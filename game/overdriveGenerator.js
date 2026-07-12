const crypto = require("crypto");
const { createDeck } = require("../utils/deck");
const {
  DRAMATIC_PROFILE,
  PROFILE_LABELS,
  isHighPotentialStartingHand,
  scoreCandidate,
  validateCandidate,
} = require("./candidateScorer");

const DEFAULT_CANDIDATE_COUNT = 500;
const MAX_CANDIDATE_COUNT = 2000;
const PROFILE_WEIGHTS = Object.freeze({
  [DRAMATIC_PROFILE.STRONG_CONFRONTATION]: 0.35,
  [DRAMATIC_PROFILE.RIVER_UPGRADE]: 0.3,
  [DRAMATIC_PROFILE.RIVER_OVERTAKE]: 0.2,
  [DRAMATIC_PROFILE.EXTREME]: 0.15,
});

const BASE_DECK = createDeck();

function cryptoRandomUnit() {
  const bytes = crypto.randomBytes(6);
  return bytes.readUIntBE(0, 6) / 281474976710656;
}

function secureShuffle(cards) {
  if (!Array.isArray(cards)) throw new TypeError("cards 必须是数组");
  const shuffled = [...cards];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function weightedSecureChoice(items, getWeight = (item) => item?.weight ?? 1) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const weighted = items.map((item, index) => {
    const raw = Number(getWeight(item, index));
    return { item, weight: Number.isFinite(raw) && raw > 0 ? raw : 0 };
  });
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) return items[crypto.randomInt(items.length)];
  let cursor = cryptoRandomUnit() * total;
  for (const entry of weighted) {
    cursor -= entry.weight;
    if (cursor < 0) return entry.item;
  }
  return weighted[weighted.length - 1].item;
}

function buildStrongHolePool() {
  const pairs = [];
  for (let i = 0; i < BASE_DECK.length - 1; i += 1) {
    for (let j = i + 1; j < BASE_DECK.length; j += 1) {
      const holeCards = [BASE_DECK[i], BASE_DECK[j]];
      if (isHighPotentialStartingHand(holeCards)) pairs.push(holeCards);
    }
  }
  return pairs;
}

const STRONG_HOLE_POOL = buildStrongHolePool();

function chooseDisjointStrongHands() {
  const first = STRONG_HOLE_POOL[crypto.randomInt(STRONG_HOLE_POOL.length)];
  const used = new Set(first.map((card) => card.code));
  const available = STRONG_HOLE_POOL.filter((pair) => pair.every((card) => !used.has(card.code)));
  const second = available[crypto.randomInt(available.length)];
  const shouldSwap = crypto.randomInt(2) === 1;
  return shouldSwap
    ? { playerA: [...second], playerB: [...first] }
    : { playerA: [...first], playerB: [...second] };
}

function createCandidate() {
  const { playerA, playerB } = chooseDisjointStrongHands();
  const used = new Set([...playerA, ...playerB].map((card) => card.code));
  const available = secureShuffle(BASE_DECK.filter((card) => !used.has(card.code)));
  return {
    playerA,
    playerB,
    community: available.slice(0, 5),
    remainingDeck: available.slice(5),
  };
}

// GameEngine consumes room.deck with pop(). The resulting pop order is:
// A1, B1, A2, B2, burn, flop x3, burn, turn, burn, river.
function buildCommittedDeck(candidate) {
  const validation = validateCandidate(candidate);
  if (!validation.valid) {
    throw new RangeError(`无法构建非法候选牌堆: ${validation.violations.join(",")}`);
  }
  const unused = secureShuffle(candidate.remainingDeck);
  const burns = unused.slice(0, 3);
  const tail = unused.slice(3);
  const popOrder = [
    candidate.playerA[0],
    candidate.playerB[0],
    candidate.playerA[1],
    candidate.playerB[1],
    burns[0],
    candidate.community[0],
    candidate.community[1],
    candidate.community[2],
    burns[1],
    candidate.community[3],
    burns[2],
    candidate.community[4],
    ...tail,
  ];
  return popOrder.reverse();
}

