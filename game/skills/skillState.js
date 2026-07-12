const { SKILL_CONFIG } = require("../skillConfig");
const { getSkillDefinition, listSkillDefinitions, isCardEditSkill } = require("./definitions");

function createEmptySkillRuntime() {
  return {
    equippedSkillIds: [],
    loadoutConfirmed: false,
    abyssEnergy: 0,
    skillUsesThisHand: {},
    skillUsesThisGame: {},
    activeSkillsUsedThisPhase: 0,
    activeSkillsUsedThisHand: 0,
    successfulCardEditThisHand: false,
    overloadDiscount: null,
    nextHandSkillLocked: false,
    pendingOverloadLock: false,
    adversityCounter: 0,
    passiveEnergyGainedThisHand: 0,
    statusEffects: [],
    hasUsedActiveThisHand: false,
    foldedThisHand: false,
    breathEligible: false,
    firstStreetActionTaken: false,
    emberRecycleUsedThisHand: false,
  };
}

function createRoomSkillState() {
  return {
    pendingSkill: null,
    reactionWindow: null,
    skillChoice: null,
    preDealWindow: null,
    skillActionLog: [],
    burnedCards: [],
    removedCards: [],
    nullifiedCommunityCardIds: [],
    silenceActive: false,
    processedRequestIds: new Set(),
  };
}

function resetPlayerSkillsForGame(player) {
  const equipped = [...(player.skillRuntime?.equippedSkillIds || [])];
  const confirmed = Boolean(player.skillRuntime?.loadoutConfirmed);
  player.skillRuntime = {
    ...createEmptySkillRuntime(),
    equippedSkillIds: equipped,
    loadoutConfirmed: confirmed,
    abyssEnergy: SKILL_CONFIG.INITIAL_ABYSS_ENERGY,
  };
}

function resetPlayerSkillsForHand(player) {
  const runtime = player.skillRuntime;
  if (!runtime) return;
  runtime.skillUsesThisHand = {};
  runtime.activeSkillsUsedThisPhase = 0;
  runtime.activeSkillsUsedThisHand = 0;
  runtime.successfulCardEditThisHand = false;
  runtime.passiveEnergyGainedThisHand = 0;
  runtime.hasUsedActiveThisHand = false;
  runtime.foldedThisHand = false;
  runtime.breathEligible = false;
  runtime.firstStreetActionTaken = false;
  runtime.emberRecycleUsedThisHand = false;
  runtime.statusEffects = (runtime.statusEffects || []).filter(
    (effect) => effect.persistAcrossHands
  );
  if (runtime.pendingOverloadLock) {
    runtime.nextHandSkillLocked = true;
    runtime.pendingOverloadLock = false;
  } else {
    runtime.nextHandSkillLocked = false;
  }
  runtime.overloadDiscount = null;
}

function resetRoomSkillsForHand(room) {
  room.skillState = room.skillState || createRoomSkillState();
  clearSkillTimers(room);
  room.skillState.pendingSkill = null;
  room.skillState.reactionWindow = null;
  room.skillState.skillChoice = null;
  room.skillState.preDealWindow = null;
  room.skillState.burnedCards = [];
  room.skillState.removedCards = [];
  room.skillState.nullifiedCommunityCardIds = [];
  room.skillState.silenceActive = false;
  room.skillState.skillActionLog = [];
}

function clearSkillTimers(room) {
  const state = room.skillState;
  if (!state) return;
  for (const key of ["reactionTimer", "choiceTimer", "preDealTimer"]) {
    if (state[key]) {
      clearTimeout(state[key]);
      state[key] = null;
    }
  }
}

