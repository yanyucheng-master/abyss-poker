const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const { SKILL_CONFIG } = require("../game/skillConfig");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { getValidActions, collectBet } = require("../game/pokerLogic");
const { createDeck } = require("../utils/deck");
const {
  SkillEngine,
  FORTUNE_COMBOS,
  getFutureCommunitySlots,
  validateLoadout,
  setPlayerLoadout,
  beginHandSkills,
  endHandSkills,
  getPublicSkillSummary,
  getSelfSkillSummary,
  getPublicRoomSkillSnapshot,
} = require("../game/skills/skillEngine");
const { listSkillDefinitions } = require("../game/skills/definitions");
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
  deckFactory = createDeck,
  start = true,
} = {}) {
  const io = makeIoStub();
  const roomManager = new RoomManager({ logger, eventBus });
  const engine = new GameEngine({ io, roomManager, logger, eventBus, deckFactory });
  engine.skillEngine.random = random;
  const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.ABYSS);
  const a = roomManager.joinRoom({ roomId: room.roomId, playerName: "A", playerId: "PA", socketId: "s1" }).player;
  const b = roomManager.joinRoom({ roomId: room.roomId, playerName: "B", playerId: "PB", socketId: "s2" }).player;
  expect(setPlayerLoadout(a, loadoutA).ok).toBe(true);
  expect(setPlayerLoadout(b, loadoutB).ok).toBe(true);
  if (start) {
    engine.startHand(room);
    engine.clearActionTimer(room);
  }
  return { io, roomManager, engine, room, a, b };
}

function use(engine, room, player, skillId, target = {}, requestId = `${skillId}-${Math.random()}`) {
  return engine.handleSkillUse(room, player, { skillId, target, requestId });
}

function byCode() {
  return Object.fromEntries(createDeck().map((card) => [card.code, card]));
}

describe("V2 技能目录与隐私边界", () => {
  test("目录完整替换为 17 个新技能", () => {
    const catalog = listSkillDefinitions();
    expect(catalog).toHaveLength(17);
    expect(catalog.map((skill) => skill.id)).toEqual([
      "DEEP_BREATH", "RECYCLE", "INTIMIDATION", "DESPERATION", "BLOOD_BATTLE",
      "DEFENSE", "PERCEPTION", "INTEL_ONE", "TOP_SECRET", "COUNTER", "FAIRNESS",
      "CHEAT", "DEAD_END", "CLAIRVOYANCE", "NULLIFICATION", "FORTUNE", "DESTINY",
    ]);
    expect(catalog.find((skill) => skill.id === "DESTINY")).toMatchObject({
      load: 7, energyCost: 8, maxUsesPerHand: null, maxUsesPerGame: null,
    });
    expect(catalog.some((skill) => skill.id === "NEURAL_INTERRUPT")).toBe(false);
  });

  test("构筑严格执行 2–4 个、负载不超过 8、不可重复", () => {
    expect(validateLoadout(["DESTINY", "RECYCLE"])).toMatchObject({ ok: true, totalLoad: 8 });
    expect(validateLoadout(["FORTUNE", "RECYCLE"])).toMatchObject({ ok: true, totalLoad: 7 });
    expect(validateLoadout(["DESTINY"])).toMatchObject({ ok: false });
    expect(validateLoadout(["DESTINY", "DEEP_BREATH"])).toMatchObject({ ok: true });
    expect(validateLoadout(["FORTUNE", "DESPERATION"])).toMatchObject({ ok: true, totalLoad: 8 });
    expect(validateLoadout(["DESTINY", "DESPERATION"])).toMatchObject({ ok: false });
    expect(validateLoadout(["RECYCLE", "RECYCLE"])).toMatchObject({ ok: false });
    expect(validateLoadout(["RECYCLE", "OLD_SKILL"])).toMatchObject({ ok: false });
  });

  test("公开快照隐藏构筑与实时能量，自己的快照保持完整", () => {
    const { a } = setupRoom({ start: false });
    a.skillRuntime.abyssEnergy = 1;
    a.skillRuntime.visibleAbyssEnergy = 4;
    const publicSummary = getPublicSkillSummary(a);
    const selfSummary = getSelfSkillSummary(a);
    expect(publicSummary).toMatchObject({ abyssEnergy: 4, buildHidden: true });
    expect(publicSummary).not.toHaveProperty("equippedSkillIds");
    expect(publicSummary).not.toHaveProperty("skillUsesThisHand");
    expect(selfSummary.abyssEnergy).toBe(1);
    expect(selfSummary.equippedSkillIds).toEqual(a.skillRuntime.equippedSkillIds);
  });

  test("无技能房间不会创建技能运行时", () => {
    const io = makeIoStub();
    const roomManager = new RoomManager({ logger, eventBus });
    const engine = new GameEngine({ io, roomManager, logger, eventBus });
    const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.OFF);
    const a = roomManager.joinRoom({ roomId: room.roomId, playerId: "A", socketId: "s1" }).player;
    roomManager.joinRoom({ roomId: room.roomId, playerId: "B", socketId: "s2" });
    engine.tryStartGame(room);
    engine.clearActionTimer(room);
    expect(room.phase).toBe("pre_flop");
    expect(a.skillRuntime).toBeNull();
  });
});

