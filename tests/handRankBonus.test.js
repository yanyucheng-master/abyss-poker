const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { createDeck } = require("../utils/deck");
const { pickBestFive } = require("../game/handEvaluator");
const {
  SkillEngine,
  initPlayerForSkillMode,
  setPlayerLoadout,
} = require("../game/skills/skillEngine");
const {
  HAND_RANK_BONUS,
  HAND_RANK_BONUS_BY_CATEGORY,
  HAND_RANK_BONUS_TABLE_VERSION,
  HAND_CATEGORY,
  getHandRankBonusValue,
} = require("../game/handRankBonus");
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
  start = true,
} = {}) {
  const io = makeIoStub();
  const roomManager = new RoomManager({ logger, eventBus });
  const engine = new GameEngine({ io, roomManager, logger, eventBus, deckFactory: createDeck });
  const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.ABYSS);
  const a = roomManager.joinRoom({ roomId: room.roomId, playerName: "A", playerId: "PA", socketId: "s1" }).player;
  const b = roomManager.joinRoom({ roomId: room.roomId, playerName: "B", playerId: "PB", socketId: "s2" }).player;
  expect(setPlayerLoadout(a, loadoutA).ok).toBe(true);
  expect(setPlayerLoadout(b, loadoutB).ok).toBe(true);
  if (start) {
    engine.startHand(room);
    engine.clearActionTimer(room);
  }
  return { io, engine, room, a, b };
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
  return a.chips + b.chips;
}

function settle(engine, room, winner, category, extra = {}) {
  return engine.skillEngine.applySettlementModifiers(room, {
    reason: extra.reason || "showdown",
    winner,
    tie: Boolean(extra.tie),
    winnerCategory: category,
    foldOrigin: extra.foldOrigin || "user",
  });
}

describe("牌型基础奖励表 launch-v1", () => {
  test("HR01-HR10 查表与 Royal 独立 category 10", () => {
    expect(HAND_RANK_BONUS_TABLE_VERSION).toBe("launch-v1");
    expect(HAND_RANK_BONUS).toEqual({
      HIGH_CARD: 0,
      ONE_PAIR: 0,
      TWO_PAIR: 0,
      THREE_OF_A_KIND: 25,
      STRAIGHT: 50,
      FLUSH: 75,
      FULL_HOUSE: 100,
      FOUR_OF_A_KIND: 250,
      STRAIGHT_FLUSH: 400,
      ROYAL_FLUSH: 500,
    });
    const expected = [0, 0, 0, 0, 25, 50, 75, 100, 250, 400, 500];
    for (let category = 1; category <= 10; category += 1) {
      expect(getHandRankBonusValue(category)).toBe(expected[category]);
      expect(HAND_RANK_BONUS_BY_CATEGORY[category]).toBe(expected[category]);
    }
    expect(HAND_CATEGORY.ROYAL_FLUSH).toBe(10);
    expect(HAND_CATEGORY.STRAIGHT_FLUSH).toBe(9);
    const royal = pickBestFive(["HA", "HK", "HQ", "HJ", "HT", "C2", "D3"].map(card));
    const sf = pickBestFive(["H9", "H8", "H7", "H6", "H5", "C2", "D3"].map(card));
    expect(royal.category).toBe(10);
    expect(sf.category).toBe(9);
  });

  test.each([
    ["HR01", 1, 0],
    ["HR02", 2, 0],
    ["HR03", 3, 0],
    ["HR04", 4, 25],
    ["HR05", 5, 50],
    ["HR06", 6, 75],
    ["HR07", 7, 100],
    ["HR08", 8, 250],
    ["HR09", 9, 400],
    ["HR10", 10, 500],
  ])("%s category %i bonus %i 进入基础加值", (_id, category, bonus) => {
    const { engine, room, a, b } = setupRoom();
    const total = seedShowdownChips(a, b, { standardNet: 500 });
    const details = settle(engine, room, a, category);
    expect(details.handRankBonusValue).toBe(bonus);
    expect(details.standardPokerNet).toBe(500);
    expect(details.baseTransfer).toBe(500 + bonus);
    expect(details.desiredTransfer).toBe(500 + bonus);
    expect(a.chips + b.chips).toBe(total);
    expect(a.chips).toBeGreaterThanOrEqual(0);
    expect(b.chips).toBeGreaterThanOrEqual(0);
    if (500 + bonus <= 1000) {
      expect(a.chips).toBe(1500 + bonus);
      expect(b.chips).toBe(500 - bonus);
    }
  });
});

