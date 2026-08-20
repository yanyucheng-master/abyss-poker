const fs = require("fs");
const path = require("path");
const { createDeck } = require("../utils/deck");
const { pickBestFive, compareEvaluatedHands } = require("../game/handEvaluator");
const { SKILL_MODE } = require("../game/skillModes");
const { SKILL_CONFIG, PERCEPTION_CONFIG } = require("../game/skillConfig");
const { collectBet, isStreetComplete } = require("../game/pokerLogic");
const {
  SkillEngine,
  setPlayerLoadout,
  beginHandSkills,
  initPlayerForSkillMode,
} = require("../game/skills/skillEngine");
const { FORTUNE_CONFIG, isStrongHole } = require("../game/skills/fortuneConfig");

const PRIMARY_SEED = 20260820;
const EXTRA_SEEDS = [20260821, 20260822, 20260823];
const HANDS_PER_STACK = Number(process.env.VP_HANDS) || 12000;
const ENERGY_HANDS = Number(process.env.VP_ENERGY_HANDS) || 2500;
const SEQ_HANDS = Number(process.env.VP_SEQ_HANDS) || 20000;
const MATCHES = Number(process.env.VP_MATCHES) || 1000;
const EXTRA_HANDS = Number(process.env.VP_EXTRA_HANDS) || 4000;
const EXTRA_MATCHES = Number(process.env.VP_EXTRA_MATCHES) || 250;
const MAX_HANDS_PER_MATCH = 80;
const EQUITY_SAMPLES = 10;
const START_CHIPS = 1000;
const SMALL_BLIND = 25;
const BIG_BLIND = 50;

const STACKS = Object.freeze({
  even: { a: 1000, b: 1000, label: "均势" },
  mild: { a: 700, b: 1300, label: "轻度落后" },
  behind: { a: 400, b: 1600, label: "明显落后" },
  desperate: { a: 150, b: 1850, label: "绝境" },
});

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

function round(value, digits = 4) {
  if (value == null || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
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

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function summarizeNumeric(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, median: null, std: null, p75: null, p90: null, p95: null, p99: null, min: null, max: null };
  const sorted = values.slice().sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
  const variance = n > 1
    ? sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
    : 0;
  return {
    n,
    mean: round(mean, 5),
    median: round(percentile(sorted, 0.5), 5),
    std: round(Math.sqrt(variance), 5),
    p75: round(percentile(sorted, 0.75), 5),
    p90: round(percentile(sorted, 0.9), 5),
    p95: round(percentile(sorted, 0.95), 5),
    p99: round(percentile(sorted, 0.99), 5),
    min: round(sorted[0], 5),
    max: round(sorted[n - 1], 5),
  };
}

function wilson(count, n, z = 1.96) {
  if (!n) return { n: 0, count: count || 0, percentage: null, low: null, high: null };
  const p = count / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    n,
    count,
    percentage: round(p, 4),
    low: round((center - margin) / denom, 4),
    high: round((center + margin) / denom, 4),
  };
}

function meanCi(values) {
  const stats = summarizeNumeric(values);
  if (!stats.n) return stats;
  const se = stats.std / Math.sqrt(stats.n);
  return {
    ...stats,
    se: round(se, 5),
    meanLow: round(stats.mean - 1.96 * se, 5),
    meanHigh: round(stats.mean + 1.96 * se, 5),
  };
}

function showdownScore(hero, villain, board) {
  const handA = pickBestFive([...(hero || []), ...board]);
  const handB = pickBestFive([...(villain || []), ...board]);
  if (!handA || !handB) return 0.5;
  const cmp = compareEvaluatedHands(handA, handB);
  if (cmp > 0) return 1;
  if (cmp < 0) return 0;
  return 0.5;
}

function mcEquity(hero, villain, board, remaining, random, samples = EQUITY_SAMPLES) {
  if (!remaining.length) return showdownScore(hero, villain, board);
  let total = 0;
  for (let i = 0; i < samples; i += 1) {
    const pool = shuffle(remaining, random);
    const fullBoard = cloneCards(board);
    let cursor = 0;
    while (fullBoard.length < 5 && cursor < pool.length) {
      fullBoard.push(pool[cursor]);
      cursor += 1;
    }
    total += showdownScore(hero, villain, fullBoard);
  }
  return total / samples;
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
    hasActed: false,
    isAllIn: false,
    skillRuntime: null,
  };
  initPlayerForSkillMode(player, SKILL_MODE.ABYSS);
  const loaded = setPlayerLoadout(player, loadout);
  if (!loaded.ok) throw new Error(`${id} loadout invalid: ${loaded.error}`);
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
    currentPlayerIndex: 0,
    currentBet: 0,
    lastRaiseSize: BIG_BLIND,
    bigBlind: BIG_BLIND,
    pot: 0,
  };
}

