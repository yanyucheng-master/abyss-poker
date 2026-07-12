const { SKILL_TAGS } = require("../skillConfig");

const SKILL_DEFINITIONS = Object.freeze({
  ABYSS_BREATH: Object.freeze({
    id: "ABYSS_BREATH",
    name: "深呼吸",
    load: 1,
    energyCost: 0,
    tags: Object.freeze([SKILL_TAGS.PASSIVE, SKILL_TAGS.RESOURCE, SKILL_TAGS.ONCE_PER_HAND]),
    allowedPhases: Object.freeze([]),
    maxUsesPerHand: 1,
    maxUsesPerGame: null,
    requiresActionTurn: false,
    canBeCountered: false,
    description:
      "若本手进入转牌时尚未发动主动技能，则本手结束后额外获得 1 点深渊能量（主动弃牌不触发）。",
  }),
  EMBER_RECYCLE: Object.freeze({
    id: "EMBER_RECYCLE",
    name: "余烬回收",
    load: 1,
    energyCost: 0,
    tags: Object.freeze([SKILL_TAGS.PASSIVE, SKILL_TAGS.RESOURCE, SKILL_TAGS.ONCE_PER_HAND]),
    allowedPhases: Object.freeze([]),
    maxUsesPerHand: 1,
    maxUsesPerGame: null,
    requiresActionTurn: false,
    canBeCountered: false,
    description: "你的主动技能被成功取消时，额外返还 1 点深渊能量（不恢复使用次数）。",
  }),
  ADVERSITY_CIRCUIT: Object.freeze({
    id: "ADVERSITY_CIRCUIT",
    name: "逆境回路",
    load: 2,
    energyCost: 0,
    tags: Object.freeze([SKILL_TAGS.PASSIVE, SKILL_TAGS.RESOURCE]),
    allowedPhases: Object.freeze([]),
    maxUsesPerHand: null,
    maxUsesPerGame: null,
    requiresActionTurn: false,
    canBeCountered: false,
    description:
      "一手开始时若筹码不超过对手的 40%，累计逆境计数；每累计两手额外获得 1 点能量。",
  }),
  ECHO_SCAN: Object.freeze({
    id: "ECHO_SCAN",
    name: "残响扫描",
    load: 2,
    energyCost: 2,
    tags: Object.freeze([
      SKILL_TAGS.ACTIVE,
      SKILL_TAGS.INFORMATION,
      SKILL_TAGS.ONCE_PER_HAND,
    ]),
    allowedPhases: Object.freeze(["flop", "turn"]),
    maxUsesPerHand: 1,
    maxUsesPerGame: null,
    requiresActionTurn: true,
    canBeCountered: true,
    description:
      "翻牌或转牌阶段：随机返回一条关于对手底牌的真实信息。对手知道技能发动但看不到结果。",
  }),
  PROBABILITY_CLOAK: Object.freeze({
    id: "PROBABILITY_CLOAK",
    name: "概率遮蔽",
    load: 2,
    energyCost: 2,
    tags: Object.freeze([SKILL_TAGS.ACTIVE, SKILL_TAGS.DEFENSE, SKILL_TAGS.ONCE_PER_HAND]),
    allowedPhases: Object.freeze(["pre_flop", "flop", "turn", "river"]),
    maxUsesPerHand: 1,
    maxUsesPerGame: null,
    requiresActionTurn: true,
    canBeCountered: true,
    description: "本下注阶段内，针对你的情报技能无法获得隐藏牌信息。",
  }),
  OVERLOAD_CORE: Object.freeze({
    id: "OVERLOAD_CORE",
    name: "过载核心",
    load: 2,
    energyCost: 2,
    tags: Object.freeze([SKILL_TAGS.ACTIVE, SKILL_TAGS.RESOURCE, SKILL_TAGS.ONCE_PER_GAME]),
    allowedPhases: Object.freeze(["pre_flop", "flop", "turn", "river"]),
    maxUsesPerHand: 1,
    maxUsesPerGame: 1,
    requiresActionTurn: true,
    canBeCountered: true,
    description:
      "本手下一个主动技能能量消耗 -3（最低 1）。下一手不能发动主动技能；未使用其他主动技能时折扣失效但代价仍保留。",
  }),
  SILENCE_ZONE: Object.freeze({
    id: "SILENCE_ZONE",
    name: "静默区",
    load: 3,
    energyCost: 3,
    tags: Object.freeze([SKILL_TAGS.ACTIVE, SKILL_TAGS.CONTROL, SKILL_TAGS.ONCE_PER_HAND]),
    allowedPhases: Object.freeze(["pre_flop", "flop", "turn", "river"]),
    maxUsesPerHand: 1,
    maxUsesPerGame: null,
    requiresActionTurn: true,
    canBeCountered: true,
    description: "本下注阶段内双方不能继续发动新的主动技能。不影响扑克操作与已结算技能。",
  }),
  NEURAL_INTERRUPT: Object.freeze({
    id: "NEURAL_INTERRUPT",
    name: "神经阻断",
    load: 3,
    energyCost: 3,
    tags: Object.freeze([SKILL_TAGS.REACTION, SKILL_TAGS.CONTROL]),
    allowedPhases: Object.freeze([]),
    maxUsesPerHand: 1,
    maxUsesPerGame: 2,
    requiresActionTurn: false,
    canBeCountered: false,
    description: "反制窗口内取消对手可被反制的主动技能。返还其消耗能量的 50%（向下取整，至少损失 1）。",
  }),
  MEMORY_REWRITE: Object.freeze({
    id: "MEMORY_REWRITE",
    name: "记忆重构",
    load: 3,
    energyCost: 5,
    tags: Object.freeze([
      SKILL_TAGS.ACTIVE,
      SKILL_TAGS.HOLE_EDIT,
      SKILL_TAGS.ONCE_PER_GAME,
    ]),
    allowedPhases: Object.freeze(["pre_flop"]),
    maxUsesPerHand: 1,
    maxUsesPerGame: 1,
    requiresActionTurn: true,
    requiresBeforeFirstAction: true,
    canBeCountered: true,
    description:
      "翻牌前第一次下注行动前：选择一张底牌移出本手，从既定牌堆顶部抽一张新牌。",
  }),
  FORK_OBSERVATION: Object.freeze({
    id: "FORK_OBSERVATION",
    name: "分岔观测",
    load: 4,
    energyCost: 6,
    tags: Object.freeze([
      SKILL_TAGS.ACTIVE,
      SKILL_TAGS.DECK_EDIT,
      SKILL_TAGS.ONCE_PER_GAME,
    ]),
    allowedPhases: Object.freeze(["before_turn", "before_river"]),
    maxUsesPerHand: 1,
    maxUsesPerGame: 1,
    requiresActionTurn: false,
    canBeCountered: true,
    description:
      "转牌或河牌发出前：私下查看即将发出的公共牌，选择保留或烧掉改发下一张。",
  }),
  NULLIFICATION_PROTOCOL: Object.freeze({
    id: "NULLIFICATION_PROTOCOL",
    name: "零化协议",
    load: 4,
    energyCost: 7,
    tags: Object.freeze([
      SKILL_TAGS.ACTIVE,
      SKILL_TAGS.BOARD_EDIT,
      SKILL_TAGS.ONCE_PER_GAME,
    ]),
    allowedPhases: Object.freeze(["flop", "turn"]),
    maxUsesPerHand: 1,
    maxUsesPerGame: 1,
    requiresActionTurn: true,
    canBeCountered: true,
    description:
      "选择一张已公开公共牌标记为零化：仍显示但不参与双方最佳牌型计算。",
  }),
  QUANTUM_HOLE_CARDS: Object.freeze({
    id: "QUANTUM_HOLE_CARDS",
    name: "量子底牌",
    load: 5,
    energyCost: 8,
    tags: Object.freeze([
      SKILL_TAGS.ACTIVE,
      SKILL_TAGS.HOLE_EDIT,
      SKILL_TAGS.ONCE_PER_GAME,
    ]),
    allowedPhases: Object.freeze(["pre_flop"]),
    maxUsesPerHand: 1,
    maxUsesPerGame: 1,
    requiresActionTurn: true,
    requiresBeforeFirstAction: true,
    canBeCountered: true,
    description:
      "翻牌前第一次下注行动前：从牌堆顶再抽一张，从三张中选两张作底牌，舍弃一张移出本手。",
  }),
});

