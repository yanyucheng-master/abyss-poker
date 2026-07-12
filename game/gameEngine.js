const crypto = require("crypto");
const { createShuffledDeck } = require("../utils/deck");
const { pickBestFive, compareEvaluatedHands } = require("./handEvaluator");
const { GAME_MODE, normalizeGameMode } = require("./gameModes");
const { normalizeSkillMode, isSkillEnabled } = require("./skillModes");
const { generateOverdriveDeal } = require("./overdriveGenerator");
const { createDeckCommitment } = require("./deckCommitment");
const {
  SkillEngine,
  beginHandSkills,
  onStreetPhaseChanged,
  onPlayerFolded,
  onPlayerPokerAction,
  endHandSkills,
  isPokerLockedBySkills,
  autoConfirmBotLoadouts,
  allLoadoutsConfirmed,
  setPlayerLoadout,
  getPublicRoomSkillSnapshot,
} = require("./skills/skillEngine");
const { SKILL_CONFIG } = require("./skillConfig");
const {
  otherIndex,
  getActivePlayers,
  getToCall,
  getEffectiveMaxTotal,
  getMinRaiseTo,
  getValidActions,
  collectBet,
  isStreetComplete,
} = require("./pokerLogic");

const HAND_SETTLE_MS = 5000;
const FULL_BOARD_SETTLE_MS = 6000;
const REMATCH_TIMEOUT_MS = 10000;
const ACTION_TIMEOUT_MS = 30000;

function withRoomId(roomId, payload) {
  if (payload == null) return { roomId };
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return { roomId, data: payload };
  }
  return { roomId, ...payload };
}

class GameEngine {
  constructor({
    io,
    roomManager,
    logger,
    eventBus,
    overdriveGenerator = generateOverdriveDeal,
    deckFactory = createShuffledDeck,
    commitmentFactory = createDeckCommitment,
  }) {
    this.io = io;
    this.roomManager = roomManager;
    this.logger = logger;
    this.eventBus = eventBus;
    this.overdriveGenerator = overdriveGenerator;
    this.deckFactory = deckFactory;
    this.commitmentFactory = commitmentFactory;
    this.skillEngine = new SkillEngine({ gameEngine: this });
  }

  emitToRoom(room, event, payload) {
    this.io.to(room.roomId).emit(event, withRoomId(room.roomId, payload));
  }

  emitToPlayer(player, event, payload) {
    if (!player?.socketId) return;
    const roomId = player.roomId || null;
    this.io.to(player.socketId).emit(event, roomId ? withRoomId(roomId, payload) : payload);
  }

  clearActionTimer(room) {
    if (room.actionTimer) {
      clearTimeout(room.actionTimer);
      room.actionTimer = null;
    }
    room.actionDeadline = null;
  }

  scheduleActionTimeout(room, playerIndex, turn) {
    this.clearActionTimer(room);
    const player = room.players[playerIndex];
    if (!player) return;

    room.actionDeadline = Date.now() + ACTION_TIMEOUT_MS;
    if (player.isBot) return;
    const handNo = room.handNo;
    const playerId = player.playerId;
    room.actionTimer = setTimeout(() => {
      if (room.handNo !== handNo || room.currentPlayerIndex !== playerIndex) return;
      if (room.players[playerIndex]?.playerId !== playerId) return;
      if (["waiting", "showdown", "end", "game_over"].includes(room.phase)) return;
      const latest = getValidActions(room, playerIndex);
      const timeoutAction = latest.validActions.includes("check") ? "check" : "fold";
      this.logger.warn("GAME", "行动超时自动处理", {
        roomId: room.roomId,
        playerId,
        action: timeoutAction,
      });
      this.handlePlayerAction(room, playerIndex, timeoutAction, undefined, { system: true });
    }, ACTION_TIMEOUT_MS);
    if (typeof room.actionTimer.unref === "function") room.actionTimer.unref();
  }

  createHandCommitment(room) {
    const handId = crypto.randomUUID();
    const initialDeck = room.deck.map((card) => ({ ...card }));
    const commitment = this.commitmentFactory({
      handId,
      mode: room.gameMode,
      skillMode: normalizeSkillMode(room.skillMode),
      deck: initialDeck,
    });
    room.handId = handId;
    room.deckCommitment = commitment.commitment;
    room.handReveal = {
      handId,
      mode: room.gameMode,
      skillMode: normalizeSkillMode(room.skillMode),
      nonce: commitment.nonce,
      deck: initialDeck,
      commitment: commitment.commitment,
      profile: room.privateOverdriveProfile || null,
      ...this.skillEngine.buildRevealExtras(room),
    };
    room.handRevealSent = false;
  }

  revealHandCommitment(room) {
    if (!room.handReveal || room.handRevealSent) return;
    room.handRevealSent = true;
    if (room.handReveal.profile?.type) {
      room.history.push({
        type: "overdrive_profile",
        profile: room.handReveal.profile.type,
        handNo: room.handNo,
        at: Date.now(),
      });
    }
    Object.assign(room.handReveal, this.skillEngine.buildRevealExtras(room));
    this.emitToRoom(room, "hand_reveal", room.handReveal);
  }

