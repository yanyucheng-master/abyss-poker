#!/usr/bin/env node
/**
 * 深渊技能系统批量模拟
 * 覆盖 STANDARD+ABYSS / OVERDRIVE+ABYSS 的构筑、能量守恒与改牌不破坏牌唯一性。
 */
const { generateOverdriveDeal } = require("../game/overdriveGenerator");
const { validateLoadout, pickDefaultBotLoadout } = require("../game/skills/skillState");
const { listSkillDefinitions } = require("../game/skills/definitions");
const { SKILL_CONFIG } = require("../game/skillConfig");
const { pickBestFive, compareEvaluatedHands } = require("../game/handEvaluator");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const eventBus = require("../utils/eventBus");

// Batch simulation should report aggregate failures, not emit thousands of
// per-room production log lines.
const logger = Object.freeze({ info() {}, warn() {}, error() {} });

const LOADOUTS = [
  ["ECHO_SCAN", "PROBABILITY_CLOAK", "SILENCE_ZONE", "EMBER_RECYCLE"],
  ["QUANTUM_HOLE_CARDS", "OVERLOAD_CORE", "ABYSS_BREATH"],
  ["FORK_OBSERVATION", "NULLIFICATION_PROTOCOL"],
  ["MEMORY_REWRITE", "NEURAL_INTERRUPT", "ADVERSITY_CIRCUIT"],
  ["ECHO_SCAN", "PROBABILITY_CLOAK", "OVERLOAD_CORE", "ADVERSITY_CIRCUIT"],
  pickDefaultBotLoadout(),
];

