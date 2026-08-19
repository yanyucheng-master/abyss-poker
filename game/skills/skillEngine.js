const crypto = require("crypto");
const { isSkillEnabled } = require("../skillModes");
const { SKILL_CONFIG } = require("../skillConfig");
const {
  getSkillDefinition,
  listSkillDefinitions,
  isActiveSkill,
  protocolMatchesCategory,
} = require("./definitions");
const {
  createEmptySkillRuntime,
  createRoomSkillState,
  resetPlayerSkillsForGame,
  resetPlayerSkillsForHand,
  resetRoomSkillsForHand,
  validateLoadout,
  pickDefaultBotLoadout,
  gainEnergy,
  spendEnergy,
  getEffectiveEnergyCost,
  syncVisibleEnergy,
  hasEquipped,
  getPublicSkillSummary,
  getSelfSkillSummary,
  getPublicRoomSkillSnapshot,
  markSkillUse,
  markSkillEvent,
  getRemainingUses,
  getEnergyCap,
  confirmPublicSkill,
  recordPaidFailure,
  canTriggerNewSkillEvent,
  equippedProtocols,
} = require("./skillState");
const {
  FORTUNE_COMBOS,
  FORTUNE_CONFIG,
  computeFortuneChance,
  isStrongHole,
  scoreHeroBoard,
} = require("./fortuneConfig");
const { buildPerceptionFacts, pickPerceptionStatement } = require("./perceptionFacts");

