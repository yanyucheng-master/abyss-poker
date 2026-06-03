const crypto = require("crypto");

const RECONNECT_TTL_MS = 5 * 60 * 1000;

function generateCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function generateReconnectToken() {
  return crypto.randomBytes(12).toString("hex");
}

function makePlayer({ playerId, name, socketId, reconnectToken }) {
  return {
    playerId,
    reconnectToken,
    socketId,
    name,
    chips: 1000,
    cards: [],
    status: "active",
    totalBet: 0,
    streetBet: 0,
    hasActed: false,
    isAllIn: false,
    disconnectedAt: null,
    disconnectTimer: null,
    isBot: false,
    skills: [],
    buffs: [],
    relics: [],
    statusEffects: [],
  };
}

function toPublicPlayer(player) {
  return {
    playerId: player.playerId,
    name: player.name,
    chips: player.chips,
    status: player.status,
    streetBet: player.streetBet,
    totalBet: player.totalBet,
    isConnected: Boolean(player.socketId),
    isBot: Boolean(player.isBot),
  };
}

class RoomManager {
  constructor({ logger, eventBus, reconnectTtlMs = RECONNECT_TTL_MS }) {
    this.rooms = new Map();
    this.logger = logger;
    this.eventBus = eventBus;
    this.reconnectTtlMs = reconnectTtlMs;
  }

  createRoom(password) {
    let roomId = generateCode();
    while (this.rooms.has(roomId)) roomId = generateCode();
    const room = {
      roomId,
      password: password || null,
      ownerPlayerId: null,
      players: [],
      phase: "waiting",
      dealerIndex: 0,
      currentPlayerIndex: 0,
      deck: [],
      communityCards: [],
      pot: 0,
      currentBet: 0,
      lastRaiseSize: 50,
      smallBlind: 25,
      bigBlind: 50,
      handNo: 0,
      history: [],
      lastActionAt: Date.now(),
    };
    this.rooms.set(roomId, room);
    this.logger.info("ROOM", "房间创建", { roomId });
    this.eventBus.emit("room:created", { roomId });
    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(String(roomId || "").toUpperCase());
  }

  getRoomBySocket(socketId) {
    for (const room of this.rooms.values()) {
      const playerIndex = room.players.findIndex((p) => p.socketId === socketId);
      if (playerIndex >= 0) return { room, playerIndex };
    }
    return null;
  }

  joinRoom({ roomId, password, playerName, playerId, reconnectToken, socketId }) {
    const room = this.getRoom(roomId);
    if (!room) return { ok: false, error: "房间不存在" };
    if (room.password && room.password !== password) return { ok: false, error: "房间密码错误" };

    if (room.phase === "waiting") {
      room.players = room.players.filter(
        (p) => p.isBot || p.socketId || (playerId && p.playerId === playerId)
      );
    }

    const reconnectPlayer = room.players.find((p) => p.playerId === playerId);
    if (reconnectPlayer) {
      if (reconnectToken && reconnectPlayer.reconnectToken !== reconnectToken) {
        return { ok: false, error: "重连凭证错误" };
      }
      reconnectPlayer.socketId = socketId;
      reconnectPlayer.status = reconnectPlayer.chips > 0 ? "active" : "out";
      reconnectPlayer.disconnectedAt = null;
      if (reconnectPlayer.disconnectTimer) {
        clearTimeout(reconnectPlayer.disconnectTimer);
        reconnectPlayer.disconnectTimer = null;
      }
      this.logger.info("ROOM", "玩家重连", { roomId: room.roomId, playerId });
      this.eventBus.emit("player:reconnected", { roomId: room.roomId, playerId });
      return { ok: true, room, player: reconnectPlayer, reconnected: true };
    }

    if (room.players.length >= 2) return { ok: false, error: "房间已满" };
    const finalPlayerId = playerId || `P${generateCode(8)}`;
    const token = reconnectToken || generateReconnectToken();
    const trimmedName = String(playerName || "").trim();
    const defaultName = room.players.length === 0 ? "player1" : "player2";
    const player = makePlayer({
      playerId: finalPlayerId,
      name: trimmedName || defaultName,
      socketId,
      reconnectToken: token,
    });
    room.players.push(player);
    if (!room.ownerPlayerId) room.ownerPlayerId = player.playerId;
    this.logger.info("ROOM", "玩家加入", { roomId: room.roomId, playerId: player.playerId });
    this.eventBus.emit("player:joined", { roomId: room.roomId, playerId: player.playerId });
    return { ok: true, room, player, reconnected: false };
  }

  addBotPlayer(room, botName = "深渊AI") {
    if (!room || room.players.length >= 2) {
      return { ok: false, error: "房间已满或不存在" };
    }
    const bot = makePlayer({
      playerId: `BOT_${generateCode(6)}`,
      reconnectToken: `BOT_TOKEN_${generateCode(8)}`,
      socketId: null,
      name: botName,
    });
    bot.isBot = true;
    room.players.push(bot);
    this.logger.info("ROOM", "机器人加入", { roomId: room.roomId, playerId: bot.playerId });
    this.eventBus.emit("player:bot_joined", { roomId: room.roomId, playerId: bot.playerId });
    return { ok: true, bot };
  }

  markDisconnected(socketId, onTimeoutLose) {
    const found = this.getRoomBySocket(socketId);
    if (!found) return null;
    const { room, playerIndex } = found;
    const player = room.players[playerIndex];
    player.socketId = null;
    player.disconnectedAt = Date.now();
    player.status = player.chips > 0 ? "disconnected" : "out";
    this.logger.warn("ROOM", "玩家断线", { roomId: room.roomId, playerId: player.playerId });
    this.eventBus.emit("player:disconnected", { roomId: room.roomId, playerId: player.playerId });

    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
    player.disconnectTimer = setTimeout(() => {
      if (player.socketId) return;
      onTimeoutLose?.(room, player);
      player.disconnectTimer = null;
    }, this.reconnectTtlMs);
    if (typeof player.disconnectTimer.unref === "function") {
      player.disconnectTimer.unref();
    }

    return { room, player };
  }

  getPublicPlayers(room) {
    return room.players.map(toPublicPlayer);
  }

  removePlayerBySocket(socketId, { onForfeit } = {}) {
    const found = this.getRoomBySocket(socketId);
    if (!found) return { ok: false, error: "not_in_room" };

    const { room, playerIndex } = found;
    const player = room.players[playerIndex];

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    const activePhases = new Set(["pre_flop", "flop", "turn", "river", "showdown"]);
    if (activePhases.has(room.phase) && player.chips > 0 && !player.isBot) {
      onForfeit?.(room, player);
      return { ok: true, room, player, forfeited: true };
    }

    room.players.splice(playerIndex, 1);
    const destroyed = room.players.length === 0 || room.players.every((p) => p.isBot);
    if (destroyed) this.rooms.delete(room.roomId);

    this.logger.info("ROOM", "玩家离开房间", { roomId: room.roomId, playerId: player.playerId });
    this.eventBus.emit("player:left", { roomId: room.roomId, playerId: player.playerId });
    return { ok: true, room, player, destroyed };
  }
}

module.exports = { RoomManager, RECONNECT_TTL_MS };