function parseCount(argv) {
  const gamesFlag = argv.find((arg) => arg.startsWith("--games="));
  const raw = gamesFlag ? gamesFlag.slice("--games=".length) : argv[0];
  const parsed = Number(raw ?? 1000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1000;
}

function makeIoStub() {
  return { to: () => ({ emit() {} }) };
}

function uniqueCardCount(room) {
  const codes = [
    ...room.deck.map((c) => c.code),
    ...room.communityCards.map((c) => c.code),
    ...room.players.flatMap((p) => (p.cards || []).map((c) => c.code)),
    ...(room.skillState?.removedCards || []).map((c) => c.code),
    ...(room.skillState?.burnedCards || []).map((c) => c.code),
  ];
  return { total: codes.length, unique: new Set(codes).size };
}

function runModeSimulation(mode, games) {
  const io = makeIoStub();
  const roomManager = new RoomManager({ logger, eventBus });
  const engine = new GameEngine({ io, roomManager, logger, eventBus });

  const stats = {
    mode,
    games,
    loadoutRejects: 0,
    handsStarted: 0,
    skillUses: 0,
    skillFails: 0,
    counters: 0,
    cardEdits: 0,
    duplicateCardIncidents: 0,
    cardConservationIncidents: 0,
    energyOverflow: 0,
    energyNegative: 0,
    nullifyEvaluations: 0,
    winners: { A: 0, B: 0, tie: 0 },
    equippedRate: {},
    useRate: {},
  };

  listSkillDefinitions().forEach((s) => {
    stats.equippedRate[s.id] = 0;
    stats.useRate[s.id] = 0;
  });

  for (let i = 0; i < games; i += 1) {
    const room = roomManager.createRoom(
      null,
      mode === "overdrive" ? GAME_MODE.OVERDRIVE : GAME_MODE.STANDARD,
      SKILL_MODE.ABYSS
    );
    const a = roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "SimA",
      playerId: `A${i}`,
      socketId: `sa${i}`,
    }).player;
    const b = roomManager.joinRoom({
      roomId: room.roomId,
      playerName: "SimB",
      playerId: `B${i}`,
      socketId: `sb${i}`,
    }).player;

    const loadoutA = LOADOUTS[i % LOADOUTS.length];
    const loadoutB = LOADOUTS[(i + 2) % LOADOUTS.length];
    for (const id of loadoutA) stats.equippedRate[id] += 1;
    for (const id of loadoutB) stats.equippedRate[id] += 1;

    const setA = engine.handleSkillLoadout(room, a, loadoutA);
    const setB = engine.handleSkillLoadout(room, b, loadoutB);
    if (!setA.ok || !setB.ok) {
      stats.loadoutRejects += 1;
      roomManager.destroyRoom(room.roomId);
      continue;
    }
    if (room.phase !== "pre_flop") {
      // force start if still drafting (shouldn't happen)
      engine.tryStartGame(room);
    }
    if (room.phase === "pre_flop") stats.handsStarted += 1;

    // Attempt a few legal skills early
    a.skillRuntime.abyssEnergy = 10;
    b.skillRuntime.abyssEnergy = 10;
    room.currentPlayerIndex = 0;
    a.skillRuntime.firstStreetActionTaken = false;

    if (loadoutA.includes("MEMORY_REWRITE")) {
      const r = engine.handleSkillUse(room, a, {
        skillId: "MEMORY_REWRITE",
        requestId: `mem-${i}`,
        target: { cardIndex: 0 },
      });
      stats.skillUses += 1;
      stats.useRate.MEMORY_REWRITE += 1;
      if (!r.ok) stats.skillFails += 1;
      else stats.cardEdits += 1;
    } else if (loadoutA.includes("OVERLOAD_CORE")) {
      const r = engine.handleSkillUse(room, a, {
        skillId: "OVERLOAD_CORE",
        requestId: `ov-${i}`,
      });
      stats.skillUses += 1;
      stats.useRate.OVERLOAD_CORE += 1;
      if (!r.ok) stats.skillFails += 1;
    }

    // Opponent may counter if pending
    if (room.skillState?.reactionWindow?.status === "WAITING" && loadoutB.includes("NEURAL_INTERRUPT")) {
      const c = engine.handleSkillCounter(room, b, {
        requestId: room.skillState.reactionWindow.requestId,
        skillId: "NEURAL_INTERRUPT",
      });
      if (c.ok) {
        stats.counters += 1;
        stats.useRate.NEURAL_INTERRUPT += 1;
      }
    }

    // Advance to flop and maybe nullify
    if (["pre_flop", "flop", "turn", "river"].includes(room.phase)) {
      while (room.phase === "pre_flop") {
        // force street complete via checks if possible
        const idx = room.currentPlayerIndex;
        const p = room.players[idx];
        if (!p || p.isAllIn || p.status !== "active") break;
        const act = engine.handlePlayerAction(room, idx, "check");
        if (!act.ok) {
          const fold = engine.handlePlayerAction(room, idx, "call");
          if (!fold.ok) break;
        }
        if (room.phase !== "pre_flop") break;
        // safety
        if (room.communityCards.length > 0) break;
      }
    }

    if (room.phase === "flop" && loadoutA.includes("NULLIFICATION_PROTOCOL") && !a.skillRuntime.successfulCardEditThisHand) {
      room.currentPlayerIndex = room.players.findIndex((p) => p.playerId === a.playerId);
      a.skillRuntime.abyssEnergy = 10;
      a.skillRuntime.activeSkillsUsedThisPhase = 0;
      a.skillRuntime.activeSkillsUsedThisHand = Math.min(
        a.skillRuntime.activeSkillsUsedThisHand,
        SKILL_CONFIG.MAX_ACTIVE_SKILLS_PER_HAND - 1
      );
      const code = room.communityCards[0]?.code;
      if (code) {
        const r = engine.handleSkillUse(room, a, {
          skillId: "NULLIFICATION_PROTOCOL",
          requestId: `null-${i}`,
          target: { cardCode: code },
        });
        stats.skillUses += 1;
        stats.useRate.NULLIFICATION_PROTOCOL += 1;
        if (r.ok) {
          stats.cardEdits += 1;
          const hand = engine.evaluatePlayerHand(a, room);
          if (hand) stats.nullifyEvaluations += 1;
        } else stats.skillFails += 1;
      }
    }

    const cards = uniqueCardCount(room);
    if (cards.unique !== cards.total) stats.duplicateCardIncidents += 1;
    if (cards.total !== 52) stats.cardConservationIncidents += 1;

    for (const p of room.players) {
      const e = p.skillRuntime?.abyssEnergy;
      if (e > SKILL_CONFIG.MAX_ABYSS_ENERGY) stats.energyOverflow += 1;
      if (e < 0) stats.energyNegative += 1;
    }

    // Quick showdown if board full enough
    if (room.communityCards.length >= 3) {
      const ha = pickBestFive([...(a.cards || []), ...room.communityCards], {
        excludedCodes: engine.getExcludedCodes(room),
      });
      const hb = pickBestFive([...(b.cards || []), ...room.communityCards], {
        excludedCodes: engine.getExcludedCodes(room),
      });
      if (ha && hb) {
        const comparison = compareEvaluatedHands(ha, hb);
        if (comparison === 0) {
          stats.winners.tie += 1;
        } else if (comparison > 0) {
          stats.winners.A += 1;
        } else stats.winners.B += 1;
      }
    }

    roomManager.destroyRoom(room.roomId);
  }

  const denom = games || 1;
  return {
    ...stats,
    equippedRate: Object.fromEntries(
      Object.entries(stats.equippedRate).map(([k, v]) => [k, Number((v / (denom * 2)).toFixed(4))])
    ),
    useRate: Object.fromEntries(
      Object.entries(stats.useRate).map(([k, v]) => [k, Number((v / denom).toFixed(4))])
    ),
    seatWinSample: {
      A: stats.winners.A,
      B: stats.winners.B,
      tie: stats.winners.tie,
    },
  };
}

