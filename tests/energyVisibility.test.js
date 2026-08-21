const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { createDeck } = require("../utils/deck");
const {
  setPlayerLoadout,
  beginHandSkills,
  getPublicSkillSummary,
  getSelfSkillSummary,
  getPublicEnergySnapshot,
  getRealEnergy,
  syncVisibleEnergy,
} = require("../game/skills/skillEngine");
const logger = require("../utils/logger");
const eventBus = require("../utils/eventBus");

const FORBIDDEN_ENERGY_KEYS = [
  "realEnergy",
  "negativeEnergy",
  "maskedEnergy",
  "strongFortuneDebt",
  "energyDebt",
  "energyWasClamped",
  "actualEnergy",
  "displayEnergy",
];

function makeIoStub() {
  const emits = [];
  return {
    emits,
    to: (target) => ({ emit: (event, payload) => emits.push({ target, event, payload }) }),
  };
}

function setupRoom({
  loadoutA = ["DEEP_BREATH", "BLOOD_BATTLE"],
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
  return { io, roomManager, engine, room, a, b };
}

function use(engine, room, player, skillId, target = {}, requestId = `${skillId}-${Math.random()}`) {
  room.currentPlayerIndex = room.players.findIndex((item) => item.playerId === player.playerId);
  room.phase = "pre_flop";
  player.isAllIn = false;
  return engine.handleSkillUse(room, player, { skillId, target, requestId });
}

function publicSkillsOf(engine, room, viewer, target) {
  return engine.getRoomSnapshot(room, viewer).players.find((player) => player.playerId === target.playerId)?.skills;
}

function latestPayload(io, event, socketId) {
  return [...io.emits].reverse().find((entry) => entry.event === event && entry.target === socketId)?.payload;
}

function collectKeys(value, found = new Set()) {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, found));
    return found;
  }
  Object.keys(value).forEach((key) => {
    found.add(key);
    collectKeys(value[key], found);
  });
  return found;
}

function assertNoEnergyLeak(payload) {
  const keys = collectKeys(payload);
  FORBIDDEN_ENERGY_KEYS.forEach((key) => {
    expect(keys.has(key)).toBe(false);
  });
}

