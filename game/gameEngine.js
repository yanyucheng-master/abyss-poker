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
  autoConfirmBotLoadouts,
  allLoadoutsConfirmed,
  setPlayerLoadout,
  getPublicRoomSkillSnapshot,
  isChipViewHiddenFor,
  energyVisibleToViewer,
  getRealEnergy,
  getPublicEnergySnapshot,
} = require("./skills/skillEngine");
const {
  otherIndex,
  getActivePlayers,
  getToCall,
  getEffectiveMaxTotal,
  getMinRaiseTo,
  getValidActions,
  collectBet,
  isStreetComplete,
  isActionablePlayer,
  pickAutoAction,
  pickTimeoutAction,
} = require("./pokerLogic");

const HAND_SETTLE_MS = 2000;
const PARTIAL_BOARD_SETTLE_MS = 4000;
const FULL_BOARD_SETTLE_MS = 6000;
const ALL_IN_EFFECT_MS = 2200;
const REMATCH_TIMEOUT_MS = 10000;
const ACTION_TIMEOUT_MS = 30000;

function getHandSettlementMs(communityCardCount) {
  const count = Math.max(0, Number(communityCardCount) || 0);
  if (count >= 5) return FULL_BOARD_SETTLE_MS;
  if (count === 0) return HAND_SETTLE_MS;
  return PARTIAL_BOARD_SETTLE_MS;
}

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
    if (room.botActionTimer) {
      clearTimeout(room.botActionTimer);
      room.botActionTimer = null;
    }
    room.actionDeadline = null;
  }

  abortPendingRoomWork(room) {
    this.clearActionTimer(room);
    for (const timerKey of ["nextHandTimer"]) {
      if (room[timerKey]) {
        clearTimeout(room[timerKey]);
        room[timerKey] = null;
      }
    }
    if (room.rematch?.timer) {
      clearTimeout(room.rematch.timer);
      room.rematch.timer = null;
    }
  }

  scheduleActionTimeout(room, playerIndex, turn, timeoutMs = ACTION_TIMEOUT_MS) {
    this.clearActionTimer(room);
    const player = room.players[playerIndex];
    if (!player) return;

    room.actionDeadline = Date.now() + timeoutMs;
    if (player.isBot) return;
    const handNo = room.handNo;
    const playerId = player.playerId;
    const turnId = room.turnId;
    room.actionTimer = setTimeout(() => {
      if (room.handNo !== handNo || room.currentPlayerIndex !== playerIndex) return;
      if (room.turnId !== turnId) return;
      if (room.players[playerIndex]?.playerId !== playerId) return;
      if (["waiting", "showdown", "end", "game_over"].includes(room.phase)) return;
      if (room.skillState?.endgameWindow) {
        this.closeEndgameWindow(room, { used: false });
        return;
      }
      const latest = getValidActions(room, playerIndex);
      const actor = room.players[playerIndex];
      const timeoutAction = pickTimeoutAction(latest.validActions)
        || (actor?.status === "disconnected" ? "fold" : null);
      if (!timeoutAction) return;
      this.logger.warn("GAME", "行动超时自动处理", {
        roomId: room.roomId,
        playerId,
        action: timeoutAction,
      });
      this.handlePlayerAction(room, playerIndex, timeoutAction, undefined, {
        system: true,
        foldOrigin: actor?.status === "disconnected" ? "disconnect" : "timeout",
      });
    }, timeoutMs);
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
    room.handRevealDeferred = false;
  }

  completeHandReveal(room) {
    if (!room.handReveal) return null;
    this.rememberPrivateHandAudit(room, {
      handId: room.handReveal.handId,
      handNo: room.handNo,
      ...this.skillEngine.buildRevealExtras(room, { includePrivateAudit: true }),
    });
    Object.assign(room.handReveal, this.skillEngine.buildRevealExtras(room));
    return room.handReveal;
  }

  rememberPrivateHandAudit(room, audit) {
    if (!audit?.handId) return;
    room.privateHandAuditHistory = room.privateHandAuditHistory || [];
    if (room.privateHandAuditHistory.some((entry) => entry.handId === audit.handId)) return;
    room.privateHandAuditHistory.push({
      handId: audit.handId,
      handNo: audit.handNo,
      skillActions: (audit.skillActions || []).map((entry) => JSON.parse(JSON.stringify(entry))),
      skillTransforms: (audit.skillTransforms || []).map((entry) => JSON.parse(JSON.stringify(entry))),
      nullifications: (audit.nullifications || []).map((entry) => JSON.parse(JSON.stringify(entry))),
    });
  }

  rememberRevealedHand(room, reveal) {
    if (!reveal?.handId) return;
    room.revealedHandHistory = room.revealedHandHistory || [];
    if (room.revealedHandHistory.some((entry) => entry.handId === reveal.handId)) return;
    room.revealedHandHistory.push({
      ...reveal,
      deck: (reveal.deck || []).map((card) => typeof card === "string" ? card : card.code),
      burnedCards: (reveal.burnedCards || []).map((card) =>
        typeof card === "string" ? card : card.code
      ),
      removedCards: (reveal.removedCards || []).map((card) =>
        typeof card === "string" ? card : card.code
      ),
      skillActions: (reveal.skillActions || []).map((entry) => ({ ...entry })),
      equippedSkills: (reveal.equippedSkills || []).map((entry) => ({
        ...entry,
        skillIds: [...(entry.skillIds || [])],
      })),
    });
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
    const reveal = this.completeHandReveal(room);
    this.rememberRevealedHand(room, reveal);
    this.emitToRoom(room, "hand_reveal", reveal);
  }

  deferHandCommitmentReveal(room) {
    if (!room.handReveal || room.handRevealSent || room.handRevealDeferred) return;
    const reveal = this.completeHandReveal(room);
    room.handRevealDeferred = true;
    room.deferredHandReveals = room.deferredHandReveals || [];
    room.deferredHandReveals.push({
      ...reveal,
      // Folded hands stay private until match end. Keep their audit record
      // compact because a long heads-up match may defer many hands.
      deck: (reveal.deck || []).map((card) => typeof card === "string" ? card : card.code),
      burnedCards: (reveal.burnedCards || []).map((card) =>
        typeof card === "string" ? card : card.code
      ),
      removedCards: (reveal.removedCards || []).map((card) =>
        typeof card === "string" ? card : card.code
      ),
    });
  }

  flushDeferredHandReveals(room) {
    const reveals = room.deferredHandReveals || [];
    reveals.forEach((reveal) => {
      this.rememberRevealedHand(room, reveal);
      this.emitToRoom(room, "hand_reveal", reveal);
    });
    if (room.handReveal && reveals.some((reveal) => reveal.handId === room.handReveal.handId)) {
      room.handRevealSent = true;
      room.handRevealDeferred = false;
    }
    room.deferredHandReveals = [];
  }

  visibleHandResultForPlayer(payload, recipient, { revealAll = false } = {}) {
    if (revealAll) return payload;
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
    return { ...payload, players };
  }

  emitHandResult(room, payload, { revealAll = false } = {}) {
    room.players.forEach((recipient) => {
      this.emitToPlayer(recipient, "hand_result", this.handResultForViewer(room, payload, recipient, { revealAll }));
    });
  }

  rememberHandResult(room, handResult) {
    if (!room || !handResult) return;
    room.handResultHistory = Array.isArray(room.handResultHistory) ? room.handResultHistory : [];
    const entry = JSON.parse(JSON.stringify({
      ...handResult,
      handNo: Number(handResult.handNo || room.handNo) || 0,
    }));
    const index = room.handResultHistory.findIndex((item) => Number(item.handNo) === Number(entry.handNo));
    if (index >= 0) room.handResultHistory[index] = entry;
    else room.handResultHistory.push(entry);
  }

  storeAndEmitHandResult(room, handResult, { revealAll = false } = {}) {
    this.syncHandResultAfterEndHand(room, handResult);
    this.rememberHandResult(room, handResult);
    room.lastHandResult = handResult;
    this.emitHandResult(room, handResult, { revealAll });
  }

  emitHandHistory(room, player) {
    if (!room || !player) return;
    const hands = (room.handResultHistory || []).map((entry) => this.handResultForViewer(
      room,
      entry,
      player,
      { revealAll: entry.reason === "showdown" }
    ));
    this.emitToPlayer(player, "hand_history", { hands });
  }

  maskSkillSettlementForViewer(settlement) {
    if (!settlement || typeof settlement !== "object") return null;
    return {
      ...settlement,
      baseTransfer: null,
      finalTransfer: null,
      standardTransfer: null,
      directGain: null,
      lossBeforeDefense: null,
      desiredTransfer: null,
      effects: Array.isArray(settlement.effects)
        ? settlement.effects.map((effect) => {
          if (!effect || typeof effect !== "object") return effect;
          if (!Object.prototype.hasOwnProperty.call(effect, "amount")) return { ...effect };
          return { ...effect, amount: null };
        })
        : [],
    };
  }

  stampHandResultEnergy(room, handResult) {
    if (!handResult || !isSkillEnabled(room?.skillMode)) return handResult;
    handResult.players = (handResult.players || []).map((detail) => {
      const source = room.players.find((player) => player.playerId === detail.playerId);
      if (!source?.skillRuntime) return detail;
      return {
        ...detail,
        abyssEnergy: getRealEnergy(source),
        publicAbyssEnergy: getPublicEnergySnapshot(source),
      };
    });
    return handResult;
  }

  handResultEnergyForViewer(detail, recipient, source) {
    const isSelf = Boolean(recipient && detail.playerId === recipient.playerId);
    if (isSelf && Number.isFinite(Number(detail.abyssEnergy))) return Number(detail.abyssEnergy);
    if (!isSelf && Number.isFinite(Number(detail.publicAbyssEnergy))) return Number(detail.publicAbyssEnergy);
    if (source?.skillRuntime) return energyVisibleToViewer(source, recipient);
    const fallback = Number(detail.abyssEnergy);
    return Number.isFinite(fallback) ? fallback : undefined;
  }

  handResultForViewer(room, payload, recipient, { revealAll = false } = {}) {
    let next = revealAll ? payload : this.visibleHandResultForPlayer(payload, recipient);
    if (isChipViewHiddenFor(room, recipient)) {
      next = {
        ...next,
        pot: null,
        skillSettlement: this.maskSkillSettlementForViewer(next.skillSettlement),
      };
    }
    if (!isSkillEnabled(room.skillMode)) return next;
    return {
      ...next,
      players: (next.players || []).map((detail) => {
        const source = room.players.find((player) => player.playerId === detail.playerId);
        const { publicAbyssEnergy, ...rest } = detail;
        const energy = this.handResultEnergyForViewer(detail, recipient, source);
        if (energy == null) return rest;
        return { ...rest, abyssEnergy: energy };
      }),
    };
  }

  buildPlayerHandDetail(player, communityCards, extra = {}, room = null) {
    const cards = [...(player.cards || [])];
    const detail = {
      playerId: player.playerId,
      name: player.name,
      cards,
      ...extra,
    };
    const excluded = room ? this.getExcludedCodes(room, player) : new Set();
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

  getExcludedCodes(room, player) {
    return this.skillEngine.getNullifiedSet(room, player);
  }

  buildLoadoutReveal(room) {
    if (!isSkillEnabled(room?.skillMode)) return [];
    return room.players.map((player) => ({
      playerId: player.playerId,
      name: player.name,
      skillIds: [...(player.skillRuntime?.equippedSkillIds || [])],
    }));
  }

  evaluatePlayerHand(player, room) {
    return pickBestFive([...(player.cards || []), ...(room.communityCards || [])], {
      excludedCodes: this.getExcludedCodes(room, player),
    });
  }

  buildHandHint(player, communityCards, _room = null) {
    const pool = [...(player.cards || []), ...(communityCards || [])];
    if (pool.length >= 5) {
      const hand = pickBestFive(pool);
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

  buildHandResultPayload(room, { reason, winner, tie, pot, playersDetail, endgameExecution = false, endgameExecutionOverride = false }) {
    const bust = room.players.some((p) => p.chips <= 0);
    const communityCardCount = (room.communityCards || []).length;
    return {
      reason,
      handNo: Number(room.handNo) || 0,
      handId: room.handId || null,
      settleMs: getHandSettlementMs(communityCardCount),
      pot,
      tie: Boolean(tie),
      winner: winner?.playerId || null,
      winnerName: winner?.name || null,
      isFinalHand: bust,
      endgameExecution: Boolean(endgameExecutionOverride || endgameExecution),
      endgameExecutionOverride: Boolean(endgameExecutionOverride),
      communityCards: [...(room.communityCards || [])],
      players: playersDetail,
      skillSettlement: room.skillState?.settlement || null,
    };
  }

  syncHandResultAfterEndHand(room, handResult) {
    if (!handResult) return handResult;
    // Loan repayment is resolved by SkillEngine.endHand and may bankrupt a
    // player after the initial result payload was constructed.
    handResult.isFinalHand = room.players.some((player) => player.chips <= 0);
    handResult.skillSettlement = room.skillState?.settlement || handResult.skillSettlement || null;
    return this.stampHandResultEnergy(room, handResult);
  }

  getHandFinalizeDelay(room, settleMs) {
    const visibleSettleMs = Math.max(0, Number(settleMs) || HAND_SETTLE_MS);
    const remainingAllInEffectMs = Math.max(
      0,
      Number(room.allInPresentationEndsAt || 0) - Date.now()
    );
    return visibleSettleMs + remainingAllInEffectMs;
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

  getRoomSnapshot(room, viewer = null) {
    const current = room.players[room.currentPlayerIndex];
    const hideChips = Boolean(viewer && isChipViewHiddenFor(room, viewer));
    const snapshot = {
      roomId: room.roomId,
      gameMode: normalizeGameMode(room.gameMode),
      skillMode: normalizeSkillMode(room.skillMode),
      phase: room.phase,
      handNo: room.handNo,
      pot: hideChips ? null : room.pot,
      currentBet: hideChips ? null : room.currentBet,
      dealer: room.players[room.dealerIndex]?.playerId || null,
      currentPlayer: current?.playerId || null,
      activePlayerId: current?.playerId || null,
      turnId: room.turnId || null,
      communityCards: room.communityCards,
      actionDeadline: room.actionDeadline || null,
      handId: room.handId || null,
      deckCommitment: room.deckCommitment || null,
      chipViewHidden: hideChips,
      overdriveProfile:
        room.gameMode === GAME_MODE.OVERDRIVE
          ? { enabled: true, label: "OVERDRIVE PROTOCOL" }
          : null,
      players: this.getViewPlayers(room, viewer),
      hasPassword: Boolean(room.password),
    };
    if (isSkillEnabled(room.skillMode)) {
      snapshot.skillState = getPublicRoomSkillSnapshot(room, viewer);
      snapshot.nullifiedCommunityCardIds = [
        ...(room.skillState?.nullifiedCommunityCardIds || []),
      ];
    }
    return snapshot;
  }

  getViewPlayers(room, viewer = null) {
    const hideChips = Boolean(viewer && isChipViewHiddenFor(room, viewer));
    return this.roomManager.getPublicPlayers(room).map((publicPlayer) => {
      const source = room.players.find((player) => player.playerId === publicPlayer.playerId);
      const self = viewer && publicPlayer.playerId === viewer.playerId;
      const forcePublicAllIn = Boolean(source?.skillRuntime?.deadEndActive && source.isAllIn);
      const next = { ...publicPlayer };
      if (hideChips) {
        next.chips = null;
        next.streetBet = null;
        next.totalBet = null;
        if (self) next.isAllIn = Boolean(source?.isAllIn);
        else next.isAllIn = forcePublicAllIn ? true : false;
      }
      return next;
    });
  }

  maskTurnForViewer(room, viewer, turn) {
    if (!viewer || !isChipViewHiddenFor(room, viewer)) return turn;
    return {
      ...turn,
      validActions: turn.playerId === viewer.playerId ? [...(turn.validActions || [])] : [],
      minRaise: null,
      maxBet: null,
      toCall: null,
      minRaiseTo: null,
      maxTotalBet: null,
      callAmount: null,
      minRaiseAmount: null,
      currentBet: null,
      pot: null,
    };
  }

  emitActionMade(room, { playerId, action, declaredAction, amount, toCallBefore = 0, forcePublicAllIn = false }) {
    room.players.forEach((viewer) => {
      const hide = isChipViewHiddenFor(room, viewer);
      const actorIsViewer = viewer.playerId === playerId;
      let viewAction = action;
      let viewDeclared = declaredAction;
      const hideAllInFx = hide && !forcePublicAllIn && !actorIsViewer;
      if (hideAllInFx && (action === "allin" || declaredAction === "allin")) {
        viewAction = toCallBefore > 0 ? "call" : "raise";
        viewDeclared = viewAction;
      }
      const payload = {
        playerId,
        action: viewAction,
        declaredAction: viewDeclared,
        amount: hide ? null : amount,
        pot: hide ? null : room.pot,
        playerChips: this.getViewPlayers(room, viewer),
        forcePublicAllIn,
      };
      if (actorIsViewer) {
        payload.ownAllInStatus = Boolean(
          room.players.find((player) => player.playerId === playerId)?.isAllIn
        );
      }
      this.emitToPlayer(viewer, "action_made", payload);
    });
  }

  broadcastRoomState(room) {
    room.players.forEach((player) => {
      this.emitToPlayer(player, "room_state", this.getRoomSnapshot(room, player));
    });
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
    room.turnSeq = 0;
    room.turnId = null;
    room.deck = [];
    room.communityCards = [];
    room.pot = 0;
    room.currentBet = 0;
    room.lastRaiseSize = room.bigBlind;
    room.handNo = 0;
    room.history = [];
    room.handResultHistory = [];
    room.lastActionAt = Date.now();
    room.rematch = null;
    room.handId = null;
    room.deckCommitment = null;
    room.handReveal = null;
    room.handRevealSent = false;
    room.handRevealDeferred = false;
    room.deferredHandReveals = [];
    room.revealedHandHistory = [];
    room.privateHandAuditHistory = [];
    room.hadAllInActionThisHand = false;
    room.allInPresentationEndsAt = 0;
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
    this.skillEngine?.expireLoanDebts?.(room);
    this.flushDeferredHandReveals(room);
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
      loadouts: gameOverPayload.loadouts || this.buildLoadoutReveal(room),
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
      if (!this.ensureValidMatchLoadouts(room)) return;
    }

    this.startHand(room);
  }

  ensureValidMatchLoadouts(room) {
    const ready = allLoadoutsConfirmed(room);
    room.players.forEach((player) => {
      const runtime = player.skillRuntime;
      if (!runtime?.invalidBuild || runtime.invalidBuildNotified) return;
      runtime.invalidBuildNotified = true;
      this.emitToPlayer(player, "skill:failed", {
        reason: "INVALID_BUILD",
        message: "当前技能构筑包含重复或无效技能，请重新配置。",
      });
    });
    if (ready) return true;

    room.phase = "drafting";
    this.broadcastRoomState(room);
    this.skillEngine.broadcastSkillState(room);
    return false;
  }

  handleSkillLoadout(room, player, skillIds) {
    if (!isSkillEnabled(room.skillMode)) return { ok: false, error: "当前房间未启用技能" };
    if (room.handNo > 0 || !["waiting", "drafting"].includes(room.phase)) {
      return { ok: false, error: "对局开始后不能更换技能" };
    }
    const result = setPlayerLoadout(player, skillIds);
    if (!result.ok) return result;
    this.emitToRoom(room, "skill:loadout:confirmed", { playerId: player.playerId });
    this.skillEngine.broadcastSkillState(room);
    this.broadcastRoomState(room);
    this.tryStartGame(room);
    return result;
  }

  handleSkillUse(room, player, payload, options = {}) {
    return this.skillEngine.requestUse(room, player, payload || {}, options);
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
      this.skillEngine.restorePrivateState(room, player);
    }
    this.emitHandHistory(room, player);

    if (!["waiting", "drafting", "game_over"].includes(room.phase)) {
      this.emitToPlayer(player, "your_cards", { cards: player.cards || [] });
      this.emitToPlayer(player, "hand_hint", this.buildHandHint(player, room.communityCards, room));
    }

    if (room.phase === "game_over") {
      const restoredIds = new Set();
      (room.revealedHandHistory || []).forEach((reveal) => {
        this.emitToPlayer(player, "hand_reveal", reveal);
        restoredIds.add(reveal.handId);
      });
      if (room.handRevealSent && room.handReveal && !restoredIds.has(room.handReveal.handId)) {
        this.emitToPlayer(player, "hand_reveal", room.handReveal);
      }
    } else if (room.handRevealSent && room.handReveal) {
      this.emitToPlayer(player, "hand_reveal", room.handReveal);
    }

    if (room.phase === "end" && room.lastHandResult) {
      this.emitToPlayer(
        player,
        "hand_result",
        this.handResultForViewer(room, room.lastHandResult, player, {
          revealAll: room.lastHandResult.reason === "showdown",
        })
      );
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
    this.emitToPlayer(player, "player_turn", this.maskTurnForViewer(room, player, {
      playerId: current.playerId,
      handId: room.handId || null,
      turnId: room.turnId || null,
      validActions: turn.validActions,
      minRaise: turn.minRaiseTo,
      maxBet: turn.maxTotalBet,
      toCall: turn.toCall,
      actionDeadline: room.actionDeadline || null,
    }));
  }

  startHand(room) {
    if (isSkillEnabled(room.skillMode) && !this.ensureValidMatchLoadouts(room)) return false;
    this.clearActionTimer(room);
    if (room.nextHandTimer) {
      clearTimeout(room.nextHandTimer);
      room.nextHandTimer = null;
    }
    room.phase = "pre_flop";
    room.handNo += 1;
    room.gameMode = normalizeGameMode(room.gameMode);
    beginHandSkills(room);
    room.players.forEach((p) => {
      p.cards = [];
      p.totalBet = 0;
      p.streetBet = 0;
      p.hasActed = false;
      p.isAllIn = false;
      p.status = p.chips > 0 ? "active" : "out";
    });
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
    // Commit the untouched server deck first. Every skill mutation is then
    // disclosed in the hand audit, so the final zones can be replayed from the
    // committed source instead of merely committing an already-favoured deck.
    this.createHandCommitment(room);
    if (isSkillEnabled(room.skillMode)) this.skillEngine.prepareDeckForHand(room);
    room.communityCards = [];
    room.pot = 0;
    room.currentBet = 0;
    room.lastRaiseSize = room.bigBlind;
    room.lastActionAt = Date.now();
    room.turnSeq = 0;
    room.turnId = null;
    room.lastHandResult = null;
    room.lastGameOverPayload = null;
    room.hadAllInActionThisHand = false;
    room.allInPresentationEndsAt = 0;
    room.history.push({ type: "hand_start", handNo: room.handNo, at: Date.now() });

    for (let i = 0; i < 2; i += 1) {
      room.players.forEach((p) => p.cards.push(room.deck.pop()));
    }
    if (isSkillEnabled(room.skillMode)) this.skillEngine.applyHoleFortune(room);
    this.logger.info("GAME", "发底牌", { roomId: room.roomId, handNo: room.handNo });
    this.eventBus.emit("game:deal_hole_cards", { roomId: room.roomId, handNo: room.handNo });

    const sbIndex = room.dealerIndex;
    const bbIndex = otherIndex(sbIndex);
    const effectiveStack = Math.min(...room.players.map((player) => player.chips));
    collectBet(room, room.players[sbIndex], Math.min(room.smallBlind, effectiveStack));
    collectBet(room, room.players[bbIndex], Math.min(room.bigBlind, effectiveStack));
    room.currentBet = Math.max(...room.players.map((player) => player.streetBet));
    if (room.players.some((player) => player.isAllIn)) {
      room.players.forEach((player) => {
        if (!player.isAllIn && player.status === "active" && player.streetBet === room.currentBet) {
          player.hasActed = true;
        }
      });
    }
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

    if (isSkillEnabled(room.skillMode)) {
      room.players.forEach((player) => this.skillEngine.restorePrivateState(room, player));
    }
    if (isSkillEnabled(room.skillMode)) this.skillEngine.onCardsDealt(room, "pre_flop");
    if (isSkillEnabled(room.skillMode)) {
      room.players.filter((player) => player.isAllIn).forEach((player) => {
        this.skillEngine.onPlayerAllIn(room, player);
      });
    }
    this.emitPrivateHandHints(room);
    if (isSkillEnabled(room.skillMode)) this.skillEngine.broadcastSkillState(room);

    this.emitToRoom(room, "community_cards", { cards: room.communityCards, phase: room.phase });
    this.broadcastRoomState(room);
    if (!this.runoutToShowdownIfAllIn(room)) this.emitTurn(room);
    return true;
  }

  emitTurn(room, { timeoutMs = ACTION_TIMEOUT_MS } = {}) {
    if (["waiting", "showdown", "end", "game_over"].includes(room.phase)) return;
    if (room.skillState?.endgameWindow) {
      this.emitEndgameWindow(room, { timeoutMs });
      return;
    }
    const current = room.players[room.currentPlayerIndex];
    if (current?.status === "disconnected" && isActionablePlayer(room, current)) {
      room.turnSeq = Number(room.turnSeq || 0) + 1;
      room.turnId = `${room.handId || room.handNo}:${room.turnSeq}`;
      const pausedTurn = { validActions: [], minRaiseTo: 0, maxTotalBet: 0, toCall: 0 };
      this.scheduleActionTimeout(room, room.currentPlayerIndex, pausedTurn, timeoutMs);
      this.emitToRoom(room, "player_turn", {
        playerId: current.playerId,
        handId: room.handId || null,
        turnId: room.turnId,
        validActions: [],
        minRaise: 0,
        maxBet: 0,
        toCall: 0,
        actionDeadline: room.actionDeadline,
      });
      this.broadcastRoomState(room);
      return;
    }
    if (!current || current.status !== "active" || !isActionablePlayer(room, current)) {
      const next = this.findNextActionPlayer(room, room.currentPlayerIndex);
      if (next < 0) {
        if (this.runoutToShowdownIfAllIn(room)) return;
        if (isStreetComplete(room)) this.moveToNextStreet(room);
        return;
      }
      room.currentPlayerIndex = next;
      this.emitTurn(room, { timeoutMs });
      return;
    }
    const turnPlayer = room.players[room.currentPlayerIndex];
    const turn = getValidActions(room, room.currentPlayerIndex);
    room.turnSeq = Number(room.turnSeq || 0) + 1;
    room.turnId = `${room.handId || room.handNo}:${room.turnSeq}`;
    this.scheduleActionTimeout(room, room.currentPlayerIndex, turn, timeoutMs);
    if (isSkillEnabled(room.skillMode)) this.skillEngine.onBettingDecisionStart(room, turnPlayer);
    room.players.forEach((viewer) => {
      const viewed = this.maskTurnForViewer(room, viewer, {
        playerId: turnPlayer.playerId,
        handId: room.handId || null,
        turnId: room.turnId,
        validActions: turn.validActions,
        minRaise: turn.minRaiseTo,
        maxBet: turn.maxTotalBet,
        toCall: turn.toCall,
        actionDeadline: room.actionDeadline,
      });
      this.emitToPlayer(viewer, "player_turn", viewed);
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
      if (isActionablePlayer(room, p)) return idx;
    }
    return -1;
  }

  tryOpenEndgameResponseWindow(room) {
    if (!isSkillEnabled(room.skillMode) || !room.skillState) return false;
    if (room.skillState.endgameWindow || room.skillState.endgameActive || room.skillState.fairnessActive) {
      return false;
    }
    if (room.skillState.endgameWindowResolved) return false;
    const aggressorId = room.skillState.callToZeroAggressorId || null;
    if (aggressorId) {
      const aggressor = room.players.find((player) => player.playerId === aggressorId);
      const caller = room.players.find((player) => player.playerId !== aggressorId);
      const deadEndMadeAllInPublic = Boolean(
        caller?.skillRuntime?.deadEndActive && caller.isAllIn
      );
      if (
        aggressor
        && caller
        && Number(caller.chips) <= 0
        && isChipViewHiddenFor(room, aggressor)
        && !deadEndMadeAllInPublic
      ) {
        // The existence of this extra response window would reveal that the
        // disguised caller reached zero. Suppress it at the authoritative
        // rules layer; never create a payload for the client to hide.
        room.skillState.endgameWindowResolved = true;
        return false;
      }
    }
    const holders = room.players.filter((player) => {
      const opponent = room.players.find((candidate) => candidate.playerId !== player.playerId);
      if (!opponent || Number(opponent.chips) > 0) return false;
      if (aggressorId && player.playerId !== aggressorId) return false;
      if (!player.skillRuntime?.equippedSkillIds?.includes("ENDGAME")) return false;
      if ((player.skillRuntime.skillUsesThisHand?.ENDGAME || 0) > 0) return false;
      if ((Number(player.skillRuntime.abyssEnergy) || 0) < 8) return false;
      if (player.skillRuntime.lockedThisHand) return false;
      if (player.status !== "active") return false;
      return true;
    });
    if (!holders.length) return false;
    if (!aggressorId && holders.length > 1) return false;
    const holder = aggressorId
      ? holders.find((player) => player.playerId === aggressorId)
      : holders[0];
    if (!holder) return false;
    const wouldGetBettingTurn = isActionablePlayer(room, holder)
      && (!holder.hasActed || holder.streetBet !== room.currentBet);
    if (wouldGetBettingTurn) return false;
    room.skillState.endgameWindow = { playerId: holder.playerId };
    room.currentPlayerIndex = room.players.findIndex((player) => player.playerId === holder.playerId);
    this.emitEndgameWindow(room);
    return true;
  }

  emitEndgameWindow(room, { timeoutMs = ACTION_TIMEOUT_MS } = {}) {
    const holderId = room.skillState?.endgameWindow?.playerId;
    const holderIndex = room.players.findIndex((player) => player.playerId === holderId);
    const holder = room.players[holderIndex];
    if (!holder) {
      this.closeEndgameWindow(room, { used: false });
      return;
    }
    room.currentPlayerIndex = holderIndex;
    room.turnSeq = Number(room.turnSeq || 0) + 1;
    room.turnId = `${room.handId || room.handNo}:${room.turnSeq}`;
    this.scheduleActionTimeout(room, holderIndex, { validActions: ["skip_endgame"] }, timeoutMs);
    if (isSkillEnabled(room.skillMode)) this.skillEngine.onBettingDecisionStart(room, holder);
    room.players.forEach((viewer) => {
      const isHolder = viewer.playerId === holder.playerId;
      this.emitToPlayer(viewer, "player_turn", {
        playerId: holder.playerId,
        handId: room.handId || null,
        turnId: room.turnId,
        validActions: isHolder ? ["skip_endgame"] : [],
        minRaise: 0,
        maxBet: 0,
        toCall: 0,
        endgameWindow: true,
        actionDeadline: room.actionDeadline,
      });
    });
    this.broadcastRoomState(room);
    if (holder.isBot) this.scheduleBotEndgameWindow(room, holderIndex);
  }

  shouldBotUseEndgame(room, player) {
    if (!player?.skillRuntime?.equippedSkillIds?.includes("ENDGAME")) return false;
    if ((Number(player.skillRuntime.abyssEnergy) || 0) < 8) return false;
    if (player.skillRuntime.lockedThisHand) return false;
    const hand = this.evaluatePlayerHand(player, room);
    if (!hand) return true;
    return Number(hand.category) <= 6;
  }

  scheduleBotEndgameWindow(room, holderIndex) {
    if (room.botActionTimer) clearTimeout(room.botActionTimer);
    const handId = room.handId;
    const turnId = room.turnId;
    const holderId = room.players[holderIndex]?.playerId;
    const timer = setTimeout(() => {
      if (room.botActionTimer !== timer) return;
      room.botActionTimer = null;
      if (room.handId !== handId || room.turnId !== turnId) return;
      if (!room.skillState?.endgameWindow) return;
      const holder = room.players[holderIndex];
      if (!holder || holder.playerId !== holderId || !holder.isBot) return;
      this.resolveBotEndgameWindow(room, holder);
    }, 800);
    room.botActionTimer = timer;
    if (typeof timer.unref === "function") timer.unref();
  }

  resolveBotEndgameWindow(room, holder) {
    if (!room.skillState?.endgameWindow || room.skillState.endgameWindow.playerId !== holder?.playerId) {
      return { used: false };
    }
    if (this.shouldBotUseEndgame(room, holder)) {
      const used = this.skillEngine.requestUse(room, holder, {
        skillId: "ENDGAME",
        target: {},
        requestId: `bot_endgame_${holder.playerId}`,
      });
      if (!used?.ok || used.status !== "SUCCESS") {
        this.closeEndgameWindow(room, { used: false });
        return { used: false };
      }
      return { used: true };
    }
    this.closeEndgameWindow(room, { used: false });
    return { used: false };
  }

  closeEndgameWindow(room, { used = false } = {}) {
    if (!room.skillState) return;
    room.skillState.endgameWindow = null;
    room.skillState.endgameWindowResolved = true;
    this.clearActionTimer(room);
    if (used || room.skillState.endgameActive) return;
    if (this.runoutToShowdownIfAllIn(room)) return;
    if (isStreetComplete(room)) this.moveToNextStreet(room);
    else this.emitTurn(room);
  }

  continueAfterEndgame(room) {
    if (room.skillState) {
      room.skillState.endgameWindow = null;
      room.skillState.endgameWindowResolved = true;
      room.skillState.bettingClosed = true;
    }
    this.clearActionTimer(room);
    this.runoutToShowdownIfAllIn(room);
  }

  settleLoanKill(room, winner, loser) {
    if (!room || !winner || !loser) return;
    this.clearActionTimer(room);
    winner.chips += room.pot;
    room.pot = 0;
    loser.chips = 0;
    loser.status = "out";
    room.phase = "end";
    this.skillEngine.endHand(room, { reason: "loan_kill", winner, tie: false });
    const handResult = this.buildHandResultPayload(room, {
      reason: "loan_kill",
      winner,
      tie: false,
      pot: 0,
      playersDetail: room.players.map((p) =>
        this.buildPlayerHandDetail(p, room.communityCards, { folded: p.status === "folded" }, room)
      ),
    });
    this.storeAndEmitHandResult(room, handResult, { revealAll: false });
    this.deferHandCommitmentReveal(room);
    this.finalizeHand(room, this.getHandFinalizeDelay(room, handResult.settleMs));
  }

  settleByRetreat(room, folder) {
    this.clearActionTimer(room);
    room.players.forEach((player) => {
      const returned = Math.max(0, Number(player.totalBet) || 0);
      player.chips += returned;
      player.totalBet = 0;
      player.streetBet = 0;
    });
    room.pot = 0;
    if (folder?.skillRuntime) folder.skillRuntime.retreatTriggered = true;
    room.phase = "end";
    this.emitActionMade(room, {
      playerId: folder.playerId,
      action: "retreat",
      declaredAction: "retreat",
      amount: 0,
    });
    const handResult = this.buildHandResultPayload(room, {
      reason: "retreat",
      winner: null,
      tie: true,
      pot: 0,
      playersDetail: room.players.map((p) =>
        this.buildPlayerHandDetail(p, room.communityCards, {
          folded: p.status === "folded",
        }, room)
      ),
    });
    this.skillEngine.endHand(room, { reason: "retreat", winner: null, tie: true });
    this.storeAndEmitHandResult(room, handResult, { revealAll: false });
    this.deferHandCommitmentReveal(room);
    this.finalizeHand(room, this.getHandFinalizeDelay(room, handResult.settleMs));
  }

  settleByFold(room, { foldOrigin = "user" } = {}) {
    const active = getActivePlayers(room);
    if (active.length !== 1) return;
    this.clearActionTimer(room);
    const winner = active[0];
    const pot = room.pot;
    winner.chips += room.pot;
    room.pot = 0;
    if (isSkillEnabled(room.skillMode)) {
      this.skillEngine.applySettlementModifiers(room, {
        reason: "fold",
        winner,
        tie: false,
        foldOrigin,
      });
    }
    room.phase = "end";

    this.logger.info("GAME", "弃牌结算", { roomId: room.roomId, winner: winner.playerId, pot });
    this.eventBus.emit("game:fold_win", { roomId: room.roomId, winner: winner.playerId, pot });

    this.emitActionMade(room, {
      playerId: winner.playerId,
      action: "win_by_fold",
      declaredAction: "win_by_fold",
      amount: pot,
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
    this.skillEngine.endHand(room, { reason: "fold", winner, tie: false });
    this.storeAndEmitHandResult(room, handResult, { revealAll: false });
    this.deferHandCommitmentReveal(room);
    this.finalizeHand(room, this.getHandFinalizeDelay(room, handResult.settleMs));
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

    this.finishStreetDeal(room, nextPhase, { autoRunout });
  }

  finishStreetDeal(room, nextPhase, { autoRunout = false } = {}) {
    room.phase = nextPhase;
    onStreetPhaseChanged(room, nextPhase);
    room.players.forEach((p) => {
      p.streetBet = 0;
      p.hasActed = false;
    });
    room.currentBet = 0;
    room.lastRaiseSize = room.bigBlind;

    if (isSkillEnabled(room.skillMode) && ["flop", "turn", "river"].includes(nextPhase)) {
      this.skillEngine.applyBoardFortune(room, nextPhase);
    }

    if (nextPhase === "flop") {
      const burned = room.deck.pop();
      if (room.skillState && burned) room.skillState.burnedCards.push(burned);
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
      nullifiedCommunityCardIds: [...(getPublicRoomSkillSnapshot(room).nullifiedCommunityCardIds || [])],
    });
    if (isSkillEnabled(room.skillMode)) this.skillEngine.onCardsDealt(room, nextPhase);
    if (isSkillEnabled(room.skillMode)) this.skillEngine.broadcastSkillState(room);
    this.broadcastRoomState(room);
    if (!autoRunout) this.emitTurn(room);
  }

  runoutToShowdownIfAllIn(room) {
    if (room.skillState?.endgameWindow) return true;
    if (this.tryOpenEndgameResponseWindow(room)) return true;
    const active = getActivePlayers(room);
    const actionable = active.filter((p) => isActionablePlayer(room, p));
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
      // A malformed/over-edited board must still terminate cleanly. Return the
      // matched pot as a void tie instead of leaving the room stuck at showdown.
      const recipients = alive.length ? alive : room.players.filter((p) => p.status !== "folded");
      if (recipients.length && room.pot > 0) {
        const share = Math.floor(room.pot / recipients.length);
        recipients.forEach((p) => {
          p.chips += share;
        });
        const remainder = room.pot - share * recipients.length;
        if (remainder > 0) {
          const bigBlind = room.players[otherIndex(room.dealerIndex)];
          (recipients.includes(bigBlind) ? bigBlind : recipients[0]).chips += remainder;
        }
        room.pot = 0;
      }
      this.logger.warn("GAME", "摊牌无有效牌型，按无效平局退还底池", {
        roomId: room.roomId,
        pot: potBefore,
      });
      this.eventBus.emit("game:showdown", {
        roomId: room.roomId,
        tie: true,
        pot: potBefore,
        void: true,
      });
      this.emitToRoom(room, "showdown", {
        players: [],
        winner: null,
        tie: true,
        void: true,
        pot: potBefore,
      });
      const handResult = this.buildHandResultPayload(room, {
        reason: "showdown",
        winner: null,
        tie: true,
        pot: potBefore,
        playersDetail: room.players.map((player) =>
          this.buildPlayerHandDetail(player, room.communityCards, {}, room)
        ),
      });
      this.skillEngine.endHand(room, { reason: "showdown", winner: null, tie: true });
      this.storeAndEmitHandResult(room, handResult, { revealAll: true });
      this.revealHandCommitment(room);
      room.phase = "end";
      this.finalizeHand(room, this.getHandFinalizeDelay(room, handResult.settleMs));
      return;
    }

    const tieNatural = second ? compareEvaluatedHands(first.hand, second.hand) === 0 : false;
    const endgame = room.skillState?.endgameActive;
    const caster = endgame
      ? room.players.find((player) => player.playerId === endgame.casterId)
      : null;
    const casterEntry = caster ? result.find((entry) => entry.player.playerId === caster.playerId) : null;
    const otherEntry = caster ? result.find((entry) => entry.player.playerId !== caster.playerId) : null;
    const sameCategory = Boolean(
      endgame?.execution && casterEntry && otherEntry && casterEntry.hand.category === otherEntry.hand.category
    );
    const naturalCasterCmp = casterEntry && otherEntry
      ? compareEvaluatedHands(casterEntry.hand, otherEntry.hand)
      : 0;
    const endgameExecutionOverride = Boolean(sameCategory && naturalCasterCmp <= 0);
    let tie = tieNatural && !sameCategory;
    let winnerPlayer = tie ? null : first.player;
    if (sameCategory) {
      winnerPlayer = caster || first.player;
      tie = false;
    }

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
        const bigBlind = room.players[otherIndex(room.dealerIndex)];
        if (bigBlind) bigBlind.chips += oddChip;
      }
    } else {
      winnerPlayer.chips += room.pot;
    }
    room.pot = 0;
    if (isSkillEnabled(room.skillMode) && !tie) {
      this.skillEngine.applySettlementModifiers(room, {
        reason: "showdown",
        winner: winnerPlayer,
        winnerCategory: result.find((entry) => entry.player.playerId === winnerPlayer.playerId)?.hand?.category ?? null,
        tie: false,
      });
    }

    this.logger.info("GAME", "摊牌结算", {
      roomId: room.roomId,
      winner: tie ? "tie" : winnerPlayer.playerId,
      pot: potBefore,
      returned,
    });
    this.eventBus.emit("game:showdown", {
      roomId: room.roomId,
      tie,
      pot: potBefore,
      endgameExecution: endgameExecutionOverride,
      endgameExecutionOverride,
    });

    const showdownPayload = {
      players: result.map((x) => ({
        playerId: x.player.playerId,
        name: x.player.name,
        cards: x.player.cards,
        handName: x.hand.handName,
        handRank: x.hand.category,
        bestFive: x.hand.bestFive,
      })),
      winner: tie ? null : winnerPlayer.playerId,
      tie,
      endgameExecution: endgameExecutionOverride,
      endgameExecutionOverride,
      pot: potBefore,
    };
    room.players.forEach((viewer) => {
      this.emitToPlayer(viewer, "showdown", {
        ...showdownPayload,
        pot: isChipViewHiddenFor(room, viewer) ? null : showdownPayload.pot,
      });
    });
      const handResult = this.buildHandResultPayload(room, {
        reason: "showdown",
        winner: tie ? null : winnerPlayer,
        tie,
        pot: potBefore,
        endgameExecution: endgameExecutionOverride,
        endgameExecutionOverride,
        playersDetail: result.map((x) =>
          this.buildPlayerHandDetail(x.player, room.communityCards, {}, room)
        ),
      });
    this.skillEngine.endHand(room, {
      reason: "showdown",
      winner: tie ? null : winnerPlayer,
      tie,
    });
    this.storeAndEmitHandResult(room, handResult, { revealAll: true });
    this.revealHandCommitment(room);
    room.phase = "end";
    this.finalizeHand(room, this.getHandFinalizeDelay(room, handResult.settleMs));
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
    if (can("fold")) return { action: "fold" };
    if (can("check")) return { action: "check" };
    const fallback = pickAutoAction(turn.validActions);
    return { action: fallback || "check" };
  }

  scheduleBotAction(room, botIndex, turn) {
    if (room.botActionTimer) clearTimeout(room.botActionTimer);
    const handId = room.handId;
    const turnId = room.turnId;
    const botId = room.players[botIndex]?.playerId;
    const timer = setTimeout(() => {
      if (room.botActionTimer !== timer) return;
      room.botActionTimer = null;
      if (room.handId !== handId || room.turnId !== turnId) return;
      if (["waiting", "showdown", "end", "game_over"].includes(room.phase)) return;
      if (room.currentPlayerIndex !== botIndex) return;
      const bot = room.players[botIndex];
      if (!bot || bot.playerId !== botId || !bot.isBot || bot.status !== "active" || bot.isAllIn) return;
      if (isSkillEnabled(room.skillMode)) this.skillEngine.tryBotTurnSkill(room, bot);
      const picked = this.chooseBotAction(room, botIndex, turn);
      this.handlePlayerAction(room, botIndex, picked.action, picked.amount);
    }, 800);
    room.botActionTimer = timer;
    if (typeof timer.unref === "function") timer.unref();
  }

  resolveDisconnectTimeout(room, loser) {
    if (
      !room ||
      !loser ||
      this.roomManager.getRoom(room.roomId) !== room ||
      !room.players.includes(loser) ||
      room.phase === "game_over"
    ) {
      return { ok: false, error: "stale_disconnect_timeout" };
    }
    this.abortPendingRoomWork(room);
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
    this.flushDeferredHandReveals(room);
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
    return { ok: true };
  }

  handlePlayerAction(room, playerIndex, action, amount, options = {}) {
    if (!room || room.players.length !== 2) {
      return { ok: false, error: "牌局席位状态异常，请重新进入房间" };
    }
    if (
      options.enforceTurnToken &&
      (options.handId !== room.handId || options.turnId !== room.turnId)
    ) {
      return { ok: false, error: "该操作已过期，请按当前回合重新选择" };
    }
    if (["waiting", "drafting", "showdown", "end", "game_over", "before_turn", "before_river"].includes(room.phase)) {
      return { ok: false, error: "当前阶段不可行动" };
    }
    const player = room.players[playerIndex];
    const opponent = room.players[otherIndex(playerIndex)];
    if (!player || !opponent) return { ok: false, error: "牌局席位状态异常，请重新进入房间" };
    if (room.skillState?.endgameWindow) {
      const holderId = room.skillState.endgameWindow.playerId;
      if (player.playerId !== holderId) return { ok: false, error: "当前不是你的终局响应窗口" };
      if (action === "skip_endgame") {
        this.closeEndgameWindow(room, { used: false });
        return { ok: true, skippedEndgame: true };
      }
      return { ok: false, error: "请选择发动终局或放弃" };
    }
    if (room.skillState?.bettingClosed) {
      return { ok: false, error: "终局已关闭下注" };
    }
    if (room.currentPlayerIndex !== playerIndex) return { ok: false, error: "未轮到你行动" };

    const systemCanFoldDisconnected = options.system && action === "fold" && player.status === "disconnected";
    if ((player.status !== "active" && !systemCanFoldDisconnected) || player.isAllIn) {
      return { ok: false, error: "当前不可行动" };
    }

    const toCall = getToCall(room, player);
    const maxTotal = getEffectiveMaxTotal(room, playerIndex);
    const oldCurrentBet = room.currentBet;
    const foldOrigin = options.foldOrigin || (options.system ? "system" : "user");
    const hideChipView = isChipViewHiddenFor(room, player);
    let appliedAction = action;
    let appliedAmount = 0;

    if (action === "fold") {
      if (room.skillState?.noFoldActive) return { ok: false, error: "恐吓生效期间不能弃牌" };
      if (room.skillState?.bettingClosed) return { ok: false, error: "终局已关闭下注" };
      player.status = "folded";
      player.hasActed = true;
      onPlayerFolded(player);
      if (
        foldOrigin === "user"
        && player.skillRuntime?.retreatActive
        && !room.skillState?.fairnessActive
      ) {
        this.settleByRetreat(room, player);
        return { ok: true };
      }
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
        if (player.isAllIn || paid < toCall) appliedAction = "allin";
        player.hasActed = true;
      }
    } else if (action === "raise") {
      if (opponent.isAllIn && hideChipView) {
        // A rejected Raise would itself reveal the disguised opponent's All In.
        // Treat every submitted amount as a committed decision and collapse it
        // to the remaining legal passive action instead of returning an oracle.
        if (toCall > 0) {
          const paid = collectBet(room, player, toCall);
          appliedAmount = paid;
          appliedAction = player.isAllIn || paid < toCall ? "allin" : "call";
        } else {
          appliedAction = "check";
        }
        player.hasActed = true;
      } else {
        if (opponent.isAllIn) {
          return { ok: false, error: "对手已All In，不能再加注" };
        }
        const targetTotalRaw = Number(amount);
        const minRaiseTo = getMinRaiseTo(room);
        if (!Number.isFinite(targetTotalRaw)) {
          return { ok: false, error: hideChipView ? "下注金额格式错误" : "加注金额必须是整数" };
        }
        if (!hideChipView && !Number.isInteger(targetTotalRaw)) {
          return { ok: false, error: "加注金额必须是整数" };
        }

        let targetTotal = hideChipView ? Math.round(targetTotalRaw) : targetTotalRaw;
        if (hideChipView) {
          if (player.chips <= 0 || maxTotal <= player.streetBet) {
            return { ok: false, error: "当前操作无效" };
          }
          if (targetTotal > maxTotal) {
            targetTotal = maxTotal;
          } else if (targetTotal < minRaiseTo) {
            targetTotal = maxTotal >= minRaiseTo ? minRaiseTo : maxTotal;
          }
        } else {
          if (targetTotal > maxTotal) return { ok: false, error: "超过有效筹码上限" };
          if (targetTotal < minRaiseTo) return { ok: false, error: `最小加注到 ${minRaiseTo}` };
          if (targetTotal <= room.currentBet) return { ok: false, error: "加注必须高于当前注" };
        }

        const need = Math.max(0, targetTotal - player.streetBet);
        if (need <= 0) return { ok: false, error: hideChipView ? "当前操作无效" : "加注必须高于当前注" };
        const paid = collectBet(room, player, need);
        appliedAmount = paid;

        if (player.streetBet > room.currentBet) {
          const raiseSize = player.streetBet - room.currentBet;
          room.currentBet = player.streetBet;
          if (raiseSize >= room.lastRaiseSize) {
            room.lastRaiseSize = raiseSize;
            room.players.forEach((p) => {
              if (p.playerId !== player.playerId && p.status === "active" && !p.isAllIn) {
                p.hasActed = false;
              }
            });
          }
        }
        player.hasActed = true;
        appliedAction = player.isAllIn
          ? "allin"
          : player.streetBet > oldCurrentBet
            ? "raise"
            : toCall > 0
              ? "call"
              : "check";
      }
    } else if (action === "allin") {
      if (!getValidActions(room, playerIndex).validActions.includes("allin")) {
        return { ok: false, error: "当前投入上限下不可全押" };
      }
      if (player.chips <= 0) return { ok: false, error: "无可用筹码" };
      if (opponent.isAllIn) {
        // Facing an all-in: commit remaining chips toward the call only.
        if (toCall <= 0) {
          return { ok: false, error: hideChipView ? "当前操作无效" : "对手已All In，只能过牌或等待" };
        }
        const paid = collectBet(room, player, toCall);
        appliedAmount = paid;
        player.hasActed = true;
        appliedAction = player.isAllIn ? "allin" : "call";
      } else {
        const targetTotal = Math.min(player.streetBet + player.chips, maxTotal);
        if (targetTotal < player.streetBet) return { ok: false, error: "当前不可全押" };
        const need = Math.max(0, targetTotal - player.streetBet);
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
        appliedAction = player.isAllIn
          ? "allin"
          : player.streetBet > oldCurrentBet
            ? "raise"
            : "call";
      }
      if (room.skillState?.contributionCap != null) appliedAction = "allin";
      if (player.skillRuntime) {
        player.skillRuntime.allInAction = true;
        player.skillRuntime.stackCommitted = Boolean(player.isAllIn);
      }
    } else {
      return { ok: false, error: "未知操作" };
    }

    const actionAt = Date.now();
    if (action === "allin" || appliedAction === "allin") {
      room.hadAllInActionThisHand = true;
      room.allInPresentationEndsAt = actionAt + ALL_IN_EFFECT_MS;
    }

    if (player.streetBet > oldCurrentBet && ["raise", "allin"].includes(appliedAction)) {
      this.skillEngine.onAggressiveAction(room, player);
    }
    if (action === "allin" || appliedAction === "allin") {
      this.skillEngine.onPlayerAllIn(room, player);
    }
    if (room.skillState && Number(player.chips) <= 0) {
      const wasCall = action === "call"
        || appliedAction === "call"
        || (appliedAction === "allin" && toCall > 0 && player.streetBet <= oldCurrentBet);
      if (wasCall) room.skillState.callToZeroAggressorId = opponent.playerId;
    }

    this.clearActionTimer(room);
    room.history.push({
      type: "action",
      action: appliedAction,
      declaredAction: action,
      amount: appliedAmount,
      playerId: player.playerId,
      origin: foldOrigin,
      at: actionAt,
    });
    room.lastActionAt = actionAt;

    this.logger.info("GAME", "玩家行动", {
      roomId: room.roomId,
      playerId: player.playerId,
      action: appliedAction,
      declaredAction: action,
      amount: appliedAmount,
    });
    this.eventBus.emit("game:action", {
      roomId: room.roomId,
      playerId: player.playerId,
      action: appliedAction,
      declaredAction: action,
      amount: appliedAmount,
    });

    this.emitActionMade(room, {
      playerId: player.playerId,
      action: appliedAction,
      declaredAction: action,
      amount: appliedAmount,
      toCallBefore: toCall,
      forcePublicAllIn: Boolean(options.fromSkill === "DEAD_END" || (player.skillRuntime?.deadEndActive && appliedAction === "allin")),
    });

    if (getActivePlayers(room).length === 1) {
      this.settleByFold(room, { foldOrigin });
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

module.exports = {
  GameEngine,
  HAND_SETTLE_MS,
  PARTIAL_BOARD_SETTLE_MS,
  FULL_BOARD_SETTLE_MS,
  ALL_IN_EFFECT_MS,
  ACTION_TIMEOUT_MS,
  getHandSettlementMs,
};
