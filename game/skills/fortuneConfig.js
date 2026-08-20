const { SKILL_CONFIG, FORTUNE_RULE } = require("../skillConfig");

/**
 * 当前推荐版本：soft-v1，状态以 skillConfig.FORTUNE_RULE / SKILL_RULE_FREEZE 为准。
 * 公式：mix = 筹码劣势 * chipWeight + 能量比例 * energyWeight，再在 min~max 线性插值。
 * draft / clutch / conservative 只存在于 scripts/experiments，生产路径不可选。
 */
const FORTUNE_CONFIG = Object.freeze({
  ...FORTUNE_RULE,
  rewriteCost: SKILL_CONFIG.FORTUNE_REWRITE_COST,
  minEnergy: SKILL_CONFIG.MIN_FORTUNE_ENERGY,
  nodes: Object.freeze(["HOLE_DEAL", "FLOP_DEAL", "TURN_DEAL", "RIVER_DEAL", "HAND_END_RESOURCE"]),
  holeChance: Object.freeze({
    min: 0.06,
    max: 0.20,
    chipWeight: 0.78,
    energyWeight: 0.22,
  }),
  boardChance: Object.freeze({
    min: 0.04,
    max: 0.12,
    chipWeight: 0.74,
    energyWeight: 0.26,
  }),
  resourceChance: Object.freeze({
    min: 0.12,
    max: 0.22,
    chipWeight: 0.40,
    energyWeight: 0.60,
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

let chanceOverride = null;

function setFortuneChanceOverride(next) {
  if (!next) {
    chanceOverride = null;
    return null;
  }
  chanceOverride = {
    holeChance: { ...FORTUNE_CONFIG.holeChance, ...(next.holeChance || {}) },
    boardChance: { ...FORTUNE_CONFIG.boardChance, ...(next.boardChance || {}) },
    resourceChance: { ...FORTUNE_CONFIG.resourceChance, ...(next.resourceChance || {}) },
  };
  return chanceOverride;
}

function chanceSpec(kind) {
  const key = `${kind}Chance`;
  return (chanceOverride && chanceOverride[key]) || FORTUNE_CONFIG[key];
}

function computeFortuneChance(kind, { disadvantage = 0, energy = 0, energyCap = SKILL_CONFIG.MAX_ABYSS_ENERGY } = {}) {
  const spec = chanceSpec(kind);
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
  setFortuneChanceOverride,
  isStrongHole,
  scoreHeroBoard,
  energyRatio,
};
