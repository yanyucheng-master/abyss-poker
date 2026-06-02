const { io: Client } = require("socket.io-client");
const { createAppServer } = require("../server/server");

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

async function setupRoom(baseUrl) {
  const c1 = new Client(baseUrl, { transports: ["websocket"] });
  const c2 = new Client(baseUrl, { transports: ["websocket"] });
  await Promise.all([waitFor(c1, "connect"), waitFor(c2, "connect")]);

  c1.emit("create_room", {});
  const { roomId } = await waitFor(c1, "room_created");

  const p1Join = waitFor(c1, "room_joined");
  c1.emit("join_room", { roomId, playerName: "A", playerId: "PA" });
  const j1 = await p1Join;

  const p2Join = waitFor(c2, "room_joined");
  const p1Cards = waitFor(c1, "your_cards");
  const p2Cards = waitFor(c2, "your_cards");
  const turnPromise = waitFor(c1, "player_turn");
  c2.emit("join_room", { roomId, playerName: "B", playerId: "PB" });
  const j2 = await p2Join;

  await Promise.all([p1Cards, p2Cards]);
  const turn = await turnPromise;
  return { c1, c2, roomId, j1, j2, turn };
}

describe("socket integration", () => {
  let httpServer;
  let baseUrl;
  const clients = [];

  beforeAll(async () => {
    const appServer = createAppServer({ reconnectTtlMs: 220 });
    httpServer = appServer.httpServer;
    await new Promise((resolve) => httpServer.listen(0, resolve));
    baseUrl = `http://localhost:${httpServer.address().port}`;
  });

  afterEach(() => {
    while (clients.length) {
      const c = clients.pop();
      try {
        c.close();
      } catch (e) {
        // ignore
      }
    }
  });

  afterAll(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
  });

  test("创建房间、加入房间、收到底牌", async () => {
    const { c1, c2, roomId, j1 } = await setupRoom(baseUrl);
    clients.push(c1, c2);
    expect(roomId).toBeTruthy();
    expect(j1.playerId).toBe("PA");
    expect(j1.reconnectToken).toBeTruthy();
  });

  test("支持 raise / call / check / fold 全流程", async () => {
    const { c1, c2, j1, j2, turn } = await setupRoom(baseUrl);
    clients.push(c1, c2);
    const sockets = { [j1.playerId]: c1, [j2.playerId]: c2 };

    const nextTurn1 = waitFor(c1, "player_turn", (p) => p.playerId !== turn.playerId);
    sockets[turn.playerId].emit("player_action", { action: "raise", amount: turn.minRaise });
    await waitFor(c1, "action_made", (p) => p.action === "raise");

    const turn2 = await nextTurn1;
    const nextTurn2 = waitFor(c1, "player_turn");
    sockets[turn2.playerId].emit("player_action", { action: "call" });
    await waitFor(c1, "action_made", (p) => p.action === "call");

    const turn3 = await nextTurn2;
    const nextTurn3 = waitFor(c1, "player_turn");
    sockets[turn3.playerId].emit("player_action", { action: "check" });
    await waitFor(c1, "action_made", (p) => p.action === "check");

    const turn4 = await nextTurn3;
    sockets[turn4.playerId].emit("player_action", { action: "fold" });
    await waitFor(c1, "action_made", (p) => p.action === "win_by_fold");

  });

  test("断线后可凭 token 重连，超时则判负", async () => {
    const { c1, c2, roomId, j1 } = await setupRoom(baseUrl);
    clients.push(c1, c2);

    c1.close();
    await waitFor(c2, "player_disconnected");

    const c3 = new Client(baseUrl, { transports: ["websocket"] });
    clients.push(c3);
    await waitFor(c3, "connect");
    const rejoin = waitFor(c3, "room_joined");
    c3.emit("join_room", {
      roomId,
      playerName: "A",
      playerId: j1.playerId,
      reconnectToken: j1.reconnectToken,
    });
    await rejoin;

    c3.close();
    await waitFor(c2, "player_disconnected");
    const over = await waitFor(c2, "game_over");
    expect(over.reason).toBe("disconnect_timeout_forfeit");

  });

  test("单机模式可创建人机房并正常开局", async () => {
    const c1 = new Client(baseUrl, { transports: ["websocket"] });
    clients.push(c1);
    await waitFor(c1, "connect");
    const joined = waitFor(c1, "room_joined");
    const cards = waitFor(c1, "your_cards");
    const turn = waitFor(c1, "player_turn");
    c1.emit("create_solo_room", { playerName: "Solo", playerId: "PSOLO" });

    const room = await joined;
    const myCards = await cards;
    const firstTurn = await turn;
    expect(room.players.length).toBe(2);
    expect(room.players.some((p) => p.isBot)).toBe(true);
    expect(myCards.cards.length).toBe(2);
    expect(firstTurn.playerId).toBeTruthy();
  });
});
