const socket = io();

let initialPlayerId = sessionStorage.getItem("abyss_player_id");
if (!initialPlayerId) {
  initialPlayerId = `P${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  sessionStorage.setItem("abyss_player_id", initialPlayerId);
}

const HAND_SETTLE_MS = 5000;
const COUNTDOWN_CIRC = 188.5;
const DEFAULT_HOST_NAME = "player1";
const DEFAULT_GUEST_NAME = "player2";
const REMATCH_TIMEOUT_MS = 10000;

function resolvePlayerName(raw, role) {
  const trimmed = (raw || "").trim();
  if (trimmed) return trimmed;
  return role === "guest" ? DEFAULT_GUEST_NAME : DEFAULT_HOST_NAME;
}

const state = {
  playerId: initialPlayerId,
  reconnectToken: sessionStorage.getItem("abyss_reconnect_token") || "",
  roomId: "",
  myName: "",
  players: [],
  myCards: [],
  showdownCards: {},
  bestFiveCodes: new Set(),
  communityCards: [],
  phase: "waiting",
  pot: 0,
  currentBet: 0,
  currentTurnPlayerId: null,
  validActions: [],
  minRaise: 0,
  maxBet: 0,
  showMyCards: localStorage.getItem("abyss_reveal_cards") === "1",
  gameOver: false,
  atLobby: true,
  handSettling: false,
  handSettleStage: 0,
  handSettleEndAt: 0,
  handSettleTotalMs: HAND_SETTLE_MS,
  handSettleTimers: [],
  rematchDeadlineAt: 0,
  rematchCountdownRaf: 0,
  rematchAcceptedIds: new Set(),
  rematchResponded: false,
};

const el = {
  auth: document.getElementById("screen-auth"),
  wait: document.getElementById("screen-wait"),
  game: document.getElementById("screen-game"),
  inputName: document.getElementById("input-name"),
  inputPwd: document.getElementById("input-password"),
  inputRoom: document.getElementById("input-room"),
  inputJoinPwd: document.getElementById("input-join-password"),
  btnCreate: document.getElementById("btn-create"),
  btnSolo: document.getElementById("btn-solo"),
  btnJoin: document.getElementById("btn-join"),
  waitRoomId: document.getElementById("wait-room-id"),
  btnCopyRoom: document.getElementById("btn-copy-room"),
  selfName: document.getElementById("self-name"),
  oppName: document.getElementById("opponent-name"),
  selfChips: document.getElementById("self-chips"),
  oppChips: document.getElementById("opponent-chips"),
  selfCards: document.getElementById("self-cards"),
  oppCards: document.getElementById("opponent-cards"),
  community: document.getElementById("community-cards"),
  pot: document.getElementById("pot-value"),
  currentBet: document.getElementById("current-bet"),
  phaseText: document.getElementById("phase-text"),
  actionLog: document.getElementById("action-log"),
  actionButtons: document.querySelectorAll(".action-panel [data-action]"),
  raiseInput: document.getElementById("raise-input"),
  selfAreaHeader: document.querySelector("#self-area .player-header"),
  oppAreaHeader: document.querySelector("#opponent-area .player-header"),
  flash: document.getElementById("flash-allin"),
  chipFx: document.getElementById("chip-fx-layer"),
  resultBanner: document.getElementById("result-banner"),
  btnToggleCards: document.getElementById("btn-toggle-cards"),
  gameOverModal: document.getElementById("game-over-modal"),
  gameOverTitle: document.getElementById("game-over-title"),
  gameOverMsg: document.getElementById("game-over-msg"),
  rematchBox: document.getElementById("rematch-box"),
  rematchStatus: document.getElementById("rematch-status"),
  rematchCountdown: document.getElementById("rematch-countdown"),
  btnRematchYes: document.getElementById("btn-rematch-yes"),
  btnRematchNo: document.getElementById("btn-rematch-no"),
  btnBackLobby: document.getElementById("btn-back-lobby"),
  btnBackWait: document.getElementById("btn-back-wait"),
  btnBackGame: document.getElementById("btn-back-game"),
  handSettleModal: document.getElementById("hand-settle-modal"),
  settleVerdict: document.getElementById("settle-verdict"),
  settleDetail: document.getElementById("settle-detail"),
  settleHandName: document.getElementById("settle-hand-name"),
  settleCountdownNum: document.getElementById("settle-countdown-num"),
  settleCountdownProgress: document.getElementById("settle-countdown-progress"),
  settleNext: document.getElementById("settle-next"),
  settleBoard: document.getElementById("settle-board"),
  settleCommunity: document.getElementById("settle-community"),
  settleSelfLabel: document.getElementById("settle-self-label"),
  settleSelfCards: document.getElementById("settle-self-cards"),
  settleSelfHand: document.getElementById("settle-self-hand"),
  settleOppLabel: document.getElementById("settle-opp-label"),
  settleOppCards: document.getElementById("settle-opp-cards"),
  settleOppHand: document.getElementById("settle-opp-hand"),
  board: document.querySelector(".board"),
};

function phaseLabel(phase) {
  const labels = {
    waiting: "WAITING",
    pre_flop: "PRE-FLOP",
    flop: "FLOP",
    turn: "TURN",
    river: "RIVER",
    showdown: "SHOWDOWN",
    end: "END",
    game_over: "GAME OVER",
  };
  return labels[phase] || String(phase || "").toUpperCase();
}

function updateEyeButton() {
  if (!el.btnToggleCards) return;
  const on = state.showMyCards;
  el.btnToggleCards.classList.toggle("active", on);
  el.btnToggleCards.setAttribute("aria-pressed", on ? "true" : "false");
  el.btnToggleCards.title = on ? "隐藏我的手牌" : "显示我的手牌";
  el.btnToggleCards.setAttribute("aria-label", el.btnToggleCards.title);
  el.btnToggleCards.querySelector(".eye-open")?.classList.toggle("hidden", on);
  el.btnToggleCards.querySelector(".eye-closed")?.classList.toggle("hidden", !on);
}

function showSettlementOverlay(isWin, message) {
  el.gameOverTitle.textContent = isWin ? "胜利" : "失败";
  el.gameOverTitle.classList.toggle("win-text", isWin);
  el.gameOverTitle.classList.toggle("lose-text", !isWin);
  el.gameOverMsg.textContent = message;
  el.gameOverModal.classList.remove("hidden");
}

function hideSettlementOverlay() {
  el.gameOverModal.classList.add("hidden");
}

function clearRematchPrompt() {
  if (state.rematchCountdownRaf) {
    cancelAnimationFrame(state.rematchCountdownRaf);
    state.rematchCountdownRaf = 0;
  }
  state.rematchDeadlineAt = 0;
  state.rematchAcceptedIds = new Set();
  state.rematchResponded = false;
  el.rematchBox?.classList.add("hidden");
  if (el.btnRematchYes) el.btnRematchYes.disabled = false;
  if (el.btnRematchNo) el.btnRematchNo.disabled = false;
  if (el.btnBackLobby) {
    el.btnBackLobby.classList.remove("hidden");
    el.btnBackLobby.textContent = "返回大厅";
  }
}

function updateRematchCountdown() {
  if (!state.rematchDeadlineAt) return;
  const left = Math.max(0, state.rematchDeadlineAt - Date.now());
  if (el.rematchCountdown) el.rematchCountdown.textContent = String(Math.ceil(left / 1000));
  if (left > 0) {
    state.rematchCountdownRaf = requestAnimationFrame(updateRematchCountdown);
  } else {
    if (el.rematchCountdown) el.rematchCountdown.textContent = "0";
  }
}

function updateRematchPrompt(payload = {}) {
  if (state.rematchCountdownRaf) {
    cancelAnimationFrame(state.rematchCountdownRaf);
    state.rematchCountdownRaf = 0;
  }
  const rematch = payload.rematch || payload;
  const accepted = Array.isArray(rematch.accepted) ? rematch.accepted : [];
  state.rematchAcceptedIds = new Set(accepted.map((item) => item.playerId));
  state.rematchDeadlineAt =
    rematch.deadlineAt || Date.now() + (rematch.timeoutMs || REMATCH_TIMEOUT_MS);

  const meAccepted = state.rematchAcceptedIds.has(state.playerId);
  state.rematchResponded = state.rematchResponded || meAccepted;
  const total = (rematch.players || state.players || []).filter((p) => !p.isBot).length || 2;
  const count = state.rematchAcceptedIds.size;

  el.rematchBox?.classList.remove("hidden");
  if (el.rematchStatus) {
    el.rematchStatus.textContent = meAccepted
      ? `已选择继续，等待对手确认（${count}/${total}）`
      : `是否再来一局？双方同意后立即开新局（${count}/${total}）`;
  }
  if (el.btnRematchYes) el.btnRematchYes.disabled = meAccepted;
  if (el.btnRematchNo) el.btnRematchNo.disabled = false;
  if (el.btnBackLobby) {
    el.btnBackLobby.classList.add("hidden");
    el.btnBackLobby.textContent = "返回大厅";
  }
  updateRematchCountdown();
}

function clearHandSettlement() {
  state.handSettleTimers.forEach((id) => clearTimeout(id));
  state.handSettleTimers = [];
  if (state.handSettleCountdownRaf) {
    cancelAnimationFrame(state.handSettleCountdownRaf);
    state.handSettleCountdownRaf = 0;
  }
  state.handSettling = false;
  state.handSettleStage = 0;
  state.handSettleEndAt = 0;
  state.handSettleTotalMs = HAND_SETTLE_MS;
  el.handSettleModal?.classList.add("hidden");
  el.settleBoard?.classList.add("hidden");
  el.board?.classList.remove("settle-dim");
  el.game?.classList.remove("settle-dim");
}

function applyHandResultCards(players) {
  state.showdownCards = {};
  state.bestFiveCodes = new Set();
  (players || []).forEach((p) => {
    if (p.cards?.length) state.showdownCards[p.playerId] = p.cards;
    (p.bestFive || []).forEach((card) => state.bestFiveCodes.add(card.code));
  });
}

function updateSettleCountdown() {
  if (!state.handSettling || !state.handSettleEndAt) return;
  const left = Math.max(0, state.handSettleEndAt - Date.now());
  const sec = Math.max(0, Math.ceil(left / 1000));
  el.settleCountdownNum.textContent = String(sec);
  const progress = left / (state.handSettleTotalMs || HAND_SETTLE_MS);
  el.settleCountdownProgress.style.strokeDashoffset = String(COUNTDOWN_CIRC * (1 - progress));
  if (left > 0) {
    state.handSettleCountdownRaf = requestAnimationFrame(updateSettleCountdown);
  } else {
    el.settleCountdownNum.textContent = "0";
    el.settleCountdownProgress.style.strokeDashoffset = String(COUNTDOWN_CIRC);
  }
}

function renderSettleCardRow(container, cards, highlightCodes, padToFive = false) {
  if (!container) return;
  container.innerHTML = "";
  const list = cards || [];
  if (!list.length && !padToFive) {
    const empty = document.createElement("span");
    empty.className = "settle-empty";
    empty.textContent = "—";
    container.appendChild(empty);
    return;
  }
  list.forEach((card) => {
    const node = createCardElement(card, { glow: highlightCodes.has(card.code) });
    node.classList.add("settle-card", "flip-reveal");
    container.appendChild(node);
  });
  if (padToFive) {
    for (let i = list.length; i < 5; i += 1) {
      container.appendChild(createCardElement({}, { back: true }));
    }
  }
}

function renderSettleBoard(payload) {
  const me = getMe();
  const op = getOpponent();
  const meDetail = (payload.players || []).find((p) => p.playerId === state.playerId);
  const opDetail = (payload.players || []).find((p) => p.playerId !== state.playerId);
  const community = payload.communityCards || state.communityCards || [];
  const highlights = state.bestFiveCodes;

  el.settleBoard?.classList.remove("hidden");
  el.settleSelfLabel.textContent = me?.name || "你";
  el.settleOppLabel.textContent = op?.name || "对手";

  renderSettleCardRow(el.settleCommunity, community, highlights, true);
  renderSettleCardRow(el.settleSelfCards, meDetail?.cards || state.myCards, highlights);
  renderSettleCardRow(el.settleOppCards, opDetail?.cards || state.showdownCards[op?.playerId] || [], highlights);

  const selfHandText = meDetail?.handName ? `牌型：${meDetail.handName}` : meDetail?.folded ? "已弃牌" : "";
  const oppHandText = opDetail?.handName ? `牌型：${opDetail.handName}` : opDetail?.folded ? "已弃牌" : "";
  el.settleSelfHand.textContent = selfHandText;
  el.settleOppHand.textContent = oppHandText;
}

function showHandVerdict(payload) {
  const op = getOpponent();
  const iWon = !payload.tie && payload.winner === state.playerId;
  const winDetail = (payload.players || []).find((p) => p.playerId === payload.winner);
  const meDetail = (payload.players || []).find((p) => p.playerId === state.playerId);
  const opDetail = (payload.players || []).find((p) => p.playerId !== state.playerId);

  el.settleVerdict.className = "settle-verdict";
  if (payload.reason === "fold") {
    if (iWon) {
      el.settleVerdict.textContent = "胜利";
      el.settleVerdict.classList.add("win-text");
      el.settleDetail.textContent = `${op?.name || "对手"} 弃牌，你赢得底池 ${payload.pot}`;
    } else {
      el.settleVerdict.textContent = "败北";
      el.settleVerdict.classList.add("lose-text");
      el.settleDetail.textContent = `你弃牌，${payload.winnerName || op?.name || "对手"} 赢得底池 ${payload.pot}`;
    }
  } else if (payload.tie) {
    el.settleVerdict.textContent = "平局";
    el.settleVerdict.classList.add("tie-text");
    el.settleDetail.textContent = `底池 ${payload.pot} 平分（余数给房主）`;
  } else {
    el.settleVerdict.textContent = iWon ? "胜利" : "败北";
    el.settleVerdict.classList.add(iWon ? "win-text" : "lose-text");
    el.settleDetail.textContent = `${payload.winnerName || winDetail?.name || "对手"} 赢得底池 ${payload.pot}`;
  }

  renderSettleBoard(payload);
  if (payload.reason === "showdown" || payload.reason === "fold") {
    const parts = [];
    if (meDetail?.handName) parts.push(`你：${meDetail.handName}`);
    if (opDetail?.handName) parts.push(`${op?.name || "对手"}：${opDetail.handName}`);
    el.settleHandName.textContent = parts.join(" ｜ ");
  } else {
    el.settleHandName.textContent = winDetail?.handName ? `胜方牌型 · ${winDetail.handName}` : "";
  }
  el.settleNext.textContent = payload.isFinalHand ? "对局即将结束" : "下一局即将开始";
}

function scheduleHandSettle(fn, ms) {
  state.handSettleTimers.push(setTimeout(fn, ms));
}

function startHandSettlement(payload) {
  clearHandSettlement();
  state.handSettling = true;
  state.handSettleStage = 2;
  state.handSettleEndAt = Date.now() + (payload.settleMs || HAND_SETTLE_MS);
  state.handSettleTotalMs = payload.settleMs || HAND_SETTLE_MS;
  state.phase = payload.reason === "showdown" ? "showdown" : "end";
  state.validActions = [];
  state.currentTurnPlayerId = null;

  if (payload.communityCards?.length) {
    state.communityCards = payload.communityCards;
  }
  applyHandResultCards(payload.players);
  renderState();
  renderSettleBoard(payload);

  el.board?.classList.add("settle-dim");
  el.game?.classList.add("settle-dim");
  el.handSettleModal?.classList.remove("hidden");
  el.settleVerdict.textContent = "审判中";
  el.settleVerdict.className = "settle-verdict";
  el.settleDetail.textContent = "正在展示双方手牌与牌型...";
  el.settleHandName.textContent = "";
  el.settleCountdownNum.textContent = String(Math.ceil((payload.settleMs || HAND_SETTLE_MS) / 1000));
  el.settleCountdownProgress.style.strokeDashoffset = "0";
  updateSettleCountdown();

  scheduleHandSettle(() => {
    state.handSettleStage = 3;
    showHandVerdict(payload);
    renderCards();
    const iWon = !payload.tie && payload.winner === state.playerId;
    if (payload.tie) setBanner("平局", true);
    else if (payload.winner) setBanner(iWon ? "胜利" : "败北", iWon);
  }, 380);
}

function resetLocalSession() {
  clearHandSettlement();
  clearRematchPrompt();
  hideSettlementOverlay();
  state.gameOver = false;
  state.atLobby = true;
  state.roomId = "";
  state.phase = "waiting";
  state.players = [];
  state.myCards = [];
  state.showdownCards = {};
  state.bestFiveCodes = new Set();
  state.communityCards = [];
  state.pot = 0;
  state.currentBet = 0;
  state.currentTurnPlayerId = null;
  state.validActions = [];
}

function returnToLobby() {
  if (state.gameOver && state.rematchDeadlineAt) {
    socket.emit("rematch_response", { accepted: false });
  }
  resetLocalSession();
  socket.emit("leave_room");
  showScreen("auth");
}

function confirmReturnToLobby() {
  if (state.gameOver || state.phase === "game_over") {
    returnToLobby();
    return;
  }
  if (state.phase === "waiting" || state.players.length < 2) {
    returnToLobby();
    return;
  }
  if (window.confirm("确定返回大厅？进行中的对局将判负。")) returnToLobby();
}

function showScreen(name) {
  el.auth.classList.remove("active");
  el.wait.classList.remove("active");
  el.game.classList.remove("active");
  el[name].classList.add("active");
}

function getMe() {
  return state.players.find((p) => p.playerId === state.playerId);
}

function getOpponent() {
  return state.players.find((p) => p.playerId !== state.playerId);
}

function suitText(suit) {
  return { S: "♠", H: "♥", C: "♣", D: "♦" }[suit] || "?";
}

function cardLabel(card) {
  return `${suitText(card.suit)}${card.rank.replace("T", "10")}`;
}

function createCardElement(card, options = {}) {
  const node = document.createElement("div");
  node.className = "card";
  if (options.back) {
    node.classList.add("back");
    node.textContent = "ABYSS";
    return node;
  }
  node.textContent = cardLabel(card);
  if (card.suit === "H" || card.suit === "D") node.classList.add("red");
  if (options.glow) node.classList.add("glow-gold");
  return node;
}

function logAction(text) {
  el.actionLog.textContent = text;
}

function setBanner(text, isWin) {
  el.resultBanner.textContent = text;
  el.resultBanner.classList.remove("hidden", "win", "lose");
  el.resultBanner.classList.add(isWin ? "win" : "lose");
  setTimeout(() => {
    el.resultBanner.classList.add("hidden");
  }, 1800);
}

function animatePot(nextValue) {
  const start = Number(el.pot.textContent || 0);
  const end = Number(nextValue || 0);
  const duration = 260;
  const started = performance.now();

  function frame(now) {
    const t = Math.min(1, (now - started) / duration);
    const val = Math.round(start + (end - start) * t);
    el.pot.textContent = String(val);
    if (t < 1) requestAnimationFrame(frame);
    else {
      el.pot.classList.add("pot-update");
      setTimeout(() => el.pot.classList.remove("pot-update"), 180);
    }
  }
  requestAnimationFrame(frame);
}

function flyChip() {
  const chip = document.createElement("div");
  chip.className = "chip-fx";
  const fromX = 180 + Math.random() * (window.innerWidth - 360);
  const fromY = window.innerHeight - 180;
  const toX = window.innerWidth / 2;
  const toY = window.innerHeight / 2;
  chip.style.left = `${fromX}px`;
  chip.style.top = `${fromY}px`;
  el.chipFx.appendChild(chip);
  chip.animate(
    [
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
      { transform: `translate(${toX - fromX}px, ${toY - fromY}px) scale(0.7)`, opacity: 0.2 },
    ],
    { duration: 320, easing: "ease-out" }
  );
  setTimeout(() => chip.remove(), 340);
}

function playAllInEffect() {
  document.body.classList.add("shake");
  el.flash.classList.remove("hidden");
  setTimeout(() => {
    document.body.classList.remove("shake");
    el.flash.classList.add("hidden");
  }, 550);
}

function updateActionPanel() {
  if (state.gameOver || state.phase === "game_over" || state.handSettling) {
    el.actionButtons.forEach((btn) => {
      btn.disabled = true;
    });
    el.raiseInput.disabled = true;
    return;
  }

  const isMyTurn = state.currentTurnPlayerId === state.playerId;
  const me = getMe();
  const toCall = me ? Math.max(0, state.currentBet - (me.streetBet || 0)) : 0;

  el.actionButtons.forEach((btn) => {
    const action = btn.dataset.action;
    const allowed = isMyTurn && state.validActions.includes(action);
    btn.disabled = !allowed;
    if (action === "call") btn.textContent = toCall > 0 ? `CALL(${toCall})` : "CALL";
  });

  const canRaise = isMyTurn && state.validActions.includes("raise");
  el.raiseInput.disabled = !canRaise;
  if (canRaise) {
    el.raiseInput.min = String(state.minRaise || 0);
    el.raiseInput.max = String(state.maxBet || 0);
  }
}

function renderCards() {
  const opponent = getOpponent();
  const showdownOppCards = state.showdownCards[opponent?.playerId] || [];
  const highlightCodes = state.bestFiveCodes;

  el.selfCards.innerHTML = "";
  state.myCards.forEach((card, idx) => {
    const cardNode = createCardElement(card, { glow: highlightCodes.has(card.code) });
    if (state.handSettling && state.handSettleStage >= 2 && highlightCodes.has(card.code)) {
      cardNode.classList.add("judge-glow");
    }
    if (state.phase !== "showdown" && !state.showMyCards && !state.handSettling) {
      const frontClass = cardNode.className;
      const frontText = cardNode.textContent;
      cardNode.className = "card back";
      cardNode.textContent = "ABYSS";
      let timer = null;
      const reveal = () => {
        cardNode.className = frontClass;
        cardNode.textContent = frontText;
      };
      const hide = () => {
        cardNode.className = "card back";
        cardNode.textContent = "ABYSS";
      };
      cardNode.addEventListener("mouseenter", reveal);
      cardNode.addEventListener("mouseleave", hide);
      cardNode.addEventListener("click", () => {
        reveal();
        clearTimeout(timer);
        timer = setTimeout(hide, 1500);
      });
    }
    el.selfCards.appendChild(cardNode);
  });

  el.oppCards.innerHTML = "";
  const inShowdownReveal =
    state.phase === "showdown" || (state.handSettling && state.handSettleStage >= 2);
  if (inShowdownReveal && showdownOppCards.length) {
    showdownOppCards.forEach((card, idx) => {
      const cardNode = createCardElement(card, { glow: highlightCodes.has(card.code) });
      if (state.handSettling && state.handSettleStage >= 1 && state.handSettleStage < 3) {
        cardNode.classList.add("flip-reveal");
        cardNode.style.animationDelay = `${idx * 0.18}s`;
      }
      if (state.handSettling && state.handSettleStage >= 2 && highlightCodes.has(card.code)) {
        cardNode.classList.add("judge-glow");
      }
      el.oppCards.appendChild(cardNode);
    });
  } else {
    for (let i = 0; i < 2; i += 1) el.oppCards.appendChild(createCardElement({}, { back: true }));
  }

  el.community.innerHTML = "";
  for (let i = 0; i < 5; i += 1) {
    const card = state.communityCards[i];
    if (!card) el.community.appendChild(createCardElement({}, { back: true }));
    else {
      const cardNode = createCardElement(card, { glow: highlightCodes.has(card.code) });
      if (state.handSettling && state.handSettleStage >= 2 && highlightCodes.has(card.code)) {
        cardNode.classList.add("judge-glow");
      }
      el.community.appendChild(cardNode);
    }
  }
}

function renderState() {
  const me = getMe();
  const op = getOpponent();
  el.selfName.textContent = me?.name || "你";
  el.oppName.textContent = op?.name || "等待中";
  el.selfChips.textContent = String(me?.chips ?? "-");
  el.oppChips.textContent = String(op?.chips ?? "-");
  el.currentBet.textContent = String(state.currentBet);
  el.phaseText.textContent = state.handSettling ? "JUDGMENT" : phaseLabel(state.phase);
  animatePot(state.pot);

  const myTurn = state.currentTurnPlayerId === state.playerId;
  const opTurn = state.currentTurnPlayerId && state.currentTurnPlayerId !== state.playerId;
  el.selfAreaHeader.classList.toggle("active-turn", Boolean(myTurn));
  el.oppAreaHeader.classList.toggle("active-turn", Boolean(opTurn));
  updateActionPanel();
  renderCards();
}

function emitJoin(roomId, password) {
  socket.emit("join_room", {
    roomId,
    password,
    playerName: state.myName,
    playerId: state.playerId,
    reconnectToken: state.reconnectToken || undefined,
  });
}

function persistSession() {
  sessionStorage.setItem("abyss_player_id", state.playerId);
  if (state.reconnectToken) sessionStorage.setItem("abyss_reconnect_token", state.reconnectToken);
  if (state.roomId) sessionStorage.setItem("abyss_room_id", state.roomId);
}

function syncPlayersFromServer(players) {
  if (!Array.isArray(players)) return;
  state.players = players;
  if (state.players.length >= 2 && !state.atLobby) showScreen("game");
  renderState();
}

el.btnCreate.addEventListener("click", () => {
  const name = resolvePlayerName(el.inputName.value, "host");
  state.myName = name;
  state.atLobby = false;
  socket.emit("create_room", {
    password: (el.inputPwd.value || "").trim() || null,
    playerName: name,
    playerId: state.playerId,
    reconnectToken: state.reconnectToken || undefined,
  });
});

el.btnSolo.addEventListener("click", () => {
  const name = resolvePlayerName(el.inputName.value, "host");
  state.myName = name;
  state.atLobby = false;
  socket.emit("create_solo_room", {
    playerName: name,
    playerId: state.playerId,
    reconnectToken: state.reconnectToken || undefined,
  });
});

el.btnJoin.addEventListener("click", () => {
  const roomId = (el.inputRoom.value || "").trim().toUpperCase();
  if (!roomId) return alert("请输入房间号");
  const name = resolvePlayerName(el.inputName.value, "guest");
  state.myName = name;
  state.atLobby = false;
  emitJoin(roomId, (el.inputJoinPwd.value || "").trim() || null);
});

el.btnCopyRoom.addEventListener("click", async () => {
  if (!state.roomId) return;
  await navigator.clipboard.writeText(state.roomId);
  logAction(`房间号 ${state.roomId} 已复制`);
});

el.actionButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    if (!action) return;
    if (action === "raise") {
      const amount = Number(el.raiseInput.value);
      socket.emit("player_action", { action, amount });
    } else {
      socket.emit("player_action", { action });
    }
  });
});

socket.on("room_created", ({ roomId }) => {
  state.roomId = roomId;
  el.inputRoom.value = roomId;
  el.waitRoomId.textContent = roomId;
  persistSession();
});

socket.on("room_joined", ({ roomId, playerId, reconnectToken, players }) => {
  if (state.atLobby) return;
  state.roomId = roomId;
  if (playerId) {
    state.playerId = playerId;
    persistSession();
  }
  if (reconnectToken) {
    state.reconnectToken = reconnectToken;
    persistSession();
  }
  state.players = players || [];
  el.waitRoomId.textContent = roomId;
  showScreen(state.players.length >= 2 ? "game" : "wait");
  renderState();
});

socket.on("room_state", (payload) => {
  if (state.atLobby) return;
  state.players = payload.players || state.players;
  if (!state.gameOver && !state.handSettling) state.phase = payload.phase || state.phase;
  state.pot = payload.pot ?? state.pot;
  state.currentBet = payload.currentBet ?? state.currentBet;
  state.communityCards = payload.communityCards || state.communityCards;
  if (payload.phase === "game_over") state.gameOver = true;
  if (state.players.length >= 2) showScreen("game");
  renderState();
});

socket.on("your_cards", ({ cards }) => {
  clearHandSettlement();
  clearRematchPrompt();
  hideSettlementOverlay();
  state.gameOver = false;
  state.myCards = cards || [];
  state.showdownCards = {};
  state.bestFiveCodes = new Set();
  renderState();
});

socket.on("community_cards", ({ cards, phase }) => {
  state.communityCards = cards || [];
  state.phase = phase || state.phase;
  renderState();
});

socket.on("player_turn", ({ playerId, validActions, minRaise, maxBet }) => {
  state.currentTurnPlayerId = playerId;
  if (playerId === state.playerId) {
    state.validActions = validActions || [];
    state.minRaise = minRaise || 0;
    state.maxBet = maxBet || 0;
    logAction(`轮到你行动：${state.validActions.join(" / ")}`);
  } else {
    state.validActions = [];
    logAction("对手正在行动...");
  }
  renderState();
});

socket.on("action_made", ({ playerId, action, amount, pot, playerChips }) => {
  if (Array.isArray(playerChips)) state.players = playerChips;
  if (typeof pot === "number") state.pot = pot;
  if (action === "allin") playAllInEffect();
  if (["call", "raise", "allin"].includes(action) && amount > 0) flyChip();
  logAction(`玩家 ${playerId} 执行 ${action}${amount ? ` ${amount}` : ""}`);
  renderState();
});

socket.on("hand_result", (payload) => {
  if (state.atLobby) return;
  startHandSettlement(payload);
});

socket.on("game_over", (payload) => {
  const { winner, winnerName, loserName, reason, players, rematch } = payload;
  clearHandSettlement();
  state.gameOver = true;
  state.phase = "game_over";
  state.validActions = [];
  state.currentTurnPlayerId = null;
  if (players) state.players = players;
  const iWon = winner === state.playerId;
  const op = getOpponent();
  let message;
  if (reason === "bankrupt") {
    message = iWon
      ? `恭喜获胜！${loserName || op?.name || "对手"} 筹码已耗尽`
      : `你已出局，${winnerName || op?.name || "对手"} 获胜`;
  } else if (reason === "disconnect_timeout_forfeit") {
    message = iWon ? "对手断线超时，你获胜" : "断线超时，本局判负";
  } else {
    message = iWon ? "游戏结束，你获胜" : `游戏结束，${winnerName || op?.name || "对手"} 获胜`;
  }
  logAction(message);
  setBanner(iWon ? "整场胜利" : "整场失败", iWon);
  showSettlementOverlay(iWon, message);
  if (rematch) updateRematchPrompt({ rematch });
  else clearRematchPrompt();
  renderState();
});

socket.on("rematch_update", (payload) => {
  if (state.atLobby || !state.gameOver) return;
  updateRematchPrompt(payload);
});

socket.on("rematch_started", ({ players }) => {
  clearRematchPrompt();
  hideSettlementOverlay();
  state.gameOver = false;
  state.phase = "waiting";
  state.players = players || state.players;
  logAction("双方同意，再来一局");
  renderState();
});

socket.on("room_closed", ({ reason }) => {
  const message =
    reason === "rematch_declined"
      ? "有玩家选择不继续，房间已关闭"
      : "再来一局确认超时，房间已关闭";
  resetLocalSession();
  showScreen("auth");
  alert(message);
});

socket.on("player_joined", ({ playerId, players }) => {
  logAction(`玩家加入：${playerId}`);
  syncPlayersFromServer(players);
});
socket.on("player_reconnected", ({ playerId, players }) => {
  logAction(`玩家重连：${playerId}`);
  if (players) syncPlayersFromServer(players);
});
socket.on("player_left", ({ playerId }) => {
  logAction(`玩家离开：${playerId}`);
});
socket.on("player_disconnected", ({ playerId }) => logAction(`玩家离线：${playerId}`));

socket.on("join_error", ({ message }) => alert(message || "加入失败"));
socket.on("action_error", ({ message }) => alert(message || "操作失败"));

el.btnToggleCards?.addEventListener("click", () => {
  state.showMyCards = !state.showMyCards;
  localStorage.setItem("abyss_reveal_cards", state.showMyCards ? "1" : "0");
  updateEyeButton();
  renderCards();
});

el.btnRematchYes?.addEventListener("click", () => {
  state.rematchResponded = true;
  el.btnRematchYes.disabled = true;
  socket.emit("rematch_response", { accepted: true });
});

el.btnRematchNo?.addEventListener("click", () => {
  state.rematchResponded = true;
  el.btnRematchYes.disabled = true;
  el.btnRematchNo.disabled = true;
  socket.emit("rematch_response", { accepted: false });
});

el.btnBackLobby?.addEventListener("click", returnToLobby);
el.btnBackWait?.addEventListener("click", returnToLobby);
el.btnBackGame?.addEventListener("click", confirmReturnToLobby);

updateEyeButton();
