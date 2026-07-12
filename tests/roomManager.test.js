const { EventEmitter } = require("events");
const { RoomManager } = require("../game/roomManager");
const { GAME_MODE } = require("../game/gameModes");

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
    expect(room.gameMode).toBe(GAME_MODE.STANDARD);
  });

  test("房间模式在创建时规范化并保持不可变", () => {
    const rm = new RoomManager({ logger, eventBus: new EventEmitter() });
    const room = rm.createRoom(null, " OVERDRIVE ");
    expect(room.gameMode).toBe(GAME_MODE.OVERDRIVE);
    room.gameMode = GAME_MODE.STANDARD;
    expect(room.gameMode).toBe(GAME_MODE.OVERDRIVE);
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

    const missing = rm.joinRoom({
      roomId: room.roomId,
      playerName: "A",
      socketId: "s3",
      playerId: "P1",
    });
    expect(missing.ok).toBe(false);

    const good = rm.joinRoom({
      roomId: room.roomId,
      playerName: "A",
      socketId: "s4",
      playerId: "P1",
      reconnectToken: joined.player.reconnectToken,
    });
    expect(good.ok).toBe(true);
    expect(good.reconnected).toBe(true);
  });

  test("密码房可仅凭正确重连 token 恢复，不在浏览器保存房间密码", () => {
    const rm = new RoomManager({ logger, eventBus: new EventEmitter() });
    const room = rm.createRoom("secret");
    const joined = rm.joinRoom({
      roomId: room.roomId,
      password: "secret",
      playerName: "A",
      socketId: "s1",
      playerId: "P1",
    });
    joined.player.socketId = null;

    const restored = rm.joinRoom({
      roomId: room.roomId,
      playerName: "A",
      socketId: "s2",
      playerId: "P1",
      reconnectToken: joined.player.reconnectToken,
    });
    expect(restored.ok).toBe(true);
    expect(restored.reconnected).toBe(true);
  });

  test("公开玩家状态完整且不泄露手牌和重连凭证", () => {
    const rm = new RoomManager({ logger, eventBus: new EventEmitter() });
    const room = rm.createRoom(null);
    const joined = rm.joinRoom({
      roomId: room.roomId,
      playerName: "A",
      socketId: "s1",
      playerId: "P1",
    });
    joined.player.cards = [{ code: "SA", suit: "S", rank: "A" }];
    joined.player.streetBet = 25;
    joined.player.isAllIn = true;

    const [publicPlayer] = rm.getPublicPlayers(room);
    expect(publicPlayer).toEqual(
      expect.objectContaining({
        playerId: "P1",
        streetBet: 25,
        isConnected: true,
        isBot: false,
        isReady: true,
        isAllIn: true,
      })
    );
    expect(publicPlayer).not.toHaveProperty("cards");
    expect(publicPlayer).not.toHaveProperty("reconnectToken");
    expect(publicPlayer).not.toHaveProperty("socketId");
  });

  test("离房后解除 socket 关联并把房主转给剩余玩家", () => {
    const rm = new RoomManager({ logger, eventBus: new EventEmitter() });
    const room = rm.createRoom(null);
    rm.joinRoom({ roomId: room.roomId, playerName: "A", socketId: "s1", playerId: "P1" });
    rm.joinRoom({ roomId: room.roomId, playerName: "B", socketId: "s2", playerId: "P2" });
    room.phase = "pre_flop";
    const onForfeit = jest.fn((_room, loser) => {
      loser.status = "out";
      _room.phase = "game_over";
    });

    const left = rm.removePlayerBySocket("s1", { onForfeit });
    expect(left.ok).toBe(true);
    expect(left.forfeited).toBe(true);
    expect(onForfeit).toHaveBeenCalled();
    expect(rm.getRoomBySocket("s1")).toBeNull();
    expect(room.ownerPlayerId).toBe("P2");
    expect(room.players.map((p) => p.playerId)).toEqual(["P1", "P2"]);
    expect(room.players[0]).toEqual(expect.objectContaining({ socketId: null, isReady: false }));
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
