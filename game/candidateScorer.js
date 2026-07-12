const { createDeck } = require("../utils/deck");
const { pickBestFive, compareEvaluatedHands } = require("./handEvaluator");

const HIGH_POTENTIAL_THRESHOLD = 52;
const EXPECTED_CODES = new Set(createDeck().map((card) => card.code));

const DRAMATIC_PROFILE = Object.freeze({
  STRONG_CONFRONTATION: "strong_confrontation",
  RIVER_UPGRADE: "river_upgrade",
  RIVER_OVERTAKE: "river_overtake",
  EXTREME: "extreme",
});

const PROFILE_LABELS = Object.freeze({
  [DRAMATIC_PROFILE.STRONG_CONFRONTATION]: "强强对抗",
  [DRAMATIC_PROFILE.RIVER_UPGRADE]: "河牌升级",
  [DRAMATIC_PROFILE.RIVER_OVERTAKE]: "河牌反超",
  [DRAMATIC_PROFILE.EXTREME]: "极端爆发",
});

function cardIdentity(card) {
  if (!card || typeof card !== "object") return null;
  if (typeof card.code === "string") return card.code;
  if (typeof card.suit === "string" && typeof card.rank === "string") {
    return `${card.suit}${card.rank}`;
  }
  return null;
}

function candidateCards(candidate) {
  return [
    ...(Array.isArray(candidate?.playerA) ? candidate.playerA : []),
    ...(Array.isArray(candidate?.playerB) ? candidate.playerB : []),
    ...(Array.isArray(candidate?.community) ? candidate.community : []),
    ...(Array.isArray(candidate?.remainingDeck) ? candidate.remainingDeck : []),
  ];
}

function validateCandidate(candidate) {
  const violations = [];
  if (!candidate || typeof candidate !== "object") {
    return { valid: false, violations: ["candidate_missing"], totalCards: 0, uniqueCards: 0 };
  }
  if (!Array.isArray(candidate.playerA) || candidate.playerA.length !== 2) {
    violations.push("player_a_hole_count");
  }
  if (!Array.isArray(candidate.playerB) || candidate.playerB.length !== 2) {
    violations.push("player_b_hole_count");
  }
  if (!Array.isArray(candidate.community) || candidate.community.length !== 5) {
    violations.push("community_count");
  }
  if (!Array.isArray(candidate.remainingDeck) || candidate.remainingDeck.length !== 43) {
    violations.push("remaining_deck_count");
  }

  const cards = candidateCards(candidate);
  const codes = cards.map(cardIdentity);
  const unique = new Set(codes.filter(Boolean));
  if (cards.length !== 52) violations.push("total_card_count");
  if (codes.some((code) => !code || !EXPECTED_CODES.has(code))) violations.push("illegal_card");
  if (unique.size !== cards.length) violations.push("duplicate_card");
  if (cards.length === 52 && unique.size === 52) {
    for (const code of EXPECTED_CODES) {
      if (!unique.has(code)) {
        violations.push("incomplete_standard_deck");
        break;
      }
    }
  }
  return {
    valid: violations.length === 0,
    violations: [...new Set(violations)],
    totalCards: cards.length,
    uniqueCards: unique.size,
  };
}

function startingHandPotential(holeCards) {
  if (!Array.isArray(holeCards) || holeCards.length !== 2) return 0;
  const [first, second] = holeCards;
  if (!Number.isFinite(first?.value) || !Number.isFinite(second?.value)) return 0;
  const high = Math.max(first.value, second.value);
  const low = Math.min(first.value, second.value);
  const pair = high === low;
  const suited = first.suit === second.suit;
  const gap = high - low;

  if (pair) return Math.min(100, 52 + (high - 2) * 3.5);

  let score = (high + low) * 1.6;
  if (low >= 10) score += 25;
  if (suited) score += 10;
  if (gap === 1) score += 10;
  else if (gap === 2) score += 5;
  if (suited && gap === 1 && low >= 8) score += 7;
  if (suited && high === 14 && low >= 8) score += 10;

  const key = `${high}-${low}`;
  const namedBonuses = {
    "13-12": 8,
    "13-11": 7,
    "12-11": 7,
    "11-10": 6,
  };
  score += namedBonuses[key] || 0;
  return Math.max(0, Math.min(100, score));
}

function isHighPotentialStartingHand(holeCards, threshold = HIGH_POTENTIAL_THRESHOLD) {
  return startingHandPotential(holeCards) >= threshold;
}

function normalizedRankVector(rankVector = []) {
  return rankVector.reduce((total, value, index) => total + Number(value || 0) / 15 ** (index + 1), 0);
}

function finalHandStrength(evaluatedHand) {
  if (!evaluatedHand || !Number.isFinite(evaluatedHand.category)) return 0;
  return evaluatedHand.category * 12 + normalizedRankVector(evaluatedHand.rankVector) * 3;
}

