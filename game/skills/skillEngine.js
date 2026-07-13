const crypto = require("crypto");
const { SKILL_CONFIG } = require("../skillConfig");
const { isSkillEnabled } = require("../skillModes");
const {
  getSkillDefinition,
  isActiveSkill,
  isCardEditSkill,
  isInformationSkill,
  isReactionSkill,
} = require("./definitions");
const {
  createRoomSkillState,
  resetPlayerSkillsForGame,
  resetPlayerSkillsForHand,
  resetRoomSkillsForHand,
  clearSkillTimers,
  validateLoadout,
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
} = require("./skillState");

function otherPlayer(room, player) {
  return room.players.find((p) => p.playerId !== player.playerId) || null;
}

function cardCode(card) {
  return typeof card === "string" ? card : card?.code;
}

function ensureRoomSkillState(room) {
  if (!room.skillState) room.skillState = createRoomSkillState();
  return room.skillState;
}

function appendSkillLog(room, entry) {
  ensureRoomSkillState(room).skillActionLog.push({ at: Date.now(), ...entry });
}

function rememberProcessedRequest(state, playerId, requestId) {
  const key = `${playerId}:${requestId}`;
  if (state.processedRequestIds.has(key)) return false;
  state.processedRequestIds.add(key);
  while (state.processedRequestIds.size > 256) {
    state.processedRequestIds.delete(state.processedRequestIds.values().next().value);
  }
  return true;
}

function initPlayerForSkillMode(player, skillMode) {
  if (!isSkillEnabled(skillMode)) {
    player.skillRuntime = null;
    return;
  }
  if (!player.skillRuntime) {
    resetPlayerSkillsForGame(player);
  }
}

function setPlayerLoadout(player, skillIds) {
  const checked = validateLoadout(skillIds);
  if (!checked.ok) return checked;
  if (!player.skillRuntime) resetPlayerSkillsForGame(player);
  player.skillRuntime.equippedSkillIds = checked.skillIds;
  player.skillRuntime.loadoutConfirmed = true;
  return { ok: true, skillIds: checked.skillIds, totalLoad: checked.totalLoad };
}

function autoConfirmBotLoadouts(room) {
  if (!isSkillEnabled(room.skillMode)) return;
  for (const player of room.players) {
    if (!player.isBot) continue;
    initPlayerForSkillMode(player, room.skillMode);
    if (!player.skillRuntime.loadoutConfirmed) {
      setPlayerLoadout(player, pickDefaultBotLoadout());
    }
  }
}

function allLoadoutsConfirmed(room) {
  if (!isSkillEnabled(room.skillMode)) return true;
  return room.players.every((p) => p.skillRuntime?.loadoutConfirmed);
}

function beginHandSkills(room) {
  if (!isSkillEnabled(room.skillMode)) return;
  ensureRoomSkillState(room);
  resetRoomSkillsForHand(room);
  for (const player of room.players) {
    if (!player.skillRuntime) resetPlayerSkillsForGame(player);
    resetPlayerSkillsForHand(player);
    if (room.handNo <= 1) {
      player.skillRuntime.abyssEnergy = SKILL_CONFIG.INITIAL_ABYSS_ENERGY;
      player.skillRuntime.skillUsesThisGame = {};
      player.skillRuntime.adversityCounter = 0;
    } else {
      gainEnergy(player, SKILL_CONFIG.ENERGY_GAIN_PER_HAND, { bonus: false });
    }
    applyAdversityAtHandStart(room, player);
  }
}

function applyAdversityAtHandStart(room, player) {
  if (!hasEquipped(player, "ADVERSITY_CIRCUIT")) return;
  const opponent = otherPlayer(room, player);
  if (!opponent) return;
  const threshold = opponent.chips * SKILL_CONFIG.ADVERSITY_CHIP_RATIO;
  if (player.chips <= threshold) {
    player.skillRuntime.adversityCounter += 1;
    if (player.skillRuntime.adversityCounter >= SKILL_CONFIG.ADVERSITY_HANDS_PER_ENERGY) {
      player.skillRuntime.adversityCounter = 0;
      const gained = gainEnergy(player, 1, { bonus: true });
      if (gained > 0) {
        appendSkillLog(room, {
          skillId: "ADVERSITY_CIRCUIT",
          casterId: player.playerId,
          status: "PASSIVE",
          publicSummary: "逆境回路触发：获得 1 点深渊能量",
        });
      }
    }
  } else {
    player.skillRuntime.adversityCounter = 0;
  }
}

