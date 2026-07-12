const GAME_MODE = Object.freeze({
  STANDARD: "standard",
  OVERDRIVE: "overdrive",
});

const GAME_MODE_INFO = Object.freeze({
  [GAME_MODE.STANDARD]: Object.freeze({
    id: GAME_MODE.STANDARD,
    name: "标准局",
    description: "完整随机洗牌的标准双人德州扑克。",
  }),
  [GAME_MODE.OVERDRIVE]: Object.freeze({
    id: GAME_MODE.OVERDRIVE,
    name: "高爆局",
    description: "高潜力起手牌、强对抗公共牌与河牌变局；下注规则与标准局一致。",
  }),
});

function isGameMode(value) {
  return value === GAME_MODE.STANDARD || value === GAME_MODE.OVERDRIVE;
}

function normalizeGameMode(value) {
  if (typeof value !== "string") return GAME_MODE.STANDARD;
  const normalized = value.trim().toLowerCase();
  return isGameMode(normalized) ? normalized : GAME_MODE.STANDARD;
}

module.exports = {
  GAME_MODE,
  GAME_MODE_INFO,
  isGameMode,
  normalizeGameMode,
};