describe("Fold / Retreat / Tie 不发牌型奖励", () => {
  test("HR11 普通 Fold bonus = 0", () => {
    const { engine, room, a, b } = setupRoom();
    seedShowdownChips(a, b, { standardNet: 200 });
    const details = settle(engine, room, a, 7, { reason: "fold" });
    expect(details.handRankBonusValue).toBe(0);
    expect(details.handRankBonusApplied).toBe(false);
    expect(details.baseTransfer).toBe(200);
    expect(a.chips).toBe(1200);
    expect(b.chips).toBe(800);
  });

  test("HR12 Retreat Fold bonus = 0", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["RETREAT", "RECYCLE"] });
    a.skillRuntime.retreatTriggered = true;
    const details = settle(engine, room, a, 10, { reason: "retreat" });
    expect(details.handRankBonusValue).toBe(0);
    expect(details.handRankBonusApplied).toBe(false);
  });

  test("HR13 Dead End Fold 仍只走 Fold×3，不查牌型奖励", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["DEAD_END", "RECYCLE"] });
    seedShowdownChips(a, room.players[1], { standardNet: 100 });
    a.skillRuntime.deadEndActive = true;
    const details = settle(engine, room, a, 8, { reason: "fold" });
    expect(details.handRankBonusValue).toBe(0);
    expect(details.effects.some((entry) => entry.skillId === "DEAD_END")).toBe(true);
    expect(details.baseTransfer).toBe(100);
    expect(details.desiredTransfer).toBe(300);
  });

  test("HR14 Showdown Tie 双方 bonus = 0", () => {
    const { engine, room, a, b } = setupRoom();
    a.chips = 1000;
    b.chips = 1000;
    const details = settle(engine, room, a, 7, { tie: true });
    expect(details.handRankBonusValue).toBe(0);
    expect(details.baseTransfer).toBe(0);
    expect(a.chips).toBe(1000);
    expect(b.chips).toBe(1000);
  });
});