function onStreetPhaseChanged(room, nextPhase) {
  if (!isSkillEnabled(room.skillMode)) return;
  const state = ensureRoomSkillState(room);
  state.silenceActive = false;
  for (const player of room.players) {
    if (!player.skillRuntime) continue;
    player.skillRuntime.activeSkillsUsedThisPhase = 0;
    player.skillRuntime.statusEffects = (player.skillRuntime.statusEffects || []).filter(
      (effect) => effect.persistAcrossPhase || effect.phase === nextPhase
    );
  }
  if (nextPhase === "turn") {
    for (const player of room.players) {
      if (!hasEquipped(player, "ABYSS_BREATH")) continue;
      if (!player.skillRuntime.hasUsedActiveThisHand) {
        player.skillRuntime.breathEligible = true;
      }
    }
  }
}

function onPlayerFolded(player) {
  if (!player?.skillRuntime) return;
  player.skillRuntime.foldedThisHand = true;
  player.skillRuntime.breathEligible = false;
}

function onPlayerPokerAction(player) {
  if (!player?.skillRuntime) return;
  if (!player.skillRuntime.firstStreetActionTaken) {
    player.skillRuntime.firstStreetActionTaken = true;
  }
}

function endHandSkills(room, { reason, winner, tie } = {}) {
  if (!isSkillEnabled(room.skillMode)) return;
  for (const player of room.players) {
    if (!player.skillRuntime) continue;
    if (
      hasEquipped(player, "ABYSS_BREATH") &&
      player.skillRuntime.breathEligible &&
      !player.skillRuntime.foldedThisHand
    ) {
      const gained = gainEnergy(player, 1, { bonus: true });
      if (gained > 0) {
        appendSkillLog(room, {
          skillId: "ABYSS_BREATH",
          casterId: player.playerId,
          status: "PASSIVE",
          publicSummary: "深呼吸触发：获得 1 点深渊能量",
        });
      }
      player.skillRuntime.breathEligible = false;
    }
    if (reason === "showdown" && !tie && winner && player.playerId !== winner.playerId) {
      if (!player.skillRuntime.foldedThisHand) {
        gainEnergy(player, SKILL_CONFIG.SHOWDOWN_LOSER_BONUS, { bonus: true });
      }
    }
  }
  clearSkillTimers(room);
}

function isPokerLockedBySkills(room) {
  if (!isSkillEnabled(room.skillMode)) return false;
  const state = room.skillState;
  if (!state) return false;
  return Boolean(state.pendingSkill || state.reactionWindow || state.skillChoice);
}

function buildScanResult(opponentCards) {
  const [a, b] = opponentCards;
  const facts = [
    { key: "pocket_pair", text: a.rank === b.rank ? "对手是口袋对子" : "对手不是口袋对子" },
    { key: "suited", text: a.suit === b.suit ? "对手是同花底牌" : "对手不是同花底牌" },
    {
      key: "has_ace",
      text: a.rank === "A" || b.rank === "A" ? "对手至少有一张 A" : "对手没有 A",
    },
    {
      key: "has_broadway",
      text: ["J", "Q", "K", "A"].includes(a.rank) || ["J", "Q", "K", "A"].includes(b.rank)
        ? "对手至少有一张高张（J/Q/K/A）"
        : "对手没有高张（J/Q/K/A）",
    },
    {
      key: "connected",
      text: Math.abs(a.value - b.value) === 1 || (a.rank === "A" && b.rank === "2") || (b.rank === "A" && a.rank === "2")
        ? "对手两张底牌点数相连"
        : "对手两张底牌点数不相连",
    },
    {
      key: "gap_le_2",
      text: Math.abs(a.value - b.value) <= 2 ? "对手两张底牌点数差不超过 2" : "对手两张底牌点数差超过 2",
    },
  ];
  return facts[crypto.randomInt(facts.length)];
}

class SkillEngine {
  constructor({ gameEngine }) {
    this.gameEngine = gameEngine;
  }

  emit(room, event, payload) {
    this.gameEngine.emitToRoom(room, event, payload);
  }

  emitPlayer(player, event, payload) {
    this.gameEngine.emitToPlayer(player, event, payload);
  }

  broadcastSkillState(room) {
    if (!isSkillEnabled(room.skillMode)) return;
    const publicRoom = getPublicRoomSkillSnapshot(room);
    for (const player of room.players) {
      this.emitPlayer(player, "skill:state", {
        skillMode: room.skillMode,
        room: publicRoom,
        self: getPublicSkillSummary(player),
        players: room.players.map((p) => ({
          playerId: p.playerId,
          ...getPublicSkillSummary(p),
        })),
      });
    }
    this.gameEngine.broadcastRoomState(room);
  }

