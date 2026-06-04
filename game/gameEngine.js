const { createShuffledDeck } = require("../utils/deck");
const { pickBestFive, compareEvaluatedHands } = require("./handEvaluator");
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

class GameEngine {
  constructor({ io, roomManager, logger, eventBus }) {
    this.io = io;
    this.roomManager = roomManager;
    this.logger = logger;
    this.eventBus = eventBus;
  }

  emitToRoom(room, event, payload) {
    this.io.to(room.roomId).emit(event, payload);
  }

  emitToPlayer(player, event, payload) {
    if (player.socketId) this.io.to(player.socketId).emit(event, payload);
  }

  buildPlayerHandDetail(player, communityCards, extra = {}) {
    const cards = [...(player.cards || [])];
    const detail = {
      playerId: player.playerId,
      name: player.name,
      cards,
      ...extra,
    };
    const pool = [...cards, ...(communityCards || [])];
    if (pool.length >= 5) {
      const hand = pickBestFive(pool);
      detail.handName = hand.handName;
      detail.bestFive = hand.bestFive;
    } else if (extra.folded) {
      detail.handName = cards.length ? "已弃牌（未成牌）" : "已弃牌";
    } else if (cards.length > 0 && pool.length < 5) {
      detail.handName = "未成牌";
    }
    return detail;
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
    return {
      roomId: room.roomId,
      phase: room.phase,
      pot: room.pot,
      currentBet: room.currentBet,
      dealer: room.players[room.dealerIndex]?.playerId || null,
      currentPlayer: current?.playerId || null,
      communityCards: room.communityCards,
      players: this.roomManager.getPublicPlayers(room),
    };
  }

  broadcastRoomState(room) {
    this.emitToRoom(room, "room_state", this.getRoomSnapshot(room));
  }

  resetRoomForRematch(room) {
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
    room.players.forEach((player) => {
      player.chips = 1000;
      player.cards = [];
      player.status = "active";
      player.totalBet = 0;
      player.streetBet = 0;
      player.hasActed = false;
      player.isAllIn = false;
      player.disconnectedAt = null;
    });
  }

  closeRoom(room, reason = "rematch_timeout") {
    if (!room || !this.roomManager.getRoom(room.roomId)) return;
    if (room.rematch?.timer) {
      clearTimeout(room.rematch.timer);
      room.rematch.timer = null;
    }
    this.emitToRoom(room, "room_closed", { reason });
    this.roomManager.destroyRoom(room.roomId);
  }

  getRematchPlayers(room) {
    return room.players.filter((p) => !p.isBot && p.socketId);
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

    room.rematch.accepted.add(player.playerId);
    const voters = this.getRematchPlayers(room);
    const allAccepted = voters.length > 0 && voters.every((p) => room.rematch.accepted.has(p.playerId));
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
    if (room.phase !== "waiting") return;
    if (room.players.length !== 2) return;
    if (room.players.some((p) => p.chips <= 0)) return;

    const humans = room.players.filter((p) => !p.isBot);
    const bots = room.players.filter((p) => p.isBot);
    if (humans.length === 2) {
      if (humans.some((p) => !p.socketId)) return;
    } else if (humans.length === 1 && bots.length === 1) {
      if (!humans[0].socketId) return;
    } else {
      return;
    }

    this.startHand(room);
  }

  startHand(room) {
    room.phase = "pre_flop";
    room.handNo += 1;
    room.deck = createShuffledDeck();
    room.communityCards = [];
    room.pot = 0;
    room.currentBet = 0;
    room.lastRaiseSize = room.bigBlind;
    room.lastActionAt = Date.now();
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

    room.players.forEach((player, idx) => {
      this.emitToPlayer(player, "room_joined", {
        roomId: room.roomId,
        playerId: player.playerId,
        reconnectToken: player.reconnectToken,
        players: this.roomManager.getPublicPlayers(room),
      });
      this.emitToPlayer(player, "your_cards", { cards: player.cards });
      this.emitToPlayer(player, "game_started", {
        dealer: room.players[room.dealerIndex].playerId,
        opponentName: room.players[otherIndex(idx)].name,
      });
    });

    this.emitToRoom(room, "community_cards", { cards: room.communityCards, phase: room.phase });
    this.broadcastRoomState(room);
    this.emitTurn(room);
  }

