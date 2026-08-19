const { createDeck } = require("../utils/deck");
const { pickBestFive, compareEvaluatedHands } = require("../game/handEvaluator");
const { listSkillDefinitions } = require("../game/skills/definitions");
const { FORTUNE_COMBOS, computeFortuneChance } = require("../game/skills/fortuneConfig");
const { SKILL_CONFIG } = require("../game/skillConfig");

const iterations = Math.max(
  1000,
  Number.parseInt(process.env.SKILL_SIM_ITERATIONS || process.argv[2] || '20000', 10) || 20000,
);

function shuffleInPlace(values) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
}

function enumerateLoadouts() {
  const catalog = listSkillDefinitions();
  const builds = [];
  function visit(start, picked, load) {
    if (picked.length >= SKILL_CONFIG.MIN_EQUIPPED_SKILLS) {
      builds.push({ skillIds: [...picked], load });
    }
    if (picked.length >= SKILL_CONFIG.MAX_EQUIPPED_SKILLS) return;
    for (let index = start; index < catalog.length; index += 1) {
      const nextLoad = load + catalog[index].load;
      if (nextLoad > SKILL_CONFIG.MAX_SKILL_LOAD) continue;
      picked.push(catalog[index].id);
      visit(index + 1, picked, nextLoad);
      picked.pop();
    }
  }
  visit(0, [], 0);
  return builds;
}

function simulateFortuneEquity() {
  const results = {
    all: { wins: 0, ties: 0, losses: 0, trials: 0 },
    pocketPair: { wins: 0, ties: 0, losses: 0, trials: 0 },
    suitedConnector: { wins: 0, ties: 0, losses: 0, trials: 0 },
  };
  for (let trial = 0; trial < iterations; trial += 1) {
    const combo = FORTUNE_COMBOS[Math.floor(Math.random() * FORTUNE_COMBOS.length)];
    const chosen = new Set(combo.codes);
    const remainder = shuffleInPlace(createDeck().filter((card) => !chosen.has(card.code)));
    const byCode = Object.fromEntries(createDeck().map((card) => [card.code, card]));
    const hero = combo.codes.map((code) => byCode[code]);
    const villain = [remainder.pop(), remainder.pop()];
    const board = [remainder.pop(), remainder.pop(), remainder.pop(), remainder.pop(), remainder.pop()];
    const heroHand = pickBestFive([...hero, ...board]);
    const villainHand = pickBestFive([...villain, ...board]);
    const comparison = compareEvaluatedHands(heroHand, villainHand);
    const bucket = combo.type === "POCKET_PAIR" ? results.pocketPair : results.suitedConnector;
    [results.all, bucket].forEach((target) => {
      target.trials += 1;
      if (comparison > 0) target.wins += 1;
      else if (comparison < 0) target.losses += 1;
      else target.ties += 1;
    });
  }
  Object.values(results).forEach((result) => {
    result.equity = Number(((result.wins + result.ties / 2) / result.trials).toFixed(4));
    result.winRate = Number((result.wins / result.trials).toFixed(4));
    result.tieRate = Number((result.ties / result.trials).toFixed(4));
  });
  return results;
}

function fortuneTriggerCurve() {
  return [
    [50, 50],
    [40, 60],
    [25, 75],
    [10, 90],
    [0, 100],
  ].map(([self, opponent]) => {
    const severity = Math.max(0, opponent - self) / Math.max(1, opponent);
    const chance = computeFortuneChance("hole", {
      disadvantage: severity,
      energy: SKILL_CONFIG.INITIAL_ABYSS_ENERGY,
      energyCap: SKILL_CONFIG.MAX_ABYSS_ENERGY,
    });
    return { selfChipShare: self, opponentChipShare: opponent, triggerChance: Number(chance.toFixed(4)) };
  });
}

function settlementMatrix() {
  const rows = [];
  for (const bloodStacks of [0, 1, 2]) {
    for (const desperation of [false, true]) {
      for (const deadEndFold of [false, true]) {
        for (const defense of [false, true]) {
          const multiplier = (2 ** bloodStacks) * (desperation ? 3 : 1) *
            (deadEndFold ? 3 : 1) * (defense ? 0.5 : 1);
          rows.push({ bloodStacks, desperation, deadEndFold, defense, multiplier });
        }
      }
    }
  }
  return rows;
}

function main() {
  const builds = enumerateLoadouts();
  const inclusion = Object.fromEntries(listSkillDefinitions().map((skill) => [skill.id, 0]));
  builds.forEach((build) => build.skillIds.forEach((skillId) => { inclusion[skillId] += 1; }));
  const fortuneTypes = FORTUNE_COMBOS.reduce((counts, combo) => {
    counts[combo.type] = (counts[combo.type] || 0) + 1;
    return counts;
  }, {});
  const report = {
    ruleset: "abyss-skills-v2-provisional",
    iterations,
    catalogSize: listSkillDefinitions().length,
    legalLoadoutCount: builds.length,
    loadoutCountByLoad: builds.reduce((counts, build) => {
      counts[build.load] = (counts[build.load] || 0) + 1;
      return counts;
    }, {}),
    legalBuildInclusion: inclusion,
    fortune: {
      combinationPool: fortuneTypes,
      combinationWeights: {
        pocketPair: Number((fortuneTypes.POCKET_PAIR / FORTUNE_COMBOS.length).toFixed(4)),
        suitedConnector: Number((fortuneTypes.SUITED_CONNECTOR / FORTUNE_COMBOS.length).toFixed(4)),
      },
      triggerCurve: fortuneTriggerCurve(),
      equityVsRandom: simulateFortuneEquity(),
      minimumPostCostEnergy: SKILL_CONFIG.MIN_FORTUNE_ENERGY,
    },
    settlementMultipliers: settlementMatrix(),
    auditNotes: [
      "All settlement modifiers are applied to net chip transfer and remain strictly zero-sum.",
      "The theoretical maximum multiplier is intentionally uncapped, but payment is capped by the loser's remaining chips.",
      "Fortune is sampled uniformly over 126 real card combinations, not uniformly over two hand-class labels.",
      "Equity figures are blind all-in equity against one uniformly random legal hand and are not a realistic betting-policy win rate.",
    ],
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();