  emitHandResult(room, payload, { revealAll = false } = {}) {
    if (revealAll) {
      this.emitToRoom(room, "hand_result", payload);
      return;
    }
    room.players.forEach((recipient) => {
      const players = (payload.players || []).map((detail) => {
        if (detail.playerId === recipient.playerId) return detail;
        return {
          playerId: detail.playerId,
          name: detail.name,
          folded: detail.folded,
          cards: [],
          bestFive: [],
          handName: detail.folded ? "已弃牌" : undefined,
        };
      });
      this.emitToPlayer(recipient, "hand_result", { ...payload, players });
    });
  }

  buildPlayerHandDetail(player, communityCards, extra = {}, room = null) {
    const cards = [...(player.cards || [])];
    const detail = {
      playerId: player.playerId,
      name: player.name,
      cards,
      ...extra,
    };
    const excluded = room ? this.getExcludedCodes(room) : new Set();
    const pool = [...cards, ...(communityCards || [])];
    if (pool.length >= 5) {
      const hand = pickBestFive(pool, { excludedCodes: excluded });
      if (hand) {
        detail.handName = hand.handName;
        detail.handRank = hand.category;
        detail.bestFive = hand.bestFive;
      } else {
        detail.handName = "无效牌型";
        detail.bestFive = [];
      }
    } else if (extra.folded) {
      detail.handName = cards.length ? "已弃牌（未成牌）" : "已弃牌";
    } else if (cards.length > 0 && pool.length < 5) {
      detail.handName = "未成牌";
    }
    return detail;
  }

  getExcludedCodes(room) {
    return this.skillEngine.getNullifiedSet(room);
  }

  evaluatePlayerHand(player, room) {
    return pickBestFive([...(player.cards || []), ...(room.communityCards || [])], {
      excludedCodes: this.getExcludedCodes(room),
    });
  }

  buildHandHint(player, communityCards, room = null) {
    const excluded = room ? this.getExcludedCodes(room) : new Set();
    const pool = [...(player.cards || []), ...(communityCards || [])];
    if (pool.length >= 5) {
      const hand = pickBestFive(pool, { excludedCodes: excluded });
      if (!hand) return { handName: "无效牌型", category: 0, bestFive: [] };
      return {
        handName: hand.handName,
        category: hand.category,
        bestFive: hand.bestFive,
      };
    }
    if (player.cards?.length === 2 && player.cards[0].value === player.cards[1].value) {
      return { handName: "口袋对子", category: 2, bestFive: [] };
    }
    return { handName: "未成牌", category: 0, bestFive: [] };
  }

  emitPrivateHandHints(room) {
    room.players.forEach((player) => {
      this.emitToPlayer(player, "hand_hint", this.buildHandHint(player, room.communityCards, room));
    });
  }

  buildHandResultPayload(room, { reason, winner, tie, pot, playersDetail }) {
    const bust = room.players.some((p) => p.chips <= 0);
    const isFullBoard = (room.communityCards || []).length >= 5;
    return {
      reason,
      settleMs: reason === "showdown" && isFullBoard ? FULL_BOARD_SETTLE_MS : HAND_SETTLE_MS,
      pot,
      tie: Boolean(tie),
      winner: winner?.playerId || null,
      winnerName: winner?.name || null,
      isFinalHand: bust,
      communityCards: [...(room.communityCards || [])],
      players: playersDetail,
    };
  }

  normalizeHeadsUpShowdownPot(room) {
    if (room.players.length !== 2) return 0;
    const [a, b] = room.players;
    const high = a.totalBet > b.totalBet ? a : b;
    const excess = Math.abs(a.totalBet - b.totalBet);
    if (excess <= 0) return 0;

    // Heads-up all-in can leave an unmatched bet in the pot. Return it before showdown.
    high.chips += excess;
    high.totalBet -= excess;
    high.streetBet = Math.max(0, high.streetBet - excess);
    room.pot = Math.max(0, room.pot - excess);
    return excess;
  }

  getRoomSnapshot(room) {
    const current = room.players[room.currentPlayerIndex];
    const snapshot = {
      roomId: room.roomId,
      gameMode: normalizeGameMode(room.gameMode),
      skillMode: normalizeSkillMode(room.skillMode),
      phase: room.phase,
      pot: room.pot,
      currentBet: room.currentBet,
      dealer: room.players[room.dealerIndex]?.playerId || null,
      currentPlayer: current?.playerId || null,
      activePlayerId: current?.playerId || null,
      communityCards: room.communityCards,
      actionDeadline: room.actionDeadline || null,
      handId: room.handId || null,
      deckCommitment: room.deckCommitment || null,
      overdriveProfile:
        room.gameMode === GAME_MODE.OVERDRIVE
          ? { enabled: true, label: "OVERDRIVE PROTOCOL" }
          : null,
      players: this.roomManager.getPublicPlayers(room),
      hasPassword: Boolean(room.password),
    };
    if (isSkillEnabled(room.skillMode)) {
      snapshot.skillState = getPublicRoomSkillSnapshot(room);
      snapshot.nullifiedCommunityCardIds = [
        ...(room.skillState?.nullifiedCommunityCardIds || []),
      ];
    }
    return snapshot;
  }

  broadcastRoomState(room) {
    this.emitToRoom(room, "room_state", this.getRoomSnapshot(room));
  }

