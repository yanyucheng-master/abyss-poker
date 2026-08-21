"use strict";

const INITIAL_STACK = 1000;
const PLAYER_COUNT = 2;
const MATCH_TOTAL_CHIPS = INITIAL_STACK * PLAYER_COUNT;
const SMALL_BLIND = 25;
const BIG_BLIND = 50;

const CHIP_REASON = Object.freeze({
  STANDARD_BET: "STANDARD_BET",
  STANDARD_SHOWDOWN: "STANDARD_SHOWDOWN",
  STANDARD_FOLD: "STANDARD_FOLD",
  STANDARD_SETTLEMENT: "STANDARD_SETTLEMENT",
  HAND_RANK_BONUS_ADJUSTMENT: "HAND_RANK_BONUS_ADJUSTMENT",
  PROBE_BASE_BONUS: "PROBE_BASE_BONUS",
  SKILL_MULTIPLIER_ADJUSTMENT: "SKILL_MULTIPLIER_ADJUSTMENT",
  DEFENSE_ADJUSTMENT: "DEFENSE_ADJUSTMENT",
  DEFENSE_REFUND: "DEFENSE_REFUND",
  LOAN_TRANSFER: "LOAN_TRANSFER",
  LOAN_REPAYMENT: "LOAN_REPAYMENT",
  ENDGAME_CONFISCATION: "ENDGAME_CONFISCATION",
  RETREAT_REFUND: "RETREAT_REFUND",
  UNMATCHED_REFUND: "UNMATCHED_REFUND",
  TIE_SPLIT: "TIE_SPLIT",
  TIE_ODD_CHIP: "TIE_ODD_CHIP",
  LOAN_KILL_POT: "LOAN_KILL_POT",
  LOAN_KILL_REMAINDER: "LOAN_KILL_REMAINDER",
  DISCONNECT_FORFEIT: "DISCONNECT_FORFEIT",
  VOID_TIE: "VOID_TIE",
});

function truncateTowardZero(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.trunc(number);
}

function isSafeNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isLegalPlayerChipAmount(amount) {
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0;
}

