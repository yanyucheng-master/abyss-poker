const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const { SKILL_CONFIG, PERCEPTION_CONFIG, FORTUNE_RULE, SKILL_RULE_FREEZE } = require("../game/skillConfig");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { createDeck } = require("../utils/deck");
const { resetPlayerSkillsForHand } = require("../game/skills/skillState");
const {
  FORTUNE_CONFIG,
  validateLoadout,
  setPlayerLoadout,
  isChipViewHiddenFor,
} = require("../game/skills/skillEngine");
const { listSkillDefinitions } = require("../game/skills/definitions");
const { computeFortuneChance } = require("../game/skills/fortuneConfig");
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

function zoneCodes(room, a, b) {
  return [
    ...a.cards, ...b.cards, ...room.communityCards, ...room.deck,
    ...(room.skillState.burnedCards || []), ...(room.skillState.removedCards || []),
  ].map((card) => card.code);
}

describe("首发 24 技能冻结核对", () => {
  test("感知与强运仍为 FROZEN_V1，概率未改", () => {
    expect(SKILL_RULE_FREEZE.PERCEPTION.status).toBe("FROZEN_V1");
    expect(PERCEPTION_CONFIG.baseChance).toBe(0.25);
    expect(PERCEPTION_CONFIG.maxChance).toBe(0.5);
    expect(PERCEPTION_CONFIG.truthChance).toBe(0.75);
    expect(SKILL_RULE_FREEZE.FORTUNE).toMatchObject({ status: "FROZEN_V1", variant: "soft-v1" });
    expect(FORTUNE_RULE.status).toBe("FROZEN_V1");
    expect(FORTUNE_CONFIG.rewriteCost).toBe(3);
    expect(FORTUNE_CONFIG.minEnergy).toBe(-4);
    expect(computeFortuneChance("hole", { disadvantage: 0, energy: 4 })).toBeCloseTo(0.0805, 3);
    expect(computeFortuneChance("board", { disadvantage: 0, energy: 4 })).toBeCloseTo(0.0539, 3);
    expect(computeFortuneChance("resource", { disadvantage: 0, energy: 4 })).toBeCloseTo(0.16, 3);
    expect(computeFortuneChance("hole", { disadvantage: 1, energy: 4 })).toBeCloseTo(0.1897, 3);
    expect(computeFortuneChance("board", { disadvantage: 1, energy: 4 })).toBeCloseTo(0.1131, 3);
    expect(computeFortuneChance("resource", { disadvantage: 1, energy: 4 })).toBeCloseTo(0.2, 3);
  });

  test("24 主体技能均存在，构筑仍为最多 4 / 负载 8", () => {
    const ids = listSkillDefinitions().map((skill) => skill.id);
    [
      "LOAN", "ALERT", "RETREAT", "RESTART", "PROBE", "DISGUISE", "ENDGAME",
    ].forEach((id) => expect(ids).toContain(id));
    expect(SKILL_CONFIG.MAX_EQUIPPED_SKILLS).toBe(4);
    expect(SKILL_CONFIG.MIN_EQUIPPED_SKILLS).toBe(1);
    expect(SKILL_CONFIG.MAX_SKILL_LOAD).toBe(8);
    expect(validateLoadout(["ENDGAME"]).ok).toBe(true);
    expect(validateLoadout(["ENDGAME", "CHEAT"]).ok).toBe(false);
  });
});