  resetRoomForRematch(room) {
    this.clearActionTimer(room);
    if (room.nextHandTimer) {
      clearTimeout(room.nextHandTimer);
      room.nextHandTimer = null;
    }
    room.phase = "waiting";
    room.dealerIndex = 0;
    room.currentPlayerIndex = 0;
    room.deck = [];
    room.communityCards = [];
    room.pot = 0;
    room.currentBet = 0;
    room.lastRaiseSize = room.bigBlind;
    room.handNo = 0;
    room.history = [];
    room.lastActionAt = Date.now();
    room.rematch = null;
    room.handId = null;
    room.deckCommitment = null;
    room.handReveal = null;
    room.handRevealSent = false;
    room.privateOverdriveProfile = null;
    room.players.forEach((player) => {
      player.chips = 1000;
      player.cards = [];
      player.status = "active";
      player.totalBet = 0;
      player.streetBet = 0;
      player.hasActed = false;
      player.isAllIn = false;
      player.disconnectedAt = null;
      player.isReady = Boolean(player.isBot || player.socketId);
      if (isSkillEnabled(room.skillMode) && player.skillRuntime) {
        const equipped = [...player.skillRuntime.equippedSkillIds];
        const confirmed = player.skillRuntime.loadoutConfirmed;
        const { resetPlayerSkillsForGame } = require("./skills/skillState");
        resetPlayerSkillsForGame(player);
        player.skillRuntime.equippedSkillIds = equipped;
        player.skillRuntime.loadoutConfirmed = confirmed;
      }
    });
    if (isSkillEnabled(room.skillMode)) {
      const { resetRoomSkillsForHand } = require("./skills/skillState");
      resetRoomSkillsForHand(room);
    }
  }

  closeRoom(room, reason = "rematch_timeout") {
    if (!room || !this.roomManager.getRoom(room.roomId)) return;
    this.clearActionTimer(room);
    if (room.nextHandTimer) {
      clearTimeout(room.nextHandTimer);
      room.nextHandTimer = null;
    }
    if (room.rematch?.timer) {
      clearTimeout(room.rematch.timer);
      room.rematch.timer = null;
    }
    this.emitToRoom(room, "room_closed", { reason });
    this.roomManager.destroyRoom(room.roomId);
  }

  getRematchPlayers(room) {
    return room.players.filter((p) => !p.isBot);
  }

  buildRematchPayload(room) {
    const rematch = room.rematch;
    const accepted = rematch
      ? Array.from(rematch.accepted).map((playerId) => ({ playerId, accepted: true }))
      : [];
    return {
      timeoutMs: REMATCH_TIMEOUT_MS,
      deadlineAt: rematch?.deadlineAt || Date.now() + REMATCH_TIMEOUT_MS,
      accepted,
      players: this.roomManager.getPublicPlayers(room),
    };
  }

  emitRematchUpdate(room) {
    this.emitToRoom(room, "rematch_update", this.buildRematchPayload(room));
  }

  beginRematchVote(room, gameOverPayload) {
    if (room.rematch?.timer) clearTimeout(room.rematch.timer);
    const deadlineAt = Date.now() + REMATCH_TIMEOUT_MS;
    room.rematch = {
      active: true,
      accepted: new Set(),
      deadlineAt,
      timer: setTimeout(() => this.closeRoom(room, "rematch_timeout"), REMATCH_TIMEOUT_MS),
    };
    room.lastGameOverPayload = gameOverPayload;
    if (typeof room.rematch.timer.unref === "function") room.rematch.timer.unref();

    this.emitToRoom(room, "game_over", {
      ...gameOverPayload,
      rematch: this.buildRematchPayload(room),
    });
    this.broadcastRoomState(room);
  }

  handleRematchResponse(room, player, accepted) {
    if (!room?.rematch?.active || room.phase !== "game_over") {
      return { ok: false, error: "当前不可再来一局" };
    }
    if (!accepted) {
      this.closeRoom(room, "rematch_declined");
      return { ok: true };
    }
    if (!player.socketId) return { ok: false, error: "离线玩家不能确认再来一局" };

    room.rematch.accepted.add(player.playerId);
    const voters = this.getRematchPlayers(room);
    const allAccepted =
      voters.length > 0 &&
      voters.every((p) => p.socketId && room.rematch.accepted.has(p.playerId));
    this.emitRematchUpdate(room);
    if (allAccepted) {
      clearTimeout(room.rematch.timer);
      this.resetRoomForRematch(room);
      this.emitToRoom(room, "rematch_started", {
        players: this.roomManager.getPublicPlayers(room),
      });
      this.startHand(room);
    }
    return { ok: true };
  }

  tryStartGame(room) {
    if (room.phase !== "waiting" && room.phase !== "drafting") return;
    if (room.players.length !== 2) return;
    if (room.players.some((p) => p.chips <= 0)) return;
    if (room.players.some((p) => p.isReady === false)) return;

    const humans = room.players.filter((p) => !p.isBot);
    const bots = room.players.filter((p) => p.isBot);
    if (humans.length === 2) {
      if (humans.some((p) => !p.socketId)) return;
    } else if (humans.length === 1 && bots.length === 1) {
      if (!humans[0].socketId) return;
    } else {
      return;
    }

    if (isSkillEnabled(room.skillMode)) {
      autoConfirmBotLoadouts(room);
      if (!allLoadoutsConfirmed(room)) {
        room.phase = "drafting";
        this.broadcastRoomState(room);
        this.skillEngine.broadcastSkillState(room);
        return;
      }
    }

    this.startHand(room);
  }

