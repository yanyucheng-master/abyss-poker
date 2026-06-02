const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { registerSocketHandlers } = require("../socket/socketHandlers");
const logger = require("../utils/logger");
const eventBus = require("../utils/eventBus");

function createAppServer(options = {}) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  app.use(express.static("public"));

  const roomManager = new RoomManager({
    logger,
    eventBus,
    reconnectTtlMs: options.reconnectTtlMs,
  });
  const gameEngine = new GameEngine({ io, roomManager, logger, eventBus });

  registerSocketHandlers({ io, roomManager, gameEngine, logger });

  eventBus.on("game:action", (payload) => logger.info("EVENT", "动作事件", payload));
  eventBus.on("game:showdown", (payload) => logger.info("EVENT", "摊牌事件", payload));

  return { app, httpServer, io };
}

function startServer(port = process.env.PORT || 3002, options = {}) {
  const { httpServer } = createAppServer(options);
  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      logger.info("BOOT", "Abyss Poker 启动成功", { port });
      resolve({ httpServer, port });
    });
  });
}

module.exports = { createAppServer, startServer };

if (require.main === module) {
  startServer();
}
