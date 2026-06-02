const { EventEmitter } = require("events");
const { RoomManager } = require("../game/roomManager");

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

describe("roomManager", () => {
  test("创建房间并加入", () => {
    const rm = new RoomManager({ logger, eventBus: new EventEmitter() });
    const room = rm.createRoom(null);
    const joined = rm.joinRoom({
      roomId: room.roomId,
      playerName: "A",
      socketId: "s1",
    });
    expect(joined.ok).toBe(true);
    expect(joined.player.reconnectToken).toBeTruthy();
  });

  test("重连需要正确 token", () => {
    const rm = new RoomManager({ logger, eventBus: new EventEmitter() });
    const room = rm.createRoom(null);
    const joined = rm.joinRoom({
      roomId: room.roomId,
      playerName: "A",
      socketId: "s1",
      playerId: "P1",
    });
    joined.player.socketId = null;
    const bad = rm.joinRoom({
      roomId: room.roomId,
      playerName: "A",
      socketId: "s2",
      playerId: "P1",
      reconnectToken: "wrong",
    });
    expect(bad.ok).toBe(false);
  });

  test("断线超时触发回调", async () => {
    const rm = new RoomManager({
      logger,
      eventBus: new EventEmitter(),
      reconnectTtlMs: 60,
    });
    const room = rm.createRoom(null);
    rm.joinRoom({ roomId: room.roomId, playerName: "A", socketId: "s1", playerId: "P1" });
    let called = false;
    rm.markDisconnected("s1", () => {
      called = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(called).toBe(true);
  });

  test("可添加机器人玩家，且房满时失败", () => {
    const rm = new RoomManager({ logger, eventBus: new EventEmitter() });
    const room = rm.createRoom(null);
    rm.joinRoom({ roomId: room.roomId, playerName: "A", socketId: "s1", playerId: "P1" });
    const botOk = rm.addBotPlayer(room, "AI");
    expect(botOk.ok).toBe(true);
    expect(room.players[1].isBot).toBe(true);

    const botFail = rm.addBotPlayer(room, "AI2");
    expect(botFail.ok).toBe(false);
  });
});
