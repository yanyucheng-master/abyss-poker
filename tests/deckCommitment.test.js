const crypto = require("crypto");
const { createDeck } = require("../utils/deck");
const {
  serializeDeck,
  validateCompleteDeck,
  computeDeckCommitment,
  createDeckCommitment,
  verifyDeckCommitment,
  buildCommitmentPayload,
  buildRevealPayload,
} = require("../game/deckCommitment");

describe("deck commitment", () => {
  test("serializes exactly as comma-separated card codes", () => {
    expect(serializeDeck(createDeck().slice(0, 3))).toBe("S2,S3,S4");
  });

  test("uses the specified SHA-256 concatenation", () => {
    const deck = createDeck();
    const input = {
      handId: "hand-42",
      mode: "overdrive",
      skillMode: "off",
      deck,
      nonce: "known-nonce",
    };
    const expected = crypto
      .createHash("sha256")
      .update(`hand-42overdriveoff${deck.map((card) => card.code).join(",")}known-nonce`, "utf8")
      .digest("hex");
    expect(computeDeckCommitment(input)).toBe(expected);
  });

  test("creates a private reveal record and a minimal public payload", () => {
    const deck = createDeck();
    const record = createDeckCommitment({ handId: "h-1", mode: "overdrive", deck });
    const publicPayload = buildCommitmentPayload(record);
    const revealPayload = buildRevealPayload(record, deck);

    expect(record.nonce).toMatch(/^[a-f\d]{64}$/);
    expect(record.commitment).toMatch(/^[a-f\d]{64}$/);
    expect(publicPayload).toEqual({
      handId: "h-1",
      mode: "overdrive",
      skillMode: "off",
      commitment: record.commitment,
    });
    expect(publicPayload).not.toHaveProperty("nonce");
    expect(publicPayload).not.toHaveProperty("deck");
    expect(revealPayload.deck).toHaveLength(52);
  });

  test("verifies the reveal and rejects every committed field after tampering", () => {
    const deck = createDeck();
    const record = createDeckCommitment({ handId: "h-2", mode: "overdrive", deck });
    const proof = { ...record, deck };
    expect(verifyDeckCommitment(proof)).toBe(true);

    const swapped = [...deck];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(verifyDeckCommitment({ ...proof, deck: swapped })).toBe(false);
    expect(verifyDeckCommitment({ ...proof, nonce: `${record.nonce}x` })).toBe(false);
    expect(verifyDeckCommitment({ ...proof, mode: "standard" })).toBe(false);
    expect(verifyDeckCommitment({ ...proof, handId: "h-3" })).toBe(false);
    expect(verifyDeckCommitment({ ...proof, commitment: "0".repeat(64) })).toBe(false);
  });

  test("rejects duplicate or incomplete decks", () => {
    const deck = createDeck();
    const duplicate = [...deck];
    duplicate[51] = duplicate[0];
    expect(validateCompleteDeck(duplicate)).toBe(false);
    expect(() => createDeckCommitment({ handId: "h", mode: "overdrive", deck: duplicate })).toThrow();
    expect(validateCompleteDeck(deck.slice(1))).toBe(false);
  });

  test("generates independent nonces for otherwise identical commitments", () => {
    const deck = createDeck();
    const first = createDeckCommitment({ handId: "same", mode: "overdrive", deck });
    const second = createDeckCommitment({ handId: "same", mode: "overdrive", deck });
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.commitment).not.toBe(second.commitment);
  });
});
