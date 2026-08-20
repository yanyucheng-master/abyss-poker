const RANKS = Object.freeze(["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"]);
const RANK_LABEL = Object.freeze({
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
  T: "10", J: "J", Q: "Q", K: "K", A: "A",
});
const SUIT_LABEL = Object.freeze({ S: "♠", H: "♥", C: "♣", D: "♦" });

const PERCEPTION_CATEGORIES = Object.freeze({
  COLOR: Object.freeze({ id: "COLOR", label: "颜色", weight: 1 }),
  SUIT: Object.freeze({ id: "SUIT", label: "花色", weight: 1 }),
  PAIR: Object.freeze({ id: "PAIR", label: "对子", weight: 1 }),
  CONNECTED: Object.freeze({ id: "CONNECTED", label: "连张", weight: 1 }),
  RANK: Object.freeze({ id: "RANK", label: "具体点数", weight: 1 }),
  HOLE_SUIT_MATCH: Object.freeze({ id: "HOLE_SUIT_MATCH", label: "底牌同色", weight: 1 }),
  BOARD_RELATION: Object.freeze({ id: "BOARD_RELATION", label: "与公共牌关系", weight: 1 }),
  MADE: Object.freeze({ id: "MADE", label: "成牌状态", weight: 1 }),
  DRAW: Object.freeze({ id: "DRAW", label: "听牌状态", weight: 1 }),
});

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

function makeFact({
  id, category, axis, domain, evaluate, yes, no, requiresHole = false,
}) {
  return { id, category, axis, domain, evaluate, yes, no, requiresHole };
}

