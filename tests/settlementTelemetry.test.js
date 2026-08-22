"use strict";

const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { createDeck } = require("../utils/deck");
const { setPlayerLoadout } = require("../game/skills/skillEngine");
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
  loadoutA = ["RECYCLE", "DEEP_BREATH"],
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
  return { engine, room, a, b };
}

function seedShowdownChips(a, b, {
  start = 1000,
  standardNet = 500,
  directGain = 0,
} = {}) {
  a.chips = start + standardNet + directGain;
  b.chips = start - standardNet - directGain;
  a.skillRuntime.handStartChips = start;
  b.skillRuntime.handStartChips = start;
  a.skillRuntime.directChipGainThisHand = directGain;
}

describe("结算 Telemetry 字段语义", () => {
  test("TEL01 普通 Showdown：finalStandardTransfer 正确，netDirectChipTransfer=0", () => {
    const { engine, room, a, b } = setupRoom();
    seedShowdownChips(a, b, { standardNet: 500 });
    const details = engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: 1,
    });
    expect(details.finalStandardTransfer).toBe(500);
    expect(details.netDirectChipTransfer).toBe(0);
    expect(details.totalNetChipDelta).toBe(500);
    expect(details.directGain).toBe(0);
  });

  test("TEL02 Loan + Showdown：标准收益与 Loan direct transfer 分开记录", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"] });
    seedShowdownChips(a, b, { standardNet: 400, directGain: 100 });
    const details = engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: 1,
    });
    expect(details.finalStandardTransfer).toBe(400);
    expect(details.netDirectChipTransfer).toBe(100);
    expect(details.totalNetChipDelta).toBe(500);
  });

  test("TEL03 Loan repayment：netDirectChipTransfer 可以为负数，不得被 clamp 为 0", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"] });
    seedShowdownChips(a, b, { standardNet: 200, directGain: -150 });
    const details = engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: 4,
    });
    expect(details.netDirectChipTransfer).toBe(-150);
    expect(details.netDirectChipTransfer).not.toBe(0);
    expect(details.directGain).toBe(0);
    expect(details.finalStandardTransfer).toBe(225);
    expect(details.totalNetChipDelta).toBe(75);
  });

  test("TEL04 Endgame confiscation：没收进入 direct transfer，不进入 finalStandardTransfer", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"] });
    seedShowdownChips(a, b, { standardNet: 500, directGain: 200 });
    const details = engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: 4,
    });
    expect(details.standardPokerNet).toBe(500);
    expect(details.netDirectChipTransfer).toBe(200);
    expect(details.finalStandardTransfer).toBe(525);
    expect(details.totalNetChipDelta).toBe(725);
  });

  test("TEL05 Defense：只改变 finalStandardTransfer，不错误修改 direct transfer", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["RECYCLE", "DEEP_BREATH"],
      loadoutB: ["DEFENSE", "RECYCLE"],
    });
    seedShowdownChips(a, b, { standardNet: 500, directGain: 100 });
    b.skillRuntime.defenseActive = true;
    const details = engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: 4,
    });
    expect(details.netDirectChipTransfer).toBe(100);
    expect(details.finalStandardTransfer).toBe(262);
    expect(details.totalNetChipDelta).toBe(362);
  });
});
