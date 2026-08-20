const { createDeck } = require("../utils/deck");
const {
  PERCEPTION_CATEGORIES,
  buildPerceptionFacts,
  pickPerceptionStatement,
  canEmitFact,
} = require("../game/skills/perceptionFacts");
const { PERCEPTION_CONFIG } = require("../game/skillConfig");

function card(code) {
  const suit = code[0];
  const rank = code.slice(1);
  const values = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
  return { code, suit, rank, value: values[rank] || Number(rank) };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roomWith(observerCodes, targetCodes, boardCodes = []) {
  const by = Object.fromEntries(createDeck().map((item) => [item.code, item]));
  return {
    room: { communityCards: boardCodes.map((code) => by[code] || card(code)) },
    observer: { cards: observerCodes.map((code) => by[code] || card(code)) },
    target: { cards: targetCodes.map((code) => by[code] || card(code)) },
  };
}

describe("感知命题生成", () => {
  test("冻结配置为 spec-25-50", () => {
    expect(PERCEPTION_CONFIG).toMatchObject({
      status: "FROZEN_V1",
      variant: "spec-25-50",
      frozenAt: "2026-08-20",
      baseChance: 0.25,
      maxChance: 0.5,
      truthChance: 0.75,
      maxTriggersPerHand: 3,
    });
    expect(Object.keys(PERCEPTION_CATEGORIES).sort()).toEqual([
      "BOARD_RELATION", "COLOR", "CONNECTED", "DRAW", "HOLE_SUIT_MATCH",
      "MADE", "PAIR", "RANK", "SUIT",
    ].sort());
  });

  test("假命题对应当前牌面严格为假，真命题严格为真", () => {
    const random = mulberry32(20260820);
    let checked = 0;
    for (let i = 0; i < 400; i += 1) {
      const deck = createDeck();
      for (let n = deck.length - 1; n > 0; n -= 1) {
        const swap = Math.floor(random() * (n + 1));
        [deck[n], deck[swap]] = [deck[swap], deck[n]];
      }
      const observer = { cards: [deck[0], deck[1]] };
      const target = { cards: [deck[2], deck[3]] };
      const room = { communityCards: i % 2 === 0 ? [] : [deck[4], deck[5], deck[6]] };
      const facts = buildPerceptionFacts(room, observer, target);
      const picked = pickPerceptionStatement(facts, {
        truthChance: PERCEPTION_CONFIG.truthChance,
        random,
        history: [],
      });
      if (!picked) continue;
      const fact = facts.find((entry) => entry.id === picked.factId);
      expect(fact).toBeTruthy();
      const sentenceTrue = picked.message === fact.yes ? Boolean(fact.truth) : !fact.truth;
      expect(sentenceTrue).toBe(picked.truthful);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(200);
  });

  test("先选类别再掷真假：点数类不会因为命题数量多而主导", () => {
    const { room, observer, target } = roomWith(["SA", "C2"], ["H9", "D5"]);
    const facts = buildPerceptionFacts(room, observer, target);
    const random = mulberry32(11);
    const counts = {};
    for (let i = 0; i < 2000; i += 1) {
      const picked = pickPerceptionStatement(facts, { truthChance: 0.75, random, history: [] });
      if (!picked) continue;
      counts[picked.category] = (counts[picked.category] || 0) + 1;
    }
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    expect(counts.RANK / total).toBeLessThan(0.28);
    expect(counts.HOLE_SUIT_MATCH / total).toBeGreaterThan(0.1);
    expect(counts.PAIR / total).toBeGreaterThan(0.1);
  });

  test("同手拒绝相同轴、等价命题和直接逻辑否定", () => {
    const { room, observer, target } = roomWith(["SA", "C2"], ["HA", "D9"]);
    const facts = buildPerceptionFacts(room, observer, target);
    const suited = facts.find((fact) => fact.id === "suited");
    const hasRed = facts.find((fact) => fact.id === "has-red");
    const hasHeart = facts.find((fact) => fact.id === "has-suit-H");
    expect(suited.truth).toBe(false);
    expect(hasRed.truth).toBe(true);
    expect(hasHeart.truth).toBe(true);

    const history = [{
      axis: "hole.suited",
      canonicalKey: "hole.suited",
      truthful: false,
      atoms: { "hole.suited": false },
    }];
    expect(canEmitFact(suited, false, history)).toBe(false);
    expect(canEmitFact(suited, true, history)).toBe(false);

    const noRedHistory = [{
      axis: "hole.hasRed",
      canonicalKey: "hole.hasRed",
      truthful: false,
      atoms: { "hole.hasRed": false, "hole.hasSuit.H": false, "hole.hasSuit.D": false },
    }];
    expect(canEmitFact(hasHeart, true, noRedHistory)).toBe(false);
    expect(canEmitFact(hasRed, true, noRedHistory)).toBe(false);

    const random = () => 0;
    const first = pickPerceptionStatement(facts, { truthChance: 1, random, history: [] });
    const second = pickPerceptionStatement(facts, { truthChance: 1, random, history: [first] });
    expect(first.axis).not.toBe(second.axis);
  });

  test("至少一张红牌与含红桃可以共存，因为不是完全等价", () => {
    const { room, observer, target } = roomWith(["SA", "C2"], ["HA", "D9"]);
    const facts = buildPerceptionFacts(room, observer, target);
    const hasRed = facts.find((fact) => fact.id === "has-red");
    const hasHeart = facts.find((fact) => fact.id === "has-suit-H");
    const history = [{
      axis: "hole.hasRed",
      canonicalKey: "hole.hasRed",
      truthful: true,
      atoms: { "hole.hasRed": true },
    }];
    expect(canEmitFact(hasHeart, true, history)).toBe(true);
    expect(canEmitFact(hasRed, true, history)).toBe(false);
  });

  test("抽中假极性时输出相反句子，而不是改抽真命题", () => {
    const { room, observer, target } = roomWith(["C2", "D7"], ["HA", "DA"]);
    const facts = buildPerceptionFacts(room, observer, target).filter((fact) => fact.id === "pocket-pair");
    expect(facts[0].truth).toBe(true);
    const picked = pickPerceptionStatement(facts, {
      truthChance: 0,
      random: () => 0.99,
      history: [],
    });
    expect(picked).toMatchObject({
      factId: "pocket-pair",
      truthful: false,
      message: "对手没有口袋对子。",
    });
  });
});