describe("对手能量可见性：逐手公开、手内冻结", () => {
  test("E01 普通结算刷新", () => {
    const { engine, room, a, b } = setupRoom();
    a.skillRuntime.abyssEnergy = 2;
    expect(getPublicEnergySnapshot(a)).toBe(4);
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(getRealEnergy(a)).toBe(2);
    expect(publicSkillsOf(engine, room, b, a).abyssEnergy).toBe(2);
  });

  test("E02 手内不实时刷新", () => {
    const { engine, room, a, b } = setupRoom();
    a.skillRuntime.abyssEnergy = 6;
    syncVisibleEnergy(a);
    a.skillRuntime.abyssEnergy = 2;
    expect(getRealEnergy(a)).toBe(2);
    expect(publicSkillsOf(engine, room, b, a).abyssEnergy).toBe(6);
  });

  test("E03 本人实时可见", () => {
    const { a } = setupRoom();
    a.skillRuntime.abyssEnergy = 6;
    syncVisibleEnergy(a);
    a.skillRuntime.abyssEnergy = 2;
    expect(getSelfSkillSummary(a).abyssEnergy).toBe(2);
    expect(getSelfSkillSummary(a).visibleAbyssEnergy).toBe(6);
  });

  test("E04 下一手刷新", () => {
    const { engine, room, a, b } = setupRoom();
    a.skillRuntime.abyssEnergy = 2;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    beginHandSkills(room);
    expect(getRealEnergy(a)).toBe(2);
    expect(publicSkillsOf(engine, room, b, a).abyssEnergy).toBe(2);
  });

  test("E05 Strong Fortune -1", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["FORTUNE", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = -1;
    a.skillRuntime.fortuneResourceUsed = true;
    expect(getSelfSkillSummary(a).abyssEnergy).toBe(-1);
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(getRealEnergy(a)).toBe(-1);
    expect(publicSkillsOf(engine, room, b, a).abyssEnergy).toBe(0);
  });

  test("E06 Strong Fortune -4", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["FORTUNE", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = -4;
    a.skillRuntime.fortuneResourceUsed = true;
    expect(getSelfSkillSummary(a).abyssEnergy).toBe(-4);
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(getRealEnergy(a)).toBe(-4);
    expect(publicSkillsOf(engine, room, b, a).abyssEnergy).toBe(0);
  });

  test("E07 真实 0 与负债公开不可区分", () => {
    const zero = setupRoom({ loadoutA: ["FORTUNE", "RECYCLE"] });
    zero.a.skillRuntime.abyssEnergy = 0;
    syncVisibleEnergy(zero.a);
    const zeroPublic = getPublicSkillSummary(zero.a);

    const debt = setupRoom({ loadoutA: ["FORTUNE", "RECYCLE"] });
    debt.a.skillRuntime.abyssEnergy = -3;
    syncVisibleEnergy(debt.a);
    const debtPublic = getPublicSkillSummary(debt.a);

    expect(zeroPublic.abyssEnergy).toBe(0);
    expect(debtPublic.abyssEnergy).toBe(0);
    expect(JSON.stringify(zeroPublic)).toBe(JSON.stringify(debtPublic));
    expect(getSelfSkillSummary(debt.a).abyssEnergy).toBe(-3);
    assertNoEnergyLeak(debtPublic);
  });

  test("E08 Clairvoyance 读取手内真实值", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["CLAIRVOYANCE", "RECYCLE"],
      loadoutB: ["DEFENSE", "RECYCLE"],
    });
    b.skillRuntime.abyssEnergy = 5;
    syncVisibleEnergy(b);
    b.skillRuntime.abyssEnergy = 2;
    a.skillRuntime.abyssEnergy = 8;
    expect(publicSkillsOf(engine, room, a, b).abyssEnergy).toBe(5);
    expect(use(engine, room, a, "CLAIRVOYANCE", {}, "e08")).toMatchObject({ status: "SUCCESS" });
    expect(a.skillRuntime.privateResults.at(-1).opponentEnergy).toBe(2);
    expect(publicSkillsOf(engine, room, a, b).abyssEnergy).toBe(5);
  });

  test("E09 Clairvoyance 读取负能量", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["CLAIRVOYANCE", "RECYCLE"],
      loadoutB: ["FORTUNE", "RECYCLE"],
    });
    b.skillRuntime.abyssEnergy = 4;
    syncVisibleEnergy(b);
    b.skillRuntime.abyssEnergy = -3;
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "CLAIRVOYANCE", {}, "e09")).toMatchObject({ status: "SUCCESS" });
    expect(a.skillRuntime.privateResults.at(-1).opponentEnergy).toBe(-3);
    expect(publicSkillsOf(engine, room, a, b).abyssEnergy).toBe(4);
  });

  test("E10 Energy Loan 不实时泄露", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 4;
    syncVisibleEnergy(a);
    expect(use(engine, room, a, "LOAN", { mode: "energy" }, "e10")).toMatchObject({ status: "SUCCESS" });
    expect(getRealEnergy(a)).toBe(7);
    expect(getSelfSkillSummary(a).abyssEnergy).toBe(7);
    expect(publicSkillsOf(engine, room, b, a).abyssEnergy).toBe(4);
  });

  test("E11 Fairness 结算后才刷新快照", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["FAIRNESS", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 6;
    syncVisibleEnergy(a);
    expect(use(engine, room, a, "FAIRNESS", {}, "e11")).toMatchObject({ status: "SUCCESS" });
    expect(getRealEnergy(a)).toBe(3);
    expect(publicSkillsOf(engine, room, b, a).abyssEnergy).toBe(6);
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(getRealEnergy(a)).toBe(3);
    expect(publicSkillsOf(engine, room, b, a).abyssEnergy).toBe(3);
  });

  test("E12 Reconnect 仍只看到公开快照", () => {
    const { engine, room, a, b } = setupRoom();
    a.skillRuntime.abyssEnergy = 5;
    syncVisibleEnergy(a);
    a.skillRuntime.abyssEnergy = 1;
    engine.restorePlayerState(room, b);
    const snapshot = engine.getRoomSnapshot(room, b);
    expect(snapshot.players.find((player) => player.playerId === a.playerId).skills.abyssEnergy).toBe(5);
    expect(JSON.stringify(snapshot)).not.toContain('"abyssEnergy":1');
  });

  test("E13 Strong Fortune 负债重连只得到 0", () => {
    const { engine, room, a, b, io } = setupRoom({ loadoutA: ["FORTUNE", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = -3;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    room.phase = "pre_flop";
    engine.restorePlayerState(room, b);
    const snapshot = engine.getRoomSnapshot(room, b);
    const publicA = snapshot.players.find((player) => player.playerId === a.playerId);
    expect(publicA.skills.abyssEnergy).toBe(0);
    expect(JSON.stringify(publicA)).not.toContain("-3");
    const skillState = latestPayload(io, "skill:state", b.socketId);
    const listed = skillState.players.find((player) => player.playerId === a.playerId);
    expect(listed.abyssEnergy).toBe(0);
    assertNoEnergyLeak(listed);
    assertNoEnergyLeak(publicA);
  });

  test("E14 普通对手 payload 无真实负能量侧信道", () => {
    const { engine, room, a, b, io } = setupRoom({ loadoutA: ["FORTUNE", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = -3;
    syncVisibleEnergy(a);
    engine.skillEngine.broadcastSkillState(room);
    engine.broadcastRoomState(room);
    const publicA = publicSkillsOf(engine, room, b, a);
    const roomState = latestPayload(io, "room_state", b.socketId);
    const skillState = latestPayload(io, "skill:state", b.socketId);
    expect(publicA.abyssEnergy).toBe(0);
    assertNoEnergyLeak(publicA);
    assertNoEnergyLeak(roomState.players.find((player) => player.playerId === a.playerId));
    assertNoEnergyLeak(skillState.players.find((player) => player.playerId === a.playerId));
    expect(JSON.stringify(publicA)).not.toMatch(/-3/);
    expect(getPublicSkillSummary(a)).not.toHaveProperty("visibleAbyssEnergy");
    expect(getPublicSkillSummary(a)).not.toHaveProperty("publicEnergySnapshot");
  });

  test("手内技能广播仍冻结对手快照，本人 skill:state 为真实值", () => {
    const { engine, room, a, b, io } = setupRoom({ loadoutA: ["DEEP_BREATH", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 6;
    syncVisibleEnergy(a);
    expect(use(engine, room, a, "DEEP_BREATH", {}, "freeze-cast")).toMatchObject({ status: "SUCCESS" });
    const toB = latestPayload(io, "skill:state", b.socketId);
    const toA = latestPayload(io, "skill:state", a.socketId);
    expect(toB.players.find((player) => player.playerId === a.playerId).abyssEnergy).toBe(6);
    expect(toA.self.abyssEnergy).toBe(5);
  });
});
