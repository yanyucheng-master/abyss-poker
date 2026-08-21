const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const { SKILL_CONFIG, PERCEPTION_CONFIG, FORTUNE_RULE, SKILL_RULE_FREEZE } = require("../game/skillConfig");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { getValidActions, collectBet } = require("../game/pokerLogic");
const { createDeck } = require("../utils/deck");
const {
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
const { FORTUNE_CONFIG, computeFortuneChance } = require("../game/skills/fortuneConfig");
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

function byCode() {
  return Object.fromEntries(createDeck().map((card) => [card.code, card]));
}

function playerCardLabel(card) {
  const suitSymbols = { S: "♠", H: "♥", C: "♣", D: "♦" };
  const rank = card.rank === "T" ? "10" : card.rank;
  return `${rank}${suitSymbols[card.suit]}`;
}

function goToStreet(engine, room, street, actorIndex = 0) {
  const order = ["pre_flop", "flop", "turn", "river"];
  const target = order.indexOf(street);
  while (order.indexOf(room.phase) < target) {
    const next = order[order.indexOf(room.phase) + 1];
    engine.finishStreetDeal(room, next);
    engine.clearActionTimer(room);
  }
  room.currentPlayerIndex = actorIndex;
}

function weakHole() {
  const cards = byCode();
  return [cards.C2, cards.D7];
}

describe("技能目录、构筑与隐私", () => {
  test("目录包含 24 个主体技能与 9 个协议，并提供新手/专家说明", () => {
    const catalog = listSkillDefinitions();
    expect(catalog).toHaveLength(33);
    expect(catalog.map((skill) => skill.id).slice(0, 24)).toEqual([
      "DEEP_BREATH", "RECYCLE", "INTIMIDATION", "DESPERATION", "BLOOD_BATTLE",
      "DEFENSE", "PERCEPTION", "INTEL_ONE", "TOP_SECRET", "COUNTER", "FAIRNESS",
      "CHEAT", "DEAD_END", "CLAIRVOYANCE", "NULLIFICATION", "FORTUNE", "DESTINY",
      "LOAN", "ALERT", "RETREAT", "RESTART", "PROBE", "DISGUISE", "ENDGAME",
    ]);
    expect(catalog.filter((skill) => skill.id.startsWith("PROTOCOL_"))).toHaveLength(9);
    const destiny = catalog.find((skill) => skill.id === "DESTINY");
    expect(destiny).toMatchObject({ load: 5, energyCost: 7, maxUsesPerHand: null });
    expect(destiny.shortDescription).toBeTruthy();
    expect(destiny.expertDescription).toContain("能量上限");
    expect(catalog.find((skill) => skill.id === "FAIRNESS")).toMatchObject({
      load: 4, energyCost: 3, canBeCountered: false,
    });
    expect(catalog.find((skill) => skill.id === "ENDGAME")).toMatchObject({
      load: 6, energyCost: 8, visibility: "PUBLIC", canBeCountered: true,
    });
    expect(validateLoadout(["ENDGAME", "DEEP_BREATH"])).toMatchObject({ ok: true, totalLoad: 7 });
  });

  test("构筑最多 4 个技能且总负载不超过 8", () => {
    expect(validateLoadout(["DESTINY", "RECYCLE"])).toMatchObject({ ok: true, totalLoad: 7 });
    expect(validateLoadout(["FORTUNE", "DESPERATION"])).toMatchObject({ ok: true, totalLoad: 7 });
    expect(validateLoadout(["PROTOCOL_PAIR", "PROTOCOL_TWO_PAIR", "PROTOCOL_TRIPS", "PROTOCOL_FLUSH"])).toMatchObject({
      ok: true, totalLoad: 4,
    });
    expect(validateLoadout(["DESTINY"])).toMatchObject({ ok: true, totalLoad: 5 });
    expect(validateLoadout(["ENDGAME"])).toMatchObject({ ok: true, totalLoad: 6 });
    expect(validateLoadout([])).toMatchObject({ ok: false });
    expect(validateLoadout(["RECYCLE", "RECYCLE"])).toMatchObject({ ok: false });
    expect(validateLoadout(["RECYCLE", "OLD_SKILL"])).toMatchObject({ ok: false });
    expect(validateLoadout([
      "DEEP_BREATH", "RECYCLE", "BLOOD_BATTLE", "DEFENSE", "PERCEPTION",
    ]).ok).toBe(false);
    expect(validateLoadout(["FAIRNESS", "CHEAT"]).ok).toBe(false);
    expect(validateLoadout(["FAIRNESS", "COUNTER"])).toMatchObject({ ok: true, totalLoad: 8 });
  });

  test("公开快照隐藏构筑与技能数量，不暴露天命 10 点上限", () => {
    const { a } = setupRoom({ loadoutA: ["DESTINY", "RECYCLE"], start: false });
    a.skillRuntime.abyssEnergy = 10;
    const publicSummary = getPublicSkillSummary(a);
    const selfSummary = getSelfSkillSummary(a);
    expect(publicSummary).toMatchObject({ abyssEnergy: 8, buildHidden: true, energyCap: 8 });
    expect(publicSummary).not.toHaveProperty("equippedSkillIds");
    expect(publicSummary.knownSkills).toEqual([]);
    expect(publicSummary.publicEffects).not.toContain("???");
    expect(selfSummary.abyssEnergy).toBe(10);
    expect(selfSummary.energyCap).toBe(10);
    expect(selfSummary.equippedSkillIds).toEqual(["DESTINY", "RECYCLE"]);
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

describe("能量、深呼吸、回收与公平", () => {
  test("胜者 +0、败者 +1、平局双方 +0；Fold 视为败局", () => {
    const { room, a, b, engine } = setupRoom();
    expect(a.skillRuntime.abyssEnergy).toBe(4);
    a.skillRuntime.abyssEnergy = 8;
    b.skillRuntime.abyssEnergy = 5;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(a.skillRuntime.abyssEnergy).toBe(8);
    expect(b.skillRuntime.abyssEnergy).toBe(6);

    const tied = setupRoom();
    tied.a.skillRuntime.abyssEnergy = 7;
    tied.b.skillRuntime.abyssEnergy = 7;
    tied.engine.skillEngine.endHand(tied.room, { reason: "showdown", winner: null, tie: true });
    expect(tied.a.skillRuntime.abyssEnergy).toBe(7);
    expect(tied.b.skillRuntime.abyssEnergy).toBe(7);
  });

  test("深呼吸后无技能再 Fold：恢复 2 + 败局自然 +1", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["DEEP_BREATH", "BLOOD_BATTLE"] });
    expect(use(engine, room, a, "DEEP_BREATH", {}, "breath-fold").ok).toBe(true);
    expect(a.skillRuntime.abyssEnergy).toBe(3);
    a.skillRuntime.foldedThisHand = true;
    engine.skillEngine.endHand(room, { reason: "fold", winner: b, tie: false });
    expect(a.skillRuntime.abyssEnergy).toBe(6);
  });

  test("深呼吸后发动公平：手牌结束不恢复", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["DEEP_BREATH", "FAIRNESS"] });
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "DEEP_BREATH", {}, "breath-then-fair").ok).toBe(true);
    expect(use(engine, room, a, "FAIRNESS", {}, "fair-after-breath").ok).toBe(true);
    const energy = a.skillRuntime.abyssEnergy;
    engine.skillEngine.endHand(room, { reason: "fold", winner: a, tie: false });
    expect(a.skillRuntime.abyssEnergy).toBe(energy);
  });

  test("深呼吸不再要求当前能量 ≤ 4", () => {
    const { engine, room, a } = setupRoom();
    a.skillRuntime.abyssEnergy = 5;
    expect(use(engine, room, a, "DEEP_BREATH", {}, "breath-high-energy")).toMatchObject({ ok: true });
  });

  test("回收利用在手牌结束按最高失败费用的 50% 向下取整返还", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["RECYCLE", "CLAIRVOYANCE"] });
    a.skillRuntime.paidFailuresThisHand = [
      { skillId: "CLAIRVOYANCE", cost: 2, reason: "FAILED" },
      { skillId: "DESTINY", cost: 7, reason: "FAILED" },
    ];
    const before = a.skillRuntime.abyssEnergy;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(a.skillRuntime.abyssEnergy).toBe(before + 3);
    expect(a.skillRuntime.recycleUsedThisHand).toBe(true);
  });

  test("非法请求不扣费、不记失败、不消耗反制", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["INTEL_ONE", "RECYCLE"],
      loadoutB: ["COUNTER", "DEEP_BREATH"],
    });
    b.skillRuntime.counterArmed = true;
    const result = use(engine, room, a, "INTEL_ONE", { zone: "future", boardIndex: null }, "invalid-intel");
    expect(result).toMatchObject({ ok: false });
    expect(a.skillRuntime.abyssEnergy).toBe(4);
    expect(a.skillRuntime.paidFailuresThisHand).toHaveLength(0);
    expect(b.skillRuntime.counterArmed).toBe(true);
  });

  test("公平不必是本手第一个技能，且不能被反制", () => {
    const later = setupRoom({ loadoutA: ["FAIRNESS", "DEEP_BREATH"] });
    later.a.skillRuntime.abyssEnergy = 8;
    expect(use(later.engine, later.room, later.a, "DEEP_BREATH", {}, "first-skill").ok).toBe(true);
    expect(use(later.engine, later.room, later.a, "FAIRNESS", {}, "fair-later")).toMatchObject({ ok: true, status: "SUCCESS" });
    expect(later.room.skillState.fairnessActive).toBe(true);

    const vsCounter = setupRoom({
      loadoutA: ["FAIRNESS", "DEEP_BREATH"],
      loadoutB: ["COUNTER", "RECYCLE"],
    });
    vsCounter.b.skillRuntime.counterArmed = true;
    vsCounter.a.skillRuntime.abyssEnergy = 8;
    expect(use(vsCounter.engine, vsCounter.room, vsCounter.a, "FAIRNESS", {}, "fair-vs-counter")).toMatchObject({
      ok: true, status: "SUCCESS",
    });
    expect(vsCounter.b.skillRuntime.counterArmed).toBe(false);
    expect(vsCounter.a.skillRuntime.lockedThisHand).toBe(true);
  });

  test("公平清除反制、防守、血战、零化，但不回滚已完成的千术与天命", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["CHEAT", "RECYCLE"],
      loadoutB: ["FAIRNESS", "COUNTER"],
    });
    a.skillRuntime.abyssEnergy = 8;
    b.skillRuntime.counterArmed = false;
    b.skillRuntime.defenseActive = true;
    a.skillRuntime.bloodBattleActive = true;
    a.skillRuntime.confirmedPublicSkills.push("BLOOD_BATTLE");
    a.skillRuntime.revealedSkillIds.push("BLOOD_BATTLE");
    room.skillState.nullifications.push({ type: "board", boardIndex: 0, cardCode: "SA", revealed: false });
    engine.finishStreetDeal(room, "flop");
    engine.clearActionTimer(room);
    room.currentPlayerIndex = 0;
    const own = a.cards[0];
    const board = room.communityCards[0];
    expect(use(engine, room, a, "CHEAT", { ownIndex: 0, zone: "community", index: 0 }, "cheat-then-fair")).toMatchObject({ status: "SUCCESS" });
    expect(a.cards[0].code).toBe(board.code);
    b.skillRuntime.counterArmed = true;
    b.skillRuntime.abyssEnergy = 8;
    room.currentPlayerIndex = 1;
    expect(use(engine, room, b, "FAIRNESS", {}, "fair-clear")).toMatchObject({ status: "SUCCESS" });
    expect(b.skillRuntime.counterArmed).toBe(false);
    expect(b.skillRuntime.defenseActive).toBe(false);
    expect(a.skillRuntime.bloodBattleActive).toBe(false);
    expect(room.skillState.nullifications).toEqual([]);
    expect(a.cards[0].code).toBe(board.code);
    expect(room.communityCards[0].code).toBe(own.code);
    expect(getPublicSkillSummary(b).publicEffects).toContain("FAIRNESS");
    expect(getPublicSkillSummary(a).publicEffects).not.toContain("BLOOD_BATTLE");
    expect(getPublicSkillSummary(a).publicEffects).not.toContain("INTIMIDATION");
    expect(getPublicSkillSummary(a).knownSkills).toEqual(expect.arrayContaining(["BLOOD_BATTLE", "CHEAT"]));
    expect(getPublicSkillSummary(b).knownSkills).toContain("FAIRNESS");
  });

  test("自然公开的技能会进入已知构筑并跨手保留", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["DEEP_BREATH", "RECYCLE"] });
    expect(use(engine, room, a, "DEEP_BREATH", {}, "reveal-breath")).toMatchObject({ status: "SUCCESS" });
    expect(getPublicSkillSummary(a).knownSkills).toContain("DEEP_BREATH");

    beginHandSkills(room);
    expect(getPublicSkillSummary(a).knownSkills).toContain("DEEP_BREATH");
    expect(getPublicSkillSummary(a)).not.toHaveProperty("equippedSkillIds");
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
});