function holeClass(cards) {
  if (!cards || cards.length < 2) return "unknown";
  if (isStrongHole(cards)) {
    if (cards[0].rank === cards[1].rank) {
      if (cards[0].rank === "A") return "AA";
      if (cards[0].rank === "K") return "KK";
      if (cards[0].rank === "Q") return "QQ";
      return "pair";
    }
    return "strong";
  }
  return "weak";
}

function binDeltaPp(delta) {
  const pp = delta * 100;
  if (pp < 0) return "<0";
  if (pp < 5) return "0-5";
  if (pp < 10) return "5-10";
  if (pp < 20) return "10-20";
  if (pp < 30) return "20-30";
  return "30+";
}

function holeStrength(cards) {
  if (!cards || cards.length < 2) return 0.2;
  const [a, b] = cards;
  const high = Math.max(a.value, b.value);
  const low = Math.min(a.value, b.value);
  const pair = a.rank === b.rank;
  const suited = a.suit === b.suit;
  const gap = Math.abs(a.value - b.value);
  let score = high / 20;
  if (pair) score = 0.52 + high / 50;
  if (suited) score += 0.07;
  if (gap === 1) score += 0.07;
  else if (gap === 2) score += 0.03;
  if (high >= 13 && low >= 10) score += 0.08;
  return Math.max(0.05, Math.min(0.95, score));
}

function postflopStrength(hero, board) {
  if (!board.length) return holeStrength(hero);
  const made = pickBestFive([...(hero || []), ...board]);
  let score = ((made?.category || 1) - 1) / 9;
  const suits = [...hero, ...board].map((card) => card.suit);
  const suitCounts = suits.reduce((map, suit) => {
    map[suit] = (map[suit] || 0) + 1;
    return map;
  }, {});
  if (Math.max(0, ...Object.values(suitCounts)) >= 4) score += 0.08;
  return Math.max(0.05, Math.min(0.96, score));
}

function decideCheckdown(player, { toCall }) {
  if (toCall > 0) return { action: player.chips > 0 ? "call" : "check" };
  return { action: "check" };
}

function decideHeuristic(player, room, { toCall, canRaise }) {
  const strength = postflopStrength(player.cards, room.communityCards);
  const potOdds = toCall / Math.max(1, room.pot + toCall);
  if (toCall > 0) {
    if (strength + 0.08 < potOdds && strength < 0.46) return { action: "fold" };
    if (strength >= 0.74 && canRaise) {
      return { action: "raise", size: Math.min(player.chips + player.streetBet, Math.max(room.currentBet * 2, Math.floor(room.pot * 0.8))) };
    }
    return { action: "call" };
  }
  if (strength >= 0.64 && canRaise) {
    const raiseTo = Math.min(player.chips + player.streetBet, Math.max(BIG_BLIND, Math.floor(Math.max(room.pot, BIG_BLIND) * 0.7)));
    if (raiseTo > room.currentBet) return { action: "raise", size: raiseTo };
  }
  return { action: "check" };
}

function applyDecision(room, player, decision) {
  const toCall = Math.max(0, room.currentBet - player.streetBet);
  if (decision.action === "fold") {
    player.status = "folded";
    if (player.skillRuntime) player.skillRuntime.foldedThisHand = true;
    return "fold";
  }
  if (decision.action === "raise") {
    const raiseTo = Math.max(room.currentBet + room.lastRaiseSize, Number(decision.size) || room.currentBet + BIG_BLIND);
    const paid = collectBet(room, player, Math.max(0, raiseTo - player.streetBet));
    if (paid > toCall) {
      room.lastRaiseSize = Math.max(BIG_BLIND, player.streetBet - room.currentBet);
      room.currentBet = player.streetBet;
      room.players.forEach((other) => {
        if (other.playerId !== player.playerId && other.status === "active") other.hasActed = false;
      });
    }
    player.hasActed = true;
    return "raise";
  }
  if (toCall > 0) collectBet(room, player, toCall);
  player.hasActed = true;
  return toCall > 0 ? "call" : "check";
}

function runStreet(room, decide, firstIndex) {
  if (room.players.some((player) => player.status === "folded")) return "fold";
  room.players.forEach((player) => {
    player.streetBet = 0;
    player.hasActed = false;
  });
  if (room.phase === "pre_flop") {
    room.currentBet = Math.max(...room.players.map((player) => player.streetBet));
  } else {
    room.currentBet = 0;
    room.lastRaiseSize = BIG_BLIND;
  }
  let idx = firstIndex;
  let guard = 0;
  while (!isStreetComplete(room) && guard < 10) {
    guard += 1;
    const player = room.players[idx];
    idx = 1 - idx;
    if (player.status !== "active" || player.isAllIn) continue;
    const toCall = Math.max(0, room.currentBet - player.streetBet);
    const opponent = room.players.find((item) => item.playerId !== player.playerId);
    const canRaise = Boolean(opponent && !opponent.isAllIn && player.chips > toCall);
    const decision = decide(player, { toCall, canRaise });
    const result = applyDecision(room, player, decision);
    if (result === "fold") return "fold";
  }
  return "continue";
}

