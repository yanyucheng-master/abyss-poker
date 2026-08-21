"use strict";

const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { createDeck } = require("../utils/deck");
const { setPlayerLoadout } = require("../game/skills/skillEngine");
const { collectBet, getValidActions } = require("../game/pokerLogic");
const {
  INITIAL_STACK,
  MATCH_TOTAL_CHIPS,
  CHIP_REASON,
  truncateTowardZero,
  recycleRefund,
  defenseProtectedLoss,
  isLegalPlayerChipAmount,
  chipTotal,
  transferChips,
  assertIntegerEconomyState,
  assertNoNegativeChips,
} = require("../game/chipEconomy");
const logger = require("../utils/logger");
const eventBus = require("../utils/eventBus");

function makeIoStub() {
  const emits = [];
  return {
    emits,
    to: (target) => ({ emit: (event, payload) => emits.push({ target, event, payload }) }),
  };
}

function card(code) {
  const suit = code[0];
  const rank = code.slice(1);
  const map = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
  return { code, suit, rank, value: map[rank] || Number(rank) };
}

function setupRoom({
  loadoutA = ["RECYCLE", "DEEP_BREATH"],
  loadoutB = ["DEFENSE", "RECYCLE"],
  skillMode = SKILL_MODE.ABYSS,
  start = true,
} = {}) {
  const io = makeIoStub();
  const roomManager = new RoomManager({ logger, eventBus });
  const engine = new GameEngine({ io, roomManager, logger, eventBus, deckFactory: createDeck });
  const room = roomManager.createRoom(null, GAME_MODE.STANDARD, skillMode);
  const a = roomManager.joinRoom({ roomId: room.roomId, playerName: "A", playerId: "PA", socketId: "s1" }).player;
  const b = roomManager.joinRoom({ roomId: room.roomId, playerName: "B", playerId: "PB", socketId: "s2" }).player;
  if (skillMode === SKILL_MODE.ABYSS) {
    expect(setPlayerLoadout(a, loadoutA).ok).toBe(true);
    expect(setPlayerLoadout(b, loadoutB).ok).toBe(true);
  }
  if (start) {
    expect(engine.startHand(room)).toBe(true);
    engine.clearActionTimer(room);
  }
  return { io, engine, room, a, b };
}