  validateUse(room, player, skillId, target = {}) {
    if (!isSkillEnabled(room.skillMode)) return { ok: false, error: "当前房间未启用技能" };
    const state = ensureRoomSkillState(room);
    if (state.pendingSkill || state.reactionWindow || state.skillChoice) {
      return { ok: false, error: "当前有技能流程进行中" };
    }
    const skill = getSkillDefinition(skillId);
    if (!skill) return { ok: false, error: "未知技能" };
    if (!hasEquipped(player, skill.id)) return { ok: false, error: "未装备该技能" };
    if (isReactionSkill(skill)) return { ok: false, error: "反制技能只能在反制窗口使用" };
    if (!isActiveSkill(skill)) return { ok: false, error: "被动技能不能主动发动" };
    if (room.players.some((p) => p.isAllIn)) {
      return { ok: false, error: "任一玩家 All In 后不能发动新的主动技能" };
    }
    if (player.status === "folded") return { ok: false, error: "已弃牌不能发动技能" };
    if (player.skillRuntime.nextHandSkillLocked) {
      return { ok: false, error: "过载代价：本手不能发动主动技能" };
    }
    if (state.silenceActive) return { ok: false, error: "静默区内不能发动主动技能" };

    const phase = room.phase;
    const allowed = skill.allowedPhases || [];
    if (allowed.length && !allowed.includes(phase)) {
      return { ok: false, error: "当前阶段不能发动该技能" };
    }
    if (skill.requiresActionTurn && room.players[room.currentPlayerIndex]?.playerId !== player.playerId) {
      return { ok: false, error: "未轮到你的行动窗口" };
    }
    if (skill.requiresBeforeFirstAction && player.skillRuntime.firstStreetActionTaken) {
      return { ok: false, error: "必须在第一次下注行动之前发动" };
    }

    const uses = getRemainingUses(player, skill);
    if (uses.handLeft === 0) return { ok: false, error: "本手使用次数已耗尽" };
    if (uses.gameLeft === 0) return { ok: false, error: "本场使用次数已耗尽" };

    if (player.skillRuntime.activeSkillsUsedThisPhase >= SKILL_CONFIG.MAX_ACTIVE_SKILLS_PER_PHASE) {
      return { ok: false, error: "本阶段主动技能次数已用完" };
    }
    if (player.skillRuntime.activeSkillsUsedThisHand >= SKILL_CONFIG.MAX_ACTIVE_SKILLS_PER_HAND) {
      return { ok: false, error: "本手主动技能次数已用完" };
    }
    if (isCardEditSkill(skill) && player.skillRuntime.successfulCardEditThisHand) {
      return { ok: false, error: "本手已成功发动过牌面改写技能" };
    }
    if (
      isCardEditSkill(skill) &&
      room.players.some((p) => p.skillRuntime?.successfulCardEditThisHand)
    ) {
      return { ok: false, error: "本手已有牌面改写技能成功结算" };
    }

    const cost = getEffectiveEnergyCost(player, skill);
    if (player.skillRuntime.abyssEnergy < cost) return { ok: false, error: "深渊能量不足" };

    if (skill.id === "NULLIFICATION_PROTOCOL") {
      const code = target?.cardCode;
      if (!code) return { ok: false, error: "请选择一张公共牌" };
      const exists = room.communityCards.some((c) => cardCode(c) === code);
      if (!exists) return { ok: false, error: "只能零化已公开的公共牌" };
      if (state.nullifiedCommunityCardIds.includes(code)) {
        return { ok: false, error: "该牌已被零化" };
      }
      const remainingCommunity = room.communityCards.length - 1;
      // At river there will be 5 community; need hole(2)+effective community >= 5 eventually.
      // Conservative: after nullify, final effective cards must allow 5-card hand.
      // With 2 hole + up to 5 community - nullified, need >= 5 total effective at end.
      // During flop (3) or turn (4), final board will be 5, so effective final = 5 - nullifiedCount.
      const futureNullified = state.nullifiedCommunityCardIds.length + 1;
      if (5 - futureNullified + 2 < 5) {
        return { ok: false, error: "零化后无法组成合法五张牌" };
      }
      void remainingCommunity;
    }

    if (skill.id === "MEMORY_REWRITE") {
      const idx = Number(target?.cardIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx > 1) {
        return { ok: false, error: "请选择要替换的底牌" };
      }
    }

    if (skill.id === "FORK_OBSERVATION") {
      if (!["before_turn", "before_river"].includes(phase)) {
        return { ok: false, error: "只能在转牌/河牌发出前发动" };
      }
    }

    return { ok: true, skill, cost };
  }