  handleSkillLoadout(room, player, skillIds) {
    if (!isSkillEnabled(room.skillMode)) return { ok: false, error: "当前房间未启用技能" };
    if (!["waiting", "drafting"].includes(room.phase)) {
      return { ok: false, error: "对局开始后不能更换技能" };
    }
    const result = setPlayerLoadout(player, skillIds);
    if (!result.ok) return result;
    this.emitToRoom(room, "skill:loadout:confirmed", {
      playerId: player.playerId,
      equippedSkillIds: result.skillIds,
      totalLoad: result.totalLoad,
    });
    this.skillEngine.broadcastSkillState(room);
    this.broadcastRoomState(room);
    this.tryStartGame(room);
    return result;
  }

  handleSkillUse(room, player, payload) {
    return this.skillEngine.requestUse(room, player, payload || {});
  }

  handleSkillCounter(room, player, payload) {
    return this.skillEngine.requestCounter(room, player, payload || {});
  }

  handleSkillChoice(room, player, payload) {
    return this.skillEngine.resolveSkillChoice(room, player, payload || {});
  }

  continuePreDeal(room) {
    const state = room.skillState;
    if (!state?.preDealWindow) return;
    if (state.skillChoice) return;
    if (state.preDealTimer) {
      clearTimeout(state.preDealTimer);
      state.preDealTimer = null;
    }
    const nextPhase = state.preDealWindow.nextPhase;
    state.preDealWindow = null;
    this.finishStreetDeal(room, nextPhase, { autoRunout: Boolean(state._preDealAutoRunout) });
  }

  restorePlayerState(room, player) {
    if (!room || !player) return;
    if (room.handId && room.deckCommitment) {
      this.emitToPlayer(player, "hand_commitment", {
        handId: room.handId,
        mode: room.gameMode,
        skillMode: normalizeSkillMode(room.skillMode),
        commitment: room.deckCommitment,
      });
    }

    if (isSkillEnabled(room.skillMode)) {
      this.skillEngine.broadcastSkillState(room);
    }

    if (!["waiting", "drafting", "game_over"].includes(room.phase)) {
      this.emitToPlayer(player, "your_cards", { cards: player.cards || [] });
      this.emitToPlayer(player, "hand_hint", this.buildHandHint(player, room.communityCards, room));
    }

    if (room.handRevealSent && room.handReveal) {
      this.emitToPlayer(player, "hand_reveal", room.handReveal);
    }

    if (room.phase === "game_over" && room.lastGameOverPayload) {
      this.emitToPlayer(player, "game_over", {
        ...room.lastGameOverPayload,
        rematch: this.buildRematchPayload(room),
      });
      return;
    }

    if (!["pre_flop", "flop", "turn", "river"].includes(room.phase)) return;
    const current = room.players[room.currentPlayerIndex];
    if (!current) return;
    const turn = getValidActions(room, room.currentPlayerIndex);
    this.emitToPlayer(player, "player_turn", {
      playerId: current.playerId,
      validActions: turn.validActions,
      minRaise: turn.minRaiseTo,
      maxBet: turn.maxTotalBet,
      toCall: turn.toCall,
      actionDeadline: room.actionDeadline || null,
    });
  }

  startHand(room) {
    this.clearActionTimer(room);
    if (room.nextHandTimer) {
      clearTimeout(room.nextHandTimer);
      room.nextHandTimer = null;
    }
    room.phase = "pre_flop";
    room.handNo += 1;
    room.gameMode = normalizeGameMode(room.gameMode);
    beginHandSkills(room);
    room.privateOverdriveProfile = null;
    room.overdriveMetrics = null;
    if (room.gameMode === GAME_MODE.OVERDRIVE) {
      try {
        const recentProfiles = room.history
          .filter((entry) => entry.type === "overdrive_profile")
          .slice(-5)
          .map((entry) => entry.profile);
        const generated = this.overdriveGenerator({
          candidateCount: room.overdriveCandidateCount || 500,
          recentProfiles,
        });
        room.deck = generated.deck;
        room.privateOverdriveProfile = generated.profile || null;
        room.overdriveMetrics = generated.metrics || null;
        if (generated.metrics?.fallback) {
          this.logger.warn("OVERDRIVE", "高爆候选不足，已回退安全随机牌堆", {
            roomId: room.roomId,
            handNo: room.handNo,
          });
        }
      } catch (error) {
        room.deck = this.deckFactory();
        room.overdriveMetrics = { fallback: true, error: error.message };
        this.logger.error("OVERDRIVE", "高爆生成异常，已回退安全随机牌堆", {
          roomId: room.roomId,
          handNo: room.handNo,
          error: error.message,
        });
      }
    } else {
      room.deck = this.deckFactory();
    }
    this.createHandCommitment(room);
    room.communityCards = [];
    room.pot = 0;
    room.currentBet = 0;
    room.lastRaiseSize = room.bigBlind;
    room.lastActionAt = Date.now();
    room.lastHandResult = null;
    room.lastGameOverPayload = null;
    room.history.push({ type: "hand_start", handNo: room.handNo, at: Date.now() });

    room.players.forEach((p) => {
      p.cards = [];
      p.totalBet = 0;
      p.streetBet = 0;
      p.hasActed = false;
      p.isAllIn = false;
      p.status = p.chips > 0 ? "active" : "out";
    });

    for (let i = 0; i < 2; i += 1) {
      room.players.forEach((p) => p.cards.push(room.deck.pop()));
    }
    this.logger.info("GAME", "发底牌", { roomId: room.roomId, handNo: room.handNo });
    this.eventBus.emit("game:deal_hole_cards", { roomId: room.roomId, handNo: room.handNo });

    const sbIndex = room.dealerIndex;
    const bbIndex = otherIndex(sbIndex);
    collectBet(room, room.players[sbIndex], room.smallBlind);
    collectBet(room, room.players[bbIndex], room.bigBlind);
    room.currentBet = room.bigBlind;
    room.lastRaiseSize = room.bigBlind;
    room.currentPlayerIndex = sbIndex;

    this.emitToRoom(room, "hand_commitment", {
      handId: room.handId,
      mode: room.gameMode,
      skillMode: normalizeSkillMode(room.skillMode),
      commitment: room.deckCommitment,
    });

    room.players.forEach((player, idx) => {
      this.emitToPlayer(player, "your_cards", { cards: player.cards });
      this.emitToPlayer(player, "game_started", {
        dealer: room.players[room.dealerIndex].playerId,
        opponentName: room.players[otherIndex(idx)].name,
        gameMode: room.gameMode,
        skillMode: normalizeSkillMode(room.skillMode),
        handId: room.handId,
        deckCommitment: room.deckCommitment,
      });
    });

    this.emitPrivateHandHints(room);
    if (isSkillEnabled(room.skillMode)) this.skillEngine.broadcastSkillState(room);

    this.emitToRoom(room, "community_cards", { cards: room.communityCards, phase: room.phase });
    this.broadcastRoomState(room);
    this.emitTurn(room);
  }