describe("能量、封锁与主动技能时机", () => {
  test("初始能量 4、上限 8；摊牌败者获得基础 1 + 败者 1", () => {
    const { room, a, b } = setupRoom();
    expect(a.skillRuntime.abyssEnergy).toBe(4);
    a.skillRuntime.abyssEnergy = 8;
    b.skillRuntime.abyssEnergy = 5;
    endHandSkills(room, { reason: "showdown", winner: a, tie: false });
    expect(a.skillRuntime.abyssEnergy).toBe(8);
    expect(b.skillRuntime.abyssEnergy).toBe(7);
    expect(b.skillRuntime.visibleAbyssEnergy).toBe(7);
  });

  test("深呼吸成功蓄力；之后发生本人技能事件会打断恢复", () => {
    const first = setupRoom({ loadoutA: ["DEEP_BREATH", "BLOOD_BATTLE"] });
    expect(use(first.engine, first.room, first.a, "DEEP_BREATH", {}, "breath-only").ok).toBe(true);
    expect(first.a.skillRuntime.abyssEnergy).toBe(3);
    endHandSkills(first.room, { reason: "fold", winner: first.a, tie: false });
    expect(first.a.skillRuntime.abyssEnergy).toBe(6); // 3 + base 1 + breath 2

    const second = setupRoom({ loadoutA: ["DEEP_BREATH", "BLOOD_BATTLE"] });
    use(second.engine, second.room, second.a, "DEEP_BREATH", {}, "breath-broken");
    use(second.engine, second.room, second.a, "BLOOD_BATTLE", {}, "blood-after-breath");
    expect(second.a.skillRuntime.breathBroken).toBe(true);
    endHandSkills(second.room, { reason: "fold", winner: second.a, tie: false });
    expect(second.a.skillRuntime.abyssEnergy).toBe(1); // 4 - 1 - 3 + base 1
  });

  test("深呼吸在能量高于 4 时不可用", () => {
    const { engine, room, a } = setupRoom();
    a.skillRuntime.abyssEnergy = 5;
    expect(use(engine, room, a, "DEEP_BREATH")).toMatchObject({ ok: false });
  });

  test("反制是预埋陷阱：目标支付费用、回收 1、随后整手封锁", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["BLOOD_BATTLE", "RECYCLE"],
      loadoutB: ["COUNTER", "DEEP_BREATH"],
    });
    b.skillRuntime.counterArmed = true;
    const result = use(engine, room, a, "BLOOD_BATTLE", {}, "countered-blood");
    expect(result).toMatchObject({ ok: true, status: "COUNTERED" });
    expect(a.skillRuntime.abyssEnergy).toBe(2); // 4 - 3 + recycle 1
    expect(a.skillRuntime.lockedThisHand).toBe(true);
    expect(b.skillRuntime.counterArmed).toBe(false);
    expect(a.skillRuntime.bloodBattleActive).toBe(false);
  });

  test("反制可以截断对方正在布置的反制", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["COUNTER", "DEEP_BREATH"],
      loadoutB: ["COUNTER", "DEEP_BREATH"],
    });
    a.skillRuntime.abyssEnergy = 8;
    b.skillRuntime.counterArmed = true;
    expect(use(engine, room, a, "COUNTER", {}, "counter-v-counter")).toMatchObject({ status: "COUNTERED" });
    expect(a.skillRuntime.counterArmed).toBe(false);
    expect(a.skillRuntime.abyssEnergy).toBe(2);
  });

  test("非法精确目标不扣能量、不触发回收，也不会消耗对手的反制陷阱", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["INTEL_ONE", "RECYCLE"],
      loadoutB: ["COUNTER", "DEEP_BREATH"],
    });
    b.skillRuntime.counterArmed = true;
    const result = use(
      engine,
      room,
      a,
      "INTEL_ONE",
      { zone: "future", boardIndex: null },
      "invalid-target-before-counter",
    );
    expect(result).toMatchObject({ ok: false });
    expect(a.skillRuntime.abyssEnergy).toBe(4);
    expect(a.skillRuntime.recycleUsedThisHand).toBe(false);
    expect(a.skillRuntime.skillUsesThisHand.INTEL_ONE).toBeUndefined();
    expect(b.skillRuntime.counterArmed).toBe(true);
  });

  test("公平严格要求本人下注回合且必须是第一个技能事件，并封锁手末能量", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["FAIRNESS", "DEEP_BREATH"] });
    room.currentPlayerIndex = 1;
    expect(use(engine, room, a, "FAIRNESS", {}, "fair-wrong-turn")).toMatchObject({ ok: false });
    room.currentPlayerIndex = 0;
    expect(use(engine, room, a, "FAIRNESS", {}, "fair-first")).toMatchObject({ ok: true });
    expect(room.skillState.fairnessActive).toBe(true);
    expect(room.players.every((player) => player.skillRuntime.lockedThisHand)).toBe(true);
    expect(a.skillRuntime.abyssEnergy).toBe(0);
    endHandSkills(room, { reason: "showdown", winner: a, tie: false });
    expect(a.skillRuntime.abyssEnergy).toBe(0);

    const later = setupRoom({ loadoutA: ["FAIRNESS", "DEEP_BREATH"] });
    use(later.engine, later.room, later.a, "DEEP_BREATH", {}, "first-other-skill");
    later.a.skillRuntime.abyssEnergy = 8;
    expect(use(later.engine, later.room, later.a, "FAIRNESS", {}, "fair-too-late")).toMatchObject({ ok: false });
  });

  test("重复请求只结算一次", () => {
    const { engine, room, a } = setupRoom();
    const first = use(engine, room, a, "DEEP_BREATH", {}, "same-request");
    const energy = a.skillRuntime.abyssEnergy;
    const duplicate = use(engine, room, a, "DEEP_BREATH", {}, "same-request");
    expect(first.ok).toBe(true);
    expect(duplicate).toMatchObject({ ok: true, duplicate: true });
    expect(a.skillRuntime.abyssEnergy).toBe(energy);
  });

  test("单机对手会在自己的下注回合实际使用默认主动技能", () => {
    const strong = setupRoom({
      loadoutB: ["DEEP_BREATH", "BLOOD_BATTLE", "DEFENSE", "DESPERATION"],
    });
    strong.b.isBot = true;
    strong.room.currentPlayerIndex = 1;
    const cards = byCode();
    strong.b.cards = [cards.SA, cards.HA];
    expect(strong.engine.skillEngine.tryBotTurnSkill(strong.room, strong.b)).toMatchObject({
      ok: true,
      skillId: "BLOOD_BATTLE",
    });
    expect(strong.b.skillRuntime.bloodBattleActive).toBe(true);

    const guarded = setupRoom({
      loadoutB: ["DEEP_BREATH", "BLOOD_BATTLE", "DEFENSE", "DESPERATION"],
    });
    guarded.b.isBot = true;
    guarded.room.currentPlayerIndex = 1;
    guarded.b.cards = [cards.S2, cards.H7];
    expect(guarded.engine.skillEngine.tryBotTurnSkill(guarded.room, guarded.b)).toMatchObject({
      ok: true,
      skillId: "DEFENSE",
    });
    expect(guarded.b.skillRuntime.defenseActive).toBe(true);

    const recovering = setupRoom({
      loadoutB: ["DEEP_BREATH", "BLOOD_BATTLE", "DEFENSE", "DESPERATION"],
    });
    recovering.b.isBot = true;
    recovering.room.currentPlayerIndex = 1;
    recovering.b.cards = [cards.S2, cards.H7];
    recovering.b.skillRuntime.abyssEnergy = 2;
    expect(recovering.engine.skillEngine.tryBotTurnSkill(recovering.room, recovering.b)).toMatchObject({
      ok: true,
      skillId: "DEEP_BREATH",
    });
    expect(recovering.b.skillRuntime.breathArmed).toBe(true);
  });
});

