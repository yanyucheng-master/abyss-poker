const { SKILL_CONFIG } = require("../skillConfig");
const { getSkillDefinition, listSkillDefinitions, isProtocolSkill } = require("./definitions");

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
    paidFailuresThisHand: [],
    topSecretActive: false,
    topSecretPaidThisHand: false,
    topSecretRevealed: false,
    counterArmed: false,
    desperationActive: false,
    bloodBattleActive: false,
    defenseActive: false,
    defenseRevealed: false,
    facedAggressionThisPhase: false,
    deadEndActive: false,
    allInAction: false,
    stackCommitted: false,
    perceptionTriggerCount: 0,
    perceptionCheckedNodes: [],
    perceptionHistory: [],
    fortuneRewriteCount: 0,
    fortuneResourceUsed: false,
    foldedThisHand: false,
    handStartChips: 0,
    directChipGainThisHand: 0,
    privateResults: [],
    confirmedPublicSkills: [],
    chipLoan: null,
    chipLoans: [],
    energyLoan: null,
    energyDebt: 0,
    chipDebt: 0,
    loanChipUsesThisHand: 0,
    loanEnergyUsesThisHand: 0,
    alertChanceIndex: 0,
    alertPromptPending: false,
    alertPromptedThisHand: false,
    retreatActive: false,
    retreatTriggered: false,
    probeActive: false,
    disguiseActive: false,
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
    settlement: null,
    bettingClosed: false,
    endgameActive: null,
    endgameWindow: null,
    endgameWindowResolved: false,
    callToZeroAggressorId: null,
  };
}

function getEnergyCap(player) {
  const ids = player?.skillRuntime?.equippedSkillIds || [];
  return ids.includes("DESTINY")
    ? SKILL_CONFIG.DESTINY_MAX_ABYSS_ENERGY
    : SKILL_CONFIG.MAX_ABYSS_ENERGY;
}

function getPublicEnergyDisplay(player) {
  const real = Number(player?.skillRuntime?.abyssEnergy) || 0;
  return Math.max(0, Math.min(SKILL_CONFIG.PUBLIC_ENERGY_DISPLAY_CAP, real));
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
  const persist = {
    equippedSkillIds: runtime.equippedSkillIds,
    loadoutConfirmed: runtime.loadoutConfirmed,
    abyssEnergy: runtime.abyssEnergy,
    visibleAbyssEnergy: runtime.visibleAbyssEnergy,
    skillUsesThisGame: runtime.skillUsesThisGame,
    chipLoan: runtime.chipLoan || null,
    chipLoans: Array.isArray(runtime.chipLoans) ? runtime.chipLoans.map((loan) => ({ ...loan })) : [],
    energyLoan: runtime.energyLoan || null,
    energyDebt: Math.max(0, Number(runtime.energyDebt) || 0),
    chipDebt: Math.max(0, Number(runtime.chipDebt) || 0),
    alertChanceIndex: Math.max(0, Number(runtime.alertChanceIndex) || 0),
    alertPromptPending: Boolean(runtime.alertPromptPending),
  };
  Object.assign(runtime, createEmptySkillRuntime(), persist);
  runtime.handStartChips = Number(player.chips) || 0;
}

