const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { createDeck } = require("../utils/deck");
const { setPlayerLoadout, getRealEnergy, getPublicEnergySnapshot } = require("../game/skills/skillEngine");
const logger = require("../utils/logger");
const eventBus = require("../utils/eventBus");

function makeIoStub() {
  const emits = [];
  return {
    emits,
    to: (target) => ({ emit: (event, payload) => emits.push({ target, event, payload }) }),
  };
}

function setupRoom({
  loadoutA = ["BLOOD_BATTLE", "RECYCLE"],
  loadoutB = ["DEFENSE", "RECYCLE"],
} = {}) {
  const io = makeIoStub();
  const roomManager = new RoomManager({ logger, eventBus });
  const engine = new GameEngine({ io, roomManager, logger, eventBus, deckFactory: createDeck });
  const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.ABYSS);
  const a = roomManager.joinRoom({ roomId: room.roomId, playerName: "A", playerId: "PA", socketId: "s1" }).player;
  const b = roomManager.joinRoom({ roomId: room.roomId, playerName: "B", playerId: "PB", socketId: "s2" }).player;
  expect(setPlayerLoadout(a, loadoutA).ok).toBe(true);
  expect(setPlayerLoadout(b, loadoutB).ok).toBe(true);
  engine.startHand(room);
  engine.clearActionTimer(room);
  return { io, engine, room, a, b };
}

function latestPayload(io, event, socketId) {
  return [...io.emits].reverse().find((entry) => entry.event === event && entry.target === socketId)?.payload;
}

describe("结算筹码说明与本局历史", () => {
  test("防守把倍率后损失减半，并写入可展示的结算步骤", () => {
    const { engine, room, a, b } = setupRoom();
    a.chips = 1100;
    b.chips = 900;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.handStartChips = 1000;
    a.skillRuntime.directChipGainThisHand = 0;
    b.skillRuntime.defenseActive = true;
    const details = engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: 1,
    });
    expect(details.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillId: "DEFENSE", factor: 0.5, source: "opponent" }),
    ]));
    expect(details.baseTransfer).toBe(100);
    expect(details.lossBeforeDefense).toBe(100);
    expect(details.desiredTransfer).toBe(50);
    expect(details.finalTransfer).toBe(50);
    expect(a.chips).toBe(1050);
    expect(b.chips).toBe(950);
  });

  test("本手结算写入历史，重连后仍可按观众视角取回", () => {
    const { engine, room, a, b, io } = setupRoom();
    a.chips = 1100;
    b.chips = 900;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.defenseActive = true;
    engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: 1,
    });
    const handResult = engine.buildHandResultPayload(room, {
      reason: "showdown",
      winner: a,
      tie: false,
      pot: 200,
      playersDetail: room.players.map((player) =>
        engine.buildPlayerHandDetail(player, room.communityCards, {}, room)
      ),
    });
    engine.storeAndEmitHandResult(room, handResult, { revealAll: true });
    expect(room.handResultHistory).toHaveLength(1);
    expect(room.handResultHistory[0].handNo).toBe(room.handNo);
    expect(room.handResultHistory[0].skillSettlement.desiredTransfer).toBe(50);

    engine.restorePlayerState(room, b);
    const history = latestPayload(io, "hand_history", b.socketId);
    expect(history.hands).toHaveLength(1);
    expect(history.hands[0].skillSettlement.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillId: "DEFENSE", factor: 0.5 }),
    ]));
    const result = latestPayload(io, "hand_result", a.socketId);
    expect(result.handNo).toBe(room.handNo);
    expect(result.skillSettlement.finalTransfer).toBe(50);
  });

  test("历史回看使用结算时的能量快照，不读取当前真实能量", () => {
    const { engine, room, a, b, io } = setupRoom();
    a.skillRuntime.abyssEnergy = 2;
    b.skillRuntime.abyssEnergy = 7;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    const stampedSelf = getRealEnergy(a);
    const stampedOpp = getPublicEnergySnapshot(b);
    const handResult = engine.buildHandResultPayload(room, {
      reason: "showdown",
      winner: a,
      tie: false,
      pot: 200,
      playersDetail: room.players.map((player) =>
        engine.buildPlayerHandDetail(player, room.communityCards, {}, room)
      ),
    });
    engine.storeAndEmitHandResult(room, handResult, { revealAll: true });
    a.skillRuntime.abyssEnergy = 8;
    b.skillRuntime.abyssEnergy = 1;
    engine.restorePlayerState(room, a);
    const history = latestPayload(io, "hand_history", a.socketId);
    const self = history.hands[0].players.find((player) => player.playerId === a.playerId);
    const opponent = history.hands[0].players.find((player) => player.playerId === b.playerId);
    expect(self.abyssEnergy).toBe(stampedSelf);
    expect(opponent.abyssEnergy).toBe(stampedOpp);
    expect(JSON.stringify(history.hands[0])).not.toContain("publicAbyssEnergy");
  });

  test("伪装结算不泄露新增筹码账本数字", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["DISGUISE", "RECYCLE"],
      loadoutB: ["DEFENSE", "RECYCLE"],
    });
    room.currentPlayerIndex = room.players.findIndex((player) => player.playerId === a.playerId);
    room.phase = "pre_flop";
    a.isAllIn = false;
    a.skillRuntime.abyssEnergy = 6;
    expect(engine.handleSkillUse(room, a, { skillId: "DISGUISE", target: {}, requestId: "hist-disguise" })).toMatchObject({
      status: "SUCCESS",
    });
    a.chips = 1100;
    b.chips = 900;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.defenseActive = true;
    engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: 1,
    });
    const handResult = engine.buildHandResultPayload(room, {
      reason: "showdown",
      winner: a,
      tie: false,
      pot: 200,
      playersDetail: room.players.map((player) =>
        engine.buildPlayerHandDetail(player, room.communityCards, {}, room)
      ),
    });
    engine.storeAndEmitHandResult(room, handResult, { revealAll: true });
    const hidden = engine.handResultForViewer(room, room.handResultHistory[0], b, { revealAll: true });
    expect(hidden.pot).toBeNull();
    expect(hidden.skillSettlement.baseTransfer).toBeNull();
    expect(hidden.skillSettlement.finalTransfer).toBeNull();
    expect(hidden.skillSettlement.standardTransfer).toBeNull();
    expect(hidden.skillSettlement.directGain).toBeNull();
    expect(hidden.skillSettlement.lossBeforeDefense).toBeNull();
    expect(hidden.skillSettlement.desiredTransfer).toBeNull();
    const visible = engine.handResultForViewer(room, room.handResultHistory[0], a, { revealAll: true });
    expect(visible.skillSettlement.desiredTransfer).toBe(50);
  });
});