describe("控制、下注与零和结算", () => {
  test("技能房间未发动恐吓时不会把空上限误当成 0", () => {
    const { room, a, b } = setupRoom();
    expect(room.skillState.contributionCap).toBeNull();
    expect(room.pot).toBe(75);
    expect([a.totalBet, b.totalBet]).toEqual([25, 50]);
    expect(getValidActions(room, 0).validActions).toEqual(expect.arrayContaining(["fold", "call", "allin"]));
  });

  test("恐吓移除弃牌并把每人累计投入硬封顶为 500", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["INTIMIDATION", "DEEP_BREATH"] });
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "INTIMIDATION", {}, "fear").ok).toBe(true);
    expect(getValidActions(room, room.currentPlayerIndex).validActions).not.toContain("fold");
    a.totalBet = 490;
    a.streetBet = 0;
    a.chips = 1000;
    b.totalBet = 490;
    b.streetBet = 0;
    b.chips = 1000;
    room.currentBet = 0;
    expect(getValidActions(room, 0).maxTotalBet).toBe(0); // remaining 10 is below legal minimum raise
    expect(getValidActions(room, 0).validActions).not.toContain("allin");
    expect(collectBet(room, a, 100)).toBe(10);
    expect(a.totalBet).toBe(500);
  });

  test("防守必须在首次面对主动加注前发动", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["DEFENSE", "DEEP_BREATH"] });
    engine.skillEngine.onAggressiveAction(room, b);
    expect(a.skillRuntime.facedAggressionThisPhase).toBe(true);
    expect(use(engine, room, a, "DEFENSE", {}, "late-defense")).toMatchObject({ ok: false });
  });

  test("双方血战严格相乘为 4 倍并保持零和", () => {
    const { engine, room, a, b } = setupRoom();
    a.chips = 1100;
    b.chips = 900;
    a.skillRuntime.bloodBattleActive = true;
    b.skillRuntime.bloodBattleActive = true;
    const total = a.chips + b.chips;
    const result = engine.skillEngine.applySettlementModifiers(room, { reason: "showdown", winner: a });
    expect(result).toMatchObject({ baseTransfer: 100, finalTransfer: 400, multiplier: 4 });
    expect([a.chips, b.chips]).toEqual([1400, 600]);
    expect(a.chips + b.chips).toBe(total);
  });

  test("防守与单层血战相抵；已弃牌时防守不生效", () => {
    const { engine, room, a, b } = setupRoom();
    a.chips = 1100;
    b.chips = 900;
    a.skillRuntime.bloodBattleActive = true;
    b.skillRuntime.defenseActive = true;
    expect(engine.skillEngine.applySettlementModifiers(room, { reason: "showdown", winner: a }).multiplier).toBe(1);

    a.chips = 1100;
    b.chips = 900;
    b.skillRuntime.foldedThisHand = true;
    expect(engine.skillEngine.applySettlementModifiers(room, { reason: "fold", winner: a }).multiplier).toBe(2);
  });

  test("绝境、双血战与绝路可以叠加，但败者筹码永不为负", () => {
    const { engine, room, a, b } = setupRoom();
    a.chips = 1100;
    b.chips = 900;
    a.skillRuntime.desperationActive = true;
    a.skillRuntime.deadEndActive = true;
    a.skillRuntime.bloodBattleActive = true;
    b.skillRuntime.bloodBattleActive = true;
    b.skillRuntime.foldedThisHand = true;
    const result = engine.skillEngine.applySettlementModifiers(room, { reason: "fold", winner: a });
    expect(result.multiplier).toBe(18);
    expect([a.chips, b.chips]).toEqual([2000, 0]);
  });

  test("绝路只在实际 All In 且能量足够时自动发动，并锁住对手", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["DEAD_END", "DESPERATION"] });
    a.skillRuntime.abyssEnergy = 5;
    a.isAllIn = true;
    expect(engine.skillEngine.onPlayerAllIn(room, a)).toBe(true);
    expect(a.skillRuntime.abyssEnergy).toBe(0);
    expect(a.skillRuntime.deadEndActive).toBe(true);
    expect(b.skillRuntime.lockedThisHand).toBe(true);
    expect(engine.skillEngine.onPlayerAllIn(room, a)).toBe(false);
  });
});

