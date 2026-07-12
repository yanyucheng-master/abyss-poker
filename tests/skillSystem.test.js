const { createAppServer } = require("../server/server");
const { SKILL_MODE } = require("../game/skillModes");
const { GAME_MODE } = require("../game/gameModes");
const { validateLoadout, setPlayerLoadout, beginHandSkills } = require("../game/skills/skillEngine");
const { SkillEngine } = require("../game/skills/skillEngine");
const { pickBestFive } = require("../game/handEvaluator");
const { createDeck } = require("../utils/deck");
const { SKILL_CONFIG } = require("../game/skillConfig");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const logger = require("../utils/logger");
const eventBus = require("../utils/eventBus");

function makeIoStub() {
  const emits = [];
  return {
    emits,
    to: () => ({
      emit: (event, payload) => emits.push({ event, payload }),
    }),
  };
}

describe("skill loadout validation", () => {
  test("accepts legal combinations and rejects illegal ones", () => {
    expect(validateLoadout(["MEMORY_REWRITE", "NEURAL_INTERRUPT", "ADVERSITY_CIRCUIT"]).ok).toBe(true);
    expect(validateLoadout(["QUANTUM_HOLE_CARDS", "OVERLOAD_CORE", "ABYSS_BREATH"]).ok).toBe(true);
    expect(validateLoadout(["QUANTUM_HOLE_CARDS"]).ok).toBe(false);
    expect(validateLoadout(["ECHO_SCAN", "ECHO_SCAN", "ABYSS_BREATH", "EMBER_RECYCLE"]).ok).toBe(false);
    expect(
      validateLoadout([
        "QUANTUM_HOLE_CARDS",
        "FORK_OBSERVATION",
        "NULLIFICATION_PROTOCOL",
      ]).ok
    ).toBe(false);
    expect(validateLoadout(["NOT_A_SKILL", "ABYSS_BREATH"]).ok).toBe(false);
  });
});

describe("handEvaluator nullification", () => {
  test("excludes nullified community cards from best five", () => {
    const deck = createDeck();
    const byCode = Object.fromEntries(deck.map((c) => [c.code, c]));
    const hole = [byCode.SA, byCode.SK];
    const board = [byCode.SQ, byCode.SJ, byCode.ST, byCode.H2, byCode.H3];
    const normal = pickBestFive([...hole, ...board]);
    expect(normal.handName).toMatch(/同花顺|皇家同花顺/);
    const nullified = pickBestFive([...hole, ...board], { excludedCodes: ["ST"] });
    expect(nullified.handName).not.toMatch(/同花顺|皇家同花顺/);
  });
});