describe("倍率、协议、防守、封顶", () => {
  test("HR15 500 + Trips25 无倍率 = 525", () => {
    const { engine, room, a, b } = setupRoom();
    seedShowdownChips(a, b, { standardNet: 500 });
    const details = settle(engine, room, a, 4);
    expect(details.desiredTransfer).toBe(525);
    expect(a.chips).toBe(1525);
    expect(b.chips).toBe(475);
  });

  test("HR16 (500+25)*Blood2 = 1050 且败者有足够筹码", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["BLOOD_BATTLE", "RECYCLE"] });
    a.chips = 1450;
    b.chips = 550;
    a.skillRuntime.handStartChips = 950;
    b.skillRuntime.handStartChips = 1050;
    a.skillRuntime.directChipGainThisHand = 0;
    a.skillRuntime.bloodBattleActive = true;
    const details = settle(engine, room, a, 4);
    expect(details.baseTransfer).toBe(525);
    expect(details.selfSkillMultiplier).toBe(2);
    expect(details.desiredTransfer).toBe(1050);
    expect(details.lossCapApplied).toBe(false);
    expect(a.chips).toBe(2000);
    expect(b.chips).toBe(0);
    expect(a.chips + b.chips).toBe(2000);
  });

  test("HR17 Protocol Trips 合法 x2，牌型奖励不是技能倍率", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["PROTOCOL_TRIPS", "RECYCLE"] });
    a.chips = 1450;
    b.chips = 550;
    a.skillRuntime.handStartChips = 950;
    b.skillRuntime.handStartChips = 1050;
    a.skillRuntime.directChipGainThisHand = 0;
    const details = settle(engine, room, a, 4);
    expect(details.effects.some((entry) => entry.skillId === "PROTOCOL_TRIPS")).toBe(true);
    expect(details.selfSkillMultiplier).toBe(2);
    expect(details.desiredTransfer).toBe(1050);
    expect(a.chips + b.chips).toBe(2000);
  });

  test("HR18 Blood 已触发时 Protocol 不得再乘", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["PROTOCOL_TRIPS", "BLOOD_BATTLE"] });
    a.chips = 1450;
    b.chips = 550;
    a.skillRuntime.handStartChips = 950;
    b.skillRuntime.handStartChips = 1050;
    a.skillRuntime.directChipGainThisHand = 0;
    a.skillRuntime.bloodBattleActive = true;
    const details = settle(engine, room, a, 4);
    expect(details.effects.some((entry) => entry.skillId === "PROTOCOL_TRIPS")).toBe(false);
    expect(details.selfSkillMultiplier).toBe(2);
    expect(details.desiredTransfer).toBe(1050);
  });

  test("Desperation 在牌型奖励之后按现有倍率处理", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["DESPERATION", "RECYCLE"] });
    a.chips = 1300;
    b.chips = 700;
    a.skillRuntime.handStartChips = 1100;
    b.skillRuntime.handStartChips = 900;
    a.skillRuntime.directChipGainThisHand = 0;
    a.skillRuntime.desperationActive = true;
    const details = settle(engine, room, a, 7);
    expect(details.baseTransfer).toBe(300);
    expect(details.selfSkillMultiplier).toBe(3);
    expect(details.desiredTransfer).toBe(900);
    expect(a.chips + b.chips).toBe(2000);
  });

  test("HR19 Defense floor(525/2)=262 且零和", () => {
    const { engine, room, a, b } = setupRoom();
    seedShowdownChips(a, b, { standardNet: 500 });
    b.skillRuntime.defenseActive = true;
    const details = settle(engine, room, a, 4);
    expect(details.lossBeforeDefense).toBe(525);
    expect(details.desiredTransfer).toBe(262);
    expect(a.chips).toBe(1262);
    expect(b.chips).toBe(738);
    expect(a.chips + b.chips).toBe(2000);
  });

  test("HR20 带倍率 Defense floor(1050/2)=525", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["BLOOD_BATTLE", "RECYCLE"] });
    seedShowdownChips(a, b, { standardNet: 500 });
    a.skillRuntime.bloodBattleActive = true;
    b.skillRuntime.defenseActive = true;
    const details = settle(engine, room, a, 4);
    expect(details.lossBeforeDefense).toBe(1050);
    expect(details.desiredTransfer).toBe(525);
    expect(a.chips).toBe(1525);
    expect(b.chips).toBe(475);
  });

  test("HR21 理论 750 只能再承担 200 则 cap", () => {
    const { engine, room, a, b } = setupRoom();
    a.chips = 1800;
    b.chips = 200;
    a.skillRuntime.handStartChips = 1300;
    b.skillRuntime.handStartChips = 700;
    a.skillRuntime.directChipGainThisHand = 0;
    const details = settle(engine, room, a, 8);
    expect(details.baseTransfer).toBe(750);
    expect(details.preCapStandardTransfer).toBe(750);
    expect(details.lossCapApplied).toBe(true);
    expect(b.chips).toBe(0);
    expect(a.chips).toBe(2000);
    expect(a.chips + b.chips).toBe(2000);
  });

  test("HR22 理论值恰好等于可承担值必须完整结算", () => {
    const { engine, room, a, b } = setupRoom();
    a.chips = 1975;
    b.chips = 25;
    a.skillRuntime.handStartChips = 1475;
    b.skillRuntime.handStartChips = 525;
    a.skillRuntime.directChipGainThisHand = 0;
    const details = settle(engine, room, a, 4);
    expect(details.desiredTransfer).toBe(525);
    expect(details.lossCapApplied).toBe(false);
    expect(b.chips).toBe(0);
    expect(a.chips).toBe(2000);
  });

  test("HR23 理论值只比可承担值多 1 必须 cap", () => {
    const { engine, room, a, b } = setupRoom();
    a.chips = 1976;
    b.chips = 24;
    a.skillRuntime.handStartChips = 1476;
    b.skillRuntime.handStartChips = 524;
    a.skillRuntime.directChipGainThisHand = 0;
    const details = settle(engine, room, a, 4);
    expect(details.preCapStandardTransfer).toBe(525);
    expect(details.lossCapApplied).toBe(true);
    expect(b.chips).toBe(0);
    expect(a.chips).toBe(2000);
  });
});

