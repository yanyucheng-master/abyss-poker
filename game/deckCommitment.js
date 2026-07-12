const crypto = require("crypto");
const { createDeck } = require("../utils/deck");

const EXPECTED_CODES = new Set(createDeck().map((card) => card.code));

function cardCode(card) {
  if (typeof card === "string") return card;
  if (card && typeof card.code === "string") return card.code;
  if (card && typeof card.suit === "string" && typeof card.rank === "string") {
    return `${card.suit}${card.rank}`;
  }
  throw new TypeError("牌堆中存在无法序列化的牌");
}

function serializeDeck(deck) {
  if (!Array.isArray(deck)) throw new TypeError("deck 必须是数组");
  return deck.map(cardCode).join(",");
}

function validateCompleteDeck(deck) {
  if (!Array.isArray(deck) || deck.length !== 52) return false;
  let codes;
  try {
    codes = deck.map(cardCode);
  } catch (_error) {
    return false;
  }
  const unique = new Set(codes);
  return unique.size === 52 && codes.every((code) => EXPECTED_CODES.has(code));
}

function assertCompleteDeck(deck) {
  if (!validateCompleteDeck(deck)) {
    throw new RangeError("承诺牌堆必须包含 52 张唯一且合法的牌");
  }
}

function computeDeckCommitment({ handId, mode, skillMode = "off", deck, serializedDeck, nonce }) {
  if (handId === undefined || handId === null || String(handId).length === 0) {
    throw new TypeError("handId 不能为空");
  }
  if (mode === undefined || mode === null || String(mode).length === 0) {
    throw new TypeError("mode 不能为空");
  }
  if (nonce === undefined || nonce === null || String(nonce).length === 0) {
    throw new TypeError("nonce 不能为空");
  }
  const deckText = serializedDeck === undefined ? serializeDeck(deck) : String(serializedDeck);
  const skill = skillMode === undefined || skillMode === null || skillMode === "" ? "off" : String(skillMode);
  return crypto
    .createHash("sha256")
    .update(`${String(handId)}${String(mode)}${skill}${deckText}${String(nonce)}`, "utf8")
    .digest("hex");
}

function createDeckCommitment({
  handId,
  mode,
  skillMode = "off",
  deck,
  nonce = crypto.randomBytes(32).toString("hex"),
}) {
  assertCompleteDeck(deck);
  const serializedDeck = serializeDeck(deck);
  const commitment = computeDeckCommitment({ handId, mode, skillMode, serializedDeck, nonce });
  return {
    handId: String(handId),
    mode: String(mode),
    skillMode: String(skillMode || "off"),
    commitment,
    nonce: String(nonce),
    serializedDeck,
  };
}

function safeHashEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (!/^[a-f\d]{64}$/i.test(left) || !/^[a-f\d]{64}$/i.test(right)) return false;
  const a = Buffer.from(left.toLowerCase(), "hex");
  const b = Buffer.from(right.toLowerCase(), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyDeckCommitment({
  handId,
  mode,
  skillMode = "off",
  deck,
  serializedDeck,
  nonce,
  commitment,
}) {
  try {
    if (deck !== undefined && !validateCompleteDeck(deck)) return false;
    const verifiedSerializedDeck = deck !== undefined ? serializeDeck(deck) : serializedDeck;
    const expected = computeDeckCommitment({
      handId,
      mode,
      skillMode,
      serializedDeck: verifiedSerializedDeck,
      nonce,
    });
    return safeHashEqual(expected, commitment);
  } catch (_error) {
    return false;
  }
}

function buildCommitmentPayload(record) {
  return {
    handId: record.handId,
    mode: record.mode,
    skillMode: record.skillMode || "off",
    commitment: record.commitment,
  };
}

function buildRevealPayload(record, deck) {
  assertCompleteDeck(deck);
  return {
    handId: record.handId,
    mode: record.mode,
    skillMode: record.skillMode || "off",
    nonce: record.nonce,
    deck: [...deck],
    commitment: record.commitment,
  };
}

module.exports = {
  serializeDeck,
  validateCompleteDeck,
  computeDeckCommitment,
  createDeckCommitment,
  verifyDeckCommitment,
  buildCommitmentPayload,
  buildRevealPayload,
};