describe("反制、恐吓、血战、绝境、防守、绝路", () => {
  test("反制抓住主动技能：目标付费失败，后续主动与新被动均锁死", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["BLOOD_BATTLE", "PERCEPTION"],
      loadoutB: ["COUNTER", "DEEP_BREATH"],
      random: () => 0,
    });
    const beforePerception = a.skillRuntime.perceptionTriggerCount;
    b.skillRuntime.counterArmed = true;
    expect(use(engine, room, a, "BLOOD_BATTLE", {}, "countered-blood")).toMatchObject({ status: "COUNTERED" });
    expect(a.skillRuntime.abyssEnergy).toBe(1);
    expect(a.skillRuntime.lockedThisHand).toBe(true);
    expect(a.skillRuntime.bloodBattleActive).toBe(false);
    expect(use(engine, room, a, "BLOOD_BATTLE", {}, "locked-active").ok).toBe(false);
    engine.skillEngine.onCardsDealt(room, "flop");
    expect(a.skillRuntime.perceptionTriggerCount).toBe(beforePerception);
  });

  test("被反制后回收利用仍结算已支付失败费用", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["BLOOD_BATTLE", "RECYCLE"],
      loadoutB: ["COUNTER", "DEEP_BREATH"],
    });
    b.skillRuntime.counterArmed = true;
    expect(use(engine, room, a, "BLOOD_BATTLE", {}, "recycle-after-counter")).toMatchObject({ status: "COUNTERED" });
    expect(a.skillRuntime.abyssEnergy).toBe(1);
    expect(a.skillRuntime.lockedThisHand).toBe(true);
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(a.skillRuntime.abyssEnergy).toBe(2);
    expect(a.skillRuntime.recycleUsedThisHand).toBe(true);
  });

  test("反制整手未触发则结束返还 1 能量", () => {
    const { engine, room, b } = setupRoom({
      loadoutA: ["DEEP_BREATH", "BLOOD_BATTLE"],
      loadoutB: ["COUNTER", "RECYCLE"],
    });
    b.skillRuntime.abyssEnergy = 8;
    room.currentPlayerIndex = 1;
    expect(use(engine, room, b, "COUNTER", {}, "arm-counter")).toMatchObject({ status: "SUCCESS" });
    expect(b.skillRuntime.abyssEnergy).toBe(4);
    expect(b.skillRuntime.counterArmed).toBe(true);
    engine.skillEngine.endHand(room, { reason: "showdown", winner: b, tie: false });
    expect(b.skillRuntime.abyssEnergy).toBe(5);
    expect(b.skillRuntime.counterArmed).toBe(false);
  });

  test("恐吓禁止 Fold，ALL IN 只投入到累计 500 但仍记录 ALL IN 事件", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["INTIMIDATION", "DEEP_BREATH"] });
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "INTIMIDATION", {}, "fear").ok).toBe(true);
    expect(getValidActions(room, 0).validActions).not.toContain("fold");
    a.totalBet = 490;
    a.streetBet = 0;
    a.chips = 1000;
    b.totalBet = 490;
    b.streetBet = 0;
    b.chips = 1000;
    room.currentBet = 0;
    expect(getValidActions(room, 0).validActions).toContain("allin");
    const paid = collectBet(room, a, 100);
    expect(paid).toBe(10);
    expect(a.totalBet).toBe(500);
    a.totalBet = 490;
    a.streetBet = 0;
    a.chips = 1000;
    const allin = engine.handlePlayerAction(room, 0, "allin");
    expect(allin.ok).toBe(true);
    expect(a.totalBet).toBe(500);
    expect(a.skillRuntime.allInAction).toBe(true);
    expect(a.skillRuntime.stackCommitted).toBe(false);
    expect(a.isAllIn).toBe(false);
  });

  test("恐吓 + 绝路：可以 ALL IN，但禁止 Fold 所以不会触发绝路 Fold×3", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["INTIMIDATION", "DEAD_END"],
      loadoutB: ["DEEP_BREATH", "RECYCLE"],
    });
    a.skillRuntime.abyssEnergy = 9;
    expect(use(engine, room, a, "INTIMIDATION", {}, "fear-then-dead").ok).toBe(true);
    expect(use(engine, room, a, "DEAD_END", {}, "dead-under-fear")).toMatchObject({ status: "SUCCESS" });
    expect(a.skillRuntime.deadEndActive).toBe(true);
    expect(a.skillRuntime.allInAction).toBe(true);
    expect(getValidActions(room, 1).validActions).not.toContain("fold");
    a.chips = 1300;
    b.chips = 700;
    const result = engine.skillEngine.applySettlementModifiers(room, { reason: "showdown", winner: a, winnerCategory: 2 });
    expect(result.effects.some((entry) => entry.skillId === "DEAD_END")).toBe(false);
  });

  test("双方血战相乘为 ×4", () => {
    const { engine, room, a, b } = setupRoom();
    a.chips = 1100;
    b.chips = 900;
    a.skillRuntime.bloodBattleActive = true;
    b.skillRuntime.bloodBattleActive = true;
    const result = engine.skillEngine.applySettlementModifiers(room, { reason: "showdown", winner: a, winnerCategory: 1 });
    expect(result).toMatchObject({ baseTransfer: 100, finalTransfer: 400, multiplier: 4 });
    expect(result.selfSkillMultiplier).toBe(2);
    expect(result.opponentSkillMultiplier).toBe(2);
  });

  test("绝境只看手牌开始筹码快照：201 不触发，200 触发", () => {
    const high = setupRoom({ loadoutA: ["DESPERATION", "RECYCLE"], start: false });
    high.a.chips = 201;
    beginHandSkills(high.room);
    expect(high.a.skillRuntime.desperationActive).toBe(false);
    high.a.chips = 100;
    expect(high.a.skillRuntime.desperationActive).toBe(false);

    const low = setupRoom({ loadoutA: ["DESPERATION", "RECYCLE"], start: false });
    low.a.chips = 200;
    beginHandSkills(low.room);
    expect(low.a.skillRuntime.desperationActive).toBe(true);
  });

  test("防守在河牌发动仍减半整手最终非 Fold 损失", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["DEFENSE", "DEEP_BREATH"] });
    goToStreet(engine, room, "river", 0);
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "DEFENSE", {}, "river-defense")).toMatchObject({ status: "SUCCESS" });
    expect(a.skillRuntime.defenseActive).toBe(true);
    a.chips = 900;
    b.chips = 1100;
    const result = engine.skillEngine.applySettlementModifiers(room, { reason: "showdown", winner: b, winnerCategory: 2 });
    expect(result.multiplier).toBe(0.5);
    expect(a.skillRuntime.defenseRevealed).toBe(true);
  });

  test("绝路是主动技能，成功后锁对手；Showdown 即使获胜也不提供 ×3", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["DEAD_END", "DEEP_BREATH"] });
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "DEAD_END", {}, "dead-active")).toMatchObject({ status: "SUCCESS" });
    expect(a.skillRuntime.deadEndActive).toBe(true);
    expect(b.skillRuntime.lockedThisHand).toBe(true);
    a.chips = 1300;
    b.chips = 700;
    const result = engine.skillEngine.applySettlementModifiers(room, { reason: "showdown", winner: a, winnerCategory: 5 });
    expect(result.effects.some((entry) => entry.skillId === "DEAD_END")).toBe(false);
  });
});