describe("贷款", () => {
  test("筹码贷款 100/150，对手≤100 时可斩杀", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    b.chips = 80;
    expect(use(engine, room, a, "LOAN", { mode: "chip" }, "loan-kill")).toMatchObject({ status: "SUCCESS" });
    expect(b.chips).toBe(0);
    expect(b.status).toBe("out");
    expect(a.chips).toBeGreaterThan(1000);
  });

  test("偿还可以使自己归零；公平清债务但不回滚已得资源", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "FAIRNESS"], loadoutB: ["DEFENSE", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 8;
    const beforeB = b.chips;
    expect(use(engine, room, a, "LOAN", { mode: "chip" }, "loan-chip")).toMatchObject({ status: "SUCCESS" });
    expect(b.chips).toBe(beforeB - 100);
    expect(a.skillRuntime.chipLoan.repay).toBe(150);
    expect(use(engine, room, a, "FAIRNESS", {}, "fair-loan")).toMatchObject({ status: "SUCCESS" });
    expect(a.skillRuntime.chipLoan).toBeNull();
    expect(b.chips).toBe(beforeB - 100);

    const repay = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    expect(use(repay.engine, repay.room, repay.a, "LOAN", { mode: "chip" }, "loan-repay")).toMatchObject({ status: "SUCCESS" });
    repay.engine.skillEngine.endHand(repay.room, { reason: "showdown", winner: repay.a, tie: false });
    repay.a.chips = 120;
    repay.engine.skillEngine.endHand(repay.room, { reason: "showdown", winner: repay.a, tie: false });
    expect(repay.a.chips).toBe(0);
    expect(repay.a.skillRuntime.chipLoan).toBeNull();
  });

  test("能量贷款 +5 / 偿还 6，不足进入债务", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 4;
    expect(use(engine, room, a, "LOAN", { mode: "energy" }, "loan-energy")).toMatchObject({ status: "SUCCESS" });
    expect(a.skillRuntime.abyssEnergy).toBe(7);
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    a.skillRuntime.abyssEnergy = 3;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(a.skillRuntime.abyssEnergy).toBe(0);
    expect(a.skillRuntime.energyDebt).toBe(3);
    engine.skillEngine.endHand(room, { reason: "showdown", winner: null, tie: true });
    // 平局 +0，债务仍在，后续 +1 会优先偿债
    a.skillRuntime.energyDebt = 3;
    engine.skillEngine.endHand(room, { reason: "fold", winner: room.players[1], tie: false });
    expect(a.skillRuntime.energyDebt).toBe(2);
  });
});

describe("警觉", () => {
  test("只监听隐藏主动，公开/被动不推进，阶梯与跨手保留正确", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["DEFENSE", "BLOOD_BATTLE"],
      loadoutB: ["ALERT", "RECYCLE"],
    });
    a.skillRuntime.abyssEnergy = 8;
    expect(b.skillRuntime.alertChanceIndex).toBe(0);
    expect(use(engine, room, a, "BLOOD_BATTLE", {}, "pub")).toMatchObject({ status: "SUCCESS" });
    expect(b.skillRuntime.alertChanceIndex).toBe(0);
    expect(use(engine, room, a, "DEFENSE", {}, "hid-1")).toMatchObject({ status: "SUCCESS" });
    expect(b.skillRuntime.alertChanceIndex).toBe(1);

    const persist = setupRoom({
      loadoutA: ["DEFENSE", "RECYCLE"],
      loadoutB: ["ALERT", "RECYCLE"],
    });
    persist.b.skillRuntime.alertChanceIndex = 3;
    resetPlayerSkillsForHand(persist.b);
    expect(persist.b.skillRuntime.alertChanceIndex).toBe(3);

    const hit = setupRoom({
      loadoutA: ["DEFENSE", "COUNTER"],
      loadoutB: ["ALERT", "RECYCLE"],
      random: () => 0,
    });
    expect(use(hit.engine, hit.room, hit.a, "DEFENSE", {}, "hid-hit")).toMatchObject({ status: "SUCCESS" });
    expect(hit.b.skillRuntime.alertChanceIndex).toBe(0);
    expect(hit.b.skillRuntime.alertPromptPending).toBe(true);
    const alertLogCount = hit.room.skillState.skillActionLog.filter((entry) => entry.skillId === "ALERT").length;
    hit.a.skillRuntime.abyssEnergy = 8;
    expect(use(hit.engine, hit.room, hit.a, "COUNTER", {}, "hid-second")).toMatchObject({ status: "SUCCESS" });
    expect(hit.room.skillState.skillActionLog.filter((entry) => entry.skillId === "ALERT")).toHaveLength(alertLogCount);
    expect(hit.b.skillRuntime.alertPromptPending).toBe(true);
    hit.engine.skillEngine.onBettingDecisionStart(hit.room, hit.b);
    const privateMsg = hit.b.skillRuntime.privateResults.at(-1).message;
    expect(privateMsg).toBe(SKILL_CONFIG.ALERT_MESSAGE);
    expect(privateMsg).not.toContain("一次");

    const cleared = setupRoom({
      loadoutA: ["DEFENSE", "FAIRNESS"],
      loadoutB: ["ALERT", "RECYCLE"],
      random: () => 0,
    });
    cleared.a.skillRuntime.abyssEnergy = 8;
    expect(use(cleared.engine, cleared.room, cleared.a, "DEFENSE", {}, "alert-pending")).toMatchObject({ status: "SUCCESS" });
    expect(cleared.b.skillRuntime.alertPromptPending).toBe(true);
    expect(use(cleared.engine, cleared.room, cleared.a, "FAIRNESS", {}, "alert-fair")).toMatchObject({ status: "SUCCESS" });
    expect(cleared.b.skillRuntime.alertPromptPending).toBe(false);
  });
});