  requestUse(room, player, { skillId, target = {}, requestId }) {
    const reqId = String(requestId || crypto.randomUUID());
    const state = ensureRoomSkillState(room);
    if (state.processedRequestIds.has(`${player.playerId}:${reqId}`)) {
      return { ok: true, duplicate: true, requestId: reqId };
    }

    const checked = this.validateUse(room, player, skillId, target);
    if (!checked.ok) return checked;

    const { skill, cost } = checked;
    if (!spendEnergy(player, cost)) return { ok: false, error: "深渊能量不足" };
    consumeOverloadDiscount(player, skill);
    markSkillUse(player, skill.id);
    player.skillRuntime.activeSkillsUsedThisPhase += 1;
    player.skillRuntime.activeSkillsUsedThisHand += 1;
    player.skillRuntime.hasUsedActiveThisHand = true;
    player.skillRuntime.breathEligible = false;

    const pending = {
      requestId: reqId,
      skillId: skill.id,
      casterId: player.playerId,
      target: { ...target },
      energyPaid: cost,
      status: "PENDING",
      createdAt: Date.now(),
    };
    state.pendingSkill = pending;
    rememberProcessedRequest(state, player.playerId, reqId);
    this.gameEngine.pauseActionTimerForSkill?.(room);

    this.emit(room, "skill:pending", {
      requestId: reqId,
      skillId: skill.id,
      casterId: player.playerId,
      canBeCountered: skill.canBeCountered,
    });

    if (skill.canBeCountered) {
      const opponent = otherPlayer(room, player);
      if (opponent && this.canOfferCounter(opponent)) {
        this.openReactionWindow(room, pending, opponent);
        this.broadcastSkillState(room);
        return { ok: true, requestId: reqId, pending: true };
      }
    }

    this.resolvePending(room, { countered: false });
    return { ok: true, requestId: reqId };
  }

  canOfferCounter(player) {
    if (!hasEquipped(player, "NEURAL_INTERRUPT")) return false;
    if (player.isAllIn || player.status === "folded") return false;
    const skill = getSkillDefinition("NEURAL_INTERRUPT");
    const uses = getRemainingUses(player, skill);
    if (uses.handLeft === 0 || uses.gameLeft === 0) return false;
    if (player.skillRuntime.abyssEnergy < skill.energyCost) return false;
    return true;
  }

  openReactionWindow(room, pending, responder) {
    const state = ensureRoomSkillState(room);
    const expiresAt = Date.now() + SKILL_CONFIG.REACTION_WINDOW_MS;
    state.reactionWindow = {
      skillId: pending.skillId,
      requestId: pending.requestId,
      casterId: pending.casterId,
      responderId: responder.playerId,
      expiresAt,
      status: "WAITING",
    };
    this.emit(room, "skill:reaction-window", {
      requestId: pending.requestId,
      skillId: pending.skillId,
      casterId: pending.casterId,
      responderId: responder.playerId,
      expiresAt,
      durationMs: SKILL_CONFIG.REACTION_WINDOW_MS,
    });

    if (responder.isBot) {
      state.reactionTimer = setTimeout(() => {
        if (Math.random() < 0.35) {
          this.requestCounter(room, responder, {
            requestId: pending.requestId,
            skillId: "NEURAL_INTERRUPT",
          });
        } else {
          this.expireReaction(room, pending.requestId);
        }
      }, 600);
    } else {
      state.reactionTimer = setTimeout(() => {
        this.expireReaction(room, pending.requestId);
      }, SKILL_CONFIG.REACTION_WINDOW_MS);
    }
    if (typeof state.reactionTimer.unref === "function") state.reactionTimer.unref();
  }

  expireReaction(room, requestId) {
    const state = room.skillState;
    if (!state?.reactionWindow || state.reactionWindow.requestId !== requestId) return;
    if (state.reactionWindow.status !== "WAITING") return;
    state.reactionWindow.status = "EXPIRED";
    this.emit(room, "skill:reaction-expired", { requestId });
    this.resolvePending(room, { countered: false });
  }