function stopTimers(engine, room) {
  engine.clearActionTimer(room);
  if (room.nextHandTimer) {
    clearTimeout(room.nextHandTimer);
    room.nextHandTimer = null;
  }
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("INTEGER ECONOMY RULE V1 primitives", () => {
  test("MATCH_TOTAL_CHIPS 由初始筹码派生且为 2000", () => {
    expect(INITIAL_STACK).toBe(1000);
    expect(MATCH_TOTAL_CHIPS).toBe(2000);
  });

  test("truncate toward zero 不扩大负向惩罚", () => {
    expect(truncateTowardZero(262.5)).toBe(262);
    expect(truncateTowardZero(-262.5)).toBe(-262);
    expect(truncateTowardZero(-0.9) === 0).toBe(true);
  });

  test("Recycle floor(cost/2) 正式表", () => {
    const expected = [0, 0, 1, 1, 2, 2, 3, 3, 4];
    expected.forEach((refund, cost) => {
      expect(recycleRefund(cost)).toBe(refund);
    });
    expect(recycleRefund(1.5)).toBe(0);
  });

  test("Defense floor(loss/2)", () => {
    expect(defenseProtectedLoss(525)).toBe(262);
    expect(defenseProtectedLoss(1)).toBe(0);
    expect(defenseProtectedLoss(3)).toBe(1);
    expect(defenseProtectedLoss(999)).toBe(499);
  });

  test("玩家金额必须是安全非负整数", () => {
    expect(isLegalPlayerChipAmount(262)).toBe(true);
    expect(isLegalPlayerChipAmount(1)).toBe(true);
    expect(isLegalPlayerChipAmount(37.5)).toBe(false);
    expect(isLegalPlayerChipAmount(NaN)).toBe(false);
    expect(isLegalPlayerChipAmount(Infinity)).toBe(false);
    expect(isLegalPlayerChipAmount(-1)).toBe(false);
    expect(isLegalPlayerChipAmount("100")).toBe(false);
    expect(isLegalPlayerChipAmount(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  test("collectBet 拒绝浮点金额而不是截成整数", () => {
    const { room, a } = setupRoom({ start: true });
    const before = a.chips;
    expect(collectBet(room, a, 37.5)).toBe(0);
    expect(a.chips).toBe(before);
  });
});

describe("统一 transferChips 零和", () => {
  test("唯一 transferAmount：payer -= X 且 receiver += X", () => {
    const { room, a, b } = setupRoom();
    const before = chipTotal(room);
    const moved = transferChips(room, b, a, 262, CHIP_REASON.STANDARD_SETTLEMENT);
    expect(moved).toBe(262);
    expect(chipTotal(room)).toBe(before);
    expect(a.chips + b.chips + room.pot).toBe(MATCH_TOTAL_CHIPS);
  });

  test("Stack cap 在转移前完成，禁止负筹码后再 clamp", () => {
    const { room, a, b } = setupRoom();
    b.chips = 400;
    a.chips = MATCH_TOTAL_CHIPS - 400 - room.pot;
    const moved = transferChips(room, b, a, 525, CHIP_REASON.STANDARD_SETTLEMENT);
    expect(moved).toBe(400);
    expect(b.chips).toBe(0);
    expect(chipTotal(room)).toBe(MATCH_TOTAL_CHIPS);
    assertNoNegativeChips(room);
  });
});

describe("ECON-L Loan", () => {
  test("ECON-L01 Chip Loan 100：1100 / 900，总计 2000", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["RECYCLE", "DEEP_BREATH"] });
    a.skillRuntime.abyssEnergy = 8;
    room.currentPlayerIndex = 0;
    const beforeA = a.chips;
    const beforeB = b.chips;
    const beforeTotal = chipTotal(room);
    expect(engine.handleSkillUse(room, a, { skillId: "LOAN", target: { mode: "chip" }, requestId: "econ-l01" })).toMatchObject({ ok: true });
    expect(a.chips - beforeA).toBe(beforeB - b.chips);
    expect(a.chips - beforeA).toBe(100);
    expect(chipTotal(room)).toBe(beforeTotal);
    expect(chipTotal(room)).toBe(MATCH_TOTAL_CHIPS);
  });

  test("ECON-L02 债务 150 生成不改变筹码", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["RECYCLE", "DEEP_BREATH"] });
    a.skillRuntime.abyssEnergy = 8;
    room.currentPlayerIndex = 0;
    const chipsA = a.chips;
    const chipsB = b.chips;
    engine.handleSkillUse(room, a, { skillId: "LOAN", target: { mode: "chip" }, requestId: "econ-l02" });
    expect(a.skillRuntime.chipLoan.repay).toBe(150);
    expect(a.chips - chipsA).toBe(chipsB - b.chips);
    expect(chipTotal(room)).toBe(MATCH_TOTAL_CHIPS);
  });

  test("ECON-L03 150 完整偿还零和", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["RECYCLE", "DEEP_BREATH"] });
    a.chips = 400;
    b.chips = 1600 - room.pot;
    a.skillRuntime.chipLoans = [{ repay: 150, lenderId: b.playerId, skipCurrentEnd: false }];
    a.skillRuntime.chipLoan = { repay: 150, lenderId: b.playerId, skipCurrentEnd: false, count: 1 };
    const before = chipTotal(room);
    engine.skillEngine.applyLoanRepayments(room);
    expect(chipTotal(room)).toBe(before);
    expect(a.chips).toBe(250);
  });

  test("ECON-L04 只能偿还 80，residual 70", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["RECYCLE", "DEEP_BREATH"] });
    a.chips = 80;
    b.chips = MATCH_TOTAL_CHIPS - 80 - room.pot;
    a.skillRuntime.chipLoans = [{ repay: 150, lenderId: b.playerId, skipCurrentEnd: false }];
    a.skillRuntime.chipLoan = { repay: 150, lenderId: b.playerId, skipCurrentEnd: false, count: 1 };
    const before = chipTotal(room);
    engine.skillEngine.applyLoanRepayments(room);
    expect(chipTotal(room)).toBe(before);
    expect(a.chips).toBe(0);
    expect(a.skillRuntime.chipDebt).toBe(70);
  });

  test("ECON-L05 Fairness 清债筹码变化为 0", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["FAIRNESS", "RECYCLE"], loadoutB: ["LOAN", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 8;
    a.skillRuntime.chipDebt = 70;
    b.skillRuntime.chipDebt = 40;
    const beforeA = a.chips;
    const beforeB = b.chips;
    room.currentPlayerIndex = 0;
    expect(engine.handleSkillUse(room, a, { skillId: "FAIRNESS", target: {}, requestId: "econ-l05" })).toMatchObject({ ok: true });
    expect(a.chips).toBe(beforeA);
    expect(b.chips).toBe(beforeB);
    expect(a.skillRuntime.chipDebt).toBe(0);
    expect(b.skillRuntime.chipDebt).toBe(0);
  });
});