function postBlinds(room, dealerIndex) {
  const sb = room.players[dealerIndex];
  const bb = room.players[1 - dealerIndex];
  room.pot = 0;
  room.lastRaiseSize = BIG_BLIND;
  room.players.forEach((player) => {
    player.streetBet = 0;
    player.totalBet = 0;
    player.hasActed = false;
    player.isAllIn = false;
    player.status = "active";
  });
  collectBet(room, sb, SMALL_BLIND);
  collectBet(room, bb, BIG_BLIND);
  room.currentBet = Math.max(sb.streetBet, bb.streetBet);
}

function playHand(engine, room, options = {}) {
  const {
    chipsA,
    chipsB,
    energyA,
    persistEnergy = false,
    betting = "none",
    dealerIndex = 0,
    collectEquity = false,
  } = options;
  const [playerA, playerB] = room.players;
  if (chipsA != null) playerA.chips = chipsA;
  if (chipsB != null) playerB.chips = chipsB;
  const energyBefore = persistEnergy ? Number(playerA.skillRuntime.abyssEnergy) : energyA;

  playerA.cards = [];
  playerB.cards = [];
  playerA.status = "active";
  playerB.status = "active";
  playerA.isAllIn = false;
  playerB.isAllIn = false;
  room.communityCards = [];
  room.phase = "pre_flop";
  room.dealerIndex = dealerIndex;
  room.pot = 0;
  beginHandSkills(room);
  if (!persistEnergy && energyA != null) playerA.skillRuntime.abyssEnergy = energyA;
  if (energyBefore != null && persistEnergy) playerA.skillRuntime.abyssEnergy = energyBefore;
  const energyAtStart = Number(playerA.skillRuntime.abyssEnergy);
  room.deck = shuffle(createDeck(), engine.random);

  for (let hole = 0; hole < 2; hole += 1) {
    room.players.forEach((player) => player.cards.push(room.deck.pop()));
  }

  const beforeFortune = {
    a: cloneCards(playerA.cards),
    b: cloneCards(playerB.cards),
    deck: cloneCards(room.deck),
  };
  const holeBeforeClass = holeClass(playerA.cards);
  const strongSkip = isStrongHole(playerA.cards);
  const equityDeltas = [];

  const snapshotEquity = () => ({
    hero: cloneCards(playerA.cards),
    villain: cloneCards(playerB.cards),
    board: cloneCards(room.communityCards),
    remaining: cloneCards(room.deck),
  });

  const maybeRecord = (kind, before) => {
    if (!collectEquity) return;
    const after = snapshotEquity();
    const eqBefore = mcEquity(before.hero, before.villain, before.board, before.remaining, engine.random);
    const eqAfter = mcEquity(after.hero, after.villain, after.board, after.remaining, engine.random);
    equityDeltas.push({
      kind,
      before: eqBefore,
      after: eqAfter,
      delta: eqAfter - eqBefore,
      holeFrom: holeBeforeClass,
      holeTo: holeClass(playerA.cards),
    });
  };

  let beforeShot = snapshotEquity();
  const holeHits = engine.applyHoleFortune(room);
  if (holeHits.length) maybeRecord("hole", beforeShot);
  engine.onCardsDealt(room, "pre_flop");

  let folded = false;
  let foldBy = null;
  const actions = { fold: 0, call: 0, raise: 0, check: 0, showdown: 0 };

  const decide = (player, ctx) => {
    const decision = betting === "heuristic"
      ? decideHeuristic(player, room, ctx)
      : decideCheckdown(player, ctx);
    actions[decision.action] = (actions[decision.action] || 0) + 1;
    return decision;
  };

  if (betting !== "none") {
    postBlinds(room, dealerIndex);
    // blinds already posted; streetBet is non-zero, so don't wipe in runStreet preflop
    const preflopFirst = dealerIndex;
    room.players.forEach((player) => { player.hasActed = false; });
    let idx = preflopFirst;
    let guard = 0;
    while (!isStreetComplete(room) && guard < 10) {
      guard += 1;
      const player = room.players[idx];
      idx = 1 - idx;
      if (player.status !== "active" || player.isAllIn) continue;
      const toCall = Math.max(0, room.currentBet - player.streetBet);
      const opponent = room.players.find((item) => item.playerId !== player.playerId);
      const canRaise = Boolean(opponent && !opponent.isAllIn && player.chips > toCall);
      const result = applyDecision(room, player, decide(player, { toCall, canRaise }));
      if (result === "fold") {
        folded = true;
        foldBy = player.playerId;
        break;
      }
    }
  }

  if (!folded) {
    ["flop", "turn", "river"].forEach((phase) => {
      if (folded) return;
      room.phase = phase;
      beforeShot = snapshotEquity();
      const boardHits = engine.applyBoardFortune(room, phase);
      if (boardHits.length) maybeRecord("board", beforeShot);
      if (phase === "flop") {
        const burned = room.deck.pop();
        if (burned) room.skillState.burnedCards.push(burned);
        room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
      } else {
        room.communityCards.push(engine.applyForkDuringDeal(room));
      }
      engine.onCardsDealt(room, phase);
      if (betting !== "none") {
        const first = phase === "pre_flop" ? dealerIndex : 1 - dealerIndex;
        const streetResult = runStreet(room, decide, first);
        if (streetResult === "fold") {
          folded = true;
          foldBy = room.players.find((player) => player.status === "folded")?.playerId || null;
        }
      }
    });
  }

  const comparison = folded ? 0 : showdownScore(playerA.cards, playerB.cards, room.communityCards) * 2 - 1;
  let winner = null;
  let reason = "showdown";
  let tie = false;
  if (folded) {
    reason = "fold";
    winner = room.players.find((player) => player.playerId !== foldBy) || null;
  } else if (comparison > 0) winner = playerA;
  else if (comparison < 0) winner = playerB;
  else tie = true;

  if (betting !== "none" && !tie && winner) {
    const loser = winner.playerId === playerA.playerId ? playerB : playerA;
    loser.chips += 0;
    winner.chips += room.pot;
    room.pot = 0;
  } else if (betting !== "none" && tie) {
    const share = Math.floor(room.pot / 2);
    playerA.chips += share;
    playerB.chips += room.pot - share;
    room.pot = 0;
  }

  let baseline = 0.5;
  {
    const restoredA = { cards: cloneCards(beforeFortune.a) };
    const restoredB = { cards: cloneCards(beforeFortune.b) };
    const deck = cloneCards(beforeFortune.deck);
    deck.pop();
    const board = [deck.pop(), deck.pop(), deck.pop()];
    deck.pop();
    board.push(deck.pop());
    deck.pop();
    board.push(deck.pop());
    baseline = showdownScore(restoredA.cards, restoredB.cards, board);
  }
  const actual = folded ? (winner?.playerId === playerA.playerId ? 1 : 0) : showdownScore(playerA.cards, playerB.cards, room.communityCards);

  const energyBeforeEnd = Number(playerA.skillRuntime.abyssEnergy);
  const perceptionEntries = (room.skillState.skillActionLog || [])
    .filter((entry) => entry.skillId === "PERCEPTION" && entry.casterId === playerA.playerId);
  const fortunePaid = (room.skillState.skillActionLog || [])
    .filter((entry) => entry.skillId === "FORTUNE" && entry.casterId === playerA.playerId && entry.paid);
  const resourceBefore = Number(playerA.skillRuntime.fortuneResourceUsed);
  engine.endHand(room, { reason, winner, tie });
  const energyAfter = Number(playerA.skillRuntime.abyssEnergy);
  const resourceTriggered = Boolean(playerA.skillRuntime.fortuneResourceUsed) && energyAfter > energyBeforeEnd - 0.1
    && (room.skillState.skillActionLog || []).some((entry) => (
      entry.skillId === "FORTUNE"
      && entry.casterId === playerA.playerId
      && entry.audit?.node === "HAND_END_RESOURCE"
    ));
  const resourceHit = (room.skillState.skillActionLog || []).some((entry) => (
    entry.skillId === "FORTUNE"
    && entry.casterId === playerA.playerId
    && entry.energyRecoverySource === "FORTUNE"
  ));
  const lost = Boolean(winner && winner.playerId !== playerA.playerId && !tie);
  const loserGain = lost ? SKILL_CONFIG.ENERGY_LOSER_GAIN : 0;
  const history = playerA.skillRuntime.perceptionHistory || [];
  const axisSet = new Set(history.map((entry) => entry.axis));
  const duplicateAxis = history.length - axisSet.size;

  return {
    strongSkip,
    holeRewrites: holeHits.length,
    rewrites: Number(playerA.skillRuntime.fortuneRewriteCount || 0),
    resourceHit,
    loserGain,
    energyAtStart,
    energyBeforeEnd,
    energyAfter,
    energyDelta: energyAfter - energyAtStart,
    paidEnergy: fortunePaid.reduce((sum, entry) => sum + (Number(entry.cost) || 0), 0),
    perceptionCount: perceptionEntries.length,
    perception: perceptionEntries.map((entry) => ({
      node: entry.audit?.node,
      category: entry.audit?.category,
      truthful: entry.audit?.truthful,
      factId: entry.audit?.factId,
      axis: entry.audit?.axis,
    })),
    duplicateAxis,
    historySize: history.length,
    actual,
    baseline,
    equityDelta: actual - baseline,
    equityDeltas,
    holeFrom: holeBeforeClass,
    holeTo: holeClass(playerA.cards),
    folded,
    reason,
    winnerId: winner?.playerId || null,
    actions,
    unusedResourceFlag: resourceBefore,
  };
}