function validateLoadout(skillIds) {
  if (!Array.isArray(skillIds)) {
    return { ok: false, error: "技能构筑格式错误" };
  }
  if (skillIds.length < SKILL_CONFIG.MIN_EQUIPPED_SKILLS) {
    return { ok: false, error: `至少装备 ${SKILL_CONFIG.MIN_EQUIPPED_SKILLS} 个技能` };
  }
  if (skillIds.length > SKILL_CONFIG.MAX_EQUIPPED_SKILLS) {
    return { ok: false, error: `最多装备 ${SKILL_CONFIG.MAX_EQUIPPED_SKILLS} 个技能` };
  }
  const unique = new Set();
  let totalLoad = 0;
  const normalized = [];
  for (const rawId of skillIds) {
    if (typeof rawId !== "string") return { ok: false, error: "技能 ID 格式错误" };
    const skillId = rawId.trim().toUpperCase();
    const def = getSkillDefinition(skillId);
    if (!def) return { ok: false, error: `未知技能：${rawId}` };
    if (unique.has(skillId)) return { ok: false, error: "不能重复装备同名技能" };
    unique.add(skillId);
    totalLoad += def.load;
    normalized.push(skillId);
  }
  if (totalLoad > SKILL_CONFIG.MAX_SKILL_LOAD) {
    return { ok: false, error: `技能负载不能超过 ${SKILL_CONFIG.MAX_SKILL_LOAD}` };
  }
  return { ok: true, skillIds: normalized, totalLoad };
}

function getLoadoutLoad(skillIds) {
  return skillIds.reduce((sum, id) => sum + (getSkillDefinition(id)?.load || 0), 0);
}

function pickDefaultBotLoadout() {
  // 稳健反制流：记忆重构 + 神经阻断 + 逆境回路
  return ["MEMORY_REWRITE", "NEURAL_INTERRUPT", "ADVERSITY_CIRCUIT"];
}

function gainEnergy(player, amount, { bonus = false } = {}) {
  const runtime = player.skillRuntime;
  if (!runtime || amount <= 0) return 0;
  let grant = amount;
  if (bonus) {
    const remaining =
      SKILL_CONFIG.MAX_BONUS_ENERGY_PER_HAND - (runtime.passiveEnergyGainedThisHand || 0);
    if (remaining <= 0) return 0;
    grant = Math.min(grant, remaining);
    runtime.passiveEnergyGainedThisHand += grant;
  }
  const before = runtime.abyssEnergy;
  runtime.abyssEnergy = Math.min(
    SKILL_CONFIG.MAX_ABYSS_ENERGY,
    runtime.abyssEnergy + grant
  );
  return runtime.abyssEnergy - before;
}

function spendEnergy(player, amount) {
  const runtime = player.skillRuntime;
  if (!runtime) return false;
  if (runtime.abyssEnergy < amount) return false;
  runtime.abyssEnergy -= amount;
  return true;
}

function getEffectiveEnergyCost(player, skill) {
  let cost = skill.energyCost;
  const discount = player.skillRuntime?.overloadDiscount;
  if (discount && discount.remainingUses > 0 && skill.id !== "OVERLOAD_CORE") {
    cost = Math.max(SKILL_CONFIG.OVERLOAD_MIN_COST, cost - SKILL_CONFIG.OVERLOAD_DISCOUNT);
  }
  return cost;
}

function consumeOverloadDiscount(player, skill) {
  const discount = player.skillRuntime?.overloadDiscount;
  if (!discount || discount.remainingUses <= 0) return;
  if (skill.id === "OVERLOAD_CORE") return;
  discount.remainingUses -= 1;
  if (discount.remainingUses <= 0) player.skillRuntime.overloadDiscount = null;
}

function hasEquipped(player, skillId) {
  return Boolean(player.skillRuntime?.equippedSkillIds?.includes(skillId));
}