describe("ECON-D Defense", () => {
  test.each([
    ["ECON-D01", 525, 262],
    ["ECON-D02", 1, 0],
    ["ECON-D03", 3, 1],
    ["ECON-D04", 999, 499],
  ])("%s %i / 2 -> %i 且双方共用同一整数", (_id, loss, protectedLoss) => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["RECYCLE", "DEEP_BREATH"], loadoutB: ["DEFENSE", "RECYCLE"] });
    a.chips = 1000 + loss;
    b.chips = 1000 - loss;
    room.pot = 0;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.handStartChips = 1000;
    b.skillRuntime.defenseActive = true;
    const before = chipTotal(room);
    const details = engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: 1,
    });
    expect(details.finalTransfer).toBe(protectedLoss);
    expect(a.chips).toBe(1000 + protectedLoss);
    expect(b.chips).toBe(1000 - protectedLoss);
    expect(chipTotal(room)).toBe(before);
  });
});

describe("ECON-C Stack Cap", () => {
  test.each([
    ["ECON-C01", 525, 400, 400],
    ["ECON-C02", 525, 525, 525],
    ["ECON-C03", 526, 525, 525],
    ["ECON-C04", 525, 0, 0],
  ])("%s 理论 %i 可承担 %i -> 转 %i", (_id, theoretical, payable, expected) => {
    const { engine, room, a, b } = setupRoom();
    a.chips = 1000 + 0;
    b.chips = payable;
    room.pot = 0;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.handStartChips = 1000;
    a.skillRuntime.directChipGainThisHand = 0;
    const details = engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: 1,
      standardPokerNet: theoretical,
    });
    expect(details.finalTransfer).toBe(expected);
    expect(b.chips).toBe(payable - expected);
    expect(a.chips).toBe(1000 + expected);
    expect(a.chips + b.chips).toBe(1000 + payable);
    assertNoNegativeChips(room);
  });
});

