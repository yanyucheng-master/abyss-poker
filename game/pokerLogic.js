const { commitChipsToPot, isLegalPlayerChipAmount } = require("./chipEconomy");

function otherIndex(idx) {
  return idx === 0 ? 1 : 0;
}

function getActivePlayers(room) {
  return room.players.filter((p) => p.status !== "folded" && p.status !== "out");
}

function getToCall(room, player) {
  return Math.max(0, room.currentBet - player.streetBet);
}

function isContributionCapped(room, player) {
  const rawCap = room?.skillState?.contributionCap;
  const cap = rawCap == null ? Number.NaN : Number(rawCap);
  if (!Number.isFinite(cap) || !player) return false;
  return (Number(player.totalBet) || 0) >= cap;
}

function isActionablePlayer(room, player) {
  if (!player) return false;
  if (room?.skillState?.bettingClosed) return false;
  if (room?.skillState?.endgameWindow) return false;
  if (!["active", "disconnected"].includes(player.status)) return false;
  if (player.isAllIn) return false;
  if (isContributionCapped(room, player)) return false;
  return true;
}

function pickAutoAction(validActions) {
  const list = Array.isArray(validActions) ? validActions : [];
  return ["check", "call", "allin", "fold"].find((action) => list.includes(action)) || null;
}

function pickTimeoutAction(validActions) {
  const list = Array.isArray(validActions) ? validActions : [];
  // A timeout must never turn an ordinary faced bet into an involuntary call.
  // If another rule (for example Intimidation) removes Fold, fall back to the
  // remaining passive legal action so the hand cannot deadlock.
  return ["check", "fold", "call", "allin"].find((action) => list.includes(action)) || null;
}

function getEffectiveMaxTotal(room, playerIndex) {
  const player = room.players[playerIndex];
  const opponent = room.players[otherIndex(playerIndex)];
  if (!player || !opponent) return player?.streetBet || 0;
  // Raise targets are expressed as this street's total bet. Keep the cap in
  // the same unit so previous-street contributions cannot inflate the slider.
  const rawCap = room.skillState?.contributionCap;
  const cap = rawCap == null ? Number.NaN : Number(rawCap);
  const playerCapLeft = Number.isFinite(cap)
    ? Math.max(0, cap - (Number(player.totalBet) || 0))
    : player.chips;
  const opponentCapLeft = Number.isFinite(cap)
    ? Math.max(0, cap - (Number(opponent.totalBet) || 0))
    : opponent.chips;
  const playerMax = player.streetBet + Math.min(player.chips, playerCapLeft);
  const opponentMax = opponent.streetBet + Math.min(opponent.chips, opponentCapLeft);
  return Math.min(playerMax, opponentMax);
}

function getMinRaiseTo(room) {
  if (room.currentBet <= 0) return room.bigBlind;
  return room.currentBet + room.lastRaiseSize;
}

function getValidActions(room, playerIndex) {
  const player = room.players[playerIndex];
  const opponent = room.players[otherIndex(playerIndex)];
  if (!player || !opponent || player.status !== "active" || player.isAllIn || isContributionCapped(room, player) || room.skillState?.bettingClosed || room.skillState?.endgameWindow) {
    return { validActions: [], minRaiseTo: 0, maxTotalBet: 0, toCall: 0 };
  }
  const toCall = getToCall(room, player);
  const validActions = room.skillState?.noFoldActive ? [] : ["fold"];
  const rawCap = room.skillState?.contributionCap;
  const cap = rawCap == null ? Number.NaN : Number(rawCap);
  const available = Number.isFinite(cap)
    ? Math.min(player.chips, Math.max(0, cap - (Number(player.totalBet) || 0)))
    : player.chips;
  if (toCall === 0) validActions.push("check");
  if (toCall > 0 && available > 0) validActions.push("call");

  const maxTotalBet = getEffectiveMaxTotal(room, playerIndex);
  const minRaiseTo = getMinRaiseTo(room);
  const canRaise =
    !opponent.isAllIn &&
    available > 0 &&
    maxTotalBet > room.currentBet &&
    maxTotalBet >= minRaiseTo;
  if (canRaise) validActions.push("raise");

  // Under intimidation the contribution cap may leave chips behind. ALL IN is
  // still a legal declared action; collectBet will only take the capped amount.
  const intimidationCapActive = Number.isFinite(cap);
  const canDeclareAllIn = intimidationCapActive || available === player.chips;
  if (player.chips > 0 && canDeclareAllIn && (!opponent.isAllIn || toCall > 0)) {
    validActions.push("allin");
  }

  return {
    validActions,
    // Only expose a raise window when raise is legal — avoids MIN > MAX UI.
    minRaiseTo: canRaise ? minRaiseTo : 0,
    maxTotalBet: canRaise ? maxTotalBet : 0,
    toCall,
  };
}

function collectBet(room, player, amount) {
  if (!isLegalPlayerChipAmount(amount) || amount <= 0) return 0;
  const rawCap = room.skillState?.contributionCap;
  const cap = rawCap == null ? Number.NaN : Number(rawCap);
  const chips = isLegalPlayerChipAmount(player.chips) ? player.chips : 0;
  const capLeft = Number.isFinite(cap)
    ? Math.max(0, cap - (Number(player.totalBet) || 0))
    : chips;
  const requested = Math.min(amount, chips, capLeft);
  if (!isLegalPlayerChipAmount(requested) || requested <= 0) return 0;
  return commitChipsToPot(room, player, requested);
}

function isStreetComplete(room) {
  const active = getActivePlayers(room);
  if (active.length <= 1) return true;
  const waiting = active.filter((p) => isActionablePlayer(room, p));
  if (waiting.length === 0) return true;
  const allMatched = waiting.every((p) => p.streetBet === room.currentBet);
  const allActed = waiting.every((p) => p.hasActed);
  return allMatched && allActed;
}

module.exports = {
  otherIndex,
  getActivePlayers,
  getToCall,
  getEffectiveMaxTotal,
  getMinRaiseTo,
  getValidActions,
  collectBet,
  isStreetComplete,
  isContributionCapped,
  isActionablePlayer,
  pickAutoAction,
  pickTimeoutAction,
};
