function otherIndex(idx) {
  return idx === 0 ? 1 : 0;
}

function getActivePlayers(room) {
  return room.players.filter((p) => p.status !== "folded" && p.status !== "out");
}

function getToCall(room, player) {
  return Math.max(0, room.currentBet - player.streetBet);
}

function getEffectiveMaxTotal(room, playerIndex) {
  const player = room.players[playerIndex];
  const opponent = room.players[otherIndex(playerIndex)];
  // Raise targets are expressed as this street's total bet. Keep the cap in
  // the same unit so previous-street contributions cannot inflate the slider.
  const playerMax = player.streetBet + player.chips;
  const opponentMax = opponent.streetBet + opponent.chips;
  return Math.min(playerMax, opponentMax);
}

function getMinRaiseTo(room) {
  if (room.currentBet <= 0) return room.bigBlind;
  return room.currentBet + room.lastRaiseSize;
}

function getValidActions(room, playerIndex) {
  const player = room.players[playerIndex];
  const opponent = room.players[otherIndex(playerIndex)];
  if (!player || player.status !== "active" || player.isAllIn) {
    return { validActions: [], minRaiseTo: 0, maxTotalBet: 0, toCall: 0 };
  }
  const toCall = getToCall(room, player);
  const validActions = ["fold"];
  if (toCall === 0) validActions.push("check");
  if (toCall > 0 && player.chips > 0) validActions.push("call");

  const maxTotalBet = getEffectiveMaxTotal(room, playerIndex);
  const minRaiseTo = getMinRaiseTo(room);
  const canRaise =
    !opponent.isAllIn &&
    player.chips > 0 &&
    maxTotalBet > room.currentBet &&
    maxTotalBet >= minRaiseTo;
  if (canRaise) validActions.push("raise");

  // All-in is always available with chips left, except when facing an opponent
  // all-in with nothing left to call (already matched). Facing all-in with a
  // deficit, all-in = commit remaining chips toward the call.
  if (player.chips > 0 && (!opponent.isAllIn || toCall > 0)) {
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
  const actual = Math.max(0, Math.min(amount, player.chips));
  if (actual <= 0) return 0;
  player.chips -= actual;
  player.streetBet += actual;
  player.totalBet += actual;
  room.pot += actual;
  if (player.chips === 0) player.isAllIn = true;
  return actual;
}

function isStreetComplete(room) {
  const active = getActivePlayers(room);
  if (active.length <= 1) return true;
  const waiting = active.filter((p) => !p.isAllIn);
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
};