function rewriteBucket(count) {
  if (count >= 4) return "4+";
  return String(count);
}

function emptyRewriteDist() {
  return { 0: 0, 1: 0, 2: 0, 3: 0, "4+": 0 };
}

function emptyDeltaBins() {
  return { "<0": 0, "0-5": 0, "5-10": 0, "10-20": 0, "20-30": 0, "30+": 0 };
}

function runIsolatedHands(seed, stack, hands, { energy = 4, collectEquity = true, loadoutA = ["FORTUNE", "PERCEPTION"] } = {}) {
  const random = mulberry32(seed);
  const engine = new SkillEngine({ random });
  const playerA = makePlayer("A", "A", loadoutA);
  const playerB = makePlayer("B", "B", ["DEEP_BREATH", "RECYCLE"]);
  const room = makeRoom(playerA, playerB);
  const rewriteDist = emptyRewriteDist();
  const perceptionDist = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const categories = {};
  const nodeTruth = {};
  const holeDeltas = [];
  const boardDeltas = [];
  const allDeltas = [];
  const jumps = { weakToAA: 0, weakToKK: 0, weakToQQ: 0, weakToStrong: 0, holeRewrites: 0 };
  const resource = { hits: 0, loserAndResource: 0, recovery: { 0: 0, 1: 0, 2: 0, "3+": 0 } };
  const causal = [];
  let duplicateAxis = 0;
  let negativeEnergyHands = 0;

  for (let i = 0; i < hands; i += 1) {
    const result = playHand(engine, room, {
      chipsA: stack.a,
      chipsB: stack.b,
      energyA: energy,
      persistEnergy: false,
      betting: "none",
      collectEquity,
    });
    rewriteDist[rewriteBucket(result.rewrites)] += 1;
    perceptionDist[Math.min(3, result.perceptionCount)] += 1;
    duplicateAxis += result.duplicateAxis;
    causal.push(result.equityDelta);
    if (result.energyAfter < 0) negativeEnergyHands += 1;
    if (result.resourceHit) resource.hits += 1;
    if (result.resourceHit && result.loserGain) resource.loserAndResource += 1;
    const recovered = (result.resourceHit ? 1 : 0) + result.loserGain;
    resource.recovery[recovered >= 3 ? "3+" : String(recovered)] += 1;
    result.perception.forEach((entry) => {
      const cat = entry.category || "UNKNOWN";
      if (!categories[cat]) categories[cat] = { n: 0, true: 0, false: 0, evenTrue: 0, behindTrue: 0, nodes: {} };
      categories[cat].n += 1;
      if (entry.truthful) categories[cat].true += 1;
      else categories[cat].false += 1;
      const node = entry.node || "unknown";
      if (!categories[cat].nodes[node]) categories[cat].nodes[node] = { n: 0, true: 0 };
      categories[cat].nodes[node].n += 1;
      if (entry.truthful) categories[cat].nodes[node].true += 1;
      if (!nodeTruth[node]) nodeTruth[node] = { n: 0, true: 0 };
      nodeTruth[node].n += 1;
      if (entry.truthful) nodeTruth[node].true += 1;
    });
    result.equityDeltas.forEach((entry) => {
      allDeltas.push(entry.delta);
      if (entry.kind === "hole") {
        holeDeltas.push(entry.delta);
        jumps.holeRewrites += 1;
        if (entry.holeFrom === "weak" && entry.holeTo === "AA") jumps.weakToAA += 1;
        if (entry.holeFrom === "weak" && entry.holeTo === "KK") jumps.weakToKK += 1;
        if (entry.holeFrom === "weak" && entry.holeTo === "QQ") jumps.weakToQQ += 1;
        if (entry.holeFrom === "weak" && entry.holeTo !== "weak") jumps.weakToStrong += 1;
      } else boardDeltas.push(entry.delta);
    });
  }

  const rewriteN = hands;
  const p2 = rewriteDist["2"] + rewriteDist["3"] + rewriteDist["4+"];
  const p3 = rewriteDist["3"] + rewriteDist["4+"];
  const categoryReport = {};
  Object.entries(categories).forEach(([key, value]) => {
    categoryReport[key] = {
      ...wilson(value.true, value.n),
      falseCount: value.false,
      nodes: Object.fromEntries(Object.entries(value.nodes).map(([node, stats]) => [node, wilson(stats.true, stats.n)])),
    };
  });
  const holeBins = emptyDeltaBins();
  holeDeltas.forEach((delta) => { holeBins[binDeltaPp(delta)] += 1; });
  const boardBins = emptyDeltaBins();
  boardDeltas.forEach((delta) => { boardBins[binDeltaPp(delta)] += 1; });

  return {
    stack: stack.label,
    hands,
    rewriteDist: Object.fromEntries(Object.entries(rewriteDist).map(([key, count]) => [key, wilson(count, rewriteN)])),
    pAtLeast2: wilson(p2, rewriteN),
    pAtLeast3: wilson(p3, rewriteN),
    avgRewrites: round(Object.entries(rewriteDist).reduce((sum, [key, count]) => (
      sum + count * (key === "4+" ? 4 : Number(key))
    ), 0) / hands, 4),
    causalEquity: meanCi(causal),
    perceptionDist: Object.fromEntries(Object.entries(perceptionDist).map(([key, count]) => [key, wilson(count, hands)])),
    avgPerception: round(Object.entries(perceptionDist).reduce((sum, [key, count]) => sum + count * Number(key), 0) / hands, 4),
    categories: categoryReport,
    nodeTruth: Object.fromEntries(Object.entries(nodeTruth).map(([node, stats]) => [node, wilson(stats.true, stats.n)])),
    overallTruth: wilson(
      Object.values(categories).reduce((sum, value) => sum + value.true, 0),
      Object.values(categories).reduce((sum, value) => sum + value.n, 0),
    ),
    duplicateAxis,
    holeEquity: { ...meanCi(holeDeltas), bins: holeBins },
    boardEquity: { ...meanCi(boardDeltas), bins: boardBins },
    jumps: {
      ...jumps,
      weakToAARate: wilson(jumps.weakToAA, Math.max(1, jumps.holeRewrites)),
      weakToPremiumPairRate: wilson(jumps.weakToAA + jumps.weakToKK + jumps.weakToQQ, Math.max(1, jumps.holeRewrites)),
      weakToStrongRate: wilson(jumps.weakToStrong, Math.max(1, jumps.holeRewrites)),
    },
    resource: {
      hits: wilson(resource.hits, hands),
      per100Hands: round((resource.hits / hands) * 100, 3),
      extraEnergyPer100: round((resource.hits / hands) * 100, 3),
      withLoserGain: wilson(resource.loserAndResource, hands),
      recovery: Object.fromEntries(Object.entries(resource.recovery).map(([key, count]) => [key, wilson(count, hands)])),
    },
    negativeEnergyHands: wilson(negativeEnergyHands, hands),
  };
}

