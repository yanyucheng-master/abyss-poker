const { SKILL_CONFIG } = require("../skillConfig");

/**
 * 强运数值与事件池仍未最终定稿。
 * 本模块只提供可替换策略：概率函数、底牌改善算法、幸运节点列表。
 * 下面的默认值全部标记为 DRAFT，禁止当成正式平衡结论。
 */
const FORTUNE_CONFIG = Object.freeze({
  status: "DRAFT_UNCONFIRMED",
  rewriteCost: SKILL_CONFIG.FORTUNE_REWRITE_COST,
  minEnergy: SKILL_CONFIG.MIN_FORTUNE_ENERGY,
  nodes: Object.freeze(["HOLE_DEAL", "FLOP_DEAL", "TURN_DEAL", "RIVER_DEAL", "HAND_END_RESOURCE"]),
  holeChance: Object.freeze({
    min: 0.1,
    max: 0.3,
    chipWeight: 0.65,
    energyWeight: 0.35,
  }),
  boardChance: Object.freeze({
    min: 0.08,
    max: 0.25,
    chipWeight: 0.6,
    energyWeight: 0.4,
  }),
  resourceChance: Object.freeze({
    min: 0.08,
    max: 0.2,
    chipWeight: 0.55,
    energyWeight: 0.45,
  }),
  strongHole: Object.freeze({
    pocketPair: true,
    suitedConnector: true,
    bothBroadway: true,
    suitedBothTenPlus: true,
  }),
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildFortuneCombos() {
  const suits = ["S", "H", "C", "D"];
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
  const combos = [];
  for (const rank of ranks) {
    for (let first = 0; first < suits.length - 1; first += 1) {
      for (let second = first + 1; second < suits.length; second += 1) {
        combos.push({ type: "POCKET_PAIR", codes: [suits[first] + rank, suits[second] + rank] });
      }
    }
  }
  for (let rankIndex = 0; rankIndex < ranks.length - 1; rankIndex += 1) {
    for (const suit of suits) {
      combos.push({
        type: "SUITED_CONNECTOR",
        codes: [suit + ranks[rankIndex], suit + ranks[rankIndex + 1]],
      });
    }
  }
  return Object.freeze(combos.map((combo) => Object.freeze({
    ...combo,
    codes: Object.freeze(combo.codes),
  })));
}

const FORTUNE_COMBOS = buildFortuneCombos();

function energyRatio(energy, cap = SKILL_CONFIG.MAX_ABYSS_ENERGY) {
  const floor = FORTUNE_CONFIG.minEnergy;
  const ceiling = Math.max(floor + 1, Number(cap) || SKILL_CONFIG.MAX_ABYSS_ENERGY);
  return clamp((Number(energy) - floor) / (ceiling - floor), 0, 1);
}

function computeFortuneChance(kind, { disadvantage = 0, energy = 0, energyCap = SKILL_CONFIG.MAX_ABYSS_ENERGY } = {}) {
  const spec = FORTUNE_CONFIG[`${kind}Chance`];
  if (!spec) return 0;
  const mix = clamp(disadvantage, 0, 1) * spec.chipWeight + energyRatio(energy, energyCap) * spec.energyWeight;
  return clamp(spec.min + (spec.max - spec.min) * mix, spec.min, spec.max);
}

function isStrongHole(cards = [], rules = FORTUNE_CONFIG.strongHole) {
  if (!Array.isArray(cards) || cards.length < 2) return false;
  const [a, b] = cards;
  if (!a || !b) return false;
  const suited = a.suit === b.suit;
  const gap = Math.abs((Number(a.value) || 0) - (Number(b.value) || 0));
  if (rules.pocketPair && a.rank === b.rank) return true;
  if (rules.suitedConnector && suited && gap === 1) return true;
  if (rules.bothBroadway && a.value >= 11 && b.value >= 11) return true;
  if (rules.suitedBothTenPlus && suited && a.value >= 10 && b.value >= 10) return true;
  return false;
}

function scoreHeroBoard(heroCards, board) {
  const ranks = [...heroCards, ...board].map((card) => card?.rank).filter(Boolean);
  const suits = [...heroCards, ...board].map((card) => card?.suit).filter(Boolean);
  const heroRanks = new Set(heroCards.map((card) => card?.rank));
  const pairHits = board.filter((card) => heroRanks.has(card?.rank)).length;
  const suitCounts = suits.reduce((map, suit) => {
    map[suit] = (map[suit] || 0) + 1;
    return map;
  }, {});
  const flushMax = Math.max(0, ...Object.values(suitCounts));
  const uniqueRanks = new Set(ranks).size;
  return pairHits * 40 + flushMax * 12 + (7 - uniqueRanks) * 3;
}

module.exports = {
  FORTUNE_CONFIG,
  FORTUNE_COMBOS,
  computeFortuneChance,
  isStrongHole,
  scoreHeroBoard,
  energyRatio,
};