describe("信息、改牌与公共牌零化", () => {
  test("感知在四个节点独立判定，私有文本不带真假标签", () => {
    const sequence = [0, 0, 0];
    const { a, room } = setupRoom({
      loadoutA: ["PERCEPTION", "RECYCLE"],
      random: () => sequence.shift() ?? 0.99,
    });
    expect(a.skillRuntime.perceptionTriggerCount).toBe(1);
    expect(a.skillRuntime.privateResults).toHaveLength(1);
    expect(a.skillRuntime.privateResults[0].message).toMatch(/^感知 · /);
    expect(a.skillRuntime.privateResults[0].message).not.toMatch(/真实|虚假|75%/);
    expect(room.skillState.skillActionLog.find((entry) => entry.skillId === "PERCEPTION").secret).toBe(true);
  });

  test("情报壹可精确指定未来公共牌；绝密会使底牌目标付费失败并触发回收", () => {
    const first = setupRoom({
      loadoutA: ["INTEL_ONE", "RECYCLE"],
      loadoutB: ["TOP_SECRET", "DEEP_BREATH"],
    });
    first.a.skillRuntime.abyssEnergy = 8;
    const future = getFutureCommunitySlots(first.room).find((slot) => slot.boardIndex === 4);
    expect(use(first.engine, first.room, first.a, "INTEL_ONE", { zone: "future", boardIndex: 4 }, "intel-future")).toMatchObject({ status: "SUCCESS" });
    expect(first.a.skillRuntime.privateResults.at(-1).message).toContain(future.card.code);

    const blocked = setupRoom({
      loadoutA: ["INTEL_ONE", "RECYCLE"],
      loadoutB: ["TOP_SECRET", "DEEP_BREATH"],
    });
    blocked.a.skillRuntime.abyssEnergy = 8;
    blocked.b.skillRuntime.topSecretActive = true;
    expect(use(blocked.engine, blocked.room, blocked.a, "INTEL_ONE", { zone: "opponent" }, "intel-blocked")).toMatchObject({ status: "FAILED" });
    expect(blocked.a.skillRuntime.abyssEnergy).toBe(6); // 8 - 3 + recycle 1
  });

  test("千术交换明牌时同步牌面且守恒；河牌全部公布后禁止", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["CHEAT", "RECYCLE"] });
    engine.finishStreetDeal(room, "flop");
    engine.clearActionTimer(room);
    room.currentPlayerIndex = 0;
    a.skillRuntime.abyssEnergy = 8;
    const own = a.cards[0];
    const board = room.communityCards[1];
    const beforeCodes = [...a.cards, ...room.communityCards, ...room.deck, ...room.skillState.burnedCards].map((card) => card.code).sort();
    expect(use(engine, room, a, "CHEAT", { ownIndex: 0, zone: "community", index: 1 }, "cheat-board")).toMatchObject({ status: "SUCCESS" });
    expect(a.cards[0].code).toBe(board.code);
    expect(room.communityCards[1].code).toBe(own.code);
    const afterCodes = [...a.cards, ...room.communityCards, ...room.deck, ...room.skillState.burnedCards].map((card) => card.code).sort();
    expect(afterCodes).toEqual(beforeCodes);

    room.phase = "river";
    room.communityCards = createDeck().slice(0, 5);
    a.skillRuntime.skillUsesThisHand.CHEAT = 0;
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "CHEAT", { ownIndex: 0, zone: "community", index: 0 }, "cheat-after-river")).toMatchObject({ ok: false });
  });

  test("绝密阻断对手底牌千术，付费失败可由回收返 1", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["CHEAT", "RECYCLE"],
      loadoutB: ["TOP_SECRET", "DEEP_BREATH"],
    });
    a.skillRuntime.abyssEnergy = 8;
    b.skillRuntime.topSecretActive = true;
    expect(use(engine, room, a, "CHEAT", { ownIndex: 0, zone: "opponent", index: 0 }, "cheat-secret")).toMatchObject({ status: "FAILED" });
    expect(a.skillRuntime.abyssEnergy).toBe(3); // 8 - 6 + recycle 1
  });

  test("零化可指定未来位置且不会提前泄露牌值；亮出后进入公开快照", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["NULLIFICATION", "RECYCLE"] });
    engine.finishStreetDeal(room, "flop");
    engine.clearActionTimer(room);
    room.currentPlayerIndex = 0;
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "NULLIFICATION", { boardIndex: 4 }, "null-future")).toMatchObject({ status: "SUCCESS" });
    expect(getPublicRoomSkillSnapshot(room).nullifiedCommunityCardIds).toEqual([]);
    engine.finishStreetDeal(room, "turn");
    engine.finishStreetDeal(room, "river");
    engine.clearActionTimer(room);
    expect(getPublicRoomSkillSnapshot(room).nullifiedCommunityCardIds).toContain(room.communityCards[4].code);
  });

  test("五张公共牌公布后零化仍可发动，并确实影响牌型计算", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["NULLIFICATION", "RECYCLE"] });
    const cards = byCode();
    a.cards = [cards.SA, cards.SK];
    room.communityCards = [cards.SQ, cards.SJ, cards.ST, cards.C2, cards.C4];
    room.phase = "river";
    room.currentPlayerIndex = 0;
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "NULLIFICATION", { boardIndex: 2 }, "null-river")).toMatchObject({ status: "SUCCESS" });
    expect(engine.evaluatePlayerHand(a, room).handName).not.toMatch(/同花顺|皇家同花顺/);
  });

  test("灵视读取真实能量和本手已结算的秘密事件", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["CLAIRVOYANCE", "RECYCLE"],
      loadoutB: ["TOP_SECRET", "DEEP_BREATH"],
    });
    b.skillRuntime.abyssEnergy = 7;
    room.skillState.skillActionLog.push({ at: Date.now(), skillId: "TOP_SECRET", casterId: b.playerId, status: "SUCCESS", secret: true });
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "CLAIRVOYANCE", {}, "clair")).toMatchObject({ status: "SUCCESS" });
    const result = a.skillRuntime.privateResults.at(-1);
    expect(result.opponentEnergy).toBe(7);
    expect(result.events).toEqual(expect.arrayContaining([expect.objectContaining({ skillId: "TOP_SECRET" })]));
  });
});