describe("ECON-P Pot 与牌型奖励", () => {
  test("ECON-P01 双方 500 投入普通 Showdown 得到 1500 / 500", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["RECYCLE", "DEEP_BREATH"], loadoutB: ["RECYCLE", "DEEP_BREATH"] });
    room.phase = "river";
    room.pot = 1000;
    a.chips = 500;
    b.chips = 500;
    a.totalBet = 500;
    b.totalBet = 500;
    a.streetBet = 500;
    b.streetBet = 500;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.handStartChips = 1000;
    room.communityCards = ["S2", "D7", "C9", "H5", "S8"].map(card);
    a.cards = ["HA", "DA"].map(card);
    b.cards = ["C3", "D4"].map(card);
    engine.settleShowdown(room);
    stopTimers(engine, room);
    expect(room.pot).toBe(0);
    expect(a.chips).toBe(1500);
    expect(b.chips).toBe(500);
    expect(a.chips + b.chips).toBe(MATCH_TOTAL_CHIPS);
  });

  test("ECON-P02 双方 500 + Trips +25 -> 1525 / 475", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["RECYCLE", "DEEP_BREATH"], loadoutB: ["RECYCLE", "DEEP_BREATH"] });
    a.chips = 1500;
    b.chips = 500;
    room.pot = 0;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.handStartChips = 1000;
    const details = engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: 4,
    });
    expect(details.handRankBonusValue).toBe(25);
    expect(a.chips).toBe(1525);
    expect(b.chips).toBe(475);
    expect(a.chips + b.chips).toBe(MATCH_TOTAL_CHIPS);
  });

  test("ECON-P03 Blood x2 后不得出现负筹码或总量越界", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["BLOOD_BATTLE", "RECYCLE"], loadoutB: ["RECYCLE", "DEEP_BREATH"] });
    a.chips = 1500;
    b.chips = 500;
    room.pot = 0;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.handStartChips = 1000;
    a.skillRuntime.bloodBattleActive = true;
    engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: 4,
    });
    expect(a.chips).toBeLessThanOrEqual(MATCH_TOTAL_CHIPS);
    expect(b.chips).toBeGreaterThanOrEqual(0);
    expect(a.chips + b.chips).toBe(MATCH_TOTAL_CHIPS);
  });

  test("Defense 回调：已实现 +500 目标 250 最终 1250 / 750", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["RECYCLE", "DEEP_BREATH"], loadoutB: ["DEFENSE", "RECYCLE"] });
    a.chips = 1500;
    b.chips = 500;
    room.pot = 0;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.handStartChips = 1000;
    b.skillRuntime.defenseActive = true;
    engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: 1,
    });
    expect(a.chips).toBe(1250);
    expect(b.chips).toBe(750);
    expect(a.chips + b.chips).toBe(MATCH_TOTAL_CHIPS);
  });
});

describe("Hand Rank Bonus 零和表", () => {
  test.each([
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 25],
    [5, 50],
    [6, 75],
    [7, 100],
    [8, 250],
    [9, 400],
    [10, 500],
  ])("category %i bonus %i 仍严格零和", (category, bonus) => {
    const { engine, room, a, b } = setupRoom();
    a.chips = 1500;
    b.chips = 500;
    room.pot = 0;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.handStartChips = 1000;
    engine.skillEngine.applySettlementModifiers(room, {
      reason: "showdown",
      winner: a,
      winnerCategory: category,
    });
    expect(a.chips).toBe(1500 + bonus);
    expect(b.chips).toBe(500 - bonus);
    expect(a.chips + b.chips).toBe(MATCH_TOTAL_CHIPS);
  });
});

describe("Fold / Probe / Dead End / Retreat", () => {
  test("Probe +50 受 Stack Cap：目标 150 只能承担 120 则转 120", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["PROBE", "RECYCLE"], loadoutB: ["RECYCLE", "DEEP_BREATH"] });
    a.chips = 1000;
    b.chips = 120;
    room.pot = 0;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.handStartChips = 1000;
    a.skillRuntime.probeActive = true;
    engine.skillEngine.applySettlementModifiers(room, {
      reason: "fold",
      winner: a,
      foldOrigin: "user",
      standardPokerNet: 100,
    });
    expect(a.chips).toBe(1120);
    expect(b.chips).toBe(0);
    expect(a.chips + b.chips).toBe(1120);
  });

  test("Dead End 只允许单一 target transfer", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["DEAD_END", "PROBE"], loadoutB: ["RECYCLE", "DEEP_BREATH"] });
    a.chips = 1100;
    b.chips = 900;
    room.pot = 0;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.handStartChips = 1000;
    a.skillRuntime.probeActive = true;
    a.skillRuntime.deadEndActive = true;
    const details = engine.skillEngine.applySettlementModifiers(room, {
      reason: "fold",
      winner: a,
      foldOrigin: "user",
      standardPokerNet: 100,
    });
    expect(details.desiredTransfer).toBe(450);
    expect(a.chips).toBe(1450);
    expect(b.chips).toBe(550);
    expect(a.chips + b.chips).toBe(MATCH_TOTAL_CHIPS);
  });

  test("Retreat 退还贡献且不退已完成 Loan", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["RETREAT", "LOAN"], loadoutB: ["RECYCLE", "DEEP_BREATH"] });
    a.chips = 800;
    b.chips = 800;
    room.pot = 400;
    a.totalBet = 200;
    b.totalBet = 200;
    a.streetBet = 200;
    b.streetBet = 200;
    a.skillRuntime.directChipGainThisHand = 100;
    b.skillRuntime.directChipGainThisHand = -100;
    a.skillRuntime.retreatActive = true;
    engine.settleByRetreat(room, a);
    stopTimers(engine, room);
    expect(room.pot).toBe(0);
    expect(a.chips).toBe(1000);
    expect(b.chips).toBe(1000);
    expect(chipTotal(room)).toBe(MATCH_TOTAL_CHIPS);
  });
});

