#!/usr/bin/env node
/**
 * Hand Rank Bonus launch-v1 vs off 轻量对局模拟。
 * 用法：
 *   node scripts/simulate-hand-rank-bonus.js
 *   HRB_MATCHES=10000 node scripts/simulate-hand-rank-bonus.js
 */
const { createDeck } = require("../utils/deck");
const { pickBestFive, compareEvaluatedHands } = require("../game/handEvaluator");
const { SkillEngine, initPlayerForSkillMode, setPlayerLoadout } = require("../game/skills/skillEngine");

const MATCHES = Math.max(200, Number(process.env.HRB_MATCHES || 10000));
const MAX_HANDS = Number(process.env.HRB_MAX_HANDS || 80);
const SEED = Number(process.env.HRB_SEED || 20260822);
const START = 1000;
const BB = 50;

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
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function round(value, digits = 4) {
  if (value == null || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function makePlayer(id, name, loadout) {
  const player = { playerId: id, name, chips: START, status: "active", cards: [], totalBet: 0 };
  initPlayerForSkillMode(player, "abyss");
  setPlayerLoadout(player, loadout);
  return player;
}

function emptyStats() {
  return {
    matches: 0,
    hands: 0,
    showdowns: 0,
    folds: 0,
    ties: 0,
    bonusEligible: 0,
    bonusTriggered: 0,
    bonusAmount: 0,
    bonusTransferred: 0,
    firstHandKill: 0,
    deadEndFolds: 0,
    bloodHands: 0,
    protocolHands: 0,
    conservationFails: 0,
    negativeChips: 0,
    handsToEnd: [],
    winnerCategory: {},
    bloodWins: 0,
    protocolWins: 0,
  };
}

function playMatch(random, { bonusEnabled, loadoutA, loadoutB, engine }) {
  const a = makePlayer("PA", "A", loadoutA);
  const b = makePlayer("PB", "B", loadoutB);
  const stats = {
    hands: 0,
    showdowns: 0,
    folds: 0,
    ties: 0,
    bonusEligible: 0,
    bonusTriggered: 0,
    bonusAmount: 0,
    bonusTransferred: 0,
    firstHandKill: 0,
    deadEndFolds: 0,
    bloodHands: 0,
    protocolHands: 0,
    conservationFails: 0,
    negativeChips: 0,
    endedHands: 0,
    bloodWins: 0,
    protocolWins: 0,
    winnerCategory: {},
  };
  for (let hand = 1; hand <= MAX_HANDS; hand += 1) {
    if (a.chips <= 0 || b.chips <= 0) break;
    stats.hands += 1;
    const startA = a.chips;
    const startB = b.chips;
    const totalBefore = startA + startB;
    a.status = "active";
    b.status = "active";
    a.skillRuntime.handStartChips = startA;
    b.skillRuntime.handStartChips = startB;
    a.skillRuntime.directChipGainThisHand = 0;
    b.skillRuntime.directChipGainThisHand = 0;
    a.skillRuntime.bloodBattleActive = loadoutA.includes("BLOOD_BATTLE") && random() < 0.35;
    b.skillRuntime.bloodBattleActive = loadoutB.includes("BLOOD_BATTLE") && random() < 0.35;
    a.skillRuntime.deadEndActive = loadoutA.includes("DEAD_END") && random() < 0.12;
    b.skillRuntime.deadEndActive = loadoutB.includes("DEAD_END") && random() < 0.12;
    a.skillRuntime.defenseActive = loadoutA.includes("DEFENSE") && random() < 0.4;
    b.skillRuntime.defenseActive = loadoutB.includes("DEFENSE") && random() < 0.4;
    a.skillRuntime.desperationActive = loadoutA.includes("DESPERATION") && startA <= 200;
    b.skillRuntime.desperationActive = loadoutB.includes("DESPERATION") && startB <= 200;
    if (a.skillRuntime.bloodBattleActive || b.skillRuntime.bloodBattleActive) stats.bloodHands += 1;

    const bet = Math.min(BB, a.chips, b.chips);
    a.chips -= bet;
    b.chips -= bet;
    a.totalBet = bet;
    b.totalBet = bet;
    const pot = bet * 2;
    const deck = shuffle(createDeck(), random);
    a.cards = [deck.pop(), deck.pop()];
    b.cards = [deck.pop(), deck.pop()];
    const board = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
    const fold = random() < 0.22;
    const room = {
      skillMode: "abyss",
      players: [a, b],
      skillState: { settlement: null },
      handRankBonusEnabled: bonusEnabled,
    };

    if (fold) {
      stats.folds += 1;
      const folder = random() < 0.5 ? a : b;
      const winner = folder === a ? b : a;
      folder.status = "folded";
      winner.chips += pot;
      engine.applySettlementModifiers(room, {
        reason: "fold",
        winner,
        tie: false,
        foldOrigin: "user",
      });
      if (winner.skillRuntime.deadEndActive) stats.deadEndFolds += 1;
    } else {
      const handA = pickBestFive([...a.cards, ...board]);
      const handB = pickBestFive([...b.cards, ...board]);
      const cmp = compareEvaluatedHands(handA, handB);
      if (cmp === 0) {
        stats.ties += 1;
        a.chips += bet;
        b.chips += bet;
        engine.applySettlementModifiers(room, { reason: "showdown", winner: null, tie: true });
      } else {
        stats.showdowns += 1;
        const winner = cmp > 0 ? a : b;
        const category = (cmp > 0 ? handA : handB).category;
        stats.winnerCategory[category] = (stats.winnerCategory[category] || 0) + 1;
        winner.chips += pot;
        const details = engine.applySettlementModifiers(room, {
          reason: "showdown",
          winner,
          winnerCategory: category,
          tie: false,
        });
        stats.bonusEligible += 1;
        if (details.handRankBonusApplied) {
          stats.bonusTriggered += 1;
          stats.bonusAmount += details.handRankBonusValue;
        }
        if (details.effects.some((entry) => String(entry.skillId).startsWith("PROTOCOL_"))) {
          stats.protocolHands += 1;
          stats.protocolWins += 1;
        }
        if (winner.skillRuntime.bloodBattleActive) stats.bloodWins += 1;
      }
    }

    if (a.chips + b.chips !== totalBefore) stats.conservationFails += 1;
    if (a.chips < 0 || b.chips < 0) stats.negativeChips += 1;
    if ((a.chips <= 0 || b.chips <= 0) && hand === 1) stats.firstHandKill += 1;
    if (a.chips <= 0 || b.chips <= 0) {
      stats.endedHands = hand;
      break;
    }
    stats.endedHands = hand;
  }
  return stats;
}

function runVariant(bonusEnabled, random) {
  const engine = new SkillEngine({ random });
  const pairs = [
    [["BLOOD_BATTLE", "RECYCLE"], ["DEFENSE", "RECYCLE"]],
    [["PROTOCOL_TRIPS", "BLOOD_BATTLE"], ["DEFENSE", "DEEP_BREATH"]],
    [["DEAD_END", "RECYCLE"], ["DEFENSE", "RECYCLE"]],
    [["DESPERATION", "RECYCLE"], ["PROTOCOL_PAIR", "DEEP_BREATH"]],
    [["LOAN", "RECYCLE"], ["DEFENSE", "RECYCLE"]],
  ];
  const acc = emptyStats();
  for (let i = 0; i < MATCHES; i += 1) {
    const [loadoutA, loadoutB] = pairs[i % pairs.length];
    const result = playMatch(random, { bonusEnabled, loadoutA, loadoutB, engine });
    acc.matches += 1;
    acc.hands += result.hands;
    acc.showdowns += result.showdowns;
    acc.folds += result.folds;
    acc.ties += result.ties;
    acc.bonusEligible += result.bonusEligible;
    acc.bonusTriggered += result.bonusTriggered;
    acc.bonusAmount += result.bonusAmount;
    acc.firstHandKill += result.firstHandKill;
    acc.deadEndFolds += result.deadEndFolds;
    acc.bloodHands += result.bloodHands;
    acc.protocolHands += result.protocolHands;
    acc.conservationFails += result.conservationFails;
    acc.negativeChips += result.negativeChips;
    acc.handsToEnd.push(result.endedHands);
    acc.bloodWins += result.bloodWins;
    acc.protocolWins += result.protocolWins;
    Object.entries(result.winnerCategory).forEach(([key, value]) => {
      acc.winnerCategory[key] = (acc.winnerCategory[key] || 0) + value;
    });
  }
  acc.avgHands = round(acc.handsToEnd.reduce((sum, value) => sum + value, 0) / acc.matches, 3);
  acc.showdownRate = round(acc.showdowns / Math.max(1, acc.hands), 4);
  acc.bonusTriggerRate = round(acc.bonusTriggered / Math.max(1, acc.bonusEligible), 4);
  acc.avgBonusPerMatch = round(acc.bonusAmount / acc.matches, 3);
  acc.firstHandKillRate = round(acc.firstHandKill / acc.matches, 4);
  return acc;
}

function main() {
  const off = runVariant(false, mulberry32(SEED));
  const on = runVariant(true, mulberry32(SEED));
  const report = {
    matches: MATCHES,
    table: "launch-v1",
    off: {
      avgHands: off.avgHands,
      showdownRate: off.showdownRate,
      bonusTriggerRate: off.bonusTriggerRate,
      firstHandKillRate: off.firstHandKillRate,
      deadEndFolds: off.deadEndFolds,
      bloodHands: off.bloodHands,
      protocolHands: off.protocolHands,
      conservationFails: off.conservationFails,
      negativeChips: off.negativeChips,
    },
    on: {
      avgHands: on.avgHands,
      showdownRate: on.showdownRate,
      bonusTriggerRate: on.bonusTriggerRate,
      avgBonusPerMatch: on.avgBonusPerMatch,
      firstHandKillRate: on.firstHandKillRate,
      deadEndFolds: on.deadEndFolds,
      bloodHands: on.bloodHands,
      protocolHands: on.protocolHands,
      conservationFails: on.conservationFails,
      negativeChips: on.negativeChips,
      winnerCategory: on.winnerCategory,
    },
    delta: {
      avgHands: round(on.avgHands - off.avgHands, 3),
      firstHandKillRate: round(on.firstHandKillRate - off.firstHandKillRate, 4),
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
