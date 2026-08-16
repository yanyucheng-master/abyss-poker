const { SKILL_CONFIG } = require("../skillConfig");
const { getSkillDefinition, listSkillDefinitions } = require("./definitions");

function createEmptySkillRuntime() {
  return {
    equippedSkillIds: [],
    loadoutConfirmed: false,
    abyssEnergy: 0,
    visibleAbyssEnergy: 0,
    skillUsesThisHand: {},
    skillUsesThisGame: {},
    skillEventsThisHand: 0,
    lockedThisHand: false,
    lockReason: null,
    breathArmed: false,
    breathBroken: false,
    recycleUsedThisHand: false,
    topSecretActive: false,
    counterArmed: false,
    desperationActive: false,
    bloodBattleActive: false,
    defenseActive: false,
    facedAggressionThisPhase: false,
    deadEndActive: false,
    perceptionTriggerCount: 0,
    perceptionCheckedNodes: [],
    fortuneTriggered: false,
    foldedThisHand: false,
    handStartChips: 0,
    privateResults: [],
  };
}

function createRoomSkillState() {
  return {
    processedRequestIds: new Set(),
    skillActionLog: [],
    transformations: [],
    burnedCards: [],
    removedCards: [],
    nullifications: [],
    nullifiedCommunityCardIds: [],
    noFoldActive: false,
    contributionCap: null,
    fairnessActive: false,
  };
}

function resetPlayerSkillsForGame(player) {
  const previous = player.skillRuntime || createEmptySkillRuntime();
  player.skillRuntime = {
    ...createEmptySkillRuntime(),
    equippedSkillIds: [...(previous.equippedSkillIds || [])],
    loadoutConfirmed: Boolean(previous.loadoutConfirmed),
    abyssEnergy: SKILL_CONFIG.INITIAL_ABYSS_ENERGY,
    visibleAbyssEnergy: SKILL_CONFIG.INITIAL_ABYSS_ENERGY,
  };
}

function resetPlayerSkillsForHand(player) {
  if (!player.skillRuntime) return;
  const runtime = player.skillRuntime;
  runtime.skillUsesThisHand = {};
  runtime.skillEventsThisHand = 0;
  runtime.lockedThisHand = false;
  runtime.lockReason = null;
  runtime.breathArmed = false;
  runtime.breathBroken = false;
  runtime.recycleUsedThisHand = false;
  runtime.topSecretActive = false;
  runtime.counterArmed = false;
  runtime.desperationActive = false;
  runtime.bloodBattleActive = false;
  runtime.defenseActive = false;
  runtime.facedAggressionThisPhase = false;
  runtime.deadEndActive = false;
  runtime.perceptionTriggerCount = 0;
  runtime.perceptionCheckedNodes = [];
  runtime.fortuneTriggered = false;
  runtime.foldedThisHand = false;
  runtime.handStartChips = Number(player.chips) || 0;
  runtime.privateResults = [];
}

function resetRoomSkillsForHand(room) {
  room.skillState = room.skillState || createRoomSkillState();
  const processed = room.skillState.processedRequestIds instanceof Set
    ? room.skillState.processedRequestIds
    : new Set();
  Object.assign(room.skillState, createRoomSkillState(), { processedRequestIds: processed });
  // Request ids only need replay protection for the current room session.
  if (processed.size > 2048) processed.clear();
}

function validateLoadout(skillIds) {
  if (!Array.isArray(skillIds)) return { ok: false, error: "技能构筑格式错误" };
  if (skillIds.length < SKILL_CONFIG.MIN_EQUIPPED_SKILLS) {
    return { ok: false, error: `至少装备 ${SKILL_CONFIG.MIN_EQUIPPED_SKILLS} 个技能` };
  }
  if (skillIds.length > SKILL_CONFIG.MAX_EQUIPPED_SKILLS) {
    return { ok: false, error: `最多装备 ${SKILL_CONFIG.MAX_EQUIPPED_SKILLS} 个技能` };
  }
  const unique = new Set();
  const normalized = [];
  let totalLoad = 0;
  for (const rawId of skillIds) {
    if (typeof rawId !== "string") return { ok: false, error: "技能 ID 格式错误" };
    const skillId = rawId.trim().toUpperCase();
    const skill = getSkillDefinition(skillId);
    if (!skill) return { ok: false, error: `未知技能：${rawId}` };
    if (unique.has(skillId)) return { ok: false, error: "不能重复装备同名技能" };
    unique.add(skillId);
    normalized.push(skillId);
    totalLoad += skill.load;
  }
  if (totalLoad > SKILL_CONFIG.MAX_SKILL_LOAD) {
    return { ok: false, error: `技能负载不能超过 ${SKILL_CONFIG.MAX_SKILL_LOAD}` };
  }
  return { ok: true, skillIds: normalized, totalLoad };
}

function getLoadoutLoad(skillIds = []) {
  return skillIds.reduce((sum, id) => sum + (getSkillDefinition(id)?.load || 0), 0);
}

function pickDefaultBotLoadout() {
  return ["DEEP_BREATH", "BLOOD_BATTLE", "DEFENSE", "DESPERATION"];
}

function gainEnergy(player, amount) {
  const runtime = player?.skillRuntime;
  const requested = Math.max(0, Math.floor(Number(amount) || 0));
  if (!runtime || requested <= 0) return 0;
  const before = runtime.abyssEnergy;
  runtime.abyssEnergy = Math.min(SKILL_CONFIG.MAX_ABYSS_ENERGY, before + requested);
  return runtime.abyssEnergy - before;
}