function confrontationCloseness(handA, handB) {
  if (!handA || !handB) return 0;
  const categoryDistance = Math.abs(handA.category - handB.category);
  const strengthDistance = Math.abs(finalHandStrength(handA) - finalHandStrength(handB));
  return Math.max(0, 38 - categoryDistance * 9 - strengthDistance * 0.35);
}

function fiveCardCombinations(cards) {
  const combinations = [];
  for (let a = 0; a < cards.length - 4; a += 1) {
    for (let b = a + 1; b < cards.length - 3; b += 1) {
      for (let c = b + 1; c < cards.length - 2; c += 1) {
        for (let d = c + 1; d < cards.length - 1; d += 1) {
          for (let e = d + 1; e < cards.length; e += 1) {
            combinations.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
          }
        }
      }
    }
  }
  return combinations;
}

function holeCardParticipation(holeCards, evaluatedHand, allCards) {
  const holeCodes = new Set((holeCards || []).map(cardIdentity).filter(Boolean));
  const pool = Array.isArray(allCards) && allCards.length >= 5 ? allCards : evaluatedHand?.bestFive || [];
  let maximumCount = 0;
  const equivalentUsedCodes = new Set();
  for (const combination of fiveCardCombinations(pool)) {
    const evaluatedCombination = pickBestFive(combination);
    if (compareEvaluatedHands(evaluatedCombination, evaluatedHand) !== 0) continue;
    const usedInCombination = combination
      .map(cardIdentity)
      .filter((code) => code && holeCodes.has(code));
    maximumCount = Math.max(maximumCount, new Set(usedInCombination).size);
    usedInCombination.forEach((code) => equivalentUsedCodes.add(code));
  }
  return {
    participates: maximumCount > 0,
    count: maximumCount,
    codes: [...equivalentUsedCodes],
  };
}

function compareAtStreet(holeCardsA, holeCardsB, community) {
  const handA = pickBestFive([...holeCardsA, ...community]);
  const handB = pickBestFive([...holeCardsB, ...community]);
  return {
    handA,
    handB,
    comparison: compareEvaluatedHands(handA, handB),
  };
}

function riverImpact(candidate, precomputed = {}) {
  if (!candidate?.community || candidate.community.length !== 5) {
    return {
      upgradedA: false,
      upgradedB: false,
      categoryUpgradeA: false,
      categoryUpgradeB: false,
      overtake: false,
      winnerChanged: false,
      meaningful: false,
    };
  }
  const turnCommunity = candidate.community.slice(0, 4);
  const turn = precomputed.turn || compareAtStreet(candidate.playerA, candidate.playerB, turnCommunity);
  const final = precomputed.final || compareAtStreet(candidate.playerA, candidate.playerB, candidate.community);
  const upgradedA = compareEvaluatedHands(final.handA, turn.handA) > 0;
  const upgradedB = compareEvaluatedHands(final.handB, turn.handB) > 0;
  const categoryUpgradeA = final.handA.category > turn.handA.category;
  const categoryUpgradeB = final.handB.category > turn.handB.category;
  const overtake = turn.comparison !== 0 && final.comparison !== 0 && turn.comparison !== final.comparison;
  const winnerChanged = turn.comparison !== final.comparison;
  return {
    upgradedA,
    upgradedB,
    categoryUpgradeA,
    categoryUpgradeB,
    overtake,
    winnerChanged,
    meaningful: upgradedA || upgradedB || winnerChanged,
    turnComparison: turn.comparison,
    riverComparison: final.comparison,
    turnHandA: turn.handA,
    turnHandB: turn.handB,
  };
}

function riverImpactScore(impact) {
  if (!impact) return 0;
  return (
    (impact.categoryUpgradeA ? 18 : 0) +
    (impact.categoryUpgradeB ? 18 : 0) +
    (impact.overtake ? 32 : 0) +
    (!impact.overtake && impact.winnerChanged ? 8 : 0)
  );
}

function holeCardParticipationScore(participationA, participationB) {
  return (participationA?.participates ? 14 : 0) + (participationB?.participates ? 14 : 0);
}

function tieRisk(handA, handB) {
  if (!handA || !handB) return 250;
  return compareEvaluatedHands(handA, handB) === 0 ? 250 : 0;
}

function boardPlaysPenalty(candidate, finalHands) {
  if (!candidate?.community || candidate.community.length !== 5) return 0;
  const boardHand = pickBestFive(candidate.community);
  const handA = finalHands?.handA || pickBestFive([...candidate.playerA, ...candidate.community]);
  const handB = finalHands?.handB || pickBestFive([...candidate.playerB, ...candidate.community]);
  let penalty = 0;
  if (compareEvaluatedHands(handA, boardHand) === 0) penalty += 65;
  if (compareEvaluatedHands(handB, boardHand) === 0) penalty += 65;
  return penalty;
}