describe("天命、强运与可审计牌堆", () => {
  test("天命精确把指定牌换到未来河牌，手内与整场均无次数冷却", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["DESTINY", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 8;
    expect(room.deck.some((card) => card.code === "S2")).toBe(true);
    expect(use(engine, room, a, "DESTINY", { cardCode: "S2" }, "destiny-s2")).toMatchObject({ status: "SUCCESS" });
    expect(getFutureCommunitySlots(room).find((slot) => slot.boardIndex === 4).card.code).toBe("S2");
    const secondTarget = room.deck.find((card) => card.code !== "S2").code;
    a.skillRuntime.abyssEnergy = 8; // 验证规则层没有次数冷却；正式牌局仍受能量上限约束。
    expect(use(engine, room, a, "DESTINY", { cardCode: secondTarget }, "destiny-second")).toMatchObject({ status: "SUCCESS" });
    expect(getFutureCommunitySlots(room).find((slot) => slot.boardIndex === 4).card.code).toBe(secondTarget);
  });

  test("天命精确指中对手底牌时支付 8 后失败，回收返 1", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["DESTINY", "RECYCLE"] });
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "DESTINY", { cardCode: b.cards[0].code }, "destiny-opponent")).toMatchObject({ status: "FAILED" });
    expect(a.skillRuntime.abyssEnergy).toBe(1);
  });

  test("强运池严格为 78 个口袋对子 + 48 个同花连张", () => {
    expect(FORTUNE_COMBOS).toHaveLength(126);
    expect(FORTUNE_COMBOS.filter((combo) => combo.type === "POCKET_PAIR")).toHaveLength(78);
    expect(FORTUNE_COMBOS.filter((combo) => combo.type === "SUITED_CONNECTOR")).toHaveLength(48);
    expect(new Set(FORTUNE_COMBOS.map((combo) => combo.codes.slice().sort().join("-"))).size).toBe(126);
  });

  test("强运允许能量降至 -4，但低于可支付边界时不再触发", () => {
    const sequence = [0, 0];
    const prepared = setupRoom({
      loadoutA: ["FORTUNE", "RECYCLE"],
      start: false,
      random: () => sequence.shift() ?? 0,
    });
    beginHandSkills(prepared.room);
    prepared.room.deck = createDeck();
    prepared.a.skillRuntime.abyssEnergy = 0;
    const triggered = prepared.engine.skillEngine.prepareDeckForHand(prepared.room);
    expect(triggered).toHaveLength(1);
    expect(prepared.a.skillRuntime.abyssEnergy).toBe(-4);
    const dealtCodes = [prepared.room.deck.at(-1).code, prepared.room.deck.at(-3).code];
    expect(FORTUNE_COMBOS.some((combo) => combo.codes.every((code) => dealtCodes.includes(code)))).toBe(true);

    const blocked = setupRoom({ loadoutA: ["FORTUNE", "RECYCLE"], start: false, random: () => 0 });
    beginHandSkills(blocked.room);
    blocked.room.deck = createDeck();
    blocked.a.skillRuntime.abyssEnergy = -1;
    expect(blocked.engine.skillEngine.prepareDeckForHand(blocked.room)).toHaveLength(0);
    expect(blocked.a.skillRuntime.abyssEnergy).toBe(-1);
  });

  test("强运在原始牌堆承诺之后留下明确变换，最终牌区仍保持 52 张守恒", () => {
    const { engine, room } = setupRoom({
      loadoutA: ["FORTUNE", "RECYCLE"],
      random: () => 0,
      deckFactory: createDeck,
    });
    const committedCodes = room.handReveal.deck.map((card) => card.code);
    expect(room.skillState.transformations.some((entry) => entry.skillId === "FORTUNE")).toBe(true);
    expect(room.deck.map((card) => card.code)).not.toEqual(committedCodes.slice(0, room.deck.length));
    const reveal = engine.completeHandReveal(room);
    const finalCodes = [
      ...reveal.finalZones.communityCards,
      ...reveal.finalZones.playerCards.flatMap((entry) => entry.cards),
      ...reveal.finalZones.remainingDeck,
      ...reveal.burnedCards,
      ...reveal.removedCards,
    ].map((card) => card.code);
    expect(finalCodes).toHaveLength(52);
    expect(new Set(finalCodes).size).toBe(52);
  });
});
