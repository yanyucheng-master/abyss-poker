const { EventEmitter } = require("events");
const { GameEngine } = require("../game/gameEngine");
const { GAME_MODE } = require("../game/gameModes");
const { verifyDeckCommitment } = require("../game/deckCommitment");
const { getValidActions } = require("../game/pokerLogic");
const { createDeck } = require("../utils/deck");

function card(code) {
  const suit = code[0];
  const rank = code.slice(1);
  const map = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
  return { code, suit, rank, value: map[rank] || Number(rank) };
}

function createHarness(engineOptions = {}) {
  const emitted = [];
  let trackedRoom = null;
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
    getRoom() {
      return trackedRoom;
    },
    destroyRoom: jest.fn(() => {
      trackedRoom = null;
    }),
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
    ...engineOptions,
  });
  return {
    engine,
    emitted,
    roomManager,
    trackRoom(room) {
      trackedRoom = room;
      return room;
    },
  };
}

function makeRoom() {
  return {
    roomId: "ROOM1",
    gameMode: GAME_MODE.STANDARD,
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
        isReady: true,
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
        isReady: true,
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
    expect(emitted.some((e) => e.event === "hand_commitment")).toBe(true);
    expect(room.deckCommitment).toMatch(/^[a-f\d]{64}$/);
  });

  test("标准局不调用高爆生成器，高爆局才调用", () => {
    const overdriveGenerator = jest.fn(() => ({
      deck: createDeck(),
      profile: "strong_confrontation",
      metrics: { fallback: false },
    }));
    const { engine } = createHarness({ overdriveGenerator });
    const standard = makeRoom();
    engine.startHand(standard);
    expect(overdriveGenerator).not.toHaveBeenCalled();

    const overdrive = makeRoom();
    overdrive.gameMode = GAME_MODE.OVERDRIVE;
    engine.startHand(overdrive);
    expect(overdriveGenerator).toHaveBeenCalledTimes(1);
    expect(overdrive.privateOverdriveProfile).toBe("strong_confrontation");
  });

  test.each([GAME_MODE.STANDARD, GAME_MODE.OVERDRIVE])(
    "%s 模式均支持 Fold / Check / Call / Raise / All In",
    (gameMode) => {
      const engineOptions = {
        deckFactory: () => createDeck(),
        overdriveGenerator: () => ({
          deck: createDeck(),
          profile: null,
          metrics: { fallback: false },
        }),
      };
      const { engine } = createHarness(engineOptions);
      const room = makeRoom();
      room.gameMode = gameMode;
      engine.startHand(room);

      const firstTurn = getValidActions(room, room.currentPlayerIndex);
      expect(firstTurn.validActions).toEqual(
        expect.arrayContaining(["fold", "call", "raise", "allin"])
      );
      expect(
        engine.handlePlayerAction(room, room.currentPlayerIndex, "raise", firstTurn.minRaiseTo).ok
      ).toBe(true);
      expect(engine.handlePlayerAction(room, room.currentPlayerIndex, "call").ok).toBe(true);
      expect(room.phase).toBe("flop");
      expect(room.communityCards).toHaveLength(3);
      expect(engine.handlePlayerAction(room, room.currentPlayerIndex, "check").ok).toBe(true);
      expect(engine.handlePlayerAction(room, room.currentPlayerIndex, "check").ok).toBe(true);
      expect(engine.handlePlayerAction(room, room.currentPlayerIndex, "fold").ok).toBe(true);
      expect(room.players.every((player) => player.streetBet === 0)).toBe(true);

      const allInRoom = makeRoom();
      allInRoom.gameMode = gameMode;
      engine.startHand(allInRoom);
      expect(engine.handlePlayerAction(allInRoom, allInRoom.currentPlayerIndex, "allin").ok).toBe(
        true
      );
      expect(engine.handlePlayerAction(allInRoom, allInRoom.currentPlayerIndex, "call").ok).toBe(
        true
      );
      expect(allInRoom.communityCards).toHaveLength(5);
      expect(allInRoom.players.every((player) => player.streetBet === 0)).toBe(true);
    }
  );

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

  test("heads-up 翻牌后由非庄家先行动", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    engine.startHand(room);
    const dealer = room.dealerIndex;
    expect(engine.handlePlayerAction(room, dealer, "call").ok).toBe(true);
    expect(engine.handlePlayerAction(room, room.currentPlayerIndex, "check").ok).toBe(true);
    expect(room.phase).toBe("flop");
    expect(room.currentPlayerIndex).toBe(dealer === 0 ? 1 : 0);
  });

  test("跨街有效下注上限使用 streetBet 单位", () => {
    const room = makeRoom();
    room.currentBet = 0;
    room.players.forEach((player) => {
      player.totalBet = 50;
      player.streetBet = 0;
      player.chips = 950;
    });
    expect(getValidActions(room, 0).maxTotalBet).toBe(950);
  });

  test("仅一方 all-in 且对手跟注后自动发完公共牌", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    room.players[0].chips = 500;
    room.players[1].chips = 1500;
    engine.startHand(room);
    expect(engine.handlePlayerAction(room, 0, "allin").ok).toBe(true);
    expect(engine.handlePlayerAction(room, 1, "call").ok).toBe(true);
    expect(room.communityCards).toHaveLength(5);
    expect(room.phase).toBe("end");
    expect(room.players.reduce((sum, player) => sum + player.chips, 0)).toBe(2000);
  });

  test("当前玩家断线后行动倒计时到期会自动弃牌", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    engine.startHand(room);
    room.players[room.currentPlayerIndex].status = "disconnected";
    jest.advanceTimersByTime(30000);
    expect(room.phase).toBe("end");
  });

  test("handlePlayerAction 会拒绝非法阶段、非当前玩家和错误加注", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    expect(engine.handlePlayerAction(room, 0, "check").ok).toBe(false);

    engine.startHand(room);
    const current = room.currentPlayerIndex;
    const other = current === 0 ? 1 : 0;
    expect(engine.handlePlayerAction(room, other, "check").ok).toBe(false);
    expect(engine.handlePlayerAction(room, current, "raise", "bad").ok).toBe(false);
    expect(engine.handlePlayerAction(room, current, "raise", 1).ok).toBe(false);
  });

  test("handlePlayerAction 会拒绝无筹码全押和未知动作", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    engine.startHand(room);
    const current = room.currentPlayerIndex;
    room.players[current].chips = 0;
    expect(engine.handlePlayerAction(room, current, "allin").ok).toBe(false);
    room.players[current].chips = 1000;
    expect(engine.handlePlayerAction(room, current, "unknown").ok).toBe(false);
  });

  test("fold 可直接结算该手", () => {
    const { engine, emitted } = createHarness();
    const room = makeRoom();
    engine.startHand(room);
    const first = room.currentPlayerIndex;
    const res = engine.handlePlayerAction(room, first, "fold");
    expect(res.ok).toBe(true);
    expect(room.phase).toBe("end");
    const handResults = emitted.filter((e) => e.event === "hand_result");
    expect(handResults).toHaveLength(2);
    handResults.forEach(({ payload }) => {
      expect(payload.reason).toBe("fold");
      expect(payload.settleMs).toBe(5000);
      expect(payload.players.map((p) => p.cards.length).sort()).toEqual([0, 2]);
    });

    const reveal = emitted.find((e) => e.event === "hand_reveal")?.payload;
    expect(reveal.deck).toHaveLength(52);
    expect(verifyDeckCommitment(reveal)).toBe(true);
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
    room.communityCards = ["S2", "D7", "C9", "HJ", "SQ"].map(card);
    room.players[0].cards = ["HA", "DA"].map(card);
    room.players[1].cards = ["CA", "SA"].map(card);
    const beforeOwner = room.players[0].chips;
    engine.settleShowdown(room);
    expect(room.pot).toBe(0);
    expect(room.players[0].chips + room.players[1].chips).toBe(2000 + 101);
    expect(room.players[0].chips).toBeGreaterThan(beforeOwner + 50);
  });

  test("公共牌全部翻开时牌型展示延长到 6 秒", () => {
    const { engine, emitted } = createHarness();
    const room = makeRoom();
    room.phase = "river";
    room.pot = 100;
    room.communityCards = ["S2", "D7", "C9", "HJ", "SQ"].map(card);
    room.players[0].cards = ["HA", "DA"].map(card);
    room.players[1].cards = ["C3", "D4"].map(card);
    engine.settleShowdown(room);
    const handResult = emitted.find((e) => e.event === "hand_result");
    expect(handResult.payload.settleMs).toBe(6000);
  });

  test("摊牌前会返还双人局未被对手覆盖的下注", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    room.phase = "river";
    room.pot = 70;
    room.communityCards = ["S2", "D3", "C4", "H5", "S9"].map(card);
    room.players[0].chips = 0;
    room.players[0].totalBet = 20;
    room.players[0].streetBet = 20;
    room.players[0].isAllIn = true;
    room.players[0].cards = ["HA", "DA"].map(card);
    room.players[1].chips = 950;
    room.players[1].totalBet = 50;
    room.players[1].streetBet = 50;
    room.players[1].cards = ["C3", "D4"].map(card);

    engine.settleShowdown(room);

    expect(room.players[0].chips).toBe(40);
    expect(room.players[1].chips).toBe(980);
    expect(room.pot).toBe(0);
  });

  test("断线超时触发整场判负", () => {
    const { engine, emitted, trackRoom } = createHarness();
    const room = trackRoom(makeRoom());
    engine.resolveDisconnectTimeout(room, room.players[0]);
    const over = emitted.find((e) => e.event === "game_over");
    expect(over).toBeTruthy();
    expect(over.payload.reason).toBe("disconnect_timeout_forfeit");
    expect(over.payload.rematch.timeoutMs).toBe(10000);
  });

  test("玩家破产会触发 game_over", () => {
    const { engine, emitted, trackRoom } = createHarness();
    const room = trackRoom(makeRoom());
    room.players[0].chips = 0;
    room.players[1].chips = 1200;
    room.phase = "end";
    engine.finalizeHand(room);
    expect(room.phase).toBe("end");
    jest.advanceTimersByTime(5000);
    const over = emitted.find((e) => e.event === "game_over");
    expect(over).toBeTruthy();
    expect(over.payload.reason).toBe("bankrupt");
    expect(room.phase).toBe("game_over");
    expect(room.players[0].status).toBe("out");
    expect(over.payload.winnerName).toBeTruthy();
  });

  test("双方同意再来一局会重置筹码并重新开局", () => {
    const { engine, emitted, trackRoom } = createHarness();
    const room = trackRoom(makeRoom());
    room.phase = "game_over";
    room.players[0].chips = 0;
    room.players[0].status = "out";
    room.players[1].chips = 2000;
    engine.beginRematchVote(room, { reason: "bankrupt", players: [] });

    expect(engine.handleRematchResponse(room, room.players[0], true).ok).toBe(true);
    expect(room.phase).toBe("game_over");
    expect(engine.handleRematchResponse(room, room.players[1], true).ok).toBe(true);

    expect(room.phase).toBe("pre_flop");
    expect(room.handNo).toBe(1);
    expect(room.players.every((p) => p.chips < 1000)).toBe(true);
    expect(room.players.every((p) => p.status === "active")).toBe(true);
    expect(emitted.some((e) => e.event === "rematch_started")).toBe(true);
    expect(emitted.some((e) => e.event === "your_cards")).toBe(true);
  });

  test("真人对手离线时单方不能启动幽灵重赛", () => {
    const { engine, trackRoom } = createHarness();
    const room = trackRoom(makeRoom());
    room.phase = "game_over";
    room.players[1].socketId = null;
    room.players[1].status = "disconnected";
    engine.beginRematchVote(room, { reason: "bankrupt", players: [] });

    expect(engine.handleRematchResponse(room, room.players[0], true).ok).toBe(true);
    expect(room.phase).toBe("game_over");
  });

  test("任一玩家拒绝再来一局会关闭房间", () => {
    const { engine, emitted, roomManager, trackRoom } = createHarness();
    const room = trackRoom(makeRoom());
    room.phase = "game_over";
    engine.beginRematchVote(room, { reason: "bankrupt", players: [] });

    expect(engine.handleRematchResponse(room, room.players[0], false).ok).toBe(true);
    const closed = emitted.find((e) => e.event === "room_closed");
    expect(closed.payload.reason).toBe("rematch_declined");
    expect(roomManager.destroyRoom).toHaveBeenCalledWith(room.roomId);
  });

  test("再来一局确认超时会关闭房间", () => {
    const { engine, emitted, roomManager, trackRoom } = createHarness();
    const room = trackRoom(makeRoom());
    room.phase = "game_over";
    engine.beginRematchVote(room, { reason: "bankrupt", players: [] });

    jest.advanceTimersByTime(10000);

    const closed = emitted.find((e) => e.event === "room_closed");
    expect(closed.payload.reason).toBe("rematch_timeout");
    expect(roomManager.destroyRoom).toHaveBeenCalledWith(room.roomId);
  });

  test("非 game_over 阶段不能响应再来一局", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    const result = engine.handleRematchResponse(room, room.players[0], true);
    expect(result.ok).toBe(false);
  });

  test("等待阶段异常玩家组合不会开局", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    room.players.push({ ...room.players[0], playerId: "P3", socketId: "S3" });
    engine.tryStartGame(room);
    expect(room.phase).toBe("waiting");

    const botOnlyRoom = makeRoom();
    botOnlyRoom.players.forEach((p) => {
      p.isBot = true;
      p.socketId = null;
    });
    engine.tryStartGame(botOnlyRoom);
    expect(botOnlyRoom.phase).toBe("waiting");
  });

  test("机器人在可过牌时倾向 check/raise", () => {
    const { engine } = createHarness();
    const room = makeRoom();
    room.players[0].isBot = true;
    room.currentBet = 0;
    room.players.forEach((player) => {
      player.streetBet = 0;
    });
    const random = jest.spyOn(Math, "random").mockReturnValue(0.1);
    const picked = engine.chooseBotAction(room, 0, getValidActions(room, 0));
    expect(picked.action).toBe("raise");
    expect(Number.isFinite(picked.amount)).toBe(true);
    random.mockRestore();
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
