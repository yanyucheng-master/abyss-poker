const socket = io();

const GAME_MODE = Object.freeze({
  STANDARD: "standard",
  OVERDRIVE: "overdrive",
});
const ACTIVE_PHASES = new Set(["pre_flop", "flop", "turn", "river"]);
const HAND_SETTLE_MS = 5000;
const REMATCH_TIMEOUT_MS = 10000;
const STORAGE = Object.freeze({
  playerId: "abyss_player_id",
  reconnectToken: "abyss_reconnect_token",
  roomId: "abyss_room_id",
  playerName: "abyss_player_name",
  revealCards: "abyss_reveal_cards",
  settings: "abyss_ui_settings_v2",
  skillLoadout: "abyss_skill_loadout_v1",
});

function createPlayerId() {
  if (window.crypto && window.crypto.getRandomValues) {
    const bytes = new Uint8Array(6);
    window.crypto.getRandomValues(bytes);
    return "P" + Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  return "P" + Math.random().toString(36).slice(2, 14).toUpperCase();
}

const initialPlayerId = sessionStorage.getItem(STORAGE.playerId) || createPlayerId();
const initialReconnectToken = sessionStorage.getItem(STORAGE.reconnectToken) || "";
const initialRoomId = sessionStorage.getItem(STORAGE.roomId) || "";
const hasPendingReconnect = Boolean(initialRoomId && initialReconnectToken);
sessionStorage.setItem(STORAGE.playerId, initialPlayerId);

function loadSettings() {
  const defaults = {
    animation: "high",
    reduceMotion: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    sfx: 55,
    music: 0,
    scale: 100,
    lowPerformance: false,
  };
  try {
    return Object.assign(defaults, JSON.parse(localStorage.getItem(STORAGE.settings) || "{}"));
  } catch (_error) {
    return defaults;
  }
}

const state = {
  playerId: initialPlayerId,
  reconnectToken: initialReconnectToken,
  roomId: initialRoomId,
  myName: sessionStorage.getItem(STORAGE.playerName) || "",
  gameMode: GAME_MODE.STANDARD,
  skillMode: "off",
  skillCatalog: [],
  selectedLoadout: [],
  savedLoadout: [],
  skillConfig: { minEquipped: 2, maxEquipped: 4, maxLoad: 8 },
  pendingRoomAction: null,
  pendingJoinRoomId: null,
  autoLoadoutSubmitted: false,
  hasPassword: false,
  isHost: false,
  skillState: null,
  skillSelf: null,
  nullifiedCommunityCardIds: [],
  pendingReaction: null,
  pendingChoice: null,
  reactionTimerRaf: 0,
  phase: "waiting",
  players: [],
  myCards: [],
  showdownCards: {},
  bestFiveCodes: new Set(),
  communityCards: [],
  pot: 0,
  currentBet: 0,
  dealer: null,
  currentTurnPlayerId: null,
  validActions: [],
  minRaise: 0,
  maxBet: 0,
  toCall: 0,
  actionDeadline: null,
  actionCountdownRaf: 0,
  handHint: "等待发牌",
  handCategory: 0,
  handSettling: false,
  handSettleEndAt: 0,
  handSettleRaf: 0,
  handSettleTimer: 0,
  gameOver: false,
  atLobby: !hasPendingReconnect,
  deliberateLeave: false,
  reconnecting: hasPendingReconnect,
  showMyCards: localStorage.getItem(STORAGE.revealCards) !== "0",
  rematchDeadlineAt: 0,
  rematchAcceptedIds: new Set(),
  rematchRaf: 0,
  commitments: new Map(),
  activeCommitment: null,
  fairnessStatus: "pending",
  settings: loadSettings(),
};

function byId(id) {
  return document.getElementById(id);
}

const el = {
  auth: byId("screen-auth"),
  wait: byId("screen-wait"),
  game: byId("screen-game"),
  skillLab: byId("screen-skill-lab"),
  connectionBanner: byId("connection-banner"),
  connectionBannerText: byId("connection-banner-text"),
  toastRegion: byId("toast-region"),
  chipFx: byId("chip-fx-layer"),
  flash: byId("flash-allin"),
  riverOverload: byId("river-overload"),
  protocolBurst: byId("protocol-burst"),
  resultBanner: byId("result-banner"),
  btnSettings: byId("btn-settings"),
  settingsModal: byId("settings-modal"),
  btnCloseSettings: byId("btn-close-settings"),
  settingAnimation: byId("setting-animation"),
  settingReduceMotion: byId("setting-reduce-motion"),
  settingSfx: byId("setting-sfx"),
  settingSfxValue: byId("setting-sfx-value"),
  settingMusic: byId("setting-music"),
  settingMusicValue: byId("setting-music-value"),
  settingScale: byId("setting-scale"),
  settingScaleValue: byId("setting-scale-value"),
  settingLowPerformance: byId("setting-low-performance"),
  leaveConfirmModal: byId("leave-confirm-modal"),
  btnLeaveCancel: byId("btn-leave-cancel"),
  btnLeaveConfirm: byId("btn-leave-confirm"),
  gameOverModal: byId("game-over-modal"),
  gameOverTitle: byId("game-over-title"),
  gameOverMsg: byId("game-over-msg"),
  rematchBox: byId("rematch-box"),
  rematchStatus: byId("rematch-status"),
  rematchCountdown: byId("rematch-countdown"),
  btnRematchYes: byId("btn-rematch-yes"),
  btnRematchNo: byId("btn-rematch-no"),
  btnBackLobby: byId("btn-back-lobby"),
  handSettleModal: byId("hand-settle-modal"),
  settleVerdict: byId("settle-verdict"),
  settleCountdownNum: byId("settle-countdown-num"),
  settleDetail: byId("settle-detail"),
  settleBoard: byId("settle-board"),
  settleCommunity: byId("settle-community"),
  settleSelfLabel: byId("settle-self-label"),
  settleSelfCards: byId("settle-self-cards"),
  settleSelfHand: byId("settle-self-hand"),
  settleOppLabel: byId("settle-opp-label"),
  settleOppCards: byId("settle-opp-cards"),
  settleOppHand: byId("settle-opp-hand"),
  settleHandName: byId("settle-hand-name"),
  settleNext: byId("settle-next"),
  selectedModeTag: byId("selected-mode-tag"),
  protocolSummary: byId("protocol-summary"),
  inputName: byId("input-name"),
  inputRoom: byId("input-room"),
  btnJoin: byId("btn-join"),
  joinPasswordModal: byId("join-password-modal"),
  modalJoinPassword: byId("modal-join-password"),
  btnJoinPasswordConfirm: byId("btn-join-password-confirm"),
  btnJoinPasswordCancel: byId("btn-join-password-cancel"),
  btnOpenSkillLab: byId("btn-open-skill-lab"),
  btnBackSkillLab: byId("btn-back-skill-lab"),
  btnSaveLoadout: byId("btn-save-loadout"),
  btnClearLoadout: byId("btn-clear-loadout"),
  skillPrepStatus: byId("skill-prep-status"),
  skillLabCatalog: byId("skill-lab-catalog"),
  skillLabStatus: byId("skill-lab-status"),
  labLoadMeter: byId("lab-load-meter"),
  lobbyConnection: byId("lobby-connection"),
  inputWaitPassword: byId("input-wait-password"),
  btnSetRoomPassword: byId("btn-set-room-password"),
  waitPasswordStatus: byId("wait-password-status"),
  waitPasswordPanel: byId("wait-password-panel"),
  btnBackWait: byId("btn-back-wait"),
  waitConnection: byId("wait-connection"),
  waitRoomId: byId("wait-room-id"),
  btnCopyRoom: byId("btn-copy-room"),
  waitHostName: byId("wait-host-name"),
  waitHostState: byId("wait-host-state"),
  waitGuestName: byId("wait-guest-name"),
  waitGuestState: byId("wait-guest-state"),
  waitModeBadge: byId("wait-mode-badge"),
  waitModeName: byId("wait-mode-name"),
  waitInitialChips: byId("wait-initial-chips"),
  waitRoomStatus: byId("wait-room-status"),
  waitModeBrief: byId("wait-mode-brief"),
  btnBackGame: byId("btn-back-game"),
  gameRoomId: byId("game-room-id"),
  gameModeBadge: byId("game-mode-badge"),
  gameConnection: byId("game-connection"),
  fairnessSummary: byId("fairness-summary"),
  board: byId("board"),
  opponentArea: byId("opponent-area"),
  overdriveStage: byId("overdrive-stage"),
  opponentName: byId("opponent-name"),
  opponentConnection: byId("opponent-connection"),
  opponentChips: byId("opponent-chips"),
  opponentBet: byId("opponent-bet"),
  opponentState: byId("opponent-state"),
  opponentCards: byId("opponent-cards"),
  phaseText: byId("phase-text"),
  actionLog: byId("action-log"),
  community: byId("community-cards"),
  currentBet: byId("current-bet"),
  potCore: byId("pot-core"),
  pot: byId("pot-value"),
  commitmentShort: byId("commitment-short"),
  fairnessHandId: byId("fairness-hand-id"),
  fairnessResult: byId("fairness-result"),
  overdriveProfile: byId("overdrive-profile"),
  overdriveProfileLabel: byId("overdrive-profile-label"),
  selectedSkillTag: byId("selected-skill-tag"),
  waitSkillMode: byId("wait-skill-mode"),
  waitInitialEnergy: byId("wait-initial-energy"),
  skillDraftPanel: byId("skill-draft-panel"),
  draftLoadMeter: byId("draft-load-meter"),
  draftStatus: byId("draft-status"),
  skillCatalog: byId("skill-catalog"),
  btnConfirmLoadout: byId("btn-confirm-loadout"),
  skillHud: byId("skill-hud"),
  selfEnergy: byId("self-energy"),
  opponentEnergy: byId("opponent-energy"),
  skillSilenceFlag: byId("skill-silence-flag"),
  skillBar: byId("skill-bar"),
  skillLog: byId("skill-log"),
  skillReactionModal: byId("skill-reaction-modal"),
  skillReactionText: byId("skill-reaction-text"),
  skillReactionTimer: byId("skill-reaction-timer"),
  btnSkillCounter: byId("btn-skill-counter"),
  btnSkillCounterSkip: byId("btn-skill-counter-skip"),
  skillChoiceModal: byId("skill-choice-modal"),
  skillChoiceTitle: byId("skill-choice-title"),
  skillChoiceText: byId("skill-choice-text"),
  skillChoiceBody: byId("skill-choice-body"),
  btnSkillChoiceConfirm: byId("btn-skill-choice-confirm"),
  skillPrivateModal: byId("skill-private-modal"),
  skillPrivateText: byId("skill-private-text"),
  btnSkillPrivateClose: byId("btn-skill-private-close"),
  selfCards: byId("self-cards"),
  selfArea: byId("self-area"),
  btnToggleCards: byId("btn-toggle-cards"),
  selfHandType: byId("self-hand-type"),
  selfName: byId("self-name"),
  selfConnection: byId("self-connection"),
  selfChips: byId("self-chips"),
  selfBet: byId("self-bet"),
  selfState: byId("self-state"),
  actionCountdown: byId("action-countdown"),
  actionCountdownValue: byId("action-countdown-value"),
  turnKicker: byId("turn-kicker"),
  turnMessage: byId("turn-message"),
  callLabel: byId("call-label"),
  callAmount: byId("call-amount"),
  raiseValue: byId("raise-value"),
  raiseLabel: byId("raise-label"),
  raiseInput: byId("raise-input"),
  raiseMinLabel: byId("raise-min-label"),
  raiseMaxLabel: byId("raise-max-label"),
  raiseConsole: document.querySelector("#screen-game .raise-console"),
  btnRaise: byId("btn-raise"),
  actionButtons: document.querySelectorAll(".action-button[data-action]"),
  raisePresets: document.querySelectorAll("[data-raise-preset]"),
  modeInputs: document.querySelectorAll('input[name="game-mode"]'),
  skillModeInputs: document.querySelectorAll('input[name="skill-mode"]'),
  protocolInputs: document.querySelectorAll('input[name="protocol"]'),
  protocolCards: document.querySelectorAll(".protocol-card"),
  protocolButtons: document.querySelectorAll(".protocol-btn"),
};

const PHASE_LABELS = Object.freeze({
  waiting: "等待",
  pre_flop: "翻牌前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
  showdown: "摊牌",
  end: "结算",
  game_over: "终局",
});

const ACTION_LABELS = Object.freeze({
  fold: "弃牌",
  check: "过牌",
  call: "跟注",
  raise: "加注",
  allin: "ALL IN",
  win_by_fold: "赢得底池",
});

let audioContext = null;
let ambientOscillator = null;
let ambientGain = null;
let connectionBannerTimer = 0;

function ensureAudioContext() {
  if (!window.AudioContext && !window.webkitAudioContext) return null;
  if (!audioContext && navigator.userActivation && !navigator.userActivation.hasBeenActive) return null;
  if (!audioContext) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioCtor();
  }
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  return audioContext;
}

