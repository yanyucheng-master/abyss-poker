const { SKILL_TAGS, CARD_EDIT_TAGS } = require("../skillConfig");

const ACTIVE_STREETS = Object.freeze(["pre_flop", "flop", "turn", "river"]);
const PRE_RIVER_STREETS = Object.freeze(["pre_flop", "flop", "turn"]);

function freezeSkill(skill) {
  return Object.freeze({
    maxUsesPerHand: null,
    maxUsesPerGame: null,
    requiresActionTurn: false,
    requiresFirstSkillEvent: false,
    canBeCountered: false,
    visibility: "PUBLIC",
    allowedPhases: Object.freeze([]),
    ...skill,
    tags: Object.freeze(skill.tags || []),
    allowedPhases: Object.freeze(skill.allowedPhases || []),
  });
}

const SKILL_DEFINITIONS = Object.freeze({
  DEEP_BREATH: freezeSkill({
    id: "DEEP_BREATH", name: "深呼吸", load: 1, energyCost: 1,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.RESOURCE, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true,
    description: "本人下注行动回合发动并支付 1 能量。若本手之后没有再发生你的技能事件，手牌结束时恢复 2 能量。仅在当前能量不高于 4 时可用。",
  }),
  RECYCLE: freezeSkill({
    id: "RECYCLE", name: "回收利用", load: 1, energyCost: 0,
    tags: [SKILL_TAGS.PASSIVE, SKILL_TAGS.RESOURCE],
    description: "每手一次：你已合法支付能量的技能因反制或结算时状态失效而失败时，恢复 1 能量。非法请求、主动取消与网络重发不触发。",
  }),
  INTIMIDATION: freezeSkill({
    id: "INTIMIDATION", name: "恐吓", load: 3, energyCost: 6,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.CONTROL, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true,
    description: "本手双方不能弃牌，且每人的本手累计投入上限为 500。若任一方已投入超过 500，不能发动。超时将优先过牌，否则自动跟注。",
  }),
  DESPERATION: freezeSkill({
    id: "DESPERATION", name: "绝境", load: 2, energyCost: 0,
    tags: [SKILL_TAGS.PASSIVE, SKILL_TAGS.SETTLEMENT],
    description: "手牌开始时若你的筹码低于双方总筹码的 10%，本手获胜时净赢取筹码乘 1.5，并额外恢复 1 能量。",
  }),
  BLOOD_BATTLE: freezeSkill({
    id: "BLOOD_BATTLE", name: "血战", load: 2, energyCost: 3,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.SETTLEMENT, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true,
    description: "本手最终净筹码转移乘 2。双方均发动时相乘为 4 倍；可与绝境、绝路继续叠加，实际支付仍受败者剩余筹码限制。",
  }),
  DEFENSE: freezeSkill({
    id: "DEFENSE", name: "防守", load: 2, energyCost: 3,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.DEFENSE, SKILL_TAGS.SETTLEMENT, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true,
    description: "必须在本下注阶段首次面对对手主动加注前发动。若你未弃牌且最终输掉本手，净损失减半。",
  }),
  PERCEPTION: freezeSkill({
    id: "PERCEPTION", name: "感知", load: 3, energyCost: 0,
    tags: [SKILL_TAGS.PASSIVE, SKILL_TAGS.INFORMATION, SKILL_TAGS.SECRET], visibility: "SECRET",
    description: "底牌、翻牌、转牌、河牌四个节点各判定一次，每手最多触发 3 次。触发率随筹码劣势由 15% 升至 40%；每条私有感知有 75% 概率为真。",
  }),
  INTEL_ONE: freezeSkill({
    id: "INTEL_ONE", name: "情报壹", load: 3, energyCost: 3,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.INFORMATION, SKILL_TAGS.SECRET, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, visibility: "SECRET",
    description: "精确查看一张随机对手底牌，或指定一张尚未发出的公共牌。公共牌未知位仅剩 1 张时不能选择未来公共牌；绝密可阻断底牌查看。",
  }),
  TOP_SECRET: freezeSkill({
    id: "TOP_SECRET", name: "绝密", load: 2, energyCost: 2,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.DEFENSE, SKILL_TAGS.SECRET, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, visibility: "SECRET",
    description: "从现在起至本手结束，你的底牌不能被查看或被其他技能交换。只保护未来事件，不撤销已经泄露的情报。",
  }),
  COUNTER: freezeSkill({
    id: "COUNTER", name: "反制", load: 4, energyCost: 6,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.CONTROL, SKILL_TAGS.SECRET, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ["pre_flop"], maxUsesPerHand: 1, requiresActionTurn: true, visibility: "SECRET",
    description: "翻牌前秘密布置。对手下一次尝试主动技能时仍支付其能量，但技能失败，且对手本手之后不能再触发任何技能。反制可截断对方正在布置的反制。",
  }),
  FAIRNESS: freezeSkill({
    id: "FAIRNESS", name: "公平", load: 4, energyCost: 4,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.CONTROL, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, requiresFirstSkillEvent: true,
    description: "只能作为你本手的第一个技能事件，并严格限本人下注行动回合发动。此后双方不能发动或触发新技能，也不再获得本手结束能量；已经生效的效果保留。",
  }),
  CHEAT: freezeSkill({
    id: "CHEAT", name: "千术", load: 5, energyCost: 6,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.HOLE_EDIT, SKILL_TAGS.DECK_EDIT, SKILL_TAGS.BOARD_EDIT, SKILL_TAGS.SECRET, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: PRE_RIVER_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, visibility: "MIXED",
    description: "指定自己一张底牌，与对手指定底牌、已公开公共牌、尚未发出的公共牌或下一张有效发牌交换。河牌全部公布后绝对不可用；涉及隐藏区的牌值保持私密。",
  }),
  DEAD_END: freezeSkill({
    id: "DEAD_END", name: "绝路", load: 5, energyCost: 5,
    tags: [SKILL_TAGS.PASSIVE, SKILL_TAGS.CONTROL, SKILL_TAGS.SETTLEMENT],
    description: "当你实际进入 All In 时自动发动：对手本手不能再触发技能；若对手随后弃牌，你的净赢取筹码乘 3。可与血战叠加。",
  }),
  CLAIRVOYANCE: freezeSkill({
    id: "CLAIRVOYANCE", name: "灵视", load: 3, energyCost: 2,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.INFORMATION, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true,
    description: "私下读取对手当前真实能量，以及对手本手此前已经结算的技能事件（包括原本隐藏的技能）。",
  }),
  NULLIFICATION: freezeSkill({
    id: "NULLIFICATION", name: "零化", load: 5, energyCost: 6,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.BOARD_EDIT, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ["flop", "turn", "river"], maxUsesPerHand: 1, requiresActionTurn: true,
    description: "精确指定一张已公开或尚未发出的公共牌，使其不参与双方最佳五张牌计算。即使五张公共牌已经全部公布仍可发动；双方效果可同时存在。",
  }),
  FORTUNE: freezeSkill({
    id: "FORTUNE", name: "强运", load: 6, energyCost: 4,
    tags: [SKILL_TAGS.PASSIVE, SKILL_TAGS.HOLE_EDIT, SKILL_TAGS.SECRET], visibility: "SECRET",
    description: "发牌前按筹码劣势以 10%–30% 概率触发，将底牌改为口袋对子或同花连张。按 78:48 个真实组合加权；只有扣费后能量不低于 −4 才会判定。",
  }),
  DESTINY: freezeSkill({
    id: "DESTINY", name: "天命", load: 7, energyCost: 8,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.DECK_EDIT, SKILL_TAGS.SECRET],
    allowedPhases: PRE_RIVER_STREETS, maxUsesPerHand: null, maxUsesPerGame: null, requiresActionTurn: true, visibility: "SECRET",
    description: "精确指定一张牌成为未来河牌。没有手内冷却或整场次数限制，仅受 8 能量限制；若目标牌当前在对手底牌中，支付后失败。",
  }),
});