  emitTurn(room) {
    if (["waiting", "showdown", "end", "game_over"].includes(room.phase)) return;
    const current = room.players[room.currentPlayerIndex];
    if (current?.status === "disconnected" && !current.isAllIn) {
      const pausedTurn = { validActions: [], minRaiseTo: 0, maxTotalBet: 0, toCall: 0 };
      this.scheduleActionTimeout(room, room.currentPlayerIndex, pausedTurn);
      this.emitToRoom(room, "player_turn", {
        playerId: current.playerId,
        validActions: [],
        minRaise: 0,
        maxBet: 0,
        toCall: 0,
        actionDeadline: room.actionDeadline,
      });
      this.broadcastRoomState(room);
      return;
    }
    if (!current || current.status !== "active" || current.isAllIn) {
      const next = this.findNextActionPlayer(room, room.currentPlayerIndex);
      if (next < 0) return;
      room.currentPlayerIndex = next;
    }
    const turnPlayer = room.players[room.currentPlayerIndex];
    const turn = getValidActions(room, room.currentPlayerIndex);
    this.scheduleActionTimeout(room, room.currentPlayerIndex, turn);
    this.emitToRoom(room, "player_turn", {
      playerId: turnPlayer.playerId,
      validActions: turn.validActions,
      minRaise: turn.minRaiseTo,
      maxBet: turn.maxTotalBet,
      toCall: turn.toCall,
      actionDeadline: room.actionDeadline,
    });
    this.broadcastRoomState(room);
    if (turnPlayer.isBot) {
      this.scheduleBotAction(room, room.currentPlayerIndex, turn);
    }
  }

  findNextActionPlayer(room, fromIndex) {
    for (let i = 1; i <= room.players.length; i += 1) {
      const idx = (fromIndex + i) % room.players.length;
      const p = room.players[idx];
      if (["active", "disconnected"].includes(p.status) && !p.isAllIn) return idx;
    }
    return -1;
  }

  settleByFold(room) {
    const active = getActivePlayers(room);
    if (active.length !== 1) return;
    this.clearActionTimer(room);
    const winner = active[0];
    const pot = room.pot;
    winner.chips += room.pot;
    room.pot = 0;
    room.phase = "end";

    this.logger.info("GAME", "弃牌结算", { roomId: room.roomId, winner: winner.playerId, pot });
    this.eventBus.emit("game:fold_win", { roomId: room.roomId, winner: winner.playerId, pot });

    this.emitToRoom(room, "action_made", {
      playerId: winner.playerId,
      action: "win_by_fold",
      amount: pot,
      pot: room.pot,
      playerChips: this.roomManager.getPublicPlayers(room),
    });
    const handResult = this.buildHandResultPayload(room, {
        reason: "fold",
        winner,
        tie: false,
        pot,
        playersDetail: room.players.map((p) =>
          this.buildPlayerHandDetail(p, room.communityCards, {
            folded: p.status === "folded",
          }, room)
        ),
      });
    endHandSkills(room, { reason: "fold", winner, tie: false });
    room.lastHandResult = handResult;
    this.emitHandResult(room, handResult, { revealAll: false });
    this.revealHandCommitment(room);
    this.finalizeHand(room, handResult.settleMs);
  }