function playTone(kind) {
  if (Number(state.settings.sfx) <= 0) return;
  const context = ensureAudioContext();
  if (!context) return;
  const presets = {
    deal: [440, 0.05],
    flop: [470, 0.08],
    turn: [610, 0.1],
    check: [360, 0.05],
    call: [520, 0.07],
    raise: [660, 0.09],
    chips: [760, 0.045],
    upgrade: [940, 0.12],
    fold: [220, 0.1],
    allin: [120, 0.22],
    river: [820, 0.14],
    win: [880, 0.2],
    lose: [180, 0.2],
    connect: [560, 0.08],
    disconnect: [140, 0.12],
  };
  const preset = presets[kind] || [420, 0.06];
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;
  oscillator.type = kind === "allin" ? "sawtooth" : "sine";
  oscillator.frequency.setValueAtTime(preset[0], now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.002, Number(state.settings.sfx) / 2500), now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + preset[1]);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + preset[1] + 0.02);
}

function updateAmbientAudio() {
  const context = Number(state.settings.music) > 0 ? ensureAudioContext() : audioContext;
  if (!context) return;
  if (!ambientOscillator && Number(state.settings.music) > 0) {
    ambientOscillator = context.createOscillator();
    ambientGain = context.createGain();
    ambientOscillator.type = "sine";
    ambientOscillator.frequency.value = 54;
    ambientGain.gain.value = 0.0001;
    ambientOscillator.connect(ambientGain).connect(context.destination);
    ambientOscillator.start();
  }
  if (ambientGain) {
    const target = Number(state.settings.music) > 0 ? Number(state.settings.music) / 25000 : 0.0001;
    ambientGain.gain.setTargetAtTime(Math.max(0.0001, target), context.currentTime, 0.08);
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE.settings, JSON.stringify(state.settings));
}

function applySettings() {
  document.documentElement.dataset.animation = state.settings.animation;
  document.body.classList.toggle("reduce-motion", Boolean(state.settings.reduceMotion));
  document.body.classList.toggle("low-performance", Boolean(state.settings.lowPerformance));
  document.documentElement.style.setProperty("--ui-scale", String(Number(state.settings.scale) / 100));
  el.settingAnimation.value = state.settings.animation;
  el.settingReduceMotion.checked = Boolean(state.settings.reduceMotion);
  el.settingSfx.value = String(state.settings.sfx);
  el.settingSfxValue.textContent = String(state.settings.sfx) + "%";
  el.settingMusic.value = String(state.settings.music);
  el.settingMusicValue.textContent = String(state.settings.music) + "%";
  el.settingScale.value = String(state.settings.scale);
  el.settingScaleValue.textContent = String(state.settings.scale) + "%";
  el.settingLowPerformance.checked = Boolean(state.settings.lowPerformance);
  updateAmbientAudio();
}

function showToast(message, tone) {
  if (!message) return;
  const toast = document.createElement("div");
  toast.className = "toast " + (tone || "info");
  toast.textContent = message;
  el.toastRegion.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 220);
  }, 2600);
}

function showScreen(name) {
  [el.auth, el.wait, el.game, el.skillLab].forEach((screen) => {
    if (screen) screen.classList.remove("active");
  });
  const target = el[name];
  if (target) target.classList.add("active");
}

function modeInfo(mode) {
  return mode === GAME_MODE.OVERDRIVE
    ? {
        name: "高爆局",
        code: "高爆",
        brief: "高潜力起手牌、强对抗公共牌、河牌过载。下注规则与标准局一致。",
      }
    : {
        name: "标准局",
        code: "标准",
        brief: "每一手使用独立安全洗牌，不受高爆候选算法影响。",
      };
}

function setMode(mode) {
  state.gameMode = mode === GAME_MODE.OVERDRIVE ? GAME_MODE.OVERDRIVE : GAME_MODE.STANDARD;
  const info = modeInfo(state.gameMode);
  if (el.selectedModeTag) {
    el.selectedModeTag.textContent = info.code;
    el.selectedModeTag.className = "mode-pill " + state.gameMode;
  }
  el.modeInputs.forEach((input) => {
    input.checked = input.value === state.gameMode;
  });
  document.body.classList.toggle("overdrive", state.gameMode === GAME_MODE.OVERDRIVE);
  syncProtocolUi();
}

function getMe() {
  return state.players.find((player) => player.playerId === state.playerId);
}

function getOpponent() {
  return state.players.find((player) => player.playerId !== state.playerId);
}

function suitText(suit) {
  return { S: "♠", H: "♥", C: "♣", D: "♦" }[suit] || "";
}

function createCard(card, options) {
  const settings = options || {};
  const node = document.createElement("div");
  node.className = "card";
  if (settings.slot) {
    node.classList.add("card-slot");
    node.setAttribute("aria-hidden", "true");
    return node;
  }
  if (settings.back || !card || !card.rank) {
    node.classList.add("back");
    node.setAttribute("aria-label", "隐藏底牌");
    const glyph = document.createElement("span");
    glyph.textContent = "◇";
    node.appendChild(glyph);
    return node;
  }
  const rank = document.createElement("strong");
  const suit = document.createElement("span");
  rank.textContent = card.rank === "T" ? "10" : card.rank;
  suit.textContent = suitText(card.suit);
  node.append(rank, suit);
  node.setAttribute("aria-label", rank.textContent + suit.textContent);
  if (card.suit === "H" || card.suit === "D") node.classList.add("red");
  if (state.bestFiveCodes.has(card.code)) node.classList.add("glow-gold");
  if (settings.nullified || (settings.nullifiedCodes || []).includes(card.code)) {
    node.classList.add("nullified");
    node.classList.remove("glow-gold");
    const badge = document.createElement("em");
    badge.className = "nullified-badge";
    badge.textContent = "已零化";
    node.appendChild(badge);
  }
  if (settings.reveal) node.classList.add("flip-reveal");
  return node;
}

function renderCardRow(container, cards, options) {
  if (!container) return;
  const settings = options || {};
  container.textContent = "";
  const list = Array.isArray(cards) ? cards : [];
  list.forEach((card) =>
    container.appendChild(
      createCard(card, {
        ...settings,
        nullified: (settings.nullifiedCodes || []).includes(card?.code),
      })
    )
  );
  const padTo = Number(settings.padTo || 0);
  for (let index = list.length; index < padTo; index += 1) {
    container.appendChild(createCard(null, { slot: Boolean(settings.slot), back: !settings.slot }));
  }
}

function updateEyeButton() {
  el.btnToggleCards.setAttribute("aria-pressed", state.showMyCards ? "true" : "false");
  el.btnToggleCards.setAttribute("aria-label", state.showMyCards ? "隐藏我的底牌" : "显示我的底牌");
  el.btnToggleCards.title = state.showMyCards ? "隐藏我的底牌" : "显示我的底牌";
  el.btnToggleCards.classList.toggle("active", state.showMyCards);
  el.btnToggleCards.querySelector(".eye-open")?.classList.toggle("hidden", !state.showMyCards);
  el.btnToggleCards.querySelector(".eye-closed")?.classList.toggle("hidden", state.showMyCards);
}

function playerStateLabel(player) {
  if (!player) return "待机";
  if (player.status === "folded") return "已弃";
  if (player.status === "disconnected") return "断线";
  if (player.status === "out") return "出局";
  if (player.isAllIn) return "全押";
  if (state.currentTurnPlayerId === player.playerId) return "行动中";
  return "就绪";
}

function renderPlayers() {
  const me = getMe();
  const opponent = getOpponent();
  el.selfName.textContent = me?.name || state.myName || "你";
  el.selfChips.textContent = String(me?.chips ?? "—");
  el.selfBet.textContent = String(me?.streetBet ?? 0);
  el.selfState.textContent = playerStateLabel(me);
  el.selfState.dataset.state = (me?.status || "standby").toLowerCase();
  el.selfConnection.innerHTML = "";
  const selfDot = document.createElement("i");
  selfDot.className = "status-dot " + (me?.isConnected ? "online" : "");
  el.selfConnection.append(selfDot, document.createTextNode(me?.isConnected ? "在线" : "离线"));

  el.opponentName.textContent = opponent?.name || "等待对手";
  el.opponentChips.textContent = String(opponent?.chips ?? "—");
  el.opponentBet.textContent = String(opponent?.streetBet ?? 0);
  el.opponentState.textContent = playerStateLabel(opponent);
  el.opponentState.dataset.state = (opponent?.status || "standby").toLowerCase();
  el.opponentConnection.innerHTML = "";
  const opponentDot = document.createElement("i");
  opponentDot.className = "status-dot " + (opponent?.isConnected || opponent?.isBot ? "online" : "");
  const connectionText = opponent?.isBot ? "人机" : opponent?.isConnected ? "在线" : "连接中断";
  el.opponentConnection.append(opponentDot, document.createTextNode(connectionText));
  el.selfArea.classList.toggle("active-turn", state.currentTurnPlayerId === state.playerId);
  el.opponentArea.classList.toggle(
    "active-turn",
    Boolean(state.currentTurnPlayerId && state.currentTurnPlayerId !== state.playerId)
  );
  el.selfArea.classList.toggle("disconnected", Boolean(me && !me.isConnected));
  el.opponentArea.classList.toggle(
    "disconnected",
    Boolean(opponent && !opponent.isConnected && !opponent.isBot)
  );
}

