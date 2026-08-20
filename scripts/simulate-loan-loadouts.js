#!/usr/bin/env node
/**
 * 贷款合法构筑全枚举 + 对战抽样，用来判断贷款是否超模。
 * 生产 Bot 不会主动用贷款；本脚本只在实验策略里发动贷款及相关组合。
 *
 * 用法：
 *   node scripts/simulate-loan-loadouts.js
 *   LOAN_MATCHES=120 LOAN_FAMILY_MATCHES=40 node scripts/simulate-loan-loadouts.js
 */
const fs = require("fs");
const path = require("path");
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
const {
  listSkillDefinitions,
  getSkillDefinition,
  isProtocolSkill,
} = require("../game/skills/definitions");
const { pickDefaultBotLoadout, validateLoadout, getLoadoutLoad } = require("../game/skills/skillState");

const SEED = Number(process.env.LOAN_SEED || 20260820);
const MATCHES = Math.max(40, Number(process.env.LOAN_MATCHES || 200));
const FAMILY_MATCHES = Math.max(20, Number(process.env.LOAN_FAMILY_MATCHES || 48));
const MATRIX_MATCHES = Math.max(40, Number(process.env.LOAN_MATRIX_MATCHES || 120));
const MAX_HANDS = Number(process.env.LOAN_MAX_HANDS || 80);
const START_CHIPS = 1000;
const SMALL_BLIND = 25;
const BIG_BLIND = 50;
const FIVE_CORES = Object.freeze(["CHEAT", "NULLIFICATION", "FORTUNE", "DESTINY"]);
const FILLER_L1 = Object.freeze(["DEEP_BREATH", "ALERT", "PROBE"]);

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
  return ids.map(nameOf).join(" + ") || "空";
}

function enumerateLoadouts(predicate = () => true) {
  const catalog = listSkillDefinitions();
  const builds = [];
  function visit(start, picked, load) {
    if (picked.length >= SKILL_CONFIG.MIN_EQUIPPED_SKILLS && predicate(picked, load)) {
      builds.push({ skillIds: [...picked], load, size: picked.length });
    }
    if (picked.length >= SKILL_CONFIG.MAX_EQUIPPED_SKILLS) return;
    for (let i = start; i < catalog.length; i += 1) {
      const nextLoad = load + catalog[i].load;
      if (nextLoad > SKILL_CONFIG.MAX_SKILL_LOAD) continue;
      picked.push(catalog[i].id);
      visit(i + 1, picked, nextLoad);
      picked.pop();
    }
  }
  visit(0, [], 0);
  return builds;
}

function tagsOf(skillIds) {
  const set = new Set(skillIds);
  const five = FIVE_CORES.filter((id) => set.has(id));
  return {
    fairness: set.has("FAIRNESS"),
    desperation: set.has("DESPERATION"),
    retreat: set.has("RETREAT"),
    fiveCores: five,
    endgame: set.has("ENDGAME"),
    recycle: set.has("RECYCLE"),
    blood: set.has("BLOOD_BATTLE"),
    protocol: skillIds.some((id) => isProtocolSkill(getSkillDefinition(id))),
  };
}

function familyKey(skillIds) {
  const tags = tagsOf(skillIds);
  const keys = [];
  if (tags.fairness) keys.push("fairness");
  if (tags.desperation) keys.push("desperation");
  if (tags.retreat) keys.push("retreat");
  if (tags.fiveCores.length) keys.push(`five:${tags.fiveCores.join("+")}`);
  if (tags.endgame) keys.push("endgame");
  return keys.length ? keys.join("|") : "other";
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
    __policy: policy,
  };
  initPlayerForSkillMode(player, SKILL_MODE.ABYSS);
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

