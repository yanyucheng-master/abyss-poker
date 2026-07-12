const { GAME_MODE, isGameMode, normalizeGameMode } = require("../game/gameModes");
const { SKILL_MODE, isSkillMode, normalizeSkillMode } = require("../game/skillModes");
const { listSkillDefinitions } = require("../game/skills/definitions");

const INPUT_LIMITS = Object.freeze({
  roomId: 8,
  playerName: 16,
  password: 16,
  playerId: 64,
  reconnectToken: 128,
  skillId: 64,
  requestId: 64,
});

const RATE_LIMITS = Object.freeze({
  room: { limit: 12, windowMs: 10_000 },
  action: { limit: 120, windowMs: 10_000 },
  response: { limit: 30, windowMs: 10_000 },
  skill: { limit: 60, windowMs: 10_000 },
});

function readText(value, { label, max, required = false, uppercase = false } = {}) {
  if (value === undefined || value === null) {
    return required ? { ok: false, error: `${label}不能为空` } : { ok: true, value: "" };
  }
  if (typeof value !== "string") return { ok: false, error: `${label}格式错误` };
  const text = value.trim();
  if (required && !text) return { ok: false, error: `${label}不能为空` };
  if (text.length > max) return { ok: false, error: `${label}长度不能超过 ${max}` };
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: `${label}包含非法字符` };
  return { ok: true, value: uppercase ? text.toUpperCase() : text };
}

function readGameMode(value) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: GAME_MODE.STANDARD };
  }
  if (typeof value !== "string") return { ok: false, error: "游戏模式格式错误" };
  const normalized = value.trim().toLowerCase();
  if (!isGameMode(normalized)) return { ok: false, error: "不支持的游戏模式" };
  return { ok: true, value: normalizeGameMode(normalized) };
}

function readSkillMode(value) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: SKILL_MODE.OFF };
  }
  if (typeof value !== "string") return { ok: false, error: "技能模式格式错误" };
  const normalized = value.trim().toLowerCase();
  if (!isSkillMode(normalized)) return { ok: false, error: "不支持的技能模式" };
  return { ok: true, value: normalizeSkillMode(normalized) };
}