  requestCounter(room, player, { requestId, skillId }) {
    if (!isSkillEnabled(room.skillMode)) return { ok: false, error: "当前房间未启用技能" };
    const state = ensureRoomSkillState(room);
    const window = state.reactionWindow;
    if (!window || window.status !== "WAITING") return { ok: false, error: "当前没有反制窗口" };
    if (window.requestId !== requestId) return { ok: false, error: "反制目标不匹配" };
    if (window.responderId !== player.playerId) return { ok: false, error: "你不能反制此技能" };
    if (skillId !== "NEURAL_INTERRUPT") return { ok: false, error: "只能使用神经阻断反制" };
    if (!this.canOfferCounter(player)) return { ok: false, error: "无法发动神经阻断" };

    const skill = getSkillDefinition("NEURAL_INTERRUPT");
    if (!spendEnergy(player, skill.energyCost)) return { ok: false, error: "深渊能量不足" };
    markSkillUse(player, skill.id);
    window.status = "COUNTERED";
    if (state.reactionTimer) {
      clearTimeout(state.reactionTimer);
      state.reactionTimer = null;
    }
    this.resolvePending(room, { countered: true, counterPlayer: player });
    return { ok: true };
  }

  resolvePending(room, { countered, counterPlayer } = {}) {
    const state = ensureRoomSkillState(room);
    const pending = state.pendingSkill;
    if (!pending || pending.status !== "PENDING") return;
    pending.status = countered ? "COUNTERED" : "RESOLVING";

    if (state.reactionTimer) {
      clearTimeout(state.reactionTimer);
      state.reactionTimer = null;
    }
    state.reactionWindow = null;

    const caster = room.players.find((p) => p.playerId === pending.casterId);
    const skill = getSkillDefinition(pending.skillId);
    if (!caster || !skill) {
      state.pendingSkill = null;
      this.broadcastSkillState(room);
      return;
    }

    if (countered) {
      const maxTotalRefund = Math.max(0, pending.energyPaid - 1);
      const refund = Math.min(Math.floor(pending.energyPaid * 0.5), maxTotalRefund);
      if (refund > 0) gainEnergy(caster, refund, { bonus: false });
      let recycled = 0;
      if (hasEquipped(caster, "EMBER_RECYCLE") && !caster.skillRuntime.emberRecycleUsedThisHand) {
        const remainingRefund = Math.max(0, maxTotalRefund - refund);
        recycled = remainingRefund > 0
          ? gainEnergy(caster, Math.min(1, remainingRefund), { bonus: true })
          : 0;
        caster.skillRuntime.emberRecycleUsedThisHand = true;
        if (recycled > 0) {
          appendSkillLog(room, {
            skillId: "EMBER_RECYCLE",
            casterId: caster.playerId,
            status: "PASSIVE",
            publicSummary: "余烬回收触发：额外返还 1 点深渊能量",
          });
        }
      }
      const logEntry = {
        at: Date.now(),
        skillId: skill.id,
        casterId: caster.playerId,
        status: "COUNTERED",
        publicSummary: `${skill.name} 被神经阻断取消`,
        counterPlayerId: counterPlayer?.playerId || null,
        energyPaid: pending.energyPaid,
        energyRefunded: refund,
        energyRecycled: recycled,
      };
      state.skillActionLog.push(logEntry);
      this.emit(room, "skill:resolved", {
        requestId: pending.requestId,
        skillId: skill.id,
        casterId: caster.playerId,
        status: "COUNTERED",
        publicSummary: logEntry.publicSummary,
      });
      this.emit(room, "skill:failed", {
        requestId: pending.requestId,
        skillId: skill.id,
        reason: "countered",
      });
      state.pendingSkill = null;
      this.broadcastSkillState(room);
      if (state.preDealWindow) this.gameEngine.continuePreDeal?.(room);
      else this.gameEngine.resumeActionTimerAfterSkill?.(room);
      return;
    }

    const result = this.executeEffect(room, caster, skill, pending.target, pending);
    const logEntry = {
      at: Date.now(),
      skillId: skill.id,
      casterId: caster.playerId,
      status: result.ok ? "SUCCESS" : "FAILED",
      publicSummary: result.publicSummary || `${skill.name} 已结算`,
      private: result.privatePayload || null,
    };
    state.skillActionLog.push(logEntry);
    this.emit(room, "skill:resolved", {
      requestId: pending.requestId,
      skillId: skill.id,
      casterId: caster.playerId,
      status: logEntry.status,
      publicSummary: logEntry.publicSummary,
      publicData: result.publicData || null,
    });
    if (result.privatePayload) {
      this.emitPlayer(caster, "skill:private-result", {
        requestId: pending.requestId,
        skillId: skill.id,
        ...result.privatePayload,
      });
    }
    state.pendingSkill = null;
    this.broadcastSkillState(room);
    if (result.needsChoice) {
      // choice window opened inside executeEffect
      return;
    }
    this.gameEngine.emitPrivateHandHints?.(room);
    this.gameEngine.resumeActionTimerAfterSkill?.(room);
  }

