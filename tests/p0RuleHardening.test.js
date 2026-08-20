const fs = require("fs");
const path = require("path");
const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { createDeck } = require("../utils/deck");
const {
  clearPersistentSkillState,
  getPublicRoomSkillSnapshot,
  getSelfSkillSummary,
  setPlayerLoadout,
  validateLoadout,
} = require("../game/skills/skillEngine");
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
  loadoutA = ["ENDGAME"],
  loadoutB = ["DISGUISE", "RECYCLE"],
  start = true,
} = {}) {
  const io = makeIoStub();
  const roomManager = new RoomManager({ logger, eventBus });
  const engine = new GameEngine({ io, roomManager, logger, eventBus, deckFactory: createDeck });
  const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.ABYSS);
  const a = roomManager.joinRoom({
    roomId: room.roomId,
    playerName: "A",
    playerId: "PA",
    socketId: "s1",
  }).player;
  const b = roomManager.joinRoom({
    roomId: room.roomId,
    playerName: "B",
    playerId: "PB",
    socketId: "s2",
  }).player;
  expect(setPlayerLoadout(a, loadoutA).ok).toBe(true);
  expect(setPlayerLoadout(b, loadoutB).ok).toBe(true);
  room.__skillEngineForTests = engine.skillEngine;
  if (start) {
    expect(engine.startHand(room)).toBe(true);
    engine.clearActionTimer(room);
  }
  return { io, roomManager, engine, room, a, b };
}

function lastEmit(io, event, target = null) {
  return [...io.emits].reverse().find((entry) => (
    entry.event === event && (target == null || entry.target === target)
  ));
}

function prepareCallToZero(ctx, { disguise = false, deadEnd = false } = {}) {
  const { room, a, b } = ctx;
  room.phase = "turn";
  room.currentPlayerIndex = 0;
  room.currentBet = 300;
  room.lastRaiseSize = 100;
  a.status = "active";
  a.chips = 700;
  a.streetBet = 300;
  a.totalBet = 300;
  a.hasActed = true;
  a.isAllIn = false;
  a.skillRuntime.abyssEnergy = 8;
  a.skillRuntime.lockedThisHand = false;
  b.status = "active";
  b.chips = 0;
  b.streetBet = 300;
  b.totalBet = 300;
  b.hasActed = true;
  b.isAllIn = true;
  b.skillRuntime.disguiseActive = disguise;
  b.skillRuntime.deadEndActive = deadEnd;
  room.skillState.callToZeroAggressorId = a.playerId;
  room.skillState.endgameWindow = null;
  room.skillState.endgameWindowResolved = false;
  room.skillState.endgameActive = null;
  room.skillState.fairnessActive = false;
}

function prepareHiddenAction(ctx, {
  aStreet = 0,
  bStreet = 200,
  aChips = 1000,
  bChips = 800,
  currentBet = bStreet,
  lastRaiseSize = 100,
} = {}) {
  const { room, a, b } = ctx;
  room.phase = "turn";
  room.currentPlayerIndex = 0;
  room.currentBet = currentBet;
  room.lastRaiseSize = lastRaiseSize;
  room.pot = aStreet + bStreet;
  room.turnId = `p0-${Date.now()}-${Math.random()}`;
  a.status = "active";
  a.chips = aChips;
  a.streetBet = aStreet;
  a.totalBet = aStreet;
  a.hasActed = false;
  a.isAllIn = false;
  b.status = "active";
  b.chips = bChips;
  b.streetBet = bStreet;
  b.totalBet = bStreet;
  b.hasActed = true;
  b.isAllIn = false;
  b.skillRuntime.disguiseActive = true;
  room.skillState.bettingClosed = false;
  room.skillState.endgameWindow = null;
  room.skillState.contributionCap = null;
  room.skillState.noFoldActive = false;
}

function use(engine, room, player, skillId, requestId) {
  return engine.handleSkillUse(room, player, { skillId, target: {}, requestId });
}

