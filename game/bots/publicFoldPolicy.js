/**
 * 仅使用该玩家合法可见信息的简化弃牌策略。
 * 禁止读取对方底牌、隐藏技能、完整牌堆、未发出公共牌或真实隐藏 equity。
 */
const { createDeck } = require("../../utils/deck");
const { pickBestFive, compareEvaluatedHands } = require("../handEvaluator");

const STREET_PRESSURE = Object.freeze({
  pre_flop: 0.22,
  flop: 0.28,
  turn: 0.32,
  river: 0.36,
});

const FULL_DECK = Object.freeze(createDeck().map((card) => Object.freeze({ ...card })));

function rankValue(card) {
  return Number(card?.value) || 0;
}

function isPairedHole(cards) {
  return Boolean(cards?.[0] && cards[1] && cards[0].rank === cards[1].rank);
}

function suitedHole(cards) {
  return Boolean(cards?.[0] && cards[1] && cards[0].suit === cards[1].suit);
}

function holeGap(cards) {
  if (!cards?.[0] || !cards[1]) return 13;
  return Math.abs(rankValue(cards[0]) - rankValue(cards[1]));
}

function chenLike(cards) {
  if (!cards || cards.length < 2) return 0;
  const high = Math.max(rankValue(cards[0]), rankValue(cards[1]));
  const low = Math.min(rankValue(cards[0]), rankValue(cards[1]));
  let score = high >= 14 ? 10 : high >= 13 ? 8 : high >= 12 ? 7 : high >= 11 ? 6 : high / 2;
  if (isPairedHole(cards)) score = Math.max(5, score * 2);
  if (suitedHole(cards)) score += 2;
  const gap = holeGap(cards);
  if (gap === 1) score += 1;
  else if (gap >= 3) score -= Math.min(3, gap - 2);
  if (high >= 12 && low <= 6 && !isPairedHole(cards)) score -= 1;
  return score;
}

function boardPairOrBetter(hero, board) {
  if (!board?.length || !hero?.length) return false;
  const ranks = [...hero, ...board].map((card) => card.rank);
  const counts = ranks.reduce((map, rank) => {
    map[rank] = (map[rank] || 0) + 1;
    return map;
  }, {});
  return Object.values(counts).some((count) => count >= 2);
}

function flushDraw(hero, board) {
  if ((board || []).length < 3) return false;
  const suits = [...hero, ...board].map((card) => card.suit);
  const counts = suits.reduce((map, suit) => {
    map[suit] = (map[suit] || 0) + 1;
    return map;
  }, {});
  return Object.values(counts).some((count) => count >= 4);
}

function unknownPool(hero, board) {
  const used = new Set([...(hero || []), ...(board || [])].map((card) => card.code));
  return FULL_DECK.filter((card) => !used.has(card.code));
}

function showdownScore(hero, villain, board) {
  const handA = pickBestFive([...(hero || []), ...board]);
  const handB = pickBestFive([...(villain || []), ...board]);
  if (!handA || !handB) return 0.5;
  const cmp = compareEvaluatedHands(handA, handB);
  if (cmp > 0) return 1;
  if (cmp < 0) return 0;
  return 0.5;
}

function shuffleInPlace(values, random) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
}

/**
 * 对随机对手底牌做公开蒙特卡洛，只使用自己底牌 + 已公开公共牌 + 其余未知牌。
 */
function estimateVsRandom(hero, board, random, samples = 6) {
  const pool = unknownPool(hero, board);
  if (pool.length < 2) return 0.5;
  const needBoard = Math.max(0, 5 - (board || []).length);
  if (pool.length < 2 + needBoard) return 0.5;
  let total = 0;
  for (let i = 0; i < samples; i += 1) {
    const draw = shuffleInPlace(pool.slice(), random);
    const villain = [draw[0], draw[1]];
    const fullBoard = (board || []).slice();
    let cursor = 2;
    while (fullBoard.length < 5 && cursor < draw.length) {
      fullBoard.push(draw[cursor]);
      cursor += 1;
    }
    total += showdownScore(hero, villain, fullBoard);
  }
  return total / samples;
}

function publicMadeStrength(hero, board) {
  if (!board?.length) return chenLike(hero) / 20;
  let score = 0.18;
  if (boardPairOrBetter(hero, board)) score = 0.52;
  if (flushDraw(hero, board)) score = Math.max(score, 0.38);
  const maxHero = Math.max(...hero.map(rankValue));
  if (board.some((card) => card.rank === hero[0]?.rank || card.rank === hero[1]?.rank) && maxHero >= 12) {
    score += 0.08;
  }
  return Math.max(0.05, Math.min(0.9, score));
}