  executeEffect(room, caster, skill, target, pending) {
    const state = ensureRoomSkillState(room);
    switch (skill.id) {
      case "ECHO_SCAN":
        return this.effectEchoScan(room, caster);
      case "PROBABILITY_CLOAK":
        caster.skillRuntime.statusEffects.push({
          type: "CLOAK",
          phase: room.phase,
          persistAcrossPhase: false,
        });
        return { ok: true, publicSummary: "概率遮蔽已生效：本阶段情报扫描将被阻断" };
      case "OVERLOAD_CORE":
        caster.skillRuntime.overloadDiscount = { remainingUses: 1 };
        caster.skillRuntime.pendingOverloadLock = true;
        return { ok: true, publicSummary: "过载核心已启动：下一主动技能费用降低" };
      case "SILENCE_ZONE":
        state.silenceActive = true;
        return { ok: true, publicSummary: "静默区展开：本阶段禁止新的主动技能" };
      case "MEMORY_REWRITE":
        return this.effectMemoryRewrite(room, caster, target);
      case "QUANTUM_HOLE_CARDS":
        return this.effectQuantumStart(room, caster, pending);
      case "FORK_OBSERVATION":
        return this.effectForkStart(room, caster, pending);
      case "NULLIFICATION_PROTOCOL":
        return this.effectNullify(room, caster, target);
      default:
        return { ok: false, publicSummary: "未知技能效果" };
    }
  }

  effectEchoScan(room, caster) {
    const opponent = otherPlayer(room, caster);
    if (!opponent || !opponent.cards || opponent.cards.length < 2) {
      return { ok: false, publicSummary: "残响扫描失败：目标无效" };
    }
    const cloaked = (opponent.skillRuntime?.statusEffects || []).some(
      (e) => e.type === "CLOAK" && e.phase === room.phase
    );
    if (cloaked) {
      return {
        ok: true,
        publicSummary: "残响扫描已发动，但目标信号受到遮蔽",
        privatePayload: { cloaked: true, message: "目标信号受到遮蔽，本次扫描失败。" },
      };
    }
    const scan = buildScanResult(opponent.cards);
    return {
      ok: true,
      publicSummary: "残响扫描已完成（结果仅对发动者可见）",
      privatePayload: { cloaked: false, scan },
    };
  }

  effectMemoryRewrite(room, caster, target) {
    const state = ensureRoomSkillState(room);
    const idx = Number(target.cardIndex);
    const oldCard = caster.cards[idx];
    if (!oldCard) return { ok: false, publicSummary: "记忆重构失败：底牌无效" };
    if (!room.deck.length) return { ok: false, publicSummary: "记忆重构失败：牌堆不足" };
    const newCard = room.deck.pop();
    caster.cards[idx] = newCard;
    state.removedCards.push(oldCard);
    caster.skillRuntime.successfulCardEditThisHand = true;
    this.emitPlayer(caster, "your_cards", { cards: caster.cards });
    return {
      ok: true,
      publicSummary: "记忆重构：一名玩家替换了一张底牌",
      privatePayload: { removed: oldCard, drawn: newCard, cards: caster.cards },
    };
  }

  effectQuantumStart(room, caster, pending) {
    const state = ensureRoomSkillState(room);
    if (!room.deck.length) return { ok: false, publicSummary: "量子底牌失败：牌堆不足" };
    const extra = room.deck.pop();
    const options = [...caster.cards, extra];
    const expiresAt = Date.now() + SKILL_CONFIG.SKILL_CHOICE_TIMEOUT_MS;
    state.skillChoice = {
      type: "QUANTUM_SELECT",
      skillId: "QUANTUM_HOLE_CARDS",
      playerId: caster.playerId,
      requestId: pending.requestId,
      options,
      originalCards: [...caster.cards],
      extra,
      expiresAt,
    };
    caster.skillRuntime.successfulCardEditThisHand = true;
    this.emitPlayer(caster, "skill:private-result", {
      requestId: pending.requestId,
      skillId: "QUANTUM_HOLE_CARDS",
      choiceType: "QUANTUM_SELECT",
      options,
      expiresAt,
    });
    this.emit(room, "skill:choice-window", {
      skillId: "QUANTUM_HOLE_CARDS",
      playerId: caster.playerId,
      expiresAt,
    });
    state.choiceTimer = setTimeout(() => {
      this.resolveSkillChoice(room, caster, { timeout: true });
    }, SKILL_CONFIG.SKILL_CHOICE_TIMEOUT_MS);
    if (typeof state.choiceTimer.unref === "function") state.choiceTimer.unref();

    if (caster.isBot) {
      setTimeout(() => {
        this.resolveSkillChoice(room, caster, { keepIndexes: [0, 1] });
      }, 400);
    }
    return {
      ok: true,
      needsChoice: true,
      publicSummary: "量子底牌：玩家正在从三张牌中选择两张",
    };
  }