function renderCards() {
  const opponent = getOpponent();
  const ownCards = state.showMyCards || state.handSettling ? state.myCards : [];
  renderCardRow(el.selfCards, ownCards, {
    padTo: 2,
    slot: false,
    back: !state.showMyCards && !state.handSettling,
    reveal: state.handSettling,
  });

  const showdown = state.showdownCards[opponent?.playerId] || [];
  renderCardRow(el.opponentCards, showdown, {
    padTo: 2,
    slot: false,
    reveal: state.handSettling && showdown.length > 0,
  });
  renderCardRow(el.community, state.communityCards, {
    padTo: 5,
    slot: true,
    reveal: true,
    nullifiedCodes: state.nullifiedCommunityCardIds,
  });
  renderSkillHud();
}

function clampRaise(value) {
  const min = Number(state.minRaise || 0);
  const max = Number(state.maxBet || 0);
  if (max <= 0 || max < min) return 0;
  return Math.max(min, Math.min(max, Math.round(Number(value) || min)));
}

function setRaiseValue(value) {
  const target = clampRaise(value);
  el.raiseInput.value = String(target);
  el.raiseValue.textContent = String(target || 0);
}

function setRaiseExpanded(expanded) {
  if (!el.raiseConsole) return;
  el.raiseConsole.classList.toggle("collapsed", !expanded);
  el.raiseConsole.classList.toggle("expanded", expanded);
  if (el.raiseLabel) el.raiseLabel.textContent = expanded ? "确认加注" : "加注";
}

function renderActions() {
  const me = getMe();
  const isMyTurn =
    state.currentTurnPlayerId === state.playerId &&
    ACTIVE_PHASES.has(state.phase) &&
    !state.handSettling &&
    !state.gameOver;
  const toCall = Number.isFinite(state.toCall)
    ? state.toCall
    : Math.max(0, Number(state.currentBet || 0) - Number(me?.streetBet || 0));
  const canCheck = isMyTurn && state.validActions.includes("check");
  const canCall = isMyTurn && state.validActions.includes("call");

  el.callLabel.textContent = "跟注";
  el.callAmount.textContent = toCall > 0 ? String(toCall) : "—";
  el.actionButtons.forEach((button) => {
    const action = button.dataset.action;
    if (action === "check") {
      button.classList.toggle("hidden", !canCheck);
      button.disabled = !canCheck;
      return;
    }
    if (action === "call") {
      button.classList.toggle("hidden", !canCall);
      button.disabled = !canCall;
      return;
    }
    if (action === "raise") {
      // Raise availability handled below with expand UX.
      return;
    }
    button.classList.remove("hidden");
    button.disabled = !(isMyTurn && state.validActions.includes(action));
  });

  const canRaise =
    isMyTurn &&
    state.validActions.includes("raise") &&
    Number(state.maxBet) > 0 &&
    Number(state.maxBet) >= Number(state.minRaise);
  if (el.btnRaise) el.btnRaise.disabled = !canRaise;
  el.raiseInput.disabled = !canRaise;
  if (canRaise) {
    el.raiseInput.min = String(state.minRaise);
    el.raiseInput.max = String(state.maxBet);
    el.raiseMinLabel.textContent = "MIN " + state.minRaise;
    el.raiseMaxLabel.textContent = "MAX " + state.maxBet;
  } else {
    el.raiseInput.min = "0";
    el.raiseInput.max = "0";
    el.raiseMinLabel.textContent = "MIN —";
    el.raiseMaxLabel.textContent = "MAX —";
    setRaiseExpanded(false);
  }
  el.raisePresets.forEach((button) => {
    button.disabled = !canRaise;
  });
  if (canRaise) {
    const existing = Number(el.raiseInput.value);
    setRaiseValue(existing >= state.minRaise && existing <= state.maxBet ? existing : state.minRaise);
  } else {
    setRaiseValue(0);
  }

  if (isMyTurn) {
    el.turnKicker.textContent = "你的回合";
    el.turnMessage.textContent = "选择一项行动";
  } else if (state.currentTurnPlayerId) {
    el.turnKicker.textContent = "对手回合";
    el.turnMessage.textContent = getOpponent()?.status === "disconnected" ? "等待对手恢复连接" : "对手正在行动";
  } else {
    el.turnKicker.textContent = "等待";
    el.turnMessage.textContent = state.handSettling ? "正在结算" : "等待行动指令";
  }
}

function updateActionCountdown() {
  if (state.actionCountdownRaf) cancelAnimationFrame(state.actionCountdownRaf);
  state.actionCountdownRaf = 0;
  if (!state.actionDeadline || !ACTIVE_PHASES.has(state.phase)) {
    el.actionCountdownValue.textContent = "—";
    el.actionCountdown.style.setProperty("--countdown-progress", "0");
    return;
  }
  const tick = () => {
    const remaining = Math.max(0, state.actionDeadline - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    const progress = Math.max(0, Math.min(1, remaining / 30000));
    el.actionCountdownValue.textContent = String(seconds);
    el.actionCountdown.style.setProperty("--countdown-progress", String(progress));
    el.actionCountdown.classList.toggle("urgent", remaining <= 7000);
    if (remaining > 0 && ACTIVE_PHASES.has(state.phase)) {
      state.actionCountdownRaf = requestAnimationFrame(tick);
    }
  };
  tick();
}

function animatePot(value) {
  const next = Math.max(0, Number(value || 0));
  el.pot.textContent = String(next);
  const energy = Math.min(1, next / 2000);
  el.potCore.style.setProperty("--pot-energy", String(energy));
  el.potCore.setAttribute("aria-label", "当前底池 " + next);
}

function renderMode() {
  const info = modeInfo(state.gameMode);
  if (el.waitModeBadge) {
    el.waitModeBadge.textContent = info.code;
    el.waitModeBadge.className = "mode-pill " + state.gameMode;
  }
  if (el.gameModeBadge) {
    el.gameModeBadge.textContent = info.name;
    el.gameModeBadge.className = "mode-pill " + state.gameMode;
  }
  el.waitModeName.textContent = info.name;
  el.waitModeBrief.className = "glass-panel mode-brief " + state.gameMode;
  const briefTitle = el.waitModeBrief.querySelector("h2");
  const briefCopy = el.waitModeBrief.querySelector("p:not(.eyebrow)");
  if (briefTitle) briefTitle.textContent = info.name + " · " + info.code;
  if (briefCopy) briefCopy.textContent = info.brief;
  el.overdriveProfile.classList.toggle("hidden", state.gameMode !== GAME_MODE.OVERDRIVE);
  if (state.gameMode === GAME_MODE.OVERDRIVE && !el.overdriveProfileLabel.textContent) {
    el.overdriveProfileLabel.textContent = "高爆协议已启用";
  }
  document.body.classList.toggle("overdrive", state.gameMode === GAME_MODE.OVERDRIVE);
  el.board.classList.toggle("overdrive", state.gameMode === GAME_MODE.OVERDRIVE);
}

function renderWaitingRoom() {
  const host = state.players[0];
  const guest = state.players[1];
  el.waitRoomId.textContent = state.roomId || "——";
  el.waitHostName.textContent = host?.name || "等待同步";
  el.waitHostState.textContent = host?.isReady ? "已准备" : host ? "未准备" : "校验中";
  el.waitHostState.classList.toggle("muted", !host?.isReady);
  el.waitGuestName.textContent = guest?.name || "等待接入";
  el.waitGuestState.textContent = guest?.isReady ? "已准备" : guest ? "未准备" : "空闲";
  el.waitGuestState.classList.toggle("muted", !guest?.isReady);
  el.waitInitialChips.textContent = "1000";
  el.waitRoomStatus.textContent =
    state.phase === "drafting"
      ? "技能构筑中"
      : state.phase === "waiting"
        ? "等待中"
        : PHASE_LABELS[state.phase] || state.phase;
  if (el.waitSkillMode) el.waitSkillMode.textContent = state.skillMode === "abyss" ? "深渊技能" : "关闭";
  if (el.waitInitialEnergy) el.waitInitialEnergy.textContent = state.skillMode === "abyss" ? "4" : "—";
  if (el.waitPasswordStatus) {
    el.waitPasswordStatus.textContent = state.hasPassword ? "已设置" : "未设置";
  }
  const isHost = Boolean(host && host.playerId === state.playerId);
  state.isHost = isHost;
  if (el.waitPasswordPanel) {
    el.waitPasswordPanel.classList.toggle("hidden", !isHost || !["waiting", "drafting"].includes(state.phase || "waiting"));
  }
}

function renderFairness() {
  const commitment = state.activeCommitment;
  el.commitmentShort.textContent = commitment?.commitment
    ? commitment.commitment.slice(0, 8).toUpperCase()
    : "待定";
  el.fairnessHandId.textContent = commitment?.handId ? "HAND " + commitment.handId.slice(0, 12) : "HAND —";
  const labels = {
    pending: "牌局开始前将锁定牌堆承诺",
    locked: "牌堆承诺已锁定，等待终局揭示",
    verified: "SHA-256 验证通过，牌堆未被中途修改",
    failed: "承诺验证失败，请检查服务器日志",
  };
  el.fairnessResult.textContent = labels[state.fairnessStatus] || labels.pending;
  const summary =
    state.fairnessStatus === "verified"
      ? "通过"
      : state.fairnessStatus === "failed"
        ? "异常"
        : commitment
          ? "已锁"
          : "待锁";
  el.fairnessSummary.textContent = summary;
  el.fairnessSummary.title = labels[state.fairnessStatus] || labels.pending;
  el.fairnessSummary.dataset.status = state.fairnessStatus;
  el.fairnessSummary.classList.toggle("verified", state.fairnessStatus === "verified");
  el.fairnessSummary.classList.toggle("failed", state.fairnessStatus === "failed");
}

function renderState() {
  renderMode();
  renderWaitingRoom();
  renderPlayers();
  renderCards();
  renderActions();
  renderFairness();
  el.phaseText.textContent = PHASE_LABELS[state.phase] || String(state.phase || "").toUpperCase();
  el.board.classList.toggle("river", state.phase === "river");
  document.body.classList.toggle("river-phase", state.phase === "river");
  el.currentBet.textContent = String(state.currentBet || 0);
  el.gameRoomId.textContent = state.roomId || "——";
  el.selfHandType.textContent = state.handHint || "等待发牌";
  animatePot(state.pot);
  updateActionCountdown();
}

function setConnectionUI(connected, message) {
  if (connectionBannerTimer) clearTimeout(connectionBannerTimer);
  connectionBannerTimer = 0;
  const text = connected ? "连接正常" : message || "连接中断";
  [el.lobbyConnection, el.waitConnection, el.gameConnection].forEach((node) => {
    node.innerHTML = "";
    const dot = document.createElement("i");
    dot.className = "status-dot " + (connected ? "online" : "");
    node.append(dot, document.createTextNode(text));
    node.classList.toggle("offline", !connected);
  });
  if (connected) {
    el.connectionBannerText.textContent = "连接已恢复，正在同步服务器状态";
    el.connectionBanner.classList.remove("offline");
    el.connectionBanner.classList.remove("hidden");
    connectionBannerTimer = setTimeout(() => {
      el.connectionBanner.classList.add("hidden");
      connectionBannerTimer = 0;
    }, 1100);
  } else {
    el.connectionBannerText.textContent = message || "网络连接已中断，正在尝试恢复牌局…";
    el.connectionBanner.classList.add("offline");
    el.connectionBanner.classList.remove("hidden");
  }
}

function logAction(message) {
  el.actionLog.textContent = message || "";
}

function setBanner(message, win) {
  el.resultBanner.textContent = message;
  el.resultBanner.className = "result-banner " + (win ? "win" : "lose");
  setTimeout(() => el.resultBanner.classList.add("hidden"), 1800);
}

function animateChipFlow(fromElement, toElement, count = 4) {
  if (state.settings.reduceMotion || state.settings.lowPerformance) return;
  const fromRect = fromElement?.getBoundingClientRect();
  const toRect = toElement?.getBoundingClientRect();
  if (!fromRect || !toRect) return;
  for (let index = 0; index < count; index += 1) {
    const chip = document.createElement("span");
    chip.className = "chip-fx";
    const fromX = fromRect.left + fromRect.width * (0.35 + Math.random() * 0.3);
    const fromY = fromRect.top + fromRect.height * (0.35 + Math.random() * 0.3);
    const toX = toRect.left + toRect.width / 2;
    const toY = toRect.top + toRect.height / 2;
    chip.style.left = String(fromX) + "px";
    chip.style.top = String(fromY) + "px";
    el.chipFx.appendChild(chip);
    chip.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
        {
          transform:
            "translate(" + String(toX - fromX) + "px, " + String(toY - fromY) + "px) scale(.55)",
          opacity: 0.08,
        },
      ],
      { duration: 520, delay: index * 45, easing: "cubic-bezier(.2,.75,.25,1)" }
    );
    setTimeout(() => chip.remove(), 800);
  }
}