function pocketPairRank(holeCards) {
  if (!Array.isArray(holeCards) || holeCards.length !== 2) return 0;
  return holeCards[0].value === holeCards[1].value ? holeCards[0].value : 0;
}

function preflopDominancePenalty(holeCardsA, holeCardsB) {
  const potentialA = startingHandPotential(holeCardsA);
  const potentialB = startingHandPotential(holeCardsB);
  let penalty = Math.max(0, Math.abs(potentialA - potentialB) - 24) * 1.25;
  const pairA = pocketPairRank(holeCardsA);
  const pairB = pocketPairRank(holeCardsB);
  if (pairA && !pairB && pairA > Math.max(...holeCardsB.map((card) => card.value))) penalty += 10;
  if (pairB && !pairA && pairB > Math.max(...holeCardsA.map((card) => card.value))) penalty += 10;
  const sortedA = holeCardsA.map((card) => card.value).sort((a, b) => b - a);
  const sortedB = holeCardsB.map((card) => card.value).sort((a, b) => b - a);
  if (sortedA[0] === sortedB[0] && Math.abs(sortedA[1] - sortedB[1]) >= 4) penalty += 8;
  return penalty;
}

function extremeCollisionPenalty(holeCardsA, holeCardsB) {
  const pairA = pocketPairRank(holeCardsA);
  const pairB = pocketPairRank(holeCardsB);
  const valuesA = new Set(holeCardsA.map((card) => card.value));
  const valuesB = new Set(holeCardsB.map((card) => card.value));
  if (pairA >= 12 && pairB >= 12) return 48;
  const aPremiumBroadway = valuesA.has(14) && (valuesA.has(13) || valuesA.has(12));
  const bPremiumBroadway = valuesB.has(14) && (valuesB.has(13) || valuesB.has(12));
  if ((pairA >= 12 && bPremiumBroadway) || (pairB >= 12 && aPremiumBroadway)) return 36;
  if (startingHandPotential(holeCardsA) >= 90 && startingHandPotential(holeCardsB) >= 90) return 24;
  return 0;
}

function isExtremeFinalHand(hand) {
  if (!hand) return false;
  if (hand.category >= 8) return true;
  return hand.category === 7 && Number(hand.rankVector?.[0] || 0) >= 11;
}

function classifyDramaticProfile({ handA, handB, impact }) {
  if (impact?.overtake) return DRAMATIC_PROFILE.RIVER_OVERTAKE;
  if (isExtremeFinalHand(handA) || isExtremeFinalHand(handB)) return DRAMATIC_PROFILE.EXTREME;
  if (impact?.categoryUpgradeA || impact?.categoryUpgradeB) return DRAMATIC_PROFILE.RIVER_UPGRADE;
  return DRAMATIC_PROFILE.STRONG_CONFRONTATION;
}

function repeatedPatternPenalty(profile, recentProfiles = []) {
  if (!Array.isArray(recentProfiles) || recentProfiles.length === 0) return 0;
  const recent = recentProfiles.slice(-5);
  return recent.reduce((penalty, item, index) => {
    const type = typeof item === "string" ? item : item?.type;
    return penalty + (type === profile ? 3 + index : 0);
  }, 0);
}

function dramaticProfileBonus(profile, targetProfile) {
  const base = {
    [DRAMATIC_PROFILE.STRONG_CONFRONTATION]: 20,
    [DRAMATIC_PROFILE.RIVER_UPGRADE]: 31,
    [DRAMATIC_PROFILE.RIVER_OVERTAKE]: 38,
    [DRAMATIC_PROFILE.EXTREME]: 24,
  }[profile] || 0;
  return base + (targetProfile && targetProfile === profile ? 16 : 0);
}

function invalidScoreResult(validation) {
  return {
    valid: false,
    score: Number.NEGATIVE_INFINITY,
    profile: null,
    components: {},
    metrics: {
      totalCards: validation.totalCards,
      uniqueCards: validation.uniqueCards,
    },
    violations: validation.violations,
    evaluations: null,
  };
}