function resetRoomSkillsForHand(room) {
  room.skillState = room.skillState || createRoomSkillState();
  const processed = room.skillState.processedRequestIds instanceof Set
    ? room.skillState.processedRequestIds
    : new Set();
  Object.assign(room.skillState, createRoomSkillState(), { processedRequestIds: processed });
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
  let remaining = requested;
  const debt = Math.max(0, Math.floor(Number(runtime.energyDebt) || 0));
  if (debt > 0) {
    const paid = Math.min(debt, remaining);
    runtime.energyDebt = debt - paid;
    remaining -= paid;
  }
  if (remaining <= 0) return 0;
  const before = runtime.abyssEnergy;
  runtime.abyssEnergy = Math.min(getEnergyCap(player), before + remaining);
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

function getEffectiveEnergyCost(_player, skill, target = {}) {
  if (skill?.id === "NULLIFICATION") {
    return String(target?.mode || "board").toLowerCase() === "hole"
      ? SKILL_CONFIG.NULLIFY_HOLE_COST
      : SKILL_CONFIG.NULLIFY_BOARD_COST;
  }
  return Math.max(0, Number(skill?.energyCost) || 0);
}

function syncVisibleEnergy(player) {
  if (!player?.skillRuntime) return;
  player.skillRuntime.visibleAbyssEnergy = getPublicEnergyDisplay(player);
}

function hasEquipped(player, skillId) {
  return Boolean(player?.skillRuntime?.equippedSkillIds?.includes(skillId));
}

function confirmPublicSkill(player, skillId) {
  const runtime = player?.skillRuntime;
  if (!runtime || !skillId) return;
  if (!runtime.confirmedPublicSkills.includes(skillId)) runtime.confirmedPublicSkills.push(skillId);
}

function getPublicSkillSummary(player) {
  const runtime = player?.skillRuntime || createEmptySkillRuntime();
  return {
    loadoutConfirmed: Boolean(runtime.loadoutConfirmed),
    abyssEnergy: getPublicEnergyDisplay(player),
    energyCap: SKILL_CONFIG.PUBLIC_ENERGY_DISPLAY_CAP,
    buildHidden: true,
    lockedThisHand: Boolean(runtime.lockedThisHand),
    publicEffects: [
      ...(runtime.confirmedPublicSkills || []),
      runtime.bloodBattleActive ? "BLOOD_BATTLE" : null,
      runtime.defenseRevealed ? "DEFENSE" : null,
      runtime.deadEndActive ? "DEAD_END" : null,
      runtime.topSecretRevealed ? "TOP_SECRET" : null,
      runtime.disguiseActive ? "DISGUISE" : null,
    ].filter(Boolean).filter((id, index, list) => list.indexOf(id) === index),
  };
}

function getSelfSkillSummary(player) {
  const runtime = player?.skillRuntime || createEmptySkillRuntime();
  return {
    equippedSkillIds: [...(runtime.equippedSkillIds || [])],
    loadoutConfirmed: Boolean(runtime.loadoutConfirmed),
    abyssEnergy: Number(runtime.abyssEnergy) || 0,
    visibleAbyssEnergy: Number(runtime.visibleAbyssEnergy) || 0,
    energyCap: getEnergyCap(player),
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
    allInAction: Boolean(runtime.allInAction),
    retreatActive: Boolean(runtime.retreatActive),
    probeActive: Boolean(runtime.probeActive),
    disguiseActive: Boolean(runtime.disguiseActive),
    energyDebt: Math.max(0, Number(runtime.energyDebt) || 0),
    chipDebt: Math.max(0, Number(runtime.chipDebt) || 0),
    chipLoanPending: Boolean(listChipLoans(runtime).length),
    energyLoanPending: Boolean(runtime.energyLoan),
    loanChipUsesThisHand: Math.max(0, Number(runtime.loanChipUsesThisHand) || 0),
    loanEnergyUsesThisHand: Math.max(0, Number(runtime.loanEnergyUsesThisHand) || 0),
  };
}

function maskLoanPublicSummary(entry, room, viewer) {
  if (!entry || entry.skillId !== "LOAN" || !isChipViewHiddenFor(room, viewer)) return entry;
  const caster = (room?.players || []).find((player) => player.playerId === entry.casterId);
  return {
    ...entry,
    publicSummary: `${caster?.name || "玩家"} 发动「贷款」`,
  };
}

function getPublicRoomSkillSnapshot(room, viewer = null) {
  const state = room?.skillState || createRoomSkillState();
  return {
    noFoldActive: Boolean(state.noFoldActive),
    contributionCap: state.contributionCap == null ? null : Number(state.contributionCap),
    fairnessActive: Boolean(state.fairnessActive),
    bettingClosed: Boolean(state.bettingClosed),
    disguiseActive: Boolean((room.players || []).some((player) => player.skillRuntime?.disguiseActive)),
    endgameWindow: state.endgameWindow
      ? { playerId: state.endgameWindow.playerId }
      : null,
    endgameActive: Boolean(state.endgameActive),
    nullifiedCommunityCardIds: (state.nullifications || [])
      .filter((entry) => entry.revealed && entry.type !== "hole")
      .map((entry) => entry.cardCode)
      .filter(Boolean)
      .filter((code, index, list) => list.indexOf(code) === index),
    recentLog: (state.skillActionLog || [])
      .filter((entry) => !entry.secret)
      .slice(-8)
      .map(({ at, skillId, casterId, status, publicSummary }) => maskLoanPublicSummary({
        at, skillId, casterId, status, publicSummary,
      }, room, viewer)),
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

function recordPaidFailure(player, { skillId, cost, reason } = {}) {
  const runtime = player?.skillRuntime;
  if (!runtime) return;
  runtime.paidFailuresThisHand = runtime.paidFailuresThisHand || [];
  runtime.paidFailuresThisHand.push({
    skillId,
    cost: Math.max(0, Number(cost) || 0),
    reason: reason || "FAILED",
  });
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

function canTriggerNewSkillEvent(player, skillId, room, options = {}) {
  const runtime = player?.skillRuntime;
  if (!runtime) return false;
  if (room?.skillState?.fairnessActive) return false;
  if (!options.ignoreLock && runtime.lockedThisHand) return false;
  if (runtime.abyssEnergy < 0 && skillId !== "FORTUNE") return false;
  return true;
}

function equippedProtocols(player) {
  return (player?.skillRuntime?.equippedSkillIds || [])
    .map((id) => getSkillDefinition(id))
    .filter((skill) => isProtocolSkill(skill));
}

function isChipViewHiddenFor(room, viewer) {
  if (!room || !viewer) return false;
  const opponent = (room.players || []).find((player) => player.playerId !== viewer.playerId);
  return Boolean(opponent?.skillRuntime?.disguiseActive);
}

function addDirectChipGain(player, amount) {
  if (!player?.skillRuntime) return;
  player.skillRuntime.directChipGainThisHand =
    (Number(player.skillRuntime.directChipGainThisHand) || 0) + Math.floor(Number(amount) || 0);
}

function listChipLoans(runtime) {
  if (Array.isArray(runtime?.chipLoans)) return runtime.chipLoans;
  if (runtime?.chipLoan) return [runtime.chipLoan];
  return [];
}

function syncChipLoanState(runtime) {
  if (!runtime) return;
  const list = listChipLoans(runtime);
  runtime.chipLoans = list;
  if (!list.length) {
    runtime.chipLoan = null;
    return;
  }
  runtime.chipLoan = {
    repay: list.reduce((sum, loan) => sum + Math.max(0, Number(loan.repay) || 0), 0),
    lenderId: list[0].lenderId,
    skipCurrentEnd: list.every((loan) => loan.skipCurrentEnd),
    count: list.length,
  };
}

function addChipLoanTranche(runtime, tranche) {
  if (!runtime) return;
  runtime.chipLoans = listChipLoans(runtime);
  runtime.chipLoans.push(tranche);
  syncChipLoanState(runtime);
}

function loanReuseBlocked(player) {
  const runtime = player?.skillRuntime;
  if (!runtime) return true;
  return (Number(runtime.energyDebt) || 0) > 0 || (Number(runtime.chipDebt) || 0) > 0;
}

function expireLoanDebts(player) {
  const runtime = player?.skillRuntime;
  if (!runtime) return;
  runtime.chipLoan = null;
  runtime.chipLoans = [];
  runtime.energyLoan = null;
  runtime.energyDebt = 0;
  runtime.chipDebt = 0;
}

function expireLoanDebtsForRoom(room) {
  (room?.players || []).forEach(expireLoanDebts);
}

function isMatchOverForLoan(room) {
  return (room?.players || []).some((player) => (
    player.status === "out" || (Number(player.chips) || 0) <= 0
  ));
}

module.exports = {
  createEmptySkillRuntime, createRoomSkillState, resetPlayerSkillsForGame,
  resetPlayerSkillsForHand, resetRoomSkillsForHand,
  validateLoadout, getLoadoutLoad, pickDefaultBotLoadout, gainEnergy, spendEnergy,
  getEffectiveEnergyCost, syncVisibleEnergy, hasEquipped,
  getPublicSkillSummary, getSelfSkillSummary, getPublicRoomSkillSnapshot,
  markSkillUse, markSkillEvent, getRemainingUses, listSkillDefinitions,
  getSkillDefinition, getEnergyCap, getPublicEnergyDisplay, confirmPublicSkill,
  recordPaidFailure, canTriggerNewSkillEvent, equippedProtocols,
  isChipViewHiddenFor, addDirectChipGain, loanReuseBlocked,
  expireLoanDebts, expireLoanDebtsForRoom, isMatchOverForLoan,
  maskLoanPublicSummary, addChipLoanTranche, listChipLoans, syncChipLoanState,
};
