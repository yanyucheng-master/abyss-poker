"use strict";

const HAND_RANK_BONUS_TABLE_VERSION = "launch-v1";

const HAND_CATEGORY = Object.freeze({
  HIGH_CARD: 1,
  ONE_PAIR: 2,
  TWO_PAIR: 3,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
  ROYAL_FLUSH: 10,
});

const HAND_RANK_BONUS = Object.freeze({
  HIGH_CARD: 0,
  ONE_PAIR: 0,
  TWO_PAIR: 0,
  THREE_OF_A_KIND: 25,
  STRAIGHT: 50,
  FLUSH: 75,
  FULL_HOUSE: 100,
  FOUR_OF_A_KIND: 250,
  STRAIGHT_FLUSH: 400,
  ROYAL_FLUSH: 500,
});

const HAND_RANK_BONUS_BY_CATEGORY = Object.freeze({
  [HAND_CATEGORY.HIGH_CARD]: HAND_RANK_BONUS.HIGH_CARD,
  [HAND_CATEGORY.ONE_PAIR]: HAND_RANK_BONUS.ONE_PAIR,
  [HAND_CATEGORY.TWO_PAIR]: HAND_RANK_BONUS.TWO_PAIR,
  [HAND_CATEGORY.THREE_OF_A_KIND]: HAND_RANK_BONUS.THREE_OF_A_KIND,
  [HAND_CATEGORY.STRAIGHT]: HAND_RANK_BONUS.STRAIGHT,
  [HAND_CATEGORY.FLUSH]: HAND_RANK_BONUS.FLUSH,
  [HAND_CATEGORY.FULL_HOUSE]: HAND_RANK_BONUS.FULL_HOUSE,
  [HAND_CATEGORY.FOUR_OF_A_KIND]: HAND_RANK_BONUS.FOUR_OF_A_KIND,
  [HAND_CATEGORY.STRAIGHT_FLUSH]: HAND_RANK_BONUS.STRAIGHT_FLUSH,
  [HAND_CATEGORY.ROYAL_FLUSH]: HAND_RANK_BONUS.ROYAL_FLUSH,
});

const HAND_RANK_LABELS = Object.freeze({
  [HAND_CATEGORY.HIGH_CARD]: "高牌",
  [HAND_CATEGORY.ONE_PAIR]: "一对",
  [HAND_CATEGORY.TWO_PAIR]: "两对",
  [HAND_CATEGORY.THREE_OF_A_KIND]: "三条",
  [HAND_CATEGORY.STRAIGHT]: "顺子",
  [HAND_CATEGORY.FLUSH]: "同花",
  [HAND_CATEGORY.FULL_HOUSE]: "葫芦",
  [HAND_CATEGORY.FOUR_OF_A_KIND]: "四条",
  [HAND_CATEGORY.STRAIGHT_FLUSH]: "同花顺",
  [HAND_CATEGORY.ROYAL_FLUSH]: "皇家同花顺",
});

function isHandRankBonusEnabled(room) {
  if (!room) return true;
  if (room.handRankBonusEnabled === false) return false;
  if (room.handRankBonusTableVersion === "off") return false;
  return true;
}

function getHandRankBonusValue(category, room) {
  if (!isHandRankBonusEnabled(room)) return 0;
  const key = Number(category);
  if (!Number.isInteger(key)) return 0;
  const value = HAND_RANK_BONUS_BY_CATEGORY[key];
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function getHandRankLabel(category) {
  return HAND_RANK_LABELS[Number(category)] || "";
}

module.exports = {
  HAND_RANK_BONUS_TABLE_VERSION,
  HAND_CATEGORY,
  HAND_RANK_BONUS,
  HAND_RANK_BONUS_BY_CATEGORY,
  HAND_RANK_LABELS,
  isHandRankBonusEnabled,
  getHandRankBonusValue,
  getHandRankLabel,
};