function buildPerceptionFacts(room, observer, target, { holeProtected = false } = {}) {
  const hole = target?.cards || [];
  const board = room?.communityCards || [];
  const known = observerKnownCodes(observer, room);
  const facts = [];

  if (!holeProtected && hole.length >= 2) {
    facts.push(makeFact({
      id: "suited",
      category: PERCEPTION_CATEGORIES.HOLE_SUIT_MATCH.id,
      axis: "hole.suited",
      domain: "hole",
      evaluate: () => hole[0].suit === hole[1].suit,
      yes: "对手两张底牌同色。",
      no: "对手两张底牌不同色。",
    }));
    facts.push(makeFact({
      id: "pocket-pair",
      category: PERCEPTION_CATEGORIES.PAIR.id,
      axis: "hole.pocketPair",
      domain: "hole",
      evaluate: () => hole[0].rank === hole[1].rank,
      yes: "对手持有口袋对子。",
      no: "对手没有口袋对子。",
    }));
    facts.push(makeFact({
      id: "connected",
      category: PERCEPTION_CATEGORIES.CONNECTED.id,
      axis: "hole.connected",
      domain: "hole",
      evaluate: () => isConnected(hole[0], hole[1]),
      yes: "对手底牌是连张。",
      no: "对手底牌不是连张。",
    }));
    facts.push(makeFact({
      id: "near-connected",
      category: PERCEPTION_CATEGORIES.CONNECTED.id,
      axis: "hole.nearConnected",
      domain: "hole",
      evaluate: () => isNearConnected(hole[0], hole[1]),
      yes: "对手底牌是近连张。",
      no: "对手底牌不是近连张。",
    }));
    facts.push(makeFact({
      id: "has-red",
      category: PERCEPTION_CATEGORIES.COLOR.id,
      axis: "hole.hasRed",
      domain: "hole",
      evaluate: () => hole.some((card) => ["H", "D"].includes(card.suit)),
      yes: "对手至少有一张红牌。",
      no: "对手没有红牌。",
    }));
    facts.push(makeFact({
      id: "has-black",
      category: PERCEPTION_CATEGORIES.COLOR.id,
      axis: "hole.hasBlack",
      domain: "hole",
      evaluate: () => hole.some((card) => ["S", "C"].includes(card.suit)),
      yes: "对手至少有一张黑牌。",
      no: "对手没有黑牌。",
    }));
    ["S", "H", "C", "D"].forEach((suit) => {
      facts.push(makeFact({
        id: `has-suit-${suit}`,
        category: PERCEPTION_CATEGORIES.SUIT.id,
        axis: `hole.hasSuit.${suit}`,
        domain: "hole",
        evaluate: () => hole.some((card) => card.suit === suit),
        yes: `对手底牌含${SUIT_LABEL[suit]}。`,
        no: `对手底牌不含${SUIT_LABEL[suit]}。`,
      }));
    });
    RANKS.forEach((rank) => {
      if (rankRemaining(rank, known) <= 0) return;
      facts.push(makeFact({
        id: `has-rank-${rank}`,
        category: PERCEPTION_CATEGORIES.RANK.id,
        axis: `hole.hasRank.${rank}`,
        domain: "hole",
        evaluate: () => hole.some((card) => card.rank === rank),
        yes: `对方可能有${RANK_LABEL[rank]}。`,
        no: `对方没有${RANK_LABEL[rank]}。`,
      }));
    });
  }

  if (board.length >= 3 && !holeProtected) {
    facts.push(makeFact({
      id: "board-pair",
      category: PERCEPTION_CATEGORIES.BOARD_RELATION.id,
      axis: "board.pairWithHole",
      domain: "board",
      requiresHole: true,
      evaluate: () => boardPairWithHole(hole, board),
      yes: "对手底牌与公共牌形成对子。",
      no: "对手底牌尚未与公共牌成对。",
    }));
    facts.push(makeFact({
      id: "made-hand",
      category: PERCEPTION_CATEGORIES.MADE.id,
      axis: "board.madeHand",
      domain: "board",
      requiresHole: true,
      evaluate: () => madeHandLikely(hole, board),
      yes: "对手当前已有成牌倾向。",
      no: "对手当前还没有明显成牌。",
    }));
    facts.push(makeFact({
      id: "straight-draw",
      category: PERCEPTION_CATEGORIES.DRAW.id,
      axis: "board.straightDraw",
      domain: "board",
      requiresHole: true,
      evaluate: () => straightDrawLikely(hole, board),
      yes: "对手存在顺子听牌倾向。",
      no: "对手没有明显的顺子听牌倾向。",
    }));
    facts.push(makeFact({
      id: "flush-draw",
      category: PERCEPTION_CATEGORIES.DRAW.id,
      axis: "board.flushDraw",
      domain: "board",
      requiresHole: true,
      evaluate: () => flushDrawLikely(hole, board),
      yes: "对手存在同花听牌倾向。",
      no: "对手没有明显的同花听牌倾向。",
    }));
  }

  return facts.map((fact) => {
    fact.truth = Boolean(fact.evaluate());
    return fact;
  });
}

function claimedAtoms(fact, truthful) {
  const atoms = { [fact.axis]: Boolean(truthful) };
  if (fact.axis === "hole.hasRed" && !truthful) {
    atoms["hole.hasSuit.H"] = false;
    atoms["hole.hasSuit.D"] = false;
  }
  if (fact.axis === "hole.hasBlack" && !truthful) {
    atoms["hole.hasSuit.S"] = false;
    atoms["hole.hasSuit.C"] = false;
  }
  if (fact.axis === "hole.hasSuit.H" && truthful) atoms["hole.hasRed"] = true;
  if (fact.axis === "hole.hasSuit.D" && truthful) atoms["hole.hasRed"] = true;
  if (fact.axis === "hole.hasSuit.S" && truthful) atoms["hole.hasBlack"] = true;
  if (fact.axis === "hole.hasSuit.C" && truthful) atoms["hole.hasBlack"] = true;
  if (fact.axis === "hole.pocketPair" && truthful) {
    atoms["hole.connected"] = false;
    atoms["hole.nearConnected"] = false;
  }
  if (fact.axis === "hole.connected" && truthful) atoms["hole.pocketPair"] = false;
  if (fact.axis === "hole.nearConnected" && truthful) atoms["hole.pocketPair"] = false;
  return atoms;
}

