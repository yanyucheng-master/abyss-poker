#!/usr/bin/env node
/**
 * Loan + Fairness 超模归因实验。
 * 正式技能规则不变。实验开关只通过 SkillEngine.experiment 传入。
 *
 *   node scripts/simulate-loan-fairness-ablation.js
 *   ABLATION_MATCHES=2000 ABLATION_HEAVY=10000 node scripts/simulate-loan-fairness-ablation.js
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const { createDeck } = require("../utils/deck");
const { pickBestFive, compareEvaluatedHands } = require("../game/handEvaluator");
const { SKILL_MODE } = require("../game/skillModes");
const { SKILL_CONFIG } = require("../game/skillConfig");
const { collectBet, isStreetComplete, otherIndex } = require("../game/pokerLogic");
const {
  SkillEngine,
  setPlayerLoadout,
  beginHandSkills,
  initPlayerForSkillMode,
  onStreetPhaseChanged,
  onPlayerFolded,
} = require("../game/skills/skillEngine");
const { getSkillDefinition } = require("../game/skills/definitions");
const { pickDefaultBotLoadout, validateLoadout } = require("../game/skills/skillState");

const SEED = Number(process.env.ABLATION_SEED || 20260821);
const MATCHES = Math.max(40, Number(process.env.ABLATION_MATCHES || 2000));
const HEAVY = Math.max(MATCHES, Number(process.env.ABLATION_HEAVY || 10000));
const MAX_HANDS = Number(process.env.ABLATION_MAX_HANDS || 80);
const START_CHIPS = 1000;
const SMALL_BLIND = 25;
const BIG_BLIND = 50;
const TOTAL_CHIPS = START_CHIPS * 2;
const IRREVERSIBLE = new Set(["CHEAT", "DESTINY", "RESTART", "INTEL_ONE"]);
const PASSIVES = new Set(["FORTUNE", "PERCEPTION", "DESPERATION", "ALERT", "RECYCLE"]);

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

function wilson(count, n, z = 1.96) {
  if (!n) return { n: 0, count: 0, percentage: null, low: null, high: null };
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

function shuffle(deck, random) {
  const values = deck.slice();
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function nameOf(id) {
  return getSkillDefinition(id)?.name || id;
}

function labelOf(ids) {
  return ids.map(nameOf).join(" + ") || "无技能";
}

function fileHash(rel) {
  const abs = path.join(__dirname, "..", rel);
  return crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex").slice(0, 12);
}

function gitHead() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: path.join(__dirname, ".."), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
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
  const counts = suits.reduce((map, suit) => {
    map[suit] = (map[suit] || 0) + 1;
    return map;
  }, {});
  if (Math.max(0, ...Object.values(counts)) >= 4) score += 0.08;
  return Math.max(0.05, Math.min(0.96, score));
}

function decideHeuristic(player, room, { toCall, canRaise }) {
  const strength = postflopStrength(player.cards, room.communityCards);
  const potOdds = toCall / Math.max(1, room.pot + toCall);
  if (toCall > 0) {
    if (strength + 0.08 < potOdds && strength < 0.46) return { action: "fold" };
    if (strength >= 0.74 && canRaise) {
      return {
        action: "raise",
        size: Math.min(player.chips + player.streetBet, Math.max(room.currentBet * 2, Math.floor(room.pot * 0.8))),
      };
    }
    return { action: "call" };
  }
  if (strength >= 0.64 && canRaise) {
    const raiseTo = Math.min(
      player.chips + player.streetBet,
      Math.max(BIG_BLIND, Math.floor(Math.max(room.pot, BIG_BLIND) * 0.7)),
    );
    if (raiseTo > room.currentBet) return { action: "raise", size: raiseTo };
  }
  return { action: "check" };
}

function opponentOf(room, player) {
  return room.players.find((item) => item.playerId !== player.playerId) || null;
}

function sideOf(player) {
  return player.playerId === "HERO" ? "hero" : "vill";
}

function equippedSet(player) {
  return new Set(player.skillRuntime?.equippedSkillIds || []);
}

function pendingChipLoans(player) {
  return (player.skillRuntime?.chipLoans || []).length;
}

function pendingEnergyLoan(player) {
  return Boolean(player.skillRuntime?.energyLoan);
}

function opponentPersistents(room, opponent) {
  const runtime = opponent?.skillRuntime || {};
  return Boolean(
    runtime.bloodBattleActive
    || runtime.defenseActive
    || runtime.counterArmed
    || runtime.retreatActive
    || runtime.probeActive
    || runtime.disguiseActive
    || runtime.deadEndActive
    || runtime.topSecretActive
    || runtime.desperationActive
    || (room.skillState?.nullifications || []).length,
  );
}

function isLocked(room, player) {
  return Boolean(room.skillState?.fairnessActive || player.skillRuntime?.lockedThisHand);
}

function lastSkillAudit(room, skillId) {
  const log = room.skillState?.skillActionLog || [];
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i].skillId === skillId) return log[i].audit || {};
  }
  return {};
}

function emptyStats() {
  return {
    chipLoans: 0,
    energyLoans: 0,
    chipTaken: 0,
    fairness: 0,
    fairnessFail: 0,
    loanKills: 0,
    chipRepayCleared: 0,
    energyRepayCleared: 0,
    persistentsCleared: 0,
    heroDeniedActive: 0,
    villDeniedActive: 0,
    heroDeniedPassive: 0,
    villDeniedPassive: 0,
    counterArmed: 0,
    loanCountered: 0,
    fairnessCountered: 0,
    villFactsBeforeFairness: 0,
    handsWithVillFactThenFair: 0,
    conservationFails: 0,
    energySum: 0,
    energySamples: 0,
    chipSum: 0,
    chipSamples: 0,
    reasons: {},
  };
}

function makePlayer(id, name, loadout, policy) {
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
    __policy: policy || {},
  };
  initPlayerForSkillMode(player, SKILL_MODE.ABYSS);
  if (!loadout.length) {
    player.skillRuntime.equippedSkillIds = [];
    player.skillRuntime.loadoutConfirmed = true;
    player.skillRuntime.invalidBuild = false;
    return player;
  }
  const loaded = setPlayerLoadout(player, loadout);
  if (!loaded.ok) throw new Error(`${id} 非法构筑 ${loadout.join(",")}: ${loaded.error}`);
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
    smallBlind: SMALL_BLIND,
    bigBlind: BIG_BLIND,
    pot: 0,
    handNo: 0,
  };
}

function totalChips(room) {
  return room.players.reduce((sum, player) => sum + Math.max(0, Number(player.chips) || 0), 0) + (Number(room.pot) || 0);
}

function noteDeniedPassive(room, stats) {
  room.players.forEach((player) => {
    if (!isLocked(room, player)) return;
    const equipped = equippedSet(player);
    const key = `${sideOf(player)}DeniedPassive`;
    PASSIVES.forEach((id) => {
      if (equipped.has(id)) stats[key] += 1;
    });
  });
}

function tryUse(engine, room, player, skillId, target, stats, handCtx) {
  if (isLocked(room, player)) {
    stats[`${sideOf(player)}DeniedActive`] += 1;
    return { ok: false, denied: true };
  }
  room.currentPlayerIndex = room.players.findIndex((item) => item.playerId === player.playerId);
  const result = engine.requestUse(room, player, {
    skillId,
    target,
    requestId: `${skillId}-${room.handNo}-${player.playerId}-${Math.floor(engine.random() * 1e9)}`,
  });
  if (result?.status === "COUNTERED") {
    if (skillId === "LOAN") stats.loanCountered += 1;
    if (skillId === "FAIRNESS") stats.fairnessCountered += 1;
    return result;
  }
  if (result?.ok && result.status === "SUCCESS") {
    if (skillId === "LOAN") {
      if (String(target.mode) === "chip") stats.chipLoans += 1;
      if (String(target.mode) === "energy") stats.energyLoans += 1;
    }
    if (skillId === "FAIRNESS") {
      stats.fairness += 1;
      const audit = lastSkillAudit(room, "FAIRNESS");
      const heroRow = (audit.loanAudit || []).find((row) => row.playerId === "HERO");
      stats.chipRepayCleared += Number(heroRow?.chipRepay) || 0;
      stats.energyRepayCleared += Number(heroRow?.energyRepay) || 0;
      stats.persistentsCleared += Number(audit.persistentsCleared) || 0;
      if (handCtx) {
        handCtx.fairnessDone = true;
        if (handCtx.villFact) stats.handsWithVillFactThenFair += 1;
      }
    }
    if (skillId === "COUNTER") stats.counterArmed += 1;
    if (IRREVERSIBLE.has(skillId) && player.playerId === "VILL" && handCtx && !handCtx.fairnessDone) {
      stats.villFactsBeforeFairness += 1;
      handCtx.villFact = true;
    }
  }
  return result;
}

function energyCapFor(player) {
  return (player.skillRuntime?.equippedSkillIds || []).includes("DESTINY")
    ? SKILL_CONFIG.DESTINY_MAX_ABYSS_ENERGY
    : SKILL_CONFIG.MAX_ABYSS_ENERGY;
}

function projectedEnergy(player, policy, chipCount) {
  let energy = Number(player.skillRuntime.abyssEnergy) || 0;
  const need = (policy.fairness ? 3 : 0) + 2 * chipCount;
  if (policy.energyLoan && energy >= 2 && energy < need) {
    energy = Math.min(energyCapFor(player), energy - 2 + SKILL_CONFIG.LOAN_ENERGY_GAIN);
  }
  return energy;
}

function chipsToTake(player, opponent, policy) {
  if (!policy.chipLoan || opponent.chips <= 0) return 0;
  const rule = SKILL_CONFIG.LOAN_CHIP_MAX_USES_PER_HAND;
  const cap = Math.min(rule, Number(policy.chipLoanMax || rule));
  if (pendingChipLoans(player) > 0 && !policy.stackLoans && cap <= 1) return 0;
  if (policy.chipOnlyKill) return opponent.chips <= SKILL_CONFIG.LOAN_CHIP_TAKE * cap ? cap : 0;
  if (policy.chipIfShort && opponent.chips > 250 && player.chips > 250) return 0;
  if (!policy.fairness) return policy.spamLoan ? cap : Math.min(1, cap);
  for (let count = cap; count >= 1; count -= 1) {
    if (projectedEnergy(player, policy, count) >= 2 * count + 3) return count;
  }
  return projectedEnergy(player, policy, 1) >= 2 ? 1 : 0;
}

function wantFairnessNow(policy, player, room, opponent, afterLoan) {
  if (!policy.fairness || !equippedSet(player).has("FAIRNESS")) return false;
  const style = policy.fairnessStyle || "afterLoan";
  if (style === "asap") return true;
  if (style === "ifPersistents") return opponentPersistents(room, opponent);
  if (style === "ifDebtOrPersistents") {
    return pendingChipLoans(player) > 0 || pendingEnergyLoan(player) || opponentPersistents(room, opponent);
  }
  return afterLoan && (pendingChipLoans(player) > 0 || pendingEnergyLoan(player) || policy.fairnessAlways);
}

function applyPolicySkills(engine, room, player, ctx, stats, handCtx) {
  const policy = player.__policy || {};
  const equipped = equippedSet(player);
  const opponent = opponentOf(room, player);
  if (!opponent) return null;
  const energy = () => Number(player.skillRuntime.abyssEnergy) || 0;

  if (policy.armCounter && equipped.has("COUNTER") && room.phase === "pre_flop" && energy() >= 4) {
    tryUse(engine, room, player, "COUNTER", {}, stats, handCtx);
  }

  if (wantFairnessNow(policy, player, room, opponent, false) && (policy.fairnessStyle === "asap") && energy() >= 3) {
    const used = tryUse(engine, room, player, "FAIRNESS", {}, stats, handCtx);
    if (!used?.ok || used.status !== "SUCCESS") stats.fairnessFail += 1;
  }

  const chipCount = chipsToTake(player, opponent, policy);
  if (policy.energyLoan && equipped.has("LOAN") && energy() >= 2 && !isLocked(room, player)) {
    const needAfter = (policy.fairness ? 3 : 0) + 2 * chipCount;
    const afterLoan = Math.min(energyCapFor(player), energy() - 2 + SKILL_CONFIG.LOAN_ENERGY_GAIN);
    const mustBridge = energy() < needAfter && afterLoan >= needAfter;
    const energyFairLoop = Boolean(policy.fairness && !policy.chipLoan && energy() < 7);
    if (mustBridge || energyFairLoop || (policy.energyLoanBelow && energy() < policy.energyLoanBelow)) {
      tryUse(engine, room, player, "LOAN", { mode: "energy" }, stats, handCtx);
    }
  }

  if (equipped.has("LOAN") && chipCount > 0) {
    for (let i = 0; i < chipCount; i += 1) {
      if (opponent.chips <= 0 || isLocked(room, player)) break;
      const before = opponent.chips;
      const used = tryUse(engine, room, player, "LOAN", { mode: "chip" }, stats, handCtx);
      if (!(used?.ok && used.status === "SUCCESS")) break;
      stats.chipTaken += Math.max(0, before - opponent.chips);
      if (opponent.chips <= 0) {
        stats.loanKills += 1;
        return "loan_kill";
      }
    }
  }

  if (wantFairnessNow(policy, player, room, opponent, true) && energy() >= 3 && !isLocked(room, player)) {
    const used = tryUse(engine, room, player, "FAIRNESS", {}, stats, handCtx);
    if (!(used?.ok && used.status === "SUCCESS")) stats.fairnessFail += 1;
  }

  if (policy.useRestart && equipped.has("RESTART") && energy() >= 3) {
    tryUse(engine, room, player, "RESTART", {}, stats, handCtx);
  }
  if (policy.useIntel && equipped.has("INTEL_ONE") && energy() >= 4) {
    tryUse(engine, room, player, "INTEL_ONE", { zone: "opponent" }, stats, handCtx);
  }
  if (policy.useCheat && equipped.has("CHEAT") && energy() >= 6 && player.cards.length === 2) {
    const ownIndex = (player.cards[0].value || 0) <= (player.cards[1].value || 0) ? 0 : 1;
    tryUse(engine, room, player, "CHEAT", { ownIndex, zone: "deck_random" }, stats, handCtx);
  }
  if (policy.useDestiny && equipped.has("DESTINY") && room.phase === "turn" && room.deck.length && energy() >= 7) {
    const pick = room.deck.reduce((best, card) => (!best || card.value > best.value ? card : best), null);
    if (pick) tryUse(engine, room, player, "DESTINY", { cardCode: pick.code }, stats, handCtx);
  }
  if (policy.useNullify && equipped.has("NULLIFICATION") && ["flop", "turn", "river"].includes(room.phase) && energy() >= 6) {
    tryUse(engine, room, player, "NULLIFICATION", { mode: "board", boardIndex: 0 }, stats, handCtx);
  }

  if (policy.baselineSkills) {
    const values = (player.cards || []).map((card) => Number(card?.value) || 0);
    const strong =
      player.cards.length === 2
      && (player.cards[0].rank === player.cards[1].rank
        || values.filter((value) => value >= 10).length === 2
        || Math.max(...values) >= 14);
    const order = strong
      ? ["BLOOD_BATTLE", "DEFENSE", "DEEP_BREATH"]
      : ["DEFENSE", "DEEP_BREATH", "BLOOD_BATTLE"];
    for (const skillId of order) {
      if (!equipped.has(skillId)) continue;
      if (tryUse(engine, room, player, skillId, {}, stats, handCtx)?.ok) break;
    }
    if (equipped.has("INTIMIDATION") && energy() >= 4) {
      tryUse(engine, room, player, "INTIMIDATION", {}, stats, handCtx);
    }
  }

  const retreatSpot = policy.retreatFold && equipped.has("RETREAT") && (
    ctx.wouldFold || (Number(ctx.toCall) || 0) >= (policy.retreatToCall || 80)
  );
  if (retreatSpot) {
    const armed = tryUse(engine, room, player, "RETREAT", {}, stats, handCtx);
    if (armed?.ok && armed.status === "SUCCESS") return "retreat_ready";
  }
  return null;
}

function applyDecision(room, player, decision) {
  const toCall = Math.max(0, room.currentBet - player.streetBet);
  if (decision.action === "fold") {
    player.status = "folded";
    onPlayerFolded(player);
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

function settleRetreat(engine, room, folder, stats) {
  room.players.forEach((player) => {
    const returned = Math.max(0, Number(player.totalBet) || 0);
    player.chips += returned;
    player.totalBet = 0;
    player.streetBet = 0;
  });
  room.pot = 0;
  if (folder.skillRuntime) folder.skillRuntime.retreatTriggered = true;
  engine.endHand(room, { reason: "retreat", winner: null, tie: true });
  stats.reasons.retreat = (stats.reasons.retreat || 0) + 1;
}

function settleLoanKill(engine, room, winner, loser, stats) {
  winner.chips += room.pot;
  room.pot = 0;
  loser.chips = 0;
  loser.status = "out";
  engine.endHand(room, { reason: "loan_kill", winner, tie: false });
  stats.reasons.loan_kill = (stats.reasons.loan_kill || 0) + 1;
}

function settleFold(engine, room, stats) {
  const winner = room.players.find((player) => player.status === "active");
  if (!winner) return;
  winner.chips += room.pot;
  room.pot = 0;
  engine.applySettlementModifiers(room, { reason: "fold", winner, tie: false, foldOrigin: "user" });
  engine.endHand(room, { reason: "fold", winner, tie: false });
  stats.reasons.fold = (stats.reasons.fold || 0) + 1;
}

function evaluateHand(engine, room, player) {
  return pickBestFive([...(player.cards || []), ...(room.communityCards || [])], {
    excludedCodes: engine.getNullifiedSet(room, player),
  });
}

function settleShowdown(engine, room, stats) {
  const alive = room.players.filter((player) => player.status === "active");
  if (alive.length === 2) {
    const high = alive[0].totalBet > alive[1].totalBet ? alive[0] : alive[1];
    const excess = Math.abs(alive[0].totalBet - alive[1].totalBet);
    if (excess > 0) {
      high.chips += excess;
      high.totalBet -= excess;
      high.streetBet = Math.max(0, high.streetBet - excess);
      room.pot = Math.max(0, room.pot - excess);
    }
  }
  const ranked = alive.map((player) => ({ player, hand: evaluateHand(engine, room, player) }))
    .filter((entry) => entry.hand)
    .sort((a, b) => compareEvaluatedHands(b.hand, a.hand));
  const pot = room.pot;
  if (!ranked.length) {
    alive.forEach((player) => {
      player.chips += Math.floor(pot / Math.max(1, alive.length));
    });
    room.pot = 0;
    engine.endHand(room, { reason: "showdown", winner: null, tie: true });
    stats.reasons.tie = (stats.reasons.tie || 0) + 1;
    return;
  }
  const tie = ranked.length > 1 && compareEvaluatedHands(ranked[0].hand, ranked[1].hand) === 0;
  if (tie) {
    const share = Math.floor(pot / ranked.length);
    ranked.forEach((entry) => { entry.player.chips += share; });
    room.pot = 0;
    engine.endHand(room, { reason: "showdown", winner: null, tie: true });
    stats.reasons.tie = (stats.reasons.tie || 0) + 1;
    return;
  }
  const winner = ranked[0].player;
  winner.chips += pot;
  room.pot = 0;
  engine.applySettlementModifiers(room, {
    reason: "showdown",
    winner,
    tie: false,
    winnerCategory: ranked[0].hand.category,
  });
  engine.endHand(room, { reason: "showdown", winner, tie: false });
  stats.reasons.showdown = (stats.reasons.showdown || 0) + 1;
}

function dealStreet(engine, room, phase, stats) {
  room.phase = phase;
  onStreetPhaseChanged(room, phase);
  room.players.forEach((player) => {
    player.streetBet = 0;
    player.hasActed = false;
  });
  room.currentBet = 0;
  room.lastRaiseSize = BIG_BLIND;
  if (["flop", "turn", "river"].includes(phase)) {
    noteDeniedPassive(room, stats);
    engine.applyBoardFortune(room, phase);
  }
  if (phase === "flop") {
    const burned = room.deck.pop();
    if (burned) room.skillState.burnedCards.push(burned);
    room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
  } else {
    const card = engine.applyForkDuringDeal(room);
    if (card) room.communityCards.push(card);
  }
  room.currentPlayerIndex = otherIndex(room.dealerIndex);
  noteDeniedPassive(room, stats);
  engine.onCardsDealt(room, phase);
}

function runBetting(engine, room, stats, handCtx) {
  let idx = room.currentPlayerIndex;
  let guard = 0;
  while (!isStreetComplete(room) && guard < 24) {
    guard += 1;
    const player = room.players[idx];
    idx = 1 - idx;
    if (!player || player.status !== "active" || player.isAllIn) continue;
    room.currentPlayerIndex = room.players.findIndex((item) => item.playerId === player.playerId);
    engine.onBettingDecisionStart?.(room, player);
    const toCall = Math.max(0, room.currentBet - player.streetBet);
    const opponent = opponentOf(room, player);
    const canRaise = Boolean(opponent && !opponent.isAllIn && player.chips > toCall);
    const heuristic = decideHeuristic(player, room, { toCall, canRaise });
    const skillHalt = applyPolicySkills(engine, room, player, { wouldFold: heuristic.action === "fold", toCall }, stats, handCtx);
    if (skillHalt === "loan_kill") {
      settleLoanKill(engine, room, player, opponent, stats);
      return "loan_kill";
    }
    if (opponent.chips <= 0) {
      settleLoanKill(engine, room, player, opponent, stats);
      return "loan_kill";
    }
    if (skillHalt === "retreat_ready") {
      settleRetreat(engine, room, player, stats);
      return "retreat";
    }
    const result = applyDecision(room, player, heuristic);
    if (result === "fold") {
      settleFold(engine, room, stats);
      return "fold";
    }
  }
  return "continue";
}

function playHand(engine, room, stats, seatMode, hero) {
  const [playerA, playerB] = room.players;
  if (playerA.chips <= 0 || playerB.chips <= 0) return "over";
  room.handNo += 1;
  room.players.forEach((player) => {
    player.cards = [];
    player.status = "active";
    player.isAllIn = false;
    player.hasActed = false;
    player.streetBet = 0;
    player.totalBet = 0;
  });
  room.communityCards = [];
  room.phase = "pre_flop";
  room.pot = 0;
  beginHandSkills(room);
  engine.prepareDeckForHand(room);
  room.deck = shuffle(createDeck(), engine.random);
  for (let i = 0; i < 2; i += 1) {
    room.players.forEach((player) => player.cards.push(room.deck.pop()));
  }
  noteDeniedPassive(room, stats);
  engine.applyHoleFortune(room);
  engine.onCardsDealt(room, "pre_flop");

  stats.energySum += Number(hero.skillRuntime?.abyssEnergy) || 0;
  stats.energySamples += 1;
  stats.chipSum += Number(hero.chips) || 0;
  stats.chipSamples += 1;

  const sb = room.players[room.dealerIndex];
  const bb = room.players[1 - room.dealerIndex];
  const stack = Math.min(sb.chips, bb.chips);
  collectBet(room, sb, Math.min(SMALL_BLIND, stack));
  collectBet(room, bb, Math.min(BIG_BLIND, stack));
  room.currentBet = Math.max(sb.streetBet, bb.streetBet);
  room.lastRaiseSize = BIG_BLIND;
  room.currentPlayerIndex = room.dealerIndex;

  const handCtx = { fairnessDone: false, villFact: false };
  let street = runBetting(engine, room, stats, handCtx);
  if (street !== "continue") return street;

  for (const phase of ["flop", "turn", "river"]) {
    if (room.players.some((player) => player.status === "folded" || player.chips <= 0)) break;
    dealStreet(engine, room, phase, stats);
    const alive = room.players.filter((player) => player.status === "active");
    const needBet = alive.filter((player) => !player.isAllIn).length >= 1 && alive.length === 2;
    if (needBet && alive.some((player) => !player.isAllIn)) {
      street = runBetting(engine, room, stats, handCtx);
      if (street !== "continue") return street;
    }
  }
  settleShowdown(engine, room, stats);
  return "showdown";
}

function playMatch(heroLoadout, villainLoadout, heroPolicy, villainPolicy, random, heroSeat, experiment, seatMode) {
  const engine = new SkillEngine({ random, experiment });
  const hero = makePlayer("HERO", "Hero", heroLoadout, heroPolicy);
  const villain = makePlayer("VILL", "Villain", villainLoadout, villainPolicy);
  const ordered = heroSeat === 0 ? [hero, villain] : [villain, hero];
  const room = makeRoom(ordered[0], ordered[1]);
  const stats = emptyStats();
  let hands = 0;
  while (hands < MAX_HANDS && hero.chips > 0 && villain.chips > 0) {
    if (seatMode === "heroFirstSkill") room.dealerIndex = room.players.findIndex((item) => item.playerId === "HERO");
    else if (seatMode === "heroSecondSkill") room.dealerIndex = room.players.findIndex((item) => item.playerId === "VILL");
    else room.dealerIndex = hands % 2;
    playHand(engine, room, stats, seatMode, hero);
    hands += 1;
    if (Math.abs(totalChips(room) - TOTAL_CHIPS) > 1) stats.conservationFails += 1;
  }
  const heroWin = hero.chips > 0 && villain.chips <= 0;
  const villainWin = villain.chips > 0 && hero.chips <= 0;
  return {
    winner: heroWin ? "hero" : villainWin ? "villain" : "timeout",
    chipLead: hero.chips > villain.chips ? "hero" : villain.chips > hero.chips ? "villain" : "tie",
    hands,
    heroChips: hero.chips,
    villainChips: villain.chips,
    stats,
  };
}

function runSeries(spec) {
  const {
    id,
    name,
    hero,
    villain,
    heroPolicy,
    villainPolicy,
    matches,
    seed,
    experiment = { loanCreditRestrictionV2: false },
    seatMode = "mirror",
  } = spec;
  const pairs = Math.max(1, Math.floor(matches / 2));
  let heroWins = 0;
  let villainWins = 0;
  let timeouts = 0;
  let chipLeads = 0;
  let hands = 0;
  let chipDiff = 0;
  let factMatches = 0;
  let factWins = 0;
  let factDecided = 0;
  const agg = emptyStats();
  const seatWins = [0, 0];
  const seatDecided = [0, 0];

  const games = seatMode === "mirror" ? pairs * 2 : matches;
  for (let i = 0; i < games; i += 1) {
    const pairSeed = seed + Math.floor(i / (seatMode === "mirror" ? 2 : 1));
    const heroSeat = seatMode === "mirror" ? i % 2 : (seatMode === "heroSecondSkill" ? 1 : 0);
    const random = mulberry32(seatMode === "mirror" ? pairSeed : seed + i);
    const result = playMatch(hero, villain, heroPolicy, villainPolicy, random, heroSeat, experiment, seatMode);
    if (result.winner === "hero") {
      heroWins += 1;
      seatWins[heroSeat] += 1;
    } else if (result.winner === "villain") villainWins += 1;
    else timeouts += 1;
    if (result.winner !== "timeout") seatDecided[heroSeat] += 1;
    if (result.chipLead === "hero") chipLeads += 1;
    hands += result.hands;
    chipDiff += result.heroChips - result.villainChips;
    if (result.stats.villFactsBeforeFairness > 0) {
      factMatches += 1;
      if (result.winner !== "timeout") {
        factDecided += 1;
        if (result.winner === "hero") factWins += 1;
      }
    }
    Object.keys(agg).forEach((key) => {
      if (key === "reasons") return;
      agg[key] += result.stats[key] || 0;
    });
    for (const [key, value] of Object.entries(result.stats.reasons)) {
      agg.reasons[key] = (agg.reasons[key] || 0) + value;
    }
  }

  const n = games;
  const decided = heroWins + villainWins;
  const bust = wilson(heroWins, n);
  const decidedRate = wilson(heroWins, decided);
  const lead = wilson(chipLeads, n);
  const factRate = wilson(factWins, factDecided);
  return {
    id,
    name,
    hero: labelOf(hero),
    villain: labelOf(villain),
    heroIds: hero,
    villainIds: villain,
    matches: n,
    seatMode,
    experiment,
    heroWins,
    villainWins,
    timeouts,
    decided,
    bustWinRate: bust.percentage,
    bustLow: bust.low,
    bustHigh: bust.high,
    decidedWinRate: decidedRate.percentage,
    decidedLow: decidedRate.low,
    decidedHigh: decidedRate.high,
    chipLeadRate: lead.percentage,
    chipLeadLow: lead.low,
    chipLeadHigh: lead.high,
    avgHands: round(hands / n, 2),
    avgChipDiff: round(chipDiff / n, 1),
    timeoutRate: round(timeouts / n, 4),
    seat0Bust: round(seatWins[0] / Math.max(1, seatMode === "mirror" ? pairs : n), 4),
    seat1Bust: round(seatWins[1] / Math.max(1, seatMode === "mirror" ? pairs : n), 4),
    chipLoansPerMatch: round(agg.chipLoans / n, 3),
    energyLoansPerMatch: round(agg.energyLoans / n, 3),
    fairnessPerMatch: round(agg.fairness / n, 3),
    chipTakenPerMatch: round(agg.chipTaken / n, 1),
    chipRepayClearedPerMatch: round(agg.chipRepayCleared / n, 1),
    energyRepayClearedPerMatch: round(agg.energyRepayCleared / n, 2),
    persistentsClearedPerMatch: round(agg.persistentsCleared / n, 3),
    heroDeniedActivePerMatch: round(agg.heroDeniedActive / n, 3),
    villDeniedActivePerMatch: round(agg.villDeniedActive / n, 3),
    deniedDeltaPerMatch: round((agg.heroDeniedActive - agg.villDeniedActive) / n, 3),
    heroDeniedPassivePerMatch: round(agg.heroDeniedPassive / n, 3),
    villDeniedPassivePerMatch: round(agg.villDeniedPassive / n, 3),
    counterArmedPerMatch: round(agg.counterArmed / n, 3),
    loanCounteredPerMatch: round(agg.loanCountered / n, 3),
    loanKillsPerMatch: round(agg.loanKills / n, 3),
    conservationFails: agg.conservationFails,
    avgHeroEnergy: round(agg.energySum / Math.max(1, agg.energySamples), 2),
    avgHeroChips: round(agg.chipSum / Math.max(1, agg.chipSamples), 1),
    villFactsBeforeFairnessPerMatch: round(agg.villFactsBeforeFairness / n, 3),
    factMatchShare: round(factMatches / n, 4),
    winRateGivenVillFact: factRate.percentage,
    factCi: [factRate.low, factRate.high],
    reasons: agg.reasons,
    reproduce: `ABLATION_ONLY=${id} ABLATION_MATCHES=${n} ABLATION_SEED=${seed} node scripts/simulate-loan-fairness-ablation.js`,
  };
}

const DEFAULT = pickDefaultBotLoadout();
const EMPTY = [];
const P = {
  none: {},
  baseline: { baselineSkills: true },
  counter: { baselineSkills: true, armCounter: true },
  counterNoBase: { armCounter: true },
  irrev: { useRestart: true, useCheat: true, useIntel: true, useDestiny: true },
  persist: { baselineSkills: true, retreatFold: true, useNullify: true, retreatToCall: 80 },
};

function lf(overrides = {}) {
  return {
    chipLoan: true,
    energyLoan: true,
    chipLoanMax: 2,
    stackLoans: true,
    fairness: true,
    fairnessStyle: "afterLoan",
    fairnessAlways: true,
    ...overrides,
  };
}

function catalog() {
  const L4 = lf({ chipLoanMax: 1 });
  const L5 = lf({ chipLoanMax: 2 });
  return [
    { id: "SANITY-EMPTY", phase: 1, name: "无技能自战", hero: EMPTY, villain: EMPTY, heroPolicy: P.none, villainPolicy: P.none },
    { id: "SANITY-DEFAULT", phase: 1, name: "默认壳自战", hero: DEFAULT, villain: DEFAULT, heroPolicy: P.baseline, villainPolicy: P.baseline },

    { id: "EXP-01A", phase: 1, name: "公平 vs 无技能", hero: ["FAIRNESS"], villain: EMPTY, heroPolicy: { fairness: true, fairnessStyle: "asap" }, villainPolicy: P.none },
    { id: "EXP-01B", phase: 1, name: "公平 vs 默认壳", hero: ["FAIRNESS"], villain: DEFAULT, heroPolicy: { fairness: true, fairnessStyle: "asap" }, villainPolicy: P.baseline },

    { id: "EXP-02A", phase: 1, name: "只筹码贷 vs 无技能", hero: ["LOAN"], villain: EMPTY, heroPolicy: { chipLoan: true, spamLoan: true, stackLoans: true, chipLoanMax: 2 }, villainPolicy: P.none },
    { id: "EXP-02B", phase: 1, name: "只能量贷 vs 无技能", hero: ["LOAN"], villain: EMPTY, heroPolicy: { energyLoan: true, energyLoanBelow: 8 }, villainPolicy: P.none },
    { id: "EXP-02C", phase: 1, name: "完整贷款 vs 无技能", hero: ["LOAN"], villain: EMPTY, heroPolicy: { chipLoan: true, energyLoan: true, spamLoan: true, stackLoans: true, chipLoanMax: 2 }, villainPolicy: P.none },
    { id: "EXP-02D", phase: 1, name: "完整贷款 vs 默认壳", hero: ["LOAN"], villain: DEFAULT, heroPolicy: { chipLoan: true, energyLoan: true, spamLoan: true, stackLoans: true, chipLoanMax: 2, baselineSkills: true }, villainPolicy: P.baseline },

    { id: "EXP-03A", phase: 1, name: "能量贷+公平 vs 无技能", hero: ["LOAN", "FAIRNESS"], villain: EMPTY, heroPolicy: lf({ chipLoan: false }), villainPolicy: P.none },
    { id: "EXP-03B", phase: 2, name: "能量贷+公平 vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: lf({ chipLoan: false }), villainPolicy: P.baseline },

    { id: "EXP-04A", phase: 2, name: "筹码贷×1+公平 vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: lf({ energyLoan: false, chipLoanMax: 1 }), villainPolicy: P.baseline },
    { id: "EXP-04B", phase: 2, name: "筹码贷×2+公平 vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: lf({ energyLoan: false, chipLoanMax: 2 }), villainPolicy: P.baseline },

    { id: "EXP-05A", phase: 2, name: "完整 L4（能+1筹+公平）vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: L4, villainPolicy: P.baseline },
    { id: "EXP-05B", phase: 2, name: "完整 L5（能+2筹+公平）vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: L5, villainPolicy: P.baseline },
    { id: "EXP-05C", phase: 1, name: "完整 L4 vs 无技能", hero: ["LOAN", "FAIRNESS"], villain: EMPTY, heroPolicy: L4, villainPolicy: P.none },

    { id: "EXP-06", phase: 2, name: "完整 L4 但公平不清贷款债 vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: L4, villainPolicy: P.baseline, experiment: { fairnessClearsLoanDebt: false } },
    { id: "EXP-07", phase: 2, name: "完整 L4 但公平不封未来技能 vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: L4, villainPolicy: P.baseline, experiment: { fairnessLocksFuture: false } },

    { id: "C1", phase: 1, name: "L4 vs 纯Poker", hero: ["LOAN", "FAIRNESS"], villain: EMPTY, heroPolicy: L4, villainPolicy: P.none },
    { id: "C2A", phase: 1, name: "L4 vs 感知+强运", hero: ["LOAN", "FAIRNESS"], villain: ["PERCEPTION", "FORTUNE"], heroPolicy: L4, villainPolicy: P.none },
    { id: "C2B", phase: 1, name: "L4 vs 绝境+感知+警觉+协议对子", hero: ["LOAN", "FAIRNESS"], villain: ["DESPERATION", "PERCEPTION", "ALERT", "PROTOCOL_PAIR"], heroPolicy: L4, villainPolicy: P.none },
    { id: "C3A", phase: 1, name: "L4 vs 重启+情报", hero: ["LOAN", "FAIRNESS"], villain: ["RESTART", "INTEL_ONE"], heroPolicy: L4, villainPolicy: P.irrev },
    { id: "C3B", phase: 1, name: "L4 vs 千术+深呼吸+警觉", hero: ["LOAN", "FAIRNESS"], villain: ["CHEAT", "DEEP_BREATH", "ALERT"], heroPolicy: L4, villainPolicy: P.irrev },
    { id: "C4A", phase: 1, name: "L4 vs 血战+防守+撤退+试探", hero: ["LOAN", "FAIRNESS"], villain: ["BLOOD_BATTLE", "DEFENSE", "RETREAT", "PROBE"], heroPolicy: L4, villainPolicy: P.persist },
    { id: "C4B", phase: 1, name: "L4 vs 零化+血战+深呼吸", hero: ["LOAN", "FAIRNESS"], villain: ["NULLIFICATION", "BLOOD_BATTLE", "DEEP_BREATH"], heroPolicy: L4, villainPolicy: P.persist },
    { id: "C5A", phase: 1, name: "L4 vs 反制+回收（会埋反制）", hero: ["LOAN", "FAIRNESS"], villain: ["COUNTER", "RECYCLE"], heroPolicy: L4, villainPolicy: P.counter },
    { id: "C5B", phase: 1, name: "L4 vs 反制+回收（上一轮：不埋反制）", hero: ["LOAN", "FAIRNESS"], villain: ["COUNTER", "RECYCLE"], heroPolicy: L4, villainPolicy: P.none },
    { id: "C6A", phase: 1, name: "L4 vs 强运+协议两对+警觉", hero: ["LOAN", "FAIRNESS"], villain: ["FORTUNE", "PROTOCOL_TWO_PAIR", "ALERT"], heroPolicy: L4, villainPolicy: P.none },
    { id: "C6B", phase: 1, name: "L4 vs 千术+深呼吸+警觉", hero: ["LOAN", "FAIRNESS"], villain: ["CHEAT", "DEEP_BREATH", "ALERT"], heroPolicy: L4, villainPolicy: P.irrev },
    { id: "C6C", phase: 1, name: "L4 vs 血战+防守+恐吓", hero: ["LOAN", "FAIRNESS"], villain: ["BLOOD_BATTLE", "DEFENSE", "INTIMIDATION"], heroPolicy: L4, villainPolicy: P.baseline },

    { id: "F1", phase: 1, name: "策略F1 尽快公平 vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: lf({ chipLoanMax: 1, fairnessStyle: "asap" }), villainPolicy: P.baseline },
    { id: "F2", phase: 1, name: "策略F2 见持续状态再公平 vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: lf({ chipLoanMax: 1, fairnessStyle: "ifPersistents" }), villainPolicy: P.baseline },
    { id: "F3", phase: 1, name: "策略F3 贷后公平 vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: L4, villainPolicy: P.baseline },
    { id: "F4", phase: 1, name: "策略F4 有债或持续状态才公平 vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: lf({ chipLoanMax: 1, fairnessStyle: "ifDebtOrPersistents" }), villainPolicy: P.baseline },
    { id: "L1", phase: 1, name: "策略L1 无脑连贷 vs 默认壳", hero: ["LOAN"], villain: DEFAULT, heroPolicy: { chipLoan: true, spamLoan: true, stackLoans: true, chipLoanMax: 2, baselineSkills: true }, villainPolicy: P.baseline },
    { id: "L6", phase: 1, name: "策略L6 动态短筹才贷 vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: lf({ chipLoanMax: 1, chipIfShort: true }), villainPolicy: P.baseline },

    { id: "S1", phase: 1, name: "L4 每手先技能行动 vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: L4, villainPolicy: P.baseline, seatMode: "heroFirstSkill" },
    { id: "S2", phase: 1, name: "L4 每手后技能行动 vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: L4, villainPolicy: P.baseline, seatMode: "heroSecondSkill" },
  ];
}

function main() {
  const started = Date.now();
  const only = String(process.env.ABLATION_ONLY || "").trim();
  const all = catalog();
  all.forEach((row) => {
    if (row.hero.length && !validateLoadout(row.hero).ok) throw new Error(`非法英雄 ${row.id} ${row.hero}`);
    if (row.villain.length && !validateLoadout(row.villain).ok) throw new Error(`非法对手 ${row.id} ${row.villain}`);
  });
  const selected = only ? all.filter((row) => row.id === only) : all;
  const rows = [];
  selected.forEach((row, index) => {
    const matches = row.phase === 2 && !only ? HEAVY : MATCHES;
    process.stderr.write(`[${index + 1}/${selected.length}] ${row.id} ${row.name} n=${matches}\n`);
    rows.push(runSeries({
      ...row,
      matches,
      seed: SEED + index * 97,
      experiment: { loanCreditRestrictionV2: false, ...(row.experiment || {}) },
      seatMode: row.seatMode || "mirror",
    }));
  });

  const invalid = rows.filter((row) => row.conservationFails > 0);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  const report = {
    generatedAt: new Date().toISOString(),
    masterSeed: SEED,
    matchesDefault: MATCHES,
    matchesHeavy: HEAVY,
    maxHands: MAX_HANDS,
    gitHead: gitHead(),
    hashes: {
      skillEngine: fileHash("game/skills/skillEngine.js"),
      skillConfig: fileHash("game/skillConfig.js"),
      definitions: fileHash("game/skills/definitions.js"),
      thisScript: fileHash("scripts/simulate-loan-fairness-ablation.js"),
    },
    notes: [
      "双方共用同一套公开启发式下注。差异只来自装备技能和技能专属策略。",
      "mirror 座位：每个 seed 打两场，英雄分别坐 seat0 / seat1，牌序相同。",
      "bustWinRate = 打爆对手 / 全部场次（超时算未取胜）。decidedWinRate 与上一轮口径相同，不含超时。",
      "EXP-06 / EXP-07 只改 SkillEngine.experiment，生产规则默认仍清债且封锁。",
      "无技能壳在实验里允许 0 技能，不改生产 MIN_EQUIPPED_SKILLS=1。",
    ],
    elapsedMs: Date.now() - started,
    invalidRuns: invalid.map((row) => row.id),
    rows,
    byId,
  };
  const outPath = path.join(__dirname, "loan-fairness-ablation-report.json");
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  const summary = rows.map((row) => ({
    id: row.id,
    decided: row.decidedWinRate,
    bust: row.bustWinRate,
    ci: [row.decidedLow, row.decidedHigh],
    chip: row.chipTakenPerMatch,
    fair: row.fairnessPerMatch,
    deny: [row.heroDeniedActivePerMatch, row.villDeniedActivePerMatch],
    n: row.matches,
    cons: row.conservationFails,
  }));
  process.stdout.write(`${JSON.stringify({ outPath, elapsedMs: report.elapsedMs, invalid: report.invalidRuns, summary }, null, 2)}\n`);
}

main();