function flyChip(actorId) {
  const source = actorId === state.playerId ? el.selfArea : el.opponentArea;
  animateChipFlow(source, el.potCore, 4);
}

function awardPot(winnerId) {
  const target = winnerId === state.playerId ? el.selfArea : el.opponentArea;
  animateChipFlow(el.potCore, target, 7);
}

function pulseBoard(className, duration) {
  el.board.classList.remove(className);
  void el.board.offsetWidth;
  el.board.classList.add(className);
  setTimeout(() => el.board.classList.remove(className), duration || 700);
}

function playAllInEffect() {
  el.flash.classList.remove("hidden");
  document.body.classList.add("shake");
  pulseBoard("allin-overload", 900);
  setTimeout(() => {
    el.flash.classList.add("hidden");
    document.body.classList.remove("shake");
  }, 650);
  playTone("allin");
}

function triggerProtocolBurst() {
  if (state.gameMode !== GAME_MODE.OVERDRIVE) return;
  el.protocolBurst.classList.remove("hidden");
  pulseBoard("protocol-active", 1000);
  setTimeout(() => el.protocolBurst.classList.add("hidden"), 1200);
}

function triggerStreetEffect(phase) {
  if (phase === "river" && state.gameMode === GAME_MODE.OVERDRIVE) {
    el.riverOverload.classList.remove("hidden");
    pulseBoard("river-pulse", 850);
    playTone("river");
    setTimeout(() => el.riverOverload.classList.add("hidden"), 650);
  } else if (phase === "turn") {
    pulseBoard("turn-pulse", 650);
    playTone("turn");
  } else if (phase === "flop") {
    pulseBoard("flop-pulse", 650);
    playTone("flop");
  }
}

function shouldIgnoreSyncEvent(payload, { allowPendingJoin = false } = {}) {
  if (state.atLobby && state.deliberateLeave) return true;
  // Leaving/creating clears roomId; drop late events except room_joined.
  if (!allowPendingJoin && state.deliberateLeave && !state.roomId) return true;
  if (payload?.roomId && state.roomId && payload.roomId !== state.roomId) return true;
  return false;
}

function persistSession() {
  sessionStorage.setItem(STORAGE.playerId, state.playerId);
  if (state.reconnectToken) sessionStorage.setItem(STORAGE.reconnectToken, state.reconnectToken);
  if (state.roomId) sessionStorage.setItem(STORAGE.roomId, state.roomId);
  if (state.myName) sessionStorage.setItem(STORAGE.playerName, state.myName);
}

function clearRoomSession() {
  state.roomId = "";
  state.reconnectToken = "";
  sessionStorage.removeItem(STORAGE.roomId);
  sessionStorage.removeItem(STORAGE.reconnectToken);
}

function resetLocalRoom() {
  clearHandSettlement();
  clearRematch();
  state.players = [];
  state.myCards = [];
  state.showdownCards = {};
  state.bestFiveCodes = new Set();
  state.communityCards = [];
  state.phase = "waiting";
  state.pot = 0;
  state.currentBet = 0;
  state.currentTurnPlayerId = null;
  state.validActions = [];
  state.actionDeadline = null;
  state.handHint = "等待发牌";
  state.handCategory = 0;
  el.selfHandType.dataset.category = "0";
  state.gameOver = false;
  state.activeCommitment = null;
  state.fairnessStatus = "pending";
  el.gameOverModal.classList.add("hidden");
  el.leaveConfirmModal.classList.add("hidden");
}

function emitJoin(roomId, password) {
  socket.emit("join_room", {
    roomId,
    password: password || null,
    playerName: state.myName || undefined,
    playerId: state.playerId,
    reconnectToken: state.reconnectToken || undefined,
  });
}

function prepareManualRoomRequest() {
  state.deliberateLeave = true;
  state.reconnecting = false;
  state.autoLoadoutSubmitted = false;
  clearRoomSession();
  resetLocalRoom();
}

function completeReturnToLobby() {
  state.deliberateLeave = true;
  if (state.gameOver && state.rematchDeadlineAt) {
    socket.emit("rematch_response", { accepted: false });
  }
  socket.emit("leave_room");
  resetLocalRoom();
  clearRoomSession();
  state.atLobby = true;
  showScreen("auth");
  renderState();
}

function returnToLobby() {
  const active = ACTIVE_PHASES.has(state.phase) && !state.gameOver;
  if (active) {
    el.leaveConfirmModal.classList.remove("hidden");
    el.btnLeaveCancel.focus();
    return;
  }
  completeReturnToLobby();
}

function clearHandSettlement() {
  state.handSettling = false;
  state.handSettleEndAt = 0;
  if (state.handSettleRaf) cancelAnimationFrame(state.handSettleRaf);
  if (state.handSettleTimer) clearTimeout(state.handSettleTimer);
  state.handSettleRaf = 0;
  state.handSettleTimer = 0;
  el.handSettleModal.classList.add("hidden");
  el.board.classList.remove("settle-dim");
  el.chipFx.classList.remove("settlement-flow");
}

function updateHandSettleCountdown() {
  if (!state.handSettling) return;
  const remaining = Math.max(0, state.handSettleEndAt - Date.now());
  el.settleCountdownNum.textContent = String(Math.ceil(remaining / 1000));
  if (remaining > 0) state.handSettleRaf = requestAnimationFrame(updateHandSettleCountdown);
}

function startHandSettlement(payload) {
  if (shouldIgnoreSyncEvent(payload)) return;
  clearHandSettlement();
  el.leaveConfirmModal.classList.add("hidden");
  state.handSettling = true;
  state.phase = payload.reason === "showdown" ? "showdown" : "end";
  state.validActions = [];
  state.currentTurnPlayerId = null;
  state.actionDeadline = null;
  state.handSettleEndAt = Date.now() + Number(payload.settleMs || HAND_SETTLE_MS);
  state.communityCards = payload.communityCards || state.communityCards;
  state.showdownCards = {};
  state.bestFiveCodes = new Set();
  (payload.players || []).forEach((player) => {
    if (player.cards?.length) state.showdownCards[player.playerId] = player.cards;
    (player.bestFive || []).forEach((card) => state.bestFiveCodes.add(card.code));
  });
  const me = getMe();
  const opponent = getOpponent();
  const meDetail = (payload.players || []).find((player) => player.playerId === state.playerId);
  const opponentDetail = (payload.players || []).find((player) => player.playerId !== state.playerId);
  const won = !payload.tie && payload.winner === state.playerId;
  el.settleVerdict.textContent = payload.tie ? "平局" : won ? "胜利" : "败北";
  el.settleVerdict.className = payload.tie ? "tie-text" : won ? "win-text" : "lose-text";
  if (payload.reason === "fold") {
    el.settleDetail.textContent = won
      ? (opponent?.name || "对手") + " 弃牌，你赢得底池 " + payload.pot
      : "你已弃牌，" + (payload.winnerName || opponent?.name || "对手") + " 赢得底池 " + payload.pot;
  } else if (payload.tie) {
    el.settleDetail.textContent = "底池 " + payload.pot + " 平分";
  } else {
    el.settleDetail.textContent = (payload.winnerName || "胜方") + " 赢得底池 " + payload.pot;
  }
  el.settleSelfLabel.textContent = me?.name || "你";
  el.settleOppLabel.textContent = opponent?.name || "对手";
  renderCardRow(el.settleCommunity, payload.communityCards || [], { padTo: 5, slot: true, reveal: true });
  renderCardRow(el.settleSelfCards, meDetail?.cards || state.myCards, { reveal: true });
  renderCardRow(el.settleOppCards, opponentDetail?.cards || [], { reveal: true });
  el.settleSelfHand.textContent = meDetail?.handName || "—";
  el.settleOppHand.textContent = opponentDetail?.handName || (opponentDetail?.folded ? "已弃牌" : "未公开");
  const types = [];
  if (meDetail?.handName) types.push("你：" + meDetail.handName);
  if (opponentDetail?.handName) types.push((opponent?.name || "对手") + "：" + opponentDetail.handName);
  el.settleHandName.textContent = types.join(" ｜ ");
  el.settleNext.textContent = payload.isFinalHand ? "整场对局即将结束" : "下一手即将开始";
  el.handSettleModal.classList.remove("hidden");
  el.board.classList.add("settle-dim");
  el.chipFx.classList.add("settlement-flow");
  if (payload.tie) {
    awardPot(state.playerId);
    if (opponent?.playerId) awardPot(opponent.playerId);
  } else if (payload.winner) {
    awardPot(payload.winner);
  }
  updateHandSettleCountdown();
  renderState();
  setBanner(payload.tie ? "平局" : won ? "胜利" : "败北", payload.tie || won);
  playTone(payload.tie || won ? "win" : "lose");
  state.handSettleTimer = setTimeout(clearHandSettlement, Number(payload.settleMs || HAND_SETTLE_MS) + 700);
}

