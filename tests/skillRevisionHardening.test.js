const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const { SKILL_CONFIG } = require("../game/skillConfig");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { getValidActions } = require("../game/pokerLogic");
const { createDeck } = require("../utils/deck");
const { getSkillDefinition } = require("../game/skills/definitions");
const {
  validateLoadout,
  setPlayerLoadout,
  isChipViewHiddenFor,
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
  loadoutA = ["DEEP_BREATH", "BLOOD_BATTLE"],
  loadoutB = ["DEFENSE", "RECYCLE"],
  random = () => 0.99,
  start = true,
} = {}) {
  const io = makeIoStub();
  const roomManager = new RoomManager({ logger, eventBus });
  const engine = new GameEngine({ io, roomManager, logger, eventBus, deckFactory: createDeck });
  engine.skillEngine.random = random;
  const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.ABYSS);
  const a = roomManager.joinRoom({ roomId: room.roomId, playerName: "A", playerId: "PA", socketId: "s1" }).player;
  const b = roomManager.joinRoom({ roomId: room.roomId, playerName: "B", playerId: "PB", socketId: "s2" }).player;
  expect(setPlayerLoadout(a, loadoutA).ok).toBe(true);
  expect(setPlayerLoadout(b, loadoutB).ok).toBe(true);
  room.__skillEngineForTests = engine.skillEngine;
  if (start) {
    engine.startHand(room);
    engine.clearActionTimer(room);
  }
  return { io, roomManager, engine, room, a, b };
}

function use(engine, room, player, skillId, target = {}, requestId = `${skillId}-${Math.random()}`) {
  return engine.handleSkillUse(room, player, { skillId, target, requestId });
}

function card(code, suit, rank, value) {
  return { code, suit, rank, value };
}

function lastEmit(io, event, target) {
  return [...io.emits].reverse().find((entry) => (
    entry.event === event && (target == null || entry.target === target)
  ));
}

function setFacing(room, a, b, { aBet, bBet, aChips, bChips, allInB = false }) {
  a.totalBet = aBet;
  b.totalBet = bBet;
  a.streetBet = aBet;
  b.streetBet = bBet;
  a.chips = aChips;
  b.chips = bChips;
  room.pot = aBet + bBet;
  room.currentBet = Math.max(aBet, bBet);
  room.currentPlayerIndex = 0;
  b.isAllIn = Boolean(allInB);
}

describe("Fairness load 修订", () => {
  test("F01-F07 load4 energy3，构筑与反制免疫不变", () => {
    const fairness = getSkillDefinition("FAIRNESS");
    expect(fairness).toMatchObject({ load: 4, energyCost: 3, canBeCountered: false, visibility: "PUBLIC" });
    expect(SKILL_CONFIG.MAX_SKILL_LOAD).toBe(8);
    expect(validateLoadout(["FAIRNESS", "DESTINY"]).ok).toBe(false);
    expect(validateLoadout(["FAIRNESS", "CHEAT"]).ok).toBe(false);
    expect(validateLoadout(["FAIRNESS", "FORTUNE"]).ok).toBe(false);
    expect(validateLoadout(["FAIRNESS", "NULLIFICATION"]).ok).toBe(false);
    expect(validateLoadout(["FAIRNESS", "COUNTER"])).toMatchObject({ ok: true, totalLoad: 8 });
    expect(validateLoadout(["FAIRNESS", "DEAD_END"])).toMatchObject({ ok: true, totalLoad: 8 });
    expect(validateLoadout(["FAIRNESS", "RESTART"])).toMatchObject({ ok: true, totalLoad: 8 });
    expect(validateLoadout(["FAIRNESS", "DISGUISE"])).toMatchObject({ ok: true, totalLoad: 8 });
    expect(SKILL_CONFIG.MIN_EQUIPPED_SKILLS).toBe(1);
    expect(validateLoadout(["ENDGAME"])).toMatchObject({ ok: true, totalLoad: 6 });

    const vs = setupRoom({ loadoutA: ["FAIRNESS", "DEEP_BREATH"], loadoutB: ["COUNTER", "RECYCLE"] });
    vs.b.skillRuntime.counterArmed = true;
    vs.a.skillRuntime.abyssEnergy = 8;
    vs.a.skillRuntime.bloodBattleActive = true;
    expect(use(vs.engine, vs.room, vs.a, "FAIRNESS", {}, "f07")).toMatchObject({ status: "SUCCESS" });
    expect(vs.b.skillRuntime.counterArmed).toBe(false);
    expect(vs.a.skillRuntime.bloodBattleActive).toBe(false);
    expect(vs.room.skillState.fairnessActive).toBe(true);
    expect(vs.a.skillRuntime.abyssEnergy).toBe(5);
  });
});