describe("Endgame / Nullification / Loan / Fairness / Protocol P09", () => {
  test("HR24 Endgame 强制 Showdown 仍给牌型奖励", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"] });
    room.skillState.endgameActive = { casterId: a.playerId, execution: true, confiscated: 0 };
    seedShowdownChips(a, b, { standardNet: 200 });
    const details = settle(engine, room, a, 6);
    expect(details.handRankBonusValue).toBe(75);
    expect(details.desiredTransfer).toBe(275);
  });

  test("HR25 Endgame 同类别斩杀按赢家自己的最终牌型给奖励", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"] });
    room.communityCards = ["H2", "H9", "H5", "H7", "C8"].map(card);
    a.cards = ["H3", "D4"].map(card);
    b.cards = ["HA", "DK"].map(card);
    room.phase = "river";
    room.pot = 100;
    a.chips = 950;
    b.chips = 950;
    a.totalBet = 50;
    b.totalBet = 50;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.handStartChips = 1000;
    room.skillState.endgameActive = { casterId: a.playerId, execution: true, confiscated: 0 };
    engine.settleShowdown(room);
    expect(room.lastHandResult.winner).toBe(a.playerId);
    expect(room.lastHandResult.endgameExecutionOverride).toBe(true);
    expect(room.lastHandResult.skillSettlement.winningHandCategory).toBe(6);
    expect(room.lastHandResult.skillSettlement.handRankBonusValue).toBe(75);
  });

  test("HR26 Endgame confiscation 不得进入牌型奖励基数", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["ENDGAME", "DEEP_BREATH"] });
    seedShowdownChips(a, b, { standardNet: 500, directGain: 200 });
    const details = settle(engine, room, a, 4);
    expect(details.standardPokerNet).toBe(500);
    expect(details.directGain).toBe(200);
    expect(details.baseTransfer).toBe(525);
    expect(details.desiredTransfer).toBe(525);
  });

  test("HR27 Nullification 后最终 Trips 奖励 25 不是 100", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["NULLIFICATION", "RECYCLE"] });
    room.communityCards = ["HA", "DA", "CA", "HK", "C3"].map(card);
    a.cards = ["DK", "D2"].map(card);
    b.cards = ["S4", "S5"].map(card);
    room.skillState.nullifications.push({
      type: "board",
      boardIndex: 3,
      casterId: a.playerId,
      cardCode: "HK",
      revealed: true,
    });
    const before = pickBestFive([...a.cards, ...room.communityCards]);
    expect(before.category).toBe(7);
    const after = engine.evaluatePlayerHand(a, room);
    expect(after.category).toBe(4);
    room.phase = "river";
    room.pot = 200;
    a.chips = 900;
    b.chips = 900;
    a.totalBet = 100;
    b.totalBet = 100;
    a.skillRuntime.handStartChips = 1000;
    b.skillRuntime.handStartChips = 1000;
    engine.settleShowdown(room);
    expect(room.lastHandResult.winner).toBe(a.playerId);
    expect(room.lastHandResult.skillSettlement.winningHandCategory).toBe(4);
    expect(room.lastHandResult.skillSettlement.handRankBonusValue).toBe(25);
  });

  test("HR28 Chip Loan +100 不进入 500+25 的基础", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"] });
    seedShowdownChips(a, b, { standardNet: 500, directGain: 100 });
    const details = settle(engine, room, a, 4);
    expect(details.standardPokerNet).toBe(500);
    expect(details.directGain).toBe(100);
    expect(details.baseTransfer).toBe(525);
    expect(details.desiredTransfer).toBe(525);
  });

  test("HR29 Loan repayment 不被牌型奖励或倍率放大", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "BLOOD_BATTLE"] });
    seedShowdownChips(a, b, { standardNet: 200 });
    a.skillRuntime.bloodBattleActive = true;
    const details = settle(engine, room, a, 4);
    expect(details.desiredTransfer).toBe(450);
    expect(details.effects.every((entry) => entry.skillId !== "LOAN")).toBe(true);
  });

  test("HR30 Fairness 成功后 Showdown 牌型奖励仍生效", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["FAIRNESS", "RECYCLE"] });
    room.skillState.fairnessActive = true;
    a.skillRuntime.lockedThisHand = true;
    seedShowdownChips(a, b, { standardNet: 400 });
    const details = settle(engine, room, a, 4);
    expect(details.handRankBonusValue).toBe(25);
    expect(details.desiredTransfer).toBe(425);
  });

  test("HR31 Straight Flush +400 且 P09 可 x2", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["PROTOCOL_STRAIGHT_FLUSH", "RECYCLE"] });
    seedShowdownChips(a, b, { standardNet: 100 });
    const details = settle(engine, room, a, 9);
    expect(details.handRankBonusValue).toBe(400);
    expect(details.effects.some((entry) => entry.skillId === "PROTOCOL_STRAIGHT_FLUSH")).toBe(true);
    expect(details.desiredTransfer).toBe(1000);
  });

  test("HR32 Royal Flush +500 且 P09 可 x2，仍是 category 10", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["PROTOCOL_STRAIGHT_FLUSH", "RECYCLE"] });
    seedShowdownChips(a, b, { standardNet: 100 });
    const details = settle(engine, room, a, 10);
    expect(details.winningHandCategory).toBe(10);
    expect(details.handRankBonusValue).toBe(500);
    expect(details.effects.some((entry) => entry.skillId === "PROTOCOL_STRAIGHT_FLUSH")).toBe(true);
    expect(details.desiredTransfer).toBe(1200);
  });
});