describe("P0-1 Disguise × Endgame Call-to-zero", () => {
  test("DE01 无 Disguise 时生成合法专属窗口", () => {
    const ctx = setupRoom({ loadoutB: ["DEFENSE", "RECYCLE"] });
    prepareCallToZero(ctx);
    expect(ctx.engine.tryOpenEndgameResponseWindow(ctx.room)).toBe(true);
    expect(ctx.room.skillState.endgameWindow).toEqual({ playerId: ctx.a.playerId });
  });

  test("DE02 Disguise 隐藏归零时不生成专属窗口", () => {
    const ctx = setupRoom();
    prepareCallToZero(ctx, { disguise: true });
    expect(ctx.engine.tryOpenEndgameResponseWindow(ctx.room)).toBe(false);
    expect(ctx.room.skillState.endgameWindow).toBeNull();
    expect(ctx.room.skillState.endgameWindowResolved).toBe(true);
    expect(ctx.io.emits.some((entry) => entry.payload?.endgameWindow === true)).toBe(false);
  });

  test("DE03 对方 payload 不泄露真实归零、Call-to-zero 或实际 All In", () => {
    const ctx = setupRoom();
    prepareCallToZero(ctx, { disguise: true });
    expect(ctx.engine.tryOpenEndgameResponseWindow(ctx.room)).toBe(false);
    ctx.io.emits.length = 0;
    ctx.engine.emitActionMade(ctx.room, {
      playerId: ctx.b.playerId,
      action: "allin",
      declaredAction: "call",
      amount: 200,
      toCallBefore: 200,
      forcePublicAllIn: false,
    });

    const action = lastEmit(ctx.io, "action_made", "s1").payload;
    const snapshot = ctx.engine.getRoomSnapshot(ctx.room, ctx.a);
    const opponent = snapshot.players.find((player) => player.playerId === ctx.b.playerId);
    expect(action).toMatchObject({ action: "call", declaredAction: "call", amount: null, pot: null });
    expect(action).not.toHaveProperty("ownAllInStatus");
    expect(opponent).toMatchObject({ chips: null, streetBet: null, totalBet: null, isAllIn: false });
    const serialized = JSON.stringify({ action, snapshot });
    ["realChips", "callToZero", "callToZeroAggressorId", "actualAllIn", "isActuallyAllIn"]
      .forEach((key) => expect(serialized).not.toContain(key));
  });

  test("DE04 Disguise 不影响自己正常下注窗口发动 Endgame", () => {
    const ctx = setupRoom();
    ctx.b.skillRuntime.disguiseActive = true;
    ctx.a.skillRuntime.abyssEnergy = 8;
    ctx.room.currentPlayerIndex = 0;
    ctx.a.isAllIn = false;
    expect(ctx.engine.skillEngine.validateUse(ctx.room, ctx.a, "ENDGAME", {})).toMatchObject({ ok: true });
  });

  test("DE05 Dead End 公开 All In 保留 Endgame 规则", () => {
    const ctx = setupRoom({ loadoutB: ["DISGUISE", "DEAD_END"] });
    prepareCallToZero(ctx, { disguise: true, deadEnd: true });
    expect(ctx.engine.tryOpenEndgameResponseWindow(ctx.room)).toBe(true);
    expect(ctx.room.skillState.endgameWindow).toEqual({ playerId: ctx.a.playerId });
  });

  test("DE06 Disguise 被清除后，未来 Call-to-zero 恢复专属窗口", () => {
    const ctx = setupRoom({ loadoutB: ["DISGUISE", "FAIRNESS"] });
    ctx.b.skillRuntime.disguiseActive = true;
    clearPersistentSkillState(ctx.room);
    prepareCallToZero(ctx, { disguise: false });
    expect(ctx.engine.tryOpenEndgameResponseWindow(ctx.room)).toBe(true);
  });
});