describe("Loan 比赛结束债务失效", () => {
  test("L01-L03 跨手正常偿还，比赛结束前债务仍有效", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    expect(use(engine, room, a, "LOAN", { mode: "chip" }, "l01")).toMatchObject({ status: "SUCCESS" });
    const afterTake = a.chips;
    const chipsBAfterTake = b.chips;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(a.skillRuntime.chipLoan).toBeTruthy();
    expect(a.chips).toBe(afterTake);
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(a.chips).toBe(afterTake - 150);
    expect(b.chips).toBe(chipsBAfterTake + 150);
    expect(a.skillRuntime.chipLoan).toBeNull();
  });

  test("L04-L06 比赛结束后未到期债务失效且不逆转胜负", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    expect(use(engine, room, a, "LOAN", { mode: "chip" }, "l04")).toMatchObject({ status: "SUCCESS" });
    const chipsA = a.chips;
    const chipsB = 0;
    b.chips = chipsB;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(a.skillRuntime.chipLoan).toBeNull();
    expect(a.chips).toBe(chipsA);
    expect(b.chips).toBe(0);

    const energy = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    energy.a.skillRuntime.abyssEnergy = 4;
    expect(use(energy.engine, energy.room, energy.a, "LOAN", { mode: "energy" }, "l05")).toMatchObject({ status: "SUCCESS" });
    expect(energy.a.skillRuntime.abyssEnergy).toBe(7);
    energy.b.chips = 0;
    energy.engine.skillEngine.endHand(energy.room, { reason: "showdown", winner: energy.a, tie: false });
    expect(energy.a.skillRuntime.energyLoan).toBeNull();
    expect(energy.a.skillRuntime.energyDebt).toBe(0);
    expect(energy.a.skillRuntime.abyssEnergy).toBe(7);
  });

  test("双模式可同手；筹码同一手 2 次，能量同一手 1 次；债务未清封禁全部；伪装不公开贷款数字", () => {
    const dual = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    dual.a.skillRuntime.abyssEnergy = 8;
    expect(use(dual.engine, dual.room, dual.a, "LOAN", { mode: "chip" }, "loan-both-chip")).toMatchObject({ status: "SUCCESS" });
    expect(use(dual.engine, dual.room, dual.a, "LOAN", { mode: "energy" }, "loan-both-energy")).toMatchObject({ status: "SUCCESS" });
    expect(dual.a.skillRuntime.chipLoan).toBeTruthy();
    expect(dual.a.skillRuntime.energyLoan).toBeTruthy();
    expect(use(dual.engine, dual.room, dual.a, "LOAN", { mode: "chip" }, "loan-chip-2")).toMatchObject({ status: "SUCCESS" });
    expect(dual.a.skillRuntime.chipLoan.repay).toBe(300);
    expect(dual.a.skillRuntime.chipLoan.count).toBe(2);
    expect(use(dual.engine, dual.room, dual.a, "LOAN", { mode: "chip" }, "loan-chip-3").ok).toBe(false);
    expect(use(dual.engine, dual.room, dual.a, "LOAN", { mode: "energy" }, "loan-energy-2").ok).toBe(false);

    const twoChip = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    twoChip.a.skillRuntime.abyssEnergy = 8;
    const chipsB = twoChip.b.chips;
    expect(use(twoChip.engine, twoChip.room, twoChip.a, "LOAN", { mode: "chip" }, "chip-a")).toMatchObject({ status: "SUCCESS" });
    expect(use(twoChip.engine, twoChip.room, twoChip.a, "LOAN", { mode: "chip" }, "chip-b")).toMatchObject({ status: "SUCCESS" });
    expect(twoChip.b.chips).toBe(chipsB - 200);
    twoChip.engine.skillEngine.endHand(twoChip.room, { reason: "showdown", winner: twoChip.a, tie: false });
    expect(twoChip.a.skillRuntime.chipLoan.repay).toBe(300);
    const beforeRepay = twoChip.a.chips;
    twoChip.engine.skillEngine.endHand(twoChip.room, { reason: "showdown", winner: twoChip.a, tie: false });
    expect(twoChip.a.chips).toBe(beforeRepay - 300);
    expect(twoChip.a.skillRuntime.chipLoan).toBeNull();

    const debt = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    debt.a.skillRuntime.energyDebt = 2;
    expect(use(debt.engine, debt.room, debt.a, "LOAN", { mode: "chip" }, "loan-debt-chip").ok).toBe(false);
    expect(use(debt.engine, debt.room, debt.a, "LOAN", { mode: "energy" }, "loan-debt-energy").ok).toBe(false);

    const hidden = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["DISGUISE", "RECYCLE"] });
    hidden.room.currentPlayerIndex = 1;
    hidden.b.skillRuntime.abyssEnergy = 6;
    expect(use(hidden.engine, hidden.room, hidden.b, "DISGUISE", {}, "loan-dis-b")).toMatchObject({ status: "SUCCESS" });
    hidden.room.currentPlayerIndex = 0;
    expect(use(hidden.engine, hidden.room, hidden.a, "LOAN", { mode: "chip" }, "loan-dis-a")).toMatchObject({ status: "SUCCESS" });
    const hiddenResolved = lastEmit(hidden.io, "skill:resolved", "s1");
    expect(hiddenResolved.payload.publicSummary).toBe("A 发动「贷款」");
    expect(hiddenResolved.payload.publicData.take).toBeNull();
    const visibleResolved = lastEmit(hidden.io, "skill:resolved", "s2");
    expect(visibleResolved.payload.publicSummary).toMatch(/100|斩杀/);
  });

  test("L07 正常到期还款仍可使借款人归 0", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    expect(use(engine, room, a, "LOAN", { mode: "chip" }, "l07")).toMatchObject({ status: "SUCCESS" });
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    a.chips = 120;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(a.chips).toBe(0);
    expect(a.skillRuntime.chipLoan).toBeNull();
  });
});