describe("输入 / 幂等 / 序列化", () => {
  test("Disguise 下 37.5 直接非法，不得 normalize", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["RECYCLE", "DEEP_BREATH"], loadoutB: ["DISGUISE", "RECYCLE"] });
    b.skillRuntime.abyssEnergy = 8;
    room.currentPlayerIndex = 1;
    expect(engine.handleSkillUse(room, b, { skillId: "DISGUISE", target: {}, requestId: "econ-dis" })).toMatchObject({ ok: true });
    room.currentPlayerIndex = 0;
    const before = { chips: a.chips, pot: room.pot };
    const result = engine.handlePlayerAction(room, 0, "raise", 37.5);
    expect(result.ok).toBe(false);
    expect(a.chips).toBe(before.chips);
    expect(room.pot).toBe(before.pot);
  });

  test("settleShowdown 第二次调用不得再次改筹码", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["RECYCLE", "DEEP_BREATH"], loadoutB: ["RECYCLE", "DEEP_BREATH"] });
    room.phase = "river";
    room.pot = 100;
    a.chips = 950;
    b.chips = 950;
    a.totalBet = 50;
    b.totalBet = 50;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.handStartChips = 1000;
    room.communityCards = ["S2", "D7", "C9", "H5", "S8"].map(card);
    a.cards = ["HA", "DA"].map(card);
    b.cards = ["C3", "D4"].map(card);
    engine.settleShowdown(room);
    stopTimers(engine, room);
    const snapshot = { a: a.chips, b: b.chips, pot: room.pot };
    engine.settleShowdown(room);
    expect(a.chips).toBe(snapshot.a);
    expect(b.chips).toBe(snapshot.b);
    expect(room.pot).toBe(snapshot.pot);
  });

  test("快照筹码字段为安全整数", () => {
    const { engine, room, a } = setupRoom();
    const snapshot = engine.getRoomSnapshot(room, a);
    expect(Number.isSafeInteger(snapshot.pot)).toBe(true);
    snapshot.players.forEach((player) => {
      if (player.chips != null) expect(Number.isSafeInteger(player.chips)).toBe(true);
    });
  });
});