function mergeHistoryAtoms(history = []) {
  return (history || []).reduce((known, entry) => {
    Object.assign(known, entry.atoms || {});
    return known;
  }, {});
}

function atomsConflict(known, atoms) {
  return Object.keys(atoms || {}).some((key) => (
    Object.prototype.hasOwnProperty.call(known, key) && known[key] !== atoms[key]
  ));
}

function historyHasAxis(history, axis) {
  return (history || []).some((entry) => entry.axis === axis || entry.canonicalKey === axis);
}

function statementClaimsProperty(fact, accurate) {
  return accurate ? Boolean(fact.truth) : !Boolean(fact.truth);
}

function canEmitFact(fact, accurate, history) {
  if (!fact) return false;
  if (historyHasAxis(history, fact.axis)) return false;
  const claimsProperty = statementClaimsProperty(fact, accurate);
  return !atomsConflict(mergeHistoryAtoms(history), claimedAtoms(fact, claimsProperty));
}

function groupFactsByCategory(facts) {
  const grouped = new Map();
  (facts || []).forEach((fact) => {
    const key = fact.category || "UNKNOWN";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(fact);
  });
  return grouped;
}

function pickWeighted(items, weightOf, random) {
  if (!items.length) return null;
  const total = items.reduce((sum, item) => sum + Math.max(0, weightOf(item)), 0);
  if (total <= 0) return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
  let ticket = random() * total;
  for (const item of items) {
    ticket -= Math.max(0, weightOf(item));
    if (ticket <= 0) return item;
  }
  return items[items.length - 1];
}

function categoryWeight(categoryId) {
  return PERCEPTION_CATEGORIES[categoryId]?.weight || 1;
}

function pickFactFromCategory(facts, categoryId, accurate, history, random) {
  const pool = facts.filter((fact) => fact.category === categoryId && canEmitFact(fact, accurate, history));
  if (!pool.length) return null;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

/**
 * 先按固定权重选择信息类别，再掷 75% 真 / 25% 假，最后在该类别内生成命题。
 * 真：输出与牌面一致的 yes/no。假：输出相反句子，且该命题在当前牌面确实不成立。
 * 若该类别无法满足已抽中的真假，只改选其他类别，绝不改抽反极性。
 */
function pickPerceptionStatement(facts, { truthChance, random, history = [] } = {}) {
  const liveFacts = Array.isArray(facts) ? facts : [];
  if (!liveFacts.length || typeof random !== "function") return null;

  const grouped = groupFactsByCategory(liveFacts);
  const categoryIds = [...grouped.keys()];
  const usable = categoryIds.filter((categoryId) => (
    grouped.get(categoryId).some((fact) => (
      canEmitFact(fact, true, history) || canEmitFact(fact, false, history)
    ))
  ));
  if (!usable.length) return null;

  const chosenCategory = pickWeighted(usable, categoryWeight, random);
  if (!chosenCategory) return null;
  const accurate = random() < Number(truthChance);

  const order = [chosenCategory, ...usable.filter((id) => id !== chosenCategory)];
  let chosen = null;
  let usedCategory = chosenCategory;
  for (const categoryId of order) {
    chosen = pickFactFromCategory(liveFacts, categoryId, accurate, history, random);
    if (chosen) {
      usedCategory = categoryId;
      break;
    }
  }
  if (!chosen) return null;

  const claimsProperty = statementClaimsProperty(chosen, accurate);
  return {
    factId: chosen.id,
    category: usedCategory,
    axis: chosen.axis,
    canonicalKey: chosen.axis,
    domain: chosen.domain,
    truthful: accurate,
    message: claimsProperty ? chosen.yes : chosen.no,
    atoms: claimedAtoms(chosen, claimsProperty),
  };
}

module.exports = {
  PERCEPTION_CATEGORIES,
  buildPerceptionFacts,
  pickPerceptionStatement,
  claimedAtoms,
  canEmitFact,
  atomsConflict,
  mergeHistoryAtoms,
};
