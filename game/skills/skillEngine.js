const crypto = require("crypto");
const { createDeck } = require("../../utils/deck");
const { isSkillEnabled } = require("../skillModes");
const { SKILL_CONFIG } = require("../skillConfig");
const {
  getSkillDefinition,
  listSkillDefinitions,
  isActiveSkill,
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
  syncVisibleEnergy,
  hasEquipped,
  getPublicSkillSummary,
  getSelfSkillSummary,
  getPublicRoomSkillSnapshot,
  markSkillUse,
  markSkillEvent,
  getRemainingUses,
} = require("./skillState");

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

function chanceByDisadvantage(room, player, base, maximum) {
  return base + (maximum - base) * getDisadvantageSeverity(room, player);
}

function getFutureCommunitySlots(room) {
  const deck = room?.deck || [];
  const boardCount = Math.max(0, Math.min(5, room?.communityCards?.length || 0));
  let pointer = deck.length - 1;
  const slots = [];

  if (boardCount < 3) {
    pointer -= 1; // burn before flop
    for (let boardIndex = boardCount; boardIndex < 3; boardIndex += 1) {
      if (pointer < 0) return slots;
      slots.push({ boardIndex, deckIndex: pointer, card: deck[pointer] });
      pointer -= 1;
    }
  }
  if (boardCount < 4) {
    pointer -= 1; // burn before turn
    if (pointer >= 0) {
      slots.push({ boardIndex: 3, deckIndex: pointer, card: deck[pointer] });
      pointer -= 1;
    }
  }
  if (boardCount < 5) {
    pointer -= 1; // burn before river
    if (pointer >= 0) slots.push({ boardIndex: 4, deckIndex: pointer, card: deck[pointer] });
  }
  return slots;
}

function updateNullifiedCodes(room) {
  const state = room.skillState || createRoomSkillState();
  state.nullifiedCommunityCardIds = (state.nullifications || [])
    .map((entry) => room.communityCards?.[entry.boardIndex]?.code)
    .filter(Boolean);
  (state.nullifications || []).forEach((entry) => {
    entry.revealed = Boolean(room.communityCards?.[entry.boardIndex]);
    entry.cardCode = room.communityCards?.[entry.boardIndex]?.code || entry.cardCode || null;
  });
  return state.nullifiedCommunityCardIds;
}

function buildFortuneCombos() {
  const suits = ["S", "H", "C", "D"];
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
  const combos = [];
  for (const rank of ranks) {
    for (let first = 0; first < suits.length - 1; first += 1) {
      for (let second = first + 1; second < suits.length; second += 1) {
        combos.push({ type: "POCKET_PAIR", codes: [suits[first] + rank, suits[second] + rank] });
      }
    }
  }
  for (let rankIndex = 0; rankIndex < ranks.length - 1; rankIndex += 1) {
    for (const suit of suits) {
      combos.push({
        type: "SUITED_CONNECTOR",
        codes: [suit + ranks[rankIndex], suit + ranks[rankIndex + 1]],
      });
    }
  }
  return Object.freeze(combos.map((combo) => Object.freeze({ ...combo, codes: Object.freeze(combo.codes) })));
}