function runEnergyGrid(seed, stack, hands) {
  const rows = [];
  for (let energy = 0; energy <= 8; energy += 1) {
    const random = mulberry32(seed + energy * 97);
    const engine = new SkillEngine({ random });
    const playerA = makePlayer("A", "A", ["FORTUNE", "RECYCLE"]);
    const playerB = makePlayer("B", "B", ["DEEP_BREATH", "RECYCLE"]);
    const room = makeRoom(playerA, playerB);
    let hole = 0;
    let board = 0;
    let rewrites = 0;
    let resource = 0;
    let energyDelta = 0;
    let anyRewrite = 0;
    for (let i = 0; i < hands; i += 1) {
      const result = playHand(engine, room, {
        chipsA: stack.a,
        chipsB: stack.b,
        energyA: energy,
        betting: "none",
        collectEquity: false,
      });
      hole += result.holeRewrites;
      const boardRewrites = result.rewrites - result.holeRewrites;
      board += boardRewrites;
      rewrites += result.rewrites;
      if (result.rewrites > 0) anyRewrite += 1;
      if (result.resourceHit) resource += 1;
      energyDelta += result.energyDelta;
    }
    rows.push({
      energy,
      holeRate: wilson(hole, hands),
      boardNodeRate: wilson(board, hands * 3),
      anyRewriteRate: wilson(anyRewrite, hands),
      resourceRate: wilson(resource, hands),
      avgRewrites: round(rewrites / hands, 4),
      avgNetEnergy: round(energyDelta / hands, 4),
    });
  }
  return rows;
}