function buildPublicView(player, room, context = {}) {
  return {
    heroCards: player.cards,
    board: room.communityCards,
    toCall: context.toCall,
    pot: room.pot,
    heroChips: player.chips,
    street: room.phase,
    canRaise: context.canRaise,
    streetBet: player.streetBet,
    currentBet: room.currentBet,
    random: context.random,
  };
}

/**
 * @param {object} view 只允许公开/自身字段。若传入 opponentCards，策略不得读取。
 */
function decidePublicAction(view) {
  const heroCards = view.heroCards || [];
  const board = view.board || [];
  const toCall = Math.max(0, Number(view.toCall) || 0);
  const pot = Math.max(0, Number(view.pot) || 0);
  const heroChips = Math.max(0, Number(view.heroChips) || 0);
  const street = view.street || "pre_flop";
  const canRaise = Boolean(view.canRaise);
  const streetBet = Math.max(0, Number(view.streetBet) || 0);
  const currentBet = Math.max(0, Number(view.currentBet) || 0);
  const random = typeof view.random === "function" ? view.random : Math.random;
  const potOdds = toCall / Math.max(1, pot + toCall);
  const chen = chenLike(heroCards);
  const pressure = STREET_PRESSURE[street] || 0.3;
  const commit = toCall / Math.max(1, heroChips);
  const maxRaiseTo = heroChips + streetBet;

  if (toCall > 0) {
    if (street === "pre_flop") {
      const pair = isPairedHole(heroCards);
      if (!pair && chen < 5) return { action: "fold", reason: "complete-trash" };
      if (!pair && chen < 11 && toCall >= 100) return { action: "fold", reason: "weak-vs-raise" };
      if ((pair || chen >= 16) && canRaise && toCall <= 50) {
        return { action: "raise", size: Math.min(maxRaiseTo, Math.max(currentBet * 2, currentBet + 100)) };
      }
      return { action: "call", reason: "playable-hole" };
    }
    const equity = estimateVsRandom(heroCards, board, random);
    const hasDraw = boardPairOrBetter(heroCards, board) || flushDraw(heroCards, board);
    if (equity < 0.28 && !hasDraw) return { action: "fold", reason: "low-public-equity" };
    if (equity + 0.04 < potOdds && equity < 0.42) return { action: "fold", reason: "price-too-high" };
    if (!hasDraw && (potOdds > pressure || commit > 0.22) && equity < 0.45) {
      return { action: "fold", reason: "no-showdown-value" };
    }
    if (equity >= 0.66 && canRaise) {
      return { action: "raise", size: Math.min(maxRaiseTo, Math.max(currentBet * 2, Math.floor(pot * 0.7))) };
    }
    return { action: "call", reason: "odds-ok" };
  }

  if (street === "pre_flop" && chen >= 16 && canRaise) {
    return { action: "raise", size: Math.min(maxRaiseTo, Math.max(100, currentBet + 100, Math.floor(pot * 0.8))) };
  }
  if (street !== "pre_flop" && canRaise) {
    const equity = estimateVsRandom(heroCards, board, random);
    if (equity >= 0.68) {
      return { action: "raise", size: Math.min(maxRaiseTo, Math.max(currentBet + 50, Math.floor(pot * 0.55))) };
    }
  }
  return { action: "check", reason: "no-bet" };
}

function wantsDefense(view) {
  const toCall = Math.max(0, Number(view.toCall) || 0);
  if (toCall <= 0) return false;
  if ((view.street || "pre_flop") === "pre_flop") return chenLike(view.heroCards) < 14;
  return publicMadeStrength(view.heroCards, view.board) < 0.5;
}

function wantsIntel(view) {
  const chen = chenLike(view.heroCards);
  if ((view.street || "pre_flop") === "pre_flop") return chen >= 10 && chen <= 16;
  const strength = publicMadeStrength(view.heroCards, view.board);
  return strength >= 0.28 && strength <= 0.62;
}

function wantsClairvoyance(view) {
  return Math.max(0, Number(view.toCall) || 0) > 0 || view.street === "flop" || view.street === "turn";
}

function wantsBloodBattle(view) {
  if ((view.street || "pre_flop") === "pre_flop") return chenLike(view.heroCards) >= 16;
  return publicMadeStrength(view.heroCards, view.board) >= 0.62;
}

module.exports = {
  decidePublicAction,
  buildPublicView,
  wantsDefense,
  wantsIntel,
  wantsClairvoyance,
  wantsBloodBattle,
  chenLike,
  publicMadeStrength,
  estimateVsRandom,
};
