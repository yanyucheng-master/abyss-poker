const { pickBestFive, compareEvaluatedHands } = require("../game/handEvaluator");

function c(code) {
  const suit = code[0];
  const rank = code.slice(1);
  const rankMap = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
  return { code, suit, rank, value: rankMap[rank] || Number(rank) };
}

describe("handEvaluator", () => {
  test("识别同花顺", () => {
    const cards = ["SA", "SK", "SQ", "SJ", "ST", "D2", "C3"].map(c);
    const best = pickBestFive(cards);
    expect(best.category).toBe(10);
    expect(best.handName).toContain("皇家");
  });

  test("不比较花色，完全同牌点为平局", () => {
    const a = pickBestFive(["SA", "DA", "CK", "DQ", "HJ", "D9", "C2"].map(c));
    const b = pickBestFive(["HA", "CA", "SK", "CQ", "DJ", "S9", "D2"].map(c));
    expect(compareEvaluatedHands(a, b)).toBe(0);
  });

  test("顺子大于三条", () => {
    const straight = pickBestFive(["S9", "D8", "C7", "H6", "S5", "DA", "C2"].map(c));
    const trips = pickBestFive(["SA", "DA", "CA", "H4", "S8", "D7", "C2"].map(c));
    expect(compareEvaluatedHands(straight, trips)).toBe(1);
  });
});