function extractCandidateFromCommittedDeck(deck) {
  const stack = [...deck];
  const playerA = [stack.pop()];
  const playerB = [stack.pop()];
  playerA.push(stack.pop());
  playerB.push(stack.pop());
  const excluded = new Set([...playerA, ...playerB].map((card) => card.code));
  stack.pop();
  const community = [stack.pop(), stack.pop(), stack.pop()];
  stack.pop();
  community.push(stack.pop());
  stack.pop();
  community.push(stack.pop());
  community.forEach((card) => excluded.add(card.code));
  return {
    playerA,
    playerB,
    community,
    remainingDeck: deck.filter((card) => !excluded.has(card.code)),
  };
}

function highScorePool(scored) {
  if (scored.length <= 24) return [...scored];
  const sorted = [...scored].sort((a, b) => b.result.score - a.result.score);
  const keep = Math.max(24, Math.ceil(sorted.length * 0.4));
  return sorted.slice(0, keep);
}

function selectWeightedCandidate(scored, profileWeights = PROFILE_WEIGHTS) {
  const groups = new Map();
  scored.forEach((entry) => {
    if (!groups.has(entry.result.profile)) groups.set(entry.result.profile, []);
    groups.get(entry.result.profile).push(entry);
  });
  const availableProfiles = [...groups.keys()];
  const targetProfile = weightedSecureChoice(
    availableProfiles,
    (profile) => Number(profileWeights[profile]) || 0.01
  );
  const targetPool = highScorePool(groups.get(targetProfile) || scored);
  const minimum = Math.min(...targetPool.map((entry) => entry.result.score));
  return weightedSecureChoice(targetPool, (entry) => {
    const scoreWeight = Math.max(1, entry.result.score - minimum + 8);
    const collisionMultiplier = entry.result.metrics.extremeCollision ? 0.12 : 1;
    return scoreWeight * collisionMultiplier;
  });
}

function swapCandidateSeats(candidate) {
  return {
    playerA: [...candidate.playerB],
    playerB: [...candidate.playerA],
    community: [...candidate.community],
    remainingDeck: [...candidate.remainingDeck],
  };
}

function buildProfile(result) {
  return {
    type: result.profile,
    label: PROFILE_LABELS[result.profile] || "高爆协议",
    extreme: Boolean(result.metrics.extremeFinal),
    riverImpact: {
      upgraded: Boolean(
        result.metrics.riverImpact.categoryUpgradeA || result.metrics.riverImpact.categoryUpgradeB
      ),
      overtake: Boolean(result.metrics.riverImpact.overtake),
    },
  };
}

function getPublicOverdriveProfile(profile, { revealed = false } = {}) {
  const publicProfile = {
    protocol: "OVERDRIVE",
    enabled: true,
    label: "高爆协议已启用",
  };
  if (!revealed || !profile) return publicProfile;
  return {
    ...publicProfile,
    type: profile.type,
    dramaticLabel: profile.label,
    extreme: Boolean(profile.extreme),
  };
}

function buildFallback(startedAt, candidateCount, generatedCount) {
  const deck = secureShuffle(BASE_DECK);
  const candidate = extractCandidateFromCommittedDeck(deck);
  const result = scoreCandidate(candidate, { relaxationTier: 2 });
  const profile = {
    type: "safe_random_fallback",
    label: "安全随机回退",
    extreme: Boolean(result.metrics.extremeFinal),
    riverImpact: {
      upgraded: Boolean(
        result.metrics.riverImpact?.categoryUpgradeA || result.metrics.riverImpact?.categoryUpgradeB
      ),
      overtake: Boolean(result.metrics.riverImpact?.overtake),
    },
  };
  return {
    deck,
    candidate,
    holeCards: { playerA: candidate.playerA, playerB: candidate.playerB },
    communityCards: candidate.community,
    profile,
    publicProfile: getPublicOverdriveProfile(profile),
    metrics: {
      fallback: true,
      degraded: true,
      relaxationTier: 3,
      candidateCountRequested: candidateCount,
      generatedCandidates: generatedCount,
      generationAttempts: candidateCount,
      evaluatedCandidates: generatedCount * 3,
      eligibleCandidates: 0,
      selectedScore: Number.isFinite(result.score) ? result.score : null,
      winner: result.metrics.winner,
      finalCategoryA: result.metrics.finalCategoryA,
      finalCategoryB: result.metrics.finalCategoryB,
      riverImpact: result.metrics.riverImpact,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    },
  };
}

