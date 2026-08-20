const { createDeck } = require("../utils/deck");
const { SKILL_MODE } = require("../game/skillModes");
const { SKILL_CONFIG } = require("../game/skillConfig");
const { GameEngine } = require("../game/gameEngine");
const { RoomManager } = require("../game/roomManager");
const { GAME_MODE } = require("../game/gameModes");
const {
  SkillEngine,
  setPlayerLoadout,
  beginHandSkills,
  getDisadvantageSeverity,
} = require("../game/skills/skillEngine");
const { FORTUNE_CONFIG, computeFortuneChance } = require("../game/skills/fortuneConfig");
const { spendEnergy, gainEnergy, canTriggerNewSkillEvent } = require("../game/skills/skillState");
const { decidePublicAction } = require("../game/bots/publicFoldPolicy");
const {
  playHand,
  runMatches,
  makePlayer,
  makeRoom,
  attachTelemetry,
  mulberry32,
} = require("../scripts/validate-fortune-debt");
const logger = require("../utils/logger");
const eventBus = require("../utils/eventBus");

function byCode() {
  return Object.fromEntries(createDeck().map((card) => [card.code, card]));
}

function weakHole() {
  const cards = byCode();
  return [cards.C2, cards.D7];
}

function makeIoStub() {
  return { to: () => ({ emit: () => {} }) };
}

function setupLiveRoom(loadoutA, loadoutB = ["DEEP_BREATH", "RECYCLE"], random = () => 0.99) {
  const roomManager = new RoomManager({ logger, eventBus });
  const engine = new GameEngine({ io: makeIoStub(), roomManager, logger, eventBus, deckFactory: createDeck });
  engine.skillEngine.random = random;
  const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.ABYSS);
  const a = roomManager.joinRoom({ roomId: room.roomId, playerName: "A", playerId: "PA", socketId: "s1" }).player;
  const b = roomManager.joinRoom({ roomId: room.roomId, playerName: "B", playerId: "PB", socketId: "s2" }).player;
  expect(setPlayerLoadout(a, loadoutA).ok).toBe(true);
  expect(setPlayerLoadout(b, loadoutB).ok).toBe(true);
  room.__skillEngineForTests = engine.skillEngine;
  return { engine, room, a, b };
}

