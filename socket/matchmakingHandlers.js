const { MatchmakingQueue, SESSION_MS, INVITE_MS } = require("../game/matchmakingQueue");
const { listSkillDefinitions } = require("../game/skills/definitions");

function createMatchmakingService({ io, roomManager, gameEngine, logger, autoStart = true }) {
  const queue = new MatchmakingQueue();
  const acceptedInvites = new Set();

  function emitMatchError(entry, message) {
    if (!entry?.socketId) return;
    const socket = io.sockets.sockets.get(entry.socketId);
    if (socket) socket.emit("match:error", { message });
  }

  function rollbackMatch(entryA, entryB, matchKey) {
    if (matchKey) acceptedInvites.delete(matchKey);
    queue.reinsertEntry(entryA);
    queue.reinsertEntry(entryB);
  }

  queue.onMatch = (entryA, entryB, lane) => {
    const matchKey = [entryA.playerId, entryB.playerId].sort().join("\x1f");
    if (acceptedInvites.has(matchKey)) {
      rollbackMatch(entryA, entryB, null);
      emitMatchError(entryA, "匹配冲突，已重新排队");
      emitMatchError(entryB, "匹配冲突，已重新排队");
      return;
    }
    acceptedInvites.add(matchKey);
    const acceptedInviteCleanup = setTimeout(() => acceptedInvites.delete(matchKey), 30_000);
    if (typeof acceptedInviteCleanup.unref === "function") acceptedInviteCleanup.unref();

    const sockets = [];
    for (const entry of [entryA, entryB]) {
      const socket = io.sockets.sockets.get(entry.socketId);
      if (socket) sockets.push({ socket, entry });
    }
    if (sockets.length !== 2) {
      logger.warn("MATCH", "配对后玩家 socket 不可用", { matchKey });
      rollbackMatch(entryA, entryB, matchKey);
      emitMatchError(entryA, "对手已离线，已重新进入匹配");
      emitMatchError(entryB, "对手已离线，已重新进入匹配");
      return;
    }

    for (const { socket } of sockets) {
      while (roomManager.getRoomBySocket(socket.id)) {
        const found = roomManager.getRoomBySocket(socket.id);
        if (!found) break;
        const player = found.room.players[found.playerIndex];
        if (found.room.phase === "game_over" && found.room.rematch?.active) {
          gameEngine.handleRematchResponse(found.room, player, false);
          socket.leave(found.room.roomId);
          continue;
        }
        const result = roomManager.removePlayerBySocket(socket.id, {
          onForfeit: (room, loser) => gameEngine.resolveDisconnectTimeout(room, loser),
        });
        if (!result.ok) break;
        socket.leave(result.room.roomId);
        if (!result.destroyed && roomManager.getRoom(result.room.roomId)) {
          gameEngine.broadcastRoomState(result.room);
          io.to(result.room.roomId).emit("player_left", {
            roomId: result.room.roomId,
            playerId: result.player.playerId,
            players: roomManager.getPublicPlayers(result.room),
          });
        }
      }
    }

    const room = roomManager.createRoom(null, lane.gameMode, lane.skillMode, {
      matchSource: "quick",
    });
    const joined = [];
    for (const { socket, entry } of sockets) {
      const result = roomManager.joinRoom({
        roomId: room.roomId,
        password: null,
        playerName: entry.playerName,
        playerId: entry.playerId,
        reconnectToken: entry.reconnectToken || undefined,
        socketId: socket.id,
      });
      if (!result.ok) {
        logger.error("MATCH", "匹配建房加入失败", {
          roomId: room.roomId,
          playerId: entry.playerId,
          error: result.error,
        });
        roomManager.destroyRoom(room.roomId);
        for (const item of joined) {
          item.socket.leave(room.roomId);
        }
        rollbackMatch(entryA, entryB, matchKey);
        emitMatchError(entryA, "匹配建房失败，已重新进入匹配");
        emitMatchError(entryB, "匹配建房失败，已重新进入匹配");
        return;
      }
      joined.push({ socket, entry, player: result.player });
      socket.join(room.roomId);
    }

    for (const { socket, entry, player } of joined) {
      socket.emit("match:found", {
        roomId: room.roomId,
        gameMode: room.gameMode,
        skillMode: room.skillMode,
      });
      socket.emit("room_joined", {
        roomId: room.roomId,
        gameMode: room.gameMode,
        skillMode: room.skillMode,
        phase: room.phase,
        handNo: room.handNo,
        hasPassword: false,
        matchSource: room.matchSource,
        playerId: player.playerId,
        reconnectToken: player.reconnectToken,
        players: roomManager.getPublicPlayers(room),
        skillCatalog: room.skillMode === "abyss" ? listSkillDefinitions() : [],
      });
    }

    io.to(room.roomId).emit("player_joined", {
      roomId: room.roomId,
      playerId: joined[1].player.playerId,
      players: roomManager.getPublicPlayers(room),
    });
    gameEngine.broadcastRoomState(room);
    gameEngine.tryStartGame(room);
    logger.info("MATCH", "快速匹配成局", {
      roomId: room.roomId,
      gameMode: room.gameMode,
      skillMode: room.skillMode,
      players: joined.map((item) => item.entry.playerId),
    });
  };

  queue.onInvite = ({ inviteId, invitee, partner, targetGameMode, targetSkillMode, expiresAt }) => {
    const socket = io.sockets.sockets.get(invitee.socketId);
    if (!socket) return false;
    socket.emit("match:invite", {
      inviteId,
      targetGameMode,
      targetSkillMode,
      opponentName: partner.playerName,
      expiresAt,
      timeoutMs: INVITE_MS,
    });
    return true;
  };

  queue.onInviteExpired = (invite, reason) => {
    const invitee = queue.getEntry(invite.inviteeEntryId);
    if (invitee?.socketId) {
      io.to(invitee.socketId).emit("match:invite:expired", {
        inviteId: invite.inviteId,
        reason,
      });
    }
  };

  queue.onSessionTimeout = (entry) => {
    if (!entry?.socketId) return;
    io.to(entry.socketId).emit("match:timeout", {
      sessionMs: SESSION_MS,
    });
    io.to(entry.socketId).emit("match:prompt_continue", {
      message: "本轮匹配已结束，是否继续匹配？",
    });
  };

  queue.onRemoved = (entry, reason) => {
    // cancel / requeue：由显式 handler 发 cancelled，避免双发
    if (reason === "requeue" || reason === "cancel" || reason === "user") return;
    if (!entry?.socketId) return;
    io.to(entry.socketId).emit("match:cancelled", { reason });
  };

  if (autoStart) queue.start();

  function cancelForSocket(socketId, reason = "cancel") {
    return queue.cancelBySocketId(socketId, { reason });
  }

  function cancelForPlayer(playerId, reason = "cancel") {
    return queue.cancelByPlayerId(playerId, { reason });
  }

  function isQueued(playerId) {
    return queue.isQueued(playerId);
  }

  function handleDisconnect(socketId) {
    queue.cancelBySocketId(socketId, { reason: "disconnect" });
  }

  return {
    queue,
    cancelForSocket,
    cancelForPlayer,
    isQueued,
    handleDisconnect,
  };
}

module.exports = { createMatchmakingService };