function clearRematch() {
  if (state.rematchRaf) cancelAnimationFrame(state.rematchRaf);
  state.rematchRaf = 0;
  state.rematchDeadlineAt = 0;
  state.rematchAcceptedIds = new Set();
  el.rematchBox.classList.add("hidden");
  el.btnRematchYes.disabled = false;
  el.btnRematchNo.disabled = false;
  el.btnBackLobby.classList.remove("hidden");
}

function updateRematchCountdown() {
  if (!state.rematchDeadlineAt) return;
  const remaining = Math.max(0, state.rematchDeadlineAt - Date.now());
  el.rematchCountdown.textContent = String(Math.ceil(remaining / 1000));
  if (remaining > 0) state.rematchRaf = requestAnimationFrame(updateRematchCountdown);
}

function updateRematch(payload) {
  const rematch = payload.rematch || payload;
  if (state.rematchRaf) cancelAnimationFrame(state.rematchRaf);
  state.rematchAcceptedIds = new Set((rematch.accepted || []).map((entry) => entry.playerId));
  state.rematchDeadlineAt = rematch.deadlineAt || Date.now() + (rematch.timeoutMs || REMATCH_TIMEOUT_MS);
  const humans = (rematch.players || state.players).filter((player) => !player.isBot);
  const accepted = state.rematchAcceptedIds.size;
  const mine = state.rematchAcceptedIds.has(state.playerId);
  el.rematchStatus.textContent = mine
    ? "已确认继续，等待对手（" + accepted + "/" + humans.length + "）"
    : "是否再来一局？双方确认后重置筹码（" + accepted + "/" + humans.length + "）";
  el.btnRematchYes.disabled = mine;
  el.rematchBox.classList.remove("hidden");
  el.btnBackLobby.classList.add("hidden");
  updateRematchCountdown();
}

function showGameOver(payload) {
  if (shouldIgnoreSyncEvent(payload)) return;
  clearHandSettlement();
  el.leaveConfirmModal.classList.add("hidden");
  state.gameOver = true;
  state.phase = "game_over";
  state.currentTurnPlayerId = null;
  state.validActions = [];
  state.actionDeadline = null;
  if (Array.isArray(payload.players)) state.players = payload.players;
  const won = payload.winner === state.playerId;
  el.gameOverTitle.textContent = won ? "整场胜利" : "整场结束";
  el.gameOverTitle.className = won ? "win-text" : "lose-text";
  const opponent = getOpponent();
  el.gameOverMsg.textContent =
    payload.reason === "disconnect_timeout_forfeit"
      ? won
        ? "对手断线超时，你获得胜利"
        : "你的连接超时，本局判负"
      : won
        ? (payload.loserName || opponent?.name || "对手") + " 筹码耗尽"
        : (payload.winnerName || opponent?.name || "对手") + " 赢得整场对局";
  el.gameOverModal.classList.remove("hidden");
  if (payload.rematch) updateRematch({ rematch: payload.rematch });
  else clearRematch();
  renderState();
  playTone(won ? "win" : "lose");
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await window.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function verifyHandReveal(payload) {
  const deck = Array.isArray(payload.deck) ? payload.deck : [];
  const codes = deck.map((card) => card?.code).filter(Boolean);
  const known = state.commitments.get(payload.handId);
  const validShape =
    codes.length === 52 &&
    new Set(codes).size === 52 &&
    codes.every((code) => /^[SHCD](?:[2-9TJQKA])$/.test(code));
  const commitment = payload.commitment || known?.commitment;
  const metadataMatches =
    known &&
    known.mode === payload.mode &&
    String(known.skillMode || "off") === String(payload.skillMode || known.skillMode || "off") &&
    known.commitment === commitment &&
    typeof payload.nonce === "string";
  if (!window.crypto?.subtle || !validShape || !metadataMatches) {
    state.fairnessStatus = "failed";
    renderFairness();
    showToast("牌堆承诺验证失败", "error");
    return;
  }
  const serialized = codes.join(",");
  const computed = await sha256Hex(
    String(payload.handId) +
      String(payload.mode) +
      String(payload.skillMode || state.skillMode || "off") +
      serialized +
      String(payload.nonce)
  );
  state.fairnessStatus = computed.toLowerCase() === String(commitment).toLowerCase() ? "verified" : "failed";
  renderFairness();
  showToast(
    state.fairnessStatus === "verified" ? "牌堆承诺验证通过" : "牌堆承诺不一致",
    state.fairnessStatus === "verified" ? "success" : "error"
  );
  if (payload.profile && state.gameMode === GAME_MODE.OVERDRIVE) {
    el.overdriveProfileLabel.textContent = payload.profile.label || payload.profile.type || "高爆牌局";
  }
}

function syncPlayers(players) {
  if (Array.isArray(players)) state.players = players;
  renderState();
}


function selectedMode() {
  return document.querySelector('input[name="game-mode"]:checked')?.value || GAME_MODE.STANDARD;
}

function selectedSkillMode() {
  return document.querySelector('input[name="skill-mode"]:checked')?.value || "off";
}

function protocolValue(gameMode, skillMode) {
  return (gameMode === GAME_MODE.OVERDRIVE ? "overdrive" : "standard") + "-" + (skillMode === "abyss" ? "abyss" : "off");
}

function protocolSummaryText(gameMode, skillMode) {
  const deal = gameMode === GAME_MODE.OVERDRIVE ? "高爆局" : "标准局";
  const skill = skillMode === "abyss" ? "深渊技能" : "无技能";
  return deal + " · " + skill;
}

function loadSavedLoadout() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE.skillLoadout) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch (_error) {
    return [];
  }
}

function validateLoadoutIds(ids, catalog = state.skillCatalog) {
  const min = state.skillConfig.minEquipped || 2;
  const max = state.skillConfig.maxEquipped || 4;
  const maxLoad = state.skillConfig.maxLoad || 8;
  if (!Array.isArray(ids) || ids.length < min || ids.length > max) {
    return { ok: false, load: 0, error: `请选择 ${min}–${max} 个技能` };
  }
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) return { ok: false, load: 0, error: "技能不能重复" };
  if (!catalog.length) {
    return { ok: true, load: 0, skillIds: unique, pendingCatalog: true };
  }
  let load = 0;
  for (const id of unique) {
    const def = catalog.find((skill) => skill.id === id);
    if (!def) return { ok: false, load: 0, error: "存在未知技能" };
    load += def.load || 0;
  }
  if (load > maxLoad) return { ok: false, load, error: `负载不能超过 ${maxLoad}` };
  return { ok: true, load, skillIds: unique };
}

function isLoadoutConfigured() {
  return validateLoadoutIds(state.savedLoadout).ok;
}

function syncProtocolUi() {
  const value = protocolValue(state.gameMode, state.skillMode || "off");
  el.protocolInputs?.forEach((input) => {
    const selected = input.value === value;
    input.checked = selected;
    input.closest(".protocol-card")?.classList.toggle("selected", selected);
  });
  if (el.protocolSummary) {
    el.protocolSummary.textContent = protocolSummaryText(state.gameMode, state.skillMode || "off");
  }
  updateSkillPrepUi();
}

function updateSkillPrepUi() {
  const ready = isLoadoutConfigured();
  const load = validateLoadoutIds(state.savedLoadout).load || 0;
  if (el.skillPrepStatus) {
    el.skillPrepStatus.classList.toggle("ready", ready);
    el.skillPrepStatus.textContent = ready
      ? `已配置 ${state.savedLoadout.length} 技能 · 负载 ${load}/8`
      : "未配置 · 技能协议不可进入";
  }
  el.protocolCards?.forEach((card) => {
    const needsSkill = card.dataset.skillMode === "abyss";
    card.classList.toggle("locked-abyss", needsSkill && !ready);
  });
}

function setProtocol(gameMode, skillMode) {
  setMode(gameMode);
  setSkillMode(skillMode);
}

function openSkillLab(pendingAction = null) {
  state.pendingRoomAction = pendingAction;
  state.selectedLoadout = [...state.savedLoadout];
  showScreen("skillLab");
  renderSkillLab();
}

function closeSkillLab() {
  showScreen("auth");
  updateSkillPrepUi();
}

async function ensureSkillCatalog() {
  if (state.skillCatalog.length) return state.skillCatalog;
  try {
    const response = await fetch("/api/skills");
    if (!response.ok) throw new Error("skill api failed");
    const data = await response.json();
    state.skillCatalog = Array.isArray(data.skills) ? data.skills : [];
    if (data.config) {
      state.skillConfig = {
        minEquipped: data.config.minEquipped || 2,
        maxEquipped: data.config.maxEquipped || 4,
        maxLoad: data.config.maxLoad || 8,
      };
    }
  } catch (_error) {
    showToast("技能目录加载失败", "error");
  }
  return state.skillCatalog;
}

function renderSkillLab() {
  if (!el.skillLabCatalog) return;
  const validation = validateLoadoutIds(state.selectedLoadout);
  const load = state.selectedLoadout.reduce((sum, id) => {
    const def = state.skillCatalog.find((skill) => skill.id === id);
    return sum + (def?.load || 0);
  }, 0);
  if (el.labLoadMeter) el.labLoadMeter.textContent = load + " / " + (state.skillConfig.maxLoad || 8);
  if (el.skillLabStatus) {
    el.skillLabStatus.textContent = validation.ok
      ? "构筑有效，可保存后进入技能局。"
      : validation.error || "选择 2–4 个技能，总负载不超过 8。";
  }
  if (el.btnSaveLoadout) el.btnSaveLoadout.disabled = !validation.ok;
  el.skillLabCatalog.textContent = "";
  state.skillCatalog.forEach((skill) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "skill-card load-" + skill.load;
    if (state.selectedLoadout.includes(skill.id)) card.classList.add("selected");
    card.innerHTML =
      "<strong>" +
      skill.name +
      "</strong><small>负载 " +
      skill.load +
      " · 能量 " +
      skill.energyCost +
      "</small><span>" +
      skill.description +
      "</span>";
    card.addEventListener("click", () => {
      const idx = state.selectedLoadout.indexOf(skill.id);
      if (idx >= 0) state.selectedLoadout.splice(idx, 1);
      else if (state.selectedLoadout.length >= (state.skillConfig.maxEquipped || 4)) {
        showToast("最多装备 " + (state.skillConfig.maxEquipped || 4) + " 个技能", "error");
        return;
      } else if (loadoutLoad([...state.selectedLoadout, skill.id]) > (state.skillConfig.maxLoad || 8)) {
        showToast("负载已达上限", "error");
        return;
      } else {
        state.selectedLoadout.push(skill.id);
      }
      renderSkillLab();
    });
    el.skillLabCatalog.appendChild(card);
  });
}

function saveLoadoutFromLab() {
  const validation = validateLoadoutIds(state.selectedLoadout);
  if (!validation.ok) return showToast(validation.error || "构筑无效", "error");
  state.savedLoadout = [...validation.skillIds];
  localStorage.setItem(STORAGE.skillLoadout, JSON.stringify(state.savedLoadout));
  updateSkillPrepUi();
  showToast("技能构筑已保存", "success");
  const pending = state.pendingRoomAction;
  state.pendingRoomAction = null;
  closeSkillLab();
  if (pending) startRoomAction(pending.type, pending.gameMode, pending.skillMode);
}

