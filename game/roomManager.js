const crypto = require("crypto");
const { GAME_MODE, normalizeGameMode } = require("./gameModes");
const { SKILL_MODE, normalizeSkillMode, isSkillEnabled } = require("./skillModes");
const {
  getPublicSkillSummary,
  initPlayerForSkillMode,
} = require("./skills/skillEngine");
const { createRoomSkillState, clearSkillTimers } = require("./skills/skillState");

const RECONNECT_TTL_MS = 5 * 60 * 1000;

function generateCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[crypto.randomInt(chars.length)];
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
    statusBeforeDisconnect: null,
    isBot: false,
    isReady: true,
    skills: [],
    buffs: [],
    relics: [],
    statusEffects: [],
  };
}

function toPublicPlayer(player) {
  const publicPlayer = {
    playerId: player.playerId,
    name: player.name,
    chips: player.chips,
    status: player.status,
    streetBet: player.streetBet,
    totalBet: player.totalBet,
    isConnected: Boolean(player.socketId),
    isBot: Boolean(player.isBot),
    isReady: Boolean(player.isReady),
    isAllIn: Boolean(player.isAllIn),
  };
  if (player.skillRuntime) {
    publicPlayer.skills = getPublicSkillSummary(player);
  }
  return publicPlayer;
}

class RoomManager {
  constructor({ logger, eventBus, reconnectTtlMs = RECONNECT_TTL_MS }) {
    this.rooms = new Map();
    this.logger = logger;
    this.eventBus = eventBus;
    this.reconnectTtlMs = reconnectTtlMs;
  }