describe("Property: 100000 随机结算守恒", () => {
  test("100000 个随机 settlement case 全部零和且为整数", () => {
    const { engine, room, a, b } = setupRoom();
    const random = mulberry32(20260822);
    const categories = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const multipliers = [1, 2, 3, 4, 6];
    let conservationFails = 0;
    let integerFails = 0;
    let negativeFails = 0;
    const cases = 100000;
    for (let i = 0; i < cases; i += 1) {
      const pokerNet = 1 + Math.floor(random() * 900);
      const payable = Math.floor(random() * 1001);
      const bonusCat = categories[Math.floor(random() * categories.length)];
      const blood = multipliers[Math.floor(random() * multipliers.length)];
      const defense = random() < 0.45;
      a.chips = 1000 + pokerNet;
      b.chips = payable;
      room.pot = 0;
      a.skillRuntime.handStartChips = 1000;
      b.skillRuntime.handStartChips = 1000;
      a.skillRuntime.directChipGainThisHand = 0;
      a.skillRuntime.bloodBattleActive = blood > 1;
      b.skillRuntime.defenseActive = defense;
      b.skillRuntime.foldedThisHand = false;
      const before = a.chips + b.chips;
      engine.skillEngine.applySettlementModifiers(room, {
        reason: "showdown",
        winner: a,
        winnerCategory: bonusCat,
        standardPokerNet: pokerNet,
      });
      const after = a.chips + b.chips;
      if (after !== before) conservationFails += 1;
      if (!Number.isSafeInteger(a.chips) || !Number.isSafeInteger(b.chips)) integerFails += 1;
      if (a.chips < 0 || b.chips < 0) negativeFails += 1;
    }
    expect(conservationFails).toBe(0);
    expect(integerFails).toBe(0);
    expect(negativeFails).toBe(0);
  });
});

describe("Match 级随机守恒", () => {
  test("10000 完整 Match 逐步守恒", () => {
    const random = mulberry32(220826);
    let conservationFails = 0;
    let integerFails = 0;
    let negativeFails = 0;
    const matches = 10000;
    for (let match = 0; match < matches; match += 1) {
      const { engine, room, a, b } = setupRoom({
        loadoutA: ["RECYCLE", "DEEP_BREATH"],
        loadoutB: ["DEFENSE", "RECYCLE"],
        start: false,
      });
      a.skillRuntime.abyssEnergy = 4;
      b.skillRuntime.abyssEnergy = 4;
      let hands = 0;
      while (hands < 40 && a.chips > 0 && b.chips > 0) {
        const started = engine.startHand(room);
        if (!started) break;
        stopTimers(engine, room);
        hands += 1;
        if (chipTotal(room) !== MATCH_TOTAL_CHIPS) conservationFails += 1;
        let steps = 0;
        while (["pre_flop", "flop", "turn", "river"].includes(room.phase) && steps < 24) {
          steps += 1;
          const idx = room.currentPlayerIndex;
          const player = room.players[idx];
          if (!player || player.status !== "active") break;
          const turn = getValidActions(room, idx);
          const actions = turn?.validActions || [];
          if (!actions.length) break;
          const roll = random();
          let action = "fold";
          if (actions.includes("check") && roll < 0.45) action = "check";
          else if (actions.includes("call") && roll < 0.7) action = "call";
          else if (actions.includes("raise") && roll < 0.88) action = "raise";
          else if (actions.includes("allin") && roll < 0.94) action = "allin";
          else if (actions.includes("fold")) action = "fold";
          else action = actions[0];
          const amount = action === "raise" ? turn.minRaiseTo : undefined;
          engine.handlePlayerAction(room, idx, action, amount);
          stopTimers(engine, room);
          if (chipTotal(room) !== MATCH_TOTAL_CHIPS) conservationFails += 1;
          assertIntegerEconomyState(room);
          if (!Number.isSafeInteger(a.chips) || !Number.isSafeInteger(b.chips) || !Number.isSafeInteger(room.pot)) {
            integerFails += 1;
          }
          if (a.chips < 0 || b.chips < 0 || room.pot < 0) negativeFails += 1;
        }
        if (["pre_flop", "flop", "turn", "river"].includes(room.phase)) {
          const idx = room.currentPlayerIndex;
          const leftover = getValidActions(room, idx).validActions || [];
          if (leftover.includes("fold")) engine.handlePlayerAction(room, idx, "fold");
          else if (leftover.includes("check")) engine.handlePlayerAction(room, idx, "check");
          else if (leftover.includes("call")) engine.handlePlayerAction(room, idx, "call");
          stopTimers(engine, room);
        }
        stopTimers(engine, room);
        if (room.pot === 0 && a.chips + b.chips !== MATCH_TOTAL_CHIPS) conservationFails += 1;
      }
    }
    expect(conservationFails).toBe(0);
    expect(integerFails).toBe(0);
    expect(negativeFails).toBe(0);
  }, 180000);
});