  moveToNextStreet(room, { autoRunout = false } = {}) {
    this.clearActionTimer(room);
    const nextPhase = {
      pre_flop: "flop",
      flop: "turn",
      turn: "river",
      river: "showdown",
    }[room.phase];
    if (!nextPhase) return;

    // Pre-deal skill window for FORK_OBSERVATION
    if (
      isSkillEnabled(room.skillMode) &&
      (nextPhase === "turn" || nextPhase === "river") &&
      !room.skillState?.preDealWindow &&
      !autoRunout
    ) {
      const beforePhase = nextPhase === "turn" ? "before_turn" : "before_river";
      const eligible = room.players.find((p) => {
        if (!p.skillRuntime?.equippedSkillIds?.includes("FORK_OBSERVATION")) return false;
        const prev = room.phase;
        room.phase = beforePhase;
        const ok = this.skillEngine.validateUse(room, p, "FORK_OBSERVATION", {});
        room.phase = prev;
        return ok.ok;
      });
      if (eligible) {
        const state = room.skillState;
        const expiresAt = Date.now() + SKILL_CONFIG.PRE_DEAL_SKILL_WINDOW_MS;
        const prevPhase = room.phase;
        room.phase = beforePhase;
        state.preDealWindow = { nextPhase, expiresAt, fromPhase: prevPhase };
        state._preDealAutoRunout = autoRunout;
        this.emitToRoom(room, "skill:pre-deal-window", {
          nextPhase,
          beforePhase,
          expiresAt,
          durationMs: SKILL_CONFIG.PRE_DEAL_SKILL_WINDOW_MS,
        });
        this.skillEngine.broadcastSkillState(room);
        this.broadcastRoomState(room);
        state.preDealTimer = setTimeout(() => this.continuePreDeal(room), SKILL_CONFIG.PRE_DEAL_SKILL_WINDOW_MS);
        if (typeof state.preDealTimer.unref === "function") state.preDealTimer.unref();
        if (eligible.isBot) {
          setTimeout(() => {
            if (!room.skillState?.preDealWindow) return;
            this.continuePreDeal(room);
          }, 500);
        }
        return;
      }
    }

    this.finishStreetDeal(room, nextPhase, { autoRunout });
  }

  finishStreetDeal(room, nextPhase, { autoRunout = false } = {}) {
    room.phase = nextPhase;
    onStreetPhaseChanged(room, nextPhase);
    room.players.forEach((p) => {
      p.streetBet = 0;
      p.hasActed = false;
      if (p.skillRuntime) p.skillRuntime.firstStreetActionTaken = false;
    });
    room.currentBet = 0;
    room.lastRaiseSize = room.bigBlind;

    if (nextPhase === "flop") {
      room.deck.pop();
      room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    } else if (nextPhase === "turn" || nextPhase === "river") {
      const card = this.skillEngine.applyForkDuringDeal(room);
      room.communityCards.push(card);
    }

    if (nextPhase === "showdown") {
      this.settleShowdown(room);
      return;
    }
    this.emitPrivateHandHints(room);
    room.currentPlayerIndex = otherIndex(room.dealerIndex);
    this.emitToRoom(room, "community_cards", {
      cards: room.communityCards,
      phase: room.phase,
      nullifiedCommunityCardIds: [...(room.skillState?.nullifiedCommunityCardIds || [])],
    });
    if (isSkillEnabled(room.skillMode)) this.skillEngine.broadcastSkillState(room);
    this.broadcastRoomState(room);
    if (!autoRunout) this.emitTurn(room);
  }

  runoutToShowdownIfAllIn(room) {
    const active = getActivePlayers(room);
    const actionable = active.filter((p) => !p.isAllIn);
    if (actionable.length >= 2) return false;
    if (
      actionable.length === 1 &&
      (!actionable[0].hasActed || actionable[0].streetBet !== room.currentBet)
    ) {
      return false;
    }
    this.clearActionTimer(room);
    while (["pre_flop", "flop", "turn", "river"].includes(room.phase)) {
      this.moveToNextStreet(room, { autoRunout: true });
      if (room.phase === "showdown" || room.phase === "end") return true;
    }
    return room.phase === "showdown" || room.phase === "end";
  }

  settleShowdown(room) {
    this.clearActionTimer(room);
    room.phase = "showdown";
    const returned = this.normalizeHeadsUpShowdownPot(room);
    const alive = getActivePlayers(room);
    const result = alive.map((p) => ({
      player: p,
      hand: this.evaluatePlayerHand(p, room),
    })).filter((x) => x.hand);
    result.sort((a, b) => compareEvaluatedHands(b.hand, a.hand));
    const first = result[0];
    const second = result[1];
    const potBefore = room.pot;

    if (!first) {
      // No evaluable hands (e.g. mid-hand disconnect edge) — return pot to remaining players.
      const recipients = alive.length ? alive : room.players.filter((p) => p.status !== "folded");
      if (recipients.length && room.pot > 0) {
        const share = Math.floor(room.pot / recipients.length);
        recipients.forEach((p) => {
          p.chips += share;
        });
        room.pot = 0;
      }
      this.logger.warn("GAME", "摊牌无有效牌型，已退还底池", { roomId: room.roomId, pot: potBefore });
      this.broadcastRoomState(room);
      return;
    }

    const tie = second ? compareEvaluatedHands(first.hand, second.hand) === 0 : false;

    if (tie) {
      const half = Math.floor(room.pot / 2);
      room.players.forEach((p) => {
        if (p.playerId === first.player.playerId || p.playerId === second.player.playerId) {
          p.chips += half;
        }
      });
      const used = half * 2;
      const oddChip = room.pot - used;
      if (oddChip > 0) {
        const owner = room.players.find((p) => p.playerId === room.ownerPlayerId);
        if (owner) owner.chips += oddChip;
      }
    } else {
      first.player.chips += room.pot;
    }
    room.pot = 0;

    this.logger.info("GAME", "摊牌结算", {
      roomId: room.roomId,
      winner: tie ? "tie" : first.player.playerId,
      pot: potBefore,
      returned,
    });
    this.eventBus.emit("game:showdown", { roomId: room.roomId, tie, pot: potBefore });

    this.emitToRoom(room, "showdown", {
      players: result.map((x) => ({
        playerId: x.player.playerId,
        name: x.player.name,
        cards: x.player.cards,
        handName: x.hand.handName,
        handRank: x.hand.category,
        bestFive: x.hand.bestFive,
      })),
      winner: tie ? null : first.player.playerId,
      tie,
      pot: potBefore,
    });
    const handResult = this.buildHandResultPayload(room, {
        reason: "showdown",
        winner: tie ? null : first.player,
        tie,
        pot: potBefore,
        playersDetail: result.map((x) =>
          this.buildPlayerHandDetail(x.player, room.communityCards, {}, room)
        ),
      });
    endHandSkills(room, {
      reason: "showdown",
      winner: tie ? null : first.player,
      tie,
    });
    room.lastHandResult = handResult;
    this.emitHandResult(room, handResult, { revealAll: true });
    this.revealHandCommitment(room);
    room.phase = "end";
    this.finalizeHand(room, handResult.settleMs);
  }