function opponentOf(room, player) {
  return room.players.find((item) => item.playerId !== player.playerId) || null;
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

function tryUse(engine, room, player, skillId, target, stats) {
  room.currentPlayerIndex = room.players.findIndex((item) => item.playerId === player.playerId);
  const result = engine.requestUse(room, player, {
    skillId,
    target,
    requestId: `${skillId}-${room.handNo}-${player.playerId}-${Math.floor(engine.random() * 1e9)}`,
  });
  if (result?.ok && result.status === "SUCCESS") {
    stats.skills[skillId] = (stats.skills[skillId] || 0) + 1;
    if (skillId === "LOAN") {
      if (String(target.mode) === "chip") stats.chipLoans += 1;
      if (String(target.mode) === "energy") stats.energyLoans += 1;
    }
    if (skillId === "FAIRNESS") stats.fairness += 1;
    if (skillId === "RETREAT") stats.retreats += 1;
  }
  return result;
}

function pendingChipLoans(player) {
  return (player.skillRuntime?.chipLoans || []).length;
}

function pendingLoanDue(player) {
  const runtime = player.skillRuntime;
  if (!runtime) return false;
  const dueChip = (runtime.chipLoans || []).some((loan) => !loan.skipCurrentEnd);
  const dueEnergy = Boolean(runtime.energyLoan && !runtime.energyLoan.skipCurrentEnd);
  return dueChip || dueEnergy;
}

function chipLoanCap(policy) {
  const rule = SKILL_CONFIG.LOAN_CHIP_MAX_USES_PER_HAND;
  if (policy.chipOnlyKill || policy.fairness || policy.spamLoan || policy.chipTwice || policy.stackLoans) {
    return rule;
  }
  return Math.min(1, rule);
}

function wantChipLoan(player, opponent, policy) {
  if (!policy.chipLoan) return false;
  if (opponent.chips <= 0) return false;
  const pending = pendingChipLoans(player);
  const allowStack = Boolean(policy.spamLoan || policy.stackLoans || policy.fairness || policy.chipTwice);
  if (pending > 0 && !allowStack) return false;
  const take = SKILL_CONFIG.LOAN_CHIP_TAKE;
  if (policy.chipOnlyKill) return opponent.chips <= take * chipLoanCap(policy);
  if (policy.chipIfShort) return opponent.chips <= 250 || player.chips <= 250;
  return true;
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
  if (!wantChipLoan(player, opponent, policy)) return 0;
  const cap = chipLoanCap(policy);
  if (!policy.fairness) return cap;
  for (let count = cap; count >= 1; count -= 1) {
    if (projectedEnergy(player, policy, count) >= 2 * count + 3) return count;
  }
  return projectedEnergy(player, policy, 1) >= 2 ? 1 : 0;
}

function applyPolicySkills(engine, room, player, ctx, stats) {
  const policy = player.__policy || {};
  const equipped = new Set(player.skillRuntime?.equippedSkillIds || []);
  const opponent = opponentOf(room, player);
  if (!opponent) return null;
  const energy = () => Number(player.skillRuntime.abyssEnergy) || 0;
  const planFairness = Boolean(policy.fairness && equipped.has("FAIRNESS"));
  const needCore = (policy.useCheat && equipped.has("CHEAT"))
    || (policy.useNullify && equipped.has("NULLIFICATION") && ["flop", "turn", "river"].includes(room.phase))
    || (policy.useDestiny && equipped.has("DESTINY") && room.phase === "turn")
    || (policy.useEndgame && equipped.has("ENDGAME"));
  const chipCount = chipsToTake(player, opponent, policy);
  const energyTarget = planFairness
    ? 3 + 2 * Math.max(1, chipCount)
    : needCore ? (policy.energyLoanBelow || 7) : 0;
  if (policy.energyLoan && equipped.has("LOAN") && energy() >= 2 && energy() < energyTarget) {
    tryUse(engine, room, player, "LOAN", { mode: "energy" }, stats);
  }

  if (equipped.has("LOAN") && chipCount > 0) {
    for (let i = 0; i < chipCount; i += 1) {
      if (opponent.chips <= 0) break;
      const before = opponent.chips;
      const used = tryUse(engine, room, player, "LOAN", { mode: "chip" }, stats);
      if (!used?.ok) break;
      stats.chipTaken += Math.max(0, before - opponent.chips);
      if (opponent.chips <= 0) {
        stats.loanKills += 1;
        return "loan_kill";
      }
    }
  }

  const needFairness = planFairness && (
    policy.fairnessAlways || pendingLoanDue(player) || pendingChipLoans(player) > 0
  );
  if (needFairness) {
    const used = tryUse(engine, room, player, "FAIRNESS", {}, stats);
    if (!used?.ok) stats.fairnessFail += 1;
  }

  if (policy.useCheat && equipped.has("CHEAT") && player.cards.length === 2) {
    const ownIndex = (player.cards[0].value || 0) <= (player.cards[1].value || 0) ? 0 : 1;
    tryUse(engine, room, player, "CHEAT", { ownIndex, zone: "deck_random" }, stats);
  }

  if (policy.useNullify && equipped.has("NULLIFICATION") && ["flop", "turn", "river"].includes(room.phase)) {
    tryUse(engine, room, player, "NULLIFICATION", { mode: "board", boardIndex: 0 }, stats);
  }

  if (policy.useDestiny && equipped.has("DESTINY") && room.phase === "turn" && room.deck.length) {
    const pick = room.deck.reduce((best, card) => (!best || card.value > best.value ? card : best), null);
    if (pick) tryUse(engine, room, player, "DESTINY", { cardCode: pick.code }, stats);
  }

  if (policy.useEndgame && equipped.has("ENDGAME") && player.skillRuntime.abyssEnergy >= 8) {
    tryUse(engine, room, player, "ENDGAME", {}, stats);
  }

  if (policy.baselineSkills) {
    const values = (player.cards || []).map((card) => Number(card?.value) || 0);
    const strong =
      player.cards.length === 2 &&
      (player.cards[0].rank === player.cards[1].rank
        || values.filter((value) => value >= 10).length === 2
        || Math.max(...values) >= 14);
    const order = strong
      ? ["BLOOD_BATTLE", "DEFENSE", "DEEP_BREATH"]
      : ["DEFENSE", "DEEP_BREATH", "BLOOD_BATTLE"];
    for (const skillId of order) {
      if (!equipped.has(skillId)) continue;
      if (tryUse(engine, room, player, skillId, {}, stats)?.ok) break;
    }
  }

  const retreatSpot = policy.retreatFold && equipped.has("RETREAT") && (
    ctx.wouldFold || (Number(ctx.toCall) || 0) >= (policy.retreatToCall || 80)
  );
  if (retreatSpot) {
    const armed = tryUse(engine, room, player, "RETREAT", {}, stats);
    if (armed?.ok) {
      stats.retreatFolds += 1;
      return "retreat_ready";
    }
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
  const pot = room.pot;
  if (!winner) return;
  winner.chips += pot;
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

function dealStreet(engine, room, phase) {
  room.phase = phase;
  onStreetPhaseChanged(room, phase);
  room.players.forEach((player) => {
    player.streetBet = 0;
    player.hasActed = false;
  });
  room.currentBet = 0;
  room.lastRaiseSize = BIG_BLIND;
  if (["flop", "turn", "river"].includes(phase)) engine.applyBoardFortune(room, phase);
  if (phase === "flop") {
    const burned = room.deck.pop();
    if (burned) room.skillState.burnedCards.push(burned);
    room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
  } else {
    const card = engine.applyForkDuringDeal(room);
    if (card) room.communityCards.push(card);
  }
  room.currentPlayerIndex = otherIndex(room.dealerIndex);
  engine.onCardsDealt(room, phase);
}

function runBetting(engine, room, stats) {
  let idx = room.currentPlayerIndex;
  let guard = 0;
  while (!isStreetComplete(room) && guard < 24) {
    guard += 1;
    const player = room.players[idx];
    idx = 1 - idx;
    if (!player || player.status !== "active" || player.isAllIn) continue;
    room.currentPlayerIndex = room.players.findIndex((item) => item.playerId === player.playerId);
    const toCall = Math.max(0, room.currentBet - player.streetBet);
    const opponent = opponentOf(room, player);
    const canRaise = Boolean(opponent && !opponent.isAllIn && player.chips > toCall);
    const heuristic = decideHeuristic(player, room, { toCall, canRaise });
    const skillHalt = applyPolicySkills(engine, room, player, { wouldFold: heuristic.action === "fold", toCall }, stats);
    if (skillHalt === "loan_kill") {
      settleLoanKill(engine, room, player, opponent, stats);
      return "loan_kill";
    }
    if (opponent.chips <= 0) {
      settleLoanKill(engine, room, player, opponent, stats);
      return "loan_kill";
    }
    const decision = skillHalt === "retreat_ready" ? { action: "fold" } : heuristic;
    if (skillHalt === "retreat_ready") {
      settleRetreat(engine, room, player, stats);
      return "retreat";
    }
    const result = applyDecision(room, player, decision);
    if (result === "fold") {
      settleFold(engine, room, stats);
      return "fold";
    }
  }
  return "continue";
}

function playHand(engine, room, stats) {
  const [playerA, playerB] = room.players;
  if (playerA.chips <= 0 || playerB.chips <= 0) return "over";
  room.handNo += 1;
  playerA.cards = [];
  playerB.cards = [];
  playerA.status = "active";
  playerB.status = "active";
  playerA.isAllIn = false;
  playerB.isAllIn = false;
  playerA.hasActed = false;
  playerB.hasActed = false;
  playerA.streetBet = 0;
  playerB.streetBet = 0;
  playerA.totalBet = 0;
  playerB.totalBet = 0;
  room.communityCards = [];
  room.phase = "pre_flop";
  room.pot = 0;
  beginHandSkills(room);
  engine.prepareDeckForHand(room);
  room.deck = shuffle(createDeck(), engine.random);
  for (let i = 0; i < 2; i += 1) {
    room.players.forEach((player) => player.cards.push(room.deck.pop()));
  }
  engine.applyHoleFortune(room);
  engine.onCardsDealt(room, "pre_flop");

  const sb = room.players[room.dealerIndex];
  const bb = room.players[1 - room.dealerIndex];
  const stack = Math.min(sb.chips, bb.chips);
  collectBet(room, sb, Math.min(SMALL_BLIND, stack));
  collectBet(room, bb, Math.min(BIG_BLIND, stack));
  room.currentBet = Math.max(sb.streetBet, bb.streetBet);
  room.lastRaiseSize = BIG_BLIND;
  room.currentPlayerIndex = room.dealerIndex;

  let street = runBetting(engine, room, stats);
  if (street !== "continue") return street;

  for (const phase of ["flop", "turn", "river"]) {
    if (room.players.some((player) => player.status === "folded" || player.chips <= 0)) break;
    dealStreet(engine, room, phase);
    const alive = room.players.filter((player) => player.status === "active");
    const needBet = alive.filter((player) => !player.isAllIn).length >= 1 && alive.length === 2;
    if (needBet && alive.some((player) => !player.isAllIn)) {
      street = runBetting(engine, room, stats);
      if (street !== "continue") return street;
    }
  }
  settleShowdown(engine, room, stats);
  return "showdown";
}

function emptyStats() {
  return {
    chipLoans: 0,
    energyLoans: 0,
    chipTaken: 0,
    fairness: 0,
    retreats: 0,
    retreatFolds: 0,
    fairnessFail: 0,
    loanKills: 0,
    skills: {},
    reasons: {},
  };
}

function playMatch(heroLoadout, villainLoadout, heroPolicy, villainPolicy, random, heroSeat) {
  const engine = new SkillEngine({ random });
  const hero = makePlayer("HERO", "Hero", heroLoadout, heroPolicy);
  const villain = makePlayer("VILL", "Villain", villainLoadout, villainPolicy);
  const ordered = heroSeat === 0 ? [hero, villain] : [villain, hero];
  const room = makeRoom(ordered[0], ordered[1]);
  const stats = emptyStats();
  let hands = 0;
  while (hands < MAX_HANDS && hero.chips > 0 && villain.chips > 0) {
    room.dealerIndex = hands % 2;
    playHand(engine, room, stats);
    hands += 1;
  }
  const heroWin = hero.chips > 0 && villain.chips <= 0;
  const villainWin = villain.chips > 0 && hero.chips <= 0;
  return {
    winner: heroWin ? "hero" : villainWin ? "villain" : "timeout",
    hands,
    heroChips: hero.chips,
    villainChips: villain.chips,
    stats,
  };
}

function runSeries(name, heroLoadout, villainLoadout, heroPolicy, villainPolicy, matches, seed) {
  const random = mulberry32(seed);
  let heroWins = 0;
  let villainWins = 0;
  let timeouts = 0;
  let hands = 0;
  const agg = emptyStats();
  for (let i = 0; i < matches; i += 1) {
    const result = playMatch(heroLoadout, villainLoadout, heroPolicy, villainPolicy, random, i % 2);
    if (result.winner === "hero") heroWins += 1;
    else if (result.winner === "villain") villainWins += 1;
    else timeouts += 1;
    hands += result.hands;
    agg.chipLoans += result.stats.chipLoans;
    agg.energyLoans += result.stats.energyLoans;
    agg.chipTaken += result.stats.chipTaken;
    agg.fairness += result.stats.fairness;
    agg.retreats += result.stats.retreats;
    agg.retreatFolds += result.stats.retreatFolds;
    agg.fairnessFail += result.stats.fairnessFail;
    agg.loanKills += result.stats.loanKills;
    for (const [key, value] of Object.entries(result.stats.reasons)) {
      agg.reasons[key] = (agg.reasons[key] || 0) + value;
    }
  }
  const decided = heroWins + villainWins;
  const rate = wilson(heroWins, decided);
  return {
    name,
    hero: labelOf(heroLoadout),
    villain: labelOf(villainLoadout),
    heroIds: heroLoadout,
    villainIds: villainLoadout,
    matches,
    heroWins,
    villainWins,
    timeouts,
    decided,
    winRate: rate.percentage,
    winLow: rate.low,
    winHigh: rate.high,
    avgHands: round(hands / matches, 2),
    loanKillsPerMatch: round(agg.loanKills / matches, 3),
    chipLoansPerMatch: round(agg.chipLoans / matches, 3),
    energyLoansPerMatch: round(agg.energyLoans / matches, 3),
    fairnessPerMatch: round(agg.fairness / matches, 3),
    retreatFoldsPerMatch: round(agg.retreatFolds / matches, 3),
    fairnessFailPerMatch: round(agg.fairnessFail / matches, 3),
    chipTakenPerMatch: round(agg.chipTaken / matches, 1),
    reasons: agg.reasons,
  };
}

const POLICIES = {
  control: { baselineSkills: true },
  loanSpam: { baselineSkills: true, chipLoan: true, spamLoan: true, stackLoans: true },
  loanChip: { baselineSkills: true, chipLoan: true },
  loanKill: { baselineSkills: true, chipLoan: true, chipOnlyKill: true },
  loanFair: {
    baselineSkills: true,
    chipLoan: true,
    stackLoans: true,
    fairness: true,
    fairnessAlways: true,
    energyLoan: true,
    energyLoanBelow: 5,
  },
  loanRetreat: { baselineSkills: true, chipLoan: true, retreatFold: true, retreatToCall: 80 },
  loanDesp: { baselineSkills: true, chipLoan: true, chipIfShort: true },
  loanCore: {
    baselineSkills: true,
    chipLoan: true,
    chipIfShort: true,
    energyLoan: true,
    energyLoanBelow: 7,
    useCheat: true,
    useNullify: true,
    useDestiny: true,
    useEndgame: true,
  },
};

function sample(list, n, random) {
  if (list.length <= n) return list.slice();
  const copy = list.slice();
  shuffle(copy, random);
  return copy.slice(0, n);
}

function summarizeCensus(loanBuilds) {
  const byLoad = {};
  const bySize = {};
  const partnerCounts = {};
  const families = {
    fairness: 0,
    desperation: 0,
    retreat: 0,
    five: 0,
    endgame: 0,
    other: 0,
  };
  const fiveSplit = Object.fromEntries(FIVE_CORES.map((id) => [id, 0]));
  loanBuilds.forEach((build) => {
    byLoad[build.load] = (byLoad[build.load] || 0) + 1;
    bySize[build.size] = (bySize[build.size] || 0) + 1;
    const tags = tagsOf(build.skillIds);
    if (tags.fairness) families.fairness += 1;
    if (tags.desperation) families.desperation += 1;
    if (tags.retreat) families.retreat += 1;
    if (tags.fiveCores.length) {
      families.five += 1;
      tags.fiveCores.forEach((id) => { fiveSplit[id] += 1; });
    }
    if (tags.endgame) families.endgame += 1;
    if (!tags.fairness && !tags.desperation && !tags.retreat && !tags.fiveCores.length && !tags.endgame) {
      families.other += 1;
    }
    build.skillIds.forEach((id) => {
      if (id === "LOAN") return;
      partnerCounts[id] = (partnerCounts[id] || 0) + 1;
    });
  });
  const partners = Object.entries(partnerCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, name: nameOf(id), count, share: round(count / loanBuilds.length, 4) }));
  return { byLoad, bySize, families, fiveSplit, partners };
}

function pickFamilyBattlers(loanBuilds, familyPred) {
  const all = loanBuilds.filter((build) => familyPred(build.skillIds));
  const compact = all.filter((build) => build.size <= 3);
  const random = mulberry32(SEED + 99);
  const extras = sample(all.filter((build) => build.size === 4), 24, random);
  const seen = new Set();
  return [...compact, ...extras].filter((build) => {
    const key = build.skillIds.slice().sort().join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function verdictFor(winRate, low) {
  if (winRate == null) return "无结论";
  if (low >= 0.62) return "超模";
  if (low >= 0.56) return "偏强";
  if (winRate >= 0.53 && low >= 0.50) return "略强";
  if (winRate <= 0.47 && (1 - (low || 0)) >= 0.50) return "不超模";
  return "均势附近";
}

function main() {
  const started = Date.now();
  const allBuilds = enumerateLoadouts();
  const loanBuilds = enumerateLoadouts((picked) => picked.includes("LOAN"));
  const census = summarizeCensus(loanBuilds);
  const control = pickDefaultBotLoadout();

  const reps = [
    { name: "对照自战", hero: control, villain: control, heroPolicy: POLICIES.control, villainPolicy: POLICIES.control },
    { name: "贷款无脑连贷 vs 默认壳", hero: ["LOAN"], villain: control, heroPolicy: POLICIES.loanSpam, villainPolicy: POLICIES.control },
    { name: "贷款单带（等债再贷）", hero: ["LOAN"], villain: control, heroPolicy: POLICIES.loanChip, villainPolicy: POLICIES.control },
    { name: "贷款只斩杀", hero: ["LOAN"], villain: control, heroPolicy: POLICIES.loanKill, villainPolicy: POLICIES.control },
    { name: "贷款换绝境（同壳）", hero: ["LOAN", "BLOOD_BATTLE", "DEFENSE", "DEEP_BREATH"], villain: control, heroPolicy: POLICIES.loanChip, villainPolicy: POLICIES.control },
    { name: "贷款+公平 vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: control, heroPolicy: POLICIES.loanFair, villainPolicy: POLICIES.control },
    { name: "贷款+公平 vs 公平+回收", hero: ["LOAN", "FAIRNESS"], villain: ["FAIRNESS", "RECYCLE"], heroPolicy: POLICIES.loanFair, villainPolicy: POLICIES.control },
    { name: "贷款+公平 vs 反制+回收", hero: ["LOAN", "FAIRNESS"], villain: ["COUNTER", "RECYCLE"], heroPolicy: POLICIES.loanFair, villainPolicy: POLICIES.control },
    { name: "贷款+公平+撤退 vs 默认壳", hero: ["LOAN", "FAIRNESS", "RETREAT"], villain: control, heroPolicy: POLICIES.loanFair, villainPolicy: POLICIES.control },
    { name: "贷款+绝境 vs 默认壳", hero: ["LOAN", "DESPERATION"], villain: control, heroPolicy: POLICIES.loanDesp, villainPolicy: POLICIES.control },
    { name: "贷款+绝境+血战+深呼吸", hero: ["LOAN", "DESPERATION", "BLOOD_BATTLE", "DEEP_BREATH"], villain: control, heroPolicy: POLICIES.loanDesp, villainPolicy: POLICIES.control },
    { name: "贷款+撤退 vs 默认壳", hero: ["LOAN", "RETREAT"], villain: control, heroPolicy: POLICIES.loanRetreat, villainPolicy: POLICIES.control },
    { name: "贷款+撤退 vs 试探+血战", hero: ["LOAN", "RETREAT"], villain: ["PROBE", "BLOOD_BATTLE"], heroPolicy: POLICIES.loanRetreat, villainPolicy: POLICIES.control },
    { name: "贷款+千术+警觉", hero: ["LOAN", "CHEAT", "ALERT"], villain: control, heroPolicy: POLICIES.loanCore, villainPolicy: POLICIES.control },
    { name: "贷款+零化+警觉", hero: ["LOAN", "NULLIFICATION", "ALERT"], villain: control, heroPolicy: POLICIES.loanCore, villainPolicy: POLICIES.control },
    { name: "贷款+强运+警觉", hero: ["LOAN", "FORTUNE", "ALERT"], villain: control, heroPolicy: POLICIES.loanCore, villainPolicy: POLICIES.control },
    { name: "贷款+天命+警觉", hero: ["LOAN", "DESTINY", "ALERT"], villain: control, heroPolicy: POLICIES.loanCore, villainPolicy: POLICIES.control },
    { name: "贷款+终局", hero: ["LOAN", "ENDGAME"], villain: control, heroPolicy: POLICIES.loanCore, villainPolicy: POLICIES.control },
  ];

  reps.forEach((row) => {
    if (!validateLoadout(row.hero).ok) throw new Error(`非法英雄构筑 ${row.name}`);
    if (!validateLoadout(row.villain).ok) throw new Error(`非法对手构筑 ${row.name}`);
  });

  const representative = reps.map((row, index) => {
    process.stderr.write(`rep ${index + 1}/${reps.length} ${row.name}\n`);
    return runSeries(row.name, row.hero, row.villain, row.heroPolicy, row.villainPolicy, MATCHES, SEED + index * 17);
  });

  const matrixHeroes = [
    { name: "贷款+公平", ids: ["LOAN", "FAIRNESS"], policy: POLICIES.loanFair },
    { name: "贷款+绝境", ids: ["LOAN", "DESPERATION"], policy: POLICIES.loanDesp },
    { name: "贷款+撤退", ids: ["LOAN", "RETREAT"], policy: POLICIES.loanRetreat },
    { name: "贷款+强运", ids: ["LOAN", "FORTUNE", "ALERT"], policy: POLICIES.loanCore },
    { name: "贷款+天命", ids: ["LOAN", "DESTINY", "ALERT"], policy: POLICIES.loanCore },
  ];
  const matrix = [];
  let matrixIndex = 0;
  for (let i = 0; i < matrixHeroes.length; i += 1) {
    for (let j = i + 1; j < matrixHeroes.length; j += 1) {
      const a = matrixHeroes[i];
      const b = matrixHeroes[j];
      process.stderr.write(`matrix ${a.name} vs ${b.name}\n`);
      matrix.push(runSeries(
        `${a.name} vs ${b.name}`,
        a.ids,
        b.ids,
        a.policy,
        b.policy,
        MATRIX_MATCHES,
        SEED + 800 + matrixIndex * 13,
      ));
      matrixIndex += 1;
    }
  }

  function familyReport(title, pred, policy) {
    const battlers = pickFamilyBattlers(loanBuilds, pred);
    process.stderr.write(`family ${title}: ${battlers.length} loadouts x ${FAMILY_MATCHES}\n`);
    const rows = battlers.map((build, index) => runSeries(
      `${title} ${labelOf(build.skillIds)}`,
      build.skillIds,
      control,
      policy,
      POLICIES.control,
      FAMILY_MATCHES,
      SEED + 2000 + index * 3 + title.length * 97,
    ));
    const meanWin = round(rows.reduce((sum, row) => sum + (row.winRate || 0), 0) / Math.max(1, rows.length), 4);
    const over = rows.filter((row) => (row.winLow || 0) >= 0.56).length;
    const best = rows.slice().sort((a, b) => (b.winRate || 0) - (a.winRate || 0)).slice(0, 8);
    const worst = rows.slice().sort((a, b) => (a.winRate || 0) - (b.winRate || 0)).slice(0, 5);
    return {
      title,
      loadoutCount: battlers.length,
      familyTotal: loanBuilds.filter((build) => pred(build.skillIds)).length,
      matchesEach: FAMILY_MATCHES,
      meanWinRate: meanWin,
      overCount: over,
      best,
      worst,
    };
  }

  const families = [
    familyReport("贷款+公平", (ids) => ids.includes("FAIRNESS"), POLICIES.loanFair),
    familyReport("贷款+绝境", (ids) => ids.includes("DESPERATION"), POLICIES.loanDesp),
    familyReport("贷款+撤退", (ids) => ids.includes("RETREAT"), POLICIES.loanRetreat),
    familyReport("贷款+5核", (ids) => FIVE_CORES.some((id) => ids.includes(id)), POLICIES.loanCore),
  ];

  const heroVsControl = representative.filter((row) => row.villainIds.join() === control.join() && row.name !== "对照自战");
  const strongest = heroVsControl.slice().sort((a, b) => (b.winRate || 0) - (a.winRate || 0))[0];
  const fairnessRow = representative.find((row) => row.name === "贷款+公平 vs 默认壳");
  const fairnessEqual = representative.find((row) => row.name === "贷款+公平 vs 公平+回收");
  const shellRow = representative.find((row) => row.name === "贷款换绝境（同壳）");
  const retreatRow = representative.find((row) => row.name === "贷款+撤退 vs 默认壳");
  const spamRow = representative.find((row) => row.name === "贷款无脑连贷 vs 默认壳");
  const controlRow = representative.find((row) => row.name === "对照自战");

  const conclusion = {
    headline: "待写入",
    reasons: [],
  };
  const flags = [];
  if ((fairnessRow?.winLow || 0) >= 0.58 || (fairnessEqual?.winLow || 0) >= 0.58) flags.push("fairness");
  if ((retreatRow?.winLow || 0) >= 0.58) flags.push("retreat");
  if ((shellRow?.winLow || 0) >= 0.58) flags.push("shell");
  if ((strongest?.winLow || 0) >= 0.62) flags.push("overall");
  if (flags.includes("fairness")) {
    conclusion.headline = "贷款本体不超模，但贷款+公平抹债循环明显偏强";
  } else if (flags.includes("shell") || flags.includes("retreat")) {
    conclusion.headline = "贷款在正确组合下偏强，还不到必须立刻削数值";
  } else if ((spamRow?.winRate || 1) < 0.4 && (shellRow?.winRate || 0) <= 0.53) {
    conclusion.headline = "无脑连贷严重负EV；在当前启发式对局里贷款没有稳定超模";
  } else {
    conclusion.headline = "在当前启发式对局里，贷款没有表现出稳定超模";
  }
  conclusion.reasons = [
    `对照自战胜率 ${controlRow?.winRate}，用来校正座位偏差`,
    `无脑连贷 ${spamRow?.winRate}，同壳替换绝境 ${shellRow?.winRate}`,
    `贷款+公平 vs 默认壳 ${fairnessRow?.winRate}（公平 ${fairnessRow?.fairnessPerMatch}/场），vs 公平+回收 ${fairnessEqual?.winRate}`,
    `贷款+撤退 ${retreatRow?.winRate}（撤退Fold ${retreatRow?.retreatFoldsPerMatch}/场）`,
    `最强代表构是「${strongest?.name}」，胜率 ${strongest?.winRate}（CI ${strongest?.winLow}–${strongest?.winHigh}）`,
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    seed: SEED,
    chipLoanMaxPerHand: SKILL_CONFIG.LOAN_CHIP_MAX_USES_PER_HAND,
    matchesPerRepresentative: MATCHES,
    familyMatches: FAMILY_MATCHES,
    matrixMatches: MATRIX_MATCHES,
    maxHands: MAX_HANDS,
    elapsedMs: Date.now() - started,
    catalogSize: listSkillDefinitions().length,
    legalLoadoutCount: allBuilds.length,
    loanLoadoutCount: loanBuilds.length,
    loanShare: round(loanBuilds.length / allBuilds.length, 4),
    census,
    representative,
    matrix,
    families,
    conclusion,
    notes: [
      "生产 Bot 默认构筑不含贷款，也不会主动发动 18–24。本实验给贷款方显式策略，测的是技能上限而不是当前 Bot 强度。",
      "双方共用同一套公开启发式下注，避免把牌力 AI 差异算进贷款。",
      "家族对战覆盖该家族全部 2–3 技能构筑，4 技能随机抽 24 套，对手固定为默认 Bot 构筑。",
      "超模判据：相对对照的决出胜率 Wilson 下限 ≥ 62% 视为超模，≥ 56% 视为偏强。",
      `本轮筹码贷规则上限为本手 ${SKILL_CONFIG.LOAN_CHIP_MAX_USES_PER_HAND} 次；公平/连贷策略会打满该上限。`,
    ],
  };

  const outPath = process.env.LOAN_REPORT_PATH
    ? path.resolve(process.env.LOAN_REPORT_PATH)
    : path.join(__dirname, "loan-balance-report.json");
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    loanLoadoutCount: report.loanLoadoutCount,
    legalLoadoutCount: report.legalLoadoutCount,
    elapsedMs: report.elapsedMs,
    conclusion: report.conclusion,
    representative: report.representative.map((row) => ({
      name: row.name,
      winRate: row.winRate,
      ci: [row.winLow, row.winHigh],
      loanKillsPerMatch: row.loanKillsPerMatch,
    })),
    outPath,
  }, null, 2)}\n`);
}

main();
