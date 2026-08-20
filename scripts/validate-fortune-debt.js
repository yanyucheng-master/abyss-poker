#!/usr/bin/env node
/**
 * 强运 soft-v1 负债体验验证：真实跨手筹码、Fold Bot、第二技能封锁。
 * 不修改 soft-v1 概率。
 */
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
  getDisadvantageSeverity,
} = require("../game/skills/skillEngine");
const { hasEquipped } = require("../game/skills/skillState");
const { FORTUNE_CONFIG, computeFortuneChance } = require("../game/skills/fortuneConfig");
const {
  decidePublicAction,
  buildPublicView,
  wantsDefense,
  wantsIntel,
  wantsClairvoyance,
  wantsBloodBattle,
} = require("../game/bots/publicFoldPolicy");

const PRIMARY_SEED = 20260820;
const EXTRA_SEEDS = [20260821, 20260822, 20260823];
const START_CHIPS = 1000;
const SMALL_BLIND = 25;
const BIG_BLIND = 50;
const SMOKE = process.env.FD_SMOKE === "1";
const MATCHES = Number(process.env.FD_MATCHES) || (SMOKE ? 40 : 1500);
const EXTRA_MATCHES = Number(process.env.FD_EXTRA) || (SMOKE ? 20 : 400);
const SELF_MATCHES = Number(process.env.FD_SELF) || (SMOKE ? 80 : 1500);
const SEQ_HANDS = Number(process.env.FD_SEQ) || (SMOKE ? 2000 : 12000);
const COMPARE_MATCHES = Number(process.env.FD_COMPARE) || (SMOKE ? 40 : 400);
const MAX_HANDS_PER_MATCH = Number(process.env.FD_MAX_HANDS) || 250;

