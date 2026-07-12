const SKILL_MODE = Object.freeze({
  OFF: "off",
  ABYSS: "abyss",
});

const SKILL_MODE_INFO = Object.freeze({
  [SKILL_MODE.OFF]: Object.freeze({
    id: SKILL_MODE.OFF,
    name: "技能关闭",
    description: "纯扑克对局，不启用深渊技能与能量系统。",
  }),
  [SKILL_MODE.ABYSS]: Object.freeze({
    id: SKILL_MODE.ABYSS,
    name: "深渊技能",
    description: "启用技能构筑、深渊能量、反制窗口与牌面干涉。",
  }),
});

function isSkillMode(value) {
  return value === SKILL_MODE.OFF || value === SKILL_MODE.ABYSS;
}

function normalizeSkillMode(value) {
  if (typeof value !== "string") return SKILL_MODE.OFF;
  const normalized = value.trim().toLowerCase();
  return isSkillMode(normalized) ? normalized : SKILL_MODE.OFF;
}

function isSkillEnabled(skillMode) {
  return normalizeSkillMode(skillMode) === SKILL_MODE.ABYSS;
}

module.exports = {
  SKILL_MODE,
  SKILL_MODE_INFO,
  isSkillMode,
  normalizeSkillMode,
  isSkillEnabled,
};
