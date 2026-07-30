const { io: Client } = require("socket.io-client");
const { createAppServer } = require("../server/server");
const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const { CROSS_WAIT_MS } = require("../game/matchmakingQueue");

function waitFor(socket, event, predicate = () => true, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timeout waiting ${event}`));
    }, timeout);
    function onEvent(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    }
    socket.on(event, onEvent);
  });
}

describe("matchmaking socket integration", () => {
  let httpServer;
  let baseUrl;
  let matchmaking;
  const clients = [];

  beforeAll(async () => {
    const appServer = createAppServer({
      reconnectTtlMs: 600,
      matchmakingAutoStart: false,
    });
    httpServer = appServer.httpServer;
    matchmaking = appServer.matchmaking;
    await new Promise((resolve) => httpServer.listen(0, resolve));
    baseUrl = `http://localhost:${httpServer.address().port}`;
  });

  afterEach(() => {
    while (clients.length) {
      const c = clients.pop();
      try {
        c.close();
      } catch (_error) {
        // ignore
      }
    }
  });

  afterAll(async () => {
    matchmaking?.queue.stop();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  test("同赛道两人匹配后自动建房并进桌", async () => {
    const c1 = new Client(baseUrl, { transports: ["websocket"] });
    const c2 = new Client(baseUrl, { transports: ["websocket"] });
    clients.push(c1, c2);
    await Promise.all([waitFor(c1, "connect"), waitFor(c2, "connect")]);

    const queued1 = waitFor(c1, "match:queued");
    const queued2 = waitFor(c2, "match:queued");
    c1.emit("match:queue", {
      playerName: "A",
      playerId: "MATCH_A",
      gameMode: GAME_MODE.STANDARD,
      skillMode: SKILL_MODE.OFF,
      hasSkillLoadout: false,
    });
    c2.emit("match:queue", {
      playerName: "B",
      playerId: "MATCH_B",
      gameMode: GAME_MODE.STANDARD,
      skillMode: SKILL_MODE.OFF,
      hasSkillLoadout: false,
    });
    await Promise.all([queued1, queued2]);

    const joined1 = waitFor(c1, "room_joined");
    const joined2 = waitFor(c2, "room_joined");
    matchmaking.queue.scan();
    const j1 = await joined1;
    await joined2;
    expect(j1.matchSource).toBe("quick");
    expect(j1.players.length).toBe(2);
  });

  test("匹配房禁止陌生人 join_room", async () => {
    const c1 = new Client(baseUrl, { transports: ["websocket"] });
    const c2 = new Client(baseUrl, { transports: ["websocket"] });
    const stranger = new Client(baseUrl, { transports: ["websocket"] });
    clients.push(c1, c2, stranger);
    await Promise.all([
      waitFor(c1, "connect"),
      waitFor(c2, "connect"),
      waitFor(stranger, "connect"),
    ]);

    const queued1 = waitFor(c1, "match:queued");
    const queued2 = waitFor(c2, "match:queued");
    c1.emit("match:queue", {
      playerName: "A",
      playerId: "BLOCK_A",
      gameMode: GAME_MODE.STANDARD,
      skillMode: SKILL_MODE.OFF,
    });
    c2.emit("match:queue", {
      playerName: "B",
      playerId: "BLOCK_B",
      gameMode: GAME_MODE.STANDARD,
      skillMode: SKILL_MODE.OFF,
    });
    await Promise.all([queued1, queued2]);
    const joinedPromise = waitFor(c1, "room_joined");
    matchmaking.queue.scan();
    const joined = await joinedPromise;
    stranger.emit("join_room", {
      roomId: joined.roomId,
      playerName: "X",
      playerId: "BLOCK_X",
    });
    await expect(waitFor(stranger, "join_error")).resolves.toEqual(
      expect.objectContaining({ message: "匹配房间不可直接加入" })
    );
  });

  test("跨赛道邀请只邀 B", async () => {
    const cA = new Client(baseUrl, { transports: ["websocket"] });
    const cB = new Client(baseUrl, { transports: ["websocket"] });
    clients.push(cA, cB);
    await Promise.all([waitFor(cA, "connect"), waitFor(cB, "connect")]);

    const queuedA = waitFor(cA, "match:queued");
    const queuedB = waitFor(cB, "match:queued");
    cA.emit("match:queue", {
      playerName: "A",
      playerId: "CROSS_A",
      gameMode: GAME_MODE.STANDARD,
      skillMode: SKILL_MODE.OFF,
      hasSkillLoadout: false,
    });
    cB.emit("match:queue", {
      playerName: "B",
      playerId: "CROSS_B",
      gameMode: GAME_MODE.OVERDRIVE,
      skillMode: SKILL_MODE.ABYSS,
      hasSkillLoadout: true,
    });
    await Promise.all([queuedA, queuedB]);
    await new Promise((resolve) => setTimeout(resolve, CROSS_WAIT_MS + 50));
    const invitePromise = waitFor(cB, "match:invite");
    matchmaking.queue.scan();
    const invite = await invitePromise;
    expect(invite.targetSkillMode).toBe(SKILL_MODE.OFF);
  }, 15000);
});