function normalizeCandidateCount(value) {
  if (value === undefined) return DEFAULT_CANDIDATE_COUNT;
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CANDIDATE_COUNT;
  return Math.max(0, Math.min(MAX_CANDIDATE_COUNT, Math.floor(number)));
}

function generateOverdriveDeal(options = {}) {
  const startedAt = process.hrtime.bigint();
  const suppliedCandidates = Array.isArray(options.candidates) ? options.candidates : null;
  const candidateCount = suppliedCandidates
    ? Math.min(MAX_CANDIDATE_COUNT, suppliedCandidates.length)
    : normalizeCandidateCount(options.candidateCount);
  const generated = [];
  const candidateFactory = typeof options.candidateFactory === "function" ? options.candidateFactory : createCandidate;

  for (let i = 0; i < candidateCount; i += 1) {
    try {
      generated.push(suppliedCandidates ? suppliedCandidates[i] : candidateFactory(i));
    } catch (_error) {
      // A failed candidate is skipped; the outer loop remains strictly bounded.
    }
  }

  let selectedTier = -1;
  let eligible = [];
  let evaluatedCandidates = 0;
  const eligibleByTier = [];
  for (let tier = 0; tier <= 2; tier += 1) {
    const scored = generated.map((candidate) => ({
      candidate,
      result: scoreCandidate(candidate, {
        relaxationTier: tier,
        recentProfiles: options.recentProfiles,
      }),
    }));
    evaluatedCandidates += scored.length;
    const valid = scored.filter((entry) => entry.result.valid);
    eligibleByTier.push(valid.length);
    if (valid.length > 0) {
      selectedTier = tier;
      eligible = valid;
      break;
    }
  }

  if (selectedTier < 0) return buildFallback(startedAt, candidateCount, generated.length);

  const chosen = selectWeightedCandidate(eligible, options.profileWeights || PROFILE_WEIGHTS);
  const seatSwapped = crypto.randomInt(2) === 1;
  const candidate = seatSwapped ? swapCandidateSeats(chosen.candidate) : chosen.candidate;
  const selectedResult = scoreCandidate(candidate, {
    relaxationTier: selectedTier,
    recentProfiles: options.recentProfiles,
  });
  const profile = buildProfile(selectedResult);
  const deck = buildCommittedDeck(candidate);

  return {
    deck,
    candidate,
    holeCards: { playerA: candidate.playerA, playerB: candidate.playerB },
    communityCards: candidate.community,
    profile,
    publicProfile: getPublicOverdriveProfile(profile),
    metrics: {
      fallback: false,
      degraded: selectedTier > 0,
      relaxationTier: selectedTier,
      candidateCountRequested: candidateCount,
      generatedCandidates: generated.length,
      generationAttempts: candidateCount,
      evaluatedCandidates,
      eligibleCandidates: eligible.length,
      eligibleByTier,
      selectedScore: selectedResult.score,
      selectedComponents: selectedResult.components,
      seatSwapped,
      winner: selectedResult.metrics.winner,
      finalCategoryA: selectedResult.metrics.finalCategoryA,
      finalCategoryB: selectedResult.metrics.finalCategoryB,
      highPotentialA: selectedResult.metrics.highPotentialA,
      highPotentialB: selectedResult.metrics.highPotentialB,
      holeParticipationA: selectedResult.metrics.holeParticipationA,
      holeParticipationB: selectedResult.metrics.holeParticipationB,
      boardPlays: selectedResult.metrics.boardPlays,
      extremeCollision: selectedResult.metrics.extremeCollision,
      extremeFinal: selectedResult.metrics.extremeFinal,
      riverImpact: selectedResult.metrics.riverImpact,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    },
  };
}

module.exports = {
  DEFAULT_CANDIDATE_COUNT,
  MAX_CANDIDATE_COUNT,
  PROFILE_WEIGHTS,
  secureShuffle,
  weightedSecureChoice,
  createCandidate,
  buildCommittedDeck,
  extractCandidateFromCommittedDeck,
  getPublicOverdriveProfile,
  generateOverdriveDeal,
};