function safePayload(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function registerSocketHandlers({ io, roomManager, gameEngine, logger }) {
  io.on("connection", (socket) => {
    function allowRate(bucketName, errorEvent = "action_error") {
      const config = RATE_LIMITS[bucketName];
      const now = Date.now();
      socket.data.abyssRateLimits ||= {};
      let bucket = socket.data.abyssRateLimits[bucketName];
      if (!bucket || now - bucket.startedAt >= config.windowMs) {
        bucket = { startedAt: now, count: 0 };
        socket.data.abyssRateLimits[bucketName] = bucket;
      }
      bucket.count += 1;
      if (bucket.count <= config.limit) return true;
      socket.emit(errorEvent, { message: "请求过于频繁，请稍后再试" });
      return false;
    }

    function emitJoinError(error, extra = {}) {
      socket.emit("join_error", { message: error, ...extra });
    }

    function parseIdentity(payload) {
      const playerName = readText(payload.playerName, {
        label: "昵称",
        max: INPUT_LIMITS.playerName,
      });
      if (!playerName.ok) return playerName;
      const playerId = readText(payload.playerId, {
        label: "玩家标识",
        max: INPUT_LIMITS.playerId,
      });
      if (!playerId.ok) return playerId;
      if (playerId.value && !/^[A-Za-z0-9_-]+$/.test(playerId.value)) {
        return { ok: false, error: "玩家标识格式错误" };
      }
      const reconnectToken = readText(payload.reconnectToken, {
        label: "重连凭证",
        max: INPUT_LIMITS.reconnectToken,
      });
      if (!reconnectToken.ok) return reconnectToken;
      return {
        ok: true,
        playerName: playerName.value,
        playerId: playerId.value || undefined,
        reconnectToken: reconnectToken.value || undefined,
      };
    }

    function removeSocketFromRooms({ exceptRoomId, exceptPlayerId } = {}) {
      const removed = [];
      while (true) {
        const found = roomManager.getRoomBySocket(socket.id);
        if (!found) break;
        const player = found.room.players[found.playerIndex];
        if (
          exceptRoomId &&
          found.room.roomId === exceptRoomId &&
          player?.playerId === exceptPlayerId
        ) {
          break;
        }
        if (found.room.phase === "game_over" && found.room.rematch?.active) {
          gameEngine.handleRematchResponse(found.room, player, false);
          socket.leave(found.room.roomId);
          removed.push({
            ok: true,
            room: found.room,
            player,
            destroyed: true,
            rematchDeclined: true,
          });
          continue;
        }
        const result = roomManager.removePlayerBySocket(socket.id, {
          onForfeit: (room, loser) => gameEngine.resolveDisconnectTimeout(room, loser),
        });
        if (!result.ok) break;
        socket.leave(result.room.roomId);
        removed.push(result);
        if (!result.destroyed && roomManager.getRoom(result.room.roomId)) {
          gameEngine.broadcastRoomState(result.room);
          io.to(result.room.roomId).emit("player_left", {
            playerId: result.player.playerId,
            players: roomManager.getPublicPlayers(result.room),
          });
        }
      }
      return removed;
    }

    function emitRoomJoined(room, player) {
      socket.emit("room_joined", {
        roomId: room.roomId,
        gameMode: room.gameMode,
        skillMode: room.skillMode,
        phase: room.phase,
        hasPassword: Boolean(room.password),
        playerId: player.playerId,
        reconnectToken: player.reconnectToken,
        players: roomManager.getPublicPlayers(room),
        skillCatalog: room.skillMode === "abyss" ? listSkillDefinitions() : [],
      });
    }

    socket.on("create_room", (rawPayload = {}) => {
      if (!allowRate("room", "join_error")) return;
      const payload = safePayload(rawPayload);
      const identity = parseIdentity(payload);
      if (!identity.ok) return emitJoinError(identity.error);
      const password = readText(payload.password, {
        label: "房间密码",
        max: INPUT_LIMITS.password,
      });
      if (!password.ok) return emitJoinError(password.error);
      const gameMode = readGameMode(payload.gameMode);
      if (!gameMode.ok) return emitJoinError(gameMode.error);
      const skillMode = readSkillMode(payload.skillMode);
      if (!skillMode.ok) return emitJoinError(skillMode.error);

      removeSocketFromRooms();
      const room = roomManager.createRoom(password.value || null, gameMode.value, skillMode.value);
      const joined = roomManager.joinRoom({
        roomId: room.roomId,
        password: password.value || null,
        ...identity,
        socketId: socket.id,
      });
      if (!joined.ok) {
        roomManager.destroyRoom(room.roomId);
        return emitJoinError(joined.error);
      }
      socket.join(room.roomId);
      socket.emit("room_created", {
        roomId: room.roomId,
        gameMode: room.gameMode,
        skillMode: room.skillMode,
      });
      emitRoomJoined(room, joined.player);
      gameEngine.broadcastRoomState(room);
    });

    socket.on("create_solo_room", (rawPayload = {}) => {
      if (!allowRate("room", "join_error")) return;
      const payload = safePayload(rawPayload);
      const identity = parseIdentity(payload);
      if (!identity.ok) return emitJoinError(identity.error);
      const gameMode = readGameMode(payload.gameMode);
      if (!gameMode.ok) return emitJoinError(gameMode.error);
      const skillMode = readSkillMode(payload.skillMode);
      if (!skillMode.ok) return emitJoinError(skillMode.error);

      removeSocketFromRooms();
      const room = roomManager.createRoom(null, gameMode.value, skillMode.value);
      const joined = roomManager.joinRoom({
        roomId: room.roomId,
        password: null,
        ...identity,
        socketId: socket.id,
      });
      if (!joined.ok) {
        roomManager.destroyRoom(room.roomId);
        return emitJoinError(joined.error);
      }
      roomManager.addBotPlayer(room, "深渊AI");
      socket.join(room.roomId);
      socket.emit("room_created", {
        roomId: room.roomId,
        gameMode: room.gameMode,
        skillMode: room.skillMode,
      });
      emitRoomJoined(room, joined.player);
      io.to(room.roomId).emit("player_joined", {
        playerId: joined.player.playerId,
        players: roomManager.getPublicPlayers(room),
      });
      gameEngine.broadcastRoomState(room);
      gameEngine.tryStartGame(room);
    });

    socket.on("room:set_password", (rawPayload = {}) => {
      if (!allowRate("room", "action_error")) return;
      const payload = safePayload(rawPayload);
      const found = roomManager.getRoomBySocket(socket.id);
      if (!found) {
        socket.emit("action_error", { message: "当前未加入房间" });
        return;
      }
      const password = readText(payload.password, {
        label: "房间密码",
        max: INPUT_LIMITS.password,
      });
      if (!password.ok) {
        socket.emit("action_error", { message: password.error });
        return;
      }
      const player = found.room.players[found.playerIndex];
      const result = roomManager.setRoomPassword(found.room, player, password.value || "");
      if (!result.ok) {
        socket.emit("action_error", { message: result.error });
        return;
      }
      socket.emit("room:password_updated", { hasPassword: result.hasPassword });
      gameEngine.broadcastRoomState(found.room);
    });

    socket.on("join_room", (rawPayload = {}) => {
      if (!allowRate("room", "join_error")) return;
      const payload = safePayload(rawPayload);
      const roomId = readText(payload.roomId, {
        label: "房间号",
        max: INPUT_LIMITS.roomId,
        required: true,
        uppercase: true,
      });
      if (!roomId.ok) return emitJoinError(roomId.error);
      if (!/^[A-Z0-9]+$/.test(roomId.value)) return emitJoinError("房间号格式错误");
      const password = readText(payload.password, {
        label: "房间密码",
        max: INPUT_LIMITS.password,
      });
      if (!password.ok) return emitJoinError(password.error);
      const identity = parseIdentity(payload);
      if (!identity.ok) return emitJoinError(identity.error);

      const targetRoom = roomManager.getRoom(roomId.value);
      if (!targetRoom) return emitJoinError("房间不存在");
      const reconnectPlayer = targetRoom.players.find((p) => p.playerId === identity.playerId);
      const hasReconnectCredential =
        reconnectPlayer &&
        identity.reconnectToken &&
        reconnectPlayer.reconnectToken === identity.reconnectToken;
      if (
        targetRoom.password &&
        targetRoom.password !== (password.value || null) &&
        !hasReconnectCredential
      ) {
        return emitJoinError("房间密码错误", { code: "PASSWORD_REQUIRED", roomId: roomId.value });
      }
      if (
        reconnectPlayer &&
        (!identity.reconnectToken || reconnectPlayer.reconnectToken !== identity.reconnectToken)
      ) {
        return emitJoinError("重连凭证错误");
      }
      const effectivePlayers =
        targetRoom.phase === "waiting"
          ? targetRoom.players.filter(
              (p) => p.isBot || p.socketId || (identity.playerId && p.playerId === identity.playerId)
            )
          : targetRoom.players;
      if (!reconnectPlayer && effectivePlayers.length >= 2) return emitJoinError("房间已满");

      removeSocketFromRooms({
        exceptRoomId: targetRoom.roomId,
        exceptPlayerId: identity.playerId,
      });
      const previousSocketId = reconnectPlayer?.socketId || null;
      const joined = roomManager.joinRoom({
        roomId: roomId.value,
        password: password.value || null,
        ...identity,
        socketId: socket.id,
      });
      if (!joined.ok) return emitJoinError(joined.error);

      if (previousSocketId && previousSocketId !== socket.id) {
        const previousSocket = io.sockets.sockets.get(previousSocketId);
        previousSocket?.leave(joined.room.roomId);
        previousSocket?.emit("left_room", { ok: true, reason: "session_replaced" });
      }
      socket.join(joined.room.roomId);
      emitRoomJoined(joined.room, joined.player);
      io.to(joined.room.roomId).emit(joined.reconnected ? "player_reconnected" : "player_joined", {
        playerId: joined.player.playerId,
        players: roomManager.getPublicPlayers(joined.room),
      });
      gameEngine.broadcastRoomState(joined.room);
      if (joined.room.phase !== "waiting" && joined.room.phase !== "drafting") {
        if (typeof gameEngine.restorePlayerState === "function") {
          gameEngine.restorePlayerState(joined.room, joined.player);
        } else {
          socket.emit("your_cards", { cards: joined.player.cards });
          gameEngine.emitTurn(joined.room);
        }
      } else {
        gameEngine.tryStartGame(joined.room);
      }
    });

    socket.on("player_action", (rawPayload = {}) => {
      if (!allowRate("action")) return;
      const payload = safePayload(rawPayload);
      const found = roomManager.getRoomBySocket(socket.id);
      if (!found) {
        socket.emit("action_error", { message: "当前未加入房间" });
        return;
      }
      const result = gameEngine.handlePlayerAction(
        found.room,
        found.playerIndex,
        payload.action,
        payload.amount
      );
      if (!result.ok) socket.emit("action_error", { message: result.error });
    });

    socket.on("skill:loadout:set", (rawPayload = {}) => {
      if (!allowRate("skill", "skill:failed")) return;
      const payload = safePayload(rawPayload);
      const found = roomManager.getRoomBySocket(socket.id);
      if (!found) {
        socket.emit("skill:failed", { message: "当前未加入房间" });
        return;
      }
      const player = found.room.players[found.playerIndex];
      const result = gameEngine.handleSkillLoadout(found.room, player, payload.skillIds);
      if (!result.ok) socket.emit("skill:failed", { message: result.error, reason: "loadout" });
    });

    socket.on("skill:use", (rawPayload = {}) => {
      if (!allowRate("skill", "skill:failed")) return;
      const payload = safePayload(rawPayload);
      const found = roomManager.getRoomBySocket(socket.id);
      if (!found) {
        socket.emit("skill:failed", { message: "当前未加入房间" });
        return;
      }
      const player = found.room.players[found.playerIndex];
      const skillId = readText(payload.skillId, {
        label: "技能ID",
        max: INPUT_LIMITS.skillId,
        required: true,
        uppercase: true,
      });
      if (!skillId.ok) {
        socket.emit("skill:failed", { message: skillId.error });
        return;
      }
      const requestId = readText(payload.requestId, {
        label: "请求ID",
        max: INPUT_LIMITS.requestId,
      });
      if (!requestId.ok) {
        socket.emit("skill:failed", { message: requestId.error });
        return;
      }
      const result = gameEngine.handleSkillUse(found.room, player, {
        skillId: skillId.value,
        target: safePayload(payload.target),
        requestId: requestId.value || undefined,
      });
      if (!result.ok) {
        socket.emit("skill:failed", {
          message: result.error,
          skillId: skillId.value,
          requestId: requestId.value || null,
        });
      }
    });

    socket.on("skill:counter", (rawPayload = {}) => {
      if (!allowRate("skill", "skill:failed")) return;
      const payload = safePayload(rawPayload);
      const found = roomManager.getRoomBySocket(socket.id);
      if (!found) {
        socket.emit("skill:failed", { message: "当前未加入房间" });
        return;
      }
      const player = found.room.players[found.playerIndex];
      const result = gameEngine.handleSkillCounter(found.room, player, {
        requestId: payload.requestId,
        skillId: payload.skillId || "NEURAL_INTERRUPT",
      });
      if (!result.ok) socket.emit("skill:failed", { message: result.error, reason: "counter" });
    });

    socket.on("skill:choice", (rawPayload = {}) => {
      if (!allowRate("skill", "skill:failed")) return;
      const payload = safePayload(rawPayload);
      const found = roomManager.getRoomBySocket(socket.id);
      if (!found) {
        socket.emit("skill:failed", { message: "当前未加入房间" });
        return;
      }
      const player = found.room.players[found.playerIndex];
      const result = gameEngine.handleSkillChoice(found.room, player, payload);
      if (!result.ok) socket.emit("skill:failed", { message: result.error, reason: "choice" });
    });

    socket.on("rematch_response", (rawPayload = {}) => {
      if (!allowRate("response")) return;
      const payload = safePayload(rawPayload);
      const found = roomManager.getRoomBySocket(socket.id);
      if (!found) {
        socket.emit("action_error", { message: "当前未加入房间" });
        return;
      }
      const player = found.room.players[found.playerIndex];
      const result = gameEngine.handleRematchResponse(found.room, player, payload.accepted === true);
      if (!result.ok) socket.emit("action_error", { message: result.error });
    });

    socket.on("leave_room", () => {
      if (!allowRate("response")) return;
      const [result] = removeSocketFromRooms();
      socket.emit("left_room", { ok: true });
      if (!result) return;
    });

    socket.on("disconnect", () => {
      const found = roomManager.markDisconnected(socket.id, (room, loser) => {
        gameEngine.resolveDisconnectTimeout(room, loser);
      });
      if (!found) return;
      io.to(found.room.roomId).emit("player_disconnected", {
        playerId: found.player.playerId,
        players: roomManager.getPublicPlayers(found.room),
      });
      gameEngine.broadcastRoomState(found.room);
      logger.warn("SOCKET", "连接断开", { socketId: socket.id });
    });
  });
}

module.exports = { registerSocketHandlers, INPUT_LIMITS, RATE_LIMITS };