function runSequential(seed, stack, hands) {
  const random = mulberry32(seed);
  const engine = new SkillEngine({ random });
  const playerA = makePlayer("A", "A", ["FORTUNE", "RECYCLE"]);
  const playerB = makePlayer("B", "B", ["DEEP_BREATH", "RECYCLE"]);
  const room = makeRoom(playerA, playerB);
  playerA.skillRuntime.abyssEnergy = 4;
  const levels = { "-1": 0, "-2": 0, "-3": 0, "-4": 0 };
  let inDebt = false;
  let debtStart = 0;
  const debtDurations = [];
  let maxDebt = 0;
  let resourceFromDebt = 0;
  const rewriteFlags = [];
  const feedbackFlags = [];
  for (let i = 0; i < hands; i += 1) {
    const energyBefore = Number(playerA.skillRuntime.abyssEnergy);
    const result = playHand(engine, room, {
      chipsA: stack.a,
      chipsB: stack.b,
      persistEnergy: true,
      betting: "none",
      collectEquity: false,
    });
    const energy = result.energyAfter;
    rewriteFlags.push(result.rewrites > 0);
    feedbackFlags.push(result.rewrites > 0 || result.resourceHit);
    if (energy < 0) {
      const key = String(Math.max(-4, Math.round(energy)));
      if (levels[key] != null) levels[key] += 1;
      if (!inDebt) {
        inDebt = true;
        debtStart = i;
      }
      if (result.resourceHit && energyBefore < 0) resourceFromDebt += 1;
    } else if (inDebt) {
      const duration = i - debtStart;
      debtDurations.push(duration);
      maxDebt = Math.max(maxDebt, duration);
      inDebt = false;
    }
  }
  if (inDebt) {
    const duration = hands - debtStart;
    debtDurations.push(duration);
    maxDebt = Math.max(maxDebt, duration);
  }
  function windowRate(flags, width) {
    let hits = 0;
    const windows = Math.max(0, flags.length - width + 1);
    for (let i = 0; i < windows; i += 1) {
      if (flags.slice(i, i + width).every((flag) => !flag)) hits += 1;
    }
    return wilson(hits, Math.max(1, windows));
  }
  function meanGap(flags) {
    const gaps = [];
    let gap = 0;
    flags.forEach((hit) => {
      if (hit) {
        gaps.push(gap + 1);
        gap = 0;
      } else gap += 1;
    });
    if (gap) gaps.push(gap);
    return round(gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : flags.length, 3);
  }
  const debtHands = Object.values(levels).reduce((sum, value) => sum + value, 0);
  return {
    hands,
    debtHands: wilson(debtHands, hands),
    levels: Object.fromEntries(Object.entries(levels).map(([key, count]) => [key, wilson(count, hands)])),
    avgDebtDurationHands: round(debtDurations.length ? debtDurations.reduce((a, b) => a + b, 0) / debtDurations.length : 0, 4),
    maxDebtStreakHands: maxDebt,
    debtEpisodes: debtDurations.length,
    resourceRecoveriesWhileInDebt: resourceFromDebt,
    pNoRewrite5: windowRate(rewriteFlags, 5),
    pNoRewrite10: windowRate(rewriteFlags, 10),
    pNoFeedback5: windowRate(feedbackFlags, 5),
    avgHandsPerRewrite: meanGap(rewriteFlags),
    avgHandsPerFeedback: meanGap(feedbackFlags),
  };
}