function requireLoadoutForSkillMode(skillMode, pendingAction) {
  if (skillMode !== "abyss") return true;
  if (isLoadoutConfigured()) return true;
  showToast("请先完成技能自定义配置", "error");
  ensureSkillCatalog().then(() => openSkillLab(pendingAction));
  return false;
}

function startRoomAction(type, gameMode, skillMode) {
  setProtocol(gameMode, skillMode);
  if (!requireLoadoutForSkillMode(skillMode, { type, gameMode, skillMode })) return;

  prepareManualRoomRequest();
  state.autoLoadoutSubmitted = false;
  state.myName = (el.inputName.value || "").trim() || "player1";
  state.atLobby = false;
  sessionStorage.setItem(STORAGE.playerName, state.myName);
  if (type === "solo") {
    socket.emit("create_solo_room", {
      playerName: state.myName,
      playerId: state.playerId,
      reconnectToken: state.reconnectToken || undefined,
      gameMode: state.gameMode,
      skillMode: state.skillMode,
    });
    return;
  }
  socket.emit("create_room", {
    password: null,
    playerName: state.myName,
    playerId: state.playerId,
    reconnectToken: state.reconnectToken || undefined,
    gameMode: state.gameMode,
    skillMode: state.skillMode,
  });
}

function openJoinPasswordModal(roomId) {
  state.pendingJoinRoomId = roomId;
  if (el.modalJoinPassword) el.modalJoinPassword.value = "";
  el.joinPasswordModal?.classList.remove("hidden");
  el.modalJoinPassword?.focus();
}

function closeJoinPasswordModal() {
  el.joinPasswordModal?.classList.add("hidden");
  state.pendingJoinRoomId = null;
}

function confirmJoinWithPassword() {
  const roomId = state.pendingJoinRoomId || (el.inputRoom.value || "").trim().toUpperCase();
  const password = (el.modalJoinPassword?.value || "").trim();
  if (!roomId) return showToast("请输入房间号", "error");
  if (!password) return showToast("请输入房间密码", "error");
  el.joinPasswordModal?.classList.add("hidden");
  prepareManualRoomRequest();
  state.autoLoadoutSubmitted = false;
  state.myName = (el.inputName.value || "").trim() || "player2";
  state.atLobby = false;
  sessionStorage.setItem(STORAGE.playerName, state.myName);
  emitJoin(roomId, password);
}

function maybeAutoSubmitLoadout() {
  if (state.skillMode !== "abyss") return;
  if (!["waiting", "drafting"].includes(state.phase || "waiting")) return;
  if (!isLoadoutConfigured()) return;
  const me = getMe();
  if (me?.skills?.loadoutConfirmed) return;
  if (state.autoLoadoutSubmitted) return;
  state.selectedLoadout = [...state.savedLoadout];
  state.autoLoadoutSubmitted = true;
  socket.emit("skill:loadout:set", { skillIds: state.savedLoadout });
}

el.modeInputs.forEach((input) => input.addEventListener("change", () => setMode(input.value)));
el.protocolCards?.forEach((card) => {
  card.addEventListener("click", (event) => {
    if (event.target.closest(".protocol-btn")) return;
    setProtocol(card.dataset.gameMode || "standard", card.dataset.skillMode || "off");
  });
});
el.protocolButtons?.forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const card = button.closest(".protocol-card");
    if (!card) return;
    startRoomAction(
      button.dataset.roomAction === "solo" ? "solo" : "create",
      card.dataset.gameMode || "standard",
      card.dataset.skillMode || "off"
    );
  });
});
el.btnJoin.addEventListener("click", () => {
  const roomId = (el.inputRoom.value || "").trim().toUpperCase();
  if (!roomId) return showToast("请输入房间号", "error");
  prepareManualRoomRequest();
  state.autoLoadoutSubmitted = false;
  state.pendingJoinRoomId = roomId;
  state.myName = (el.inputName.value || "").trim() || "player2";
  state.atLobby = false;
  sessionStorage.setItem(STORAGE.playerName, state.myName);
  emitJoin(roomId, null);
});
el.btnJoinPasswordConfirm?.addEventListener("click", confirmJoinWithPassword);
el.btnJoinPasswordCancel?.addEventListener("click", () => {
  closeJoinPasswordModal();
  state.atLobby = true;
  showScreen("auth");
});
el.modalJoinPassword?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") confirmJoinWithPassword();
});
el.btnSetRoomPassword?.addEventListener("click", () => {
  socket.emit("room:set_password", {
    password: (el.inputWaitPassword?.value || "").trim() || "",
  });
});
el.btnOpenSkillLab?.addEventListener("click", async () => {
  await ensureSkillCatalog();
  openSkillLab(null);
});
el.btnBackSkillLab?.addEventListener("click", () => {
  state.pendingRoomAction = null;
  closeSkillLab();
});
el.btnSaveLoadout?.addEventListener("click", saveLoadoutFromLab);
el.btnClearLoadout?.addEventListener("click", () => {
  state.selectedLoadout = [];
  renderSkillLab();
});
el.btnCopyRoom.addEventListener("click", async () => {
  if (!state.roomId) return;
  try {
    await navigator.clipboard.writeText(state.roomId);
    showToast("房间号已复制", "success");
  } catch (_error) {
    showToast("复制失败，请手动记录 " + state.roomId, "error");
  }
});
el.btnBackWait.addEventListener("click", returnToLobby);
el.btnBackGame.addEventListener("click", returnToLobby);
el.btnBackLobby.addEventListener("click", returnToLobby);

el.actionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    if (!action || button.disabled) return;
    ensureAudioContext();
    if (action === "raise") {
      const expanded = el.raiseConsole?.classList.contains("expanded");
      if (!expanded) {
        setRaiseExpanded(true);
        return;
      }
      setRaiseExpanded(false);
    } else {
      setRaiseExpanded(false);
    }
    const payload = { action };
    if (action === "raise") payload.amount = Number(el.raiseInput.value);
    socket.emit("player_action", payload);
  });
});
el.raiseInput.addEventListener("input", () => setRaiseValue(el.raiseInput.value));
el.raisePresets.forEach((button) => {
  button.addEventListener("click", () => {
    const preset = button.dataset.raisePreset;
    let value = state.minRaise;
    if (preset === "half") value = state.currentBet + Math.max(1, Math.round(state.pot / 2));
    if (preset === "pot") value = state.currentBet + state.pot;
    if (preset === "max") value = state.maxBet;
    setRaiseValue(value);
  });
});
el.btnLeaveCancel.addEventListener("click", () => {
  el.leaveConfirmModal.classList.add("hidden");
  el.btnBackGame.focus();
});
el.btnLeaveConfirm.addEventListener("click", () => {
  el.leaveConfirmModal.classList.add("hidden");
  completeReturnToLobby();
});
el.btnToggleCards.addEventListener("click", () => {
  state.showMyCards = !state.showMyCards;
  localStorage.setItem(STORAGE.revealCards, state.showMyCards ? "1" : "0");
  updateEyeButton();
  renderCards();
});

el.btnRematchYes.addEventListener("click", () => {
  el.btnRematchYes.disabled = true;
  socket.emit("rematch_response", { accepted: true });
});
el.btnRematchNo.addEventListener("click", () => {
  el.btnRematchYes.disabled = true;
  el.btnRematchNo.disabled = true;
  socket.emit("rematch_response", { accepted: false });
});

el.btnSettings.addEventListener("click", () => {
  el.settingsModal.classList.remove("hidden");
  el.btnCloseSettings.focus();
});
el.btnCloseSettings.addEventListener("click", () => el.settingsModal.classList.add("hidden"));
el.settingAnimation.addEventListener("change", () => {
  state.settings.animation = el.settingAnimation.value;
  saveSettings();
  applySettings();
});
el.settingReduceMotion.addEventListener("change", () => {
  state.settings.reduceMotion = el.settingReduceMotion.checked;
  saveSettings();
  applySettings();
});
el.settingSfx.addEventListener("input", () => {
  state.settings.sfx = Number(el.settingSfx.value);
  saveSettings();
  applySettings();
});
el.settingMusic.addEventListener("input", () => {
  state.settings.music = Number(el.settingMusic.value);
  saveSettings();
  applySettings();
});
el.settingScale.addEventListener("input", () => {
  state.settings.scale = Number(el.settingScale.value);
  saveSettings();
  applySettings();
});
el.settingLowPerformance.addEventListener("change", () => {
  state.settings.lowPerformance = el.settingLowPerformance.checked;
  saveSettings();
  applySettings();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const wasLeaveOpen = !el.leaveConfirmModal.classList.contains("hidden");
  el.settingsModal.classList.add("hidden");
  el.leaveConfirmModal.classList.add("hidden");
  el.joinPasswordModal?.classList.add("hidden");
  if (wasLeaveOpen) el.btnBackGame.focus();
});

socket.on("connect", () => {
  setConnectionUI(true, "连接正常");
  playTone("connect");
  const savedRoom = sessionStorage.getItem(STORAGE.roomId);
  const savedToken = sessionStorage.getItem(STORAGE.reconnectToken);
  if (savedRoom && savedToken && !state.deliberateLeave) {
    state.roomId = savedRoom;
    state.reconnectToken = savedToken;
    state.myName = sessionStorage.getItem(STORAGE.playerName) || state.myName;
    state.atLobby = false;
    state.reconnecting = true;
    showScreen("wait");
    emitJoin(savedRoom);
  }
});
socket.on("disconnect", () => {
  setConnectionUI(false, "网络连接已中断，正在尝试恢复牌局…");
  playTone("disconnect");
  state.players = state.players.map((player) =>
    player.playerId === state.playerId ? Object.assign({}, player, { isConnected: false }) : player
  );
  renderState();
});
socket.on("connect_error", () => setConnectionUI(false, "无法连接服务器，正在重试…"));
socket.io.on("reconnect_attempt", () => setConnectionUI(false, "正在恢复实时连接…"));
socket.io.on("reconnect_failed", () => showToast("自动重连失败，请刷新页面", "error"));

socket.on("room_created", (payload) => {
  state.roomId = payload.roomId;
  state.gameMode = payload.gameMode || state.gameMode;
  el.inputRoom.value = state.roomId;
  persistSession();
});
function applyRoomJoinedPayload(payload, { fromLobby = false } = {}) {
  state.roomId = payload.roomId;
  state.gameMode = payload.gameMode || state.gameMode;
  state.skillMode = payload.skillMode || state.skillMode;
  if (Object.prototype.hasOwnProperty.call(payload, "phase") && payload.phase) {
    state.phase = payload.phase;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "hasPassword")) {
    state.hasPassword = Boolean(payload.hasPassword);
  }
  if (Array.isArray(payload.skillCatalog) && payload.skillCatalog.length) {
    state.skillCatalog = payload.skillCatalog;
  }
  state.playerId = payload.playerId || state.playerId;
  state.reconnectToken = payload.reconnectToken || state.reconnectToken;
  if (Array.isArray(payload.players)) state.players = payload.players;
  persistSession();
}