describe("撤退", () => {
  test("触发时返还双方标准贡献且无败者+1；未用则正常+1", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["RETREAT", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    const startA = a.chips + a.totalBet;
    const startB = b.chips + b.totalBet;
    a.skillRuntime.abyssEnergy = 6;
    expect(use(engine, room, a, "RETREAT", {}, "ret")).toMatchObject({ status: "SUCCESS" });
    const energyAfter = a.skillRuntime.abyssEnergy;
    engine.handlePlayerAction(room, 0, "fold", 0);
    expect(a.chips + b.chips).toBe(startA + startB);
    expect(room.pot).toBe(0);
    expect(a.skillRuntime.abyssEnergy).toBe(energyAfter);

    const unused = setupRoom({ loadoutA: ["RETREAT", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    unused.a.skillRuntime.abyssEnergy = 6;
    expect(use(unused.engine, unused.room, unused.a, "RETREAT", {}, "ret-unused")).toMatchObject({ status: "SUCCESS" });
    unused.engine.skillEngine.endHand(unused.room, { reason: "showdown", winner: unused.b, tie: false });
    expect(unused.a.skillRuntime.abyssEnergy).toBe(4);
  });

  test("绝路不清撤退；公平清除；恐吓禁止撤退 Fold", () => {
    const keep = setupRoom({ loadoutA: ["RETREAT", "RECYCLE"], loadoutB: ["DEAD_END", "DEEP_BREATH"] });
    keep.a.skillRuntime.abyssEnergy = 6;
    keep.b.skillRuntime.abyssEnergy = 8;
    expect(use(keep.engine, keep.room, keep.a, "RETREAT", {}, "ret-keep")).toMatchObject({ status: "SUCCESS" });
    keep.room.currentPlayerIndex = 1;
    expect(use(keep.engine, keep.room, keep.b, "DEAD_END", {}, "dead")).toMatchObject({ status: "SUCCESS" });
    expect(keep.a.skillRuntime.retreatActive).toBe(true);

    const fair = setupRoom({ loadoutA: ["RETREAT", "FAIRNESS"], loadoutB: ["DEFENSE", "RECYCLE"] });
    fair.a.skillRuntime.abyssEnergy = 8;
    expect(use(fair.engine, fair.room, fair.a, "RETREAT", {}, "ret-fair")).toMatchObject({ status: "SUCCESS" });
    expect(use(fair.engine, fair.room, fair.a, "FAIRNESS", {}, "fair")).toMatchObject({ status: "SUCCESS" });
    expect(fair.a.skillRuntime.retreatActive).toBe(false);

    const fear = setupRoom({ loadoutA: ["RETREAT", "RECYCLE"], loadoutB: ["INTIMIDATION", "DEEP_BREATH"] });
    fear.a.skillRuntime.abyssEnergy = 6;
    fear.b.skillRuntime.abyssEnergy = 8;
    expect(use(fear.engine, fear.room, fear.a, "RETREAT", {}, "ret-fear")).toMatchObject({ status: "SUCCESS" });
    fear.room.currentPlayerIndex = 1;
    expect(use(fear.engine, fear.room, fear.b, "INTIMIDATION", {}, "fear")).toMatchObject({ status: "SUCCESS" });
    fear.room.currentPlayerIndex = 0;
    expect(fear.engine.handlePlayerAction(fear.room, 0, "fold", 0).ok).toBe(false);
  });
});

describe("重启", () => {
  test("两张一起洗入后再抽，允许抽回原牌，保持 52 张唯一，公平不能回滚", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["RESTART", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    const original = a.cards.map((card) => card.code);
    a.skillRuntime.abyssEnergy = 6;
    expect(use(engine, room, a, "RESTART", {}, "restart")).toMatchObject({ status: "SUCCESS" });
    expect(a.cards).toHaveLength(2);
    const codes = zoneCodes(room, a, b);
    expect(codes).toHaveLength(52);
    expect(new Set(codes).size).toBe(52);
    expect([...a.cards.map((card) => card.code), ...room.deck.map((card) => card.code)]).toEqual(
      expect.arrayContaining(original)
    );
    const fair = setupRoom({ loadoutA: ["RESTART", "FAIRNESS"], loadoutB: ["DEFENSE", "RECYCLE"] });
    fair.a.skillRuntime.abyssEnergy = 8;
    expect(use(fair.engine, fair.room, fair.a, "RESTART", {}, "rs")).toMatchObject({ status: "SUCCESS" });
    const kept = fair.a.cards.map((card) => card.code);
    expect(use(fair.engine, fair.room, fair.a, "FAIRNESS", {}, "fair")).toMatchObject({ status: "SUCCESS" });
    expect(fair.a.cards.map((card) => card.code)).toEqual(kept);
  });
});

describe("试探", () => {
  test("对手普通 Fold 先 +50 再倍率；自己 Fold 不触发；公平可清除", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["PROBE", "BLOOD_BATTLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "PROBE", {}, "probe")).toMatchObject({ status: "SUCCESS" });
    expect(use(engine, room, a, "BLOOD_BATTLE", {}, "bb")).toMatchObject({ status: "SUCCESS" });
    a.chips = 1100;
    b.chips = 900;
    a.skillRuntime.handStartChips = 1000;
    a.skillRuntime.directChipGainThisHand = 0;
    const details = engine.skillEngine.applySettlementModifiers(room, { reason: "fold", winner: a, tie: false });
    expect(details.effects.some((entry) => entry.skillId === "PROBE")).toBe(true);
    expect(details.baseTransfer).toBe(150);
    expect(details.multiplier).toBe(2);
    expect(a.chips).toBe(1300);
    expect(b.chips).toBe(700);

    const selfFold = setupRoom({ loadoutA: ["PROBE", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    expect(use(selfFold.engine, selfFold.room, selfFold.a, "PROBE", {}, "self")).toMatchObject({ status: "SUCCESS" });
    const no = selfFold.engine.skillEngine.applySettlementModifiers(selfFold.room, {
      reason: "fold", winner: selfFold.b, tie: false,
    });
    expect(no.effects.some((entry) => entry.skillId === "PROBE")).toBe(false);

    const timeout = setupRoom({ loadoutA: ["PROBE", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    timeout.a.skillRuntime.probeActive = true;
    timeout.a.chips = 1100;
    timeout.b.chips = 900;
    timeout.a.skillRuntime.handStartChips = 1000;
    const timeoutDetails = timeout.engine.skillEngine.applySettlementModifiers(timeout.room, {
      reason: "fold",
      winner: timeout.a,
      tie: false,
      foldOrigin: "timeout",
    });
    expect(timeoutDetails.effects.some((entry) => entry.skillId === "PROBE")).toBe(false);
    expect(timeout.a.chips).toBe(1100);
    expect(timeout.b.chips).toBe(900);

    const fair = setupRoom({ loadoutA: ["PROBE", "FAIRNESS"], loadoutB: ["DEFENSE", "RECYCLE"] });
    fair.a.skillRuntime.abyssEnergy = 8;
    expect(use(fair.engine, fair.room, fair.a, "PROBE", {}, "p")).toMatchObject({ status: "SUCCESS" });
    expect(use(fair.engine, fair.room, fair.a, "FAIRNESS", {}, "f")).toMatchObject({ status: "SUCCESS" });
    expect(fair.a.skillRuntime.probeActive).toBe(false);
  });
});

describe("伪装", () => {
  test("单方时发动者视角正常，对手视图隐藏筹码与金额；双方进入黑暗筹码", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["DISGUISE", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    expect(use(engine, room, a, "DISGUISE", {}, "dis")).toMatchObject({ status: "SUCCESS" });
    expect(isChipViewHiddenFor(room, a)).toBe(false);
    expect(isChipViewHiddenFor(room, b)).toBe(true);
    const hidden = engine.getRoomSnapshot(room, b);
    expect(hidden.chipViewHidden).toBe(true);
    expect(hidden.pot).toBeNull();
    expect(hidden.players.every((player) => player.chips == null)).toBe(true);
    const visible = engine.getRoomSnapshot(room, a);
    expect(visible.chipViewHidden).toBe(false);
    expect(typeof visible.players[0].chips).toBe("number");

    const both = setupRoom({ loadoutA: ["DISGUISE", "RECYCLE"], loadoutB: ["DISGUISE", "RECYCLE"] });
    expect(use(both.engine, both.room, both.a, "DISGUISE", {}, "d1")).toMatchObject({ status: "SUCCESS" });
    both.room.currentPlayerIndex = 1;
    expect(use(both.engine, both.room, both.b, "DISGUISE", {}, "d2")).toMatchObject({ status: "SUCCESS" });
    expect(isChipViewHiddenFor(both.room, both.a)).toBe(true);
    expect(isChipViewHiddenFor(both.room, both.b)).toBe(true);
  });

  test("本人能看见自己 ALL IN；绝路 ALL IN 强制公开；公平清除；灵视不含筹码数字", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["DISGUISE", "DEAD_END"], loadoutB: ["CLAIRVOYANCE", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "DISGUISE", {}, "d")).toMatchObject({ status: "SUCCESS" });
    a.isAllIn = true;
    const selfView = engine.getViewPlayers(room, a).find((player) => player.playerId === a.playerId);
    expect(selfView.isAllIn).toBe(true);
    const oppView = engine.getViewPlayers(room, b).find((player) => player.playerId === a.playerId);
    expect(oppView.isAllIn).toBe(false);
    a.isAllIn = false;
    expect(use(engine, room, a, "DEAD_END", {}, "dead")).toMatchObject({ status: "SUCCESS" });
    const forced = engine.getViewPlayers(room, b).find((player) => player.playerId === a.playerId);
    expect(forced.isAllIn).toBe(true);

    const fair = setupRoom({ loadoutA: ["DISGUISE", "FAIRNESS"], loadoutB: ["DEFENSE", "RECYCLE"] });
    fair.a.skillRuntime.abyssEnergy = 8;
    expect(use(fair.engine, fair.room, fair.a, "DISGUISE", {}, "d3")).toMatchObject({ status: "SUCCESS" });
    expect(use(fair.engine, fair.room, fair.a, "FAIRNESS", {}, "f")).toMatchObject({ status: "SUCCESS" });
    expect(fair.a.skillRuntime.disguiseActive).toBe(false);

    const spy = setupRoom({ loadoutA: ["CLAIRVOYANCE", "RECYCLE"], loadoutB: ["DISGUISE", "RECYCLE"] });
    spy.room.currentPlayerIndex = 1;
    expect(use(spy.engine, spy.room, spy.b, "DISGUISE", {}, "d4")).toMatchObject({ status: "SUCCESS" });
    spy.room.currentPlayerIndex = 0;
    expect(use(spy.engine, spy.room, spy.a, "CLAIRVOYANCE", {}, "cv")).toMatchObject({ status: "SUCCESS" });
    const msg = spy.a.skillRuntime.privateResults.at(-1).message;
    expect(msg).toContain("能量");
    expect(msg).not.toMatch(/筹码\s*\d/);
  });
});

describe("终局", () => {
  test("没收未匹配筹码不进倍率，成功后关闭下注并强制摊牌", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["BLOOD_BATTLE", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 8;
    b.skillRuntime.bloodBattleActive = true;
    a.totalBet = 100;
    b.totalBet = 300;
    a.streetBet = 100;
    b.streetBet = 300;
    room.pot = 400;
    a.chips = 900;
    b.chips = 700;
    a.skillRuntime.handStartChips = 1000;
    expect(use(engine, room, a, "ENDGAME", {}, "eg")).toMatchObject({ status: "SUCCESS" });
    expect(room.skillState.bettingClosed).toBe(true);
    expect(room.skillState.endgameActive.confiscated).toBe(200);
    expect(a.skillRuntime.directChipGainThisHand).toBe(200);
    expect(["showdown", "end"]).toContain(room.phase);
  });

  test("处决：同牌型等级发动者直接获胜；不同牌型正常比较", () => {
    const same = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["DEFENSE", "RECYCLE"] });
    same.room.skillState.endgameActive = { casterId: same.a.playerId, execution: true, confiscated: 0 };
    same.room.communityCards = [
      { code: "H2", suit: "H", rank: "2", value: 2 },
      { code: "C9", suit: "C", rank: "9", value: 9 },
      { code: "S5", suit: "S", rank: "5", value: 5 },
      { code: "D7", suit: "D", rank: "7", value: 7 },
      { code: "H8", suit: "H", rank: "8", value: 8 },
    ];
    same.a.cards = [
      { code: "S2", suit: "S", rank: "2", value: 2 },
      { code: "D3", suit: "D", rank: "3", value: 3 },
    ];
    same.b.cards = [
      { code: "SA", suit: "S", rank: "A", value: 14 },
      { code: "DA", suit: "D", rank: "A", value: 14 },
    ];
    same.room.phase = "river";
    same.room.pot = 100;
    same.engine.settleShowdown(same.room);
    expect(same.room.lastHandResult.winner).toBe(same.a.playerId);
    expect(same.room.lastHandResult.endgameExecution).toBe(true);

    const diff = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["DEFENSE", "RECYCLE"] });
    diff.room.skillState.endgameActive = { casterId: diff.a.playerId, execution: true, confiscated: 0 };
    diff.room.communityCards = [
      { code: "H2", suit: "H", rank: "2", value: 2 },
      { code: "C2", suit: "C", rank: "2", value: 2 },
      { code: "S2", suit: "S", rank: "2", value: 2 },
      { code: "D7", suit: "D", rank: "7", value: 7 },
      { code: "H9", suit: "H", rank: "9", value: 9 },
    ];
    diff.a.cards = [
      { code: "S3", suit: "S", rank: "3", value: 3 },
      { code: "D4", suit: "D", rank: "4", value: 4 },
    ];
    diff.b.cards = [
      { code: "SA", suit: "S", rank: "A", value: 14 },
      { code: "DA", suit: "D", rank: "A", value: 14 },
    ];
    diff.room.phase = "river";
    diff.room.pot = 100;
    diff.engine.settleShowdown(diff.room);
    expect(diff.room.lastHandResult.endgameExecution).toBe(false);
    expect(diff.room.lastHandResult.winner).toBe(diff.b.playerId);
  });

  test("可被反制且不改变原下注；公平后不可发动；Call 至 0 打开响应窗口", () => {
    const countered = setupRoom({
      loadoutA: ["ENDGAME", "DEEP_BREATH"],
      loadoutB: ["COUNTER", "RECYCLE"],
    });
    countered.a.skillRuntime.abyssEnergy = 8;
    countered.b.skillRuntime.counterArmed = true;
    countered.a.totalBet = 100;
    countered.b.totalBet = 300;
    countered.room.pot = 400;
    const pot = countered.room.pot;
    expect(use(countered.engine, countered.room, countered.a, "ENDGAME", {}, "eg-c")).toMatchObject({ status: "COUNTERED" });
    expect(countered.room.pot).toBe(pot);
    expect(countered.room.skillState.endgameActive).toBeFalsy();
    expect(countered.a.skillRuntime.abyssEnergy).toBe(0);

    const fair = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["DEFENSE", "RECYCLE"] });
    fair.a.skillRuntime.abyssEnergy = 8;
    fair.room.skillState.fairnessActive = true;
    fair.a.skillRuntime.lockedThisHand = true;
    expect(use(fair.engine, fair.room, fair.a, "ENDGAME", {}, "blocked").ok).toBe(false);

    const windowRoom = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"], loadoutB: ["DEFENSE", "RECYCLE"] });
    windowRoom.a.skillRuntime.abyssEnergy = 8;
    windowRoom.b.chips = 0;
    windowRoom.b.isAllIn = true;
    windowRoom.a.hasActed = true;
    windowRoom.a.streetBet = windowRoom.room.currentBet;
    windowRoom.room.skillState.callToZeroAggressorId = windowRoom.a.playerId;
    expect(windowRoom.engine.tryOpenEndgameResponseWindow(windowRoom.room)).toBe(true);
    expect(windowRoom.room.skillState.endgameWindow.playerId).toBe(windowRoom.a.playerId);
  });
});

describe("协议与 Counter 覆盖", () => {
  test("皇家同花顺归同花顺协议；新主动技能可被反制", () => {
    const royal = setupRoom({ loadoutA: ["PROTOCOL_STRAIGHT_FLUSH", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    royal.a.chips = 1100;
    royal.a.skillRuntime.handStartChips = 1000;
    expect(royal.engine.skillEngine.applySettlementModifiers(royal.room, {
      reason: "showdown", winner: royal.a, winnerCategory: 10,
    }).effects.some((entry) => entry.skillId === "PROTOCOL_STRAIGHT_FLUSH")).toBe(true);

    const trap = setupRoom({
      loadoutA: ["PROBE", "RECYCLE"],
      loadoutB: ["COUNTER", "RECYCLE"],
    });
    trap.b.skillRuntime.counterArmed = true;
    expect(use(trap.engine, trap.room, trap.a, "PROBE", {}, "probe-c")).toMatchObject({ status: "COUNTERED" });
    expect(trap.a.skillRuntime.lockedThisHand).toBe(true);
  });
});