function runMatches(seed, betting, matches, loadoutA, loadoutB) {
  const random = mulberry32(seed);
  const engine = new SkillEngine({ random });
  let aWins = 0;
  let bWins = 0;
  let ties = 0;
  let hands = 0;
  let folds = 0;
  let showdowns = 0;
  let rewrites = 0;
  let paid = 0;
  let debtHands = 0;
  const chipDeltas = [];
  const handCounts = [];
  for (let match = 0; match < matches; match += 1) {
    const playerA = makePlayer("A", "A", loadoutA);
    const playerB = makePlayer("B", "B", loadoutB);
    const room = makeRoom(playerA, playerB);
    playerA.chips = START_CHIPS;
    playerB.chips = START_CHIPS;
    let hand = 0;
    while (hand < MAX_HANDS_PER_MATCH && playerA.chips > 0 && playerB.chips > 0) {
      const result = playHand(engine, room, {
        persistEnergy: true,
        betting,
        dealerIndex: hand % 2,
        collectEquity: false,
      });
      hand += 1;
      hands += 1;
      rewrites += result.rewrites;
      paid += result.paidEnergy;
      if (result.energyAfter < 0) debtHands += 1;
      if (result.folded) folds += 1;
      else showdowns += 1;
    }
    handCounts.push(hand);
    chipDeltas.push(playerA.chips - START_CHIPS);
    if (playerA.chips > playerB.chips) aWins += 1;
    else if (playerB.chips > playerA.chips) bWins += 1;
    else ties += 1;
  }
  return {
    matches,
    hands,
    aWins,
    bWins,
    ties,
    aWinRate: wilson(aWins, matches),
    avgHands: round(handCounts.reduce((a, b) => a + b, 0) / matches, 3),
    foldRate: wilson(folds, hands),
    showdownRate: wilson(showdowns, hands),
    avgChipDelta: meanCi(chipDeltas),
    avgRewritesPerHand: round(rewrites / Math.max(1, hands), 4),
    avgPaidEnergyPerHand: round(paid / Math.max(1, hands), 4),
    debtHandRate: wilson(debtHands, hands),
  };
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function main() {
  const started = Date.now();
  log("validate-fortune-perception-v1 starting");
  const report = {
    seed: PRIMARY_SEED,
    extraSeeds: EXTRA_SEEDS,
    sampleSizes: {
      handsPerStack: HANDS_PER_STACK,
      energyHands: ENERGY_HANDS,
      sequentialHands: SEQ_HANDS,
      matches: MATCHES,
      extraHands: EXTRA_HANDS,
      extraMatches: EXTRA_MATCHES,
      equitySamples: EQUITY_SAMPLES,
    },
    production: {
      fortune: {
        status: FORTUNE_CONFIG.status,
        variant: FORTUNE_CONFIG.variant,
        holeChance: FORTUNE_CONFIG.holeChance,
        boardChance: FORTUNE_CONFIG.boardChance,
        resourceChance: FORTUNE_CONFIG.resourceChance,
        rewriteCost: FORTUNE_CONFIG.rewriteCost,
        minEnergy: FORTUNE_CONFIG.minEnergy,
      },
      perception: PERCEPTION_CONFIG,
    },
    note: "Destiny+Fortune exceeds load 8, so energy 9/10 is unreachable for a Fortune build.",
  };

  report.isolated = {};
  Object.entries(STACKS).forEach(([key, stack], index) => {
    log(`isolated ${stack.label} ${HANDS_PER_STACK} hands`);
    report.isolated[key] = runIsolatedHands(PRIMARY_SEED + index * 19, stack, HANDS_PER_STACK);
  });

  log("energy grid even/behind");
  report.energyGrid = {
    even: runEnergyGrid(PRIMARY_SEED + 400, STACKS.even, ENERGY_HANDS),
    behind: runEnergyGrid(PRIMARY_SEED + 500, STACKS.behind, ENERGY_HANDS),
  };

  log("sequential debt/experience");
  report.sequential = {
    even: runSequential(PRIMARY_SEED + 600, STACKS.even, SEQ_HANDS),
    behind: runSequential(PRIMARY_SEED + 700, STACKS.behind, SEQ_HANDS),
  };

  log("matches check-down and heuristic");
  report.matches = {
    checkdown: runMatches(PRIMARY_SEED + 800, "checkdown", MATCHES, ["FORTUNE", "RECYCLE"], ["DEEP_BREATH", "RECYCLE"]),
    heuristic: runMatches(PRIMARY_SEED + 810, "heuristic", MATCHES, ["FORTUNE", "RECYCLE"], ["DEEP_BREATH", "RECYCLE"]),
    perceptionCheckdown: runMatches(PRIMARY_SEED + 820, "checkdown", MATCHES, ["PERCEPTION", "RECYCLE"], ["DEEP_BREATH", "RECYCLE"]),
  };

  report.stability = EXTRA_SEEDS.map((seed, index) => {
    log(`stability seed ${seed}`);
    return {
      seed,
      evenCausal: runIsolatedHands(seed, STACKS.even, EXTRA_HANDS, { collectEquity: false }).causalEquity,
      behindRewrite: runIsolatedHands(seed + 3, STACKS.behind, EXTRA_HANDS, { collectEquity: false }).pAtLeast2,
      heuristic: runMatches(seed + 9, "heuristic", EXTRA_MATCHES, ["FORTUNE", "RECYCLE"], ["DEEP_BREATH", "RECYCLE"]).aWinRate,
    };
  });

  report.elapsedMs = Date.now() - started;
  const outPath = path.join(__dirname, "experiments", "validate-fortune-perception-v1.out.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  log(`wrote ${outPath} in ${report.elapsedMs}ms`);
  process.stdout.write(`${JSON.stringify({
    elapsedMs: report.elapsedMs,
    evenDelta: report.isolated.even.causalEquity.mean,
    evenP2: report.isolated.even.pAtLeast2.percentage,
    behindP2: report.isolated.behind.pAtLeast2.percentage,
    truth: report.isolated.even.overallTruth.percentage,
    checkdownWR: report.matches.checkdown.aWinRate.percentage,
    heuristicWR: report.matches.heuristic.aWinRate.percentage,
    outPath,
  }, null, 2)}\n`);
}

main();