const ACTIVE_PHASES = new Set(["pre_flop", "flop", "turn", "river"]);
const CARD_CODE_RE = /^[SHCD](?:[2-9TJQKA])$/;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asIndex(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function cloneCard(card) {
  return card ? { ...card } : null;
}

function opponentOf(room, player) {
  return room.players.find((candidate) => candidate.playerId !== player.playerId) || null;
}

function contributionFor(player) {
  return Math.max(0, Number(player?.totalBet) || 0);
}

function getDisadvantageSeverity(room, player) {
  const opponent = opponentOf(room, player);
  if (!opponent) return 0;
  const deficit = Math.max(0, (Number(opponent.chips) || 0) - (Number(player.chips) || 0));
  return clamp(deficit / Math.max(1, Number(opponent.chips) || 0), 0, 1);
}

function collectZoneCards(room) {
  return [
    ...(room.communityCards || []),
    ...(room.deck || []),
    ...(room.skillState?.burnedCards || []),
    ...(room.skillState?.removedCards || []),
    ...room.players.flatMap((player) => player.cards || []),
  ].filter(Boolean);
}

function zonesAreUnique(room) {
  const codes = collectZoneCards(room).map((card) => card.code);
  return codes.length === 52 && new Set(codes).size === 52;
}

function snapshotZones(room) {
  return {
    deck: (room.deck || []).map(cloneCard),
    communityCards: (room.communityCards || []).map(cloneCard),
    burnedCards: (room.skillState?.burnedCards || []).map(cloneCard),
    removedCards: (room.skillState?.removedCards || []).map(cloneCard),
    playerCards: room.players.map((player) => ({
      playerId: player.playerId,
      cards: (player.cards || []).map(cloneCard),
    })),
  };
}

function restoreZones(room, snapshot) {
  room.deck = snapshot.deck.map(cloneCard);
  room.communityCards = snapshot.communityCards.map(cloneCard);
  if (room.skillState) {
    room.skillState.burnedCards = snapshot.burnedCards.map(cloneCard);
    room.skillState.removedCards = snapshot.removedCards.map(cloneCard);
  }
  snapshot.playerCards.forEach((entry) => {
    const player = room.players.find((candidate) => candidate.playerId === entry.playerId);
    if (player) player.cards = entry.cards.map(cloneCard);
  });
}

function reservedDeckIndexes(room) {
  const reserved = new Set();
  const deck = room?.deck || [];
  if (deck.length) reserved.add(deck.length - 1);
  getFutureCommunitySlots(room).forEach((slot) => reserved.add(slot.deckIndex));
  return reserved;
}

function getFutureCommunitySlots(room) {
  const deck = room?.deck || [];
  const boardCount = Math.max(0, Math.min(5, room?.communityCards?.length || 0));
  let pointer = deck.length - 1;
  const slots = [];

  if (boardCount < 3) {
    pointer -= 1;
    for (let boardIndex = boardCount; boardIndex < 3; boardIndex += 1) {
      if (pointer < 0) return slots;
      slots.push({ boardIndex, deckIndex: pointer, card: deck[pointer] });
      pointer -= 1;
    }
  }
  if (boardCount < 4) {
    pointer -= 1;
    if (pointer >= 0) {
      slots.push({ boardIndex: 3, deckIndex: pointer, card: deck[pointer] });
      pointer -= 1;
    }
  }
  if (boardCount < 5) {
    pointer -= 1;
    if (pointer >= 0) slots.push({ boardIndex: 4, deckIndex: pointer, card: deck[pointer] });
  }
  return slots;
}

function updateNullifiedCodes(room) {
  const state = room.skillState || createRoomSkillState();
  const boardCodes = [];
  (state.nullifications || []).forEach((entry) => {
    if (entry.type === "hole") return;
    const live = room.communityCards?.[entry.boardIndex]?.code;
    const future = getFutureCommunitySlots(room).find((slot) => slot.boardIndex === entry.boardIndex)?.card?.code;
    entry.cardCode = live || future || entry.cardCode || null;
    if (entry.cardCode && !boardCodes.includes(entry.cardCode)) boardCodes.push(entry.cardCode);
  });
  state.nullifiedCommunityCardIds = boardCodes;
  return state.nullifiedCommunityCardIds;
}

function evaluationExcludedCodes(room, player = null) {
  updateNullifiedCodes(room);
  const codes = new Set();
  (room.skillState?.nullifications || []).forEach((entry) => {
    if (!entry?.cardCode) return;
    if (entry.type === "hole") {
      if (player && entry.playerId === player.playerId) codes.add(entry.cardCode);
      return;
    }
    codes.add(entry.cardCode);
  });
  return codes;
}

function createSkillEvent(room, player, skill, extra = {}) {
  return {
    at: Date.now(),
    stage: room.phase,
    skillId: skill.id,
    casterId: player.playerId,
    ownerId: player.playerId,
    kind: extra.kind || (isActiveSkill(skill) ? "active" : "passive"),
    paid: Boolean(extra.paid),
    cost: extra.cost == null ? null : Number(extra.cost),
    success: extra.success !== false && extra.status !== "FAILED" && extra.status !== "COUNTERED",
    failureReason: extra.failureReason || null,
    public: extra.secret ? false : extra.secret === false,
    secret: Boolean(extra.secret),
    completed: extra.completed !== false,
    persistent: Boolean(extra.persistent),
    pending: Boolean(extra.pending),
    multiplierSource: extra.multiplierSource || null,
    energyRecoverySource: extra.energyRecoverySource || null,
    cardMutationCompleted: Boolean(extra.cardMutationCompleted),
    status: extra.status || "SUCCESS",
    publicSummary: extra.publicSummary || `${player.name} 发动「${skill.name}」`,
    target: extra.target ? JSON.parse(JSON.stringify(extra.target)) : null,
    audit: extra.audit ? JSON.parse(JSON.stringify(extra.audit)) : null,
  };
}

function initPlayerForSkillMode(player, skillMode) {
  if (!isSkillEnabled(skillMode)) {
    player.skillRuntime = null;
    return player;
  }
  if (!player.skillRuntime) player.skillRuntime = createEmptySkillRuntime();
  resetPlayerSkillsForGame(player);
  return player;
}

function setPlayerLoadout(player, skillIds) {
  const result = validateLoadout(skillIds);
  if (!result.ok) return result;
  if (!player.skillRuntime) player.skillRuntime = createEmptySkillRuntime();
  player.skillRuntime.equippedSkillIds = [...result.skillIds];
  player.skillRuntime.loadoutConfirmed = true;
  return result;
}

function autoConfirmBotLoadouts(room) {
  room.players.filter((player) => player.isBot).forEach((player) => {
    if (!player.skillRuntime) player.skillRuntime = createEmptySkillRuntime();
    if (!player.skillRuntime.loadoutConfirmed) setPlayerLoadout(player, pickDefaultBotLoadout());
  });
}

function allLoadoutsConfirmed(room) {
  return room.players.length === 2 && room.players.every((player) => player.skillRuntime?.loadoutConfirmed);
}

function beginHandSkills(room) {
  if (!isSkillEnabled(room.skillMode)) return;
  resetRoomSkillsForHand(room);
  room.players.forEach(resetPlayerSkillsForHand);
  room.players.forEach((player) => {
    const runtime = player.skillRuntime;
    if (
      hasEquipped(player, "DESPERATION") &&
      canTriggerNewSkillEvent(player, "DESPERATION", room) &&
      runtime.handStartChips <= SKILL_CONFIG.DESPERATION_CHIP_THRESHOLD
    ) {
      runtime.desperationActive = true;
      markSkillEvent(player, "DESPERATION");
      room.skillState.skillActionLog.push(createSkillEvent(room, player, getSkillDefinition("DESPERATION"), {
        status: "TRIGGERED",
        secret: false,
        persistent: true,
        pending: true,
        multiplierSource: "self",
        publicSummary: `${player.name} 进入绝境`,
      }));
    }
  });
}

function onStreetPhaseChanged(room, phase) {
  if (!isSkillEnabled(room.skillMode)) return;
  if (ACTIVE_PHASES.has(phase)) {
    room.players.forEach((player) => {
      if (player.skillRuntime) player.skillRuntime.facedAggressionThisPhase = false;
    });
  }
}

function onPlayerFolded(player) {
  if (player?.skillRuntime) player.skillRuntime.foldedThisHand = true;
}

const CLEARED_PUBLIC_EFFECTS = new Set([
  "INTIMIDATION",
  "BLOOD_BATTLE",
  "DEAD_END",
  "DEFENSE",
  "COUNTER",
]);

function clearPersistentSkillState(room) {
  const state = room.skillState || createRoomSkillState();
  state.noFoldActive = false;
  state.contributionCap = null;
  state.nullifications = [];
  state.nullifiedCommunityCardIds = [];
  room.players.forEach((player) => {
    const runtime = player.skillRuntime;
    if (!runtime) return;
    runtime.breathArmed = false;
    runtime.breathBroken = true;
    runtime.counterArmed = false;
    runtime.desperationActive = false;
    runtime.bloodBattleActive = false;
    runtime.defenseActive = false;
    runtime.defenseRevealed = false;
    runtime.deadEndActive = false;
    runtime.topSecretActive = false;
    runtime.confirmedPublicSkills = (runtime.confirmedPublicSkills || [])
      .filter((id) => !CLEARED_PUBLIC_EFFECTS.has(id));
  });
}

function revealNullifications(room) {
  updateNullifiedCodes(room);
  (room.skillState?.nullifications || []).forEach((entry) => {
    entry.revealed = true;
  });
}

class SkillEngine {
  constructor({ gameEngine, random = Math.random } = {}) {
    this.gameEngine = gameEngine;
    this.random = typeof random === "function" ? random : Math.random;
  }

  emitToPlayer(player, event, payload) {
    this.gameEngine?.emitToPlayer(player, event, payload);
  }

  emitToRoom(room, event, payload) {
    this.gameEngine?.emitToRoom(room, event, payload);
  }

  broadcastSkillState(room) {
    if (!isSkillEnabled(room.skillMode)) return;
    const roomSnapshot = getPublicRoomSkillSnapshot(room);
    room.players.forEach((viewer) => {
      this.emitToPlayer(viewer, "skill:state", {
        skillMode: room.skillMode,
        room: roomSnapshot,
        self: getSelfSkillSummary(viewer),
        players: room.players.map((player) => ({
          playerId: player.playerId,
          ...getPublicSkillSummary(player),
        })),
      });
    });
  }

  restorePrivateState(_room, player) {
    (player?.skillRuntime?.privateResults || []).slice(-8).forEach((result) => {
      this.emitToPlayer(player, "skill:private-result", result);
    });
  }

  notifyPrivate(player, payload) {
    const result = { resultId: crypto.randomUUID(), at: Date.now(), ...payload };
    player.skillRuntime.privateResults.push(result);
    if (player.skillRuntime.privateResults.length > 16) player.skillRuntime.privateResults.shift();
    this.emitToPlayer(player, "skill:private-result", result);
    return result;
  }

  recordSkill(room, player, skill, extra = {}) {
    const entry = createSkillEvent(room, player, skill, extra);
    room.skillState.skillActionLog.push(entry);
    return entry;
  }

  emitResolved(room, player, skill, options = {}) {
    const secret = Boolean(options.secret);
    const payload = {
      requestId: options.requestId || null,
      skillId: skill.id,
      casterId: player.playerId,
      status: options.status || "SUCCESS",
      publicSummary: options.publicSummary || `${player.name} 发动「${skill.name}」`,
      publicData: options.publicData || null,
    };
    if (secret) this.emitToPlayer(player, "skill:resolved", payload);
    else this.emitToRoom(room, "skill:resolved", payload);
  }

  tryActivateTopSecret(room, defender, { requestId } = {}) {
    const runtime = defender?.skillRuntime;
    if (!defender || !hasEquipped(defender, "TOP_SECRET")) return false;
    if (runtime.topSecretActive) return true;
    if (!canTriggerNewSkillEvent(defender, "TOP_SECRET", room)) return false;
    if (runtime.abyssEnergy < SKILL_CONFIG.TOP_SECRET_COST) return false;
    if (!spendEnergy(defender, SKILL_CONFIG.TOP_SECRET_COST)) return false;
    runtime.topSecretActive = true;
    runtime.topSecretPaidThisHand = true;
    runtime.topSecretRevealed = true;
    markSkillEvent(defender, "TOP_SECRET");
    const skill = getSkillDefinition("TOP_SECRET");
    this.recordSkill(room, defender, skill, {
      status: "TRIGGERED",
      secret: false,
      paid: true,
      cost: SKILL_CONFIG.TOP_SECRET_COST,
      persistent: true,
      publicSummary: `${defender.name} 的「绝密」生效`,
      audit: { requestId },
    });
    this.emitToRoom(room, "skill:resolved", {
      requestId: requestId || null,
      skillId: skill.id,
      casterId: defender.playerId,
      status: "TRIGGERED",
      publicSummary: `${defender.name} 的「绝密」生效`,
    });
    return true;
  }

  settleRecycle(room, player) {
    const runtime = player.skillRuntime;
    if (!hasEquipped(player, "RECYCLE") || runtime.recycleUsedThisHand) return 0;
    if (!canTriggerNewSkillEvent(player, "RECYCLE", room, { ignoreLock: true })) return 0;
    const failures = runtime.paidFailuresThisHand || [];
    if (!failures.length) return 0;
    const best = failures.reduce((winner, entry) => (entry.cost > winner.cost ? entry : winner), failures[0]);
    const restored = gainEnergy(player, Math.floor(best.cost * SKILL_CONFIG.RECYCLE_REFUND_RATE));
    runtime.recycleUsedThisHand = true;
    markSkillEvent(player, "RECYCLE");
    const recycle = getSkillDefinition("RECYCLE");
    this.recordSkill(room, player, recycle, {
      status: "TRIGGERED",
      secret: false,
      energyRecoverySource: "RECYCLE",
      publicSummary: `${player.name} 触发「回收利用」`,
      audit: { failedSkillId: best.skillId, originalCost: best.cost, restored },
    });
    this.emitToRoom(room, "skill:resolved", {
      skillId: recycle.id,
      casterId: player.playerId,
      status: "TRIGGERED",
      publicSummary: `${player.name} 触发「回收利用」`,
    });
    return restored;
  }

  applyResourceFortune(room, player) {
    const runtime = player.skillRuntime;
    if (!hasEquipped(player, "FORTUNE") || runtime.fortuneResourceUsed) return false;
    if (room.skillState.fairnessActive || runtime.lockedThisHand) return false;
    const chance = computeFortuneChance("resource", {
      disadvantage: getDisadvantageSeverity(room, player),
      energy: runtime.abyssEnergy,
      energyCap: getEnergyCap(player),
    });
    runtime.fortuneResourceUsed = true;
    if (this.random() >= chance) return false;
    const restored = gainEnergy(player, 1);
    markSkillEvent(player, "FORTUNE");
    this.recordSkill(room, player, getSkillDefinition("FORTUNE"), {
      status: "TRIGGERED",
      secret: true,
      kind: "passive",
      energyRecoverySource: "FORTUNE",
      publicSummary: "秘密技能已结算",
      audit: { node: "HAND_END_RESOURCE", chance, restored },
    });
    this.notifyPrivate(player, { skillId: "FORTUNE", message: "强运：额外恢复 1 能量。" });
    return true;
  }

  endHand(room, { reason, winner, tie = false } = {}) {
    if (!isSkillEnabled(room.skillMode)) return;
    revealNullifications(room);
    const fairness = Boolean(room.skillState?.fairnessActive);
    room.players.forEach((player) => {
      const runtime = player.skillRuntime;
      if (!runtime) return;
      const debtLock = runtime.abyssEnergy < 0;
      if (!fairness) {
        if (runtime.breathArmed && !runtime.breathBroken) {
          gainEnergy(player, SKILL_CONFIG.DEEP_BREATH_RESTORE);
        }
        if (runtime.counterArmed) {
          runtime.counterArmed = false;
          gainEnergy(player, SKILL_CONFIG.COUNTER_UNUSED_REFUND);
          this.recordSkill(room, player, getSkillDefinition("COUNTER"), {
            status: "REFUNDED",
            secret: true,
            energyRecoverySource: "COUNTER",
            publicSummary: "秘密技能已结算",
            audit: { unused: true, restored: SKILL_CONFIG.COUNTER_UNUSED_REFUND },
          });
        }
        const lost = !tie && winner && winner.playerId !== player.playerId;
        if (lost) gainEnergy(player, SKILL_CONFIG.ENERGY_LOSER_GAIN);
        if (!tie && winner?.playerId === player.playerId && runtime.desperationActive) {
          gainEnergy(player, 1);
        }
        if (!debtLock) this.settleRecycle(room, player);
        this.applyResourceFortune(room, player);
      }
      syncVisibleEnergy(player);
    });
  }

  validateUse(room, player, rawSkillId, target = {}) {
    if (!room || !player || !isSkillEnabled(room.skillMode)) return { ok: false, error: "当前房间未启用技能" };
    const skill = getSkillDefinition(rawSkillId);
    if (!skill) return { ok: false, error: "未知技能" };
    if (!isActiveSkill(skill)) return { ok: false, error: "该技能为自动触发技能" };
    const runtime = player.skillRuntime;
    if (!runtime?.loadoutConfirmed || !hasEquipped(player, skill.id)) return { ok: false, error: "未装备该技能" };
    if (!ACTIVE_PHASES.has(room.phase)) return { ok: false, error: "当前牌局阶段不可发动技能" };
    if (runtime.lockedThisHand || room.skillState?.fairnessActive) return { ok: false, error: "本手技能已被封锁" };
    if (runtime.abyssEnergy < 0) return { ok: false, error: "负能量时除强运外不能发动技能" };
    if (["folded", "out", "disconnected"].includes(player.status)) return { ok: false, error: "当前已退出本手" };
    if (skill.allowedPhases.length && !skill.allowedPhases.includes(room.phase)) return { ok: false, error: "当前阶段不可发动该技能" };
    if (skill.requiresActionTurn) {
      const current = room.players[room.currentPlayerIndex];
      if (!current || current.playerId !== player.playerId || player.isAllIn) {
        return { ok: false, error: "该技能只能在你的下注行动回合发动" };
      }
    }
    const remaining = getRemainingUses(player, skill);
    if (remaining.handLeft === 0) return { ok: false, error: "本手已使用过该技能" };
    if (remaining.gameLeft === 0) return { ok: false, error: "本场使用次数已耗尽" };
    const cost = getEffectiveEnergyCost(player, skill, target);
    if (runtime.abyssEnergy < cost) return { ok: false, error: "深渊能量不足" };

    if (skill.id === "INTIMIDATION" && room.players.some((candidate) => contributionFor(candidate) > SKILL_CONFIG.FEAR_CONTRIBUTION_CAP)) {
      return { ok: false, error: "已有玩家本手投入超过 500，恐吓不能发动" };
    }
    if (skill.id === "INTEL_ONE") {
      const zone = String(target.zone || target.mode || "opponent").toLowerCase();
      if (zone === "opponent" || zone === "hole") {
        if (!opponentOf(room, player)?.cards?.length) return { ok: false, error: "对手底牌尚未就绪" };
      } else if (zone === "future" || zone === "board") {
        const slots = getFutureCommunitySlots(room);
        const boardIndex = asIndex(target.boardIndex);
        if (boardIndex == null || !slots.some((slot) => slot.boardIndex === boardIndex)) {
          return { ok: false, error: "请选择有效的未来公共牌位置" };
        }
      } else {
        return { ok: false, error: "请选择有效的情报目标" };
      }
    }
    if (skill.id === "NULLIFICATION") {
      const mode = String(target.mode || "board").toLowerCase();
      if (mode === "hole") {
        if (!opponentOf(room, player)?.cards?.length) return { ok: false, error: "对手底牌尚未就绪" };
      } else {
        const boardIndex = asIndex(target.boardIndex);
        if (boardIndex == null || boardIndex < 0 || boardIndex > 4) return { ok: false, error: "请选择有效的公共牌位置" };
        const existsNow = Boolean(room.communityCards[boardIndex]);
        const existsFuture = getFutureCommunitySlots(room).some((slot) => slot.boardIndex === boardIndex);
        if (!existsNow && !existsFuture) return { ok: false, error: "该公共牌位置当前不可指定" };
      }
    }
    if (skill.id === "DESTINY") {
      const cardCode = String(target.cardCode || "").toUpperCase();
      if (!CARD_CODE_RE.test(cardCode)) return { ok: false, error: "请选择精确有效的目标牌" };
      if (!getFutureCommunitySlots(room).some((slot) => slot.boardIndex === 4)) {
        return { ok: false, error: "未来河牌位置已经不存在" };
      }
    }
    if (skill.id === "CHEAT") {
      const ownIndex = asIndex(target.ownIndex);
      const zone = String(target.zone || "").toLowerCase();
      if (![0, 1].includes(ownIndex) || !player.cards?.[ownIndex]) {
        return { ok: false, error: "请选择自己的一张底牌" };
      }
      if (!["opponent", "community", "future", "next", "deck_random"].includes(zone)) {
        return { ok: false, error: "请选择千术交换目标" };
      }
      const index = asIndex(target.index);
      if (zone === "opponent" && (![0, 1].includes(index) || !opponentOf(room, player)?.cards?.[index])) {
        return { ok: false, error: "请选择有效的对手底牌位置" };
      }
      if (zone === "community" && (index == null || !room.communityCards[index])) {
        return { ok: false, error: "请选择已经公开的公共牌" };
      }
      const futureSlots = getFutureCommunitySlots(room);
      if (zone === "future" && (index == null || !futureSlots.some((slot) => slot.boardIndex === index))) {
        return { ok: false, error: "请选择有效的未来公共牌位置" };
      }
      if (zone === "next" && futureSlots.length === 0) {
        return { ok: false, error: "当前没有下一张有效发牌" };
      }
      if (zone === "deck_random") {
        const excluded = new Set();
        if (room.deck.length) excluded.add(room.deck.length - 1);
        if (futureSlots[0]) excluded.add(futureSlots[0].deckIndex);
        const pool = room.deck.map((_, deckIndex) => deckIndex).filter((deckIndex) => !excluded.has(deckIndex));
        if (!pool.length) return { ok: false, error: "当前没有可暗抽的非顶部牌" };
      }
    }
    return { ok: true, skill, cost };
  }

  requestUse(room, player, payload = {}, options = {}) {
    const skillId = String(payload.skillId || "").trim().toUpperCase();
    const requestId = String(payload.requestId || crypto.randomUUID()).slice(0, 128);
    room.skillState = room.skillState || createRoomSkillState();
    if (room.skillState.processedRequestIds.has(requestId)) return { ok: true, duplicate: true };
    if (options.enforceContext) {
      if (payload.handId !== room.handId || payload.turnId !== room.turnId || payload.phase !== room.phase) {
        return { ok: false, error: "该技能请求已过期，请按当前回合重新发动" };
      }
    }
    const target = payload.target && typeof payload.target === "object" ? payload.target : {};
    const validation = this.validateUse(room, player, skillId, target);
    if (!validation.ok) return validation;
    const { skill, cost } = validation;

    if (!spendEnergy(player, cost)) return { ok: false, error: "深渊能量不足" };
    room.skillState.processedRequestIds.add(requestId);
    markSkillUse(player, skill.id);
    markSkillEvent(player, skill.id);

    const opponent = opponentOf(room, player);
    if (skill.canBeCountered !== false && opponent?.skillRuntime?.counterArmed) {
      opponent.skillRuntime.counterArmed = false;
      recordPaidFailure(player, { skillId: skill.id, cost, reason: "COUNTERED" });
      player.skillRuntime.lockedThisHand = true;
      player.skillRuntime.lockReason = "COUNTER";
      this.recordSkill(room, player, skill, {
        status: "COUNTERED",
        secret: skill.visibility === "SECRET",
        paid: true,
        cost,
        success: false,
        failureReason: "COUNTERED",
        publicSummary: `${player.name} 的技能被反制`,
        target,
        audit: { paidEnergy: cost },
      });
      this.emitToRoom(room, "skill:resolved", {
        requestId, skillId: "COUNTER", casterId: opponent.playerId, status: "TRIGGERED",
        publicSummary: `${opponent.name} 的「反制」生效`,
      });
      this.notifyPrivate(player, { skillId: skill.id, message: "技能被反制；本手后续主动与新的被动技能事件已封锁。" });
      this.broadcastSkillState(room);
      this.gameEngine?.broadcastRoomState(room);
      return { ok: true, status: "COUNTERED" };
    }

    let resolution;
    try {
      resolution = this.resolveActiveSkill(room, player, opponent, skill, target, requestId, cost);
    } catch (error) {
      recordPaidFailure(player, { skillId: skill.id, cost, reason: error.message });
      this.recordSkill(room, player, skill, {
        status: "FAILED", secret: true, paid: true, cost, success: false, failureReason: error.message, target,
        publicSummary: `${player.name} 的技能结算失败`,
        audit: { reason: error.message, paidEnergy: cost },
      });
      this.notifyPrivate(player, { skillId: skill.id, message: `技能结算失败：${error.message}` });
      this.broadcastSkillState(room);
      return { ok: true, status: "FAILED" };
    }

    const result = resolution || {};
    if (result.status === "FAILED") {
      recordPaidFailure(player, { skillId: skill.id, cost, reason: result.failureReason || "FAILED" });
    }
    this.recordSkill(room, player, skill, {
      status: result.status || "SUCCESS",
      secret: result.secret ?? skill.visibility === "SECRET",
      paid: true,
      cost,
      success: (result.status || "SUCCESS") === "SUCCESS",
      failureReason: result.failureReason || null,
      persistent: Boolean(result.persistent),
      pending: Boolean(result.pending),
      completed: result.cardMutationCompleted ? true : result.completed !== false,
      cardMutationCompleted: Boolean(result.cardMutationCompleted),
      publicSummary: result.publicSummary,
      target: result.auditTarget || target,
      audit: result.audit,
    });
    this.emitResolved(room, player, skill, {
      requestId,
      status: result.status || "SUCCESS",
      secret: result.secret ?? skill.visibility === "SECRET",
      publicSummary: result.publicSummary,
      publicData: result.publicData,
    });
    if (result.privateResult) this.notifyPrivate(player, { skillId: skill.id, ...result.privateResult });
    if (result.cardsChanged) {
      room.players.forEach((candidate) => this.emitToPlayer(candidate, "your_cards", { cards: candidate.cards }));
      this.gameEngine?.emitPrivateHandHints(room);
    }
    if (result.communityChanged) {
      updateNullifiedCodes(room);
      this.emitToRoom(room, "community_cards", {
        cards: room.communityCards,
        phase: room.phase,
        nullifiedCommunityCardIds: getPublicRoomSkillSnapshot(room).nullifiedCommunityCardIds,
      });
    }
    this.broadcastSkillState(room);
    this.gameEngine?.broadcastRoomState(room);
    if (result.commitAllIn) this.commitDeclaredAllIn(room, player);
    return { ok: true, status: result.status || "SUCCESS" };
  }

  commitDeclaredAllIn(room, player) {
    const playerIndex = room.players.findIndex((candidate) => candidate.playerId === player.playerId);
    if (playerIndex < 0 || !this.gameEngine?.handlePlayerAction) return;
    this.gameEngine.handlePlayerAction(room, playerIndex, "allin", 0, { fromSkill: "DEAD_END" });
  }

  resolveActiveSkill(room, player, opponent, skill, target, requestId, cost) {
    const runtime = player.skillRuntime;
    switch (skill.id) {
      case "DEEP_BREATH":
        runtime.breathArmed = true;
        return { publicSummary: `${player.name} 调整呼吸`, pending: true, audit: { armed: true, cost } };
      case "INTIMIDATION":
        room.skillState.noFoldActive = true;
        room.skillState.contributionCap = SKILL_CONFIG.FEAR_CONTRIBUTION_CAP;
        confirmPublicSkill(player, "INTIMIDATION");
        return { publicSummary: `${player.name} 发动「恐吓」：本手禁止弃牌，投入上限 500`, persistent: true };
      case "BLOOD_BATTLE":
        runtime.bloodBattleActive = true;
        confirmPublicSkill(player, "BLOOD_BATTLE");
        return { publicSummary: `${player.name} 宣告「血战」`, persistent: true, pending: true, multiplierSource: "self" };
      case "DEFENSE":
        runtime.defenseActive = true;
        return { secret: true, publicSummary: "秘密技能已结算", persistent: true, pending: true, privateResult: { message: "防守已秘密生效。" } };
      case "COUNTER":
        runtime.counterArmed = true;
        return { secret: true, publicSummary: "秘密技能已结算", persistent: true, pending: true, privateResult: { message: "反制已秘密布置。" } };
      case "FAIRNESS":
        clearPersistentSkillState(room);
        room.skillState.fairnessActive = true;
        room.players.forEach((candidate) => {
          candidate.skillRuntime.lockedThisHand = true;
          candidate.skillRuntime.lockReason = "FAIRNESS";
        });
        confirmPublicSkill(player, "FAIRNESS");
        return { publicSummary: `${player.name} 宣告「公平」：清除未完成技能状态，并封锁后续技能与结束恢复` };
      case "DEAD_END": {
        runtime.deadEndActive = true;
        if (opponent?.skillRuntime) {
          opponent.skillRuntime.lockedThisHand = true;
          opponent.skillRuntime.lockReason = "DEAD_END";
        }
        confirmPublicSkill(player, "DEAD_END");
        return {
          publicSummary: `${player.name} 发动「绝路」`,
          persistent: true,
          commitAllIn: true,
        };
      }
      case "INTEL_ONE":
        return this.resolveIntelOne(room, player, opponent, target, requestId, cost);
      case "CHEAT":
        return this.resolveCheat(room, player, opponent, target, requestId, cost);
      case "CLAIRVOYANCE":
        return this.resolveClairvoyance(room, player, opponent);
      case "NULLIFICATION":
        return this.resolveNullification(room, player, opponent, target, requestId, cost);
      case "DESTINY":
        return this.resolveDestiny(room, player, opponent, target, requestId, cost);
      default:
        throw new Error("技能尚未接入结算器");
    }
  }

  resolveIntelOne(room, player, opponent, target, requestId, cost) {
    const zone = String(target.zone || target.mode || "opponent").toLowerCase();
    if (zone === "opponent" || zone === "hole") {
      if (this.tryActivateTopSecret(room, opponent, { requestId }) || opponent?.skillRuntime?.topSecretActive) {
        return {
          status: "FAILED",
          secret: true,
          failureReason: "TOP_SECRET",
          publicSummary: "秘密技能已结算",
          privateResult: { message: "情报目标受到绝密保护，本次读取失败。" },
          audit: { reason: "TOP_SECRET", paidEnergy: cost },
        };
      }
      const index = this.random() < 0.5 ? 0 : 1;
      const card = opponent?.cards?.[index];
      if (!card) throw new Error("对手底牌尚未就绪");
      return {
        secret: true, publicSummary: "秘密技能已结算",
        privateResult: { message: `情报：对手的一张底牌是 ${card.code}`, card: cloneCard(card), zone: "opponent" },
        audit: { zone: "opponent", cardIndex: index, cardCode: card.code },
      };
    }
    if (zone === "future" || zone === "board") {
      const slots = getFutureCommunitySlots(room);
      const requested = asIndex(target.boardIndex);
      const slot = slots.find((candidate) => candidate.boardIndex === requested);
      if (!slot?.card) throw new Error("指定的未来公共牌不存在");
      return {
        secret: true, publicSummary: "秘密技能已结算",
        privateResult: { message: `情报：第 ${slot.boardIndex + 1} 张公共牌将是 ${slot.card.code}`, card: cloneCard(slot.card), zone: "future", boardIndex: slot.boardIndex },
        audit: { zone: "future", boardIndex: slot.boardIndex, cardCode: slot.card.code },
      };
    }
    throw new Error("未知情报目标");
  }

  resolveCheat(room, player, opponent, target, requestId, cost) {
    const ownIndex = asIndex(target.ownIndex);
    const zone = String(target.zone || "").toLowerCase();
    const ownCard = player.cards?.[ownIndex];
    if (!ownCard) throw new Error("自己的目标底牌不存在");
    const snapshot = snapshotZones(room);
    let otherCard = null;
    let otherLocation = null;
    let secret = true;
    let communityChanged = false;

    if (zone === "opponent") {
      if (this.tryActivateTopSecret(room, opponent, { requestId }) || opponent?.skillRuntime?.topSecretActive) {
        return {
          status: "FAILED",
          secret: true,
          failureReason: "TOP_SECRET",
          publicSummary: "秘密技能已结算",
          privateResult: { message: "千术目标受到绝密保护，交换失败。" },
          audit: { reason: "TOP_SECRET", paidEnergy: cost },
        };
      }
      const index = asIndex(target.index);
      if (![0, 1].includes(index) || !opponent.cards[index]) throw new Error("对手底牌目标无效");
      otherCard = opponent.cards[index];
      otherLocation = { zone, index };
      opponent.cards[index] = ownCard;
      player.cards[ownIndex] = otherCard;
    } else if (zone === "community") {
      const index = asIndex(target.index);
      if (index == null || !room.communityCards[index]) throw new Error("公共牌目标无效");
      otherCard = room.communityCards[index];
      otherLocation = { zone, index };
      room.communityCards[index] = ownCard;
      player.cards[ownIndex] = otherCard;
      secret = false;
      communityChanged = true;
    } else if (zone === "deck_random") {
      const futureSlots = getFutureCommunitySlots(room);
      const excluded = new Set();
      if (room.deck.length) excluded.add(room.deck.length - 1);
      if (futureSlots[0]) excluded.add(futureSlots[0].deckIndex);
      const pool = room.deck.map((_, deckIndex) => deckIndex).filter((deckIndex) => !excluded.has(deckIndex));
      if (!pool.length) throw new Error("没有可暗抽的非顶部牌");
      const deckIndex = pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))];
      otherCard = room.deck[deckIndex];
      otherLocation = { zone, deckIndex };
      room.deck[deckIndex] = ownCard;
      player.cards[ownIndex] = otherCard;
    } else {
      const slots = getFutureCommunitySlots(room);
      const slot = zone === "next"
        ? slots[0]
        : slots.find((candidate) => candidate.boardIndex === asIndex(target.index));
      if (!slot?.card) throw new Error("未来公共牌目标无效");
      otherCard = slot.card;
      otherLocation = { zone, boardIndex: slot.boardIndex, deckIndex: slot.deckIndex };
      room.deck[slot.deckIndex] = ownCard;
      player.cards[ownIndex] = otherCard;
    }

    if (!zonesAreUnique(room)) {
      restoreZones(room, snapshot);
      throw new Error("牌张守恒校验失败");
    }

    const transform = {
      at: Date.now(), skillId: "CHEAT", casterId: player.playerId,
      from: { zone: "own_hole", playerId: player.playerId, index: ownIndex, cardCode: ownCard.code },
      to: { ...otherLocation, cardCode: otherCard.code },
      after: { ownCardCode: otherCard.code, targetCardCode: ownCard.code },
    };
    room.skillState.transformations.push(transform);
    updateNullifiedCodes(room);
    return {
      secret,
      publicSummary: secret ? "牌序受到一次隐秘干预" : `${player.name} 以「千术」交换一张公共牌`,
      privateResult: { message: `千术完成：你的底牌变为 ${otherCard.code}` },
      audit: transform,
      cardsChanged: true,
      communityChanged,
      cardMutationCompleted: true,
    };
  }

  resolveClairvoyance(room, _player, opponent) {
    const events = (room.skillState.skillActionLog || [])
      .filter((entry) => entry.casterId === opponent.playerId)
      .map((entry) => ({
        skillId: entry.skillId,
        status: entry.status,
        at: entry.at,
        stage: entry.stage || null,
      }));
    return {
      secret: true,
      publicSummary: "秘密技能已结算",
      privateResult: {
        message: `灵视：对手真实能量 ${opponent.skillRuntime.abyssEnergy}；本手已结算技能事件 ${events.length} 次。`,
        opponentEnergy: opponent.skillRuntime.abyssEnergy,
        events,
      },
      audit: { observedEventCount: events.length },
    };
  }

  resolveNullification(room, player, opponent, target, requestId, cost) {
    const mode = String(target.mode || "board").toLowerCase();
    if (mode === "hole") {
      if (this.tryActivateTopSecret(room, opponent, { requestId }) || opponent?.skillRuntime?.topSecretActive) {
        return {
          status: "FAILED",
          secret: true,
          failureReason: "TOP_SECRET",
          publicSummary: "秘密技能已结算",
          privateResult: { message: "零化底牌受到绝密保护，技能失败。" },
          audit: { reason: "TOP_SECRET", paidEnergy: cost },
        };
      }
      const index = this.random() < 0.5 ? 0 : 1;
      const card = opponent?.cards?.[index];
      if (!card) throw new Error("对手底牌尚未就绪");
      const entry = {
        type: "hole",
        casterId: player.playerId,
        playerId: opponent.playerId,
        cardIndex: index,
        cardCode: card.code,
        revealed: false,
      };
      room.skillState.nullifications.push(entry);
      return {
        secret: true,
        publicSummary: "秘密技能已结算",
        persistent: true,
        pending: true,
        privateResult: { message: "零化已秘密锁定对手一张底牌。" },
        audit: { type: "hole" },
      };
    }
    const boardIndex = asIndex(target.boardIndex);
    const entry = {
      type: "board",
      boardIndex,
      casterId: player.playerId,
      revealed: false,
      cardCode: room.communityCards[boardIndex]?.code
        || getFutureCommunitySlots(room).find((slot) => slot.boardIndex === boardIndex)?.card?.code
        || null,
    };
    room.skillState.nullifications.push(entry);
    updateNullifiedCodes(room);
    return {
      secret: true,
      publicSummary: "秘密技能已结算",
      persistent: true,
      pending: true,
      privateResult: { message: `零化已秘密锁定第 ${boardIndex + 1} 张公共牌。` },
      audit: { type: "board", boardIndex },
    };
  }

  resolveDestiny(room, player, opponent, target, requestId, cost) {
    const cardCode = String(target.cardCode || "").toUpperCase();
    const riverSlot = getFutureCommunitySlots(room).find((slot) => slot.boardIndex === 4);
    if (!riverSlot) {
      return {
        status: "FAILED", secret: true, failureReason: "NO_RIVER_SLOT",
        publicSummary: "秘密技能已结算",
        privateResult: { message: "天命失败：未来河牌位置已不存在。" },
        audit: { targetCardCode: cardCode, reason: "NO_RIVER_SLOT", paidEnergy: cost },
      };
    }
    if ((opponent?.cards || []).some((card) => card.code === cardCode)) {
      return {
        status: "FAILED", secret: true, failureReason: "OPPONENT_HOLE",
        publicSummary: "秘密技能已结算",
        privateResult: { message: "天命失败：目标牌当前在对手底牌中。" },
        audit: { targetCardCode: cardCode, reason: "OPPONENT_HOLE", paidEnergy: cost },
      };
    }
    const targetDeckIndex = room.deck.findIndex((card) => card.code === cardCode);
    if (targetDeckIndex < 0) {
      return {
        status: "FAILED", secret: true, failureReason: "NOT_IN_DECK",
        publicSummary: "秘密技能已结算",
        privateResult: { message: "天命失败：目标牌已离开可控制牌堆。" },
        audit: { targetCardCode: cardCode, reason: "NOT_IN_DECK", paidEnergy: cost },
      };
    }
    const snapshot = snapshotZones(room);
    const displaced = room.deck[riverSlot.deckIndex];
    room.deck[riverSlot.deckIndex] = room.deck[targetDeckIndex];
    room.deck[targetDeckIndex] = displaced;
    if (!zonesAreUnique(room)) {
      restoreZones(room, snapshot);
      throw new Error("牌张守恒校验失败");
    }
    const transform = {
      at: Date.now(), skillId: "DESTINY", casterId: player.playerId,
      targetCardCode: cardCode, riverDeckIndex: riverSlot.deckIndex,
      displacedCardCode: displaced.code, displacedDeckIndex: targetDeckIndex,
    };
    room.skillState.transformations.push(transform);
    return {
      secret: true, publicSummary: "秘密技能已结算",
      privateResult: { message: `天命已锁定：${cardCode} 将成为河牌。` },
      audit: transform,
      cardMutationCompleted: true,
    };
  }

  applyHoleFortune(room) {
    if (!isSkillEnabled(room.skillMode)) return [];
    const triggered = [];
    room.players.forEach((player) => {
      const runtime = player.skillRuntime;
      if (!hasEquipped(player, "FORTUNE") || !canTriggerNewSkillEvent(player, "FORTUNE", room)) return;
      if (isStrongHole(player.cards)) return;
      const rewriteCost = FORTUNE_CONFIG.rewriteCost;
      if (runtime.abyssEnergy - rewriteCost < FORTUNE_CONFIG.minEnergy) return;
      const chance = computeFortuneChance("hole", {
        disadvantage: getDisadvantageSeverity(room, player),
        energy: runtime.abyssEnergy,
        energyCap: getEnergyCap(player),
      });
      if (this.random() >= chance) return;
      const used = new Set([
        ...(player.cards || []).map((card) => card.code),
        ...(opponentOf(room, player)?.cards || []).map((card) => card.code),
        ...(room.communityCards || []).map((card) => card.code),
      ]);
      const eligible = FORTUNE_COMBOS.filter((combo) => combo.codes.every((code) => {
        if (player.cards.some((card) => card.code === code)) return true;
        const inDeck = room.deck.some((card) => card.code === code);
        return inDeck && !used.has(code);
      }));
      if (!eligible.length) return;
      const selected = eligible[Math.min(eligible.length - 1, Math.floor(this.random() * eligible.length))];
      const snapshot = snapshotZones(room);
      const original = (player.cards || []).map(cloneCard);
      selected.codes.forEach((code, index) => {
        if (player.cards[index]?.code === code) return;
        const existingIndex = player.cards.findIndex((card) => card.code === code);
        if (existingIndex >= 0) {
          [player.cards[index], player.cards[existingIndex]] = [player.cards[existingIndex], player.cards[index]];
          return;
        }
        const deckIndex = room.deck.findIndex((card) => card.code === code);
        if (deckIndex < 0) return;
        const taken = player.cards[index];
        player.cards[index] = room.deck[deckIndex];
        room.deck[deckIndex] = taken;
      });
      if (!zonesAreUnique(room)) {
        restoreZones(room, snapshot);
        return;
      }
      if (!spendEnergy(player, rewriteCost, { allowDebt: true, minimum: FORTUNE_CONFIG.minEnergy })) {
        restoreZones(room, snapshot);
        return;
      }
      runtime.fortuneRewriteCount += 1;
      markSkillEvent(player, "FORTUNE");
      room.skillState.transformations.push({
        at: Date.now(), skillId: "FORTUNE", casterId: player.playerId, node: "HOLE_DEAL",
        from: original.map((card) => card.code),
        to: player.cards.map((card) => card.code),
        comboType: selected.type,
      });
      this.recordSkill(room, player, getSkillDefinition("FORTUNE"), {
        status: "TRIGGERED", secret: true, paid: true, cost: rewriteCost,
        cardMutationCompleted: true, publicSummary: "秘密技能已结算",
        audit: { node: "HOLE_DEAL", chance, comboType: selected.type, from: original.map((card) => card.code), to: player.cards.map((card) => card.code) },
      });
      this.notifyPrivate(player, {
        skillId: "FORTUNE",
        message: `强运：${original.map((card) => card.code).join(" ")} → ${player.cards.map((card) => card.code).join(" ")}`,
        from: original.map(cloneCard),
        to: player.cards.map(cloneCard),
      });
      triggered.push({ playerId: player.playerId, comboType: selected.type });
    });
    return triggered;
  }

  applyBoardFortune(room, phase) {
    if (!isSkillEnabled(room.skillMode)) return [];
    const triggered = [];
    room.players.forEach((player) => {
      const upcoming = getFutureCommunitySlots(room)[0];
      if (!upcoming) return;
      const runtime = player.skillRuntime;
      if (!hasEquipped(player, "FORTUNE") || !canTriggerNewSkillEvent(player, "FORTUNE", room)) return;
      const rewriteCost = FORTUNE_CONFIG.rewriteCost;
      if (runtime.abyssEnergy - rewriteCost < FORTUNE_CONFIG.minEnergy) return;
      const chance = computeFortuneChance("board", {
        disadvantage: getDisadvantageSeverity(room, player),
        energy: runtime.abyssEnergy,
        energyCap: getEnergyCap(player),
      });
      if (this.random() >= chance) return;
      const currentBoard = [...(room.communityCards || [])];
      const baseline = scoreHeroBoard(player.cards || [], [...currentBoard, upcoming.card]);
      const reserved = reservedDeckIndexes(room);
      let best = null;
      room.deck.forEach((card, deckIndex) => {
        if (reserved.has(deckIndex)) return;
        const score = scoreHeroBoard(player.cards || [], [...currentBoard, card]);
        if (score > baseline && (!best || score > best.score)) {
          best = { deckIndex, card, score };
        }
      });
      if (!best) return;
      const snapshot = snapshotZones(room);
      const original = cloneCard(upcoming.card);
      room.deck[upcoming.deckIndex] = best.card;
      room.deck[best.deckIndex] = original;
      if (!zonesAreUnique(room)) {
        restoreZones(room, snapshot);
        return;
      }
      if (!spendEnergy(player, rewriteCost, { allowDebt: true, minimum: FORTUNE_CONFIG.minEnergy })) {
        restoreZones(room, snapshot);
        return;
      }
      runtime.fortuneRewriteCount += 1;
      markSkillEvent(player, "FORTUNE");
      room.skillState.transformations.push({
        at: Date.now(), skillId: "FORTUNE", casterId: player.playerId, node: `${String(phase).toUpperCase()}_DEAL`,
        from: original.code, to: best.card.code,
      });
      this.recordSkill(room, player, getSkillDefinition("FORTUNE"), {
        status: "TRIGGERED", secret: true, paid: true, cost: rewriteCost,
        cardMutationCompleted: true, publicSummary: "秘密技能已结算",
        audit: { node: `${String(phase).toUpperCase()}_DEAL`, chance, from: original.code, to: best.card.code },
      });
      this.notifyPrivate(player, {
        skillId: "FORTUNE",
        message: `强运改写了即将发出的公共牌：${original.code} → ${best.card.code}`,
      });
      triggered.push({ playerId: player.playerId, phase });
    });
    return triggered;
  }

  prepareDeckForHand(_room) {
    return [];
  }

  onCardsDealt(room, node) {
    if (!isSkillEnabled(room.skillMode)) return;
    updateNullifiedCodes(room);
    room.players.forEach((player) => {
      const runtime = player.skillRuntime;
      if (!hasEquipped(player, "PERCEPTION") || !canTriggerNewSkillEvent(player, "PERCEPTION", room)) return;
      if (runtime.perceptionCheckedNodes.includes(node)) return;
      runtime.perceptionCheckedNodes.push(node);
      if (runtime.perceptionTriggerCount >= SKILL_CONFIG.PERCEPTION_MAX_TRIGGERS_PER_HAND) return;
      const chance = SKILL_CONFIG.PERCEPTION_BASE_CHANCE
        + (SKILL_CONFIG.PERCEPTION_MAX_CHANCE - SKILL_CONFIG.PERCEPTION_BASE_CHANCE)
        * getDisadvantageSeverity(room, player);
      if (this.random() >= chance) return;
      const opponent = opponentOf(room, player);
      if (!opponent?.cards?.length) return;
      const candidateFacts = buildPerceptionFacts(room, player, opponent, { holeProtected: false });
      const wouldReadHole = candidateFacts.some((fact) => fact.domain === "hole" || fact.requiresHole);
      if (wouldReadHole && hasEquipped(opponent, "TOP_SECRET")) {
        this.tryActivateTopSecret(room, opponent);
      }
      const holeProtected = Boolean(opponent.skillRuntime?.topSecretActive);
      const facts = holeProtected
        ? candidateFacts.filter((fact) => fact.domain !== "hole" && !fact.requiresHole)
        : candidateFacts;
      const picked = pickPerceptionStatement(facts, {
        truthChance: SKILL_CONFIG.PERCEPTION_TRUTH_CHANCE,
        random: () => this.random(),
      });
      if (!picked) return;
      runtime.perceptionTriggerCount += 1;
      markSkillEvent(player, "PERCEPTION");
      this.recordSkill(room, player, getSkillDefinition("PERCEPTION"), {
        status: "TRIGGERED", secret: true, publicSummary: "秘密技能已结算",
        audit: { node, chance, truthful: picked.truthful, factId: picked.factId, statement: picked.message },
      });
      this.notifyPrivate(player, { skillId: "PERCEPTION", message: `感知 · ${picked.message}`, node });
    });
    this.broadcastSkillState(room);
  }

  onAggressiveAction(room, aggressor) {
    const opponent = opponentOf(room, aggressor);
    if (opponent?.skillRuntime) opponent.skillRuntime.facedAggressionThisPhase = true;
    this.broadcastSkillState(room);
  }

  onPlayerAllIn(room, player) {
    if (!isSkillEnabled(room.skillMode) || !player?.skillRuntime) return false;
    player.skillRuntime.allInAction = true;
    player.skillRuntime.stackCommitted = Boolean(player.isAllIn);
    return true;
  }

  tryBotTurnSkill(room, player) {
    if (!player?.isBot || !isSkillEnabled(room?.skillMode)) return null;
    const cards = player.cards || [];
    const values = cards.map((card) => Number(card?.value) || 0);
    const strongHolding =
      cards.length === 2 &&
      (cards[0].rank === cards[1].rank || values.filter((value) => value >= 10).length === 2 || Math.max(...values) >= 14);
    const priorities = strongHolding
      ? ["BLOOD_BATTLE", "DEFENSE", "DEEP_BREATH"]
      : ["DEFENSE", "DEEP_BREATH", "BLOOD_BATTLE"];

    for (const skillId of priorities) {
      if (!hasEquipped(player, skillId)) continue;
      const validation = this.validateUse(room, player, skillId, {});
      if (!validation.ok) continue;
      const result = this.requestUse(room, player, {
        skillId,
        target: {},
        requestId: `bot_${crypto.randomUUID()}`,
      });
      return { skillId, ...result };
    }
    return null;
  }

  applySettlementModifiers(room, { reason, winner, tie = false, winnerCategory = null } = {}) {
    const details = {
      baseTransfer: 0,
      finalTransfer: 0,
      multiplier: 1,
      selfSkillMultiplier: 1,
      opponentSkillMultiplier: 1,
      baseRuleMultiplier: 1,
      effects: [],
    };
    if (!isSkillEnabled(room.skillMode) || tie || !winner) return details;
    const loser = opponentOf(room, winner);
    if (!loser) return details;
    const baseTransfer = Math.max(0, winner.chips - (winner.skillRuntime?.handStartChips || winner.chips));
    let selfSkillMultiplier = 1;
    let opponentSkillMultiplier = 1;

    room.players.forEach((player) => {
      if (!player.skillRuntime?.bloodBattleActive) return;
      const factor = SKILL_CONFIG.BLOOD_BATTLE_MULTIPLIER;
      if (player.playerId === winner.playerId) selfSkillMultiplier *= factor;
      else opponentSkillMultiplier *= factor;
      details.effects.push({ skillId: "BLOOD_BATTLE", factor, source: player.playerId === winner.playerId ? "self" : "opponent" });
    });
    if (winner.skillRuntime?.desperationActive) {
      selfSkillMultiplier *= SKILL_CONFIG.DESPERATION_WIN_MULTIPLIER;
      details.effects.push({ skillId: "DESPERATION", factor: SKILL_CONFIG.DESPERATION_WIN_MULTIPLIER, source: "self" });
    }
    if (reason === "fold" && winner.skillRuntime?.deadEndActive) {
      selfSkillMultiplier *= SKILL_CONFIG.DEAD_END_FOLD_MULTIPLIER;
      details.effects.push({ skillId: "DEAD_END", factor: SKILL_CONFIG.DEAD_END_FOLD_MULTIPLIER, source: "self" });
    }

    if (reason === "showdown" && selfSkillMultiplier === 1) {
      equippedProtocols(winner).forEach((skill) => {
        if (!protocolMatchesCategory(skill.protocolCategory, winnerCategory)) return;
        selfSkillMultiplier *= SKILL_CONFIG.PROTOCOL_WIN_MULTIPLIER;
        details.effects.push({ skillId: skill.id, factor: SKILL_CONFIG.PROTOCOL_WIN_MULTIPLIER, source: "self" });
      });
    }

    let multiplier = selfSkillMultiplier * opponentSkillMultiplier;
    if (loser.skillRuntime?.defenseActive && !loser.skillRuntime.foldedThisHand) {
      multiplier *= 0.5;
      details.effects.push({ skillId: "DEFENSE", factor: 0.5, source: "opponent" });
      loser.skillRuntime.defenseRevealed = true;
      confirmPublicSkill(loser, "DEFENSE");
      this.emitToRoom(room, "skill:resolved", {
        skillId: "DEFENSE",
        casterId: loser.playerId,
        status: "REVEALED",
        publicSummary: `${loser.name} 的「防守」将公开损失减半`,
      });
    }

    const desiredTransfer = Math.max(0, Math.floor(baseTransfer * multiplier));
    if (desiredTransfer > baseTransfer) {
      const extra = Math.min(desiredTransfer - baseTransfer, loser.chips);
      loser.chips -= extra;
      winner.chips += extra;
    } else if (desiredTransfer < baseTransfer) {
      const refund = Math.min(baseTransfer - desiredTransfer, winner.chips);
      winner.chips -= refund;
      loser.chips += refund;
    }
    details.baseTransfer = baseTransfer;
    details.finalTransfer = Math.max(0, winner.chips - (winner.skillRuntime?.handStartChips || winner.chips));
    details.multiplier = multiplier;
    details.selfSkillMultiplier = selfSkillMultiplier;
    details.opponentSkillMultiplier = opponentSkillMultiplier;
    room.skillState.settlement = details;
    return details;
  }

  getNullifiedSet(room, player = null) {
    return evaluationExcludedCodes(room, player);
  }

  buildRevealExtras(room, { includeLoadouts = false } = {}) {
    const state = room.skillState || createRoomSkillState();
    updateNullifiedCodes(room);
    return {
      burnedCards: (state.burnedCards || []).map(cloneCard),
      removedCards: (state.removedCards || []).map(cloneCard),
      nullifications: (state.nullifications || []).map((entry) => ({ ...entry })),
      nullifiedCommunityCardIds: [...new Set((state.nullifications || []).map((entry) => entry.cardCode).filter(Boolean))],
      skillTransforms: (state.transformations || []).map((entry) => JSON.parse(JSON.stringify(entry))),
      skillActions: (state.skillActionLog || []).map((entry) => JSON.parse(JSON.stringify(entry))),
      equippedSkills: includeLoadouts
        ? room.players.map((player) => ({
          playerId: player.playerId,
          skillIds: [...(player.skillRuntime?.equippedSkillIds || [])],
        }))
        : [],
      finalZones: {
        communityCards: (room.communityCards || []).map(cloneCard),
        playerCards: room.players.map((player) => ({
          playerId: player.playerId,
          cards: (player.cards || []).map(cloneCard),
        })),
        remainingDeck: (room.deck || []).map(cloneCard),
      },
      skillSettlement: state.settlement ? JSON.parse(JSON.stringify(state.settlement)) : null,
    };
  }

  applyForkDuringDeal(room) {
    const burned = room.deck.pop();
    if (burned) room.skillState?.burnedCards?.push(burned);
    return room.deck.pop();
  }
}

function endHandSkills(room, result = {}) {
  // Tests and engine share the same settlement path via a lightweight engine
  // when no live socket context exists.
  const engine = room.__skillEngineForTests instanceof SkillEngine
    ? room.__skillEngineForTests
    : new SkillEngine({ random: room.__skillRandom || Math.random });
  engine.endHand(room, result);
}

module.exports = {
  SkillEngine,
  FORTUNE_COMBOS,
  FORTUNE_CONFIG,
  getFutureCommunitySlots,
  updateNullifiedCodes,
  initPlayerForSkillMode,
  setPlayerLoadout,
  autoConfirmBotLoadouts,
  allLoadoutsConfirmed,
  beginHandSkills,
  onStreetPhaseChanged,
  onPlayerFolded,
  endHandSkills,
  clearPersistentSkillState,
  getPublicSkillSummary,
  getSelfSkillSummary,
  getPublicRoomSkillSnapshot,
  validateLoadout,
  listSkillDefinitions,
  evaluationExcludedCodes,
};