  effectForkStart(room, caster, pending) {
    const state = ensureRoomSkillState(room);
    if (room.deck.length < 2) return { ok: false, publicSummary: "分岔观测失败：牌堆不足" };
    // Upcoming community card sits under the burn card at the pop end.
    const upcoming = room.deck[room.deck.length - 2];
    const expiresAt = Date.now() + SKILL_CONFIG.SKILL_CHOICE_TIMEOUT_MS;
    state.skillChoice = {
      type: "FORK_DECISION",
      skillId: "FORK_OBSERVATION",
      playerId: caster.playerId,
      requestId: pending.requestId,
      upcoming,
      expiresAt,
    };
    caster.skillRuntime.successfulCardEditThisHand = true;
    this.emitPlayer(caster, "skill:private-result", {
      requestId: pending.requestId,
      skillId: "FORK_OBSERVATION",
      choiceType: "FORK_DECISION",
      upcoming,
      expiresAt,
    });
    this.emit(room, "skill:choice-window", {
      skillId: "FORK_OBSERVATION",
      playerId: caster.playerId,
      expiresAt,
    });
    state.choiceTimer = setTimeout(() => {
      this.resolveSkillChoice(room, caster, { timeout: true, decision: "keep" });
    }, SKILL_CONFIG.SKILL_CHOICE_TIMEOUT_MS);
    if (typeof state.choiceTimer.unref === "function") state.choiceTimer.unref();

    if (caster.isBot) {
      setTimeout(() => {
        this.resolveSkillChoice(room, caster, { decision: "keep" });
      }, 400);
    }
    return {
      ok: true,
      needsChoice: true,
      publicSummary: "分岔观测：玩家正在决定是否烧牌",
    };
  }

  effectNullify(room, caster, target) {
    const state = ensureRoomSkillState(room);
    const code = target.cardCode;
    state.nullifiedCommunityCardIds.push(code);
    caster.skillRuntime.successfulCardEditThisHand = true;
    return {
      ok: true,
      publicSummary: `零化协议：公共牌 ${code} 已被零化`,
      publicData: { nullifiedCommunityCardIds: [...state.nullifiedCommunityCardIds] },
    };
  }

  resolveSkillChoice(room, player, payload = {}) {
    const state = ensureRoomSkillState(room);
    const choice = state.skillChoice;
    if (!choice || choice.playerId !== player.playerId) {
      return { ok: false, error: "当前没有待处理的技能选择" };
    }
    if (state.choiceTimer) {
      clearTimeout(state.choiceTimer);
      state.choiceTimer = null;
    }

    if (choice.type === "QUANTUM_SELECT") {
      let keepIndexes = payload.keepIndexes;
      if (payload.timeout || !Array.isArray(keepIndexes)) {
        keepIndexes = [0, 1]; // keep original hole cards
      }
      keepIndexes = keepIndexes
        .map(Number)
        .filter((i) => Number.isInteger(i) && i >= 0 && i <= 2);
      if (new Set(keepIndexes).size !== 2) keepIndexes = [0, 1];
      const kept = keepIndexes.map((i) => choice.options[i]);
      const discarded = choice.options.find((_, i) => !keepIndexes.includes(i));
      player.cards = kept;
      if (discarded) state.removedCards.push(discarded);
      state.skillChoice = null;
      const publicSummary = payload.timeout
        ? "量子底牌超时：保留原底牌"
        : "量子底牌：选择已完成";
      appendSkillLog(room, {
        requestId: choice.requestId,
        skillId: "QUANTUM_HOLE_CARDS",
        casterId: player.playerId,
        status: "CHOICE_RESOLVED",
        publicSummary,
      });
      this.emitPlayer(player, "your_cards", { cards: player.cards });
      this.emit(room, "skill:resolved", {
        requestId: choice.requestId,
        skillId: "QUANTUM_HOLE_CARDS",
        casterId: player.playerId,
        status: "SUCCESS",
        publicSummary,
      });
      this.broadcastSkillState(room);
      this.gameEngine.emitPrivateHandHints?.(room);
      this.gameEngine.resumeActionTimerAfterSkill?.(room);
      return { ok: true };
    }

    if (choice.type === "FORK_DECISION") {
      const decision = payload.decision === "burn" ? "burn" : "keep";
      choice.decision = decision;
      // Actual burn/deal applied when street deals; stash decision.
      state.pendingForkDecision = {
        playerId: player.playerId,
        decision,
        upcomingCode: cardCode(choice.upcoming),
      };
      state.skillChoice = null;
      const publicSummary = decision === "burn" ? "分岔观测：选择舍弃该牌" : "分岔观测：选择保留该牌";
      appendSkillLog(room, {
        requestId: choice.requestId,
        skillId: "FORK_OBSERVATION",
        casterId: player.playerId,
        status: "CHOICE_RESOLVED",
        publicSummary,
      });
      this.emit(room, "skill:resolved", {
        requestId: choice.requestId,
        skillId: "FORK_OBSERVATION",
        casterId: player.playerId,
        status: "SUCCESS",
        publicSummary,
        publicData: { decision },
      });
      this.broadcastSkillState(room);
      // Continue pre-deal if waiting
      if (state.preDealWindow) {
        this.gameEngine.continuePreDeal?.(room);
      } else {
        this.gameEngine.resumeActionTimerAfterSkill?.(room);
      }
      return { ok: true };
    }

    return { ok: false, error: "未知选择类型" };
  }