describe("强运负债体验与动态筹码", () => {
  test("真实筹码差会改变下一手强运概率", () => {
    const engine = new SkillEngine({ random: () => 0.5 });
    const a = makePlayer("A", "A", ["FORTUNE", "PERCEPTION"]);
    const b = makePlayer("B", "B", ["DEEP_BREATH", "RECYCLE"]);
    const room = makeRoom(a, b);
    a.chips = 1000;
    b.chips = 1000;
    const even = computeFortuneChance("hole", {
      disadvantage: getDisadvantageSeverity(room, a),
      energy: 4,
    });
    a.chips = 400;
    b.chips = 1600;
    const behind = computeFortuneChance("hole", {
      disadvantage: getDisadvantageSeverity(room, a),
      energy: 4,
    });
    expect(getDisadvantageSeverity(room, a)).toBeCloseTo(0.75, 5);
    expect(behind).toBeGreaterThan(even);

    a.chips = 700;
    b.chips = 1300;
    const afterWin = computeFortuneChance("hole", {
      disadvantage: getDisadvantageSeverity(room, a),
      energy: 4,
    });
    expect(afterWin).toBeGreaterThan(even);
    expect(afterWin).toBeLessThan(behind);
    expect(engine).toBeTruthy();
  });

  test("连续比赛中筹码跨手保留，不会被重置回 1000/1000", () => {
    const random = mulberry32(20260820);
    const engine = attachTelemetry(new SkillEngine({ random }));
    const a = makePlayer("A", "A", ["FORTUNE", "DEFENSE"]);
    const b = makePlayer("B", "B", ["DEEP_BREATH", "RECYCLE"]);
    const room = makeRoom(a, b);
    let hands = 0;
    while (hands < 8 && a.chips === 1000 && b.chips === 1000) {
      const incoming = [a.chips, b.chips];
      const result = playHand(engine, room, {
        persistEnergy: true,
        betting: "fold",
        dealerIndex: hands % 2,
        resetChips: false,
      });
      expect(result.resetChips).toBe(false);
      expect(result.chipsAtHandStart).toEqual(incoming);
      hands += 1;
    }
    const after = [a.chips, b.chips];
    expect(a.chips + b.chips).toBe(2000);
    expect(after[0] === 1000 && after[1] === 1000).toBe(false);
    const incoming = [a.chips, b.chips];
    const follow = playHand(engine, room, { persistEnergy: true, betting: "fold", dealerIndex: hands % 2, resetChips: false });
    expect(follow.chipsAtHandStart).toEqual(incoming);
    expect(a.chips + b.chips).toBe(2000);
  });

  test("负能量状态正确封锁第二技能，回到 0 后恢复", () => {
    const { engine, room, a } = setupLiveRoom(["FORTUNE", "DEFENSE"]);
    engine.startHand(room);
    engine.clearActionTimer(room);
    a.skillRuntime.abyssEnergy = -1;
    room.currentPlayerIndex = room.players.indexOf(a);
    const blocked = engine.handleSkillUse(room, a, { skillId: "DEFENSE", target: {}, requestId: "debt-def" });
    expect(blocked.ok).toBe(false);
    expect(canTriggerNewSkillEvent(a, "DEFENSE", room)).toBe(false);

    a.skillRuntime.abyssEnergy = 3;
    const restored = engine.handleSkillUse(room, a, { skillId: "DEFENSE", target: {}, requestId: "ok-def" });
    expect(restored.ok).toBe(true);
    expect(a.skillRuntime.defenseActive).toBe(true);
  });

  test("强运+感知：负债节点跳过感知；回正后可再触发", () => {
    const { engine, room, a } = setupLiveRoom(["FORTUNE", "PERCEPTION"], ["DEEP_BREATH", "RECYCLE"], () => 0);
    engine.startHand(room);
    engine.clearActionTimer(room);
    a.skillRuntime.abyssEnergy = -2;
    a.skillRuntime.perceptionCheckedNodes = [];
    a.skillRuntime.perceptionTriggerCount = 0;
    engine.skillEngine.onCardsDealt(room, "flop");
    expect(a.skillRuntime.perceptionTriggerCount).toBe(0);
    expect(a.skillRuntime.perceptionCheckedNodes).toEqual([]);

    a.skillRuntime.abyssEnergy = 4;
    engine.skillEngine.onCardsDealt(room, "turn");
    expect(a.skillRuntime.perceptionTriggerCount).toBeGreaterThan(0);
  });

  test("强运+绝密：负债时不触发绝密；回正后可保护", () => {
    const debt = setupLiveRoom(["FORTUNE", "TOP_SECRET"], ["INTEL_ONE", "RECYCLE"], () => 0);
    debt.engine.startHand(debt.room);
    debt.engine.clearActionTimer(debt.room);
    debt.room.currentPlayerIndex = debt.room.players.indexOf(debt.b);
    debt.a.skillRuntime.abyssEnergy = -1;
    debt.b.skillRuntime.abyssEnergy = 8;
    const leaked = debt.engine.handleSkillUse(debt.room, debt.b, {
      skillId: "INTEL_ONE",
      target: { zone: "opponent" },
      requestId: "intel-debt",
    });
    expect(leaked.ok).toBe(true);
    expect(debt.a.skillRuntime.topSecretActive).toBe(false);

    const ok = setupLiveRoom(["FORTUNE", "TOP_SECRET"], ["INTEL_ONE", "RECYCLE"], () => 0);
    ok.engine.startHand(ok.room);
    ok.engine.clearActionTimer(ok.room);
    ok.room.currentPlayerIndex = ok.room.players.indexOf(ok.b);
    ok.a.skillRuntime.abyssEnergy = 4;
    ok.b.skillRuntime.abyssEnergy = 8;
    ok.engine.handleSkillUse(ok.room, ok.b, {
      skillId: "INTEL_ONE",
      target: { zone: "opponent" },
      requestId: "intel-ok",
    });
    expect(ok.a.skillRuntime.topSecretActive).toBe(true);
  });

  test("强运+防守：负债时不可发动防守", () => {
    const { engine, room, a } = setupLiveRoom(["FORTUNE", "DEFENSE"]);
    engine.startHand(room);
    engine.clearActionTimer(room);
    room.currentPlayerIndex = room.players.indexOf(a);
    a.skillRuntime.abyssEnergy = -3;
    const result = engine.skillEngine.validateUse(room, a, "DEFENSE", {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/负能量/);
  });

  test("强运自身在负债状态仍按自己的规则运行，且能量不能低于 -4", () => {
    const live = setupLiveRoom(["FORTUNE", "RECYCLE"], ["DEEP_BREATH", "RECYCLE"], () => 0);
    beginHandSkills(live.room);
    live.a.cards = weakHole();
    live.b.cards = [byCode().S3, byCode().H8];
    live.room.deck = createDeck().filter((card) => !["C2", "D7", "S3", "H8"].includes(card.code));
    live.a.skillRuntime.abyssEnergy = -1;
    const triggered = live.engine.skillEngine.applyHoleFortune(live.room);
    expect(triggered).toHaveLength(1);
    expect(live.a.skillRuntime.abyssEnergy).toBe(-4);

    const blocked = setupLiveRoom(["FORTUNE", "RECYCLE"], ["DEEP_BREATH", "RECYCLE"], () => 0);
    beginHandSkills(blocked.room);
    blocked.a.cards = weakHole();
    blocked.b.cards = [byCode().S3, byCode().H8];
    blocked.room.deck = createDeck().filter((card) => !["C2", "D7", "S3", "H8"].includes(card.code));
    blocked.a.skillRuntime.abyssEnergy = -2;
    expect(blocked.engine.skillEngine.applyHoleFortune(blocked.room)).toHaveLength(0);
    expect(blocked.a.skillRuntime.abyssEnergy).toBe(-2);
    expect(spendEnergy(blocked.a, 3, { allowDebt: true, minimum: FORTUNE_CONFIG.minEnergy })).toBe(false);
    expect(blocked.a.skillRuntime.abyssEnergy).toBe(-2);
  });

  test("资源型强运可以帮助偿还负债", () => {
    const { engine, room, a } = setupLiveRoom(["FORTUNE", "RECYCLE"], ["DEEP_BREATH", "RECYCLE"], () => 0);
    beginHandSkills(room);
    a.skillRuntime.abyssEnergy = -3;
    a.skillRuntime.fortuneResourceUsed = false;
    const hit = engine.skillEngine.applyResourceFortune(room, a);
    expect(hit).toBe(true);
    expect(a.skillRuntime.abyssEnergy).toBe(-2);
    gainEnergy(a, SKILL_CONFIG.ENERGY_LOSER_GAIN);
    expect(a.skillRuntime.abyssEnergy).toBe(-1);
  });

  test("Fold Bot 不能访问隐藏信息", () => {
    const hidden = new Proxy({}, {
      get() {
        throw new Error("hidden-info");
      },
    });
    const decision = decidePublicAction({
      heroCards: [byCode().C2, byCode().D7],
      board: [],
      toCall: 25,
      pot: 75,
      heroChips: 975,
      street: "pre_flop",
      canRaise: true,
      streetBet: 25,
      currentBet: 50,
      opponentCards: hidden,
      deck: hidden,
      opponentRuntime: hidden,
      trueEquity: hidden,
    });
    expect(decision.action).toBe("fold");
  });

  test("双方相同构筑时 Bot 不存在明显座位偏差", () => {
    const stats = runMatches(20260820, {
      matches: 80,
      loadoutA: ["DEEP_BREATH", "RECYCLE"],
      loadoutB: ["DEEP_BREATH", "RECYCLE"],
      betting: "fold",
      maxHands: 80,
    });
    const rate = stats.aWins / stats.matches;
    expect(rate).toBeGreaterThan(0.32);
    expect(rate).toBeLessThan(0.68);
    expect(stats.folds / Math.max(1, stats.hands)).toBeGreaterThan(0.08);
  }, 45000);
});
