#!/usr/bin/env node
/**
 * Loan Credit Restriction V2 平衡验证。
 * 正式规则已启用贷款信用受限 V2。本脚本仍可通过
 * experiment.loanCreditRestrictionV2 = false 对照旧规则。
 *
 *   node scripts/simulate-loan-credit-v2.js
 *   CREDIT_MATCHES=2000 CREDIT_HEAVY=10000 node scripts/simulate-loan-credit-v2.js
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
const { pickDefaultBotLoadout, validateLoadout, getLoanCreditState, LOAN_CREDIT, pendingLoanObligations } = require("../game/skills/skillState");

const SEED = Number(process.env.CREDIT_SEED || 20260821);
const MATCHES = Math.max(40, Number(process.env.CREDIT_MATCHES || 2000));
const HEAVY = Math.max(MATCHES, Number(process.env.CREDIT_HEAVY || 10000));
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
    restrictedEntries: 0,
    defaultedEntries: 0,
    restores: 0,
    washDebts: 0,
    defaultEscapes: 0,
    deniedByCredit: 0,
    realChipRepaid: 0,
    realEnergyRepaid: 0,
    washRepayWashCycles: 0,
    restoreGapSum: 0,
    restoreGapN: 0,
    chipDebtCleared: 0,
    energyDebtCleared: 0,
    cycleGapSum: 0,
    cycleGapN: 0,
    cycleChipEvSum: 0,
    cycleEnergyEvSum: 0,
    cycleCount: 0,
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
      stats.chipDebtCleared += Number(heroRow?.chipDebt) || 0;
      stats.energyDebtCleared += Number(heroRow?.energyDebt) || 0;
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

function planCreditLoans(player, opponent, policy) {
  const style = policy.creditStyle;
  if (!style) return null;
  const runtime = player.skillRuntime || {};
  const state = getLoanCreditState(runtime);
  const energy = Number(runtime.abyssEnergy) || 0;
  const chips = Number(player.chips) || 0;
  const opp = Number(opponent.chips) || 0;
  const debt = pendingLoanObligations(runtime);
  const canTakeChip = opp > 0 && energy >= 2;
  const canFairAfterLoan = energy >= 5;
  const nearKill = opp <= SKILL_CONFIG.LOAN_CHIP_TAKE * 2;

  if (state === LOAN_CREDIT.DEFAULTED) {
    return {
      energyLoan: false,
      chipCount: 0,
      fairness: debt.residual > 0 && energy >= 3,
    };
  }

  if (state === LOAN_CREDIT.RESTRICTED) {
    if (style === "burstThenRepay") {
      const canAffordRepay = chips >= 280;
      if (!canAffordRepay && canTakeChip && canFairAfterLoan) {
        return { energyLoan: false, chipCount: 1, fairness: true };
      }
      return { energyLoan: false, chipCount: canTakeChip ? 1 : 0, fairness: false };
    }
    if (style === "stayRestricted") {
      return { energyLoan: false, chipCount: canTakeChip ? 1 : 0, fairness: canTakeChip && canFairAfterLoan };
    }
    const desperate = chips < 280 || nearKill;
    if (desperate) {
      return { energyLoan: false, chipCount: canTakeChip ? 1 : 0, fairness: canTakeChip && canFairAfterLoan };
    }
    if (chips > 280 && canTakeChip) {
      return { energyLoan: false, chipCount: 1, fairness: false };
    }
    return { energyLoan: energy < 4 && energy >= 2, chipCount: 0, fairness: false };
  }

  const cap = energyCapFor(player);
  const canBridge = energy >= 2 && energy < 7;
  let projected = energy;
  if (canBridge) projected = Math.min(cap, energy - 2 + SKILL_CONFIG.LOAN_ENERGY_GAIN);
  let chipCount = 0;
  if (canTakeChip) {
    if (projected >= 7) chipCount = 2;
    else if (projected >= 5) chipCount = 1;
  }
  if (style === "dynamic" && chips >= 600 && !nearKill && chips > opp + 150) {
    return {
      energyLoan: energy < 3 && energy >= 2,
      chipCount: 0,
      fairness: false,
    };
  }
  return {
    energyLoan: canBridge,
    chipCount,
    fairness: chipCount > 0 || canBridge,
  };
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

  const creditPlan = planCreditLoans(player, opponent, policy);
  const energyLoanWanted = creditPlan ? creditPlan.energyLoan : Boolean(policy.energyLoan);
  const fairnessWanted = creditPlan ? creditPlan.fairness : Boolean(policy.fairness);
  const creditState = getLoanCreditState(player.skillRuntime);

  if (creditPlan && creditPlan.fairness && creditState === LOAN_CREDIT.DEFAULTED && energy() >= 3 && equipped.has("FAIRNESS")) {
    const used = tryUse(engine, room, player, "FAIRNESS", {}, stats, handCtx);
    if (!(used?.ok && used.status === "SUCCESS")) stats.fairnessFail += 1;
  }

  if (wantFairnessNow({ ...policy, fairness: fairnessWanted }, player, room, opponent, false) && (policy.fairnessStyle === "asap") && energy() >= 3) {
    const used = tryUse(engine, room, player, "FAIRNESS", {}, stats, handCtx);
    if (!(used?.ok && used.status === "SUCCESS")) stats.fairnessFail += 1;
  }

  const chipCount = creditPlan ? creditPlan.chipCount : chipsToTake(player, opponent, policy);
  if (energyLoanWanted && equipped.has("LOAN") && energy() >= 2 && !isLocked(room, player)) {
    const needAfter = ((creditPlan ? creditPlan.fairness : policy.fairness) ? 3 : 0) + 2 * chipCount;
    const afterLoan = Math.min(energyCapFor(player), energy() - 2 + SKILL_CONFIG.LOAN_ENERGY_GAIN);
    const mustBridge = energy() < needAfter && afterLoan >= needAfter;
    const energyFairLoop = Boolean((creditPlan ? creditPlan.fairness : policy.fairness) && !chipCount && energy() < 7);
    if (creditPlan || mustBridge || energyFairLoop || (policy.energyLoanBelow && energy() < policy.energyLoanBelow)) {
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

  const afterLoanPolicy = creditPlan
    ? { ...policy, fairness: creditPlan.fairness, fairnessAlways: Boolean(creditPlan.fairness) }
    : policy;
  if (wantFairnessNow(afterLoanPolicy, player, room, opponent, true) && energy() >= 3 && !isLocked(room, player)) {
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

function harvestCreditMetrics(hero, stats) {
  const metrics = hero?.skillRuntime?.loanCreditMetrics;
  if (!metrics) return;
  stats.restrictedEntries += Number(metrics.restrictedEntries) || 0;
  stats.defaultedEntries += Number(metrics.defaultedEntries) || 0;
  stats.restores += Number(metrics.restores) || 0;
  stats.washDebts += Number(metrics.washDebts) || 0;
  stats.defaultEscapes += Number(metrics.defaultEscapes) || 0;
  stats.deniedByCredit += Number(metrics.deniedByCredit) || 0;
  stats.realChipRepaid += Number(metrics.realChipRepaid) || 0;
  stats.realEnergyRepaid += Number(metrics.realEnergyRepaid) || 0;
  stats.washRepayWashCycles += Number(metrics.washRepayWashCycles) || 0;
  for (const gap of metrics.restoreHandGaps || []) {
    stats.restoreGapSum += Number(gap) || 0;
    stats.restoreGapN += 1;
  }
  for (const gap of metrics.cycleHandGaps || []) {
    stats.cycleGapSum += Number(gap) || 0;
    stats.cycleGapN += 1;
  }
}

function analyzeWashRepayWash(metrics, chipsByHand, energyByHand) {
  const washes = (metrics?.washHandNos || []).filter((handNo) => handNo != null);
  const restores = (metrics?.restoreHandNos || []).filter((handNo) => handNo != null);
  const out = { cycles: 0, handSum: 0, chipSum: 0, energySum: 0 };
  for (let i = 0; i < washes.length - 1; i += 1) {
    const start = washes[i];
    const end = washes[i + 1];
    const restored = restores.some((handNo) => handNo > start && handNo <= end);
    if (!restored) continue;
    out.cycles += 1;
    out.handSum += Math.max(0, end - start);
    out.chipSum += (Number(chipsByHand[end]) || 0) - (Number(chipsByHand[start]) || 0);
    out.energySum += (Number(energyByHand[end]) || 0) - (Number(energyByHand[start]) || 0);
  }
  return out;
}

function playMatch(heroLoadout, villainLoadout, heroPolicy, villainPolicy, random, heroSeat, experiment, seatMode) {
  const engine = new SkillEngine({ random, experiment });
  const hero = makePlayer("HERO", "Hero", heroLoadout, heroPolicy);
  const villain = makePlayer("VILL", "Villain", villainLoadout, villainPolicy);
  const ordered = heroSeat === 0 ? [hero, villain] : [villain, hero];
  const room = makeRoom(ordered[0], ordered[1]);
  const stats = emptyStats();
  const chipsByHand = {};
  const energyByHand = {};
  let hands = 0;
  while (hands < MAX_HANDS && hero.chips > 0 && villain.chips > 0) {
    if (seatMode === "heroFirstSkill") room.dealerIndex = room.players.findIndex((item) => item.playerId === "HERO");
    else if (seatMode === "heroSecondSkill") room.dealerIndex = room.players.findIndex((item) => item.playerId === "VILL");
    else room.dealerIndex = hands % 2;
    playHand(engine, room, stats, seatMode, hero);
    hands += 1;
    chipsByHand[room.handNo] = Number(hero.chips) || 0;
    energyByHand[room.handNo] = Number(hero.skillRuntime?.abyssEnergy) || 0;
    if (Math.abs(totalChips(room) - TOTAL_CHIPS) > 1) stats.conservationFails += 1;
  }
  harvestCreditMetrics(hero, stats);
  const cycles = analyzeWashRepayWash(hero.skillRuntime?.loanCreditMetrics, chipsByHand, energyByHand);
  stats.cycleCount += cycles.cycles;
  stats.cycleChipEvSum += cycles.chipSum;
  stats.cycleEnergyEvSum += cycles.energySum;
  if (cycles.cycles > 0 && stats.cycleGapN <= 0) {
    stats.cycleGapSum += cycles.handSum;
    stats.cycleGapN += cycles.cycles;
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
    experiment = {},
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
    totalLoansPerMatch: round((agg.chipLoans + agg.energyLoans) / n, 3),
    fairnessPerMatch: round(agg.fairness / n, 3),
    chipTakenPerMatch: round(agg.chipTaken / n, 1),
    chipRepayClearedPerMatch: round(agg.chipRepayCleared / n, 1),
    energyRepayClearedPerMatch: round(agg.energyRepayCleared / n, 2),
    chipDebtClearedPerMatch: round(agg.chipDebtCleared / n, 2),
    energyDebtClearedPerMatch: round(agg.energyDebtCleared / n, 2),
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
    restrictedPerMatch: round(agg.restrictedEntries / n, 3),
    defaultedPerMatch: round(agg.defaultedEntries / n, 3),
    restoresPerMatch: round(agg.restores / n, 3),
    washDebtsPerMatch: round(agg.washDebts / n, 3),
    defaultEscapesPerMatch: round(agg.defaultEscapes / n, 3),
    deniedByCreditPerMatch: round(agg.deniedByCredit / n, 3),
    realChipRepaidPerMatch: round(agg.realChipRepaid / n, 1),
    realEnergyRepaidPerMatch: round(agg.realEnergyRepaid / n, 2),
    loanNetChipPerMatch: round((agg.chipTaken - agg.realChipRepaid) / n, 1),
    avgHandsToRestore: round(agg.restoreGapSum / Math.max(1, agg.restoreGapN), 2),
    washRepayWashCyclesPerMatch: round(agg.washRepayWashCycles / n, 3),
    avgCycleHands: round(agg.cycleGapSum / Math.max(1, agg.cycleGapN), 2),
    avgCycleChipEv: round(agg.cycleChipEvSum / Math.max(1, agg.cycleCount), 1),
    avgCycleEnergyEv: round(agg.cycleEnergyEvSum / Math.max(1, agg.cycleCount), 2),
    cyclesObserved: agg.cycleCount,
    restoreSamples: agg.restoreGapN,
    reasons: agg.reasons,
    reproduce: `CREDIT_ONLY=${id} CREDIT_MATCHES=${n} CREDIT_SEED=${seed} node scripts/simulate-loan-credit-v2.js`,
  };
}

const DEFAULT = pickDefaultBotLoadout();
const EMPTY = [];
const V2 = { loanCreditRestrictionV2: true };
const OLD = { loanCreditRestrictionV2: false };
const P = {
  none: {},
  baseline: { baselineSkills: true },
  counter: { armCounter: true },
  irrev: { useRestart: true, useCheat: true, useIntel: true, useDestiny: true },
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

function creditPolicy(style, overrides = {}) {
  return {
    creditStyle: style,
    chipLoan: true,
    energyLoan: true,
    chipLoanMax: 2,
    stackLoans: true,
    fairness: true,
    fairnessStyle: "afterLoan",
    ...overrides,
  };
}

function catalog() {
  return [
    { id: "SANITY-EMPTY", phase: 1, name: "无技能自战", hero: EMPTY, villain: EMPTY, heroPolicy: P.none, villainPolicy: P.none, experiment: OLD },
    { id: "SANITY-DEFAULT", phase: 1, name: "默认壳自战", hero: DEFAULT, villain: DEFAULT, heroPolicy: P.baseline, villainPolicy: P.baseline, experiment: OLD },

    { id: "P1-DEFAULT", phase: 1, name: "P1 BURST_THEN_REPAY vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: creditPolicy("burstThenRepay"), villainPolicy: P.baseline, experiment: V2 },
    { id: "P2-DEFAULT", phase: 1, name: "P2 STAY_RESTRICTED vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: creditPolicy("stayRestricted"), villainPolicy: P.baseline, experiment: V2 },
    { id: "P3-DEFAULT", phase: 1, name: "P3 DYNAMIC_CREDIT vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: creditPolicy("dynamic"), villainPolicy: P.baseline, experiment: V2 },

    { id: "C-LOAN-DEFAULT", phase: 1, name: "C V2 Loan单独 vs 默认壳", hero: ["LOAN"], villain: DEFAULT, heroPolicy: { chipLoan: true, energyLoan: true, spamLoan: true, stackLoans: true, chipLoanMax: 2 }, villainPolicy: P.baseline, experiment: V2 },
    { id: "D-FAIR-DEFAULT", phase: 1, name: "D V2 Fairness单独 vs 默认壳", hero: ["FAIRNESS"], villain: DEFAULT, heroPolicy: { fairness: true, fairnessStyle: "asap" }, villainPolicy: P.baseline, experiment: V2 },
    { id: "C-LOAN-EMPTY", phase: 1, name: "C' V2 Loan单独 vs 无技能", hero: ["LOAN"], villain: EMPTY, heroPolicy: { chipLoan: true, energyLoan: true, spamLoan: true, stackLoans: true, chipLoanMax: 2 }, villainPolicy: P.none, experiment: V2 },

    { id: "A-OLD-EMPTY", phase: 1, name: "A 旧规则 Loan+Fairness vs 无技能", hero: ["LOAN", "FAIRNESS"], villain: EMPTY, heroPolicy: lf(), villainPolicy: P.none, experiment: OLD },
    { id: "E-V2-EMPTY", phase: 1, name: "E V2 Loan+Fairness vs 无技能", hero: ["LOAN", "FAIRNESS"], villain: EMPTY, heroPolicy: creditPolicy("burstThenRepay"), villainPolicy: P.none, experiment: V2, useBestStyle: true },
    { id: "G-FORTUNE", phase: 1, name: "G V2 Loan+Fairness vs 感知+强运", hero: ["LOAN", "FAIRNESS"], villain: ["PERCEPTION", "FORTUNE"], heroPolicy: creditPolicy("burstThenRepay"), villainPolicy: P.none, experiment: V2, useBestStyle: true },
    { id: "H-IRREV", phase: 1, name: "H V2 Loan+Fairness vs 千术+情报", hero: ["LOAN", "FAIRNESS"], villain: ["CHEAT", "INTEL_ONE"], heroPolicy: creditPolicy("burstThenRepay"), villainPolicy: P.irrev, experiment: V2, useBestStyle: true },
    { id: "I-COUNTER", phase: 1, name: "I V2 Loan+Fairness vs 反制+回收", hero: ["LOAN", "FAIRNESS"], villain: ["COUNTER", "RECYCLE"], heroPolicy: creditPolicy("burstThenRepay"), villainPolicy: P.counter, experiment: V2, useBestStyle: true },

    { id: "A-OLD-DEFAULT", phase: 2, name: "A 旧规则 Loan+Fairness vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: lf(), villainPolicy: P.baseline, experiment: OLD },
    { id: "B-V2-DEFAULT", phase: 2, name: "B/F V2 Loan+Fairness vs 默认壳", hero: ["LOAN", "FAIRNESS"], villain: DEFAULT, heroPolicy: creditPolicy("burstThenRepay"), villainPolicy: P.baseline, experiment: V2, useBestStyle: true },
  ];
}

function applyBestStyle(row, style) {
  if (!row.useBestStyle || !style) return row;
  return {
    ...row,
    heroPolicy: { ...row.heroPolicy, creditStyle: style },
    name: `${row.name} [${style}]`,
  };
}

function main() {
  const started = Date.now();
  const only = String(process.env.CREDIT_ONLY || "").trim();
  const all = catalog();
  all.forEach((row) => {
    if (row.hero.length && !validateLoadout(row.hero).ok) throw new Error(`非法英雄 ${row.id} ${row.hero}`);
    if (row.villain.length && !validateLoadout(row.villain).ok) throw new Error(`非法对手 ${row.id} ${row.villain}`);
  });
  const selected = only ? all.filter((row) => row.id === only) : all;
  const rows = [];
  const byId = {};
  let bestStyle = "burstThenRepay";
  selected.forEach((raw, index) => {
    const styleMap = {
      "P1-DEFAULT": "burstThenRepay",
      "P2-DEFAULT": "stayRestricted",
      "P3-DEFAULT": "dynamic",
    };
    if (!only && raw.useBestStyle) {
      const ranked = ["P1-DEFAULT", "P2-DEFAULT", "P3-DEFAULT"]
        .map((id) => byId[id])
        .filter(Boolean)
        .sort((a, b) => (b.decidedWinRate || 0) - (a.decidedWinRate || 0) || (b.bustWinRate || 0) - (a.bustWinRate || 0));
      if (ranked[0]) bestStyle = styleMap[ranked[0].id] || bestStyle;
    }
    const row = applyBestStyle(raw, bestStyle);
    const matches = row.phase === 2 && !only ? HEAVY : MATCHES;
    process.stderr.write(`[${index + 1}/${selected.length}] ${row.id} ${row.name} n=${matches}\n`);
    const result = runSeries({
      ...row,
      matches,
      seed: SEED + index * 97,
      experiment: row.experiment || {},
      seatMode: row.seatMode || "mirror",
    });
    rows.push(result);
    byId[result.id] = result;
  });

  const v2Key = byId["B-V2-DEFAULT"];
  const extra = [];
  if (!only && v2Key && (v2Key.decidedWinRate > 0.6 || v2Key.decidedWinRate < 0.4) && HEAVY < 20000 && MATCHES >= 200) {
    const upgraded = Math.max(20000, HEAVY);
    process.stderr.write(`[upgrade] B-V2-DEFAULT decided=${v2Key.decidedWinRate} → n=${upgraded}\n`);
    const raw = applyBestStyle(all.find((row) => row.id === "B-V2-DEFAULT"), bestStyle);
    const rerun = runSeries({
      ...raw,
      id: "B-V2-DEFAULT-20K",
      name: `${raw.name} 20k确认`,
      matches: upgraded,
      seed: SEED + 9000,
      experiment: raw.experiment || {},
      seatMode: "mirror",
    });
    extra.push(rerun);
    byId[rerun.id] = rerun;
    const oldRaw = all.find((row) => row.id === "A-OLD-DEFAULT");
    process.stderr.write(`[upgrade] A-OLD-DEFAULT → n=${upgraded}\n`);
    extra.push(runSeries({
      ...oldRaw,
      id: "A-OLD-DEFAULT-20K",
      name: `${oldRaw.name} 20k确认`,
      matches: upgraded,
      seed: SEED + 9100,
      experiment: oldRaw.experiment || {},
      seatMode: "mirror",
    }));
    extra.forEach((row) => {
      rows.push(row);
      byId[row.id] = row;
    });
  }

  const invalid = rows.filter((row) => row.conservationFails > 0);
  const report = {
    generatedAt: new Date().toISOString(),
    masterSeed: SEED,
    matchesDefault: MATCHES,
    matchesHeavy: HEAVY,
    maxHands: MAX_HANDS,
    gitHead: gitHead(),
    bestCreditStyle: bestStyle,
    hashes: {
      skillEngine: fileHash("game/skills/skillEngine.js"),
      skillState: fileHash("game/skills/skillState.js"),
      skillConfig: fileHash("game/skillConfig.js"),
      definitions: fileHash("game/skills/definitions.js"),
      thisScript: fileHash("scripts/simulate-loan-credit-v2.js"),
    },
    notes: [
      "双方共用同一套公开启发式下注。差异只来自装备技能、技能策略，以及 loanCreditRestrictionV2 开关。",
      "mirror 座位：每个 seed 打两场，英雄分别坐 seat0 / seat1，牌序相同。",
      "bustWinRate = 打爆对手 / 全部场次（超时算未取胜）。decidedWinRate 不含超时。",
      "旧规则组必须显式 loanCreditRestrictionV2=false；未传开关时走正式 V2。",
      "P1/P2/P3 先筛查，对阵矩阵使用其中 decidedWinRate 最高的策略。",
      "无技能壳在实验里允许 0 技能，不改生产 MIN_EQUIPPED_SKILLS=1。",
    ],
    elapsedMs: Date.now() - started,
    invalidRuns: invalid.map((row) => row.id),
    rows,
    byId,
  };
  const outPath = path.join(__dirname, "loan-credit-v2-report.json");
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  const summary = rows.map((row) => ({
    id: row.id,
    decided: row.decidedWinRate,
    bust: row.bustWinRate,
    ci: [row.decidedLow, row.decidedHigh],
    wash: row.washDebtsPerMatch,
    restrict: row.restrictedPerMatch,
    restore: row.restoresPerMatch,
    cycle: row.washRepayWashCyclesPerMatch,
    loans: row.totalLoansPerMatch,
    n: row.matches,
    cons: row.conservationFails,
  }));
  process.stdout.write(`${JSON.stringify({ outPath, elapsedMs: report.elapsedMs, bestCreditStyle: bestStyle, invalid: report.invalidRuns, summary }, null, 2)}\n`);
}

main();
