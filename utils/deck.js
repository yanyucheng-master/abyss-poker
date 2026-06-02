const { shuffle } = require("./shuffle");

function rankValue(rank) {
  if (rank === "A") return 14;
  if (rank === "K") return 13;
  if (rank === "Q") return 12;
  if (rank === "J") return 11;
  if (rank === "T") return 10;
  return Number(rank);
}

function createDeck() {
  const suits = ["S", "H", "C", "D"];
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({
        rank,
        suit,
        value: rankValue(rank),
        code: `${suit}${rank}`,
      });
    }
  }
  return deck;
}

function createShuffledDeck() {
  return shuffle(createDeck());
}

module.exports = { createDeck, createShuffledDeck, rankValue };