describe("Retreat 同窗后悔按钮", () => {
  test("R01-R06 同窗立即 Fold，退还含盲注，无败者+1", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["RETREAT", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    const startA = a.chips + a.totalBet;
    const startB = b.chips + b.totalBet;
    const blinds = a.totalBet + b.totalBet;
    expect(blinds).toBeGreaterThan(0);
    a.skillRuntime.abyssEnergy = 6;
    const actor = room.currentPlayerIndex;
    expect(use(engine, room, a, "RETREAT", {}, "r01")).toMatchObject({ status: "SUCCESS" });
    expect(room.currentPlayerIndex).toBe(actor);
    expect(a.skillRuntime.retreatActive).toBe(true);
    const energyAfter = a.skillRuntime.abyssEnergy;
    expect(engine.handlePlayerAction(room, 0, "fold", 0).ok).toBe(true);
    expect(a.chips).toBe(startA);
    expect(b.chips).toBe(startB);
    expect(room.pot).toBe(0);
    expect(a.skillRuntime.abyssEnergy).toBe(energyAfter);

    const unused = setupRoom({ loadoutA: ["RETREAT", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    unused.a.skillRuntime.abyssEnergy = 6;
    expect(use(unused.engine, unused.room, unused.a, "RETREAT", {}, "r06")).toMatchObject({ status: "SUCCESS" });
    unused.engine.skillEngine.endHand(unused.room, { reason: "showdown", winner: unused.b, tie: false });
    expect(unused.a.skillRuntime.abyssEnergy).toBe(4);
  });

  test("R07 不回滚贷款直接筹码；R08-R09 反制后不自动 Fold", () => {
    const loaned = setupRoom({ loadoutA: ["RETREAT", "LOAN"], loadoutB: ["DEFENSE", "RECYCLE"] });
    loaned.a.skillRuntime.abyssEnergy = 8;
    expect(use(loaned.engine, loaned.room, loaned.a, "LOAN", { mode: "chip" }, "loan-r")).toMatchObject({ status: "SUCCESS" });
    const afterLoan = loaned.a.chips + loaned.a.totalBet;
    expect(use(loaned.engine, loaned.room, loaned.a, "RETREAT", {}, "ret-loan")).toMatchObject({ status: "SUCCESS" });
    loaned.engine.handlePlayerAction(loaned.room, 0, "fold", 0);
    expect(loaned.a.chips).toBe(afterLoan);

    const trap = setupRoom({
      loadoutA: ["RETREAT", "RECYCLE"],
      loadoutB: ["COUNTER", "RECYCLE"],
    });
    trap.a.skillRuntime.abyssEnergy = 6;
    trap.b.skillRuntime.counterArmed = true;
    const actor = trap.room.currentPlayerIndex;
    expect(use(trap.engine, trap.room, trap.a, "RETREAT", {}, "ret-c")).toMatchObject({ status: "COUNTERED" });
    expect(trap.a.skillRuntime.retreatActive).toBeFalsy();
    expect(trap.room.currentPlayerIndex).toBe(actor);
    expect(trap.engine.handlePlayerAction(trap.room, 0, "check", 0).ok || trap.engine.handlePlayerAction(trap.room, 0, "call", 0).ok).toBe(true);
  });

  test("R10-R15 Dead End / Fairness / Intimidation / Endgame / Probe", () => {
    const keep = setupRoom({ loadoutA: ["RETREAT", "RECYCLE"], loadoutB: ["DEAD_END", "DEEP_BREATH"] });
    keep.a.skillRuntime.abyssEnergy = 6;
    keep.b.skillRuntime.abyssEnergy = 8;
    expect(use(keep.engine, keep.room, keep.a, "RETREAT", {}, "r10")).toMatchObject({ status: "SUCCESS" });
    keep.room.currentPlayerIndex = 1;
    expect(use(keep.engine, keep.room, keep.b, "DEAD_END", {}, "dead")).toMatchObject({ status: "SUCCESS" });
    expect(keep.a.skillRuntime.retreatActive).toBe(true);
    keep.room.skillState.bettingClosed = false;
    keep.a.status = "active";
    keep.a.isAllIn = false;
    keep.room.currentPlayerIndex = 0;
    keep.room.phase = "pre_flop";
    expect(keep.engine.handlePlayerAction(keep.room, 0, "fold", 0).ok).toBe(true);

    const blocked = setupRoom({ loadoutA: ["RETREAT", "RECYCLE"], loadoutB: ["DEAD_END", "DEEP_BREATH"] });
    blocked.b.skillRuntime.abyssEnergy = 8;
    blocked.room.currentPlayerIndex = 1;
    expect(use(blocked.engine, blocked.room, blocked.b, "DEAD_END", {}, "dead-first")).toMatchObject({ status: "SUCCESS" });
    blocked.a.skillRuntime.abyssEnergy = 6;
    expect(use(blocked.engine, blocked.room, blocked.a, "RETREAT", {}, "r11").ok).toBe(false);

    const fair = setupRoom({ loadoutA: ["RETREAT", "FAIRNESS"], loadoutB: ["DEFENSE", "RECYCLE"] });
    fair.a.skillRuntime.abyssEnergy = 8;
    expect(use(fair.engine, fair.room, fair.a, "RETREAT", {}, "r12")).toMatchObject({ status: "SUCCESS" });
    expect(use(fair.engine, fair.room, fair.a, "FAIRNESS", {}, "fair")).toMatchObject({ status: "SUCCESS" });
    expect(fair.a.skillRuntime.retreatActive).toBe(false);

    const fear = setupRoom({ loadoutA: ["RETREAT", "RECYCLE"], loadoutB: ["INTIMIDATION", "DEEP_BREATH"] });
    fear.a.skillRuntime.abyssEnergy = 6;
    fear.b.skillRuntime.abyssEnergy = 8;
    expect(use(fear.engine, fear.room, fear.a, "RETREAT", {}, "r13")).toMatchObject({ status: "SUCCESS" });
    fear.room.currentPlayerIndex = 1;
    expect(use(fear.engine, fear.room, fear.b, "INTIMIDATION", {}, "fear")).toMatchObject({ status: "SUCCESS" });
    expect(fear.a.skillRuntime.retreatActive).toBe(true);
    fear.room.currentPlayerIndex = 0;
    expect(fear.engine.handlePlayerAction(fear.room, 0, "fold", 0).ok).toBe(false);

    const end = setupRoom({ loadoutA: ["RETREAT", "RECYCLE"], loadoutB: ["ENDGAME", "DEEP_BREATH"] });
    end.a.skillRuntime.abyssEnergy = 6;
    end.b.skillRuntime.abyssEnergy = 8;
    expect(use(end.engine, end.room, end.a, "RETREAT", {}, "r14")).toMatchObject({ status: "SUCCESS" });
    end.room.currentPlayerIndex = 1;
    expect(use(end.engine, end.room, end.b, "ENDGAME", {}, "eg")).toMatchObject({ status: "SUCCESS" });
    expect(end.a.skillRuntime.retreatActive).toBe(true);
    expect(end.engine.handlePlayerAction(end.room, 0, "fold", 0).ok).toBe(false);

    const probe = setupRoom({ loadoutA: ["RETREAT", "RECYCLE"], loadoutB: ["PROBE", "RECYCLE"] });
    probe.a.skillRuntime.abyssEnergy = 6;
    expect(use(probe.engine, probe.room, probe.a, "RETREAT", {}, "r15a")).toMatchObject({ status: "SUCCESS" });
    probe.room.currentPlayerIndex = 1;
    probe.b.skillRuntime.abyssEnergy = 6;
    expect(use(probe.engine, probe.room, probe.b, "PROBE", {}, "r15b")).toMatchObject({ status: "SUCCESS" });
    probe.room.currentPlayerIndex = 0;
    probe.engine.handlePlayerAction(probe.room, 0, "fold", 0);
    const details = probe.engine.skillEngine.applySettlementModifiers(probe.room, {
      reason: "fold", winner: probe.b, tie: false,
    });
    expect(details.effects.some((entry) => entry.skillId === "PROBE")).toBe(false);
  });
});

describe("Disguise 筹码信息裁剪", () => {
  test("D01-D07 / D12 视图模型隐藏数值，不靠 CSS", () => {
    const { engine, room, a, b, io } = setupRoom({ loadoutA: ["DISGUISE", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    expect(use(engine, room, a, "DISGUISE", {}, "d01")).toMatchObject({ status: "SUCCESS" });
    expect(isChipViewHiddenFor(room, a)).toBe(false);
    expect(isChipViewHiddenFor(room, b)).toBe(true);
    const selfView = engine.getRoomSnapshot(room, a);
    const hidden = engine.getRoomSnapshot(room, b);
    expect(selfView.chipViewHidden).toBe(false);
    expect(typeof selfView.players[0].chips).toBe("number");
    expect(hidden.chipViewHidden).toBe(true);
    expect(hidden.pot).toBeNull();
    expect(hidden.currentBet).toBeNull();
    expect(hidden.players.every((player) => player.chips == null && player.streetBet == null && player.totalBet == null)).toBe(true);
    engine.emitTurn(room);
    const turnHidden = lastEmit(io, "player_turn", "s2");
    expect(turnHidden.payload.toCall).toBeNull();
    expect(turnHidden.payload.minRaise).toBeNull();
    expect(turnHidden.payload.maxBet).toBeNull();
    engine.handlePlayerAction(room, room.currentPlayerIndex === 0 ? 0 : 1, "check", 0);
    const actionHidden = lastEmit(io, "action_made", "s2");
    if (actionHidden) expect(actionHidden.payload.amount).toBeNull();

    const both = setupRoom({ loadoutA: ["DISGUISE", "RECYCLE"], loadoutB: ["DISGUISE", "RECYCLE"] });
    expect(use(both.engine, both.room, both.a, "DISGUISE", {}, "d12a")).toMatchObject({ status: "SUCCESS" });
    both.room.currentPlayerIndex = 1;
    expect(use(both.engine, both.room, both.b, "DISGUISE", {}, "d12b")).toMatchObject({ status: "SUCCESS" });
    expect(isChipViewHiddenFor(both.room, both.a)).toBe(true);
    expect(isChipViewHiddenFor(both.room, both.b)).toBe(true);
  });

  test("D08-D14 超额封顶 ALL IN、本人可见、对手不见普通 ALL IN、绝路强制公开", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["DISGUISE", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    expect(use(engine, room, a, "DISGUISE", {}, "d08a")).toMatchObject({ status: "SUCCESS" });
    room.currentPlayerIndex = 1;
    b.chips = 300;
    const raised = engine.handlePlayerAction(room, 1, "raise", b.streetBet + 500);
    expect(raised.ok).toBe(true);
    expect(String(raised.error || "")).not.toMatch(/不足|剩余|300/);
    expect(b.isAllIn).toBe(true);
    const selfPlayers = engine.getViewPlayers(room, b);
    expect(selfPlayers.find((player) => player.playerId === b.playerId).isAllIn).toBe(true);
    const oppPlayers = engine.getViewPlayers(room, b);
    expect(oppPlayers.find((player) => player.playerId === a.playerId).isAllIn).toBe(false);
    const casterViewOfB = engine.getViewPlayers(room, a).find((player) => player.playerId === b.playerId);
    expect(casterViewOfB.isAllIn).toBe(true);

    a.isAllIn = true;
    const hiddenViewOfA = engine.getViewPlayers(room, b).find((player) => player.playerId === a.playerId);
    expect(hiddenViewOfA.isAllIn).toBe(false);
    const selfViewOfA = engine.getViewPlayers(room, a).find((player) => player.playerId === a.playerId);
    expect(selfViewOfA.isAllIn).toBe(true);

    const dead = setupRoom({ loadoutA: ["DISGUISE", "DEAD_END"], loadoutB: ["DEFENSE", "RECYCLE"] });
    dead.a.skillRuntime.abyssEnergy = 8;
    expect(use(dead.engine, dead.room, dead.a, "DISGUISE", {}, "d14a")).toMatchObject({ status: "SUCCESS" });
    dead.a.isAllIn = false;
    expect(use(dead.engine, dead.room, dead.a, "DEAD_END", {}, "d14b")).toMatchObject({ status: "SUCCESS" });
    const forced = dead.engine.getViewPlayers(dead.room, dead.b).find((player) => player.playerId === dead.a.playerId);
    expect(forced.isAllIn).toBe(true);
  });

  test("D15-D17 灵视不穿透；公开伪装不触发警觉；公平恢复未来不回填历史", () => {
    const spy = setupRoom({ loadoutA: ["CLAIRVOYANCE", "RECYCLE"], loadoutB: ["DISGUISE", "RECYCLE"] });
    spy.room.currentPlayerIndex = 1;
    expect(use(spy.engine, spy.room, spy.b, "DISGUISE", {}, "d15a")).toMatchObject({ status: "SUCCESS" });
    spy.room.currentPlayerIndex = 0;
    expect(use(spy.engine, spy.room, spy.a, "CLAIRVOYANCE", {}, "d15b")).toMatchObject({ status: "SUCCESS" });
    const msg = spy.a.skillRuntime.privateResults.at(-1).message;
    expect(msg).not.toMatch(/筹码\s*\d/);

    const alert = setupRoom({
      loadoutA: ["DISGUISE", "RECYCLE"],
      loadoutB: ["ALERT", "RECYCLE"],
    });
    expect(use(alert.engine, alert.room, alert.a, "DISGUISE", {}, "d16")).toMatchObject({ status: "SUCCESS" });
    expect(alert.b.skillRuntime.alertChanceIndex).toBe(0);

    const { engine, room, a, b, io } = setupRoom({ loadoutA: ["DISGUISE", "FAIRNESS"], loadoutB: ["DEFENSE", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "DISGUISE", {}, "d17a")).toMatchObject({ status: "SUCCESS" });
    engine.emitActionMade(room, { playerId: a.playerId, action: "raise", declaredAction: "raise", amount: 80 });
    const hiddenLog = lastEmit(io, "action_made", "s2");
    expect(hiddenLog.payload.amount).toBeNull();
    expect(use(engine, room, a, "FAIRNESS", {}, "d17b")).toMatchObject({ status: "SUCCESS" });
    const restored = engine.getRoomSnapshot(room, b);
    expect(restored.chipViewHidden).toBe(false);
    expect(typeof restored.pot).toBe("number");
    expect(hiddenLog.payload.amount).toBeNull();
  });
});

describe("Endgame 结算顺序与处决", () => {
  test("E01-E05 面对 Bet/Raise/ALL IN 可发动", () => {
    const skill = getSkillDefinition("ENDGAME");
    expect(skill).toMatchObject({ load: 6, energyCost: 8, visibility: "PUBLIC" });
    const facing = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["DEFENSE", "RECYCLE"] });
    facing.a.skillRuntime.abyssEnergy = 8;
    setFacing(facing.room, facing.a, facing.b, { aBet: 100, bBet: 200, aChips: 900, bChips: 800 });
    expect(use(facing.engine, facing.room, facing.a, "ENDGAME", {}, "e03")).toMatchObject({ status: "SUCCESS" });

    const raise = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["DEFENSE", "RECYCLE"] });
    raise.a.skillRuntime.abyssEnergy = 8;
    setFacing(raise.room, raise.a, raise.b, { aBet: 100, bBet: 350, aChips: 900, bChips: 650 });
    expect(use(raise.engine, raise.room, raise.a, "ENDGAME", {}, "e04")).toMatchObject({ status: "SUCCESS" });

    const allin = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["DEFENSE", "RECYCLE"] });
    allin.a.skillRuntime.abyssEnergy = 8;
    setFacing(allin.room, allin.a, allin.b, { aBet: 100, bBet: 400, aChips: 900, bChips: 0, allInB: true });
    expect(use(allin.engine, allin.room, allin.a, "ENDGAME", {}, "e05")).toMatchObject({ status: "SUCCESS" });
  });

  test("E06-E08 专属窗口与恐吓伪 ALL IN 不处决", () => {
    const zero = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["DEFENSE", "RECYCLE"] });
    zero.a.skillRuntime.abyssEnergy = 8;
    zero.b.chips = 0;
    zero.b.isAllIn = true;
    zero.a.hasActed = true;
    zero.a.streetBet = zero.room.currentBet;
    zero.room.skillState.callToZeroAggressorId = zero.a.playerId;
    expect(zero.engine.tryOpenEndgameResponseWindow(zero.room)).toBe(true);

    const notZero = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["DEFENSE", "RECYCLE"] });
    notZero.a.skillRuntime.abyssEnergy = 8;
    notZero.b.chips = 40;
    notZero.b.isAllIn = false;
    expect(notZero.engine.tryOpenEndgameResponseWindow(notZero.room)).toBe(false);

    const fake = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["INTIMIDATION", "RECYCLE"] });
    fake.a.skillRuntime.abyssEnergy = 8;
    fake.room.skillState.contributionCap = 500;
    fake.b.skillRuntime.allInAction = true;
    fake.b.isAllIn = true;
    fake.b.chips = 400;
    setFacing(fake.room, fake.a, fake.b, { aBet: 100, bBet: 500, aChips: 900, bChips: 400, allInB: true });
    expect(use(fake.engine, fake.room, fake.a, "ENDGAME", {}, "e08")).toMatchObject({ status: "SUCCESS" });
    expect(fake.room.skillState.endgameActive.execution).toBe(false);
  });

  test("E09-E13 先付费再反制；失败不没收；Recycle 返 4", () => {
    const countered = setupRoom({
      loadoutA: ["ENDGAME", "RECYCLE"],
      loadoutB: ["COUNTER", "RECYCLE"],
    });
    countered.a.skillRuntime.abyssEnergy = 8;
    countered.b.skillRuntime.counterArmed = true;
    setFacing(countered.room, countered.a, countered.b, { aBet: 100, bBet: 300, aChips: 900, bChips: 700 });
    const pot = countered.room.pot;
    const bBet = countered.b.totalBet;
    expect(use(countered.engine, countered.room, countered.a, "ENDGAME", {}, "e09")).toMatchObject({ status: "COUNTERED" });
    expect(countered.a.skillRuntime.abyssEnergy).toBe(0);
    expect(countered.room.pot).toBe(pot);
    expect(countered.b.totalBet).toBe(bBet);
    expect(countered.room.skillState.endgameActive).toBeFalsy();
    expect(countered.room.skillState.bettingClosed).toBeFalsy();
    countered.engine.skillEngine.endHand(countered.room, { reason: "showdown", winner: countered.a, tie: false });
    expect(countered.a.skillRuntime.abyssEnergy).toBe(4);
  });

  test("E14-E19 只没收对手未匹配部分，不进倍率，关闭下注并发完公共牌", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["BLOOD_BATTLE", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 8;
    b.skillRuntime.bloodBattleActive = true;
    setFacing(room, a, b, { aBet: 100, bBet: 300, aChips: 900, bChips: 700 });
    a.skillRuntime.handStartChips = 1000;
    expect(use(engine, room, a, "ENDGAME", {}, "e14")).toMatchObject({ status: "SUCCESS" });
    expect(room.skillState.endgameActive.confiscated).toBe(200);
    expect(room.skillState.endgameActive.transferKind).toBe("DIRECT_SKILL_CHIP_TRANSFER");
    expect(a.skillRuntime.directChipGainThisHand).toBe(200);
    expect(room.skillState.bettingClosed).toBe(true);
    expect(getValidActions(room, 0).validActions).toEqual([]);
    expect(["showdown", "end"]).toContain(room.phase);
    expect(room.communityCards.length).toBe(5);

    const ownerLead = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["DEFENSE", "RECYCLE"] });
    ownerLead.a.skillRuntime.abyssEnergy = 8;
    setFacing(ownerLead.room, ownerLead.a, ownerLead.b, { aBet: 300, bBet: 100, aChips: 700, bChips: 900 });
    expect(use(ownerLead.engine, ownerLead.room, ownerLead.a, "ENDGAME", {}, "e16")).toMatchObject({ status: "SUCCESS" });
    expect(ownerLead.room.skillState.endgameActive.confiscated).toBe(0);
    expect(ownerLead.a.skillRuntime.directChipGainThisHand || 0).toBe(0);
  });

  test("E20-E29 处决比较与斩杀标记", () => {
    function showdownWith(setupCards) {
      const ctx = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["DEFENSE", "RECYCLE"] });
      setupCards(ctx);
      ctx.room.phase = "river";
      ctx.room.pot = 100;
      ctx.engine.settleShowdown(ctx.room);
      return ctx;
    }

    const normal = showdownWith(({ room, a, b }) => {
      room.skillState.endgameActive = { casterId: a.playerId, execution: false, confiscated: 0 };
      room.communityCards = [card("H2", "H", "2", 2), card("C9", "C", "9", 9), card("S5", "S", "5", 5), card("D7", "D", "7", 7), card("H8", "H", "8", 8)];
      a.cards = [card("S2", "S", "2", 2), card("D3", "D", "3", 3)];
      b.cards = [card("SA", "S", "A", 14), card("DA", "D", "A", 14)];
    });
    expect(normal.room.lastHandResult.winner).toBe(normal.b.playerId);
    expect(normal.room.lastHandResult.endgameExecutionOverride).toBe(false);

    const diff = showdownWith(({ room, a, b }) => {
      room.skillState.endgameActive = { casterId: a.playerId, execution: true, confiscated: 0 };
      room.communityCards = [card("H2", "H", "2", 2), card("C2", "C", "2", 2), card("S2", "S", "2", 2), card("D7", "D", "7", 7), card("H9", "H", "9", 9)];
      a.cards = [card("S3", "S", "3", 3), card("D4", "D", "4", 4)];
      b.cards = [card("SA", "S", "A", 14), card("DA", "D", "A", 14)];
    });
    expect(diff.room.lastHandResult.endgameExecutionOverride).toBe(false);
    expect(diff.room.lastHandResult.winner).toBe(diff.b.playerId);

    const pair = showdownWith(({ room, a, b }) => {
      room.skillState.endgameActive = { casterId: a.playerId, execution: true, confiscated: 0 };
      room.communityCards = [card("H2", "H", "2", 2), card("C9", "C", "9", 9), card("S5", "S", "5", 5), card("D7", "D", "7", 7), card("H8", "H", "8", 8)];
      a.cards = [card("S2", "S", "2", 2), card("D3", "D", "3", 3)];
      b.cards = [card("SA", "S", "A", 14), card("DA", "D", "A", 14)];
    });
    expect(pair.room.lastHandResult.winner).toBe(pair.a.playerId);
    expect(pair.room.lastHandResult.endgameExecutionOverride).toBe(true);

    const straight = showdownWith(({ room, a, b }) => {
      room.skillState.endgameActive = { casterId: a.playerId, execution: true, confiscated: 0 };
      room.communityCards = [card("H5", "H", "5", 5), card("C6", "C", "6", 6), card("D7", "D", "7", 7), card("S8", "S", "8", 8), card("H2", "H", "2", 2)];
      a.cards = [card("C4", "C", "4", 4), card("D3", "D", "3", 3)];
      b.cards = [card("C9", "C", "9", 9), card("DT", "D", "T", 10)];
    });
    expect(straight.room.lastHandResult.winner).toBe(straight.a.playerId);
    expect(straight.room.lastHandResult.endgameExecutionOverride).toBe(true);

    const flush = showdownWith(({ room, a, b }) => {
      room.skillState.endgameActive = { casterId: a.playerId, execution: true, confiscated: 0 };
      room.communityCards = [card("HA", "H", "A", 14), card("HK", "H", "K", 13), card("HQ", "H", "Q", 12), card("C2", "C", "2", 2), card("D3", "D", "3", 3)];
      a.cards = [card("H9", "H", "9", 9), card("H4", "H", "4", 4)];
      b.cards = [card("HJ", "H", "J", 11), card("H5", "H", "5", 5)];
    });
    expect(flush.room.lastHandResult.winner).toBe(flush.a.playerId);
    expect(flush.room.lastHandResult.endgameExecutionOverride).toBe(true);

    const boat = showdownWith(({ room, a, b }) => {
      room.skillState.endgameActive = { casterId: a.playerId, execution: true, confiscated: 0 };
      room.communityCards = [card("HK", "H", "K", 13), card("DK", "D", "K", 13), card("C9", "C", "9", 9), card("S9", "S", "9", 9), card("H2", "H", "2", 2)];
      a.cards = [card("H9", "H", "9", 9), card("D4", "D", "4", 4)];
      b.cards = [card("SK", "S", "K", 13), card("D3", "D", "3", 3)];
    });
    expect(boat.room.lastHandResult.winner).toBe(boat.a.playerId);
    expect(boat.room.lastHandResult.endgameExecutionOverride).toBe(true);

    const identical = showdownWith(({ room, a, b }) => {
      room.skillState.endgameActive = { casterId: a.playerId, execution: true, confiscated: 0 };
      room.communityCards = [card("HK", "H", "K", 13), card("DK", "D", "K", 13), card("CK", "C", "K", 13), card("S9", "S", "9", 9), card("H9", "H", "9", 9)];
      a.cards = [card("S2", "S", "2", 2), card("D3", "D", "3", 3)];
      b.cards = [card("S4", "S", "4", 4), card("D5", "D", "5", 5)];
    });
    expect(identical.room.lastHandResult.winner).toBe(identical.a.playerId);
    expect(identical.room.lastHandResult.endgameExecutionOverride).toBe(true);

    const alreadyWinning = showdownWith(({ room, a, b }) => {
      room.skillState.endgameActive = { casterId: a.playerId, execution: true, confiscated: 0 };
      room.communityCards = [card("H2", "H", "2", 2), card("C9", "C", "9", 9), card("S5", "S", "5", 5), card("D7", "D", "7", 7), card("H8", "H", "8", 8)];
      a.cards = [card("SA", "S", "A", 14), card("DA", "D", "A", 14)];
      b.cards = [card("S2", "S", "2", 2), card("D3", "D", "3", 3)];
    });
    expect(alreadyWinning.room.lastHandResult.winner).toBe(alreadyWinning.a.playerId);
    expect(alreadyWinning.room.lastHandResult.endgameExecutionOverride).toBe(false);

    const royalVsSf = showdownWith(({ room, a, b }) => {
      room.skillState.endgameActive = { casterId: a.playerId, execution: true, confiscated: 0 };
      room.communityCards = [
        card("HT", "H", "T", 10), card("HJ", "H", "J", 11), card("HQ", "H", "Q", 12),
        card("HK", "H", "K", 13), card("C2", "C", "2", 2),
      ];
      a.cards = [card("H9", "H", "9", 9), card("D3", "D", "3", 3)];
      b.cards = [card("HA", "H", "A", 14), card("D4", "D", "4", 4)];
    });
    expect(royalVsSf.room.lastHandResult.winner).toBe(royalVsSf.b.playerId);
    expect(royalVsSf.room.lastHandResult.endgameExecutionOverride).toBe(false);
  });

  test("Call-to-zero 只给进攻方；放弃窗口；Bot 按牌力判断；发动者超额注退还", () => {
    const both = setupRoom({ loadoutA: ["ENDGAME"], loadoutB: ["ENDGAME"] });
    both.a.skillRuntime.abyssEnergy = 8;
    both.b.skillRuntime.abyssEnergy = 8;
    both.a.chips = 0;
    both.b.chips = 0;
    both.a.isAllIn = true;
    both.b.isAllIn = true;
    both.a.hasActed = true;
    both.b.hasActed = true;
    both.room.skillState.callToZeroAggressorId = both.a.playerId;
    expect(both.engine.tryOpenEndgameResponseWindow(both.room)).toBe(true);
    expect(both.room.skillState.endgameWindow.playerId).toBe(both.a.playerId);

    const skipped = setupRoom({ loadoutA: ["ENDGAME"], loadoutB: ["DEFENSE", "RECYCLE"] });
    skipped.a.skillRuntime.abyssEnergy = 8;
    skipped.b.chips = 0;
    skipped.b.isAllIn = true;
    skipped.a.hasActed = true;
    skipped.a.streetBet = skipped.room.currentBet;
    skipped.room.skillState.callToZeroAggressorId = skipped.a.playerId;
    expect(skipped.engine.tryOpenEndgameResponseWindow(skipped.room)).toBe(true);
    const holderIndex = skipped.room.players.findIndex((player) => player.playerId === skipped.a.playerId);
    expect(skipped.engine.handlePlayerAction(skipped.room, holderIndex, "skip_endgame")).toMatchObject({ ok: true, skippedEndgame: true });
    expect(skipped.room.skillState.endgameWindow).toBeNull();
    expect(skipped.room.skillState.endgameActive).toBeFalsy();

    const ownerLead = setupRoom({ loadoutA: ["ENDGAME"], loadoutB: ["DEFENSE", "RECYCLE"] });
    ownerLead.a.skillRuntime.abyssEnergy = 8;
    setFacing(ownerLead.room, ownerLead.a, ownerLead.b, { aBet: 300, bBet: 100, aChips: 700, bChips: 900 });
    expect(use(ownerLead.engine, ownerLead.room, ownerLead.a, "ENDGAME", {}, "owner-unmatched")).toMatchObject({ status: "SUCCESS" });
    expect(ownerLead.room.skillState.endgameActive.confiscated).toBe(0);
    expect(ownerLead.room.skillState.endgameActive.ownerUnmatched).toBe(200);
    expect(ownerLead.a.skillRuntime.directChipGainThisHand || 0).toBe(0);

    const weakBot = setupRoom({ loadoutA: ["ENDGAME"], loadoutB: ["DEFENSE", "RECYCLE"] });
    weakBot.a.isBot = true;
    weakBot.a.skillRuntime.abyssEnergy = 8;
    weakBot.room.communityCards = [];
    weakBot.a.cards = [card("S2", "S", "2", 2), card("D3", "D", "3", 3)];
    expect(weakBot.engine.shouldBotUseEndgame(weakBot.room, weakBot.a)).toBe(true);

    const strongBot = setupRoom({ loadoutA: ["ENDGAME"], loadoutB: ["DEFENSE", "RECYCLE"] });
    strongBot.a.isBot = true;
    strongBot.a.skillRuntime.abyssEnergy = 8;
    strongBot.room.communityCards = [
      card("HK", "H", "K", 13), card("DK", "D", "K", 13), card("CK", "C", "K", 13),
      card("SK", "S", "K", 13), card("H2", "H", "2", 2),
    ];
    strongBot.a.cards = [card("SA", "S", "A", 14), card("DA", "D", "A", 14)];
    expect(strongBot.engine.shouldBotUseEndgame(strongBot.room, strongBot.a)).toBe(false);
  });

  test("E30 成功后不再生成普通主动技能窗口", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["BLOOD_BATTLE", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "ENDGAME", {}, "e30")).toMatchObject({ status: "SUCCESS" });
    expect(use(engine, room, a, "DEEP_BREATH", {}, "after").ok).toBe(false);
    expect(room.skillState.bettingClosed).toBe(true);
    expect(getValidActions(room, 0).validActions).toEqual([]);
  });
});
