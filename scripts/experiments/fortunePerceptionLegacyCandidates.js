/**
 * 历史校准候选，仅供对照实验。生产强运固定 soft-v1，感知固定 spec-25-50。
 */
const LEGACY_FORTUNE_CANDIDATES = Object.freeze([
  {
    id: "draft-current",
    holeChance: { min: 0.10, max: 0.30, chipWeight: 0.65, energyWeight: 0.35 },
    boardChance: { min: 0.08, max: 0.25, chipWeight: 0.60, energyWeight: 0.40 },
    resourceChance: { min: 0.08, max: 0.20, chipWeight: 0.55, energyWeight: 0.45 },
  },
  {
    id: "clutch",
    holeChance: { min: 0.08, max: 0.32, chipWeight: 0.80, energyWeight: 0.20 },
    boardChance: { min: 0.06, max: 0.22, chipWeight: 0.75, energyWeight: 0.25 },
    resourceChance: { min: 0.10, max: 0.24, chipWeight: 0.35, energyWeight: 0.65 },
  },
  {
    id: "conservative",
    holeChance: { min: 0.08, max: 0.22, chipWeight: 0.70, energyWeight: 0.30 },
    boardChance: { min: 0.05, max: 0.16, chipWeight: 0.65, energyWeight: 0.35 },
    resourceChance: { min: 0.12, max: 0.24, chipWeight: 0.40, energyWeight: 0.60 },
  },
]);

const LEGACY_PERCEPTION_CANDIDATES = Object.freeze([
  { id: "leaner-20-40", base: 0.20, max: 0.40, truth: 0.75 },
  { id: "mid-22-44", base: 0.22, max: 0.44, truth: 0.75 },
]);

module.exports = {
  LEGACY_FORTUNE_CANDIDATES,
  LEGACY_PERCEPTION_CANDIDATES,
};