const FORTUNE_COMBOS = buildFortuneCombos();

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
  const totalChips = room.players.reduce((sum, player) => sum + (Number(player.chips) || 0), 0);
  room.players.forEach((player) => {
    const runtime = player.skillRuntime;
    if (
      hasEquipped(player, "DESPERATION") &&
      player.chips < totalChips * SKILL_CONFIG.DESPERATION_CHIP_RATIO
    ) {
      runtime.desperationActive = true;
      markSkillEvent(player, "DESPERATION");
      room.skillState.skillActionLog.push({
        at: Date.now(), skillId: "DESPERATION", casterId: player.playerId,
        status: "TRIGGERED", secret: false, publicSummary: `${player.name} 进入绝境`,
      });
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

function endHandSkills(room, { reason, winner, tie = false } = {}) {
  if (!isSkillEnabled(room.skillMode)) return;
  const fairness = Boolean(room.skillState?.fairnessActive);
  room.players.forEach((player) => {
    const runtime = player.skillRuntime;
    if (!runtime) return;
    if (!fairness) {
      gainEnergy(player, SKILL_CONFIG.ENERGY_GAIN_PER_HAND);
      if (reason === "showdown" && !tie && winner && winner.playerId !== player.playerId) {
        gainEnergy(player, SKILL_CONFIG.SHOWDOWN_LOSER_BONUS);
      }
      if (runtime.breathArmed && !runtime.breathBroken) gainEnergy(player, 2);
      if (runtime.desperationActive && !tie && winner?.playerId === player.playerId) {
        gainEnergy(player, 1);
      }
    }
    syncVisibleEnergy(player);
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

  recordSkill(room, player, skill, {
    status = "SUCCESS", secret = false, publicSummary = null, target = null, audit = null,
  } = {}) {
    const entry = {
      at: Date.now(), skillId: skill.id, casterId: player.playerId,
      status, secret: Boolean(secret), publicSummary: publicSummary || `${player.name} 发动「${skill.name}」`,
      target: target ? JSON.parse(JSON.stringify(target)) : null,
      audit: audit ? JSON.parse(JSON.stringify(audit)) : null,
    };
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

  triggerRecycle(room, player, failedSkill, requestId) {
    const runtime = player.skillRuntime;
    if (!hasEquipped(player, "RECYCLE") || runtime.recycleUsedThisHand) return 0;
    runtime.recycleUsedThisHand = true;
    markSkillEvent(player, "RECYCLE");
    const restored = gainEnergy(player, 1);
    const recycle = getSkillDefinition("RECYCLE");
    this.recordSkill(room, player, recycle, {
      status: "TRIGGERED", secret: false,
      publicSummary: `${player.name} 触发「回收利用」`,
      audit: { failedSkillId: failedSkill.id, restored, requestId },
    });
    this.emitToRoom(room, "skill:resolved", {
      requestId, skillId: recycle.id, casterId: player.playerId, status: "TRIGGERED",
      publicSummary: `${player.name} 触发「回收利用」`,
    });
    return restored;
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
    if (skill.requiresFirstSkillEvent && runtime.skillEventsThisHand > 0) {
      return { ok: false, error: "公平必须是你本手的第一个技能事件" };
    }
    if (runtime.abyssEnergy < skill.energyCost) return { ok: false, error: "深渊能量不足" };

    if (skill.id === "DEEP_BREATH" && runtime.abyssEnergy > 4) {
      return { ok: false, error: "能量高于 4 时不能使用深呼吸" };
    }
    if (skill.id === "INTIMIDATION" && room.players.some((candidate) => contributionFor(candidate) > SKILL_CONFIG.FEAR_CONTRIBUTION_CAP)) {
      return { ok: false, error: "已有玩家本手投入超过 500，恐吓不能发动" };
    }
    if (skill.id === "DEFENSE" && runtime.facedAggressionThisPhase) {
      return { ok: false, error: "已面对本阶段首次主动加注，不能再发动防守" };
    }
    if (skill.id === "CHEAT" && room.communityCards.length >= 5) {
      return { ok: false, error: "河牌全部公布后千术不能发动" };
    }
    if (skill.id === "INTEL_ONE") {
      const zone = String(target.zone || "opponent").toLowerCase();
      if (zone === "opponent") {
        if (!opponentOf(room, player)?.cards?.length) {
          return { ok: false, error: "对手底牌尚未就绪" };
        }
      } else if (zone === "future") {
        const slots = getFutureCommunitySlots(room);
        if (slots.length <= 1) {
          return { ok: false, error: "未来公共牌仅剩一张，不能选择该情报目标" };
        }
        const boardIndex = asIndex(target.boardIndex);
        if (boardIndex == null || !slots.some((slot) => slot.boardIndex === boardIndex)) {
          return { ok: false, error: "请选择有效的未来公共牌位置" };
        }
      } else {
        return { ok: false, error: "请选择有效的情报目标" };
      }
    }
    if (skill.id === "NULLIFICATION") {
      const boardIndex = asIndex(target.boardIndex);
      if (boardIndex == null || boardIndex < 0 || boardIndex > 4) return { ok: false, error: "请选择有效的公共牌位置" };
      const existsNow = Boolean(room.communityCards[boardIndex]);
      const existsFuture = getFutureCommunitySlots(room).some((slot) => slot.boardIndex === boardIndex);
      if (!existsNow && !existsFuture) return { ok: false, error: "该公共牌位置当前不可指定" };
      if (room.skillState.nullifications.some((entry) => entry.boardIndex === boardIndex)) {
        return { ok: false, error: "该公共牌已经被零化" };
      }
    }
    if (skill.id === "DESTINY") {
      const cardCode = String(target.cardCode || "").toUpperCase();
      if (!CARD_CODE_RE.test(cardCode)) return { ok: false, error: "请选择精确有效的目标牌" };
      if (!getFutureCommunitySlots(room).some((slot) => slot.boardIndex === 4)) {
        return { ok: false, error: "未来河牌位置已经不存在" };
      }
      if (player.cards.some((card) => card.code === cardCode) || room.communityCards.some((card) => card.code === cardCode)) {
        return { ok: false, error: "目标牌已经由你明确可见，不能成为未来河牌" };
      }
    }
    if (skill.id === "CHEAT") {
      const ownIndex = asIndex(target.ownIndex);
      const zone = String(target.zone || "").toLowerCase();
      if (![0, 1].includes(ownIndex) || !player.cards?.[ownIndex]) {
        return { ok: false, error: "请选择自己的一张底牌" };
      }
      if (!["opponent", "community", "future", "next"].includes(zone)) return { ok: false, error: "请选择千术交换目标" };
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
    }
    return { ok: true, skill, cost: skill.energyCost };
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
    const { skill } = validation;

    if (!spendEnergy(player, skill.energyCost)) return { ok: false, error: "深渊能量不足" };
    room.skillState.processedRequestIds.add(requestId);
    markSkillUse(player, skill.id);
    markSkillEvent(player, skill.id);

    const opponent = opponentOf(room, player);
    if (opponent?.skillRuntime?.counterArmed) {
      opponent.skillRuntime.counterArmed = false;
      const restored = this.triggerRecycle(room, player, skill, requestId);
      player.skillRuntime.lockedThisHand = true;
      player.skillRuntime.lockReason = "COUNTER";
      this.recordSkill(room, player, skill, {
        status: "COUNTERED", secret: skill.visibility === "SECRET",
        publicSummary: `${player.name} 的技能被反制`, target,
        audit: { paidEnergy: skill.energyCost, recycledEnergy: restored },
      });
      this.emitToRoom(room, "skill:resolved", {
        requestId, skillId: "COUNTER", casterId: opponent.playerId, status: "TRIGGERED",
        publicSummary: `${opponent.name} 的「反制」生效`,
      });
      this.notifyPrivate(player, { skillId: skill.id, message: "技能被反制；本手后续技能已封锁。" });
      this.broadcastSkillState(room);
      this.gameEngine?.broadcastRoomState(room);
      return { ok: true, status: "COUNTERED" };
    }

    let resolution;
    try {
      resolution = this.resolveActiveSkill(room, player, opponent, skill, target, requestId);
    } catch (error) {
      const restored = this.triggerRecycle(room, player, skill, requestId);
      this.recordSkill(room, player, skill, {
        status: "FAILED", secret: true, target,
        publicSummary: `${player.name} 的技能结算失败`,
        audit: { reason: error.message, paidEnergy: skill.energyCost, recycledEnergy: restored },
      });
      this.notifyPrivate(player, { skillId: skill.id, message: `技能结算失败：${error.message}` });
      this.broadcastSkillState(room);
      return { ok: true, status: "FAILED" };
    }

    const result = resolution || {};
    this.recordSkill(room, player, skill, {
      status: result.status || "SUCCESS",
      secret: result.secret ?? skill.visibility === "SECRET",
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
        nullifiedCommunityCardIds: [...room.skillState.nullifiedCommunityCardIds],
      });
    }
    this.broadcastSkillState(room);
    this.gameEngine?.broadcastRoomState(room);
    return { ok: true, status: result.status || "SUCCESS" };
  }

  resolveActiveSkill(room, player, opponent, skill, target, requestId) {
    const runtime = player.skillRuntime;
    switch (skill.id) {
      case "DEEP_BREATH":
        runtime.breathArmed = true;
        return { publicSummary: `${player.name} 调整呼吸`, audit: { armed: true } };
      case "INTIMIDATION":
        room.skillState.noFoldActive = true;
        room.skillState.contributionCap = SKILL_CONFIG.FEAR_CONTRIBUTION_CAP;
        return { publicSummary: `${player.name} 发动「恐吓」：本手禁止弃牌，投入上限 500` };
      case "BLOOD_BATTLE":
        runtime.bloodBattleActive = true;
        return { publicSummary: `${player.name} 宣告「血战」` };
      case "DEFENSE":
        runtime.defenseActive = true;
        return { publicSummary: `${player.name} 建立「防守」` };
      case "TOP_SECRET":
        runtime.topSecretActive = true;
        return { secret: true, publicSummary: "秘密技能已结算", privateResult: { message: "绝密已生效：本手后续底牌情报与交换将被阻断。" } };
      case "COUNTER":
        runtime.counterArmed = true;
        return { secret: true, publicSummary: "秘密技能已结算", privateResult: { message: "反制已秘密布置。" } };
      case "FAIRNESS":
        room.skillState.fairnessActive = true;
        room.players.forEach((candidate) => {
          candidate.skillRuntime.lockedThisHand = true;
          candidate.skillRuntime.lockReason = "FAIRNESS";
        });
        return { publicSummary: `${player.name} 宣告「公平」：本手后续技能与能量恢复封锁` };
      case "INTEL_ONE":
        return this.resolveIntelOne(room, player, opponent, target, requestId);
      case "CHEAT":
        return this.resolveCheat(room, player, opponent, target);
      case "CLAIRVOYANCE":
        return this.resolveClairvoyance(room, player, opponent);
      case "NULLIFICATION":
        return this.resolveNullification(room, player, target);
      case "DESTINY":
        return this.resolveDestiny(room, player, opponent, target, requestId);
      default:
        throw new Error("技能尚未接入结算器");
    }
  }

  resolveIntelOne(room, player, opponent, target, requestId) {
    const zone = String(target.zone || "opponent").toLowerCase();
    if (zone === "opponent") {
      if (opponent?.skillRuntime?.topSecretActive) {
        const restored = this.triggerRecycle(room, player, getSkillDefinition("INTEL_ONE"), requestId);
        return {
          status: "FAILED", secret: true, publicSummary: "秘密技能已结算",
          privateResult: { message: "情报目标受到绝密保护，本次读取失败。" },
          audit: { reason: "TOP_SECRET", recycledEnergy: restored },
        };
      }
      const index = this.random() < 0.5 ? 0 : 1;
      const card = opponent?.cards?.[index];
      if (!card) throw new Error("对手底牌尚未就绪");
      return {
        secret: true, publicSummary: "秘密技能已结算",
        privateResult: { message: `情报壹：对手的一张底牌是 ${card.code}`, card: cloneCard(card), zone: "opponent" },
        audit: { zone: "opponent", cardIndex: index, cardCode: card.code },
      };
    }
    if (zone === "future") {
      const slots = getFutureCommunitySlots(room);
      if (slots.length <= 1) throw new Error("未来公共牌仅剩一张");
      const requested = asIndex(target.boardIndex);
      const slot = slots.find((candidate) => candidate.boardIndex === requested);
      if (!slot?.card) throw new Error("指定的未来公共牌不存在");
      return {
        secret: true, publicSummary: "秘密技能已结算",
        privateResult: { message: `情报壹：第 ${slot.boardIndex + 1} 张公共牌将是 ${slot.card.code}`, card: cloneCard(slot.card), zone: "future", boardIndex: slot.boardIndex },
        audit: { zone: "future", boardIndex: slot.boardIndex, cardCode: slot.card.code },
      };
    }
    throw new Error("未知情报目标");
  }

  resolveCheat(room, player, opponent, target) {
    const ownIndex = asIndex(target.ownIndex);
    const zone = String(target.zone || "").toLowerCase();
    const ownCard = player.cards?.[ownIndex];
    if (!ownCard) throw new Error("自己的目标底牌不存在");
    let otherCard = null;
    let otherLocation = null;
    let secret = true;
    let communityChanged = false;

    if (zone === "opponent") {
      if (opponent?.skillRuntime?.topSecretActive) throw new Error("对手底牌受到绝密保护");
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
      audit: transform, cardsChanged: true, communityChanged,
    };
  }

  resolveClairvoyance(room, _player, opponent) {
    const events = room.skillState.skillActionLog
      .filter((entry) => entry.casterId === opponent.playerId)
      .map((entry) => ({ skillId: entry.skillId, status: entry.status, at: entry.at }));
    return {
      secret: false,
      publicSummary: "灵视信号已建立",
      privateResult: {
        message: `灵视：对手真实能量 ${opponent.skillRuntime.abyssEnergy}；本手已结算技能事件 ${events.length} 次。`,
        opponentEnergy: opponent.skillRuntime.abyssEnergy,
        events,
      },
      audit: { observedEventCount: events.length },
    };
  }

  resolveNullification(room, player, target) {
    const boardIndex = asIndex(target.boardIndex);
    const revealed = Boolean(room.communityCards[boardIndex]);
    const entry = {
      boardIndex, casterId: player.playerId, revealed,
      announced: revealed,
      cardCode: room.communityCards[boardIndex]?.code || getFutureCommunitySlots(room).find((slot) => slot.boardIndex === boardIndex)?.card?.code || null,
    };
    room.skillState.nullifications.push(entry);
    updateNullifiedCodes(room);
    return {
      secret: !revealed,
      publicSummary: revealed ? `${player.name} 将第 ${boardIndex + 1} 张公共牌零化` : "秘密技能已结算",
      publicData: revealed ? { nullifiedCommunityCardIds: [...room.skillState.nullifiedCommunityCardIds] } : null,
      privateResult: !revealed ? { message: `零化已锁定未来第 ${boardIndex + 1} 张公共牌。` } : null,
      audit: entry,
    };
  }

  resolveDestiny(room, player, opponent, target, requestId) {
    const cardCode = String(target.cardCode || "").toUpperCase();
    if (opponent.cards.some((card) => card.code === cardCode)) {
      const restored = this.triggerRecycle(room, player, getSkillDefinition("DESTINY"), requestId);
      return {
        status: "FAILED", secret: true, publicSummary: "秘密技能已结算",
        privateResult: { message: "天命失败：目标牌当前在对手底牌中。" },
        audit: { targetCardCode: cardCode, reason: "OPPONENT_HOLE", recycledEnergy: restored },
      };
    }
    const riverSlot = getFutureCommunitySlots(room).find((slot) => slot.boardIndex === 4);
    if (!riverSlot) throw new Error("未来河牌位置不存在");
    const targetDeckIndex = room.deck.findIndex((card) => card.code === cardCode);
    if (targetDeckIndex < 0) {
      const restored = this.triggerRecycle(room, player, getSkillDefinition("DESTINY"), requestId);
      return {
        status: "FAILED", secret: true, publicSummary: "秘密技能已结算",
        privateResult: { message: "天命失败：目标牌已离开可控制牌堆。" },
        audit: { targetCardCode: cardCode, reason: "NOT_IN_DECK", recycledEnergy: restored },
      };
    }
    const displaced = room.deck[riverSlot.deckIndex];
    room.deck[riverSlot.deckIndex] = room.deck[targetDeckIndex];
    room.deck[targetDeckIndex] = displaced;
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
    };
  }

  prepareDeckForHand(room) {
    if (!isSkillEnabled(room.skillMode) || !Array.isArray(room.deck) || room.deck.length < 4) return [];
    const lockedIndexes = new Set();
    const triggered = [];
    room.players.forEach((player, playerIndex) => {
      const runtime = player.skillRuntime;
      if (!hasEquipped(player, "FORTUNE") || runtime.lockedThisHand) return;
      if (runtime.abyssEnergy - 4 < SKILL_CONFIG.MIN_FORTUNE_ENERGY) return;
      const chance = chanceByDisadvantage(room, player, SKILL_CONFIG.FORTUNE_BASE_CHANCE, SKILL_CONFIG.FORTUNE_MAX_CHANCE);
      if (this.random() >= chance) return;
      const eligible = FORTUNE_COMBOS.filter((combo) => combo.codes.every((code) => {
        const index = room.deck.findIndex((card) => card.code === code);
        return index >= 0 && !lockedIndexes.has(index);
      }));
      if (!eligible.length) return;
      const selected = eligible[Math.min(eligible.length - 1, Math.floor(this.random() * eligible.length))];
      const targetIndexes = [room.deck.length - 1 - playerIndex, room.deck.length - 3 - playerIndex];
      const swaps = [];
      selected.codes.forEach((code, index) => {
        const sourceIndex = room.deck.findIndex((card) => card.code === code);
        const destinationIndex = targetIndexes[index];
        swaps.push({
          sourceIndex,
          destinationIndex,
          selectedCardCode: room.deck[sourceIndex].code,
          displacedCardCode: room.deck[destinationIndex].code,
        });
        [room.deck[sourceIndex], room.deck[destinationIndex]] = [room.deck[destinationIndex], room.deck[sourceIndex]];
      });
      targetIndexes.forEach((index) => lockedIndexes.add(index));
      spendEnergy(player, 4, { allowDebt: true, minimum: SKILL_CONFIG.MIN_FORTUNE_ENERGY });
      runtime.fortuneTriggered = true;
      markSkillEvent(player, "FORTUNE");
      const entry = {
        at: Date.now(), skillId: "FORTUNE", casterId: player.playerId,
        status: "TRIGGERED", secret: true, publicSummary: "秘密技能已结算",
        audit: { chance, comboType: selected.type, cardCodes: [...selected.codes], swaps, energyAfter: runtime.abyssEnergy },
      };
      room.skillState.skillActionLog.push(entry);
      room.skillState.transformations.push({
        at: entry.at,
        skillId: "FORTUNE",
        casterId: player.playerId,
        comboType: selected.type,
        swaps,
      });
      player.skillRuntime.privateResults.push({
        resultId: crypto.randomUUID(),
        at: Date.now(),
        skillId: "FORTUNE",
        message: `强运触发：${selected.type === "POCKET_PAIR" ? "口袋对子" : "同花连张"}。`,
      });
      triggered.push({ playerId: player.playerId, comboType: selected.type });
    });
    return triggered;
  }

  onCardsDealt(room, node) {
    if (!isSkillEnabled(room.skillMode)) return;
    updateNullifiedCodes(room);
    const newlyRevealed = room.skillState.nullifications.filter((entry) => entry.revealed && !entry.announced);
    newlyRevealed.forEach((entry) => {
      entry.announced = true;
      this.emitToRoom(room, "skill:resolved", {
        skillId: "NULLIFICATION", casterId: entry.casterId, status: "REVEALED",
        publicSummary: `第 ${entry.boardIndex + 1} 张公共牌的零化标记显现`,
        publicData: { nullifiedCommunityCardIds: [...room.skillState.nullifiedCommunityCardIds] },
      });
    });

    room.players.forEach((player) => {
      const runtime = player.skillRuntime;
      if (!hasEquipped(player, "PERCEPTION") || runtime.lockedThisHand || room.skillState.fairnessActive) return;
      if (runtime.perceptionCheckedNodes.includes(node)) return;
      runtime.perceptionCheckedNodes.push(node);
      if (runtime.perceptionTriggerCount >= SKILL_CONFIG.PERCEPTION_MAX_TRIGGERS_PER_HAND) return;
      const chance = chanceByDisadvantage(room, player, SKILL_CONFIG.PERCEPTION_BASE_CHANCE, SKILL_CONFIG.PERCEPTION_MAX_CHANCE);
      if (this.random() >= chance) return;
      const opponent = opponentOf(room, player);
      if (!opponent?.cards?.length) return;
      const facts = [
        {
          truth: opponent.cards[0].suit === opponent.cards[1].suit,
          yes: "对手的两张底牌同花。", no: "对手的两张底牌不同花。",
        },
        {
          truth: opponent.cards[0].rank === opponent.cards[1].rank,
          yes: "对手持有口袋对子。", no: "对手没有口袋对子。",
        },
        {
          truth: opponent.cards.some((card) => card.value >= 11),
          yes: "对手至少持有一张 J 或更高的牌。", no: "对手两张底牌都低于 J。",
        },
        {
          truth: opponent.cards.some((card) => ["H", "D"].includes(card.suit)),
          yes: "对手至少持有一张红色花色牌。", no: "对手没有红色花色底牌。",
        },
      ];
      const fact = facts[Math.min(facts.length - 1, Math.floor(this.random() * facts.length))];
      const truthful = this.random() < SKILL_CONFIG.PERCEPTION_TRUTH_CHANCE;
      const statedPositive = truthful ? fact.truth : !fact.truth;
      const text = statedPositive ? fact.yes : fact.no;
      runtime.perceptionTriggerCount += 1;
      markSkillEvent(player, "PERCEPTION");
      room.skillState.skillActionLog.push({
        at: Date.now(), skillId: "PERCEPTION", casterId: player.playerId,
        status: "TRIGGERED", secret: true, publicSummary: "秘密技能已结算",
        audit: { node, chance, truthful, statement: text },
      });
      this.notifyPrivate(player, { skillId: "PERCEPTION", message: `感知 · ${text}`, node });
    });
    this.broadcastSkillState(room);
  }

  onAggressiveAction(room, aggressor) {
    const opponent = opponentOf(room, aggressor);
    if (opponent?.skillRuntime) opponent.skillRuntime.facedAggressionThisPhase = true;
    this.broadcastSkillState(room);
  }

  onPlayerAllIn(room, player) {
    if (!isSkillEnabled(room.skillMode)) return false;
    const runtime = player.skillRuntime;
    if (
      !player.isAllIn || runtime.deadEndActive || runtime.lockedThisHand ||
      room.skillState.fairnessActive || !hasEquipped(player, "DEAD_END") || runtime.abyssEnergy < 5
    ) return false;
    spendEnergy(player, 5);
    runtime.deadEndActive = true;
    markSkillEvent(player, "DEAD_END");
    const opponent = opponentOf(room, player);
    if (opponent?.skillRuntime) {
      opponent.skillRuntime.lockedThisHand = true;
      opponent.skillRuntime.lockReason = "DEAD_END";
    }
    const skill = getSkillDefinition("DEAD_END");
    this.recordSkill(room, player, skill, {
      status: "TRIGGERED", secret: false,
      publicSummary: `${player.name} 在 All In 时触发「绝路」`,
    });
    this.emitToRoom(room, "skill:resolved", {
      skillId: "DEAD_END", casterId: player.playerId, status: "TRIGGERED",
      publicSummary: `${player.name} 在 All In 时触发「绝路」`,
    });
    this.broadcastSkillState(room);
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

  applySettlementModifiers(room, { reason, winner, tie = false } = {}) {
    const details = { baseTransfer: 0, finalTransfer: 0, multiplier: 1, effects: [] };
    if (!isSkillEnabled(room.skillMode) || tie || !winner) return details;
    const loser = opponentOf(room, winner);
    if (!loser) return details;
    const baseTransfer = Math.max(0, winner.chips - (winner.skillRuntime?.handStartChips || winner.chips));
    let multiplier = 1;
    const bloodCount = room.players.filter((player) => player.skillRuntime?.bloodBattleActive).length;
    if (bloodCount) {
      const factor = 2 ** bloodCount;
      multiplier *= factor;
      details.effects.push({ skillId: "BLOOD_BATTLE", factor, stacks: bloodCount });
    }
    if (winner.skillRuntime?.desperationActive) {
      multiplier *= 1.5;
      details.effects.push({ skillId: "DESPERATION", factor: 1.5 });
    }
    if (reason === "fold" && winner.skillRuntime?.deadEndActive) {
      multiplier *= 3;
      details.effects.push({ skillId: "DEAD_END", factor: 3 });
    }
    if (loser.skillRuntime?.defenseActive && !loser.skillRuntime.foldedThisHand) {
      multiplier *= 0.5;
      details.effects.push({ skillId: "DEFENSE", factor: 0.5 });
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
    room.skillState.settlement = details;
    return details;
  }

  getNullifiedSet(room) {
    updateNullifiedCodes(room);
    return new Set(room.skillState?.nullifiedCommunityCardIds || []);
  }

  buildRevealExtras(room) {
    const state = room.skillState || createRoomSkillState();
    updateNullifiedCodes(room);
    return {
      burnedCards: (state.burnedCards || []).map(cloneCard),
      removedCards: (state.removedCards || []).map(cloneCard),
      nullifications: (state.nullifications || []).map((entry) => ({ ...entry })),
      nullifiedCommunityCardIds: [...(state.nullifiedCommunityCardIds || [])],
      skillTransforms: (state.transformations || []).map((entry) => JSON.parse(JSON.stringify(entry))),
      skillActions: (state.skillActionLog || []).map((entry) => JSON.parse(JSON.stringify(entry))),
      equippedSkills: room.players.map((player) => ({
        playerId: player.playerId,
        skillIds: [...(player.skillRuntime?.equippedSkillIds || [])],
      })),
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

module.exports = {
  SkillEngine,
  FORTUNE_COMBOS,
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
  getPublicSkillSummary,
  getSelfSkillSummary,
  getPublicRoomSkillSnapshot,
  validateLoadout,
  listSkillDefinitions,
};