const CONTROL_B = ["DEEP_BREATH", "BLOOD_BATTLE", "DEFENSE"];
const PROBE_B = ["PERCEPTION", "INTEL_ONE", "RECYCLE"];
const BUILDS = Object.freeze({
  defense: { key: "defense", label: "强运+防守", loadoutA: ["FORTUNE", "DEFENSE"], loadoutB: CONTROL_B },
  perception: { key: "perception", label: "强运+感知", loadoutA: ["FORTUNE", "PERCEPTION"], loadoutB: CONTROL_B },
  intel: { key: "intel", label: "强运+情报", loadoutA: ["FORTUNE", "INTEL_ONE"], loadoutB: CONTROL_B },
  topSecret: { key: "topSecret", label: "强运+绝密", loadoutA: ["FORTUNE", "TOP_SECRET"], loadoutB: PROBE_B },
  clairvoyance: { key: "clairvoyance", label: "强运+灵视", loadoutA: ["FORTUNE", "CLAIRVOYANCE"], loadoutB: CONTROL_B },
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
  if (!n) {
    return {
      n: 0, mean: null, median: null, std: null,
      p50: null, p75: null, p90: null, p95: null, p99: null, min: null, max: null,
    };
  }
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
    p50: round(percentile(sorted, 0.5), 5),
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
  const margin = z * Math.sqrt((p * (p > 1 ? 0 : 1 - p) + z2 / (4 * n)) / n);
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

function rateAtLeast(values, min) {
  if (!values.length) return { n: 0, count: 0, percentage: null };
  const count = values.filter((value) => value >= min).length;
  return wilson(count, values.length);
}

function emptyNodeMap() {
  return { pre_flop: 0, flop: 0, turn: 0, river: 0 };
}

function createRunStats() {
  return {
    matches: 0,
    aWins: 0,
    bWins: 0,
    ties: 0,
    hands: 0,
    folds: 0,
    showdowns: 0,
    raises: 0,
    calls: 0,
    checks: 0,
    pots: [],
    handCounts: [],
    chipDeltas: [],
    finalSpreads: [],
    rewrites: 0,
    matchRewrites: [],
    matchDebtEntries: [],
    debtHandsStart: 0,
    debtHandsAny: 0,
    debtHandsEnd: 0,
    blockedHands: 0,
    legalHands: 0,
    depth: { "0+": 0, "-1": 0, "-2": 0, "-3": 0, "-4": 0 },
    enterNeg4: 0,
    neg4Recoveries: [],
    episodes: [],
    repayLoss: 0,
    repayResource: 0,
    repayOther: 0,
    repayUnits: 0,
    fortuneWhileDebt: 0,
    skill: { legal: 0, wanted: 0, used: 0, debtBlocked: 0, debtLockOnly: 0 },
    perception: {
      facts: 0,
      nodes: emptyNodeMap(),
      skip: emptyNodeMap(),
      factsDebtStart: 0,
      handsDebtStart: 0,
      factsOkStart: 0,
      handsOkStart: 0,
    },
    topSecret: { holeAccess: 0, legalProtect: 0, protected: 0, debtBlocked: 0, leakDueToDebt: 0 },
    defense: { legal: 0, wanted: 0, used: 0, debtBlocked: 0, wouldHaveReducedLoss: 0 },
    holeChances: [],
    chipResetBugs: 0,
    requestIds: 0,
  };
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
    handSeq: 0,
  };
}

function attachTelemetry(engine) {
  if (engine.__debtTelemetryAttached) return engine;
  engine.__debtTelemetryAttached = true;
  const origDealt = engine.onCardsDealt.bind(engine);
  engine.onCardsDealt = function onCardsDealtWithDebt(room, node) {
    const hand = engine.__handStats;
    const hero = room.players[0];
    if (hand && hero && hasEquipped(hero, "PERCEPTION")) {
      hand.perception.nodes[node] += 1;
      hand.skill.legal += 1;
      hand.hadLegal = true;
      if (hero.skillRuntime.abyssEnergy < 0) {
        hand.perception.skip[node] += 1;
        hand.skill.debtBlocked += 1;
        hand.skill.debtLockOnly += 1;
        hand.blocked = true;
      }
    }
    return origDealt(room, node);
  };
  const origSecret = engine.tryActivateTopSecret.bind(engine);
  engine.tryActivateTopSecret = function tryActivateTopSecretWithDebt(room, defender, opts) {
    const hand = engine.__handStats;
    const before = Number(defender?.skillRuntime?.abyssEnergy);
    const already = Boolean(defender?.skillRuntime?.topSecretActive);
    const equipped = hasEquipped(defender, "TOP_SECRET");
    const result = origSecret(room, defender, opts);
    if (hand && equipped && defender?.playerId === "A") {
      hand.topSecret.holeAccess += 1;
      if (!already && before >= 3) {
        hand.topSecret.legalProtect += 1;
        hand.hadLegal = true;
        if (result) hand.topSecret.protected += 1;
      }
      if (!already && before < 0) {
        hand.topSecret.debtBlocked += 1;
        hand.skill.debtBlocked += 1;
        hand.hadLegal = true;
        hand.blocked = true;
        if (!result) hand.topSecret.leakDueToDebt += 1;
      }
    }
    return result;
  };
  return engine;
}

function emptyHandStats() {
  return {
    hadLegal: false,
    blocked: false,
    skill: { legal: 0, wanted: 0, used: 0, debtBlocked: 0, debtLockOnly: 0 },
    perception: { nodes: emptyNodeMap(), skip: emptyNodeMap(), facts: 0 },
    topSecret: { holeAccess: 0, legalProtect: 0, protected: 0, debtBlocked: 0, leakDueToDebt: 0 },
    defense: { legal: 0, wanted: 0, used: 0, debtBlocked: 0 },
    fortuneWhileDebt: 0,
    actions: { fold: 0, call: 0, raise: 0, check: 0 },
  };
}

function tryActiveSkill(engine, room, player, skillId, target, view, wantFn, hand) {
  if (!hasEquipped(player, skillId)) return;
  const runtime = player.skillRuntime;
  const saved = runtime.abyssEnergy;
  runtime.abyssEnergy = Math.max(saved, 8);
  const legal = engine.validateUse(room, player, skillId, target);
  runtime.abyssEnergy = saved;
  if (!legal.ok) return;
  const isHero = player.playerId === "A";
  if (isHero) {
    hand.skill.legal += 1;
    hand.hadLegal = true;
    if (skillId === "DEFENSE") hand.defense.legal += 1;
  }
  if (!wantFn(view)) return;
  if (isHero) {
    hand.skill.wanted += 1;
    if (skillId === "DEFENSE") hand.defense.wanted += 1;
  }
  if (saved < 0) {
    if (isHero) {
      hand.skill.debtBlocked += 1;
      hand.blocked = true;
      if (skillId === "DEFENSE") hand.defense.debtBlocked += 1;
      runtime.abyssEnergy = 0;
      const atZero = engine.validateUse(room, player, skillId, target);
      runtime.abyssEnergy = saved;
      if (atZero.ok) hand.skill.debtLockOnly += 1;
    }
    return;
  }
  engine.__requestSeq = (engine.__requestSeq || 0) + 1;
  const used = engine.requestUse(room, player, {
    skillId,
    target,
    requestId: `debt_${skillId}_${player.playerId}_${engine.__requestSeq}`,
  });
  if (used.ok && used.status !== "FAILED" && isHero) {
    hand.skill.used += 1;
    if (skillId === "DEFENSE") hand.defense.used += 1;
  }
}

function maybeSkills(engine, room, player, view, hand) {
  tryActiveSkill(engine, room, player, "DEFENSE", {}, view, wantsDefense, hand);
  tryActiveSkill(engine, room, player, "INTEL_ONE", { zone: "opponent" }, view, wantsIntel, hand);
  tryActiveSkill(engine, room, player, "CLAIRVOYANCE", {}, view, wantsClairvoyance, hand);
  tryActiveSkill(engine, room, player, "BLOOD_BATTLE", {}, view, wantsBloodBattle, hand);
  tryActiveSkill(engine, room, player, "DEEP_BREATH", {}, view, () => true, hand);
}

function applyDecision(room, player, decision) {
  const toCall = Math.max(0, room.currentBet - player.streetBet);
  if (decision.action === "fold") {
    player.status = "folded";
    if (player.skillRuntime) player.skillRuntime.foldedThisHand = true;
    return "fold";
  }
  if (decision.action === "raise") {
    const raiseTo = Math.max(
      room.currentBet + room.lastRaiseSize,
      Number(decision.size) || room.currentBet + BIG_BLIND,
    );
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

function decideForPlayer(engine, room, player, { toCall, canRaise, betting }) {
  if (betting === "checkdown") {
    if (toCall > 0) return { action: player.chips > 0 ? "call" : "check" };
    return { action: "check" };
  }
  if (betting === "heuristic") {
    const board = room.communityCards || [];
    const made = board.length ? pickBestFive([...(player.cards || []), ...board]) : null;
    const strength = made ? ((made.category || 1) - 1) / 9 : 0.3;
    const potOdds = toCall / Math.max(1, room.pot + toCall);
    if (toCall > 0) {
      if (strength + 0.08 < potOdds && strength < 0.46) return { action: "fold" };
      return { action: "call" };
    }
    return { action: "check" };
  }
  return decidePublicAction(buildPublicView(player, room, {
    toCall,
    canRaise,
    random: engine.random,
  }));
}

function runBettingRound(engine, room, firstIndex, betting, hand) {
  if (room.players.some((player) => player.status === "folded")) return "fold";
  if (room.players.filter((player) => player.status === "active" && !player.isAllIn).length <= 1) {
    return "continue";
  }
  let idx = firstIndex;
  let guard = 0;
  while (!isStreetComplete(room) && guard < 12) {
    guard += 1;
    const player = room.players[idx];
    idx = 1 - idx;
    if (player.status !== "active" || player.isAllIn) continue;
    const toCall = Math.max(0, room.currentBet - player.streetBet);
    const opponent = room.players.find((item) => item.playerId !== player.playerId);
    const canRaise = Boolean(opponent && !opponent.isAllIn && player.chips > toCall);
    room.currentPlayerIndex = room.players.indexOf(player);
    const view = buildPublicView(player, room, { toCall, canRaise, random: engine.random });
    maybeSkills(engine, room, player, view, hand);
    const decision = decideForPlayer(engine, room, player, { toCall, canRaise, betting });
    const result = applyDecision(room, player, decision);
    hand.actions[result] = (hand.actions[result] || 0) + 1;
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
  collectBet(room, sb, Math.min(SMALL_BLIND, sb.chips));
  collectBet(room, bb, Math.min(BIG_BLIND, bb.chips));
  room.currentBet = Math.max(sb.streetBet, bb.streetBet);
}

function attributeRepayment(stats, energyBeforeEnd, lost, resourceHit) {
  if (energyBeforeEnd >= 0) return;
  let energy = energyBeforeEnd;
  const take = (source, amount) => {
    if (energy >= 0 || amount <= 0) return 0;
    const repaid = Math.min(-energy, amount);
    energy += repaid;
    stats[source] += repaid;
    stats.repayUnits += repaid;
    return repaid;
  };
  if (lost) take("repayLoss", SKILL_CONFIG.ENERGY_LOSER_GAIN);
  if (resourceHit) take("repayResource", 1);
  if (energy < 0) {
    /* remaining unpaid this hand */
  }
}

function playHand(engine, room, options = {}) {
  const {
    chipsA = null,
    chipsB = null,
    persistEnergy = true,
    betting = "fold",
    dealerIndex = 0,
    resetChips = false,
  } = options;
  const [playerA, playerB] = room.players;
  const incomingChips = [playerA.chips, playerB.chips];
  if (resetChips) {
    if (chipsA != null) playerA.chips = chipsA;
    if (chipsB != null) playerB.chips = chipsB;
  }
  const chipsAtHandStart = [playerA.chips, playerB.chips];
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
  room.handSeq = (room.handSeq || 0) + 1;
  beginHandSkills(room);
  const energyAtStart = Number(playerA.skillRuntime.abyssEnergy);
  const holeChance = computeFortuneChance("hole", {
    disadvantage: getDisadvantageSeverity(room, playerA),
    energy: energyAtStart,
    energyCap: SKILL_CONFIG.MAX_ABYSS_ENERGY,
  });
  const hand = emptyHandStats();
  engine.__handStats = hand;
  room.deck = shuffle(createDeck(), engine.random);

  for (let hole = 0; hole < 2; hole += 1) {
    room.players.forEach((player) => player.cards.push(room.deck.pop()));
  }

  if (energyAtStart < 0) hand.fortuneWhileDebt += Number((engine.applyHoleFortune(room) || []).length);
  else engine.applyHoleFortune(room);

  let folded = false;
  let foldBy = null;
  if (betting !== "none") postBlinds(room, dealerIndex);
  engine.onCardsDealt(room, "pre_flop");

  if (betting !== "none") {
    room.players.forEach((player) => { player.hasActed = false; });
    const streetResult = runBettingRound(engine, room, dealerIndex, betting, hand);
    if (streetResult === "fold") {
      folded = true;
      foldBy = room.players.find((player) => player.status === "folded")?.playerId || null;
    }
  }

  if (!folded) {
    ["flop", "turn", "river"].forEach((phase) => {
      if (folded) return;
      room.phase = phase;
      const beforeEnergy = Number(playerA.skillRuntime.abyssEnergy);
      const boardHits = engine.applyBoardFortune(room, phase) || [];
      if (beforeEnergy < 0) hand.fortuneWhileDebt += boardHits.length;
      if (phase === "flop") {
        const burned = room.deck.pop();
        if (burned) room.skillState.burnedCards.push(burned);
        room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
      } else {
        room.communityCards.push(engine.applyForkDuringDeal(room));
      }
      engine.onCardsDealt(room, phase);
      if (betting !== "none") {
        room.players.forEach((player) => {
          player.streetBet = 0;
          player.hasActed = false;
        });
        room.currentBet = 0;
        room.lastRaiseSize = BIG_BLIND;
        const first = 1 - dealerIndex;
        const streetResult = runBettingRound(engine, room, first, betting, hand);
        if (streetResult === "fold") {
          folded = true;
          foldBy = room.players.find((player) => player.status === "folded")?.playerId || null;
        }
      }
    });
  }

  let winner = null;
  let tie = false;
  let reason = "showdown";
  let winnerCategory = null;
  if (folded) {
    reason = "fold";
    winner = room.players.find((player) => player.playerId !== foldBy) || null;
  } else {
    const handA = pickBestFive([...(playerA.cards || []), ...room.communityCards]);
    const handB = pickBestFive([...(playerB.cards || []), ...room.communityCards]);
    const cmp = (handA && handB) ? compareEvaluatedHands(handA, handB) : 0;
    if (cmp > 0) {
      winner = playerA;
      winnerCategory = handA?.category ?? null;
    } else if (cmp < 0) {
      winner = playerB;
      winnerCategory = handB?.category ?? null;
    } else tie = true;
  }

  const potSize = room.pot;
  if (!tie && winner) {
    winner.chips += room.pot;
    room.pot = 0;
    engine.applySettlementModifiers(room, { reason, winner, tie: false, winnerCategory });
  } else {
    const share = Math.floor(room.pot / 2);
    playerA.chips += share;
    playerB.chips += room.pot - share;
    room.pot = 0;
  }

  const perceptionFacts = (room.skillState.skillActionLog || []).filter((entry) => (
    entry.skillId === "PERCEPTION" && entry.casterId === playerA.playerId
  )).length;
  hand.perception.facts = perceptionFacts;
  const energyBeforeEnd = Number(playerA.skillRuntime.abyssEnergy);
  const lost = Boolean(winner && winner.playerId !== playerA.playerId && !tie);
  engine.endHand(room, { reason, winner, tie });
  const energyAfter = Number(playerA.skillRuntime.abyssEnergy);
  const resourceHit = (room.skillState.skillActionLog || []).some((entry) => (
    entry.skillId === "FORTUNE"
    && entry.casterId === playerA.playerId
    && entry.energyRecoverySource === "FORTUNE"
  ));
  engine.__handStats = null;

  if (hand.defense.debtBlocked && lost && reason === "showdown") {
    hand.defense.wouldHaveReducedLoss = 1;
  }

  return {
    incomingChips,
    chipsAtHandStart,
    resetChips: Boolean(resetChips),
    energyAtStart,
    energyBeforeEnd,
    energyAfter,
    holeChance,
    disadvantage: getDisadvantageSeverity(room, playerA),
    rewrites: Number(playerA.skillRuntime.fortuneRewriteCount || 0),
    resourceHit,
    lost,
    folded,
    reason,
    winnerId: winner?.playerId || null,
    potSize,
    chipsA: playerA.chips,
    chipsB: playerB.chips,
    hand,
  };
}

function absorbHand(stats, result) {
  stats.hands += 1;
  stats.rewrites += result.rewrites;
  stats.holeChances.push(result.holeChance);
  if (result.folded) stats.folds += 1;
  else stats.showdowns += 1;
  stats.raises += result.hand.actions.raise || 0;
  stats.calls += result.hand.actions.call || 0;
  stats.checks += result.hand.actions.check || 0;
  stats.pots.push(result.potSize);
  if (!result.resetChips && (result.incomingChips[0] !== result.chipsAtHandStart[0] || result.incomingChips[1] !== result.chipsAtHandStart[1])) {
    stats.chipResetBugs += 1;
  }
  if (result.chipsA + result.chipsB !== 2000 && Math.abs(result.chipsA + result.chipsB - 2000) > 1) {
    stats.chipResetBugs += 1;
  }
  if (result.energyAtStart < 0) stats.debtHandsStart += 1;
  if (result.energyAfter < 0 || result.energyAtStart < 0 || result.energyBeforeEnd < 0) stats.debtHandsAny += 1;
  if (result.energyAfter < 0) stats.debtHandsEnd += 1;
  const depthKey = result.energyAfter >= 0 ? "0+" : String(Math.max(-4, Math.round(result.energyAfter)));
  if (stats.depth[depthKey] != null) stats.depth[depthKey] += 1;
  else stats.depth["0+"] += 1;
  stats.fortuneWhileDebt += result.hand.fortuneWhileDebt;
  stats.skill.legal += result.hand.skill.legal;
  stats.skill.wanted += result.hand.skill.wanted;
  stats.skill.used += result.hand.skill.used;
  stats.skill.debtBlocked += result.hand.skill.debtBlocked;
  stats.skill.debtLockOnly += result.hand.skill.debtLockOnly;
  if (result.hand.hadLegal) stats.legalHands += 1;
  if (result.hand.blocked) stats.blockedHands += 1;
  ["pre_flop", "flop", "turn", "river"].forEach((node) => {
    stats.perception.nodes[node] += result.hand.perception.nodes[node];
    stats.perception.skip[node] += result.hand.perception.skip[node];
  });
  stats.perception.facts += result.hand.perception.facts;
  if (result.energyAtStart < 0) {
    stats.perception.handsDebtStart += 1;
    stats.perception.factsDebtStart += result.hand.perception.facts;
  } else {
    stats.perception.handsOkStart += 1;
    stats.perception.factsOkStart += result.hand.perception.facts;
  }
  stats.topSecret.holeAccess += result.hand.topSecret.holeAccess;
  stats.topSecret.legalProtect += result.hand.topSecret.legalProtect;
  stats.topSecret.protected += result.hand.topSecret.protected;
  stats.topSecret.debtBlocked += result.hand.topSecret.debtBlocked;
  stats.topSecret.leakDueToDebt += result.hand.topSecret.leakDueToDebt;
  stats.defense.legal += result.hand.defense.legal;
  stats.defense.wanted += result.hand.defense.wanted;
  stats.defense.used += result.hand.defense.used;
  stats.defense.debtBlocked += result.hand.defense.debtBlocked;
  stats.defense.wouldHaveReducedLoss += result.hand.defense.wouldHaveReducedLoss || 0;
  attributeRepayment(stats, result.energyBeforeEnd, result.lost, result.resourceHit);
}

function closeEpisode(episodes, inDebt, start, index) {
  if (!inDebt) return;
  episodes.push(index - start);
}

function runSequentialFixed(seed, chipsA, chipsB, hands, loadoutA = ["FORTUNE", "PERCEPTION"]) {
  const random = mulberry32(seed);
  const engine = attachTelemetry(new SkillEngine({ random }));
  const playerA = makePlayer("A", "A", loadoutA);
  const playerB = makePlayer("B", "B", CONTROL_B);
  const room = makeRoom(playerA, playerB);
  const stats = createRunStats();
  let inDebt = false;
  let debtStart = 0;
  let atNeg4 = false;
  let neg4Start = 0;
  let prevEnergy = 4;
  for (let i = 0; i < hands; i += 1) {
    const result = playHand(engine, room, {
      chipsA,
      chipsB,
      resetChips: true,
      persistEnergy: true,
      betting: "none",
      dealerIndex: i % 2,
    });
    absorbHand(stats, result);
    if (result.energyAfter < 0) {
      if (!inDebt) {
        inDebt = true;
        debtStart = i;
      }
    } else if (inDebt) {
      closeEpisode(stats.episodes, true, debtStart, i);
      inDebt = false;
    }
    if (result.energyAfter === -4 && prevEnergy !== -4) {
      stats.enterNeg4 += 1;
      atNeg4 = true;
      neg4Start = i;
    }
    if (atNeg4 && result.energyAfter >= 0) {
      stats.neg4Recoveries.push(i - neg4Start);
      atNeg4 = false;
    }
    prevEnergy = result.energyAfter;
  }
  closeEpisode(stats.episodes, inDebt, debtStart, hands);
  if (atNeg4) stats.neg4Recoveries.push(hands - neg4Start);
  stats.matches = 1;
  return stats;
}

function runMatches(seed, {
  matches,
  loadoutA,
  loadoutB,
  betting = "fold",
  maxHands = MAX_HANDS_PER_MATCH,
} = {}) {
  const random = mulberry32(seed);
  const engine = attachTelemetry(new SkillEngine({ random }));
  const stats = createRunStats();
  for (let match = 0; match < matches; match += 1) {
    const playerA = makePlayer("A", "A", loadoutA);
    const playerB = makePlayer("B", "B", loadoutB);
    const room = makeRoom(playerA, playerB);
    playerA.chips = START_CHIPS;
    playerB.chips = START_CHIPS;
    let hand = 0;
    let inDebt = false;
    let debtStart = 0;
    let debtEntries = 0;
    let matchRewrites = 0;
    let atNeg4 = false;
    let neg4Start = 0;
    let prevEnergy = 4;
    const startA = playerA.chips;
    const startB = playerB.chips;
    while (hand < maxHands && playerA.chips > 0 && playerB.chips > 0) {
      const result = playHand(engine, room, {
        persistEnergy: true,
        betting,
        dealerIndex: hand % 2,
        resetChips: false,
      });
      absorbHand(stats, result);
      matchRewrites += result.rewrites;
      if (result.energyAfter < 0) {
        if (!inDebt) {
          inDebt = true;
          debtStart = hand;
          debtEntries += 1;
        }
      } else if (inDebt) {
        stats.episodes.push(hand - debtStart);
        inDebt = false;
      }
      if (result.energyAfter === -4 && prevEnergy !== -4) {
        stats.enterNeg4 += 1;
        atNeg4 = true;
        neg4Start = hand;
      }
      if (atNeg4 && result.energyAfter >= 0) {
        stats.neg4Recoveries.push(hand - neg4Start);
        atNeg4 = false;
      }
      prevEnergy = result.energyAfter;
      hand += 1;
    }
    if (inDebt) stats.episodes.push(hand - debtStart);
    if (atNeg4) stats.neg4Recoveries.push(hand - neg4Start);
    stats.matches += 1;
    stats.handCounts.push(hand);
    stats.matchRewrites.push(matchRewrites);
    stats.matchDebtEntries.push(debtEntries);
    stats.chipDeltas.push(playerA.chips - startA);
    stats.finalSpreads.push(playerA.chips - playerB.chips);
    if (playerA.chips > playerB.chips) stats.aWins += 1;
    else if (playerB.chips > playerA.chips) stats.bWins += 1;
    else stats.ties += 1;
    if (playerA.chips + playerB.chips !== startA + startB && Math.abs(playerA.chips + playerB.chips - (startA + startB)) > 1) {
      stats.chipResetBugs += 1;
    }
  }
  return stats;
}

function summarizeRun(stats, extra = {}) {
  const episodeStats = summarizeNumeric(stats.episodes);
  const repayUnits = Math.max(1, stats.repayUnits);
  return {
    ...extra,
    matches: stats.matches,
    hands: stats.hands,
    aWinRate: wilson(stats.aWins, stats.matches),
    bWinRate: wilson(stats.bWins, stats.matches),
    ties: stats.ties,
    avgHands: round(stats.handCounts.length ? stats.handCounts.reduce((a, b) => a + b, 0) / stats.handCounts.length : 0, 3),
    medianHands: summarizeNumeric(stats.handCounts).median,
    p90Hands: summarizeNumeric(stats.handCounts).p90,
    foldRate: wilson(stats.folds, stats.hands),
    showdownRate: wilson(stats.showdowns, stats.hands),
    avgPot: meanCi(stats.pots),
    avgRaisesPerHand: round(stats.raises / Math.max(1, stats.hands), 4),
    avgFinalSpread: meanCi(stats.finalSpreads),
    avgRewritesPerHand: round(stats.rewrites / Math.max(1, stats.hands), 4),
    avgRewritesPerMatch: meanCi(stats.matchRewrites),
    avgDebtEntriesPerMatch: meanCi(stats.matchDebtEntries),
    debtHandStartRate: wilson(stats.debtHandsStart, stats.hands),
    debtHandAnyRate: wilson(stats.debtHandsAny, stats.hands),
    debtHandEndRate: wilson(stats.debtHandsEnd, stats.hands),
    legalHandRate: wilson(stats.legalHands, stats.hands),
    blockedHandRate: wilson(stats.blockedHands, stats.hands),
    blockedGivenLegal: wilson(stats.blockedHands, Math.max(1, stats.legalHands)),
    depth: Object.fromEntries(Object.entries(stats.depth).map(([key, count]) => [key, wilson(count, stats.hands)])),
    enterNeg4Per100Hands: round((stats.enterNeg4 / Math.max(1, stats.hands)) * 100, 4),
    neg4Recovery: summarizeNumeric(stats.neg4Recoveries),
    episodes: {
      ...episodeStats,
      pGe3: rateAtLeast(stats.episodes, 3),
      pGe5: rateAtLeast(stats.episodes, 5),
      pGe10: rateAtLeast(stats.episodes, 10),
      pGe20: rateAtLeast(stats.episodes, 20),
      pGe30: rateAtLeast(stats.episodes, 30),
      histogram: {
        1: stats.episodes.filter((value) => value === 1).length,
        2: stats.episodes.filter((value) => value === 2).length,
        "3-4": stats.episodes.filter((value) => value >= 3 && value <= 4).length,
        "5-9": stats.episodes.filter((value) => value >= 5 && value <= 9).length,
        "10-19": stats.episodes.filter((value) => value >= 10 && value <= 19).length,
        "20-29": stats.episodes.filter((value) => value >= 20 && value <= 29).length,
        "30+": stats.episodes.filter((value) => value >= 30).length,
      },
    },
    repayment: {
      units: stats.repayUnits,
      lossRecovery: round(stats.repayLoss / repayUnits, 4),
      fortuneResource: round(stats.repayResource / repayUnits, 4),
      other: round(stats.repayOther / repayUnits, 4),
      lossUnits: stats.repayLoss,
      resourceUnits: stats.repayResource,
    },
    fortuneWhileDebt: stats.fortuneWhileDebt,
    skill: {
      ...stats.skill,
      debtBlockedRate: wilson(stats.skill.debtBlocked, Math.max(1, stats.skill.legal)),
      debtBlockedWantedRate: wilson(stats.skill.debtBlocked, Math.max(1, stats.skill.wanted || stats.skill.legal)),
      debtLockOnlyRate: wilson(stats.skill.debtLockOnly, Math.max(1, stats.skill.debtBlocked)),
    },
    perception: {
      factsPerHand: round(stats.perception.facts / Math.max(1, stats.hands), 4),
      factsPerHandDebtStart: round(stats.perception.factsDebtStart / Math.max(1, stats.perception.handsDebtStart), 4),
      factsPerHandOkStart: round(stats.perception.factsOkStart / Math.max(1, stats.perception.handsOkStart), 4),
      skipPer100Hands: Object.fromEntries(Object.entries(stats.perception.skip).map(([node, count]) => [
        node,
        round((count / Math.max(1, stats.hands)) * 100, 4),
      ])),
      skipRate: Object.fromEntries(Object.entries(stats.perception.nodes).map(([node, count]) => [
        node,
        wilson(stats.perception.skip[node], Math.max(1, count)),
      ])),
      nodes: stats.perception.nodes,
      skip: stats.perception.skip,
      facts: stats.perception.facts,
    },
    topSecret: {
      ...stats.topSecret,
      debtBlockedPer100Hands: round((stats.topSecret.debtBlocked / Math.max(1, stats.hands)) * 100, 4),
      leakPer100Hands: round((stats.topSecret.leakDueToDebt / Math.max(1, stats.hands)) * 100, 4),
    },
    defense: {
      ...stats.defense,
      debtBlockedRate: wilson(stats.defense.debtBlocked, Math.max(1, stats.defense.legal)),
      wantedBlockedRate: wilson(stats.defense.debtBlocked, Math.max(1, stats.defense.wanted)),
    },
    avgHoleChance: meanCi(stats.holeChances),
    chipResetBugs: stats.chipResetBugs,
  };
}

function mergeStats(target, source) {
  const skip = new Set(["depth", "perception", "topSecret", "defense", "skill"]);
  Object.keys(source).forEach((key) => {
    if (Array.isArray(source[key])) {
      target[key].push(...source[key]);
      return;
    }
    if (source[key] && typeof source[key] === "object") return;
    if (typeof source[key] === "number") target[key] += source[key];
  });
  Object.keys(source.depth).forEach((key) => { target.depth[key] += source.depth[key]; });
  Object.keys(source.skill).forEach((key) => { target.skill[key] += source.skill[key]; });
  Object.keys(source.topSecret).forEach((key) => { target.topSecret[key] += source.topSecret[key]; });
  Object.keys(source.defense).forEach((key) => { target.defense[key] += source.defense[key]; });
  ["nodes", "skip"].forEach((mapKey) => {
    Object.keys(source.perception[mapKey]).forEach((node) => {
      target.perception[mapKey][node] += source.perception[mapKey][node];
    });
  });
  ["facts", "factsDebtStart", "handsDebtStart", "factsOkStart", "handsOkStart"].forEach((key) => {
    target.perception[key] += source.perception[key];
  });
  return target;
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function main() {
  const started = Date.now();
  log(`validate-fortune-debt starting matches=${MATCHES} extra=${EXTRA_MATCHES} self=${SELF_MATCHES}`);
  const report = {
    seed: PRIMARY_SEED,
    extraSeeds: EXTRA_SEEDS,
    sampleSizes: { MATCHES, EXTRA_MATCHES, SELF_MATCHES, SEQ_HANDS, COMPARE_MATCHES, MAX_HANDS_PER_MATCH },
    production: {
      fortune: { status: FORTUNE_CONFIG.status, variant: FORTUNE_CONFIG.variant },
      perception: { status: PERCEPTION_CONFIG.status, variant: PERCEPTION_CONFIG.variant },
    },
    implementation: {
      chipsPersist: true,
      fortuneUsesLiveDisadvantage: true,
      foldPolicy: "public-only chen + vs-random MC",
    },
  };

  log("fixed-chip sequential even/behind (old method, for contrast)");
  report.fixedSequential = {
    even: summarizeRun(runSequentialFixed(PRIMARY_SEED + 11, 1000, 1000, SEQ_HANDS), { stack: "even" }),
    behind: summarizeRun(runSequentialFixed(PRIMARY_SEED + 13, 400, 1600, SEQ_HANDS), { stack: "behind" }),
  };

  log("bot self-check identical constructs");
  report.selfCheck = {
    recycleBreath: summarizeRun(runMatches(PRIMARY_SEED + 21, {
      matches: SELF_MATCHES,
      loadoutA: ["DEEP_BREATH", "RECYCLE"],
      loadoutB: ["DEEP_BREATH", "RECYCLE"],
    }), { label: "深呼吸+回收 vs 同构筑" }),
    fortunePerceptionMirror: summarizeRun(runMatches(PRIMARY_SEED + 22, {
      matches: SELF_MATCHES,
      loadoutA: ["FORTUNE", "PERCEPTION"],
      loadoutB: ["FORTUNE", "PERCEPTION"],
    }), { label: "强运+感知 vs 同构筑" }),
  };

  log("strategy contrast check-down / old heuristic / fold");
  report.strategyContrast = {
    checkdown: summarizeRun(runMatches(PRIMARY_SEED + 31, {
      matches: COMPARE_MATCHES,
      loadoutA: ["FORTUNE", "PERCEPTION"],
      loadoutB: CONTROL_B,
      betting: "checkdown",
    }), { betting: "checkdown" }),
    heuristic: summarizeRun(runMatches(PRIMARY_SEED + 32, {
      matches: COMPARE_MATCHES,
      loadoutA: ["FORTUNE", "PERCEPTION"],
      loadoutB: CONTROL_B,
      betting: "heuristic",
    }), { betting: "heuristic" }),
    fold: summarizeRun(runMatches(PRIMARY_SEED + 33, {
      matches: COMPARE_MATCHES,
      loadoutA: ["FORTUNE", "PERCEPTION"],
      loadoutB: CONTROL_B,
      betting: "fold",
    }), { betting: "fold" }),
  };

  report.builds = {};
  const pooledEpisodes = [];
  const pooledDepth = { "0+": 0, "-1": 0, "-2": 0, "-3": 0, "-4": 0 };
  let pooledHands = 0;
  Object.values(BUILDS).forEach((build, index) => {
    log(`primary ${build.label} ${MATCHES} matches`);
    const primary = runMatches(PRIMARY_SEED + 100 + index * 17, {
      matches: MATCHES,
      loadoutA: build.loadoutA,
      loadoutB: build.loadoutB,
    });
    const merged = primary;
    EXTRA_SEEDS.forEach((seed, extraIndex) => {
      log(`extra seed ${seed} ${build.label} ${EXTRA_MATCHES} matches`);
      mergeStats(merged, runMatches(seed + extraIndex * 3 + index * 29, {
        matches: EXTRA_MATCHES,
        loadoutA: build.loadoutA,
        loadoutB: build.loadoutB,
      }));
    });
    pooledEpisodes.push(...merged.episodes);
    Object.keys(pooledDepth).forEach((key) => { pooledDepth[key] += merged.depth[key]; });
    pooledHands += merged.hands;
    report.builds[build.key] = summarizeRun(merged, {
      label: build.label,
      loadoutA: build.loadoutA,
      loadoutB: build.loadoutB,
    });
  });
  report.pooledDebt = {
    hands: pooledHands,
    episodes: {
      ...summarizeNumeric(pooledEpisodes),
      pGe3: rateAtLeast(pooledEpisodes, 3),
      pGe5: rateAtLeast(pooledEpisodes, 5),
      pGe10: rateAtLeast(pooledEpisodes, 10),
      pGe20: rateAtLeast(pooledEpisodes, 20),
      pGe30: rateAtLeast(pooledEpisodes, 30),
      histogram: {
        1: pooledEpisodes.filter((value) => value === 1).length,
        2: pooledEpisodes.filter((value) => value === 2).length,
        "3-4": pooledEpisodes.filter((value) => value >= 3 && value <= 4).length,
        "5-9": pooledEpisodes.filter((value) => value >= 5 && value <= 9).length,
        "10-19": pooledEpisodes.filter((value) => value >= 10 && value <= 19).length,
        "20-29": pooledEpisodes.filter((value) => value >= 20 && value <= 29).length,
        "30+": pooledEpisodes.filter((value) => value >= 30).length,
      },
    },
    depth: Object.fromEntries(Object.entries(pooledDepth).map(([key, count]) => [key, {
      count,
      percentage: round(count / Math.max(1, pooledHands), 4),
    }])),
  };

  report.elapsedMs = Date.now() - started;
  const outPath = path.join(__dirname, "experiments", "validate-fortune-debt.out.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  log(`wrote ${outPath} in ${report.elapsedMs}ms`);
  process.stdout.write(`${JSON.stringify({
    elapsedMs: report.elapsedMs,
    selfA: report.selfCheck.recycleBreath.aWinRate,
    perceptionFacts: report.builds.perception.perception.factsPerHand,
    defenseDebtHands: report.builds.defense.blockedHandRate,
    episodes: report.builds.perception.episodes,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  PRIMARY_SEED,
  playHand,
  runMatches,
  runSequentialFixed,
  makePlayer,
  makeRoom,
  attachTelemetry,
  summarizeRun,
  BUILDS,
  CONTROL_B,
  mulberry32,
};
