const { createDeck } = require("../utils/deck");
const { pickBestFive } = require("../game/handEvaluator");
const {
  HIGH_POTENTIAL_THRESHOLD,
  startingHandPotential,
  holeCardParticipation,
  boardPlaysPenalty,
  riverImpact,
  scoreCandidate,
  validateCandidate,
} = require("../game/candidateScorer");
const {
  createCandidate,
  buildCommittedDeck,
  generateOverdriveDeal,
  getPublicOverdriveProfile,
} = require("../game/overdriveGenerator");

const CARD_BY_CODE = new Map(createDeck().map((card) => [card.code, card]));

function cards(codes) {
  return codes.map((code) => {
    const card = CARD_BY_CODE.get(code);
    if (!card) throw new Error(`unknown card ${code}`);
    return card;
  });
}

function completeCandidate(playerA, playerB, community) {
  const selected = cards([...playerA, ...playerB, ...community]);
  const used = new Set(selected.map((card) => card.code));
  return {
    playerA: cards(playerA),
    playerB: cards(playerB),
    community: cards(community),
    remainingDeck: createDeck().filter((card) => !used.has(card.code)),
  };
}

describe("overdrive candidate scoring", () => {
  test("recognizes the requested high-potential starting hand families", () => {
    expect(startingHandPotential(cards(["S7", "H7"]))).toBeGreaterThanOrEqual(HIGH_POTENTIAL_THRESHOLD);
    expect(startingHandPotential(cards(["S9", "S8"]))).toBeGreaterThanOrEqual(HIGH_POTENTIAL_THRESHOLD);
    expect(startingHandPotential(cards(["HA", "H8"]))).toBeGreaterThanOrEqual(HIGH_POTENTIAL_THRESHOLD);
    expect(startingHandPotential(cards(["CK", "DQ"]))).toBeGreaterThanOrEqual(HIGH_POTENTIAL_THRESHOLD);
    expect(startingHandPotential(cards(["S7", "D2"]))).toBeLessThan(HIGH_POTENTIAL_THRESHOLD);
  });

  test("accepts a complete strict candidate with two strong starts and a river upgrade", () => {
    const candidate = completeCandidate(
      ["SA", "SK"],
      ["HQ", "HJ"],
      ["SQ", "DJ", "C2", "D9", "CT"]
    );
    const validation = validateCandidate(candidate);
    const result = scoreCandidate(candidate);

    expect(validation).toMatchObject({ valid: true, totalCards: 52, uniqueCards: 52 });
    expect(result.valid).toBe(true);
    expect(result.metrics).toMatchObject({
      finalCategoryA: 5,
      finalCategoryB: 3,
      highPotentialA: true,
      highPotentialB: true,
      holeParticipationA: true,
      holeParticipationB: true,
    });
    expect(result.metrics.riverImpact.categoryUpgradeA).toBe(true);
  });

  test("rejects ties even when both players use a hole card", () => {
    const candidate = completeCandidate(
      ["SA", "D2"],
      ["HA", "C2"],
      ["SK", "DQ", "CJ", "HT", "D9"]
    );
    const result = scoreCandidate(candidate, { relaxationTier: 2 });
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("tie");
  });

  test("enumerates equivalent best-five combinations and still penalizes a playing board", () => {
    const hole = cards(["DQ", "C2"]);
    const board = cards(["SA", "HA", "SK", "HK", "SQ"]);
    const evaluated = pickBestFive([...hole, ...board]);
    const participation = holeCardParticipation(hole, evaluated, [...hole, ...board]);
    const candidate = completeCandidate(
      ["DQ", "C2"],
      ["D3", "C4"],
      ["SA", "HA", "SK", "HK", "SQ"]
    );

    expect(participation.participates).toBe(true);
    expect(participation.codes).toContain("DQ");
    expect(boardPlaysPenalty(candidate)).toBeGreaterThan(0);
  });

  test("detects a true river overtake", () => {
    const candidate = completeCandidate(
      ["DQ", "CQ"],
      ["SA", "HK"],
      ["HQ", "SJ", "D2", "C3", "DT"]
    );
    const impact = riverImpact(candidate);
    expect(impact.overtake).toBe(true);
    expect(impact.turnComparison).toBe(1);
    expect(impact.riverComparison).toBe(-1);
  });
});

