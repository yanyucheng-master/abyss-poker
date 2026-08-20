/**
 * 历史对照脚本。本轮正式验证请用 scripts/validate-fortune-perception-v1.js。
 * 生产强运 = fortuneConfig.soft-v1，生产感知 = PERCEPTION_CONFIG spec-25-50。
 */
const { createDeck } = require("../utils/deck");
const { pickBestFive, compareEvaluatedHands } = require("../game/handEvaluator");
const { SKILL_MODE } = require("../game/skillModes");
const { SKILL_CONFIG } = require("../game/skillConfig");
const {
  SkillEngine,
  setPlayerLoadout,
  beginHandSkills,
  initPlayerForSkillMode,
} = require("../game/skills/skillEngine");
const {
  setFortuneChanceOverride,
  computeFortuneChance,
  FORTUNE_CONFIG,
} = require("../game/skills/fortuneConfig");
const { isStrongHole } = require("../game/skills/fortuneConfig");
const {
  LEGACY_FORTUNE_CANDIDATES,
  LEGACY_PERCEPTION_CANDIDATES,
} = require("./experiments/fortunePerceptionLegacyCandidates");

const SEED = 20260820;
const CAUSAL_HANDS = 2500;
const RATE_HANDS = 1800;
const MATCHES = 200;
const MAX_HANDS_PER_MATCH = 80;
const START_CHIPS = 1000;
const SMALL_BLIND = 25;
const BIG_BLIND = 50;

const FORTUNE_CANDIDATES = [
  {
    id: FORTUNE_CONFIG.variant,
    holeChance: FORTUNE_CONFIG.holeChance,
    boardChance: FORTUNE_CONFIG.boardChance,
    resourceChance: FORTUNE_CONFIG.resourceChance,
  },
  ...LEGACY_FORTUNE_CANDIDATES,
];