function resolveLobbyScreenAfterJoin() {
  const handPhases = new Set([
    "pre_flop",
    "flop",
    "turn",
    "river",
    "showdown",
    "end",
    "before_turn",
    "before_river",
  ]);
  if (handPhases.has(state.phase)) {
    showScreen("game");
    return;
  }
  const waitingForDraft =
    state.skillMode === "abyss" && ["waiting", "drafting"].includes(state.phase || "waiting");
  if (waitingForDraft || state.players.length < 2) showScreen("wait");
  else showScreen("game");
}

socket.on("room_joined", (payload) => {
  // create/join clears roomId with deliberateLeave; must allow this event through
  if (shouldIgnoreSyncEvent(payload, { allowPendingJoin: true })) return;
  const enteringFromLobby = state.atLobby || !state.roomId || state.roomId !== payload.roomId;
  state.atLobby = false;
  state.reconnecting = false;
  state.deliberateLeave = false;
  applyRoomJoinedPayload(payload, { fromLobby: enteringFromLobby });

  if (enteringFromLobby && state.skillMode === "abyss" && !isLoadoutConfigured()) {
    showToast("技能局需先完成技能自定义配置", "error");
    completeReturnToLobby();
    ensureSkillCatalog().then(() => openSkillLab(null));
    return;
  }

  resolveLobbyScreenAfterJoin();
  maybeAutoSubmitLoadout();
  renderSkillDraft();
  renderState();
});
socket.on("room_state", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  state.gameMode = payload.gameMode || state.gameMode;
  state.skillMode = payload.skillMode || state.skillMode;
  state.phase = payload.phase || state.phase;
  if (Object.prototype.hasOwnProperty.call(payload, "hasPassword")) {
    state.hasPassword = Boolean(payload.hasPassword);
  }
  state.pot = payload.pot ?? state.pot;
  state.currentBet = payload.currentBet ?? state.currentBet;
  state.dealer = payload.dealer || null;
  if (Object.prototype.hasOwnProperty.call(payload, "activePlayerId")) {
    state.currentTurnPlayerId = payload.activePlayerId;
  } else if (Object.prototype.hasOwnProperty.call(payload, "currentPlayer")) {
    state.currentTurnPlayerId = payload.currentPlayer;
  }
  state.communityCards = payload.communityCards || state.communityCards;
  state.nullifiedCommunityCardIds = payload.nullifiedCommunityCardIds || state.nullifiedCommunityCardIds;
  if (payload.skillState) state.skillState = payload.skillState;
  state.players = payload.players || state.players;
  if (Object.prototype.hasOwnProperty.call(payload, "actionDeadline")) {
    state.actionDeadline = payload.actionDeadline;
  }
  if (payload.handId && payload.deckCommitment && !state.commitments.has(payload.handId)) {
    const record = {
      handId: payload.handId,
      mode: payload.gameMode || state.gameMode,
      skillMode: payload.skillMode || state.skillMode || "off",
      commitment: payload.deckCommitment,
    };
    state.commitments.set(record.handId, record);
    state.activeCommitment = record;
    state.fairnessStatus = "locked";
  }
  if (payload.phase === "game_over") state.gameOver = true;
  if (!state.atLobby) {
    const handPhases = new Set([
      "pre_flop",
      "flop",
      "turn",
      "river",
      "showdown",
      "end",
      "before_turn",
      "before_river",
      "game_over",
    ]);
    if (handPhases.has(state.phase)) showScreen("game");
    else if (state.phase === "drafting" || state.players.length < 2) showScreen("wait");
    else showScreen("game");
  }
  maybeAutoSubmitLoadout();
  renderSkillDraft();
  renderState();
});
socket.on("game_started", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  state.gameMode = payload.gameMode || state.gameMode;
  if (payload.skillMode) state.skillMode = payload.skillMode;
  state.phase = "pre_flop";
  state.gameOver = false;
  clearRematch();
  el.gameOverModal.classList.add("hidden");
  el.leaveConfirmModal.classList.add("hidden");
  showScreen("game");
  if (state.gameMode === GAME_MODE.OVERDRIVE) triggerProtocolBurst();
});
socket.on("your_cards", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  clearHandSettlement();
  state.gameOver = false;
  state.myCards = payload.cards || [];
  state.showdownCards = {};
  state.bestFiveCodes = new Set();
  state.handHint = "计算中…";
  state.handCategory = 0;
  el.selfHandType.dataset.category = "0";
  renderState();
  playTone("deal");
});
socket.on("hand_hint", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  const previousCategory = state.handCategory;
  state.handHint = payload.handName || "未成牌";
  state.handCategory = Number(payload.category || 0);
  state.bestFiveCodes = new Set((payload.bestFive || []).map((card) => card.code));
  el.selfHandType.dataset.category = String(state.handCategory);
  renderCards();
  el.selfHandType.textContent = state.handHint;
  if (state.handCategory > previousCategory) {
    pulseBoard("hand-upgrade-" + Math.min(9, state.handCategory), 850);
    playTone("upgrade");
  }
});
socket.on("community_cards", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  const previousCount = state.communityCards.length;
  state.communityCards = payload.cards || [];
  state.phase = payload.phase || state.phase;
  if (payload.nullifiedCommunityCardIds) {
    state.nullifiedCommunityCardIds = payload.nullifiedCommunityCardIds;
  }
  if (state.communityCards.length > previousCount) {
    state.currentTurnPlayerId = null;
    state.validActions = [];
    state.actionDeadline = null;
  }
  renderState();
  if (state.communityCards.length > previousCount) triggerStreetEffect(state.phase);
});
socket.on("player_turn", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  state.currentTurnPlayerId = payload.playerId;
  state.validActions = payload.playerId === state.playerId ? payload.validActions || [] : [];
  state.minRaise = Number(payload.minRaise || 0);
  state.maxBet = Number(payload.maxBet || 0);
  state.toCall = Number(payload.toCall || 0);
  state.actionDeadline = payload.actionDeadline || null;
  logAction(payload.playerId === state.playerId ? "轮到你行动" : "对手正在行动");
  renderState();
});
socket.on("action_made", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  state.currentTurnPlayerId = null;
  state.validActions = [];
  state.actionDeadline = null;
  if (Array.isArray(payload.playerChips)) state.players = payload.playerChips;
  if (typeof payload.pot === "number") state.pot = payload.pot;
  const label = ACTION_LABELS[payload.action] || payload.action;
  logAction("玩家 " + payload.playerId + " · " + label + (payload.amount ? " " + payload.amount : ""));
  if (["call", "raise", "allin"].includes(payload.action) && payload.amount > 0) {
    flyChip(payload.playerId);
    playTone("chips");
  }
  if (payload.action === "allin") playAllInEffect();
  else playTone(payload.action);
  renderState();
});
socket.on("hand_result", startHandSettlement);
socket.on("game_over", showGameOver);
socket.on("rematch_update", (payload) => {
  if (state.gameOver) updateRematch(payload);
});
socket.on("rematch_started", (payload) => {
  clearRematch();
  el.gameOverModal.classList.add("hidden");
  state.gameOver = false;
  state.phase = "waiting";
  if (Array.isArray(payload.players)) state.players = payload.players;
  logAction("双方确认，再来一局");
  renderState();
});
socket.on("hand_commitment", (payload) => {
  const record = {
    handId: payload.handId,
    mode: payload.mode,
    skillMode: payload.skillMode || state.skillMode || "off",
    commitment: payload.commitment,
  };
  state.commitments.set(record.handId, record);
  state.activeCommitment = record;
  state.fairnessStatus = "locked";
  renderFairness();
});
socket.on("hand_reveal", (payload) => {
  verifyHandReveal(payload).catch(() => {
    state.fairnessStatus = "failed";
    renderFairness();
  });
});
socket.on("player_joined", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  if (payload.players) syncPlayers(payload.players);
  if (payload.playerId && payload.playerId !== state.playerId) {
    showToast("玩家已接入", "success");
  }
});
socket.on("player_reconnected", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  if (payload.players) syncPlayers(payload.players);
  if (payload.playerId && payload.playerId !== state.playerId) {
    showToast("玩家连接已恢复", "success");
    playTone("connect");
  }
});
socket.on("player_disconnected", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  if (Array.isArray(payload.players)) syncPlayers(payload.players);
  showToast("玩家 " + payload.playerId + " 连接中断", "error");
  playTone("disconnect");
});
socket.on("player_left", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  if (Array.isArray(payload.players)) syncPlayers(payload.players);
  else if (payload.playerId) {
    state.players = state.players.filter((p) => p.playerId !== payload.playerId);
    renderState();
  }
  showToast("玩家 " + payload.playerId + " 已离开", "info");
});
socket.on("room_closed", (payload) => {
  resetLocalRoom();
  clearRoomSession();
  state.atLobby = true;
  showScreen("auth");
  showToast(payload.reason === "rematch_declined" ? "有玩家结束连接，房间已关闭" : "重赛确认超时，房间已关闭", "info");
});
socket.on("left_room", (payload) => {
  if (payload.reason === "session_replaced") {
    resetLocalRoom();
    clearRoomSession();
    state.atLobby = true;
    showScreen("auth");
    showToast("此席位已在另一个窗口恢复", "error");
  }
});
socket.on("join_error", (payload) => {
  const wasReconnect = state.reconnecting;
  state.reconnecting = false;
  const needsPassword =
    payload?.code === "PASSWORD_REQUIRED" ||
    String(payload?.message || "").includes("密码错误") ||
    String(payload?.message || "").includes("房间密码");
  if (needsPassword && !wasReconnect) {
    state.atLobby = true;
    showScreen("auth");
    openJoinPasswordModal(payload.roomId || state.pendingJoinRoomId || (el.inputRoom.value || "").trim().toUpperCase());
    showToast("请输入房间密码", "error");
    return;
  }
  state.atLobby = true;
  if (wasReconnect) {
    resetLocalRoom();
    clearRoomSession();
    showScreen("auth");
  }
  showToast(payload.message || "加入房间失败", "error");
});
socket.on("room:password_updated", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  state.hasPassword = Boolean(payload?.hasPassword);
  if (el.waitPasswordStatus) el.waitPasswordStatus.textContent = state.hasPassword ? "已设置" : "未设置";
  showToast(state.hasPassword ? "房间密码已设置" : "已清除房间密码", "success");
});
socket.on("action_error", (payload) => showToast(payload.message || "操作失败", "error"));

if (state.myName) el.inputName.value = state.myName;
if (state.roomId) el.inputRoom.value = state.roomId;
state.savedLoadout = loadSavedLoadout();
setMode(GAME_MODE.STANDARD);
setSkillMode("off");
applySettings();
updateEyeButton();
updateSkillPrepUi();
ensureSkillCatalog().then(() => {
  const validation = validateLoadoutIds(state.savedLoadout);
  if (state.savedLoadout.length && !validation.ok) {
    state.savedLoadout = [];
    localStorage.removeItem(STORAGE.skillLoadout);
  }
  updateSkillPrepUi();
});
if (hasPendingReconnect) showScreen("wait");
renderState();