describe("overdrive generation", () => {
  test("uses crypto-backed randomness without consulting Math.random", () => {
    const random = jest.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random must not be used");
    });
    expect(() => createCandidate()).not.toThrow();
    random.mockRestore();
  });

  test("returns a complete unique deck that matches GameEngine pop order", () => {
    const candidate = createCandidate();
    const deck = buildCommittedDeck(candidate);
    const stack = [...deck];
    const dealtA = [stack.pop()];
    const dealtB = [stack.pop()];
    dealtA.push(stack.pop());
    dealtB.push(stack.pop());
    stack.pop();
    const board = [stack.pop(), stack.pop(), stack.pop()];
    stack.pop();
    board.push(stack.pop());
    stack.pop();
    board.push(stack.pop());

    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((card) => card.code)).size).toBe(52);
    expect(dealtA.map((card) => card.code)).toEqual(candidate.playerA.map((card) => card.code));
    expect(dealtB.map((card) => card.code)).toEqual(candidate.playerB.map((card) => card.code));
    expect(board.map((card) => card.code)).toEqual(candidate.community.map((card) => card.code));
  });

  test("selects from about 500 candidates while preserving all hard constraints", () => {
    const deal = generateOverdriveDeal();
    expect(deal.metrics).toMatchObject({
      fallback: false,
      candidateCountRequested: 500,
      generatedCandidates: 500,
      highPotentialA: true,
      highPotentialB: true,
      holeParticipationA: true,
      holeParticipationB: true,
    });
    expect(deal.deck).toHaveLength(52);
    expect(new Set(deal.deck.map((card) => card.code)).size).toBe(52);
    expect(deal.metrics.winner).toMatch(/^[AB]$/);
    expect(Math.max(deal.metrics.finalCategoryA, deal.metrics.finalCategoryB)).toBeGreaterThanOrEqual(5);
    const minimum = deal.metrics.relaxationTier === 0 ? 3 : 2;
    expect(deal.metrics.finalCategoryA).toBeGreaterThanOrEqual(minimum);
    expect(deal.metrics.finalCategoryB).toBeGreaterThanOrEqual(minimum);
  });

  test("relaxes final strength before using the safety fallback", () => {
    const relaxedOnly = completeCandidate(
      ["SK", "SQ"],
      ["HA", "H8"],
      ["SJ", "DT", "C9", "D2", "S8"]
    );
    expect(scoreCandidate(relaxedOnly, { relaxationTier: 0 }).valid).toBe(false);
    expect(scoreCandidate(relaxedOnly, { relaxationTier: 1 }).valid).toBe(true);

    const deal = generateOverdriveDeal({ candidates: [relaxedOnly] });
    expect(deal.metrics).toMatchObject({ fallback: false, degraded: true, relaxationTier: 1 });
  });

  test("has a bounded crypto-random fallback when no candidates can be generated", () => {
    const deal = generateOverdriveDeal({ candidateCount: 0 });
    expect(deal.metrics).toMatchObject({
      fallback: true,
      relaxationTier: 3,
      candidateCountRequested: 0,
      generatedCandidates: 0,
    });
    expect(deal.deck).toHaveLength(52);
    expect(new Set(deal.deck.map((card) => card.code)).size).toBe(52);
  });

  test("does not expose the future dramatic type in the public in-hand profile", () => {
    const deal = generateOverdriveDeal({ candidateCount: 200 });
    const hidden = getPublicOverdriveProfile(deal.profile);
    const revealed = getPublicOverdriveProfile(deal.profile, { revealed: true });
    expect(hidden).not.toHaveProperty("type");
    expect(revealed.type).toBe(deal.profile.type);
  });

  test("does not pin the winner to a seat", () => {
    const winners = { A: 0, B: 0 };
    for (let i = 0; i < 24; i += 1) {
      const deal = generateOverdriveDeal({ candidateCount: 180 });
      if (!deal.metrics.fallback) winners[deal.metrics.winner] += 1;
    }
    expect(winners.A).toBeGreaterThan(2);
    expect(winners.B).toBeGreaterThan(2);
  });
});