  createRoom(password, gameMode = GAME_MODE.STANDARD, skillMode = SKILL_MODE.OFF) {
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
      turnSeq: 0,
      turnId: null,
      smallBlind: 25,
      bigBlind: 50,
      handNo: 0,
      history: [],
      lastActionAt: Date.now(),
      rematch: null,
      skillState: null,
      deferredHandReveals: [],
      revealedHandHistory: [],
      hadAllInActionThisHand: false,
    };
    const fixedGameMode = normalizeGameMode(gameMode);
    const fixedSkillMode = normalizeSkillMode(skillMode);
    Object.defineProperty(room, "gameMode", {
      get: () => fixedGameMode,
      set: () => {},
      enumerable: true,
      configurable: false,
    });
    Object.defineProperty(room, "skillMode", {
      get: () => fixedSkillMode,
      set: () => {},
      enumerable: true,
      configurable: false,
    });
    if (isSkillEnabled(fixedSkillMode)) {
      room.skillState = createRoomSkillState();
    }
    this.rooms.set(roomId, room);
    this.logger.info("ROOM", "房间创建", { roomId, gameMode: fixedGameMode, skillMode: fixedSkillMode });
    this.eventBus.emit("room:created", { roomId });
    return room;
  }

  setRoomPassword(room, player, password) {
    if (!room || !player) return { ok: false, error: "房间不存在" };
    if (room.handNo > 0 || !["waiting", "drafting"].includes(room.phase)) {
      return { ok: false, error: "对局开始后不能修改密码" };
    }
    const host = room.players[0];
    if (!host || host.playerId !== player.playerId) {
      return { ok: false, error: "仅房主可设置房间密码" };
    }
    const next = typeof password === "string" ? password.trim() : "";
    if (next.length > 16) return { ok: false, error: "房间密码长度不能超过 16" };
    room.password = next || null;
    return { ok: true, hasPassword: Boolean(room.password) };
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
    const reconnectCandidate = room.players.find((p) => p.playerId === playerId);
    const hasReconnectCredential =
      reconnectCandidate && reconnectToken && reconnectCandidate.reconnectToken === reconnectToken;
    if (room.password && room.password !== password && !hasReconnectCredential) {
      return { ok: false, error: "房间密码错误" };
    }

    if (["waiting", "drafting"].includes(room.phase) && room.handNo === 0) {
      const retainedPlayers = [];
      room.players.forEach((candidate) => {
        const shouldRetain =
          candidate.isBot || candidate.socketId || (playerId && candidate.playerId === playerId);
        if (shouldRetain) retainedPlayers.push(candidate);
        else this.clearPlayerDisconnectTimer(candidate);
      });
      room.players = retainedPlayers;
      this.updateOwner(room);
    }

    const reconnectPlayer = reconnectCandidate;
    if (reconnectPlayer) {
      if (!reconnectToken || reconnectPlayer.reconnectToken !== reconnectToken) {
        return { ok: false, error: "重连凭证错误" };
      }
      reconnectPlayer.socketId = socketId;
      reconnectPlayer.roomId = room.roomId;
      const previousStatus = reconnectPlayer.statusBeforeDisconnect;
      const terminalStatus = ["folded", "out"].includes(reconnectPlayer.status)
        ? reconnectPlayer.status
        : ["folded", "out"].includes(previousStatus)
          ? previousStatus
          : null;
      if (terminalStatus) {
        reconnectPlayer.status = terminalStatus;
      } else {
        reconnectPlayer.status = reconnectPlayer.isAllIn || reconnectPlayer.chips > 0 ? "active" : "out";
      }
      reconnectPlayer.statusBeforeDisconnect = null;
      reconnectPlayer.isReady = true;
      reconnectPlayer.disconnectedAt = null;
      this.clearPlayerDisconnectTimer(reconnectPlayer);
      this.logger.info("ROOM", "玩家重连", { roomId: room.roomId, playerId });
      this.eventBus.emit("player:reconnected", { roomId: room.roomId, playerId });
      return { ok: true, room, player: reconnectPlayer, reconnected: true };
    }

    if (room.players.length >= 2) return { ok: false, error: "房间已满" };
    const finalPlayerId = playerId || `P${generateCode(8)}`;
    const token = generateReconnectToken();
    const trimmedName = String(playerName || "").trim();
    const defaultName = room.players.length === 0 ? "player1" : "player2";
    const player = makePlayer({
      playerId: finalPlayerId,
      name: trimmedName || defaultName,
      socketId,
      reconnectToken: token,
    });
    player.roomId = room.roomId;
    initPlayerForSkillMode(player, room.skillMode);
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
    bot.isReady = true;
    initPlayerForSkillMode(bot, room.skillMode);
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
    if (player.status !== "disconnected") player.statusBeforeDisconnect = player.status;
    player.socketId = null;
    player.disconnectedAt = Date.now();
    // Folded/out seats must not be resurrected by a later reconnect.
    if (!["folded", "out"].includes(player.status)) player.status = "disconnected";
    player.isReady = false;
    this.logger.warn("ROOM", "玩家断线", { roomId: room.roomId, playerId: player.playerId });
    this.eventBus.emit("player:disconnected", { roomId: room.roomId, playerId: player.playerId });

    this.clearPlayerDisconnectTimer(player);
    const timer = setTimeout(() => {
      if (player.disconnectTimer !== timer) return;
      if (player.socketId) return;
      if (this.getRoom(room.roomId) !== room || !room.players.includes(player)) {
        player.disconnectTimer = null;
        return;
      }
      player.disconnectTimer = null;
      onTimeoutLose?.(room, player);
    }, this.reconnectTtlMs);
    player.disconnectTimer = timer;
    if (typeof player.disconnectTimer.unref === "function") {
      player.disconnectTimer.unref();
    }

    return { room, player };
  }

  getPublicPlayers(room) {
    return room.players.map(toPublicPlayer);
  }

  clearPlayerDisconnectTimer(player) {
    if (!player?.disconnectTimer) return;
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }

  updateOwner(room, excludedPlayerId = null) {
    if (!room) return null;
    if (
      room.players.some(
        (p) => p.playerId === room.ownerPlayerId && p.playerId !== excludedPlayerId
      )
    ) {
      return room.ownerPlayerId;
    }
    const eligible = room.players.filter((p) => p.playerId !== excludedPlayerId);
    const nextOwner = eligible.find((p) => !p.isBot) || eligible[0] || null;
    room.ownerPlayerId = nextOwner?.playerId || null;
    return room.ownerPlayerId;
  }

  destroyRoom(roomId) {
    const room = this.getRoom(roomId);
    if (!room) return null;
    if (room.rematch?.timer) {
      clearTimeout(room.rematch.timer);
      room.rematch.timer = null;
    }
    for (const timerKey of ["actionTimer", "botActionTimer", "nextHandTimer"]) {
      if (room[timerKey]) {
        clearTimeout(room[timerKey]);
        room[timerKey] = null;
      }
    }
    if (room.skillState) {
      clearSkillTimers(room);
      room.skillState.pendingSkill = null;
      room.skillState.reactionWindow = null;
      room.skillState.skillChoice = null;
      room.skillState.preDealWindow = null;
    }
    room.players.forEach((player) => {
      this.clearPlayerDisconnectTimer(player);
    });
    this.rooms.delete(room.roomId);
    this.logger.info("ROOM", "房间关闭", { roomId: room.roomId });
    this.eventBus.emit("room:destroyed", { roomId: room.roomId });
    return room;
  }

  removePlayerBySocket(socketId, { onForfeit } = {}) {
    const found = this.getRoomBySocket(socketId);
    if (!found) return { ok: false, error: "not_in_room" };

    const { room, playerIndex } = found;
    const player = room.players[playerIndex];

    this.clearPlayerDisconnectTimer(player);

    const activePhases = new Set([
      "pre_flop",
      "flop",
      "turn",
      "river",
      "before_turn",
      "before_river",
      "showdown",
      "end",
    ]);
    const matchInProgress = activePhases.has(room.phase) || (room.phase === "waiting" && room.handNo > 0);
    if (matchInProgress && !player.isBot) {
      player.statusBeforeDisconnect = player.status;
      player.socketId = null;
      player.isReady = false;
      onForfeit?.(room, player);
      this.updateOwner(room, player.playerId);
      this.logger.info("ROOM", "玩家离开房间", { roomId: room.roomId, playerId: player.playerId });
      this.eventBus.emit("player:left", { roomId: room.roomId, playerId: player.playerId });
      return { ok: true, room, player, destroyed: false, forfeited: true };
    }

    room.players.splice(playerIndex, 1);
    this.updateOwner(room);
    const destroyed = room.players.length === 0 || room.players.every((p) => p.isBot);
    if (destroyed) this.destroyRoom(room.roomId);

    this.logger.info("ROOM", "玩家离开房间", { roomId: room.roomId, playerId: player.playerId });
    this.eventBus.emit("player:left", { roomId: room.roomId, playerId: player.playerId });
    return { ok: true, room, player, destroyed };
  }
}

module.exports = { RoomManager, RECONNECT_TTL_MS };