const PERCEPTION_CANDIDATES = [
  { id: "spec-25-50", base: 0.25, max: 0.50, truth: 0.75 },
  ...LEGACY_PERCEPTION_CANDIDATES,
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(deck, random) {
  const values = deck.slice();
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
}

function cloneCards(cards) {
  return (cards || []).map((card) => ({ ...card }));
}

function makePlayer(id, name, loadout) {
  const player = {
    playerId: id,
    name,
    chips: START_CHIPS,
    cards: [],
    status: "active",
    streetBet: 0,
    totalBet: 0,
    isAllIn: false,
    skillRuntime: null,
  };
  initPlayerForSkillMode(player, SKILL_MODE.ABYSS);
  const loaded = setPlayerLoadout(player, loadout);
  if (!loaded.ok) throw new Error(id + " loadout invalid: " + loaded.error);
  return player;
}

function makeRoom(playerA, playerB) {
  return {
    skillMode: SKILL_MODE.ABYSS,
    phase: "pre_flop",
    communityCards: [],
    deck: [],
    players: [playerA, playerB],
    skillState: null,
    dealerIndex: 0,
  };
}

function dealStreet(engine, room, phase) {
  if (phase === "flop") {
    const burned = room.deck.pop();
    if (burned) room.skillState.burnedCards.push(burned);
    room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    return;
  }
  room.communityCards.push(engine.applyForkDuringDeal(room));
}

function showdown(playerA, playerB, board) {
  const handA = pickBestFive([...(playerA.cards || []), ...board]);
  const handB = pickBestFive([...(playerB.cards || []), ...board]);
  if (!handA || !handB) return 0;
  return compareEvaluatedHands(handA, handB);
}

function playFullHand(engine, room, { collectBlinds = false, dealerIndex = 0 } = {}) {
  const [playerA, playerB] = room.players;
  playerA.cards = [];
  playerB.cards = [];
  playerA.status = "active";
  playerB.status = "active";
  playerA.isAllIn = false;
  playerB.isAllIn = false;
  room.communityCards = [];
  room.phase = "pre_flop";
  beginHandSkills(room);
  room.deck = shuffle(createDeck(), engine.random);

  for (let hole = 0; hole < 2; hole += 1) {
    room.players.forEach((player) => player.cards.push(room.deck.pop()));
  }

  const beforeFortune = {
    a: cloneCards(playerA.cards),
    b: cloneCards(playerB.cards),
    deck: cloneCards(room.deck),
  };
  const strongSkip = isStrongHole(playerA.cards);

  engine.applyHoleFortune(room);
  engine.onCardsDealt(room, "pre_flop");

  ["flop", "turn", "river"].forEach((phase) => {
    room.phase = phase;
    engine.applyBoardFortune(room, phase);
    dealStreet(engine, room, phase);
    engine.onCardsDealt(room, phase);
  });

  const comparison = showdown(playerA, playerB, room.communityCards);

  let baseline = 0;
  {
    const restoredA = { cards: cloneCards(beforeFortune.a) };
    const restoredB = { cards: cloneCards(beforeFortune.b) };
    const deck = cloneCards(beforeFortune.deck);
    const burned = [];
    burned.push(deck.pop());
    const board = [deck.pop(), deck.pop(), deck.pop()];
    burned.push(deck.pop());
    board.push(deck.pop());
    burned.push(deck.pop());
    board.push(deck.pop());
    baseline = showdown(restoredA, restoredB, board);
  }

  if (collectBlinds) {
    const sb = room.players[dealerIndex];
    const bb = room.players[1 - dealerIndex];
    const sbAmt = Math.min(SMALL_BLIND, sb.chips);
    const bbAmt = Math.min(BIG_BLIND, bb.chips);
    sb.chips -= sbAmt;
    bb.chips -= bbAmt;
    const pot = sbAmt + bbAmt;
    if (comparison > 0) playerA.chips += pot;
    else if (comparison < 0) playerB.chips += pot;
    else {
      const share = Math.floor(pot / 2);
      playerA.chips += share;
      playerB.chips += pot - share;
    }
  }

  const energyBeforeEnd = Number(playerA.skillRuntime.abyssEnergy);
  const holeChanged = playerA.cards[0].code !== beforeFortune.a[0].code
    || playerA.cards[1].code !== beforeFortune.a[1].code;
  const truthful = (room.skillState.skillActionLog || [])
    .filter((entry) => entry.skillId === "PERCEPTION" && entry.casterId === playerA.playerId)
    .map((entry) => entry.audit?.truthful);
  const fortuneRewrites = Number(playerA.skillRuntime.fortuneRewriteCount || 0);
  const perceptionTriggers = Number(playerA.skillRuntime.perceptionTriggerCount || 0);

  const winner = comparison > 0 ? playerA : comparison < 0 ? playerB : null;
  engine.endHand(room, { reason: "showdown", winner, tie: comparison === 0 });
  const resourceGain = (room.skillState.skillActionLog || []).some((entry) => (
    entry.skillId === "FORTUNE"
    && entry.casterId === playerA.playerId
    && entry.audit?.node === "HAND_END_RESOURCE"
  ));

  return {
    comparison,
    baseline,
    strongSkip,
    holeRewrite: holeChanged,
    fortuneRewrites,
    resourceGain,
    perceptionTriggers,
    energy: energyBeforeEnd,
    truthful,
  };
}

function emptyRates() {
  return {
    hands: 0,
    strongSkip: 0,
    holeRewrite: 0,
    anyRewrite: 0,
    rewriteCountSum: 0,
    resourceGain: 0,
    negativeEnergy: 0,
    perceptionSum: 0,
    perceptionTrue: 0,
    perceptionFalse: 0,
    actualWins: 0,
    actualTies: 0,
    baselineWins: 0,
    baselineTies: 0,
  };
}

function addRates(target, result) {
  target.hands += 1;
  if (result.strongSkip) target.strongSkip += 1;
  if (result.holeRewrite) target.holeRewrite += 1;
  if (result.fortuneRewrites > 0) target.anyRewrite += 1;
  target.rewriteCountSum += result.fortuneRewrites;
  if (result.resourceGain) target.resourceGain += 1;
  if (result.energy < 0) target.negativeEnergy += 1;
  target.perceptionSum += result.perceptionTriggers;
  (result.truthful || []).forEach((flag) => {
    if (flag === true) target.perceptionTrue += 1;
    if (flag === false) target.perceptionFalse += 1;
  });
  if (result.comparison > 0) target.actualWins += 1;
  else if (result.comparison === 0) target.actualTies += 1;
  if (result.baseline > 0) target.baselineWins += 1;
  else if (result.baseline === 0) target.baselineTies += 1;
}

function summarizeRates(stats) {
  const n = stats.hands || 1;
  const actualEquity = (stats.actualWins + stats.actualTies / 2) / n;
  const baselineEquity = (stats.baselineWins + stats.baselineTies / 2) / n;
  const percN = stats.perceptionTrue + stats.perceptionFalse;
  return {
    hands: stats.hands,
    strongSkipRate: Number((stats.strongSkip / n).toFixed(4)),
    holeRewriteRate: Number((stats.holeRewrite / n).toFixed(4)),
    anyRewriteRate: Number((stats.anyRewrite / n).toFixed(4)),
    avgRewrites: Number((stats.rewriteCountSum / n).toFixed(4)),
    resourceGainRate: Number((stats.resourceGain / n).toFixed(4)),
    negativeEnergyRate: Number((stats.negativeEnergy / n).toFixed(4)),
    avgPerceptionFacts: Number((stats.perceptionSum / n).toFixed(4)),
    perceptionTruthRate: percN ? Number((stats.perceptionTrue / percN).toFixed(4)) : null,
    actualWinRate: Number((stats.actualWins / n).toFixed(4)),
    actualEquity: Number(actualEquity.toFixed(4)),
    baselineEquity: Number(baselineEquity.toFixed(4)),
    fortuneEquityDelta: Number((actualEquity - baselineEquity).toFixed(4)),
  };
}

function theoreticalPerception(base, max, disadvantage) {
  const p = base + (max - base) * disadvantage;
  const q = 1 - p;
  const p0 = q ** 4;
  const p1 = 4 * p * (q ** 3);
  const p2 = 6 * (p ** 2) * (q ** 2);
  const p3plus = 1 - p0 - p1 - p2;
  return {
    nodeChance: Number(p.toFixed(4)),
    expectedFacts: Number((p0 * 0 + p1 * 1 + p2 * 2 + p3plus * 3).toFixed(4)),
  };
}

function scoreFortune(summaryEven, summaryBehind) {
  const delta = summaryEven.fortuneEquityDelta;
  const rewrite = summaryEven.anyRewriteRate;
  const clutch = summaryBehind.anyRewriteRate - summaryEven.anyRewriteRate;
  const neg = summaryEven.negativeEnergyRate;
  let score = 0;
  if (delta >= 0.022 && delta <= 0.055) score += 40;
  else score += Math.max(0, 40 - Math.abs(delta - 0.038) * 500);
  if (rewrite >= 0.26 && rewrite <= 0.48) score += 30;
  else score += Math.max(0, 30 - Math.abs(rewrite - 0.36) * 120);
  if (clutch >= 0.04) score += 20;
  else score += Math.max(0, 20 + clutch * 80);
  if (neg >= 0.06 && neg <= 0.28) score += 10;
  else score += Math.max(0, 10 - Math.abs(neg - 0.16) * 40);
  return Number(score.toFixed(2));
}

function scorePerception(even, behind) {
  let score = 0;
  if (even.avgPerceptionFacts >= 0.85 && even.avgPerceptionFacts <= 1.25) score += 40;
  else score += Math.max(0, 40 - Math.abs(even.avgPerceptionFacts - 1.05) * 80);
  if (behind.avgPerceptionFacts >= 1.45 && behind.avgPerceptionFacts <= 2.2) score += 35;
  else score += Math.max(0, 35 - Math.abs(behind.avgPerceptionFacts - 1.8) * 50);
  if (even.perceptionTruthRate != null && even.perceptionTruthRate >= 0.7 && even.perceptionTruthRate <= 0.8) score += 25;
  return Number(score.toFixed(2));
}

function runRates(seed, fortuneId, perceptionId, chipsA, chipsB, hands) {
  const fortune = FORTUNE_CANDIDATES.find((item) => item.id === fortuneId);
  const perception = PERCEPTION_CANDIDATES.find((item) => item.id === perceptionId);
  setFortuneChanceOverride(fortune);
  const random = mulberry32(seed);
  const engine = new SkillEngine({ random, perceptionTuning: perception });
  const playerA = makePlayer("A", "A", ["FORTUNE", "PERCEPTION"]);
  const playerB = makePlayer("B", "B", ["DEEP_BREATH", "RECYCLE"]);
  const room = makeRoom(playerA, playerB);
  const stats = emptyRates();
  for (let i = 0; i < hands; i += 1) {
    playerA.chips = chipsA;
    playerB.chips = chipsB;
    playerA.skillRuntime.abyssEnergy = SKILL_CONFIG.INITIAL_ABYSS_ENERGY;
    playerB.skillRuntime.abyssEnergy = SKILL_CONFIG.INITIAL_ABYSS_ENERGY;
    addRates(stats, playFullHand(engine, room));
  }
  return summarizeRates(stats);
}

function runMatches(seed, loadoutA, loadoutB, fortuneId, perceptionId) {
  const fortune = FORTUNE_CANDIDATES.find((item) => item.id === fortuneId);
  const perception = PERCEPTION_CANDIDATES.find((item) => item.id === perceptionId);
  setFortuneChanceOverride(fortune);
  const random = mulberry32(seed);
  const engine = new SkillEngine({ random, perceptionTuning: perception });
  let aWins = 0;
  let bWins = 0;
  let ties = 0;
  let hands = 0;
  let finalA = 0;
  const durations = [];
  for (let match = 0; match < MATCHES; match += 1) {
    const playerA = makePlayer("A", "A", loadoutA);
    const playerB = makePlayer("B", "B", loadoutB);
    const room = makeRoom(playerA, playerB);
    let dealerIndex = 0;
    let played = 0;
    while (
      playerA.chips >= SMALL_BLIND
      && playerB.chips >= SMALL_BLIND
      && played < MAX_HANDS_PER_MATCH
    ) {
      playFullHand(engine, room, { collectBlinds: true, dealerIndex });
      dealerIndex = 1 - dealerIndex;
      played += 1;
      hands += 1;
    }
    durations.push(played);
    finalA += playerA.chips;
    if (playerA.chips > playerB.chips) aWins += 1;
    else if (playerB.chips > playerA.chips) bWins += 1;
    else ties += 1;
  }
  return {
    matches: MATCHES,
    hands,
    aWins,
    bWins,
    ties,
    aWinRate: Number((aWins / MATCHES).toFixed(4)),
    avgFinalChipsA: Number((finalA / MATCHES).toFixed(1)),
    avgChipDeltaA: Number((finalA / MATCHES - START_CHIPS).toFixed(1)),
    avgHands: Number((durations.reduce((sum, value) => sum + value, 0) / MATCHES).toFixed(2)),
  };
}

function chanceGrid(fortune) {
  setFortuneChanceOverride(fortune);
  const rows = [];
  [0, 0.33, 0.66, 1].forEach((disadvantage) => {
    [0, 4, 8].forEach((energy) => {
      rows.push({
        disadvantage,
        energy,
        hole: Number(computeFortuneChance("hole", { disadvantage, energy, energyCap: 8 }).toFixed(4)),
        board: Number(computeFortuneChance("board", { disadvantage, energy, energyCap: 8 }).toFixed(4)),
        resource: Number(computeFortuneChance("resource", { disadvantage, energy, energyCap: 8 }).toFixed(4)),
      });
    });
  });
  return rows;
}

function main() {
  const fortuneReports = FORTUNE_CANDIDATES.map((candidate, index) => {
    const even = runRates(SEED + index * 17, candidate.id, "spec-25-50", 1000, 1000, CAUSAL_HANDS);
    const behind = runRates(SEED + 900 + index * 17, candidate.id, "spec-25-50", 400, 1600, RATE_HANDS);
    const desperate = runRates(SEED + 1700 + index * 17, candidate.id, "spec-25-50", 150, 1850, RATE_HANDS);
    return {
      id: candidate.id,
      tables: candidate,
      chanceGrid: chanceGrid(candidate),
      even,
      behind,
      desperate,
      score: scoreFortune(even, behind),
    };
  });
  fortuneReports.sort((a, b) => b.score - a.score);

  const perceptionReports = PERCEPTION_CANDIDATES.map((candidate, index) => {
    setFortuneChanceOverride(null);
    const randomEven = mulberry32(SEED + 4000 + index * 13);
    const engineEven = new SkillEngine({ random: randomEven, perceptionTuning: candidate });
    const evenStats = emptyRates();
    const playerA = makePlayer("A", "A", ["PERCEPTION", "RECYCLE"]);
    const playerB = makePlayer("B", "B", ["DEEP_BREATH", "RECYCLE"]);
    const room = makeRoom(playerA, playerB);
    for (let i = 0; i < RATE_HANDS; i += 1) {
      playerA.chips = 1000;
      playerB.chips = 1000;
      playerA.skillRuntime.abyssEnergy = 4;
      addRates(evenStats, playFullHand(engineEven, room));
    }
    const randomBehind = mulberry32(SEED + 5100 + index * 13);
    const engineBehind = new SkillEngine({ random: randomBehind, perceptionTuning: candidate });
    const behindStats = emptyRates();
    const behindA = makePlayer("A", "A", ["PERCEPTION", "RECYCLE"]);
    const behindB = makePlayer("B", "B", ["DEEP_BREATH", "RECYCLE"]);
    const behindRoom = makeRoom(behindA, behindB);
    for (let i = 0; i < RATE_HANDS; i += 1) {
      behindA.chips = 400;
      behindB.chips = 1600;
      behindA.skillRuntime.abyssEnergy = 4;
      addRates(behindStats, playFullHand(engineBehind, behindRoom));
    }
    const even = summarizeRates(evenStats);
    const behind = summarizeRates(behindStats);
    return {
      id: candidate.id,
      tables: candidate,
      theoreticalEven: theoreticalPerception(candidate.base, candidate.max, 0),
      theoreticalBehind: theoreticalPerception(candidate.base, candidate.max, 0.75),
      even,
      behind,
      score: scorePerception(even, behind),
    };
  });
  perceptionReports.sort((a, b) => b.score - a.score);

  const bestFortune = fortuneReports[0];
  const conservative = fortuneReports.find((item) => item.id === "conservative");
  const soft = fortuneReports.find((item) => item.id === "soft-v1");
  const bestPerception = perceptionReports[0];
  const specPerception = perceptionReports.find((item) => item.id === "spec-25-50") || bestPerception;
  const matchCandidates = [bestFortune, conservative, soft].filter(Boolean)
    .filter((item, index, list) => list.findIndex((entry) => entry.id === item.id) === index);
  const matches = {};
  matchCandidates.forEach((candidate, index) => {
    matches[`${candidate.id}_fortuneVsControl`] = runMatches(
      SEED + 8000 + index * 17,
      ["FORTUNE", "RECYCLE"],
      ["DEEP_BREATH", "RECYCLE"],
      candidate.id,
      specPerception.id,
    );
  });
  matches.perceptionVsControl = runMatches(
    SEED + 8100,
    ["PERCEPTION", "RECYCLE"],
    ["DEEP_BREATH", "RECYCLE"],
    specPerception.id === "spec-25-50" ? "conservative" : specPerception.id,
    specPerception.id,
  );

  setFortuneChanceOverride(null);
  const report = {
    seed: SEED,
    causalHands: CAUSAL_HANDS,
    rateHands: RATE_HANDS,
    matchesPerPairing: MATCHES,
    targets: {
      fortuneShowdownDelta: "2.2%–5.5%",
      fortuneRewriteEven: "26%–48%",
      fortuneClutchRewriteLift: "≥4pp when 400 vs 1600",
      perceptionFactsEven: "0.85–1.25",
      perceptionFactsBehind: "1.45–2.20",
      perceptionTruth: "70%–80%",
    },
    recommended: {
      // 脚本分会把 clutch 排第一；第一版暂定采用 soft-v1，因为 80 手 check-down 会把每手优势复利放大。
      fortune: bestFortune.id,
      perception: bestPerception.id,
      fortuneTables: bestFortune.tables,
      perceptionTables: bestPerception.tables,
    },
    fortuneReports,
    perceptionReports,
    matches,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();