describe("P0-2 Disguise commit-only 下注", () => {
  test("DP01-DP03 玩家视图裁剪 call、raise、stack 与 effective range", () => {
    const ctx = setupRoom({ loadoutA: ["DEFENSE", "RECYCLE"] });
    prepareHiddenAction(ctx);
    const maskedTurn = ctx.engine.maskTurnForViewer(ctx.room, ctx.a, {
      playerId: ctx.a.playerId,
      validActions: ["fold", "call", "raise", "allin"],
      minRaise: 300,
      maxBet: 1000,
      toCall: 200,
      minRaiseTo: 300,
      maxTotalBet: 1000,
      callAmount: 200,
      minRaiseAmount: 100,
      currentBet: 200,
      pot: 400,
    });
    expect(maskedTurn).toMatchObject({
      minRaise: null,
      maxBet: null,
      toCall: null,
      minRaiseTo: null,
      maxTotalBet: null,
      callAmount: null,
      minRaiseAmount: null,
      currentBet: null,
      pot: null,
    });
    const snapshot = ctx.engine.getRoomSnapshot(ctx.room, ctx.a);
    expect(snapshot).toMatchObject({ chipViewHidden: true, pot: null, currentBet: null });
    const serialized = JSON.stringify({ maskedTurn, snapshot });
    ["effectiveStack", "legalBetRange", "remainingStack", "realChips"]
      .forEach((key) => expect(serialized).not.toContain(key));
  });

  test("DP04 Call 提交后由服务器执行真实合法跟注", () => {
    const ctx = setupRoom({ loadoutA: ["DEFENSE", "RECYCLE"] });
    prepareHiddenAction(ctx, { aStreet: 100, bStreet: 300, aChips: 900, bChips: 700 });
    ctx.engine.runoutToShowdownIfAllIn = jest.fn(() => true);
    expect(ctx.engine.handlePlayerAction(ctx.room, 0, "call")).toMatchObject({ ok: true });
    expect(ctx.a).toMatchObject({ chips: 700, streetBet: 300, totalBet: 300 });
    expect(ctx.room.history.at(-1)).toMatchObject({ action: "call", amount: 200 });
  });

  test("DP05 不足额 Call 自动投入剩余筹码并进入 All In", () => {
    const ctx = setupRoom({ loadoutA: ["DEFENSE", "RECYCLE"] });
    prepareHiddenAction(ctx, { aStreet: 100, bStreet: 300, aChips: 100, bChips: 700 });
    ctx.engine.runoutToShowdownIfAllIn = jest.fn(() => true);
    expect(ctx.engine.handlePlayerAction(ctx.room, 0, "call")).toMatchObject({ ok: true });
    expect(ctx.a).toMatchObject({ chips: 0, streetBet: 200, isAllIn: true });
    expect(ctx.room.history.at(-1)).toMatchObject({ action: "allin", declaredAction: "call", amount: 100 });
  });

  test("DP06 超额 Raise 自动封顶为最大合法投入", () => {
    const ctx = setupRoom({ loadoutA: ["DEFENSE", "RECYCLE"] });
    prepareHiddenAction(ctx, { aStreet: 0, bStreet: 100, aChips: 500, bChips: 900, lastRaiseSize: 50 });
    ctx.engine.runoutToShowdownIfAllIn = jest.fn(() => true);
    expect(ctx.engine.handlePlayerAction(ctx.room, 0, "raise", 999999)).toMatchObject({ ok: true });
    expect(ctx.a).toMatchObject({ chips: 0, streetBet: 500, isAllIn: true });
    expect(ctx.room.history.at(-1)).toMatchObject({ action: "allin", declaredAction: "raise", amount: 500 });
  });

  test("DP07 低于 minimum 且有能力时自动提升至 minimum", () => {
    const ctx = setupRoom({ loadoutA: ["DEFENSE", "RECYCLE"] });
    prepareHiddenAction(ctx, {
      aStreet: 100,
      bStreet: 200,
      aChips: 900,
      bChips: 800,
      currentBet: 200,
      lastRaiseSize: 100,
    });
    ctx.engine.runoutToShowdownIfAllIn = jest.fn(() => true);
    expect(ctx.engine.handlePlayerAction(ctx.room, 0, "raise", 150)).toMatchObject({ ok: true });
    expect(ctx.a).toMatchObject({ chips: 700, streetBet: 300, isAllIn: false });
    expect(ctx.room.currentBet).toBe(300);
    expect(ctx.room.history.at(-1)).toMatchObject({ action: "raise", amount: 200 });
  });

  test("DP08 无法完成 minimum 时自动执行最大合法 All In", () => {
    const ctx = setupRoom({ loadoutA: ["DEFENSE", "RECYCLE"] });
    prepareHiddenAction(ctx, {
      aStreet: 100,
      bStreet: 200,
      aChips: 150,
      bChips: 800,
      currentBet: 200,
      lastRaiseSize: 200,
    });
    ctx.engine.runoutToShowdownIfAllIn = jest.fn(() => true);
    expect(ctx.engine.handlePlayerAction(ctx.room, 0, "raise", 150)).toMatchObject({ ok: true });
    expect(ctx.a).toMatchObject({ chips: 0, streetBet: 250, isAllIn: true });
    expect(ctx.room).toMatchObject({ currentBet: 250, lastRaiseSize: 200 });
    expect(ctx.room.history.at(-1)).toMatchObject({ action: "allin", amount: 150 });
  });

  test("DP09-DP10 归一化金额不回传，但本人获知自身 All In", () => {
    const ctx = setupRoom({ loadoutA: ["DEFENSE", "RECYCLE"] });
    prepareHiddenAction(ctx, { aStreet: 0, bStreet: 100, aChips: 500, bChips: 900, lastRaiseSize: 50 });
    ctx.engine.runoutToShowdownIfAllIn = jest.fn(() => true);
    ctx.io.emits.length = 0;
    expect(ctx.engine.handlePlayerAction(ctx.room, 0, "raise", 999999)).toMatchObject({ ok: true });
    const ownPayload = lastEmit(ctx.io, "action_made", "s1").payload;
    const opponentPayload = lastEmit(ctx.io, "action_made", "s2").payload;
    expect(ownPayload).toMatchObject({ amount: null, pot: null, ownAllInStatus: true });
    expect(ownPayload.playerChips.every((player) => player.chips === null)).toBe(true);
    expect(opponentPayload).not.toHaveProperty("ownAllInStatus");
  });

  test("DP11 正式提交消耗行动窗口，不能二次提交探测", () => {
    const ctx = setupRoom({ loadoutA: ["DEFENSE", "RECYCLE"] });
    prepareHiddenAction(ctx, {
      aStreet: 100,
      bStreet: 200,
      aChips: 900,
      bChips: 800,
      currentBet: 200,
      lastRaiseSize: 100,
    });
    const token = { handId: ctx.room.handId, turnId: ctx.room.turnId, enforceTurnToken: true };
    expect(ctx.engine.handlePlayerAction(ctx.room, 0, "raise", 150, token)).toMatchObject({ ok: true });
    ctx.engine.clearActionTimer(ctx.room);
    const chipsAfterCommit = ctx.a.chips;
    expect(ctx.engine.handlePlayerAction(ctx.room, 0, "raise", 999999, token)).toMatchObject({ ok: false });
    expect(ctx.a.chips).toBe(chipsAfterCommit);
  });

  test("DP11A 面对被隐藏的普通 All In，伪造 Raise 也归一化为 Call 并消耗窗口", () => {
    const ctx = setupRoom({ loadoutA: ["DEFENSE", "RECYCLE"] });
    prepareHiddenAction(ctx, { aStreet: 100, bStreet: 300, aChips: 900, bChips: 0 });
    ctx.b.isAllIn = true;
    ctx.engine.runoutToShowdownIfAllIn = jest.fn(() => true);
    expect(ctx.engine.handlePlayerAction(ctx.room, 0, "raise", 999999)).toMatchObject({ ok: true });
    expect(ctx.a).toMatchObject({ chips: 700, streetBet: 300, hasActed: true });
    expect(ctx.room.history.at(-1)).toMatchObject({
      action: "call",
      declaredAction: "raise",
      amount: 200,
    });
  });

  test("DP12 socket/client 不提供金额校验 oracle", () => {
    const socketSource = fs.readFileSync(path.join(__dirname, "../socket/socketHandlers.js"), "utf8");
    const clientSource = fs.readFileSync(path.join(__dirname, "../public/client.js"), "utf8");
    const oracleNames = [
      "validateBetAmount",
      "canRaiseTo",
      "getMinRaise",
      "getMaxRaise",
      "effectiveStack",
      "legalBetRange",
    ];
    oracleNames.forEach((name) => {
      expect(socketSource).not.toMatch(new RegExp(`socket\\.on\\(["']${name}`));
      expect(clientSource).not.toMatch(new RegExp(`socket\\.emit\\(["']${name}`));
    });
  });

  test("DP13 正常视角仍拒绝超额与低于 minimum 的 Raise", () => {
    const ctx = setupRoom({ loadoutA: ["DEFENSE", "RECYCLE"], loadoutB: ["RECYCLE"] });
    prepareHiddenAction(ctx, {
      aStreet: 100,
      bStreet: 200,
      aChips: 900,
      bChips: 800,
      currentBet: 200,
      lastRaiseSize: 100,
    });
    ctx.b.skillRuntime.disguiseActive = false;
    const before = { chips: ctx.a.chips, streetBet: ctx.a.streetBet };
    expect(ctx.engine.handlePlayerAction(ctx.room, 0, "raise", 999999)).toMatchObject({
      ok: false,
      error: "超过有效筹码上限",
    });
    expect(ctx.engine.handlePlayerAction(ctx.room, 0, "raise", 150)).toMatchObject({
      ok: false,
      error: "最小加注到 300",
    });
    expect(ctx.a).toMatchObject(before);
  });
});