  finalizeHand(room, settleMs = HAND_SETTLE_MS) {
    this.clearActionTimer(room);
    room.phase = "end";
    room.currentPlayerIndex = -1;
    room.currentBet = 0;
    room.players.forEach((player) => {
      player.streetBet = 0;
      player.hasActed = false;
    });
    this.broadcastRoomState(room);

    room.nextHandTimer = setTimeout(() => {
      room.nextHandTimer = null;
      const bust = room.players.find((p) => p.chips <= 0);
      if (bust) {
        const winner = room.players.find((p) => p.chips > 0);
        bust.status = "out";
        room.phase = "game_over";
        room.pot = 0;
        this.logger.info("GAME", "破产结算", {
          roomId: room.roomId,
          winner: winner?.playerId || null,
          loser: bust.playerId,
        });
        this.beginRematchVote(room, {
          winner: winner ? winner.playerId : null,
          winnerName: winner?.name || null,
          loser: bust.playerId,
          loserName: bust.name,
          reason: "bankrupt",
          players: this.roomManager.getPublicPlayers(room),
        });
        return;
      }
      room.dealerIndex = otherIndex(room.dealerIndex);
      if (
        room.players.length === 2 &&
        room.players.every((p) => (p.isBot || p.socketId) && p.chips > 0)
      ) {
        this.startHand(room);
      } else {
        room.phase = "waiting";
        this.broadcastRoomState(room);
      }
    }, settleMs);
    if (typeof room.nextHandTimer.unref === "function") room.nextHandTimer.unref();
  }

  chooseBotAction(room, botIndex, turn) {
    const bot = room.players[botIndex];
    const toCall = turn.toCall;
    const can = (x) => turn.validActions.includes(x);

    if (toCall === 0) {
      if (can("raise") && Math.random() < 0.25) {
        const min = turn.minRaiseTo ?? turn.minRaise;
        const max = Math.max(min, turn.maxTotalBet ?? turn.maxBet);
        const target = Math.min(max, min + Math.floor(Math.random() * 3) * room.bigBlind);
        return { action: "raise", amount: target };
      }
      return { action: "check" };
    }

    const pressure = toCall / Math.max(1, bot.chips + bot.streetBet);
    if (pressure > 0.75 && can("fold") && Math.random() < 0.65) return { action: "fold" };
    if (pressure > 0.45 && can("allin") && Math.random() < 0.25) return { action: "allin" };
    if (can("call")) return { action: "call" };
    if (can("allin")) return { action: "allin" };
    return { action: "fold" };
  }

  scheduleBotAction(room, botIndex, turn) {
    setTimeout(() => {
      if (["waiting", "showdown", "end", "game_over"].includes(room.phase)) return;
      if (room.currentPlayerIndex !== botIndex) return;
      const bot = room.players[botIndex];
      if (!bot || !bot.isBot || bot.status !== "active" || bot.isAllIn) return;
      const picked = this.chooseBotAction(room, botIndex, turn);
      this.handlePlayerAction(room, botIndex, picked.action, picked.amount);
    }, 800);
  }

  resolveDisconnectTimeout(room, loser) {
    this.clearActionTimer(room);
    loser.status = "out";
    const winner = room.players.find((p) => p.playerId !== loser.playerId);
    if (winner && room.pot > 0) winner.chips += room.pot;
    this.logger.warn("GAME", "断线超时整场判负", {
      roomId: room.roomId,
      loser: loser.playerId,
      winner: winner?.playerId || null,
    });
    this.eventBus.emit("game:disconnect_forfeit", { roomId: room.roomId, loser: loser.playerId });
    room.phase = "game_over";
    room.pot = 0;
    room.currentBet = 0;
    this.revealHandCommitment(room);
    this.beginRematchVote(room, {
      winner: winner?.playerId || null,
      winnerName: winner?.name || null,
      loser: loser.playerId,
      loserName: loser.name,
      reason: "disconnect_timeout_forfeit",
      players: this.roomManager.getPublicPlayers(room),
    });
    this.broadcastRoomState(room);
  }

