const RANKS = Object.freeze(["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"]);
const RANK_LABEL = Object.freeze({
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
  T: "10", J: "J", Q: "Q", K: "K", A: "A",
});
const SUIT_LABEL = Object.freeze({ S: "♠", H: "♥", C: "♣", D: "♦" });

function cardCodes(cards = []) {
  return (cards || []).map((card) => card?.code).filter(Boolean);
}

function observerKnownCodes(observer, room) {
  return new Set([
    ...cardCodes(observer?.cards),
    ...cardCodes(room?.communityCards),
  ]);
}

function rankRemaining(rank, known) {
  const total = ["S", "H", "C", "D"].map((suit) => suit + rank);
  return total.filter((code) => !known.has(code)).length;
}

function isConnected(a, b) {
  const gap = Math.abs((Number(a?.value) || 0) - (Number(b?.value) || 0));
  if (gap === 1) return true;
  const ranks = [a?.rank, b?.rank];
  return ranks.includes("A") && ranks.includes("2");
}

function isNearConnected(a, b) {
  return Math.abs((Number(a?.value) || 0) - (Number(b?.value) || 0)) === 2;
}

function boardPairWithHole(hole, board) {
  const holeRanks = new Set((hole || []).map((card) => card?.rank));
  return (board || []).some((card) => holeRanks.has(card?.rank));
}

function madeHandLikely(hole, board) {
  if (!board?.length) return false;
  const values = [...(hole || []), ...board].map((card) => card?.rank);
  const counts = values.reduce((map, rank) => {
    map[rank] = (map[rank] || 0) + 1;
    return map;
  }, {});
  return Object.values(counts).some((count) => count >= 2);
}

function flushDrawLikely(hole, board) {
  if ((board || []).length < 3) return false;
  const suits = [...(hole || []), ...board].map((card) => card?.suit);
  const counts = suits.reduce((map, suit) => {
    map[suit] = (map[suit] || 0) + 1;
    return map;
  }, {});
  return Object.values(counts).some((count) => count >= 4);
}

function straightDrawLikely(hole, board) {
  if ((board || []).length < 3) return false;
  const values = [...new Set([...(hole || []), ...board].map((card) => Number(card?.value) || 0))]
    .sort((a, b) => a - b);
  if (values.includes(14)) values.unshift(1);
  for (let i = 0; i < values.length; i += 1) {
    const window = values.filter((value) => value >= values[i] && value <= values[i] + 4);
    if (window.length >= 4) return true;
  }
  return false;
}

function buildPerceptionFacts(room, observer, target, { holeProtected = false } = {}) {
  const hole = target?.cards || [];
  const board = room?.communityCards || [];
  const known = observerKnownCodes(observer, room);
  const facts = [];

  if (!holeProtected && hole.length >= 2) {
    facts.push({
      id: "suited",
      domain: "hole",
      evaluate: () => hole[0].suit === hole[1].suit,
      yes: "对手两张底牌同色。",
      no: "对手两张底牌不同色。",
    });
    facts.push({
      id: "unsuited",
      domain: "hole",
      evaluate: () => hole[0].suit !== hole[1].suit,
      yes: "对手两张底牌不同色。",
      no: "对手两张底牌同色。",
    });
    facts.push({
      id: "pocket-pair",
      domain: "hole",
      evaluate: () => hole[0].rank === hole[1].rank,
      yes: "对手持有口袋对子。",
      no: "对手没有口袋对子。",
    });
    facts.push({
      id: "connected",
      domain: "hole",
      evaluate: () => isConnected(hole[0], hole[1]),
      yes: "对手底牌是连张。",
      no: "对手底牌不是连张。",
    });
    facts.push({
      id: "near-connected",
      domain: "hole",
      evaluate: () => isNearConnected(hole[0], hole[1]),
      yes: "对手底牌是近连张。",
      no: "对手底牌不是近连张。",
    });
    facts.push({
      id: "has-red",
      domain: "hole",
      evaluate: () => hole.some((card) => ["H", "D"].includes(card.suit)),
      yes: "对手至少有一张红牌。",
      no: "对手没有红牌。",
    });
    facts.push({
      id: "has-black",
      domain: "hole",
      evaluate: () => hole.some((card) => ["S", "C"].includes(card.suit)),
      yes: "对手至少有一张黑牌。",
      no: "对手没有黑牌。",
    });
    ["S", "H", "C", "D"].forEach((suit) => {
      facts.push({
        id: `has-suit-${suit}`,
        domain: "hole",
        evaluate: () => hole.some((card) => card.suit === suit),
        yes: `对手底牌含${SUIT_LABEL[suit]}。`,
        no: `对手底牌不含${SUIT_LABEL[suit]}。`,
      });
    });
    RANKS.forEach((rank) => {
      if (rankRemaining(rank, known) <= 0) return;
      facts.push({
        id: `has-rank-${rank}`,
        domain: "hole",
        evaluate: () => hole.some((card) => card.rank === rank),
        yes: `对方可能有${RANK_LABEL[rank]}。`,
        no: `对方没有${RANK_LABEL[rank]}。`,
      });
    });
  }

  if (board.length >= 3 && !holeProtected) {
    facts.push({
      id: "board-pair",
      domain: "board",
      requiresHole: true,
      evaluate: () => boardPairWithHole(hole, board),
      yes: "对手底牌与公共牌形成对子。",
      no: "对手底牌尚未与公共牌成对。",
    });
    facts.push({
      id: "made-hand",
      domain: "board",
      requiresHole: true,
      evaluate: () => madeHandLikely(hole, board),
      yes: "对手当前已有成牌倾向。",
      no: "对手当前还没有明显成牌。",
    });
    facts.push({
      id: "straight-draw",
      domain: "board",
      requiresHole: true,
      evaluate: () => straightDrawLikely(hole, board),
      yes: "对手存在顺子听牌倾向。",
      no: "对手没有明显的顺子听牌倾向。",
    });
    facts.push({
      id: "flush-draw",
      domain: "board",
      requiresHole: true,
      evaluate: () => flushDrawLikely(hole, board),
      yes: "对手存在同花听牌倾向。",
      no: "对手没有明显的同花听牌倾向。",
    });
  }

  return facts.filter((fact) => {
    const truth = Boolean(fact.evaluate());
    fact.truth = truth;
    return true;
  });
}

function pickPerceptionStatement(facts, { truthChance, random }) {
  const truthful = random() < truthChance;
  const pool = facts.filter((fact) => fact.truth === truthful);
  if (!pool.length) return null;
  const chosen = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  if (!chosen) return null;
  return {
    factId: chosen.id,
    domain: chosen.domain,
    truthful,
    message: truthful ? chosen.yes : chosen.no,
  };
}

module.exports = {
  buildPerceptionFacts,
  pickPerceptionStatement,
};
