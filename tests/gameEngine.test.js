const { EventEmitter } = require("events");
const { GameEngine } = require("../game/gameEngine");

function card(code) {
  const suit = code[0];
  const rank = code.slice(1);
  const map = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
  return { code, suit, rank, value: map[rank] || Number(rank) };
}

function createHarness() {
  const emitted = [];
  const io = {
    to() {
      return {
        emit(event, payload) {
          emitted.push({ event, payload });
        },
      };
    },
  };
  const roomManager = {
    getPublicPlayers(room) {
      return room.players.map((p) => ({
        playerId: p.playerId,
        name: p.name,
        chips: p.chips,
        status: p.status,
        streetBet: p.streetBet,
        totalBet: p.totalBet,
        isConnected: Boolean(p.socketId),
      }));
    },
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const engine = new GameEngine({
    io,
    roomManager,
    logger,
    eventBus: new EventEmitter(),
  });
  return { engine, emitted };
}

function makeRoom() {
  return {
    roomId: "ROOM1",
    ownerPlayerId: "P1",
    players: [
      {
        playerId: "P1",
        reconnectToken: "T1",
        socketId: "S1",
        name: "A",
        chips: 1000,
        cards: [],
        status: "active",
        totalBet: 0,
        streetBet: 0,
        hasActed: false,
        isAllIn: false,
      },
      {
        playerId: "P2",
        reconnectToken: "T2",
        socketId: "S2",
        name: "B",
        chips: 1000,
        cards: [],
        status: "active",
        totalBet: 0,
        streetBet: 0,
        hasActed: false,
        isAllIn: false,
      },
    ],
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
}

describe("gameEngine", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test("startHand 会发牌并进入 pre_flop", () => {
    const { engine, emitted } = createHarness();
    const room = makeRoom();
    engine.startHand(room);
    expect(room.phase).toBe("pre_flop");
    expect(room.players[0].cards.length).toBe(2);
    expect(emitted.some((e) => e.event === "your_cards")).toBe(true);
  });

  test("handlePlayerAction 支持 raise 和 call", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    engine.startHand(room);
    const first = room.currentPlayerIndex;
    const r = engine.handlePlayerAction(room, first, "raise", 100);
    expect(r.ok).toBe(true);
    const second = room.currentPlayerIndex;
    const c = engine.handlePlayerAction(room, second, "call");
    expect(c.ok).toBe(true);
  });

  test("fold 可直接结算该手", () => {
    const { engine, emitted } = createHarness();
    const room = makeRoom();
    engine.startHand(room);
    const first = room.currentPlayerIndex;
    const res = engine.handlePlayerAction(room, first, "fold");
    expect(res.ok).toBe(true);
    expect(room.phase).toBe("end");
    const handResult = emitted.find((e) => e.event === "hand_result");
    expect(handResult).toBeTruthy();
    expect(handResult.payload.reason).toBe("fold");
    expect(handResult.payload.settleMs).toBe(3000);
  });

  test("allin 后可以推进到摊牌", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    engine.startHand(room);
    const first = room.currentPlayerIndex;
    engine.handlePlayerAction(room, first, "allin");
    const second = room.currentPlayerIndex;
    engine.handlePlayerAction(room, second, "call");
    expect(["showdown", "end", "waiting", "game_over"]).toContain(room.phase);
  });

  test("平局时奇数筹码给房主", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    room.phase = "river";
    room.pot = 101;
    room.communityCards = ["S2", "D3", "C4", "H5", "S9"].map(card);
    room.players[0].cards = ["HA", "DA"].map(card);
    room.players[1].cards = ["CA", "SA"].map(card);
    const beforeOwner = room.players[0].chips;
    engine.settleShowdown(room);
    expect(room.pot).toBe(0);
    expect(room.players[0].chips + room.players[1].chips).toBe(2000 + 101);
    expect(room.players[0].chips).toBeGreaterThan(beforeOwner + 50);
  });

  test("断线超时触发整场判负", () => {
    const { engine, emitted } = createHarness();
    const room = makeRoom();
    engine.resolveDisconnectTimeout(room, room.players[0]);
    const over = emitted.find((e) => e.event === "game_over");
    expect(over).toBeTruthy();
    expect(over.payload.reason).toBe("disconnect_timeout_forfeit");
  });

  test("玩家破产会触发 game_over", () => {
    const { engine, emitted } = createHarness();
    const room = makeRoom();
    room.players[0].chips = 0;
    room.players[1].chips = 1200;
    room.phase = "end";
    engine.finalizeHand(room);
    expect(room.phase).toBe("end");
    jest.advanceTimersByTime(3000);
    const over = emitted.find((e) => e.event === "game_over");
    expect(over).toBeTruthy();
    expect(over.payload.reason).toBe("bankrupt");
    expect(room.phase).toBe("game_over");
    expect(room.players[0].status).toBe("out");
    expect(over.payload.winnerName).toBeTruthy();
  });

  test("机器人在可过牌时倾向 check/raise", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    room.players[0].isBot = true;
    const picked = engine.chooseBotAction(room, 0, {
      toCall: 0,
      validActions: ["check", "raise", "fold", "allin"],
      minRaise: 100,
      maxBet: 200,
    });
    expect(["check", "raise"]).toContain(picked.action);
  });

  test("机器人高压力可能 fold", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    room.players[0].isBot = true;
    room.players[0].chips = 50;
    const picked = engine.chooseBotAction(room, 0, {
      toCall: 60,
      validActions: ["fold", "call", "allin"],
      minRaise: 0,
      maxBet: 60,
    });
    expect(["fold", "allin", "call"]).toContain(picked.action);
  });

  test("机器人行动调度会触发 handlePlayerAction", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    room.phase = "pre_flop";
    room.currentPlayerIndex = 0;
    room.players[0].isBot = true;
    const spy = jest.spyOn(engine, "handlePlayerAction").mockImplementation(() => ({ ok: true }));
    engine.scheduleBotAction(room, 0, {
      toCall: 0,
      validActions: ["check", "fold"],
      minRaise: 0,
      maxBet: 0,
    });
    jest.advanceTimersByTime(900);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