describe("信息泄露与零和 property", () => {
  test("HR33 Fold 不得为了牌型奖励公开隐藏牌", () => {
    const { engine, room, a, b, io } = setupRoom();
    b.status = "folded";
    a.totalBet = 50;
    b.totalBet = 50;
    room.pot = 100;
    engine.settleByFold(room, { foldOrigin: "user" });
    const hidden = engine.handResultForViewer(room, room.lastHandResult, a, { revealAll: false });
    const opp = hidden.players.find((player) => player.playerId === b.playerId);
    expect(opp.cards).toEqual([]);
    expect(opp.bestFive).toEqual([]);
    expect(hidden.skillSettlement.handRankBonusValue).toBe(0);
    expect(io.emits.some((entry) => String(entry.payload?.skillSettlement?.winningHandName || "").includes("皇家"))).toBe(false);
  });

  test("HR34 Showdown 合法公开后可以显示奖励详情", () => {
    const { engine, room, a, b } = setupRoom();
    room.communityCards = ["S2", "D7", "C9", "H2", "SK"].map(card);
    a.cards = ["H2", "C2"].map(card);
    b.cards = ["SA", "DA"].map(card);
    room.phase = "river";
    room.pot = 200;
    a.totalBet = 100;
    b.totalBet = 100;
    a.skillRuntime.handStartChips = a.chips;
    b.skillRuntime.handStartChips = b.chips;
    engine.settleShowdown(room);
    const visible = engine.handResultForViewer(room, room.lastHandResult, a, { revealAll: true });
    expect(visible.reason).toBe("showdown");
    expect(visible.skillSettlement.handRankBonusEligible).toBe(true);
    expect(visible.players.find((player) => player.playerId === a.playerId).cards.length).toBe(2);
  });

  test("10000+ 随机结算保持零和且不出现负筹码", () => {
    const skillEngine = new SkillEngine({ random: () => 0.5 });
    let violations = 0;
    for (let i = 0; i < 12000; i += 1) {
      const startA = 1000;
      const startB = 1000;
      const directGain = i % 7 === 0 ? 100 : 0;
      const standardNet = 25 + (i % 16) * 25;
      const loserLeft = startB - standardNet - directGain;
      if (loserLeft < 0) continue;
      const a = { playerId: "PA", name: "A", chips: startA + standardNet + directGain, status: "active" };
      const b = { playerId: "PB", name: "B", chips: loserLeft, status: "active" };
      initPlayerForSkillMode(a, "abyss");
      initPlayerForSkillMode(b, "abyss");
      setPlayerLoadout(a, i % 5 === 0 ? ["PROTOCOL_TRIPS", "BLOOD_BATTLE"] : ["RECYCLE", "DEEP_BREATH"]);
      setPlayerLoadout(b, ["DEFENSE", "RECYCLE"]);
      a.skillRuntime.handStartChips = startA;
      b.skillRuntime.handStartChips = startB;
      a.skillRuntime.directChipGainThisHand = directGain;
      a.skillRuntime.bloodBattleActive = i % 3 === 0;
      a.skillRuntime.desperationActive = i % 11 === 0;
      b.skillRuntime.defenseActive = i % 4 === 0;
      const room = {
        roomId: "R",
        skillMode: "abyss",
        players: [a, b],
        skillState: { settlement: null },
        handRankBonusEnabled: true,
      };
      const totalBefore = a.chips + b.chips;
      const category = 1 + (i % 10);
      skillEngine.applySettlementModifiers(room, {
        reason: "showdown",
        winner: a,
        winnerCategory: category,
        tie: false,
      });
      if (a.chips + b.chips !== totalBefore) violations += 1;
      if (a.chips < 0 || b.chips < 0) violations += 1;
    }
    expect(violations).toBe(0);
  });
});