function isSafeIntegerEnergy(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function recycleRefund(originalEnergyCost) {
  if (!isSafeNonNegativeInteger(originalEnergyCost)) return 0;
  return Math.floor(originalEnergyCost / 2);
}

function defenseProtectedLoss(lossBeforeDefense) {
  if (!isSafeNonNegativeInteger(lossBeforeDefense)) return 0;
  return Math.floor(lossBeforeDefense / 2);
}

function shouldThrowOnEconomyFault() {
  return process.env.NODE_ENV !== "production";
}

function economyFault(message) {
  const error = new Error(`[CHIP_ECONOMY] ${message}`);
  if (shouldThrowOnEconomyFault()) throw error;
  if (typeof console !== "undefined" && typeof console.error === "function") {
    console.error(error.message);
  }
  return error;
}

function createEconomyState() {
  return {
    version: "INTEGER_ECONOMY_RULE_V1",
    ledger: [],
    terminalSettled: false,
    settledHandId: null,
    lastSettlement: null,
  };
}

function ensureEconomy(room) {
  if (!room) return null;
  if (!room.economy || typeof room.economy !== "object") {
    room.economy = createEconomyState();
  }
  if (!Array.isArray(room.economy.ledger)) room.economy.ledger = [];
  return room.economy;
}

function beginHandEconomy(room) {
  if (!room) return null;
  room.economy = createEconomyState();
  return room.economy;
}

function isHandTerminalSettled(room) {
  if (!room?.economy?.terminalSettled) return false;
  if (!room.handId) return true;
  return room.economy.settledHandId === room.handId;
}

function markHandTerminalSettled(room) {
  const economy = ensureEconomy(room);
  if (!economy) return;
  economy.terminalSettled = true;
  economy.settledHandId = room.handId || null;
}

function chipTotal(room) {
  if (!room) return 0;
  const stacks = (room.players || []).reduce((sum, player) => {
    const chips = player?.chips;
    return sum + (Number.isSafeInteger(chips) ? chips : 0);
  }, 0);
  const pot = Number.isSafeInteger(room.pot) ? room.pot : 0;
  return stacks + pot;
}

function recordLedger(room, entry) {
  const economy = ensureEconomy(room);
  if (!economy) return;
  economy.ledger.push({
    at: Date.now(),
    handId: room.handId || null,
    handNo: room.handNo || 0,
    ...entry,
  });
}

function assertIntegerEconomyState(room) {
  if (!room) throw new Error("[CHIP_ECONOMY] missing room");
  if (!isSafeNonNegativeInteger(room.pot)) {
    throw new Error(`[CHIP_ECONOMY] pot is not a safe non-negative integer: ${room.pot}`);
  }
  (room.players || []).forEach((player, index) => {
    if (!isSafeNonNegativeInteger(player.chips)) {
      throw new Error(`[CHIP_ECONOMY] player[${index}].chips invalid: ${player.chips}`);
    }
    if (player.chips < 0) {
      throw new Error(`[CHIP_ECONOMY] negative chips for ${player.playerId}`);
    }
    if (player.streetBet != null && !isSafeNonNegativeInteger(player.streetBet)) {
      throw new Error(`[CHIP_ECONOMY] streetBet invalid: ${player.streetBet}`);
    }
    if (player.totalBet != null && !isSafeNonNegativeInteger(player.totalBet)) {
      throw new Error(`[CHIP_ECONOMY] totalBet invalid: ${player.totalBet}`);
    }
    const energy = player.skillRuntime?.abyssEnergy;
    if (energy != null && !isSafeIntegerEnergy(energy)) {
      throw new Error(`[CHIP_ECONOMY] energy is not a safe integer: ${energy}`);
    }
    const chipDebt = player.skillRuntime?.chipDebt;
    if (chipDebt != null && !isSafeNonNegativeInteger(chipDebt)) {
      throw new Error(`[CHIP_ECONOMY] chipDebt invalid: ${chipDebt}`);
    }
    const energyDebt = player.skillRuntime?.energyDebt;
    if (energyDebt != null && !isSafeNonNegativeInteger(energyDebt)) {
      throw new Error(`[CHIP_ECONOMY] energyDebt invalid: ${energyDebt}`);
    }
  });
  return true;
}

function assertNoNegativeChips(room) {
  if (!isSafeNonNegativeInteger(room?.pot)) {
    throw new Error(`[CHIP_ECONOMY] pot negative or non-integer: ${room?.pot}`);
  }
  (room?.players || []).forEach((player) => {
    if (!isSafeNonNegativeInteger(player.chips)) {
      throw new Error(`[CHIP_ECONOMY] chips negative or non-integer: ${player.chips}`);
    }
  });
  return true;
}

function assertChipConservation(beforeTotal, afterTotal, label = "operation") {
  if (beforeTotal !== afterTotal) {
    throw new Error(`[CHIP_ECONOMY] conservation failed during ${label}: ${beforeTotal} -> ${afterTotal}`);
  }
  return true;
}

function assertSettlementZeroSum(before, after) {
  return assertChipConservation(before, after, "settlement");
}

function assertMatchChipTotal(room, expected = MATCH_TOTAL_CHIPS) {
  const total = chipTotal(room);
  if (total !== expected) {
    throw new Error(`[CHIP_ECONOMY] match total ${total} !== ${expected}`);
  }
  return true;
}

function assertHandCleared(room, expected = MATCH_TOTAL_CHIPS) {
  if (room.pot !== 0) {
    throw new Error(`[CHIP_ECONOMY] pot not cleared: ${room.pot}`);
  }
  const stacks = (room.players || []).reduce((sum, player) => sum + player.chips, 0);
  if (stacks !== expected) {
    throw new Error(`[CHIP_ECONOMY] stacks ${stacks} !== ${expected} after pot clear`);
  }
  return true;
}

function transferChips(room, payer, receiver, amount, reason = CHIP_REASON.STANDARD_SETTLEMENT) {
  if (!payer || !receiver) {
    economyFault(`transfer missing party (${reason})`);
    return 0;
  }
  if (payer === receiver || payer.playerId === receiver.playerId) return 0;
  if (!isLegalPlayerChipAmount(amount)) {
    economyFault(`illegal transfer amount ${String(amount)} (${reason})`);
    return 0;
  }
  if (amount === 0) return 0;

  const payable = Math.min(amount, Math.max(0, Number.isSafeInteger(payer.chips) ? payer.chips : 0));
  if (!isSafeNonNegativeInteger(payable) || payable === 0) return 0;

  const beforeFrom = payer.chips;
  const beforeTo = receiver.chips;
  const potBefore = room ? room.pot : null;
  const totalBefore = room ? chipTotal(room) : beforeFrom + beforeTo;

  payer.chips -= payable;
  receiver.chips += payable;

  if (payer.chips < 0) {
    economyFault(`payer chips went negative (${reason})`);
  }

  const totalAfter = room ? chipTotal(room) : payer.chips + receiver.chips;
  if (totalAfter !== totalBefore) {
    economyFault(`transfer conservation ${totalBefore} -> ${totalAfter} (${reason})`);
  }

  recordLedger(room, {
    operationId: `${reason}:${payer.playerId}:${receiver.playerId}:${payable}`,
    reason,
    from: payer.playerId,
    to: receiver.playerId,
    amount: payable,
    beforeFrom,
    afterFrom: payer.chips,
    beforeTo,
    afterTo: receiver.chips,
    potBefore,
    potAfter: room ? room.pot : null,
    totalBefore,
    totalAfter,
  });
  return payable;
}

function commitChipsToPot(room, player, amount, reason = CHIP_REASON.STANDARD_BET) {
  if (!room || !player) return 0;
  if (!isLegalPlayerChipAmount(amount) || amount === 0) return 0;
  const actual = Math.min(amount, Math.max(0, Number.isSafeInteger(player.chips) ? player.chips : 0));
  if (!isSafeNonNegativeInteger(actual) || actual === 0) return 0;

  const beforeFrom = player.chips;
  const potBefore = room.pot;
  const totalBefore = chipTotal(room);

  player.chips -= actual;
  room.pot += actual;
  player.streetBet = (Number.isSafeInteger(player.streetBet) ? player.streetBet : 0) + actual;
  player.totalBet = (Number.isSafeInteger(player.totalBet) ? player.totalBet : 0) + actual;
  if (player.chips === 0) player.isAllIn = true;

  const totalAfter = chipTotal(room);
  if (totalAfter !== totalBefore) {
    economyFault(`commit conservation ${totalBefore} -> ${totalAfter} (${reason})`);
  }

  recordLedger(room, {
    operationId: `${reason}:${player.playerId}:${actual}`,
    reason,
    from: player.playerId,
    to: "POT",
    amount: actual,
    beforeFrom,
    afterFrom: player.chips,
    potBefore,
    potAfter: room.pot,
    totalBefore,
    totalAfter,
  });
  return actual;
}

function releaseFromPot(room, player, amount, reason = CHIP_REASON.UNMATCHED_REFUND) {
  if (!room || !player) return 0;
  if (!isLegalPlayerChipAmount(amount) || amount === 0) return 0;
  const pot = Number.isSafeInteger(room.pot) ? room.pot : 0;
  const actual = Math.min(amount, Math.max(0, pot));
  if (!isSafeNonNegativeInteger(actual) || actual === 0) return 0;

  const beforeTo = player.chips;
  const potBefore = room.pot;
  const totalBefore = chipTotal(room);

  room.pot -= actual;
  player.chips += actual;

  const totalAfter = chipTotal(room);
  if (totalAfter !== totalBefore) {
    economyFault(`release conservation ${totalBefore} -> ${totalAfter} (${reason})`);
  }

  recordLedger(room, {
    operationId: `${reason}:POT:${player.playerId}:${actual}`,
    reason,
    from: "POT",
    to: player.playerId,
    amount: actual,
    beforeTo,
    afterTo: player.chips,
    potBefore,
    potAfter: room.pot,
    totalBefore,
    totalAfter,
  });
  return actual;
}

function awardPotTo(room, player, reason = CHIP_REASON.STANDARD_SHOWDOWN) {
  if (!room || !player) return 0;
  const amount = Number.isSafeInteger(room.pot) ? room.pot : 0;
  if (amount <= 0) {
    room.pot = 0;
    return 0;
  }
  return releaseFromPot(room, player, amount, reason);
}

function splitPotHeadsUp(room, recipients, oddChipRecipient, reason = CHIP_REASON.TIE_SPLIT) {
  if (!room || !Array.isArray(recipients) || recipients.length === 0) return 0;
  const pot = Number.isSafeInteger(room.pot) ? room.pot : 0;
  if (pot <= 0) {
    room.pot = 0;
    return 0;
  }
  const share = Math.floor(pot / recipients.length);
  recipients.forEach((player) => {
    if (share > 0) releaseFromPot(room, player, share, reason);
  });
  if (room.pot > 0) {
    const leftoverOwner = recipients.includes(oddChipRecipient) ? oddChipRecipient : recipients[0];
    releaseFromPot(room, leftoverOwner, room.pot, CHIP_REASON.TIE_ODD_CHIP);
  }
  room.pot = 0;
  return pot;
}

function refundContributionsFromPot(room, reason = CHIP_REASON.RETREAT_REFUND) {
  if (!room) return 0;
  let returned = 0;
  (room.players || []).forEach((player) => {
    const owed = Number.isSafeInteger(player.totalBet) ? player.totalBet : 0;
    returned += releaseFromPot(room, player, owed, reason);
    player.totalBet = 0;
    player.streetBet = 0;
  });
  return returned;
}

function applyIntegerEnergyDelta(current, delta) {
  if (!isSafeIntegerEnergy(current) || !isSafeIntegerEnergy(delta)) return current;
  return current + delta;
}

module.exports = {
  INITIAL_STACK,
  PLAYER_COUNT,
  MATCH_TOTAL_CHIPS,
  SMALL_BLIND,
  BIG_BLIND,
  CHIP_REASON,
  truncateTowardZero,
  isSafeNonNegativeInteger,
  isLegalPlayerChipAmount,
  isSafeIntegerEnergy,
  recycleRefund,
  defenseProtectedLoss,
  createEconomyState,
  ensureEconomy,
  beginHandEconomy,
  isHandTerminalSettled,
  markHandTerminalSettled,
  chipTotal,
  recordLedger,
  assertIntegerEconomyState,
  assertNoNegativeChips,
  assertChipConservation,
  assertSettlementZeroSum,
  assertMatchChipTotal,
  assertHandCleared,
  transferChips,
  commitChipsToPot,
  releaseFromPot,
  awardPotTo,
  splitPotHeadsUp,
  refundContributionsFromPot,
  applyIntegerEnergyDelta,
};