function scoreCandidate(candidate, options = {}) {
  const validation = validateCandidate(candidate);
  if (!validation.valid) return invalidScoreResult(validation);

  const relaxationTier = Math.max(0, Math.min(2, Number(options.relaxationTier) || 0));
  const final = compareAtStreet(candidate.playerA, candidate.playerB, candidate.community);
  const turn = compareAtStreet(candidate.playerA, candidate.playerB, candidate.community.slice(0, 4));
  const impact = riverImpact(candidate, { final, turn });
  const participationA = holeCardParticipation(candidate.playerA, final.handA, [
    ...candidate.playerA,
    ...candidate.community,
  ]);
  const participationB = holeCardParticipation(candidate.playerB, final.handB, [
    ...candidate.playerB,
    ...candidate.community,
  ]);
  const potentialA = startingHandPotential(candidate.playerA);
  const potentialB = startingHandPotential(candidate.playerB);
  const boardPenalty = boardPlaysPenalty(candidate, final);
  const dominancePenalty = preflopDominancePenalty(candidate.playerA, candidate.playerB);
  const collisionPenalty = extremeCollisionPenalty(candidate.playerA, candidate.playerB);
  const profile = classifyDramaticProfile({ handA: final.handA, handB: final.handB, impact });
  const minFinalCategory = relaxationTier === 0 ? 3 : 2;
  const violations = [];

  if (potentialA < HIGH_POTENTIAL_THRESHOLD) violations.push("player_a_low_starting_potential");
  if (potentialB < HIGH_POTENTIAL_THRESHOLD) violations.push("player_b_low_starting_potential");
  if (final.handA.category < minFinalCategory) violations.push("player_a_final_too_weak");
  if (final.handB.category < minFinalCategory) violations.push("player_b_final_too_weak");
  if (Math.max(final.handA.category, final.handB.category) < 5) violations.push("no_straight_or_better");
  if (final.comparison === 0) violations.push("tie");
  if (!participationA.participates) violations.push("player_a_hole_not_used");
  if (!participationB.participates) violations.push("player_b_hole_not_used");
  if (relaxationTier < 2 && !impact.meaningful) violations.push("river_has_no_impact");

  const components = {
    startingHandPotentialA: potentialA * 0.72,
    startingHandPotentialB: potentialB * 0.72,
    finalHandStrengthA: finalHandStrength(final.handA),
    finalHandStrengthB: finalHandStrength(final.handB),
    confrontationCloseness: confrontationCloseness(final.handA, final.handB),
    riverImpact: riverImpactScore(impact),
    holeCardParticipation: holeCardParticipationScore(participationA, participationB),
    dramaticProfileBonus: dramaticProfileBonus(profile, options.profileTarget),
    tieRisk: tieRisk(final.handA, final.handB),
    boardPlaysPenalty: boardPenalty,
    preflopDominancePenalty: dominancePenalty,
    extremeCollisionPenalty: collisionPenalty,
    repeatedPatternPenalty: repeatedPatternPenalty(profile, options.recentProfiles),
  };
  const positiveKeys = [
    "startingHandPotentialA",
    "startingHandPotentialB",
    "finalHandStrengthA",
    "finalHandStrengthB",
    "confrontationCloseness",
    "riverImpact",
    "holeCardParticipation",
    "dramaticProfileBonus",
  ];
  const negativeKeys = [
    "tieRisk",
    "boardPlaysPenalty",
    "preflopDominancePenalty",
    "extremeCollisionPenalty",
    "repeatedPatternPenalty",
  ];
  const score =
    positiveKeys.reduce((sum, key) => sum + components[key], 0) -
    negativeKeys.reduce((sum, key) => sum + components[key], 0);

  return {
    valid: violations.length === 0,
    score,
    profile,
    components,
    metrics: {
      totalCards: validation.totalCards,
      uniqueCards: validation.uniqueCards,
      relaxationTier,
      tie: final.comparison === 0,
      winner: final.comparison > 0 ? "A" : final.comparison < 0 ? "B" : null,
      finalCategoryA: final.handA.category,
      finalCategoryB: final.handB.category,
      highPotentialA: potentialA >= HIGH_POTENTIAL_THRESHOLD,
      highPotentialB: potentialB >= HIGH_POTENTIAL_THRESHOLD,
      holeParticipationA: participationA.participates,
      holeParticipationB: participationB.participates,
      boardPlays: boardPenalty > 0,
      riverImpact: impact,
      extremeCollision: collisionPenalty > 0,
      extremeFinal: isExtremeFinalHand(final.handA) || isExtremeFinalHand(final.handB),
    },
    violations,
    evaluations: {
      finalA: final.handA,
      finalB: final.handB,
      turnA: turn.handA,
      turnB: turn.handB,
    },
  };
}

module.exports = {
  HIGH_POTENTIAL_THRESHOLD,
  DRAMATIC_PROFILE,
  PROFILE_LABELS,
  validateCandidate,
  startingHandPotential,
  isHighPotentialStartingHand,
  finalHandStrength,
  confrontationCloseness,
  holeCardParticipation,
  riverImpact,
  riverImpactScore,
  holeCardParticipationScore,
  tieRisk,
  boardPlaysPenalty,
  preflopDominancePenalty,
  extremeCollisionPenalty,
  isExtremeFinalHand,
  classifyDramaticProfile,
  repeatedPatternPenalty,
  dramaticProfileBonus,
  scoreCandidate,
};