function validateCatalogLoadouts() {
  const illegal = [];
  const legal = [];
  for (const loadout of LOADOUTS) {
    const result = validateLoadout(loadout);
    if (result.ok) legal.push(loadout);
    else illegal.push({ loadout, error: result.error });
  }
  // known illegal
  const over = validateLoadout(["QUANTUM_HOLE_CARDS", "FORK_OBSERVATION", "NULLIFICATION_PROTOCOL"]);
  return { legalCount: legal.length, illegalFixtures: illegal, overLoadRejected: !over.ok };
}

function main() {
  const games = parseCount(process.argv.slice(2));
  const started = Date.now();

  // Sanity: overdrive decks never regenerate under skill edits
  let regenSafe = true;
  for (let i = 0; i < 50; i += 1) {
    const deal = generateOverdriveDeal({ candidateCount: 200 });
    const codes = deal.deck.map((c) => c.code);
    if (new Set(codes).size !== 52) regenSafe = false;
  }

  const report = {
    gamesPerMode: games,
    catalogSize: listSkillDefinitions().length,
    loadoutSanity: validateCatalogLoadouts(),
    overdriveDeckIntegritySample: { ok: regenSafe, samples: 50 },
    standardAbyss: runModeSimulation("standard", games),
    overdriveAbyss: runModeSimulation("overdrive", games),
    durationMs: Date.now() - started,
  };

  // Soft asserts for CI-ish summary
  report.ok =
    report.loadoutSanity.overLoadRejected &&
    report.overdriveDeckIntegritySample.ok &&
    report.standardAbyss.duplicateCardIncidents === 0 &&
    report.overdriveAbyss.duplicateCardIncidents === 0 &&
    report.standardAbyss.cardConservationIncidents === 0 &&
    report.overdriveAbyss.cardConservationIncidents === 0 &&
    report.standardAbyss.skillFails === 0 &&
    report.overdriveAbyss.skillFails === 0 &&
    report.standardAbyss.handsStarted === games &&
    report.overdriveAbyss.handsStarted === games &&
    report.standardAbyss.energyOverflow === 0 &&
    report.overdriveAbyss.energyOverflow === 0 &&
    report.standardAbyss.energyNegative === 0 &&
    report.overdriveAbyss.energyNegative === 0;

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main();