  /**
   * Apply fork decision while dealing turn/river.
   * Normal order: burn, then community card.
   * If burn decision: burn, discard upcoming, deal next.
   */
  applyForkDuringDeal(room) {
    const state = room.skillState;
    if (!state?.pendingForkDecision) {
      const burned = room.deck.pop();
      if (state && burned) state.burnedCards.push(burned);
      return room.deck.pop(); // deal
    }
    const decision = state.pendingForkDecision.decision;
    state.pendingForkDecision = null;
    const standardBurn = room.deck.pop();
    if (standardBurn) state.burnedCards.push(standardBurn);
    if (decision === "burn") {
      const discarded = room.deck.pop();
      state.burnedCards.push(discarded);
      return room.deck.pop();
    }
    return room.deck.pop();
  }

  getNullifiedSet(room) {
    return new Set(room.skillState?.nullifiedCommunityCardIds || []);
  }

  getEffectiveCommunityCards(room) {
    const nullified = this.getNullifiedSet(room);
    return (room.communityCards || []).filter((c) => !nullified.has(cardCode(c)));
  }

  buildRevealExtras(room) {
    if (!isSkillEnabled(room.skillMode)) return {};
    const state = room.skillState || createRoomSkillState();
    return {
      skillMode: room.skillMode,
      skillActions: [...(state.skillActionLog || [])].map((e) => ({
        at: e.at,
        skillId: e.skillId,
        casterId: e.casterId,
        status: e.status,
        publicSummary: e.publicSummary,
      })),
      burnedCards: [...(state.burnedCards || [])],
      removedCards: [...(state.removedCards || [])],
      nullifiedCards: [...(state.nullifiedCommunityCardIds || [])],
      finalDeckCursor: room.deck?.length ?? null,
    };
  }

  restorePrivateState(room, player) {
    if (!isSkillEnabled(room.skillMode)) return;
    const choice = room.skillState?.skillChoice;
    if (!choice || choice.playerId !== player.playerId) return;
    if (choice.type === "QUANTUM_SELECT") {
      this.emitPlayer(player, "skill:private-result", {
        requestId: choice.requestId,
        skillId: choice.skillId,
        choiceType: choice.type,
        options: choice.options,
        expiresAt: choice.expiresAt,
        restored: true,
      });
    } else if (choice.type === "FORK_DECISION") {
      this.emitPlayer(player, "skill:private-result", {
        requestId: choice.requestId,
        skillId: choice.skillId,
        choiceType: choice.type,
        upcoming: choice.upcoming,
        expiresAt: choice.expiresAt,
        restored: true,
      });
    }
  }
}

module.exports = {
  SkillEngine,
  initPlayerForSkillMode,
  setPlayerLoadout,
  autoConfirmBotLoadouts,
  allLoadoutsConfirmed,
  beginHandSkills,
  onStreetPhaseChanged,
  onPlayerFolded,
  onPlayerPokerAction,
  endHandSkills,
  isPokerLockedBySkills,
  validateLoadout,
  getPublicSkillSummary,
  getPublicRoomSkillSnapshot,
  ensureRoomSkillState,
};