/* ========== 深渊技能 UI ========== */
function setSkillMode(mode) {
  state.skillMode = mode === "abyss" ? "abyss" : "off";
  if (el.selectedSkillTag) {
    el.selectedSkillTag.textContent = state.skillMode === "abyss" ? "技能" : "无技能";
    el.selectedSkillTag.className = "mode-pill " + (state.skillMode === "abyss" ? "abyss" : "standard");
  }
  el.skillModeInputs?.forEach((input) => {
    input.checked = input.value === state.skillMode;
  });
  if (el.waitSkillMode) el.waitSkillMode.textContent = state.skillMode === "abyss" ? "深渊技能" : "关闭";
  if (el.waitInitialEnergy) el.waitInitialEnergy.textContent = state.skillMode === "abyss" ? "4" : "—";
  syncProtocolUi();
}

function loadoutLoad(ids) {
  return ids.reduce((sum, id) => {
    const def = state.skillCatalog.find((s) => s.id === id);
    return sum + (def?.load || 0);
  }, 0);
}

function renderSkillDraft() {
  if (!el.skillDraftPanel) return;
  const show = state.skillMode === "abyss" && ["waiting", "drafting"].includes(state.phase || "waiting");
  el.skillDraftPanel.classList.toggle("hidden", !show);
  if (!show) return;
  const me = getMe();
  const confirmed = Boolean(me?.skills?.loadoutConfirmed);
  const load = loadoutLoad(state.selectedLoadout);
  el.draftLoadMeter.textContent = load + " / 8 · " + state.selectedLoadout.length + " / 4";
  el.draftStatus.textContent = confirmed
    ? "构筑已确认，等待对手…"
    : "选择 2–4 个技能，总负载不超过 8。";
  el.btnConfirmLoadout.disabled =
    confirmed ||
    state.selectedLoadout.length < 2 ||
    state.selectedLoadout.length > 4 ||
    load > 8;
  el.skillCatalog.textContent = "";
  state.skillCatalog.forEach((skill) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "skill-card load-" + skill.load;
    if (state.selectedLoadout.includes(skill.id)) card.classList.add("selected");
    card.disabled = confirmed;
    card.innerHTML =
      "<strong>" +
      skill.name +
      "</strong><small>负载 " +
      skill.load +
      " · 能量 " +
      skill.energyCost +
      "</small><span>" +
      skill.description +
      "</span>";
    card.addEventListener("click", () => {
      if (confirmed) return;
      const idx = state.selectedLoadout.indexOf(skill.id);
      if (idx >= 0) state.selectedLoadout.splice(idx, 1);
      else if (state.selectedLoadout.length < 4 && loadoutLoad([...state.selectedLoadout, skill.id]) <= 8) {
        state.selectedLoadout.push(skill.id);
      } else {
        showToast("负载或数量已达上限", "error");
        return;
      }
      renderSkillDraft();
    });
    el.skillCatalog.appendChild(card);
  });
}

function renderSkillHud() {
  if (!el.skillHud) return;
  const enabled = state.skillMode === "abyss";
  el.skillHud.classList.toggle("hidden", !enabled);
  if (!enabled) return;
  const me = getMe();
  const opponent = getOpponent();
  const selfSkills = state.skillSelf || me?.skills || {};
  el.selfEnergy.textContent = String(selfSkills.abyssEnergy ?? 0);
  el.opponentEnergy.textContent = String(opponent?.skills?.abyssEnergy ?? 0);
  el.skillSilenceFlag.classList.toggle("hidden", !state.skillState?.silenceActive);
  el.skillBar.textContent = "";
  (selfSkills.equippedSkillIds || []).forEach((skillId) => {
    const def = state.skillCatalog.find((s) => s.id === skillId) || { id: skillId, name: skillId, energyCost: "?" };
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "skill-use-btn";
    btn.title = def.description || skillId;
    btn.innerHTML =
      "<span class=\"skill-use-name\">" +
      def.name +
      "</span><span class=\"skill-use-cost\">" +
      def.energyCost +
      "</span>";
    btn.addEventListener("click", () => useSkill(skillId, def));
    el.skillBar.appendChild(btn);
  });
}

function useSkill(skillId, def) {
  const target = {};
  if (skillId === "MEMORY_REWRITE") {
    const idx = window.prompt("选择要替换的底牌索引（0 或 1）", "0");
    if (idx !== "0" && idx !== "1") return showToast("请选择 0 或 1", "error");
    target.cardIndex = Number(idx);
  }
  if (skillId === "NULLIFICATION_PROTOCOL") {
    const code = window.prompt("输入要零化的公共牌代码（如 ST）", state.communityCards[0]?.code || "");
    if (!code) return;
    target.cardCode = code.trim().toUpperCase();
  }
  socket.emit("skill:use", {
    skillId,
    target,
    requestId: "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
  });
}

el.skillModeInputs?.forEach((input) =>
  input.addEventListener("change", () => setSkillMode(input.value))
);
el.btnConfirmLoadout?.addEventListener("click", () => {
  socket.emit("skill:loadout:set", { skillIds: state.selectedLoadout });
});
el.btnSkillCounter?.addEventListener("click", () => {
  if (!state.pendingReaction) return;
  socket.emit("skill:counter", {
    requestId: state.pendingReaction.requestId,
    skillId: "NEURAL_INTERRUPT",
  });
  el.skillReactionModal.classList.add("hidden");
});
el.btnSkillCounterSkip?.addEventListener("click", () => {
  el.skillReactionModal.classList.add("hidden");
  state.pendingReaction = null;
});
el.btnSkillChoiceConfirm?.addEventListener("click", () => {
  if (!state.pendingChoice) return;
  const payload = { ...state.pendingChoice.payload };
  socket.emit("skill:choice", payload);
  el.skillChoiceModal.classList.add("hidden");
  state.pendingChoice = null;
});
el.btnSkillPrivateClose?.addEventListener("click", () => {
  el.skillPrivateModal.classList.add("hidden");
});

socket.on("skill:state", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  state.skillMode = payload.skillMode || state.skillMode;
  state.skillState = payload.room || state.skillState;
  state.skillSelf = payload.self || state.skillSelf;
  if (Array.isArray(payload.players)) {
    // merge energy into public players when possible
    payload.players.forEach((summary) => {
      const player = state.players.find((p) => p.playerId === summary.playerId);
      if (player) player.skills = summary;
    });
  }
  renderSkillDraft();
  renderState();
});

socket.on("skill:loadout:confirmed", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  showToast((payload.playerId === state.playerId ? "你" : "对手") + " 已确认技能构筑", "success");
  renderSkillDraft();
});

socket.on("skill:pending", (payload) => {
  logAction("技能发动：" + payload.skillId);
});

socket.on("skill:reaction-window", (payload) => {
  state.pendingReaction = payload;
  if (payload.responderId !== state.playerId) return;
  el.skillReactionText.textContent = "对手发动了 " + payload.skillId + "，是否使用神经阻断？";
  el.skillReactionModal.classList.remove("hidden");
  const ends = payload.expiresAt || Date.now() + 2000;
  const tick = () => {
    const left = Math.max(0, (ends - Date.now()) / 1000);
    el.skillReactionTimer.textContent = left.toFixed(1);
    if (left <= 0) {
      el.skillReactionModal.classList.add("hidden");
      return;
    }
    state.reactionTimerRaf = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(state.reactionTimerRaf);
  tick();
});

socket.on("skill:reaction-expired", () => {
  el.skillReactionModal.classList.add("hidden");
  state.pendingReaction = null;
});

socket.on("skill:resolved", (payload) => {
  if (payload.publicSummary) {
    logAction(payload.publicSummary);
    if (el.skillLog) {
      const line = document.createElement("div");
      line.textContent = payload.publicSummary;
      el.skillLog.prepend(line);
    }
  }
  if (payload.publicData?.nullifiedCommunityCardIds) {
    state.nullifiedCommunityCardIds = payload.publicData.nullifiedCommunityCardIds;
  }
  renderState();
});

socket.on("skill:failed", (payload) => {
  showToast(payload.message || "技能失败", "error");
});

socket.on("skill:private-result", (payload) => {
  if (payload.scan) {
    el.skillPrivateText.textContent = payload.scan.text || JSON.stringify(payload.scan);
    el.skillPrivateModal.classList.remove("hidden");
  } else if (payload.cloaked) {
    el.skillPrivateText.textContent = payload.message || "目标信号受到遮蔽，本次扫描失败。";
    el.skillPrivateModal.classList.remove("hidden");
  } else if (payload.choiceType === "QUANTUM_SELECT") {
    state.pendingChoice = { type: "QUANTUM_SELECT", payload: { keepIndexes: [0, 1] } };
    el.skillChoiceTitle.textContent = "量子底牌";
    el.skillChoiceText.textContent = "选择保留的两张牌（默认保留原底牌）";
    el.skillChoiceBody.textContent = "";
    (payload.options || []).forEach((card, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "skill-choice-card";
      btn.textContent = (card.rank === "T" ? "10" : card.rank) + suitText(card.suit) + " [" + index + "]";
      btn.dataset.index = String(index);
      btn.addEventListener("click", () => {
        btn.classList.toggle("selected");
        const selected = [...el.skillChoiceBody.querySelectorAll(".selected")].map((n) =>
          Number(n.dataset.index)
        );
        state.pendingChoice.payload.keepIndexes = selected.slice(0, 2);
      });
      el.skillChoiceBody.appendChild(btn);
    });
    el.skillChoiceModal.classList.remove("hidden");
  } else if (payload.choiceType === "FORK_DECISION") {
    state.pendingChoice = { type: "FORK_DECISION", payload: { decision: "keep" } };
    el.skillChoiceTitle.textContent = "分岔观测";
    el.skillChoiceText.textContent =
      "即将发出：" +
      (payload.upcoming?.rank === "T" ? "10" : payload.upcoming?.rank) +
      suitText(payload.upcoming?.suit);
    el.skillChoiceBody.textContent = "";
    ["keep", "burn"].forEach((decision) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "skill-choice-card";
      btn.textContent = decision === "keep" ? "保留" : "烧掉并改发下一张";
      btn.addEventListener("click", () => {
        state.pendingChoice.payload.decision = decision;
        [...el.skillChoiceBody.children].forEach((n) => n.classList.remove("selected"));
        btn.classList.add("selected");
      });
      el.skillChoiceBody.appendChild(btn);
    });
    el.skillChoiceModal.classList.remove("hidden");
  } else if (payload.cards) {
    state.myCards = payload.cards;
    renderState();
  }
});

socket.on("skill:choice-window", (payload) => {
  if (payload.playerId !== state.playerId) {
    showToast("对手正在进行技能选择…", "info");
  }
});

socket.on("skill:pre-deal-window", (payload) => {
  showToast("即将发" + (payload.nextPhase === "river" ? "河牌" : "转牌") + "：可发动分岔观测", "info");
});