function getPublicSkillSummary(player) {
  const runtime = player.skillRuntime || createEmptySkillRuntime();
  return {
    equippedSkillIds: [...(runtime.equippedSkillIds || [])],
    loadoutConfirmed: Boolean(runtime.loadoutConfirmed),
    abyssEnergy: runtime.abyssEnergy || 0,
    nextHandSkillLocked: Boolean(runtime.nextHandSkillLocked),
    overloadActive: Boolean(runtime.overloadDiscount?.remainingUses > 0),
    skillUsesThisHand: { ...(runtime.skillUsesThisHand || {}) },
    skillUsesThisGame: { ...(runtime.skillUsesThisGame || {}) },
    activeSkillsUsedThisPhase: runtime.activeSkillsUsedThisPhase || 0,
    activeSkillsUsedThisHand: runtime.activeSkillsUsedThisHand || 0,
    successfulCardEditThisHand: Boolean(runtime.successfulCardEditThisHand),
    firstStreetActionTaken: Boolean(runtime.firstStreetActionTaken),
  };
}

function getPublicRoomSkillSnapshot(room) {
  const state = room.skillState || createRoomSkillState();
  return {
    silenceActive: Boolean(state.silenceActive),
    nullifiedCommunityCardIds: [...(state.nullifiedCommunityCardIds || [])],
    burnedCardCount: (state.burnedCards || []).length,
    removedCardCount: (state.removedCards || []).length,
    pendingSkill: state.pendingSkill
      ? {
          requestId: state.pendingSkill.requestId,
          skillId: state.pendingSkill.skillId,
          casterId: state.pendingSkill.casterId,
          status: state.pendingSkill.status,
        }
      : null,
    reactionWindow: state.reactionWindow
      ? {
          requestId: state.reactionWindow.requestId,
          expiresAt: state.reactionWindow.expiresAt,
          casterId: state.reactionWindow.casterId,
          responderId: state.reactionWindow.responderId,
          skillId: state.reactionWindow.skillId,
          status: state.reactionWindow.status,
        }
      : null,
    skillChoice: state.skillChoice
      ? {
          requestId: state.skillChoice.requestId,
          skillId: state.skillChoice.skillId,
          playerId: state.skillChoice.playerId,
          expiresAt: state.skillChoice.expiresAt,
          type: state.skillChoice.type,
        }
      : null,
    preDealWindow: state.preDealWindow
      ? {
          nextPhase: state.preDealWindow.nextPhase,
          expiresAt: state.preDealWindow.expiresAt,
        }
      : null,
    recentLog: (state.skillActionLog || []).slice(-8).map((entry) => ({
      at: entry.at,
      skillId: entry.skillId,
      casterId: entry.casterId,
      status: entry.status,
      publicSummary: entry.publicSummary,
    })),
  };
}

function markSkillUse(player, skillId) {
  const runtime = player.skillRuntime;
  runtime.skillUsesThisHand[skillId] = (runtime.skillUsesThisHand[skillId] || 0) + 1;
  runtime.skillUsesThisGame[skillId] = (runtime.skillUsesThisGame[skillId] || 0) + 1;
}

function getRemainingUses(player, skill) {
  const runtime = player.skillRuntime;
  const handUsed = runtime.skillUsesThisHand[skill.id] || 0;
  const gameUsed = runtime.skillUsesThisGame[skill.id] || 0;
  let handLeft = null;
  let gameLeft = null;
  if (skill.maxUsesPerHand != null) handLeft = Math.max(0, skill.maxUsesPerHand - handUsed);
  if (skill.maxUsesPerGame != null) gameLeft = Math.max(0, skill.maxUsesPerGame - gameUsed);
  return { handLeft, gameLeft };
}

module.exports = {
  createEmptySkillRuntime,
  createRoomSkillState,
  resetPlayerSkillsForGame,
  resetPlayerSkillsForHand,
  resetRoomSkillsForHand,
  clearSkillTimers,
  validateLoadout,
  getLoadoutLoad,
  pickDefaultBotLoadout,
  gainEnergy,
  spendEnergy,
  getEffectiveEnergyCost,
  consumeOverloadDiscount,
  hasEquipped,
  getPublicSkillSummary,
  getPublicRoomSkillSnapshot,
  markSkillUse,
  getRemainingUses,
  listSkillDefinitions,
  getSkillDefinition,
  isCardEditSkill,
};