describe("skill energy and room flow", () => {
  test("standard rooms without skills still start normally", () => {
    const io = makeIoStub();
    const roomManager = new RoomManager({ logger, eventBus });
    const engine = new GameEngine({ io, roomManager, logger, eventBus });
    const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.OFF);
    roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "A",
      playerId: "PA",
      socketId: "s1",
    });
    roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "B",
      playerId: "PB",
      socketId: "s2",
    });
    engine.tryStartGame(room);
    expect(room.phase).toBe("pre_flop");
    expect(room.skillMode).toBe(SKILL_MODE.OFF);
    expect(room.players[0].skillRuntime).toBeNull();
  });

  test("abyss rooms wait for loadouts then start", () => {
    const io = makeIoStub();
    const roomManager = new RoomManager({ logger, eventBus });
    const engine = new GameEngine({ io, roomManager, logger, eventBus });
    const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.ABYSS);
    const a = roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "A",
      playerId: "PA",
      socketId: "s1",
    });
    const b = roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "B",
      playerId: "PB",
      socketId: "s2",
    });
    engine.tryStartGame(room);
    expect(room.phase).toBe("drafting");

    expect(
      engine.handleSkillLoadout(room, a.player, [
        "ECHO_SCAN",
        "PROBABILITY_CLOAK",
        "SILENCE_ZONE",
        "EMBER_RECYCLE",
      ]).ok
    ).toBe(true);
    expect(room.phase).toBe("drafting");
    expect(
      engine.handleSkillLoadout(room, b.player, [
        "MEMORY_REWRITE",
        "NEURAL_INTERRUPT",
        "ADVERSITY_CIRCUIT",
      ]).ok
    ).toBe(true);
    expect(room.phase).toBe("pre_flop");
    expect(a.player.skillRuntime.abyssEnergy).toBe(SKILL_CONFIG.INITIAL_ABYSS_ENERGY);
  });

  test("all-in blocks active skills and silence blocks later actives", () => {
    const io = makeIoStub();
    const roomManager = new RoomManager({ logger, eventBus });
    const engine = new GameEngine({ io, roomManager, logger, eventBus });
    const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.ABYSS);
    const a = roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "A",
      playerId: "PA",
      socketId: "s1",
    }).player;
    const b = roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "B",
      playerId: "PB",
      socketId: "s2",
    }).player;
    engine.handleSkillLoadout(room, a, ["SILENCE_ZONE", "ECHO_SCAN", "EMBER_RECYCLE", "ABYSS_BREATH"]);
    engine.handleSkillLoadout(room, b, ["ADVERSITY_CIRCUIT", "PROBABILITY_CLOAK", "OVERLOAD_CORE"]);
    expect(room.phase).toBe("pre_flop");

    // Advance to flop so ECHO_SCAN is legal
    room.phase = "flop";
    room.communityCards = createDeck().slice(0, 3);
    room.currentPlayerIndex = room.players.findIndex((p) => p.playerId === a.playerId);
    a.skillRuntime.abyssEnergy = 10;
    b.skillRuntime.abyssEnergy = 10;

    const silence = engine.handleSkillUse(room, a, {
      skillId: "SILENCE_ZONE",
      requestId: "r1",
    });
    expect(silence.ok).toBe(true);
    expect(room.skillState.silenceActive).toBe(true);

    room.currentPlayerIndex = room.players.findIndex((p) => p.playerId === b.playerId);
    const blocked = engine.handleSkillUse(room, b, {
      skillId: "PROBABILITY_CLOAK",
      requestId: "r2",
    });
    expect(blocked.ok).toBe(false);

    a.isAllIn = true;
    room.skillState.silenceActive = false;
    room.currentPlayerIndex = room.players.findIndex((p) => p.playerId === a.playerId);
    const allInBlocked = engine.handleSkillUse(room, a, {
      skillId: "ECHO_SCAN",
      requestId: "r3",
    });
    expect(allInBlocked.ok).toBe(false);
  });

  test("neural interrupt cancels a pending skill and refunds half energy", () => {
    jest.useFakeTimers();
    const io = makeIoStub();
    const roomManager = new RoomManager({ logger, eventBus });
    const engine = new GameEngine({ io, roomManager, logger, eventBus });
    const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.ABYSS);
    const a = roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "A",
      playerId: "PA",
      socketId: "s1",
    }).player;
    const b = roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "B",
      playerId: "PB",
      socketId: "s2",
    }).player;
    engine.handleSkillLoadout(room, a, ["ECHO_SCAN", "ABYSS_BREATH", "EMBER_RECYCLE", "OVERLOAD_CORE"]);
    engine.handleSkillLoadout(room, b, ["NEURAL_INTERRUPT", "ADVERSITY_CIRCUIT", "PROBABILITY_CLOAK"]);
    room.phase = "flop";
    room.communityCards = createDeck().slice(0, 3);
    room.currentPlayerIndex = 0;
    a.skillRuntime.abyssEnergy = 10;
    b.skillRuntime.abyssEnergy = 10;
    const before = a.skillRuntime.abyssEnergy;

    const use = engine.handleSkillUse(room, a, { skillId: "ECHO_SCAN", requestId: "scan-1" });
    expect(use.ok).toBe(true);
    expect(room.skillState.reactionWindow).toBeTruthy();

    const counter = engine.handleSkillCounter(room, b, {
      requestId: "scan-1",
      skillId: "NEURAL_INTERRUPT",
    });
    expect(counter.ok).toBe(true);
    // paid 2, refund floor(2*0.5)=1, ember recycle +1 bonus
    expect(a.skillRuntime.abyssEnergy).toBeGreaterThanOrEqual(before - 2 + 1);
    expect(room.skillState.pendingSkill).toBeNull();
    jest.useRealTimers();
  });

  test("nullify protocol excludes card from showdown evaluation", () => {
    const io = makeIoStub();
    const roomManager = new RoomManager({ logger, eventBus });
    const engine = new GameEngine({ io, roomManager, logger, eventBus });
    const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.ABYSS);
    const a = roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "A",
      playerId: "PA",
      socketId: "s1",
    }).player;
    const b = roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "B",
      playerId: "PB",
      socketId: "s2",
    }).player;
    engine.handleSkillLoadout(room, a, [
      "NULLIFICATION_PROTOCOL",
      "ABYSS_BREATH",
      "EMBER_RECYCLE",
      "OVERLOAD_CORE",
    ]);
    engine.handleSkillLoadout(room, b, ["ADVERSITY_CIRCUIT", "PROBABILITY_CLOAK", "ECHO_SCAN"]);

    const deck = createDeck();
    const byCode = Object.fromEntries(deck.map((c) => [c.code, c]));
    a.cards = [byCode.SA, byCode.SK];
    b.cards = [byCode.H2, byCode.H3];
    room.communityCards = [byCode.SQ, byCode.SJ, byCode.ST, byCode.C2, byCode.C4];
    room.phase = "turn";
    room.currentPlayerIndex = 0;
    a.skillRuntime.abyssEnergy = 10;
    a.skillRuntime.firstStreetActionTaken = false;

    const result = engine.handleSkillUse(room, a, {
      skillId: "NULLIFICATION_PROTOCOL",
      requestId: "null-1",
      target: { cardCode: "ST" },
    });
    expect(result.ok).toBe(true);
    expect(room.skillState.nullifiedCommunityCardIds).toContain("ST");
    const hand = engine.evaluatePlayerHand(a, room);
    expect(hand.handName).not.toMatch(/同花顺|皇家同花顺/);
  });

  test("memory rewrite removes old card and draws without duplicates", () => {
    const io = makeIoStub();
    const roomManager = new RoomManager({ logger, eventBus });
    const engine = new GameEngine({ io, roomManager, logger, eventBus });
    const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.ABYSS);
    const a = roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "A",
      playerId: "PA",
      socketId: "s1",
    }).player;
    const b = roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "B",
      playerId: "PB",
      socketId: "s2",
    }).player;
    engine.handleSkillLoadout(room, a, ["MEMORY_REWRITE", "ABYSS_BREATH", "EMBER_RECYCLE"]);
    engine.handleSkillLoadout(room, b, ["ADVERSITY_CIRCUIT", "PROBABILITY_CLOAK", "ECHO_SCAN"]);
    expect(room.phase).toBe("pre_flop");
    room.currentPlayerIndex = 0;
    a.skillRuntime.abyssEnergy = 10;
    a.skillRuntime.firstStreetActionTaken = false;
    const oldCode = a.cards[0].code;
    const top = room.deck[room.deck.length - 1].code;
    const result = engine.handleSkillUse(room, a, {
      skillId: "MEMORY_REWRITE",
      requestId: "mem-1",
      target: { cardIndex: 0 },
    });
    expect(result.ok).toBe(true);
    expect(a.cards[0].code).toBe(top);
    expect(room.skillState.removedCards.some((c) => c.code === oldCode)).toBe(true);
    const codes = [...a.cards, ...b.cards, ...room.communityCards, ...room.deck].map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
