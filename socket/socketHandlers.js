function registerSocketHandlers({ io, roomManager, gameEngine, logger }) {
  io.on("connection", (socket) => {
    socket.on("create_room", ({ password, playerName, playerId, reconnectToken } = {}) => {
      const room = roomManager.createRoom(password || null);
      const joined = roomManager.joinRoom({
        roomId: room.roomId,
        password: password || null,
        playerName,
        playerId,
        reconnectToken,
        socketId: socket.id,
      });
      if (!joined.ok) {
        socket.emit("join_error", { message: joined.error });
        return;
      }
      socket.join(room.roomId);
      socket.emit("room_created", { roomId: room.roomId });
      socket.emit("room_joined", {
        roomId: room.roomId,
        playerId: joined.player.playerId,
        reconnectToken: joined.player.reconnectToken,
        players: roomManager.getPublicPlayers(room),
      });
      gameEngine.broadcastRoomState(room);
    });

    socket.on("create_solo_room", ({ playerName, playerId, reconnectToken } = {}) => {
      const room = roomManager.createRoom(null);
      const joined = roomManager.joinRoom({
        roomId: room.roomId,
        password: null,
        playerName,
        playerId,
        reconnectToken,
        socketId: socket.id,
      });
      if (!joined.ok) {
        socket.emit("join_error", { message: joined.error });
        return;
      }
      roomManager.addBotPlayer(room, "深渊AI");
      socket.join(room.roomId);
      socket.emit("room_joined", {
        roomId: room.roomId,
        playerId: joined.player.playerId,
        reconnectToken: joined.player.reconnectToken,
        players: roomManager.getPublicPlayers(room),
      });
      io.to(room.roomId).emit("player_joined", { playerId: joined.player.playerId });
      gameEngine.broadcastRoomState(room);
      gameEngine.tryStartGame(room);
    });

    socket.on("join_room", ({ roomId, password, playerName, playerId, reconnectToken } = {}) => {
      const joined = roomManager.joinRoom({
        roomId,
        password: password || null,
        playerName,
        playerId,
        reconnectToken,
        socketId: socket.id,
      });
      if (!joined.ok) {
        socket.emit("join_error", { message: joined.error });
        return;
      }

      const { room, player, reconnected } = joined;
      socket.join(room.roomId);

      socket.emit("room_joined", {
        roomId: room.roomId,
        playerId: player.playerId,
        reconnectToken: player.reconnectToken,
        players: roomManager.getPublicPlayers(room),
      });

      io.to(room.roomId).emit(reconnected ? "player_reconnected" : "player_joined", {
        playerId: player.playerId,
        players: roomManager.getPublicPlayers(room),
      });
      gameEngine.broadcastRoomState(room);
      if (room.phase !== "waiting") {
        socket.emit("your_cards", { cards: player.cards });
        gameEngine.emitTurn(room);
      } else {
        gameEngine.tryStartGame(room);
      }
    });

    socket.on("player_action", ({ action, amount } = {}) => {
      const found = roomManager.getRoomBySocket(socket.id);
      if (!found) return;
      const result = gameEngine.handlePlayerAction(found.room, found.playerIndex, action, amount);
      if (!result.ok) socket.emit("action_error", { message: result.error });
    });

    socket.on("rematch_response", ({ accepted } = {}) => {
      const found = roomManager.getRoomBySocket(socket.id);
      if (!found) return;
      const player = found.room.players[found.playerIndex];
      const result = gameEngine.handleRematchResponse(found.room, player, Boolean(accepted));
      if (!result.ok) socket.emit("action_error", { message: result.error });
    });

    socket.on("leave_room", () => {
      const result = roomManager.removePlayerBySocket(socket.id, {
        onForfeit: (room, loser) => gameEngine.resolveDisconnectTimeout(room, loser),
      });
      if (!result.ok) {
        socket.emit("left_room", { ok: true });
        return;
      }
      const { room, destroyed, forfeited } = result;
      socket.leave(room.roomId);
      if (!destroyed && !forfeited) {
        gameEngine.broadcastRoomState(room);
        io.to(room.roomId).emit("player_left", { playerId: result.player.playerId });
      }
      socket.emit("left_room", { ok: true });
    });

    socket.on("disconnect", () => {
      const found = roomManager.markDisconnected(socket.id, (room, loser) => {
        gameEngine.resolveDisconnectTimeout(room, loser);
      });
      if (!found) return;
      io.to(found.room.roomId).emit("player_disconnected", { playerId: found.player.playerId });
      gameEngine.broadcastRoomState(found.room);
      logger.warn("SOCKET", "连接断开", { socketId: socket.id });
    });
  });
}

module.exports = { registerSocketHandlers };