describe("情报、绝密、千术、零化、感知、灵视", () => {
  test("情报底牌被绝密阻止：4 费支付后失败；未来 River 不受绝密影响", () => {
    const blocked = setupRoom({
      loadoutA: ["INTEL_ONE", "RECYCLE"],
      loadoutB: ["TOP_SECRET", "DEEP_BREATH"],
    });
    blocked.a.skillRuntime.abyssEnergy = 8;
    expect(use(blocked.engine, blocked.room, blocked.a, "INTEL_ONE", { zone: "opponent" }, "intel-hole")).toMatchObject({
      status: "FAILED",
    });
    expect(blocked.a.skillRuntime.abyssEnergy).toBe(4);
    expect(blocked.b.skillRuntime.topSecretActive).toBe(true);
    expect(blocked.b.skillRuntime.abyssEnergy).toBe(1);

    const future = setupRoom({
      loadoutA: ["INTEL_ONE", "RECYCLE"],
      loadoutB: ["TOP_SECRET", "DEEP_BREATH"],
    });
    future.a.skillRuntime.abyssEnergy = 8;
    const river = getFutureCommunitySlots(future.room).find((slot) => slot.boardIndex === 4);
    expect(use(future.engine, future.room, future.a, "INTEL_ONE", { zone: "future", boardIndex: 4 }, "intel-river")).toMatchObject({
      status: "SUCCESS",
    });
    expect(future.a.skillRuntime.privateResults.at(-1).message).toContain(playerCardLabel(river.card));
    expect(future.b.skillRuntime.topSecretActive).toBe(false);
    expect(future.b.skillRuntime.abyssEnergy).toBe(4);
  });

  test("千术只在目标为对手底牌时被绝密阻挡；河牌公开后仍可换明牌", () => {
    const blocked = setupRoom({
      loadoutA: ["CHEAT", "RECYCLE"],
      loadoutB: ["TOP_SECRET", "DEEP_BREATH"],
    });
    blocked.a.skillRuntime.abyssEnergy = 8;
    expect(use(blocked.engine, blocked.room, blocked.a, "CHEAT", { ownIndex: 0, zone: "opponent", index: 0 }, "cheat-hole")).toMatchObject({
      status: "FAILED",
    });
    expect(blocked.a.skillRuntime.abyssEnergy).toBe(2);

    const { engine, room, a } = setupRoom({ loadoutA: ["CHEAT", "RECYCLE"] });
    goToStreet(engine, room, "river", 0);
    a.skillRuntime.abyssEnergy = 8;
    const own = a.cards[0];
    const board = room.communityCards[0];
    const before = [...a.cards, ...room.communityCards, ...room.deck, ...room.skillState.burnedCards].map((card) => card.code).sort();
    expect(use(engine, room, a, "CHEAT", { ownIndex: 0, zone: "community", index: 0 }, "cheat-after-river")).toMatchObject({
      status: "SUCCESS",
    });
    expect(a.cards[0].code).toBe(board.code);
    expect(room.communityCards[0].code).toBe(own.code);
    expect(a.skillRuntime.privateResults.at(-1).message).toContain(playerCardLabel(board));
    const after = [...a.cards, ...room.communityCards, ...room.deck, ...room.skillState.burnedCards].map((card) => card.code).sort();
    expect(after).toEqual(before);
  });

  test("零化底牌被绝密阻止支付 7 费失败；双方零化同一公共牌都扣费且只排除一次", () => {
    const blocked = setupRoom({
      loadoutA: ["NULLIFICATION", "RECYCLE"],
      loadoutB: ["TOP_SECRET", "DEEP_BREATH"],
    });
    goToStreet(blocked.engine, blocked.room, "flop", 0);
    blocked.a.skillRuntime.abyssEnergy = 8;
    expect(use(blocked.engine, blocked.room, blocked.a, "NULLIFICATION", { mode: "hole" }, "null-hole")).toMatchObject({
      status: "FAILED",
    });
    expect(blocked.a.skillRuntime.abyssEnergy).toBe(1);

    const dual = setupRoom({
      loadoutA: ["NULLIFICATION", "RECYCLE"],
      loadoutB: ["NULLIFICATION", "DEEP_BREATH"],
    });
    goToStreet(dual.engine, dual.room, "flop", 0);
    dual.a.skillRuntime.abyssEnergy = 8;
    dual.b.skillRuntime.abyssEnergy = 8;
    expect(use(dual.engine, dual.room, dual.a, "NULLIFICATION", { mode: "board", boardIndex: 1 }, "null-a")).toMatchObject({
      status: "SUCCESS",
    });
    expect(getPublicRoomSkillSnapshot(dual.room).nullifiedCommunityCardIds).toEqual([]);
    dual.room.currentPlayerIndex = 1;
    expect(use(dual.engine, dual.room, dual.b, "NULLIFICATION", { mode: "board", boardIndex: 1 }, "null-b")).toMatchObject({
      status: "SUCCESS",
    });
    expect(dual.a.skillRuntime.abyssEnergy).toBe(2);
    expect(dual.b.skillRuntime.abyssEnergy).toBe(2);
    const excluded = dual.engine.skillEngine.getNullifiedSet(dual.room);
    expect(excluded.size).toBe(1);
    expect(excluded.has(dual.room.communityCards[1].code)).toBe(true);
    expect(getPublicRoomSkillSnapshot(dual.room).nullifiedCommunityCardIds).toEqual([]);

    const holeOnly = setupRoom({
      loadoutA: ["NULLIFICATION", "RECYCLE"],
      loadoutB: ["DEEP_BREATH", "RECYCLE"],
      random: () => 0,
    });
    goToStreet(holeOnly.engine, holeOnly.room, "flop", 0);
    holeOnly.a.skillRuntime.abyssEnergy = 8;
    expect(use(holeOnly.engine, holeOnly.room, holeOnly.a, "NULLIFICATION", { mode: "hole" }, "null-hole-eval")).toMatchObject({
      status: "SUCCESS",
    });
    const nullifiedCode = holeOnly.b.cards[0].code;
    expect(holeOnly.engine.skillEngine.getNullifiedSet(holeOnly.room, holeOnly.b).has(nullifiedCode)).toBe(true);
    expect(holeOnly.engine.skillEngine.getNullifiedSet(holeOnly.room, holeOnly.a).has(nullifiedCode)).toBe(false);
    expect(holeOnly.engine.skillEngine.getNullifiedSet(holeOnly.room).has(nullifiedCode)).toBe(false);
  });

  test("感知每节点独立判定、每手最多 3 次，且不带真假标签", () => {
    const { a, engine, room } = setupRoom({
      loadoutA: ["PERCEPTION", "RECYCLE"],
      random: () => 0,
    });
    expect(a.skillRuntime.perceptionTriggerCount).toBe(1);
    goToStreet(engine, room, "flop");
    goToStreet(engine, room, "turn");
    goToStreet(engine, room, "river");
    expect(a.skillRuntime.perceptionTriggerCount).toBe(3);
    expect(a.skillRuntime.privateResults[0].message).toMatch(/^感知 · /);
    expect(a.skillRuntime.privateResults[0].message).not.toMatch(/真实|虚假|75%/);
    const axes = a.skillRuntime.perceptionHistory.map((entry) => entry.axis);
    expect(new Set(axes).size).toBe(axes.length);
  });

  test("感知触及底牌信息时才触发绝密，且绝密生效后不再泄露底牌命题", () => {
    const { a, b, engine, room } = setupRoom({
      loadoutA: ["PERCEPTION", "RECYCLE"],
      loadoutB: ["TOP_SECRET", "DEEP_BREATH"],
      random: () => 0,
    });
    expect(b.skillRuntime.topSecretActive).toBe(true);
    expect(b.skillRuntime.abyssEnergy).toBe(1);
    expect(a.skillRuntime.perceptionTriggerCount).toBe(0);
    goToStreet(engine, room, "flop");
    expect(a.skillRuntime.perceptionTriggerCount).toBe(0);
    expect(a.skillRuntime.privateResults.some((entry) => String(entry.message || "").startsWith("感知 · "))).toBe(false);
  });

  test("灵视读取真实能量和已发生感知事件，但不能读取感知内容", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["CLAIRVOYANCE", "RECYCLE"],
      loadoutB: ["PERCEPTION", "DEEP_BREATH"],
    });
    b.skillRuntime.abyssEnergy = 9;
    room.skillState.skillActionLog.push({
      at: Date.now(), skillId: "PERCEPTION", casterId: b.playerId, status: "TRIGGERED", secret: true,
      audit: { statement: "对手持有口袋对子。", truthful: true },
    });
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "CLAIRVOYANCE", {}, "clair")).toMatchObject({ status: "SUCCESS" });
    const result = a.skillRuntime.privateResults.at(-1);
    expect(result.opponentEnergy).toBe(9);
    expect(result.events).toEqual(expect.arrayContaining([expect.objectContaining({ skillId: "PERCEPTION" })]));
    expect(JSON.stringify(result.events)).not.toContain("口袋对子");
    expect(result.message).not.toContain("口袋对子");
  });

  test("感知内容对对手隐藏，公开日志不含命题文本", () => {
    const { a, b, room } = setupRoom({
      loadoutA: ["PERCEPTION", "RECYCLE"],
      loadoutB: ["DEEP_BREATH", "RECYCLE"],
      random: () => 0,
    });
    expect(a.skillRuntime.perceptionTriggerCount).toBeGreaterThan(0);
    expect(a.skillRuntime.privateResults.some((entry) => String(entry.message || "").startsWith("感知 · "))).toBe(true);
    expect(b.skillRuntime.privateResults.some((entry) => String(entry.message || "").includes("感知"))).toBe(false);
    const snapshot = getPublicRoomSkillSnapshot(room);
    expect(snapshot.recentLog.some((entry) => entry.skillId === "PERCEPTION")).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("对方可能有");
    expect(JSON.stringify(snapshot)).not.toContain("口袋对子");
  });
});

