"use strict";

const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { createDeck } = require("../utils/deck");
const { setPlayerLoadout } = require("../game/skills/skillEngine");
const { getValidActions } = require("../game/pokerLogic");
const { MATCH_TOTAL_CHIPS, chipTotal } = require("../game/chipEconomy");
const logger = require("../utils/logger");
const eventBus = require("../utils/eventBus");

const MATCHES = Math.max(1, Number(process.env.ECON_MATCHES || 10000));
const SEED = Number(process.env.ECON_SEED || 220826);

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function makeIoStub() {
  return {
    to: () => ({ emit() {} }),
  };
}

function stopTimers(engine, room) {
  engine.clearActionTimer(room);
  if (room.nextHandTimer) {
    clearTimeout(room.nextHandTimer);
    room.nextHandTimer = null;
  }
}

function playMatch(random) {
  const io = makeIoStub();
  const roomManager = new RoomManager({ logger, eventBus });
  const engine = new GameEngine({ io, roomManager, logger, eventBus, deckFactory: createDeck });
  const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.ABYSS);
  const a = roomManager.joinRoom({ roomId: room.roomId, playerName: "A", playerId: "PA", socketId: "s1" }).player;
  const b = roomManager.joinRoom({ roomId: room.roomId, playerName: "B", playerId: "PB", socketId: "s2" }).player;
  setPlayerLoadout(a, ["RECYCLE", "DEEP_BREATH"]);
  setPlayerLoadout(b, ["DEFENSE", "RECYCLE"]);
  let conservationFails = 0;
  let integerFails = 0;
  let negativeFails = 0;
  let hands = 0;
  while (hands < 40 && a.chips > 0 && b.chips > 0) {
    if (!engine.startHand(room)) break;
    stopTimers(engine, room);
    hands += 1;
    if (chipTotal(room) !== MATCH_TOTAL_CHIPS) conservationFails += 1;
    let steps = 0;
    while (["pre_flop", "flop", "turn", "river"].includes(room.phase) && steps < 24) {
      steps += 1;
      const idx = room.currentPlayerIndex;
      const turn = getValidActions(room, idx);
      const actions = turn.validActions || [];
      if (!actions.length) break;
      const roll = random();
      let action = actions.includes("fold") ? "fold" : actions[0];
      if (actions.includes("check") && roll < 0.45) action = "check";
      else if (actions.includes("call") && roll < 0.7) action = "call";
      else if (actions.includes("raise") && roll < 0.88) action = "raise";
      else if (actions.includes("allin") && roll < 0.94) action = "allin";
      engine.handlePlayerAction(room, idx, action, action === "raise" ? turn.minRaiseTo : undefined);
      stopTimers(engine, room);
      if (chipTotal(room) !== MATCH_TOTAL_CHIPS) conservationFails += 1;
      if (!Number.isSafeInteger(a.chips) || !Number.isSafeInteger(b.chips) || !Number.isSafeInteger(room.pot)) {
        integerFails += 1;
      }
      if (a.chips < 0 || b.chips < 0 || room.pot < 0) negativeFails += 1;
    }
    if (["pre_flop", "flop", "turn", "river"].includes(room.phase)) {
      const idx = room.currentPlayerIndex;
      const leftover = getValidActions(room, idx).validActions || [];
      if (leftover.includes("fold")) engine.handlePlayerAction(room, idx, "fold");
      else if (leftover.includes("check")) engine.handlePlayerAction(room, idx, "check");
      else if (leftover.includes("call")) engine.handlePlayerAction(room, idx, "call");
      stopTimers(engine, room);
    }
    if (room.pot === 0 && a.chips + b.chips !== MATCH_TOTAL_CHIPS) conservationFails += 1;
  }
  stopTimers(engine, room);
  return { conservationFails, integerFails, negativeFails, hands };
}

function main() {
  const random = mulberry32(SEED);
  const started = Date.now();
  let conservationFails = 0;
  let integerFails = 0;
  let negativeFails = 0;
  let hands = 0;
  for (let i = 0; i < MATCHES; i += 1) {
    const result = playMatch(random);
    conservationFails += result.conservationFails;
    integerFails += result.integerFails;
    negativeFails += result.negativeFails;
    hands += result.hands;
  }
  const elapsedMs = Date.now() - started;
  const report = {
    matches: MATCHES,
    hands,
    conservationFails,
    integerFails,
    negativeFails,
    elapsedMs,
    pass: conservationFails === 0 && integerFails === 0 && negativeFails === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exit(1);
}

main();