const PUBLIC_SKILL_CATALOG = Object.freeze(Object.values(SKILL_DEFINITIONS).map((skill) => Object.freeze({
  id: skill.id, name: skill.name, load: skill.load, energyCost: skill.energyCost,
  tags: skill.tags, allowedPhases: skill.allowedPhases,
  maxUsesPerHand: skill.maxUsesPerHand, maxUsesPerGame: skill.maxUsesPerGame,
  requiresActionTurn: skill.requiresActionTurn, requiresFirstSkillEvent: skill.requiresFirstSkillEvent,
  visibility: skill.visibility, description: skill.description,
})));

function getSkillDefinition(skillId) { return SKILL_DEFINITIONS[String(skillId || "").trim().toUpperCase()] || null; }
function listSkillDefinitions() { return PUBLIC_SKILL_CATALOG; }
function isCardEditSkill(skill) { return Boolean(skill?.tags?.some((tag) => CARD_EDIT_TAGS.includes(tag))); }
function isActiveSkill(skill) { return Boolean(skill?.tags?.includes(SKILL_TAGS.ACTIVE)); }
function isPassiveSkill(skill) { return Boolean(skill?.tags?.includes(SKILL_TAGS.PASSIVE)); }
function isInformationSkill(skill) { return Boolean(skill?.tags?.includes(SKILL_TAGS.INFORMATION)); }
module.exports = { SKILL_DEFINITIONS, PUBLIC_SKILL_CATALOG, getSkillDefinition, listSkillDefinitions,
  isCardEditSkill, isActiveSkill, isPassiveSkill, isInformationSkill };