const PUBLIC_SKILL_CATALOG = Object.freeze(
  Object.values(SKILL_DEFINITIONS).map((skill) =>
    Object.freeze({
      id: skill.id,
      name: skill.name,
      load: skill.load,
      energyCost: skill.energyCost,
      tags: skill.tags,
      allowedPhases: skill.allowedPhases,
      maxUsesPerHand: skill.maxUsesPerHand,
      maxUsesPerGame: skill.maxUsesPerGame,
      requiresActionTurn: skill.requiresActionTurn,
      requiresBeforeFirstAction: Boolean(skill.requiresBeforeFirstAction),
      canBeCountered: skill.canBeCountered,
      description: skill.description,
    })
  )
);

function getSkillDefinition(skillId) {
  return SKILL_DEFINITIONS[skillId] || null;
}

function listSkillDefinitions() {
  return PUBLIC_SKILL_CATALOG;
}

function isCardEditSkill(skill) {
  if (!skill) return false;
  return skill.tags.some((tag) =>
    [SKILL_TAGS.HOLE_EDIT, SKILL_TAGS.DECK_EDIT, SKILL_TAGS.BOARD_EDIT].includes(tag)
  );
}

function isActiveSkill(skill) {
  return Boolean(skill?.tags?.includes(SKILL_TAGS.ACTIVE));
}

function isPassiveSkill(skill) {
  return Boolean(skill?.tags?.includes(SKILL_TAGS.PASSIVE));
}

function isReactionSkill(skill) {
  return Boolean(skill?.tags?.includes(SKILL_TAGS.REACTION));
}

function isInformationSkill(skill) {
  return Boolean(skill?.tags?.includes(SKILL_TAGS.INFORMATION));
}

module.exports = {
  SKILL_DEFINITIONS,
  PUBLIC_SKILL_CATALOG,
  getSkillDefinition,
  listSkillDefinitions,
  isCardEditSkill,
  isActiveSkill,
  isPassiveSkill,
  isReactionSkill,
  isInformationSkill,
};