describe("P0-3 Defense 整数向下取整", () => {
  test.each([
    ["DF01", 25, 12],
    ["DF02", 75, 37],
    ["DF03", 100, 50],
    ["DF04", 301, 150],
  ])("%s loss %i -> %i 且结果为整数", (_caseId, loss, protectedLoss) => {
    const ctx = setupRoom({ loadoutA: ["RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    ctx.a.chips = 1000 + loss;
    ctx.b.chips = 1000 - loss;
    ctx.a.skillRuntime.handStartChips = 1000;
    ctx.b.skillRuntime.handStartChips = 1000;
    ctx.a.skillRuntime.directChipGainThisHand = 0;
    ctx.b.skillRuntime.defenseActive = true;
    const totalBefore = ctx.a.chips + ctx.b.chips;
    const result = ctx.engine.skillEngine.applySettlementModifiers(ctx.room, {
      reason: "showdown",
      winner: ctx.a,
      winnerCategory: 1,
    });
    expect(ctx.a.chips).toBe(1000 + protectedLoss);
    expect(ctx.b.chips).toBe(1000 - protectedLoss);
    expect(Number.isInteger(result.finalTransfer)).toBe(true);
    expect(result.finalTransfer).toBe(protectedLoss);
    expect(ctx.a.chips + ctx.b.chips).toBe(totalBefore);
  });

  test("DF05 双方标准筹码转移严格零和", () => {
    const ctx = setupRoom({ loadoutA: ["RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    ctx.a.chips = 1075;
    ctx.b.chips = 925;
    ctx.a.skillRuntime.handStartChips = 1000;
    ctx.b.skillRuntime.handStartChips = 1000;
    ctx.b.skillRuntime.defenseActive = true;
    ctx.engine.skillEngine.applySettlementModifiers(ctx.room, { reason: "showdown", winner: ctx.a });
    expect(ctx.a.chips - 1000).toBe(37);
    expect(1000 - ctx.b.chips).toBe(37);
    expect(ctx.a.chips + ctx.b.chips).toBe(2000);
  });

  test("DF06 direct skill chip transfer 不进入 Defense 减半", () => {
    const ctx = setupRoom({ loadoutA: ["RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    // Winner currently holds +100 direct transfer and +25 standard transfer.
    ctx.a.chips = 1125;
    ctx.b.chips = 875;
    ctx.a.skillRuntime.handStartChips = 1000;
    ctx.b.skillRuntime.handStartChips = 1000;
    ctx.a.skillRuntime.directChipGainThisHand = 100;
    ctx.b.skillRuntime.defenseActive = true;
    ctx.engine.skillEngine.applySettlementModifiers(ctx.room, { reason: "showdown", winner: ctx.a });
    expect(ctx.a.chips).toBe(1112);
    expect(ctx.b.chips).toBe(888);
    expect(ctx.a.chips + ctx.b.chips).toBe(2000);
  });
});

describe("P0-4 构筑 skillId 唯一性", () => {
  test("BU01 单技能构筑合法", () => {
    expect(validateLoadout(["ENDGAME"])).toMatchObject({ ok: true, skillIds: ["ENDGAME"] });
  });

  test("BU02 四个不同技能且负载合规时合法", () => {
    expect(validateLoadout([
      "PROTOCOL_PAIR",
      "PROTOCOL_TWO_PAIR",
      "PROTOCOL_TRIPS",
      "PROTOCOL_STRAIGHT",
    ])).toMatchObject({ ok: true, totalLoad: 4 });
  });

  test("BU03 五个技能被拒绝", () => {
    expect(validateLoadout([
      "PROTOCOL_PAIR",
      "PROTOCOL_TWO_PAIR",
      "PROTOCOL_TRIPS",
      "PROTOCOL_STRAIGHT",
      "PROTOCOL_FLUSH",
    ])).toMatchObject({ ok: false, reason: "TOO_MANY_SKILLS" });
  });

  test("BU04 总负载超过 8 被拒绝", () => {
    expect(validateLoadout(["ENDGAME", "CHEAT"])).toMatchObject({
      ok: false,
      reason: "LOAD_LIMIT_EXCEEDED",
    });
  });

  test("BU05 重复主体 skillId 被拒绝", () => {
    expect(validateLoadout(["DEEP_BREATH", "DEEP_BREATH"])).toMatchObject({
      ok: false,
      reason: "DUPLICATE_SKILL_ID",
    });
  });

  test("BU06 重复 Protocol skillId 被拒绝", () => {
    expect(validateLoadout(["protocol_pair", "PROTOCOL_PAIR"])).toMatchObject({
      ok: false,
      reason: "DUPLICATE_SKILL_ID",
    });
  });

  test("BU07 多个不同 Protocol 合法", () => {
    expect(validateLoadout(["PROTOCOL_PAIR", "PROTOCOL_TWO_PAIR", "PROTOCOL_STRAIGHT"]))
      .toMatchObject({ ok: true, totalLoad: 3 });
  });

  test("BU08 伪造重复构筑由服务器入口拒绝且不覆盖旧构筑", () => {
    const ctx = setupRoom({ start: false, loadoutA: ["RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    const before = [...ctx.a.skillRuntime.equippedSkillIds];
    expect(ctx.engine.handleSkillLoadout(ctx.room, ctx.a, ["BLOOD_BATTLE", "BLOOD_BATTLE"]))
      .toMatchObject({ ok: false, reason: "DUPLICATE_SKILL_ID" });
    expect(ctx.a.skillRuntime.equippedSkillIds).toEqual(before);
  });

  test("BU09 旧重复构筑被标记 INVALID_BUILD，不能进入正式 Match", () => {
    const ctx = setupRoom({ start: false, loadoutA: ["RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    ctx.a.skillRuntime.equippedSkillIds = ["DEEP_BREATH", "DEEP_BREATH"];
    ctx.a.skillRuntime.loadoutConfirmed = true;
    ctx.engine.tryStartGame(ctx.room);
    expect(ctx.room).toMatchObject({ phase: "drafting", handNo: 0 });
    expect(ctx.a.skillRuntime).toMatchObject({
      loadoutConfirmed: false,
      invalidBuild: true,
    });
    expect(getSelfSkillSummary(ctx.a).buildStatus).toBe("INVALID_BUILD");
    expect(lastEmit(ctx.io, "skill:failed", "s1").payload).toMatchObject({
      reason: "INVALID_BUILD",
      message: expect.stringContaining("重新配置"),
    });
  });

  test("BU10 直接调用开局也会拦截旧重复构筑，不会叠加效果", () => {
    const ctx = setupRoom({ start: false, loadoutA: ["RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    ctx.a.skillRuntime.equippedSkillIds = ["PROTOCOL_PAIR", "PROTOCOL_PAIR"];
    ctx.a.skillRuntime.loadoutConfirmed = true;
    expect(ctx.engine.startHand(ctx.room)).toBe(false);
    expect(ctx.room).toMatchObject({ phase: "drafting", handNo: 0 });
    expect(ctx.a.skillRuntime.skillUsesThisHand).toEqual({});
    expect(ctx.io.emits.some((entry) => entry.event === "game_started")).toBe(false);
  });

  test("服务器公开技能快照不包含内部 Call-to-zero 标记", () => {
    const ctx = setupRoom();
    ctx.room.skillState.callToZeroAggressorId = ctx.a.playerId;
    expect(getPublicRoomSkillSnapshot(ctx.room, ctx.a)).not.toHaveProperty("callToZeroAggressorId");
  });
});
