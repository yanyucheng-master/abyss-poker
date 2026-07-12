#!/usr/bin/env node
const { generateOverdriveDeal } = require("../game/overdriveGenerator");

const CATEGORY_NAMES = {
  1: "high_card",
  2: "pair",
  3: "two_pair",
  4: "trips",
  5: "straight",
  6: "flush",
  7: "full_house",
  8: "quads",
  9: "straight_flush",
  10: "royal_flush",
};

function parseGameCount(argv) {
  const gamesFlag = argv.find((arg) => arg.startsWith("--games="));
  const raw = gamesFlag ? gamesFlag.slice("--games=".length) : argv[0];
  const parsed = Number(raw ?? 1000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1000;
}

function increment(record, key) {
  record[key] = (record[key] || 0) + 1;
}

function ratio(value, total) {
  return total > 0 ? Number((value / total).toFixed(4)) : 0;
}

function runSimulation(gameCount = 1000) {
  const stats = {
    games: gameCount,
    finalHandDistribution: { playerA: {}, playerB: {}, bothSeats: {} },
    profiles: {},
    winners: { A: 0, B: 0, tie: 0 },
    riverUpgrades: 0,
    riverOvertakes: 0,
    quadsGames: 0,
    straightFlushGames: 0,
    degradedDeals: 0,
    fallbackDeals: 0,
    extremeStartingCollisions: 0,
    totalGeneratedCandidates: 0,
    totalDurationMs: 0,
  };

  for (let i = 0; i < gameCount; i += 1) {
    const deal = generateOverdriveDeal();
    const metrics = deal.metrics;
    const nameA = CATEGORY_NAMES[metrics.finalCategoryA] || "unknown";
    const nameB = CATEGORY_NAMES[metrics.finalCategoryB] || "unknown";
    increment(stats.finalHandDistribution.playerA, nameA);
    increment(stats.finalHandDistribution.playerB, nameB);
    increment(stats.finalHandDistribution.bothSeats, nameA);
    increment(stats.finalHandDistribution.bothSeats, nameB);
    increment(stats.profiles, deal.profile.type);
    if (metrics.winner === "A" || metrics.winner === "B") stats.winners[metrics.winner] += 1;
    else stats.winners.tie += 1;
    if (metrics.riverImpact?.categoryUpgradeA || metrics.riverImpact?.categoryUpgradeB) {
      stats.riverUpgrades += 1;
    }
    if (metrics.riverImpact?.overtake) stats.riverOvertakes += 1;
    if (metrics.finalCategoryA === 8 || metrics.finalCategoryB === 8) stats.quadsGames += 1;
    if (metrics.finalCategoryA >= 9 || metrics.finalCategoryB >= 9) stats.straightFlushGames += 1;
    if (metrics.degraded) stats.degradedDeals += 1;
    if (metrics.fallback) stats.fallbackDeals += 1;
    if (metrics.extremeCollision) stats.extremeStartingCollisions += 1;
    stats.totalGeneratedCandidates += metrics.generatedCandidates || 0;
    stats.totalDurationMs += metrics.durationMs || 0;
  }

  const decided = stats.winners.A + stats.winners.B;
  return {
    games: stats.games,
    finalHandDistribution: stats.finalHandDistribution,
    dramaticProfileDistribution: stats.profiles,
    ties: stats.winners.tie,
    tieRate: ratio(stats.winners.tie, gameCount),
    riverUpgradeRate: ratio(stats.riverUpgrades, gameCount),
    riverOvertakeRate: ratio(stats.riverOvertakes, gameCount),
    quadsRate: ratio(stats.quadsGames, gameCount),
    straightFlushRate: ratio(stats.straightFlushGames, gameCount),
    averageCandidateGenerationCount: Number((stats.totalGeneratedCandidates / gameCount).toFixed(2)),
    averageGenerationTimeMs: Number((stats.totalDurationMs / gameCount).toFixed(3)),
    degradedDeals: stats.degradedDeals,
    fallbackDeals: stats.fallbackDeals,
    extremeStartingCollisionRate: ratio(stats.extremeStartingCollisions, gameCount),
    seatWinRates: {
      playerA: ratio(stats.winners.A, decided),
      playerB: ratio(stats.winners.B, decided),
      winsA: stats.winners.A,
      winsB: stats.winners.B,
    },
  };
}

if (require.main === module) {
  const gameCount = parseGameCount(process.argv.slice(2));
  const result = runSimulation(gameCount);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = { runSimulation };