describe("强运、天命与协议", () => {
  test("强运 1 能量触发 3 费改牌得到 -2；若会低于 -4 则不发生", () => {
    const live = setupRoom({
      loadoutA: ["FORTUNE", "RECYCLE"],
      start: false,
      random: () => 0,
    });
    beginHandSkills(live.room);
    live.a.cards = weakHole();
    live.b.cards = [byCode().S3, byCode().H8];
    live.room.deck = createDeck().filter((card) => !["C2", "D7", "S3", "H8"].includes(card.code));
    live.a.skillRuntime.abyssEnergy = 1;
    const triggered = live.engine.skillEngine.applyHoleFortune(live.room);
    expect(triggered).toHaveLength(1);
    expect(live.a.skillRuntime.abyssEnergy).toBe(-2);

    const blocked = setupRoom({ loadoutA: ["FORTUNE", "RECYCLE"], start: false, random: () => 0 });
    beginHandSkills(blocked.room);
    blocked.a.cards = weakHole();
    blocked.b.cards = [byCode().S3, byCode().H8];
    blocked.room.deck = createDeck().filter((card) => !["C2", "D7", "S3", "H8"].includes(card.code));
    blocked.a.skillRuntime.abyssEnergy = -2;
    expect(blocked.engine.skillEngine.applyHoleFortune(blocked.room)).toHaveLength(0);
    expect(blocked.a.skillRuntime.abyssEnergy).toBe(-2);

    const edge = setupRoom({ loadoutA: ["FORTUNE", "RECYCLE"], start: false, random: () => 0 });
    beginHandSkills(edge.room);
    edge.a.cards = weakHole();
    edge.b.cards = [byCode().S3, byCode().H8];
    edge.room.deck = createDeck().filter((card) => !["C2", "D7", "S3", "H8"].includes(card.code));
    edge.a.skillRuntime.abyssEnergy = -1;
    expect(edge.engine.skillEngine.applyHoleFortune(edge.room)).toHaveLength(1);
    expect(edge.a.skillRuntime.abyssEnergy).toBe(-4);
  });

  test("强运负能量时其他主动技能与新的被动事件都不能发生", () => {
    const active = setupRoom({ loadoutA: ["FORTUNE", "BLOOD_BATTLE"] });
    active.a.skillRuntime.abyssEnergy = -1;
    expect(use(active.engine, active.room, active.a, "BLOOD_BATTLE", {}, "neg-active").ok).toBe(false);

    const passive = setupRoom({ loadoutA: ["FORTUNE", "PERCEPTION"], random: () => 0 });
    const beforePerception = passive.a.skillRuntime.perceptionTriggerCount;
    passive.a.skillRuntime.abyssEnergy = -1;
    passive.engine.skillEngine.onCardsDealt(passive.room, "flop");
    expect(passive.a.skillRuntime.perceptionTriggerCount).toBe(beforePerception);
  });

  test("携带天命能量上限 10，未携带最高 8", () => {
    const withDestiny = setupRoom({ loadoutA: ["DESTINY", "RECYCLE"], start: false });
    withDestiny.a.skillRuntime.abyssEnergy = 9;
    const { gainEnergy } = require("../game/skills/skillState");
    gainEnergy(withDestiny.a, 2);
    expect(withDestiny.a.skillRuntime.abyssEnergy).toBe(10);

    const without = setupRoom({ start: false });
    without.a.skillRuntime.abyssEnergy = 8;
    gainEnergy(without.a, 2);
    expect(without.a.skillRuntime.abyssEnergy).toBe(8);
  });

  test("天命在转牌后立刻把合法牌移到 River 有效发牌位；公平不能回滚；失败仍扣 7", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["DESTINY", "RECYCLE"],
      loadoutB: ["FAIRNESS", "DEEP_BREATH"],
    });
    goToStreet(engine, room, "turn", 0);
    a.skillRuntime.abyssEnergy = 10;
    expect(room.deck.some((card) => card.code === "S2")).toBe(true);
    expect(use(engine, room, a, "DESTINY", { cardCode: "S2" }, "destiny-s2")).toMatchObject({ status: "SUCCESS" });
    expect(a.skillRuntime.privateResults.at(-1).message).toContain("2♠");
    expect(getFutureCommunitySlots(room).find((slot) => slot.boardIndex === 4).card.code).toBe("S2");
    room.currentPlayerIndex = 1;
    b.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, b, "FAIRNESS", {}, "fair-after-destiny")).toMatchObject({ status: "SUCCESS" });
    expect(getFutureCommunitySlots(room).find((slot) => slot.boardIndex === 4).card.code).toBe("S2");

    const miss = setupRoom({ loadoutA: ["DESTINY", "RECYCLE"] });
    goToStreet(miss.engine, miss.room, "turn", 0);
    miss.a.skillRuntime.abyssEnergy = 10;
    expect(use(miss.engine, miss.room, miss.a, "DESTINY", { cardCode: miss.b.cards[0].code }, "destiny-hole")).toMatchObject({
      status: "FAILED",
    });
    expect(miss.a.skillRuntime.abyssEnergy).toBe(3);
  });

  test("天命撞反制：支付 7、失败、牌堆不改、后续技能被锁", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["DESTINY", "BLOOD_BATTLE"],
      loadoutB: ["COUNTER", "DEEP_BREATH"],
    });
    goToStreet(engine, room, "turn", 0);
    a.skillRuntime.abyssEnergy = 10;
    b.skillRuntime.counterArmed = true;
    const before = room.deck.map((card) => card.code);
    expect(use(engine, room, a, "DESTINY", { cardCode: "S2" }, "destiny-counter")).toMatchObject({ status: "COUNTERED" });
    expect(a.skillRuntime.abyssEnergy).toBe(3);
    expect(room.deck.map((card) => card.code)).toEqual(before);
    expect(a.skillRuntime.lockedThisHand).toBe(true);
    expect(use(engine, room, a, "BLOOD_BATTLE", {}, "after-counter").ok).toBe(false);
  });

  test("天命成功后对手 Fold，7 能量不返还", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["DESTINY", "RECYCLE"] });
    goToStreet(engine, room, "turn", 0);
    a.skillRuntime.abyssEnergy = 10;
    expect(use(engine, room, a, "DESTINY", { cardCode: "S2" }, "destiny-then-fold")).toMatchObject({ status: "SUCCESS" });
    engine.skillEngine.endHand(room, { reason: "fold", winner: a, tie: false });
    expect(a.skillRuntime.abyssEnergy).toBe(3);
    expect(b.skillRuntime.abyssEnergy).toBe(5);
  });

  test("协议只在 Showdown 精确牌型获胜且自己没有其他倍率时触发", () => {
    const pair = setupRoom({ loadoutA: ["PROTOCOL_PAIR", "RECYCLE"] });
    pair.a.chips = 1100;
    pair.b.chips = 900;
    expect(pair.engine.skillEngine.applySettlementModifiers(pair.room, {
      reason: "showdown", winner: pair.a, winnerCategory: 2,
    }).multiplier).toBe(2);

    const twoPair = setupRoom({ loadoutA: ["PROTOCOL_PAIR", "RECYCLE"] });
    twoPair.a.chips = 1100;
    twoPair.b.chips = 900;
    expect(twoPair.engine.skillEngine.applySettlementModifiers(twoPair.room, {
      reason: "showdown", winner: twoPair.a, winnerCategory: 3,
    }).multiplier).toBe(1);

    const selfBlood = setupRoom({ loadoutA: ["PROTOCOL_PAIR", "BLOOD_BATTLE"] });
    selfBlood.a.chips = 1100;
    selfBlood.b.chips = 900;
    selfBlood.a.skillRuntime.bloodBattleActive = true;
    expect(selfBlood.engine.skillEngine.applySettlementModifiers(selfBlood.room, {
      reason: "showdown", winner: selfBlood.a, winnerCategory: 2,
    }).effects.some((entry) => entry.skillId === "PROTOCOL_PAIR")).toBe(false);

    const oppBlood = setupRoom({ loadoutA: ["PROTOCOL_PAIR", "RECYCLE"] });
    oppBlood.a.chips = 1100;
    oppBlood.b.chips = 900;
    oppBlood.b.skillRuntime.bloodBattleActive = true;
    const stacked = oppBlood.engine.skillEngine.applySettlementModifiers(oppBlood.room, {
      reason: "showdown", winner: oppBlood.a, winnerCategory: 2,
    });
    expect(stacked.multiplier).toBe(4);
    expect(stacked.selfSkillMultiplier).toBe(2);
    expect(stacked.opponentSkillMultiplier).toBe(2);

    const both = setupRoom({ loadoutA: ["PROTOCOL_PAIR", "PROTOCOL_TWO_PAIR"] });
    both.a.chips = 1100;
    both.b.chips = 900;
    const result = both.engine.skillEngine.applySettlementModifiers(both.room, {
      reason: "showdown", winner: both.a, winnerCategory: 3,
    });
    expect(result.effects.map((entry) => entry.skillId)).toEqual(["PROTOCOL_TWO_PAIR"]);
    expect(result.multiplier).toBe(2);
  });

  test("强运配置保持可替换，且默认事件池仍可审计", () => {
    expect(SKILL_RULE_FREEZE.FORTUNE).toMatchObject({
      skillId: "FORTUNE",
      status: "FROZEN_V1",
      variant: "soft-v1",
      frozenAt: "2026-08-20",
    });
    expect(SKILL_RULE_FREEZE.PERCEPTION).toMatchObject({
      skillId: "PERCEPTION",
      status: "FROZEN_V1",
      variant: "spec-25-50",
      frozenAt: "2026-08-20",
    });
    expect(FORTUNE_RULE.status).toBe("FROZEN_V1");
    expect(FORTUNE_CONFIG.status).toBe(SKILL_RULE_FREEZE.FORTUNE.status);
    expect(FORTUNE_CONFIG.variant).toBe(SKILL_RULE_FREEZE.FORTUNE.variant);
    expect(FORTUNE_CONFIG.frozenAt).toBe("2026-08-20");
    expect(FORTUNE_COMBOS).toHaveLength(126);
    expect(new Set(FORTUNE_COMBOS.map((combo) => combo.codes.slice().sort().join("-"))).size).toBe(126);
    expect(computeFortuneChance("hole", { disadvantage: 0, energy: 4 })).toBeCloseTo(0.0805, 3);
    expect(computeFortuneChance("board", { disadvantage: 0, energy: 4 })).toBeCloseTo(0.0539, 3);
    expect(computeFortuneChance("resource", { disadvantage: 0, energy: 4 })).toBeCloseTo(0.16, 3);
    expect(computeFortuneChance("hole", { disadvantage: 1, energy: 4 })).toBeCloseTo(0.1897, 3);
    expect(PERCEPTION_CONFIG.status).toBe(SKILL_RULE_FREEZE.PERCEPTION.status);
    expect(PERCEPTION_CONFIG.variant).toBe("spec-25-50");
    expect(PERCEPTION_CONFIG.frozenAt).toBe("2026-08-20");
    expect(PERCEPTION_CONFIG.nodes).toEqual(["pre_flop", "flop", "turn", "river"]);
    expect(SKILL_CONFIG.PERCEPTION_BASE_CHANCE).toBe(0.25);
    expect(SKILL_CONFIG.PERCEPTION_MAX_CHANCE).toBe(0.5);
    expect(SKILL_CONFIG.PERCEPTION_TRUTH_CHANCE).toBe(0.75);
    expect(SKILL_CONFIG.PERCEPTION_MAX_TRIGGERS_PER_HAND).toBe(3);
  });

  test("强运改写后最终牌区仍保持 52 张唯一", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["FORTUNE", "RECYCLE"],
      start: false,
      random: () => 0,
      deckFactory: createDeck,
    });
    beginHandSkills(room);
    room.deck = createDeck();
    a.cards = weakHole();
    b.cards = [byCode().S3, byCode().H8];
    room.deck = createDeck().filter((card) => !["C2", "D7", "S3", "H8"].includes(card.code));
    engine.skillEngine.applyHoleFortune(room);
    const codes = [
      ...a.cards, ...b.cards, ...room.communityCards, ...room.deck,
      ...(room.skillState.burnedCards || []), ...(room.skillState.removedCards || []),
    ].map((card) => card.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("公共牌强运不会改写即将烧掉或后续发牌槽位", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["FORTUNE", "RECYCLE"],
      start: false,
      random: () => 0,
    });
    beginHandSkills(room);
    const cards = byCode();
    a.cards = [cards.SA, cards.C2];
    b.cards = [cards.S3, cards.H8];
    const live = createDeck().filter((card) => !["SA", "C2", "S3", "H8"].includes(card.code));
    room.communityCards = [];
    room.deck = live;
    const burnCode = room.deck[room.deck.length - 1].code;
    const reservedCodes = getFutureCommunitySlots(room).map((slot) => slot.card.code);
    a.skillRuntime.abyssEnergy = 8;
    engine.skillEngine.applyBoardFortune(room, "flop");
    expect(room.deck[room.deck.length - 1].code).toBe(burnCode);
    const afterReserved = getFutureCommunitySlots(room).map((slot) => slot.card.code);
    expect(afterReserved.slice(1)).toEqual(reservedCodes.slice(1));
  });

  test("公共牌强运只按自己的底牌打分，不读取对手底牌", () => {
    const run = (villainCodes) => {
      const { engine, room, a, b } = setupRoom({
        loadoutA: ["FORTUNE", "RECYCLE"],
        start: false,
        random: () => 0,
      });
      beginHandSkills(room);
      const cards = byCode();
      a.cards = [cards.SA, cards.C2];
      b.cards = villainCodes.map((code) => cards[code]);
      room.communityCards = [];
      room.deck = createDeck().filter((card) => !["SA", "C2", "S3", "H8", "HA", "DA"].includes(card.code));
      a.skillRuntime.abyssEnergy = 8;
      engine.skillEngine.applyBoardFortune(room, "flop");
      return getFutureCommunitySlots(room)[0].card.code;
    };
    expect(run(["S3", "H8"])).toBe(run(["HA", "DA"]));
  });

  test("未触发不扣能量；资源强运 +1 且不递归、不消耗能量", () => {
    const miss = setupRoom({ loadoutA: ["FORTUNE", "RECYCLE"], start: false, random: () => 0.99 });
    beginHandSkills(miss.room);
    miss.a.cards = weakHole();
    miss.b.cards = [byCode().S3, byCode().H8];
    miss.room.deck = createDeck().filter((card) => !["C2", "D7", "S3", "H8"].includes(card.code));
    miss.a.skillRuntime.abyssEnergy = 4;
    expect(miss.engine.skillEngine.applyHoleFortune(miss.room)).toHaveLength(0);
    expect(miss.a.skillRuntime.abyssEnergy).toBe(4);

    const { engine, room, a } = setupRoom({ loadoutA: ["FORTUNE", "RECYCLE"], start: false, random: () => 0 });
    beginHandSkills(room);
    a.skillRuntime.abyssEnergy = 4;
    expect(engine.skillEngine.applyResourceFortune(room, a)).toBe(true);
    expect(a.skillRuntime.abyssEnergy).toBe(5);
    expect(engine.skillEngine.applyResourceFortune(room, a)).toBe(false);
    expect(a.skillRuntime.abyssEnergy).toBe(5);
  });

  test("负能量时强运自身仍可判定，其他被动不产生新事件", () => {
    const { engine, room, a } = setupRoom({
      loadoutA: ["FORTUNE", "PERCEPTION"],
      start: false,
      random: () => 0,
    });
    beginHandSkills(room);
    a.cards = weakHole();
    room.players[1].cards = [byCode().S3, byCode().H8];
    room.deck = createDeck().filter((card) => !["C2", "D7", "S3", "H8"].includes(card.code));
    a.skillRuntime.abyssEnergy = -1;
    expect(engine.skillEngine.applyHoleFortune(room)).toHaveLength(1);
    expect(a.skillRuntime.abyssEnergy).toBe(-4);
    const before = a.skillRuntime.perceptionTriggerCount;
    engine.skillEngine.onCardsDealt(room, "pre_flop");
    expect(a.skillRuntime.perceptionTriggerCount).toBe(before);
  });
});

describe("机器人与手牌结束辅助", () => {
  test("单机对手会在自己的下注回合使用默认主动技能", () => {
    const cards = byCode();
    const strong = setupRoom({
      loadoutB: ["DEEP_BREATH", "BLOOD_BATTLE", "DEFENSE", "DESPERATION"],
    });
    strong.b.isBot = true;
    strong.room.currentPlayerIndex = 1;
    strong.b.cards = [cards.SA, cards.HA];
    expect(strong.engine.skillEngine.tryBotTurnSkill(strong.room, strong.b)).toMatchObject({
      ok: true,
      skillId: "BLOOD_BATTLE",
    });
  });

  test("endHandSkills 兼容旧测试入口", () => {
    const { room, a, b } = setupRoom();
    a.skillRuntime.abyssEnergy = 4;
    b.skillRuntime.abyssEnergy = 4;
    endHandSkills(room, { reason: "fold", winner: a, tie: false });
    expect(a.skillRuntime.abyssEnergy).toBe(4);
    expect(b.skillRuntime.abyssEnergy).toBe(5);
  });
});