function spendEnergy(player, amount, { allowDebt = false, minimum = 0 } = {}) {
  const runtime = player?.skillRuntime;
  const cost = Math.max(0, Math.floor(Number(amount) || 0));
  if (!runtime) return false;
  const floor = allowDebt ? Number(minimum) : 0;
  if (runtime.abyssEnergy - cost < floor) return false;
  runtime.abyssEnergy -= cost;
  return true;
}

function getEffectiveEnergyCost(_player, skill) {
  return Math.max(0, Number(skill?.energyCost) || 0);
}

function syncVisibleEnergy(player) {
  if (!player?.skillRuntime) return;
  player.skillRuntime.visibleAbyssEnergy = player.skillRuntime.abyssEnergy;
}

function hasEquipped(player, skillId) {
  return Boolean(player?.skillRuntime?.equippedSkillIds?.includes(skillId));
}

function getPublicSkillSummary(player) {
  const runtime = player?.skillRuntime || createEmptySkillRuntime();
  return {
    loadoutConfirmed: Boolean(runtime.loadoutConfirmed),
    abyssEnergy: Number(runtime.visibleAbyssEnergy) || 0,
    buildHidden: true,
    lockedThisHand: Boolean(runtime.lockedThisHand),
    publicEffects: [
      runtime.bloodBattleActive ? "BLOOD_BATTLE" : null,
      runtime.defenseActive ? "DEFENSE" : null,
      runtime.deadEndActive ? "DEAD_END" : null,
    ].filter(Boolean),
  };
}

function getSelfSkillSummary(player) {
  const runtime = player?.skillRuntime || createEmptySkillRuntime();
  return {
    equippedSkillIds: [...(runtime.equippedSkillIds || [])],
    loadoutConfirmed: Boolean(runtime.loadoutConfirmed),
    abyssEnergy: Number(runtime.abyssEnergy) || 0,
    visibleAbyssEnergy: Number(runtime.visibleAbyssEnergy) || 0,
    skillUsesThisHand: { ...(runtime.skillUsesThisHand || {}) },
    skillUsesThisGame: { ...(runtime.skillUsesThisGame || {}) },
    skillEventsThisHand: Number(runtime.skillEventsThisHand) || 0,
    lockedThisHand: Boolean(runtime.lockedThisHand),
    lockReason: runtime.lockReason || null,
    breathArmed: Boolean(runtime.breathArmed),
    topSecretActive: Boolean(runtime.topSecretActive),
    counterArmed: Boolean(runtime.counterArmed),
    desperationActive: Boolean(runtime.desperationActive),
    bloodBattleActive: Boolean(runtime.bloodBattleActive),
    defenseActive: Boolean(runtime.defenseActive),
    facedAggressionThisPhase: Boolean(runtime.facedAggressionThisPhase),
    deadEndActive: Boolean(runtime.deadEndActive),
  };
}

function getPublicRoomSkillSnapshot(room) {
  const state = room?.skillState || createRoomSkillState();
  const visibleCodes = new Set((room?.communityCards || []).map((card) => card?.code));
  return {
    noFoldActive: Boolean(state.noFoldActive),
    contributionCap: state.contributionCap == null ? null : Number(state.contributionCap),
    fairnessActive: Boolean(state.fairnessActive),
    nullifiedCommunityCardIds: (state.nullifications || [])
      .filter((entry) => entry.revealed || visibleCodes.has(entry.cardCode))
      .map((entry) => entry.cardCode),
    recentLog: (state.skillActionLog || [])
      .filter((entry) => !entry.secret)
      .slice(-8)
      .map(({ at, skillId, casterId, status, publicSummary }) => ({
        at, skillId, casterId, status, publicSummary,
      })),
  };
}

function markSkillUse(player, skillId) {
  const runtime = player.skillRuntime;
  runtime.skillUsesThisHand[skillId] = (runtime.skillUsesThisHand[skillId] || 0) + 1;
  runtime.skillUsesThisGame[skillId] = (runtime.skillUsesThisGame[skillId] || 0) + 1;
}

function markSkillEvent(player, skillId) {
  const runtime = player?.skillRuntime;
  if (!runtime) return;
  if (runtime.breathArmed && skillId !== "DEEP_BREATH") runtime.breathBroken = true;
  runtime.skillEventsThisHand += 1;
}

function getRemainingUses(player, skill) {
  const runtime = player?.skillRuntime || createEmptySkillRuntime();
  const handUsed = runtime.skillUsesThisHand[skill.id] || 0;
  const gameUsed = runtime.skillUsesThisGame[skill.id] || 0;
  return {
    handLeft: skill.maxUsesPerHand == null ? null : Math.max(0, skill.maxUsesPerHand - handUsed),
    gameLeft: skill.maxUsesPerGame == null ? null : Math.max(0, skill.maxUsesPerGame - gameUsed),
  };
}

module.exports = {
  createEmptySkillRuntime, createRoomSkillState, resetPlayerSkillsForGame,
  resetPlayerSkillsForHand, resetRoomSkillsForHand,
  validateLoadout, getLoadoutLoad, pickDefaultBotLoadout, gainEnergy, spendEnergy,
  getEffectiveEnergyCost, syncVisibleEnergy, hasEquipped,
  getPublicSkillSummary, getSelfSkillSummary, getPublicRoomSkillSnapshot,
  markSkillUse, markSkillEvent, getRemainingUses, listSkillDefinitions,
  getSkillDefinition,
};