  emitTurn(room) {
    if (["waiting", "showdown", "end", "game_over"].includes(room.phase)) return;
    const current = room.players[room.currentPlayerIndex];
    if (!current || current.status !== "active" || current.isAllIn) {
      const next = this.findNextActionPlayer(room, room.currentPlayerIndex);
      if (next < 0) return;
      room.currentPlayerIndex = next;
    }
    const turnPlayer = room.players[room.currentPlayerIndex];
    const turn = getValidActions(room, room.currentPlayerIndex);
    this.emitToRoom(room, "player_turn", {
      playerId: turnPlayer.playerId,
      validActions: turn.validActions,
      minRaise: turn.minRaiseTo,
      maxBet: turn.maxTotalBet,
      toCall: turn.toCall,
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
      if (p.status === "active" && !p.isAllIn) return idx;
    }
    return -1;
  }

  settleByFold(room) {
    const active = getActivePlayers(room);
    if (active.length !== 1) return;
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
    const loser = room.players.find((p) => p.playerId !== winner.playerId);
    this.emitToRoom(
      room,
      "hand_result",
      this.buildHandResultPayload(room, {
        reason: "fold",
        winner,
        tie: false,
        pot,
        playersDetail: room.players.map((p) =>
          this.buildPlayerHandDetail(p, room.communityCards, {
            folded: p.status === "folded",
          })
        ),
      })
    );
    this.finalizeHand(room);
  }

  moveToNextStreet(room) {
    const nextPhase = {
      pre_flop: "flop",
      flop: "turn",
      turn: "river",
      river: "showdown",
    }[room.phase];
    if (!nextPhase) return;
    room.phase = nextPhase;
    room.players.forEach((p) => {
      p.streetBet = 0;
      p.hasActed = false;
    });
    room.currentBet = 0;
    room.lastRaiseSize = room.bigBlind;

    if (nextPhase === "flop") {
      room.deck.pop();
      room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    } else if (nextPhase === "turn" || nextPhase === "river") {
      room.deck.pop();
      room.communityCards.push(room.deck.pop());
    }

    if (nextPhase === "showdown") {
      this.settleShowdown(room);
      return;
    }
    room.currentPlayerIndex = room.dealerIndex;
    this.emitToRoom(room, "community_cards", { cards: room.communityCards, phase: room.phase });
    this.broadcastRoomState(room);
    this.emitTurn(room);
  }

  runoutToShowdownIfAllIn(room) {
    const active = getActivePlayers(room);
    const waiting = active.filter((p) => !p.isAllIn);
    if (waiting.length > 0) return false;
    while (["pre_flop", "flop", "turn", "river"].includes(room.phase)) {
      this.moveToNextStreet(room);
      if (room.phase === "showdown" || room.phase === "end") return true;
    }
    return room.phase === "showdown" || room.phase === "end";
  }

  settleShowdown(room) {
    room.phase = "showdown";
    const returned = this.normalizeHeadsUpShowdownPot(room);
    const alive = getActivePlayers(room);
    const result = alive.map((p) => ({
      player: p,
      hand: pickBestFive([...p.cards, ...room.communityCards]),
    }));
    result.sort((a, b) => compareEvaluatedHands(b.hand, a.hand));
    const first = result[0];
    const second = result[1];
    const tie = second ? compareEvaluatedHands(first.hand, second.hand) === 0 : false;
    const potBefore = room.pot;

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
    this.emitToRoom(
      room,
      "hand_result",
      this.buildHandResultPayload(room, {
        reason: "showdown",
        winner: tie ? null : first.player,
        tie,
        pot: potBefore,
        playersDetail: result.map((x) =>
          this.buildPlayerHandDetail(x.player, room.communityCards)
        ),
      })
    );
    room.phase = "end";
    this.finalizeHand(room);
  }

  finalizeHand(room) {
    room.phase = "end";
    room.currentPlayerIndex = -1;
    room.currentBet = 0;
    this.broadcastRoomState(room);

    setTimeout(() => {
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
    }, HAND_SETTLE_MS);
  }

  chooseBotAction(room, botIndex, turn) {
    const bot = room.players[botIndex];
    const toCall = turn.toCall;
    const can = (x) => turn.validActions.includes(x);

    if (toCall === 0) {
      if (can("raise") && Math.random() < 0.25) {
        const min = turn.minRaise;
        const max = Math.max(min, turn.maxBet);
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
    loser.status = "out";
    const winner = room.players.find((p) => p.playerId !== loser.playerId);
    this.logger.warn("GAME", "断线超时整场判负", {
      roomId: room.roomId,
      loser: loser.playerId,
      winner: winner?.playerId || null,
    });
    this.eventBus.emit("game:disconnect_forfeit", { roomId: room.roomId, loser: loser.playerId });
    room.phase = "game_over";
    room.pot = 0;
    room.currentBet = 0;
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

  handlePlayerAction(room, playerIndex, action, amount) {
    if (["waiting", "showdown", "end", "game_over"].includes(room.phase)) {
      return { ok: false, error: "当前阶段不可行动" };
    }
    if (room.currentPlayerIndex !== playerIndex) return { ok: false, error: "未轮到你行动" };

    const player = room.players[playerIndex];
    const opponent = room.players[otherIndex(playerIndex)];
    if (player.status !== "active" || player.isAllIn) return { ok: false, error: "当前不可行动" };

    const toCall = getToCall(room, player);
    const maxTotal = getEffectiveMaxTotal(room, playerIndex);
    const oldCurrentBet = room.currentBet;
    let appliedAction = action;
    let appliedAmount = 0;

    if (action === "fold") {
      player.status = "folded";
      player.hasActed = true;
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
      if (!Number.isFinite(targetTotal)) return { ok: false, error: "加注金额错误" };
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
      const targetTotal = Math.min(player.totalBet + player.chips, maxTotal);
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
      player.isAllIn = true;
      appliedAction = "allin";
    } else {
      return { ok: false, error: "未知操作" };
    }

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

module.exports = { GameEngine, HAND_SETTLE_MS };