  handlePlayerAction(room, playerIndex, action, amount, options = {}) {
    if (["waiting", "drafting", "showdown", "end", "game_over", "before_turn", "before_river"].includes(room.phase)) {
      return { ok: false, error: "当前阶段不可行动" };
    }
    if (!options.system && isPokerLockedBySkills(room)) {
      return { ok: false, error: "技能结算中，暂时无法行动" };
    }
    if (room.currentPlayerIndex !== playerIndex) return { ok: false, error: "未轮到你行动" };

    const player = room.players[playerIndex];
    const opponent = room.players[otherIndex(playerIndex)];
    const systemCanFoldDisconnected = options.system && action === "fold" && player.status === "disconnected";
    if ((player.status !== "active" && !systemCanFoldDisconnected) || player.isAllIn) {
      return { ok: false, error: "当前不可行动" };
    }

    const toCall = getToCall(room, player);
    const maxTotal = getEffectiveMaxTotal(room, playerIndex);
    const oldCurrentBet = room.currentBet;
    let appliedAction = action;
    let appliedAmount = 0;

    if (action === "fold") {
      player.status = "folded";
      player.hasActed = true;
      onPlayerFolded(player);
    } else if (action === "check") {
      if (toCall > 0) return { ok: false, error: "当前不可过牌" };
      player.hasActed = true;
    } else if (action === "call") {
      if (toCall <= 0) {
        appliedAction = "check";
        player.hasActed = true;
      } else {
        const paid = collectBet(room, player, toCall);
        appliedAmount = paid;
        if (paid < toCall) appliedAction = "allin";
        player.hasActed = true;
      }
    } else if (action === "raise") {
      if (opponent.isAllIn) return { ok: false, error: "对手已All In，不能再加注" };
      const targetTotal = Number(amount);
      const minRaiseTo = getMinRaiseTo(room);
      if (!Number.isInteger(targetTotal)) return { ok: false, error: "加注金额必须是整数" };
      if (targetTotal < minRaiseTo) return { ok: false, error: `最小加注到 ${minRaiseTo}` };
      if (targetTotal > maxTotal) return { ok: false, error: "超过有效筹码上限" };
      if (targetTotal <= room.currentBet) return { ok: false, error: "加注必须高于当前注" };

      const need = targetTotal - player.streetBet;
      const paid = collectBet(room, player, need);
      appliedAmount = paid;
      room.currentBet = player.streetBet;
      room.lastRaiseSize = room.currentBet - oldCurrentBet;
      room.players.forEach((p) => {
        if (p.playerId !== player.playerId && p.status === "active" && !p.isAllIn) p.hasActed = false;
      });
      player.hasActed = true;
    } else if (action === "allin") {
      if (player.chips <= 0) return { ok: false, error: "无可用筹码" };
      if (opponent.isAllIn) return { ok: false, error: "对手已All In，只能跟注或弃牌" };
      const targetTotal = Math.min(player.streetBet + player.chips, maxTotal);
      if (targetTotal <= player.streetBet) return { ok: false, error: "当前不可全押" };
      const need = targetTotal - player.streetBet;
      const paid = collectBet(room, player, need);
      appliedAmount = paid;

      if (player.streetBet > room.currentBet) {
        const raiseSize = player.streetBet - room.currentBet;
        room.currentBet = player.streetBet;
        if (raiseSize >= room.lastRaiseSize) {
          room.lastRaiseSize = raiseSize;
          room.players.forEach((p) => {
            if (p.playerId !== player.playerId && p.status === "active" && !p.isAllIn) p.hasActed = false;
          });
        }
      }
      player.hasActed = true;
      appliedAction = player.isAllIn ? "allin" : player.streetBet > oldCurrentBet ? "raise" : "call";
    } else {
      return { ok: false, error: "未知操作" };
    }

    this.clearActionTimer(room);
    room.history.push({
      type: "action",
      action: appliedAction,
      amount: appliedAmount,
      playerId: player.playerId,
      at: Date.now(),
    });
    room.lastActionAt = Date.now();

    this.logger.info("GAME", "玩家行动", {
      roomId: room.roomId,
      playerId: player.playerId,
      action: appliedAction,
      amount: appliedAmount,
    });
    this.eventBus.emit("game:action", {
      roomId: room.roomId,
      playerId: player.playerId,
      action: appliedAction,
      amount: appliedAmount,
    });

    onPlayerPokerAction(player);

    this.emitToRoom(room, "action_made", {
      playerId: player.playerId,
      action: appliedAction,
      amount: appliedAmount,
      pot: room.pot,
      playerChips: this.roomManager.getPublicPlayers(room),
    });

    if (getActivePlayers(room).length === 1) {
      this.settleByFold(room);
      return { ok: true };
    }

    if (this.runoutToShowdownIfAllIn(room)) return { ok: true };

    if (isStreetComplete(room)) {
      this.moveToNextStreet(room);
      return { ok: true };
    }

    room.currentPlayerIndex = this.findNextActionPlayer(room, playerIndex);
    this.emitTurn(room);
    return { ok: true };
  }
}

module.exports = { GameEngine, HAND_SETTLE_MS, ACTION_TIMEOUT_MS };
