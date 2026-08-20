const SKILL_CONFIG = Object.freeze({
  MAX_SKILL_LOAD: 8,
  MAX_EQUIPPED_SKILLS: 4,
  MIN_EQUIPPED_SKILLS: 1,
  INITIAL_ABYSS_ENERGY: 4,
  MAX_ABYSS_ENERGY: 8,
  DESTINY_MAX_ABYSS_ENERGY: 10,
  PUBLIC_ENERGY_DISPLAY_CAP: 8,
  MIN_FORTUNE_ENERGY: -4,
  ENERGY_WINNER_GAIN: 0,
  ENERGY_LOSER_GAIN: 1,
  ENERGY_TIE_GAIN: 0,
  FEAR_CONTRIBUTION_CAP: 500,
  DESPERATION_CHIP_THRESHOLD: 200,
  DESPERATION_WIN_MULTIPLIER: 3,
  BLOOD_BATTLE_MULTIPLIER: 2,
  DEAD_END_FOLD_MULTIPLIER: 3,
  PROTOCOL_WIN_MULTIPLIER: 2,
  RECYCLE_REFUND_RATE: 0.5,
  COUNTER_UNUSED_REFUND: 1,
  DEEP_BREATH_RESTORE: 2,
  PERCEPTION_BASE_CHANCE: 0.25,
  PERCEPTION_MAX_CHANCE: 0.5,
  PERCEPTION_TRUTH_CHANCE: 0.75,
  PERCEPTION_MAX_TRIGGERS_PER_HAND: 3,
  FORTUNE_REWRITE_COST: 3,
  TOP_SECRET_COST: 3,
  INTEL_COST: 4,
  NULLIFY_BOARD_COST: 6,
  NULLIFY_HOLE_COST: 7,
  LOAN_ENERGY_COST: 2,
  LOAN_CHIP_TAKE: 100,
  LOAN_CHIP_REPAY: 150,
  LOAN_CHIP_MAX_USES_PER_HAND: 2,
  LOAN_ENERGY_GAIN: 5,
  LOAN_ENERGY_REPAY: 6,
  LOAN_ENERGY_MAX_USES_PER_HAND: 1,
  PROBE_FOLD_BONUS: 50,
  ENDGAME_ENERGY_COST: 8,
  ALERT_CHANCES: Object.freeze([0.10, 0.25, 0.40, 0.55, 0.70, 0.85, 1]),
  ALERT_MESSAGE: "你隐约察觉到对手似乎进行了秘密行动。",
});

const SKILL_TAGS = Object.freeze({
  PASSIVE: "PASSIVE",
  ACTIVE: "ACTIVE",
  INFORMATION: "INFORMATION",
  DEFENSE: "DEFENSE",
  RESOURCE: "RESOURCE",
  CONTROL: "CONTROL",
  SETTLEMENT: "SETTLEMENT",
  HOLE_EDIT: "HOLE_EDIT",
  DECK_EDIT: "DECK_EDIT",
  BOARD_EDIT: "BOARD_EDIT",
  SECRET: "SECRET",
  ONCE_PER_HAND: "ONCE_PER_HAND",
  PROTOCOL: "PROTOCOL",
});

const CARD_EDIT_TAGS = Object.freeze([
  SKILL_TAGS.HOLE_EDIT,
  SKILL_TAGS.DECK_EDIT,
  SKILL_TAGS.BOARD_EDIT,
]);

/**
 * 感知核心概率已冻结为 spec-25-50。
 * 触发：四节点独立判定，均势 25% 线性插值到全劣 50%；每手最多成功 3 次。
 * 真假：先选信息类别，再 75% 真 / 25% 假，不从大小不一的真/假池里抽。
 * 信息池命题仍允许后续扩充，但不要改这组概率。
 */
const PERCEPTION_CONFIG = Object.freeze({
  status: "FROZEN_V1",
  variant: "spec-25-50",
  frozenAt: "2026-08-20",
  freezeBasis: Object.freeze([
    "trigger 25-50",
    "truth 75/25",
    "four nodes",
    "max 3 per hand",
    "category-then-truth",
  ]),
  baseChance: 0.25,
  maxChance: 0.5,
  truthChance: 0.75,
  maxTriggersPerHand: 3,
  nodes: Object.freeze(["pre_flop", "flop", "turn", "river"]),
});

/**
 * 强运规则冻结登记。具体概率表在 fortuneConfig.soft-v1，此处只作为规则层状态源。
 * 未解冻前不要改 soft-v1 数值、改牌费用或负债下限。
 */
const FORTUNE_RULE = Object.freeze({
  status: "FROZEN_V1",
  variant: "soft-v1",
  recommended: true,
  frozenAt: "2026-08-20",
  freezeBasis: Object.freeze([
    "single-hand causal equity",
    "rewrite frequency",
    "energy negative feedback",
    "debt experience",
    "dynamic stacks",
    "fold-policy matches",
  ]),
});

/**
 * 生产路径冻结总表。引擎与测试应读这里的 status/variant，而不是散落注释。
 */
const SKILL_RULE_FREEZE = Object.freeze({
  PERCEPTION: Object.freeze({
    skillId: "PERCEPTION",
    status: PERCEPTION_CONFIG.status,
    variant: PERCEPTION_CONFIG.variant,
    frozenAt: PERCEPTION_CONFIG.frozenAt,
    freezeBasis: PERCEPTION_CONFIG.freezeBasis,
  }),
  FORTUNE: Object.freeze({
    skillId: "FORTUNE",
    status: FORTUNE_RULE.status,
    variant: FORTUNE_RULE.variant,
    frozenAt: FORTUNE_RULE.frozenAt,
    freezeBasis: FORTUNE_RULE.freezeBasis,
  }),
});

const PROTOCOL_CATEGORIES = Object.freeze({
  HIGH_CARD: 1,
  PAIR: 2,
  TWO_PAIR: 3,
  TRIPS: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  QUADS: 8,
  STRAIGHT_FLUSH: 9,
});

module.exports = {
  SKILL_CONFIG,
  PERCEPTION_CONFIG,
  FORTUNE_RULE,
  SKILL_RULE_FREEZE,
  SKILL_TAGS,
  CARD_EDIT_TAGS,
  PROTOCOL_CATEGORIES,
};
