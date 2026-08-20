const socket = io();

const GAME_MODE = Object.freeze({
  STANDARD: "standard",
  OVERDRIVE: "overdrive",
});
const ACTIVE_PHASES = new Set(["pre_flop", "flop", "turn", "river"]);
const MATCH_IN_PROGRESS_PHASES = new Set([
  ...ACTIVE_PHASES,
  "before_turn",
  "before_river",
  "showdown",
  "end",
]);
const HAND_SETTLE_MS = 2000;
const REMATCH_TIMEOUT_MS = 10000;
const ALL_IN_EFFECT_MS = 2200;
const ALL_IN_BOARD_PULSE_MS = 2000;
const ALL_IN_VIBRATION_PATTERN = Object.freeze([80, 45, 130, 55, 220]);
const ENDGAME_DECLARE_MS = 2600;
const ENDGAME_KILL_MS = 2800;
const ENDGAME_DECLARE_VIBRATION = Object.freeze([60, 40, 110]);
const ENDGAME_KILL_VIBRATION = Object.freeze([130, 50, 210, 60, 330]);
const ALL_IN_STYLES = Object.freeze(["abyss", "verdict", "royal", "singularity"]);
const PRO_FONT_STYLES = Object.freeze(["broadcast", "neonrail", "chrome", "classic"]);
const STORAGE = Object.freeze({
  playerId: "abyss_player_id",
  reconnectToken: "abyss_reconnect_token",
  roomId: "abyss_room_id",
  playerName: "abyss_player_name",
  revealCards: "abyss_reveal_cards",
  settings: "abyss_ui_settings_v2",
  skillLoadout: "abyss_skill_loadout_v2",
  suspectedSkills: "abyss_suspected_skills_v1",
  commitments: "abyss_hand_commitments_v1",
});

function safeStorageGet(storageName, key, fallback = "") {
  try {
    const value = window[storageName]?.getItem(key);
    return value == null ? fallback : value;
  } catch (_error) {
    return fallback;
  }
}

function safeStorageSet(storageName, key, value) {
  try {
    window[storageName]?.setItem(key, String(value));
    return true;
  } catch (_error) {
    return false;
  }
}

function safeStorageRemove(storageName, key) {
  try {
    window[storageName]?.removeItem(key);
    return true;
  } catch (_error) {
    return false;
  }
}

function clampStoredNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function createPlayerId() {
  if (window.crypto && window.crypto.getRandomValues) {
    const bytes = new Uint8Array(6);
    window.crypto.getRandomValues(bytes);
    return "P" + Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  return "P" + Math.random().toString(36).slice(2, 14).toUpperCase();
}

const initialPlayerId = safeStorageGet("sessionStorage", STORAGE.playerId) || createPlayerId();
const initialReconnectToken = safeStorageGet("sessionStorage", STORAGE.reconnectToken);
const initialRoomId = safeStorageGet("sessionStorage", STORAGE.roomId);
const hasPendingReconnect = Boolean(initialRoomId && initialReconnectToken);
safeStorageSet("sessionStorage", STORAGE.playerId, initialPlayerId);

function loadSettings() {
  const defaults = {
    animation: "high",
    allInStyle: "abyss",
    proPlayerMode: false,
    proFontStyle: "broadcast",
    reduceMotion: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    sfx: 55,
    music: 0,
    lowPerformance: false,
    skillExpertText: false,
  };
  let stored = {};
  try {
    const parsed = JSON.parse(safeStorageGet("localStorage", STORAGE.settings, "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
  } catch (_error) {
    stored = {};
  }
  return {
    animation: ["high", "medium", "low"].includes(stored.animation)
      ? stored.animation
      : defaults.animation,
    allInStyle: ALL_IN_STYLES.includes(stored.allInStyle)
      ? stored.allInStyle
      : defaults.allInStyle,
    proPlayerMode:
      typeof stored.proPlayerMode === "boolean" ? stored.proPlayerMode : defaults.proPlayerMode,
    proFontStyle: PRO_FONT_STYLES.includes(stored.proFontStyle)
      ? stored.proFontStyle
      : defaults.proFontStyle,
    reduceMotion:
      typeof stored.reduceMotion === "boolean" ? stored.reduceMotion : defaults.reduceMotion,
    sfx: clampStoredNumber(stored.sfx, 0, 100, defaults.sfx),
    music: clampStoredNumber(stored.music, 0, 100, defaults.music),
    lowPerformance:
      typeof stored.lowPerformance === "boolean"
        ? stored.lowPerformance
        : defaults.lowPerformance,
    skillExpertText:
      typeof stored.skillExpertText === "boolean" ? stored.skillExpertText : defaults.skillExpertText,
  };
}

function loadStoredCommitments(roomId) {
  if (!roomId) return new Map();
  try {
    const parsed = JSON.parse(safeStorageGet("sessionStorage", STORAGE.commitments, "{}"));
    if (parsed?.roomId !== roomId || !Array.isArray(parsed.records)) return new Map();
    const records = parsed.records.filter((record) =>
      record &&
      typeof record.handId === "string" &&
      record.handId.length <= 128 &&
      typeof record.commitment === "string" &&
      /^[a-f\d]{64}$/i.test(record.commitment)
    );
    return new Map(records.map((record) => [record.handId, record]));
  } catch (_error) {
    return new Map();
  }
}

const state = {
  playerId: initialPlayerId,
  reconnectToken: initialReconnectToken,
  roomId: initialRoomId,
  myName: safeStorageGet("sessionStorage", STORAGE.playerName),
  gameMode: GAME_MODE.STANDARD,
  skillMode: "off",
  skillCatalog: [],
  skillCatalogStatus: "idle",
  selectedLoadout: [],
  savedLoadout: [],
  suspectedSkillIds: loadSuspectedSkillIds(),
  skillConfig: { minEquipped: 1, maxEquipped: 4, maxLoad: 8 },
  pendingRoomAction: null,
  pendingJoinRoomId: null,
  autoLoadoutSubmitted: false,
  hasPassword: false,
  isHost: false,
  skillState: null,
  skillSelf: null,
  nullifiedCommunityCardIds: [],
  pendingChoice: null,
  privateResultQueue: [],
  seenPrivateResultIds: new Set(),
  phase: "waiting",
  handNo: 0,
  players: [],
  myCards: [],
  showdownCards: {},
  bestFiveCodes: new Set(),
  communityCards: [],
  pot: 0,
  chipViewHidden: false,
  currentBet: 0,
  dealer: null,
  currentTurnPlayerId: null,
  validActions: [],
  endgameWindow: false,
  minRaise: 0,
  maxBet: 0,
  toCall: 0,
  actionDeadline: null,
  turnId: null,
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
  showMyCards: safeStorageGet("localStorage", STORAGE.revealCards, "1") !== "0",
  rematchDeadlineAt: 0,
  rematchAcceptedIds: new Set(),
  rematchRaf: 0,
  commitments: loadStoredCommitments(initialRoomId),
  activeCommitment: null,
  fairnessChecks: new Map(),
  fairnessStatus: "pending",
  settings: loadSettings(),
  uiPending: {
    room: false,
    action: false,
    skill: false,
    loadout: false,
    choice: false,
    password: false,
    match: false,
  },
  matching: false,
  matchQueuedAt: 0,
  matchWaitRaf: 0,
  pendingMatchInvite: null,
  matchInviteRaf: 0,
  matchSource: null,
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
  flashEndgameDeclare: byId("flash-endgame-declare"),
  flashEndgameKill: byId("flash-endgame-kill"),
  riverOverload: byId("river-overload"),
  protocolBurst: byId("protocol-burst"),
  resultBanner: byId("result-banner"),
  btnSettings: byId("btn-settings"),
  settingsModal: byId("settings-modal"),
  btnCloseSettings: byId("btn-close-settings"),
  settingsNavigation: byId("settings-navigation"),
  btnSettingsLobby: byId("btn-settings-lobby"),
  settingAnimation: byId("setting-animation"),
  settingAllInStyles: [...document.querySelectorAll('input[name="allin-style"]')],
  btnPreviewAllIn: byId("btn-preview-allin"),
  settingProMode: byId("setting-pro-mode"),
  settingProFont: byId("setting-pro-font"),
  settingProFontRow: byId("setting-pro-font-row"),
  settingReduceMotion: byId("setting-reduce-motion"),
  settingSfx: byId("setting-sfx"),
  settingSfxValue: byId("setting-sfx-value"),
  settingMusic: byId("setting-music"),
  settingMusicValue: byId("setting-music-value"),
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
  matchQueueModal: byId("match-queue-modal"),
  matchQueueLane: byId("match-queue-lane"),
  matchWaitSeconds: byId("match-wait-seconds"),
  btnMatchCancel: byId("btn-match-cancel"),
  matchContinueModal: byId("match-continue-modal"),
  btnMatchContinue: byId("btn-match-continue"),
  btnMatchStop: byId("btn-match-stop"),
  matchInviteModal: byId("match-invite-modal"),
  matchInviteText: byId("match-invite-text"),
  matchInviteSeconds: byId("match-invite-seconds"),
  btnMatchAccept: byId("btn-match-accept"),
  btnMatchDecline: byId("btn-match-decline"),
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
  selfEnergyCap: byId("self-energy-cap"),
  opponentEnergy: byId("opponent-energy"),
  skillSilenceFlag: byId("skill-silence-flag"),
  skillBar: byId("skill-bar"),
  opponentSkillBar: byId("opponent-skill-bar"),
  skillLog: byId("skill-log"),
  skillChoiceModal: byId("skill-choice-modal"),
  skillChoiceTitle: byId("skill-choice-title"),
  skillChoiceText: byId("skill-choice-text"),
  skillChoiceBody: byId("skill-choice-body"),
  btnSkillChoiceCancel: byId("btn-skill-choice-cancel"),
  btnSkillChoiceConfirm: byId("btn-skill-choice-confirm"),
  skillPrivateModal: byId("skill-private-modal"),
  skillPrivateText: byId("skill-private-text"),
  btnSkillPrivateClose: byId("btn-skill-private-close"),
  skillPreviewModal: byId("skill-preview-modal"),
  skillPreviewTitle: byId("skill-preview-title"),
  skillPreviewMeta: byId("skill-preview-meta"),
  skillPreviewDescription: byId("skill-preview-description"),
  skillPreviewRules: byId("skill-preview-rules"),
  btnCloseSkillPreview: byId("btn-close-skill-preview"),
  btnSkillPreviewDone: byId("btn-skill-preview-done"),
  btnSkillPreviewNovice: byId("btn-skill-preview-novice"),
  btnSkillPreviewExpert: byId("btn-skill-preview-expert"),
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
  endgameWindowActions: byId("endgame-window-actions"),
  btnEndgameFire: byId("btn-endgame-fire"),
  btnEndgameSkip: byId("btn-endgame-skip"),
  btnRaise: byId("btn-raise"),
  btnRaiseOptions: byId("btn-raise-options"),
  actionButtons: document.querySelectorAll(".action-button[data-action]"),
  raisePresets: document.querySelectorAll("[data-raise-preset]"),
  modeInputs: document.querySelectorAll('input[name="game-mode"]'),
  skillModeInputs: document.querySelectorAll('input[name="skill-mode"]'),
  protocolInputs: document.querySelectorAll('input[name="protocol"]'),
  protocolCards: document.querySelectorAll(".protocol-card"),
  protocolButtons: document.querySelectorAll(".protocol-btn"),
};

const modalLayers = [...document.querySelectorAll(".modal-layer")];
const mainContent = byId("main-content");

function visibleModalLayers() {
  return modalLayers.filter((modal) => !modal.classList.contains("hidden"));
}

function modalFocusables(modal) {
  return [...modal.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
  )].filter((node) => node.getClientRects().length > 0);
}

function syncModalIsolation() {
  const visible = visibleModalLayers();
  const hasModal = visible.length > 0;
  if (mainContent) mainContent.inert = hasModal;
  if (el.btnSettings) el.btnSettings.inert = hasModal;
  const top = visible.at(-1);
  if (top && !top.contains(document.activeElement)) {
    requestAnimationFrame(() => {
      if (top.classList.contains("hidden") || top.contains(document.activeElement)) return;
      const target = modalFocusables(top)[0] || top.querySelector(".modal-panel");
      if (target) {
        if (!target.hasAttribute("tabindex") && target.matches(".modal-panel")) {
          target.setAttribute("tabindex", "-1");
        }
        target.focus();
      }
    });
  }
}

if (typeof MutationObserver === "function") {
  const modalObserver = new MutationObserver(syncModalIsolation);
  modalLayers.forEach((modal) => modalObserver.observe(modal, { attributes: true, attributeFilter: ["class"] }));
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const top = visibleModalLayers().at(-1);
  if (!top) return;
  const focusables = modalFocusables(top);
  if (!focusables.length) {
    event.preventDefault();
    top.querySelector(".modal-panel")?.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

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
let allInEffectTimer = 0;
let allInEffectEndsAt = 0;
let endgameDeclareTimer = 0;
let endgameKillTimer = 0;
let delayedHandResultTimer = 0;
let skillPreviewReturnFocus = null;
let previewingSkill = null;
let skillCatalogPromise = null;
const uiPendingTimers = new Map();
const boardPulseTimers = new Map();

function refreshPendingUi(key) {
  const offline = !socket.connected;
  if (key === "room") {
    el.protocolButtons?.forEach((button) => {
      button.disabled = state.uiPending.room || offline;
      button.setAttribute("aria-busy", state.uiPending.room ? "true" : "false");
    });
    if (el.btnJoin) el.btnJoin.disabled = state.uiPending.room || offline;
    if (el.btnJoinPasswordConfirm) el.btnJoinPasswordConfirm.disabled = state.uiPending.room || offline;
  }
  if (key === "password" && el.btnSetRoomPassword) {
    el.btnSetRoomPassword.disabled = state.uiPending.password || offline;
  }
  if (key === "action") renderActions();
  if (key === "skill") renderSkillHud();
  if (key === "loadout") renderSkillDraft();
  if (key === "choice" && el.btnSkillChoiceConfirm) el.btnSkillChoiceConfirm.disabled = state.uiPending.choice || offline;
}

function beginUiRequest(key, timeoutMs = 4000) {
  if (state.uiPending[key]) return false;
  state.uiPending[key] = true;
  const oldTimer = uiPendingTimers.get(key);
  if (oldTimer) clearTimeout(oldTimer);
  uiPendingTimers.set(
    key,
    setTimeout(() => endUiRequest(key), timeoutMs)
  );
  refreshPendingUi(key);
  return true;
}

function canSendRealtime({ notify = true } = {}) {
  if (socket.connected) return true;
  if (notify) showToast("实时连接尚未恢复，请稍候再试", "error");
  return false;
}

function beginRealtimeRequest(key, timeoutMs = 4000) {
  return canSendRealtime() && beginUiRequest(key, timeoutMs);
}

function endUiRequest(key) {
  const timer = uiPendingTimers.get(key);
  if (timer) clearTimeout(timer);
  uiPendingTimers.delete(key);
  if (!state.uiPending[key]) return;
  state.uiPending[key] = false;
  refreshPendingUi(key);
}

function endAllUiRequests() {
  Object.keys(state.uiPending).forEach((key) => endUiRequest(key));
}

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
    allin: [92, 0.72],
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
  if (kind === "allin") {
    oscillator.frequency.exponentialRampToValueAtTime(48, now + preset[1]);
  }
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
  if (Number(state.settings.music) <= 0 && ambientOscillator) {
    try {
      ambientOscillator.stop();
      ambientOscillator.disconnect();
      ambientGain?.disconnect();
    } catch (_error) {
      // Already-stopped audio nodes are safe to discard.
    }
    ambientOscillator = null;
    ambientGain = null;
    return;
  }
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
  safeStorageSet("localStorage", STORAGE.settings, JSON.stringify(state.settings));
}

function applySettings() {
  document.documentElement.dataset.animation = state.settings.animation;
  document.documentElement.dataset.allinStyle = state.settings.allInStyle;
  document.documentElement.dataset.proFont = state.settings.proFontStyle;
  document.body.classList.toggle("reduce-motion", Boolean(state.settings.reduceMotion));
  document.body.classList.toggle("low-performance", Boolean(state.settings.lowPerformance));
  document.body.classList.toggle("pro-player-mode", Boolean(state.settings.proPlayerMode));
  el.settingAnimation.value = state.settings.animation;
  el.flash.dataset.allinStyle = state.settings.allInStyle;
  el.settingAllInStyles.forEach((input) => {
    input.checked = input.value === state.settings.allInStyle;
  });
  if (el.settingProMode) el.settingProMode.checked = Boolean(state.settings.proPlayerMode);
  if (el.settingProFont) {
    el.settingProFont.value = state.settings.proFontStyle;
    el.settingProFont.disabled = !state.settings.proPlayerMode;
  }
  if (el.settingProFontRow) {
    el.settingProFontRow.classList.toggle("is-disabled", !state.settings.proPlayerMode);
  }
  el.settingReduceMotion.checked = Boolean(state.settings.reduceMotion);
  el.settingSfx.value = String(state.settings.sfx);
  el.settingSfxValue.textContent = String(state.settings.sfx) + "%";
  el.settingMusic.value = String(state.settings.music);
  el.settingMusicValue.textContent = String(state.settings.music) + "%";
  el.settingLowPerformance.checked = Boolean(state.settings.lowPerformance);
  updateAmbientAudio();
  if (el.game?.classList.contains("active")) renderActions();
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
  document.body.dataset.screen = name;
  if (name === "game") el.toastRegion.textContent = "";
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
        // `slot` describes how the missing positions are padded. A real card
        // must never inherit it, otherwise dealt community cards render as
        // empty diamond placeholders all the way through the river.
        slot: false,
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
  el.selfChips.textContent = state.chipViewHidden ? "—" : String(me?.chips ?? "—");
  el.selfBet.textContent = state.chipViewHidden ? "—" : String(me?.streetBet ?? 0);
  el.selfState.textContent = playerStateLabel(me);
  el.selfState.dataset.state = (me?.status || "standby").toLowerCase();
  el.selfConnection.innerHTML = "";
  const selfDot = document.createElement("i");
  selfDot.className = "status-dot " + (me?.isConnected ? "online" : "");
  el.selfConnection.append(selfDot, document.createTextNode(me?.isConnected ? "在线" : "离线"));

  el.opponentName.textContent = opponent?.name || "等待对手";
  el.opponentChips.textContent = state.chipViewHidden ? "—" : String(opponent?.chips ?? "—");
  el.opponentBet.textContent = state.chipViewHidden ? "—" : String(opponent?.streetBet ?? 0);
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
  if (state.chipViewHidden) {
    const next = Math.round(Number(value) || 0);
    return Number.isFinite(next) && next > 0 ? next : 0;
  }
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
  if (el.raiseLabel) el.raiseLabel.textContent = "加注";
  if (el.btnRaiseOptions) {
    el.btnRaiseOptions.setAttribute("aria-expanded", expanded ? "true" : "false");
    el.btnRaiseOptions.title = expanded ? "收起加注额度" : "调整加注额度";
  }
}

function renderActions() {
  const me = getMe();
  const endgameMine = Boolean(
    state.endgameWindow
    && socket.connected
    && me?.isConnected !== false
    && state.currentTurnPlayerId === state.playerId
    && !state.handSettling
    && !state.gameOver
    && !state.uiPending.action
  );
  el.endgameWindowActions?.classList.toggle("hidden", !endgameMine);
  if (el.btnEndgameFire) el.btnEndgameFire.disabled = !endgameMine;
  if (el.btnEndgameSkip) el.btnEndgameSkip.disabled = !endgameMine;
  if (endgameMine) {
    el.actionButtons.forEach((button) => {
      button.classList.add("hidden");
      button.disabled = true;
    });
    if (el.raiseConsole) el.raiseConsole.classList.add("hidden");
    el.turnKicker.textContent = state.settings.proPlayerMode ? "ENDGAME" : "终局窗口";
    el.turnMessage.textContent = state.settings.proPlayerMode ? "FIRE OR SKIP" : "发动终局或放弃";
    return;
  }
  if (el.raiseConsole) el.raiseConsole.classList.remove("hidden");
  const isMyTurn =
    socket.connected &&
    me?.isConnected !== false &&
    state.currentTurnPlayerId === state.playerId &&
    ACTIVE_PHASES.has(state.phase) &&
    !state.handSettling &&
    !state.gameOver &&
    !state.uiPending.action;
  const toCall = state.chipViewHidden
    ? 0
    : Number.isFinite(state.toCall)
      ? state.toCall
      : Math.max(0, Number(state.currentBet || 0) - Number(me?.streetBet || 0));
  const canCheck = isMyTurn && state.validActions.includes("check");
  const canCall = isMyTurn && state.validActions.includes("call");

  el.callLabel.textContent = "跟注";
  el.callAmount.textContent = state.chipViewHidden || !(toCall > 0) ? "—" : String(toCall);
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
    (state.chipViewHidden || (Number(state.maxBet) > 0 && Number(state.maxBet) >= Number(state.minRaise)));
  if (el.btnRaise) el.btnRaise.disabled = !canRaise;
  if (el.btnRaiseOptions) el.btnRaiseOptions.disabled = !canRaise;
  el.raiseInput.disabled = !canRaise;
  const pro = Boolean(state.settings.proPlayerMode);
  if (canRaise && !state.chipViewHidden) {
    el.raiseInput.min = String(state.minRaise);
    el.raiseInput.max = String(state.maxBet);
    el.raiseMinLabel.textContent = (pro ? "MIN " : "最小 ") + state.minRaise;
    el.raiseMaxLabel.textContent = (pro ? "MAX " : "最大 ") + state.maxBet;
  } else if (canRaise && state.chipViewHidden) {
    el.raiseInput.min = "0";
    el.raiseInput.max = "999999";
    el.raiseMinLabel.textContent = pro ? "MIN —" : "最小 —";
    el.raiseMaxLabel.textContent = pro ? "MAX —" : "最大 —";
  } else {
    el.raiseInput.min = "0";
    el.raiseInput.max = "0";
    el.raiseMinLabel.textContent = pro ? "MIN —" : "最小 —";
    el.raiseMaxLabel.textContent = pro ? "MAX —" : "最大 —";
    setRaiseExpanded(false);
  }
  el.raisePresets.forEach((button) => {
    button.disabled = !canRaise || state.chipViewHidden;
  });
  if (canRaise) {
    const existing = Number(el.raiseInput.value);
    if (state.chipViewHidden) {
      el.raiseValue.textContent = existing > 0 ? String(existing) : "—";
    } else {
      setRaiseValue(existing >= state.minRaise && existing <= state.maxBet ? existing : state.minRaise);
    }
  } else if (!state.chipViewHidden) {
    setRaiseValue(0);
  }

  if (isMyTurn) {
    el.turnKicker.textContent = pro ? "YOUR TURN" : "你的回合";
    el.turnMessage.textContent = pro ? "SELECT AN ACTION" : "选择一项行动";
  } else if (state.currentTurnPlayerId) {
    el.turnKicker.textContent = pro ? "OPPONENT" : "对手回合";
    el.turnMessage.textContent =
      getOpponent()?.status === "disconnected"
        ? pro
          ? "WAITING FOR RECONNECT"
          : "等待对手恢复连接"
        : pro
          ? "THINKING..."
          : "对手正在行动";
  } else {
    el.turnKicker.textContent = pro ? "HOLD" : "等待";
    el.turnMessage.textContent = state.handSettling
      ? pro
        ? "SHOWDOWN"
        : "正在结算"
      : pro
        ? "AWAITING ACTION"
        : "等待行动指令";
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
  if (state.chipViewHidden) {
    el.pot.textContent = "—";
    el.potCore.setAttribute("aria-label", "当前底池已隐藏");
    return;
  }
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
    const canSetPassword =
      !state.matchSource &&
      isHost &&
      ["waiting", "drafting"].includes(state.phase || "waiting");
    el.waitPasswordPanel.classList.toggle("hidden", !canSetPassword);
  }
}

function renderFairness() {
  const commitment = state.activeCommitment;
  const verifiedCount = [...state.fairnessChecks.values()].filter(
    (result) => result === "verified"
  ).length;
  const totalCount = state.commitments.size;
  el.commitmentShort.textContent = commitment?.commitment
    ? commitment.commitment.slice(0, 8).toUpperCase()
    : "待定";
  el.fairnessHandId.textContent = commitment?.handId ? "HAND " + commitment.handId.slice(0, 12) : "HAND —";
  const labels = {
    pending: "牌局开始前将锁定牌堆承诺",
    locked: "牌堆已锁定：摊牌即时验证，弃牌手在整场结束后验证",
    verified: `SHA-256 验证通过（${verifiedCount}/${totalCount} 手），牌堆未被中途修改`,
    failed: `本场存在承诺验证失败（已验证 ${verifiedCount}/${totalCount} 手），请检查服务器日志`,
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

function refreshFairnessStatus() {
  const results = [...state.fairnessChecks.values()];
  if (results.includes("failed")) {
    state.fairnessStatus = "failed";
  } else if (state.commitments.size > 0 && results.length === state.commitments.size) {
    state.fairnessStatus = "verified";
  } else if (state.commitments.size > 0) {
    state.fairnessStatus = "locked";
  } else {
    state.fairnessStatus = "pending";
  }
}

function recordFairnessCheck(handId, result) {
  if (handId) state.fairnessChecks.set(handId, result);
  refreshFairnessStatus();
  renderFairness();
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
  Object.keys(state.uiPending).forEach((key) => refreshPendingUi(key));
  if (state.gameOver && state.rematchDeadlineAt) {
    el.btnRematchYes.disabled = !connected || state.rematchAcceptedIds.has(state.playerId);
    el.btnRematchNo.disabled = !connected;
  }
  renderActions();
  renderSkillHud();
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
  const previousTimer = boardPulseTimers.get(className);
  if (previousTimer) clearTimeout(previousTimer);
  el.board.classList.remove(className);
  void el.board.offsetWidth;
  el.board.classList.add(className);
  const timer = setTimeout(() => {
    el.board.classList.remove(className);
    boardPulseTimers.delete(className);
  }, duration || 700);
  boardPulseTimers.set(className, timer);
}

function playFxHaptics(pattern) {
  const canQueryViewport = typeof window.matchMedia === "function";
  const isTouchDevice =
    Number(navigator.maxTouchPoints || 0) > 0 ||
    (canQueryViewport &&
      (window.matchMedia("(pointer: coarse)").matches ||
        window.matchMedia("(max-width: 640px)").matches));
  if (
    !isTouchDevice ||
    state.settings.reduceMotion ||
    document.visibilityState !== "visible" ||
    typeof navigator.vibrate !== "function"
  ) {
    return;
  }
  try {
    navigator.vibrate(pattern);
  } catch (_error) {
    // Unsupported or restricted vibration APIs should not interrupt the game.
  }
}

function playAllInHaptics() {
  playFxHaptics(ALL_IN_VIBRATION_PATTERN);
}

function playAllInEffect(_actorId, { preview = false } = {}) {
  if (preview && allInEffectEndsAt > Date.now()) return;
  if (allInEffectTimer) clearTimeout(allInEffectTimer);
  el.flash.classList.add("hidden");
  el.flash.classList.toggle("is-preview", preview);
  document.body.classList.remove("shake");
  void el.flash.offsetWidth;
  el.flash.classList.remove("hidden");
  if (!preview) allInEffectEndsAt = Date.now() + ALL_IN_EFFECT_MS;
  const allowShake =
    !preview &&
    !state.settings.reduceMotion &&
    !state.settings.lowPerformance &&
    window.matchMedia("(min-width: 641px)").matches;
  if (allowShake) {
    void document.body.offsetWidth;
    document.body.classList.add("shake");
  }
  if (!preview) pulseBoard("allin-overload", ALL_IN_BOARD_PULSE_MS);
  allInEffectTimer = setTimeout(() => {
    el.flash.classList.add("hidden");
    el.flash.classList.remove("is-preview");
    document.body.classList.remove("shake");
    allInEffectTimer = 0;
    if (!preview) allInEffectEndsAt = 0;
  }, ALL_IN_EFFECT_MS);
  if (!preview) playAllInHaptics();
  playTone("allin");
}

function playEndgameSfx(kind) {
  if (Number(state.settings.sfx) <= 0) return;
  const context = ensureAudioContext();
  if (!context) return;
  const now = context.currentTime;
  const peak = Math.max(0.002, Number(state.settings.sfx) / 2500);
  const voice = ({ type, from, to, start, dur, level }) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(Math.max(1, from), now + start);
    if (to !== from) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to), now + start + dur);
    }
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * level), now + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now + start);
    oscillator.stop(now + start + dur + 0.03);
  };
  if (kind === "declare") {
    voice({ type: "sawtooth", from: 68, to: 30, start: 0, dur: 1.5, level: 1 });
    voice({ type: "sine", from: 220, to: 150, start: 0.05, dur: 1.1, level: 0.4 });
    voice({ type: "square", from: 960, to: 300, start: 0.34, dur: 0.16, level: 0.6 });
    voice({ type: "square", from: 1120, to: 320, start: 0.56, dur: 0.18, level: 0.72 });
    voice({ type: "triangle", from: 1350, to: 2300, start: 0.92, dur: 0.65, level: 0.22 });
  } else {
    voice({ type: "triangle", from: 2700, to: 380, start: 0.16, dur: 0.5, level: 0.6 });
    voice({ type: "sawtooth", from: 118, to: 26, start: 0.32, dur: 1.15, level: 1 });
    voice({ type: "square", from: 240, to: 58, start: 0.7, dur: 0.22, level: 0.8 });
    voice({ type: "square", from: 268, to: 62, start: 0.93, dur: 0.24, level: 0.9 });
    voice({ type: "sine", from: 54, to: 30, start: 1.15, dur: 1.15, level: 0.5 });
  }
}

function allowFxShake() {
  return (
    !state.settings.reduceMotion &&
    !state.settings.lowPerformance &&
    window.matchMedia("(min-width: 641px)").matches
  );
}

function playEndgameDeclare({ execution = false } = {}) {
  if (!el.flashEndgameDeclare) return;
  if (endgameDeclareTimer) clearTimeout(endgameDeclareTimer);
  el.flashEndgameDeclare.classList.add("hidden");
  el.flashEndgameDeclare.dataset.mode = execution ? "execution" : "declare";
  void el.flashEndgameDeclare.offsetWidth;
  el.flashEndgameDeclare.classList.remove("hidden");
  if (allowFxShake()) {
    document.body.classList.remove("shake");
    void document.body.offsetWidth;
    document.body.classList.add("shake");
  }
  pulseBoard("endgame-declare-pulse", 1800);
  playFxHaptics(ENDGAME_DECLARE_VIBRATION);
  playEndgameSfx("declare");
  endgameDeclareTimer = setTimeout(() => {
    el.flashEndgameDeclare.classList.add("hidden");
    document.body.classList.remove("shake");
    endgameDeclareTimer = 0;
  }, ENDGAME_DECLARE_MS);
}

function playEndgameExecution() {
  if (!el.flashEndgameKill) return;
  if (endgameKillTimer) clearTimeout(endgameKillTimer);
  el.flashEndgameKill.classList.add("hidden");
  document.body.classList.remove("shake-hard");
  void el.flashEndgameKill.offsetWidth;
  el.flashEndgameKill.classList.remove("hidden");
  if (allowFxShake()) {
    void document.body.offsetWidth;
    document.body.classList.add("shake-hard");
  }
  pulseBoard("endgame-kill-pulse", 2000);
  playFxHaptics(ENDGAME_KILL_VIBRATION);
  playEndgameSfx("kill");
  endgameKillTimer = setTimeout(() => {
    el.flashEndgameKill.classList.add("hidden");
    document.body.classList.remove("shake-hard");
    endgameKillTimer = 0;
  }, ENDGAME_KILL_MS);
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
  safeStorageSet("sessionStorage", STORAGE.playerId, state.playerId);
  if (state.reconnectToken) {
    safeStorageSet("sessionStorage", STORAGE.reconnectToken, state.reconnectToken);
  }
  if (state.roomId) safeStorageSet("sessionStorage", STORAGE.roomId, state.roomId);
  if (state.myName) safeStorageSet("sessionStorage", STORAGE.playerName, state.myName);
}

function persistCommitments() {
  if (!state.roomId || !(state.commitments instanceof Map)) return;
  const records = [...state.commitments.values()];
  safeStorageSet(
    "sessionStorage",
    STORAGE.commitments,
    JSON.stringify({ roomId: state.roomId, records })
  );
}

function clearRoomSession() {
  state.roomId = "";
  state.reconnectToken = "";
  safeStorageRemove("sessionStorage", STORAGE.roomId);
  safeStorageRemove("sessionStorage", STORAGE.reconnectToken);
}

function resetLocalRoom() {
  clearHandSettlement();
  clearRematch();
  resetTransientUi();
  state.players = [];
  state.myCards = [];
  state.showdownCards = {};
  state.bestFiveCodes = new Set();
  state.communityCards = [];
  state.phase = "waiting";
  state.handNo = 0;
  state.pot = 0;
  state.currentBet = 0;
  state.currentTurnPlayerId = null;
  state.validActions = [];
  state.endgameWindow = false;
  state.actionDeadline = null;
  state.turnId = null;
  state.handHint = "等待发牌";
  state.handCategory = 0;
  el.selfHandType.dataset.category = "0";
  state.gameOver = false;
  state.skillState = null;
  state.skillSelf = null;
  state.nullifiedCommunityCardIds = [];
  state.privateResultQueue = [];
  state.seenPrivateResultIds = new Set();
  state.commitments = new Map();
  safeStorageRemove("sessionStorage", STORAGE.commitments);
  state.activeCommitment = null;
  state.fairnessChecks = new Map();
  state.fairnessStatus = "pending";
  state.matchSource = null;
}

function resetTransientUi() {
  state.pendingChoice = null;
  if (allInEffectTimer) clearTimeout(allInEffectTimer);
  allInEffectTimer = 0;
  allInEffectEndsAt = 0;
  if (endgameDeclareTimer) clearTimeout(endgameDeclareTimer);
  endgameDeclareTimer = 0;
  if (endgameKillTimer) clearTimeout(endgameKillTimer);
  endgameKillTimer = 0;
  if (delayedHandResultTimer) clearTimeout(delayedHandResultTimer);
  delayedHandResultTimer = 0;
  if (state.actionCountdownRaf) cancelAnimationFrame(state.actionCountdownRaf);
  state.actionCountdownRaf = 0;
  boardPulseTimers.forEach((timer, className) => {
    clearTimeout(timer);
    el.board.classList.remove(className);
  });
  boardPulseTimers.clear();
  modalLayers.forEach((modal) => modal.classList.add("hidden"));
  el.flash.classList.add("hidden");
  el.flash.classList.remove("is-preview");
  el.flashEndgameDeclare?.classList.add("hidden");
  el.flashEndgameKill?.classList.add("hidden");
  el.riverOverload.classList.add("hidden");
  el.protocolBurst.classList.add("hidden");
  el.resultBanner.classList.add("hidden");
  el.chipFx.textContent = "";
  document.body.classList.remove("shake", "shake-hard", "river-phase");
  setRaiseExpanded(false);
  try {
    navigator.vibrate?.(0);
  } catch (_error) {
    // Vibration cancellation is optional.
  }
  syncModalIsolation();
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
  endAllUiRequests();
  cancelMatchmaking({ silent: true });
  if (state.gameOver && state.rematchDeadlineAt) {
    if (socket.connected) socket.emit("rematch_response", { accepted: false });
  }
  if (socket.connected) socket.emit("leave_room");
  resetLocalRoom();
  clearRoomSession();
  state.atLobby = true;
  showScreen("auth");
  renderState();
}

function returnToLobby() {
  const active =
    !state.gameOver &&
    (MATCH_IN_PROGRESS_PHASES.has(state.phase) || (state.phase === "waiting" && state.handNo > 0));
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
  if (delayedHandResultTimer) clearTimeout(delayedHandResultTimer);
  delayedHandResultTimer = 0;
  state.handSettleRaf = 0;
  state.handSettleTimer = 0;
  el.handSettleModal.classList.add("hidden");
  el.handSettleModal.classList.remove("is-endgame-execution");
  if (endgameKillTimer) clearTimeout(endgameKillTimer);
  endgameKillTimer = 0;
  el.flashEndgameKill?.classList.add("hidden");
  document.body.classList.remove("shake-hard");
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
  state.endgameWindow = false;
  state.currentTurnPlayerId = null;
  state.actionDeadline = null;
  state.turnId = null;
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
      ? (opponent?.name || "对手") + " 弃牌" + (payload.pot == null ? "，你赢得底池" : "，你赢得底池 " + payload.pot)
      : "你已弃牌，" + (payload.winnerName || opponent?.name || "对手") + (payload.pot == null ? " 赢得底池" : " 赢得底池 " + payload.pot);
  } else if (payload.tie) {
    el.settleDetail.textContent = payload.pot == null ? "平分底池" : "底池 " + payload.pot + " 平分";
  } else {
    el.settleDetail.textContent = (payload.winnerName || "胜方") + (payload.pot == null ? " 赢得底池" : " 赢得底池 " + payload.pot);
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
  const executionKill = Boolean(payload.endgameExecutionOverride);
  el.handSettleModal.classList.toggle("is-endgame-execution", executionKill);
  if (executionKill) playEndgameExecution();
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
  state.turnId = null;
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
  if (Array.isArray(payload.loadouts) && payload.loadouts.length) {
    const lines = payload.loadouts.map((entry) => {
      const owner = state.players.find((player) => player.playerId === entry.playerId);
      const names = (entry.skillIds || []).map((skillId) =>
        state.skillCatalog.find((skill) => skill.id === skillId)?.name || skillId
      );
      return (owner?.name || entry.name || entry.playerId) + "：" + (names.join(" / ") || "无");
    });
    el.gameOverMsg.textContent += "。完整构筑：" + lines.join("；");
  }
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
  const codes = deck
    .map((card) => typeof card === "string" ? card : card?.code)
    .filter(Boolean);
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
    recordFairnessCheck(payload.handId, "failed");
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
  const finalZoneCodes = [
    ...(payload.finalZones?.communityCards || []),
    ...(payload.finalZones?.playerCards || []).flatMap((entry) => entry.cards || []),
    ...(payload.finalZones?.remainingDeck || []),
    ...(payload.burnedCards || []),
    ...(payload.removedCards || []),
  ].map((card) => typeof card === "string" ? card : card?.code).filter(Boolean);
  const needsSkillAudit = String(payload.skillMode || "off") === "abyss";
  const zonesValid = !needsSkillAudit || (
    finalZoneCodes.length === 52 &&
    new Set(finalZoneCodes).size === 52 &&
    finalZoneCodes.every((code) => codes.includes(code))
  );
  const result = computed.toLowerCase() === String(commitment).toLowerCase() && zonesValid
    ? "verified"
    : "failed";
  recordFairnessCheck(payload.handId, result);
  showToast(
    result === "verified" && state.fairnessStatus !== "failed"
      ? "牌堆承诺验证通过"
      : result === "verified"
        ? "本手验证通过，但本场已有异常"
        : zonesValid ? "牌堆承诺不一致" : "技能审计发现牌张守恒异常",
    result === "verified" && state.fairnessStatus !== "failed" ? "success" : "error"
  );
  if (payload.profile && state.gameMode === GAME_MODE.OVERDRIVE) {
    el.overdriveProfileLabel.textContent = payload.profile.label || payload.profile.type || "高爆牌局";
  }
  (payload.skillActions || []).forEach((entry) => {
    const name = state.skillCatalog.find((skill) => skill.id === entry.skillId)?.name || entry.skillId;
    logAction(`技能审计 · ${name} · ${entry.status || "SUCCESS"}`);
  });
  (payload.equippedSkills || []).forEach((entry) => {
    const owner = state.players.find((player) => player.playerId === entry.playerId);
    const names = (entry.skillIds || []).map((skillId) =>
      state.skillCatalog.find((skill) => skill.id === skillId)?.name || skillId
    );
    if (names.length) logAction(`构筑审计 · ${owner?.name || entry.playerId} · ${names.join(" / ")}`);
  });
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

function loadSuspectedSkillIds() {
  try {
    const parsed = JSON.parse(safeStorageGet("localStorage", STORAGE.suspectedSkills, "[]"));
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch (_error) {
    return [];
  }
}

function saveSuspectedSkillIds(ids) {
  state.suspectedSkillIds = [...new Set(ids)];
  safeStorageSet("localStorage", STORAGE.suspectedSkills, JSON.stringify(state.suspectedSkillIds));
}

function skillDescriptionText(skill) {
  if (state.settings.skillExpertText) return skill?.expertDescription || skill?.description || "暂无技能说明。";
  return skill?.shortDescription || skill?.description || "暂无技能说明。";
}

function loadSavedLoadout() {
  try {
    const parsed = JSON.parse(safeStorageGet("localStorage", STORAGE.skillLoadout, "[]"));
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch (_error) {
    return [];
  }
}

function validateLoadoutIds(ids, catalog = state.skillCatalog) {
  const min = state.skillConfig.minEquipped ?? 1;
  const max = state.skillConfig.maxEquipped || 4;
  const maxLoad = state.skillConfig.maxLoad || 8;
  if (!Array.isArray(ids) || ids.length < min || ids.length > max) {
    return { ok: false, load: 0, error: `请选择 ${min}–${max} 个技能` };
  }
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) return { ok: false, load: 0, error: "技能不能重复" };
  if (!catalog.length) {
    const error = state.skillCatalogStatus === "error" ? "技能目录加载失败，请重试" : "技能目录加载中";
    return { ok: false, load: 0, error, pendingCatalog: state.skillCatalogStatus !== "error" };
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
    const card = input.closest(".protocol-card");
    card?.classList.toggle("selected", selected);
    card?.setAttribute("aria-current", selected ? "true" : "false");
    if (card) card.tabIndex = selected ? 0 : -1;
  });
  if (el.protocolSummary) {
    el.protocolSummary.textContent = protocolSummaryText(state.gameMode, state.skillMode || "off");
  }
  updateSkillPrepUi();
}

function updateSkillPrepUi() {
  const validation = validateLoadoutIds(state.savedLoadout);
  const ready = validation.ok;
  const load = validation.load || 0;
  const invalidSavedBuild = state.savedLoadout.length > 0 && state.skillCatalogStatus === "ready" && !ready;
  if (el.skillPrepStatus) {
    el.skillPrepStatus.classList.toggle("ready", ready);
    el.skillPrepStatus.textContent = ready
      ? `已配置 ${state.savedLoadout.length} 技能 · 负载 ${load}/8`
      : invalidSavedBuild
        ? "构筑失效 · 请重新配置"
      : state.skillCatalogStatus === "error"
        ? "目录加载失败 · 请进入构筑重试"
        : state.skillCatalogStatus !== "ready"
          ? "技能目录加载中…"
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
  if (pendingAction !== null || !state.pendingRoomAction) state.pendingRoomAction = pendingAction;
  const validation = validateLoadoutIds(state.savedLoadout);
  state.selectedLoadout = validation.ok ? [...state.savedLoadout] : [];
  if (state.savedLoadout.length && !validation.ok && state.skillCatalogStatus === "ready") {
    showToast("当前技能构筑包含重复或无效技能，请重新配置。", "error");
  }
  showScreen("skillLab");
  renderSkillLab();
}

function closeSkillLab() {
  showScreen("auth");
  updateSkillPrepUi();
}

async function ensureSkillCatalog() {
  if (state.skillCatalogStatus === "ready" && state.skillCatalog.length) return state.skillCatalog;
  if (skillCatalogPromise) return skillCatalogPromise;
  state.skillCatalogStatus = "loading";
  updateSkillPrepUi();
  skillCatalogPromise = (async () => {
    try {
      const response = await fetch("/api/skills");
      if (!response.ok) throw new Error("skill api failed");
      const data = await response.json();
      const catalog = Array.isArray(data.skills) ? data.skills : [];
      if (!catalog.length) throw new Error("empty skill catalog");
      state.skillCatalog = catalog;
      state.skillCatalogStatus = "ready";
      if (data.config) {
        state.skillConfig = {
          minEquipped: data.config.minEquipped ?? 1,
          maxEquipped: data.config.maxEquipped || 4,
          maxLoad: data.config.maxLoad || 8,
        };
      }
      return state.skillCatalog;
    } catch (_error) {
      state.skillCatalogStatus = "error";
      showToast("技能目录加载失败，请检查网络后重试", "error");
      return [];
    } finally {
      skillCatalogPromise = null;
      updateSkillPrepUi();
    }
  })();
  return skillCatalogPromise;
}

function queueHandSettlement(payload) {
  if (shouldIgnoreSyncEvent(payload)) return;
  const remainingEffectMs = Math.max(0, allInEffectEndsAt - Date.now());
  if (remainingEffectMs < 120) {
    startHandSettlement(payload);
    return;
  }
  if (delayedHandResultTimer) clearTimeout(delayedHandResultTimer);
  const totalSettleMs = Number(payload.settleMs || HAND_SETTLE_MS);
  delayedHandResultTimer = setTimeout(() => {
    delayedHandResultTimer = 0;
    startHandSettlement({
      ...payload,
      settleMs: totalSettleMs,
    });
  }, remainingEffectMs);
}

const SKILL_TAG_LABELS = Object.freeze({
  ACTIVE: "主动",
  PASSIVE: "被动",
  RESOURCE: "资源系",
  INFORMATION: "情报",
  DEFENSE: "防御",
  CONTROL: "控制",
  SETTLEMENT: "结算修正",
  SECRET: "隐秘",
  HOLE_EDIT: "底牌编辑",
  DECK_EDIT: "牌堆编辑",
  BOARD_EDIT: "公共牌编辑",
  ONCE_PER_HAND: "每手限次",
  PROTOCOL: "协议",
});

const SKILL_PHASE_LABELS = Object.freeze({
  pre_flop: "翻牌前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
  before_turn: "转牌发出前",
  before_river: "河牌发出前",
});

function skillTypeLabel(skill) {
  const tags = new Set(skill?.tags || []);
  if (tags.has("PASSIVE")) return "被动技能";
  return "主动技能";
}

function syncSkillPreviewModeButtons() {
  el.btnSkillPreviewNovice?.classList.toggle("is-active", !state.settings.skillExpertText);
  el.btnSkillPreviewExpert?.classList.toggle("is-active", Boolean(state.settings.skillExpertText));
}

function closeSkillPreview() {
  if (!el.skillPreviewModal || el.skillPreviewModal.classList.contains("hidden")) return;
  el.skillPreviewModal.classList.add("hidden");
  previewingSkill = null;
  const target = skillPreviewReturnFocus;
  skillPreviewReturnFocus = null;
  if (target?.isConnected) target.focus();
}

function showSkillPreview(skill, trigger) {
  if (!skill || !el.skillPreviewModal) return;
  previewingSkill = skill;
  skillPreviewReturnFocus = trigger || document.activeElement;
  el.skillPreviewTitle.textContent = skill.name || skill.id || "技能档案";
  el.skillPreviewDescription.textContent = skillDescriptionText(skill);
  el.skillPreviewDescription.classList.toggle("is-expert", Boolean(state.settings.skillExpertText));
  el.skillPreviewMeta.textContent = "";
  syncSkillPreviewModeButtons();

  const meta = [skillTypeLabel(skill), "负载 " + Number(skill.load || 0)];
  if (!(skill.tags || []).includes("PASSIVE")) meta.push("能量 " + Number(skill.energyCost || 0));
  (skill.tags || []).forEach((tag) => {
    const label = SKILL_TAG_LABELS[tag];
    if (label && !meta.includes(label) && !["主动", "被动"].includes(label)) meta.push(label);
  });
  meta.forEach((label) => {
    const chip = document.createElement("span");
    chip.textContent = label;
    el.skillPreviewMeta.appendChild(chip);
  });

  const phases = (skill.allowedPhases || []).map((phase) => SKILL_PHASE_LABELS[phase] || phase);
  const limits = [];
  if (skill.maxUsesPerHand != null) limits.push("每手最多 " + skill.maxUsesPerHand + " 次");
  if (skill.maxUsesPerGame != null) limits.push("每局最多 " + skill.maxUsesPerGame + " 次");
  const conditions = [];
  if (skill.requiresActionTurn) conditions.push("仅在你的行动回合");
  if (skill.requiresFirstSkillEvent) conditions.push("必须是本手第一个技能事件");
  if (skill.canBeCountered === false) conditions.push("不能被反制");

  const rows = [
    ["发动时机", phases.length ? phases.join(" / ") : skillTypeLabel(skill) === "被动技能" ? "满足条件时自动触发" : "专属窗口"],
    ["使用限制", limits.length ? limits.join("；") : "仅受自身触发条件与能量限制"],
    ["前置条件", conditions.length ? conditions.join("；") : "无额外行动条件"],
    ["信息公开", skill.visibility === "SECRET" ? "发动与结果默认私有，仅在出现可观察结果、被侦查或规则要求时确认" : skill.visibility === "MIXED" ? "按目标所在区域决定公开范围" : "发动状态公开"],
  ];
  el.skillPreviewRules.textContent = "";
  rows.forEach(([term, value]) => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    el.skillPreviewRules.append(dt, dd);
  });

  el.skillPreviewModal.classList.remove("hidden");
  el.btnCloseSkillPreview?.focus();
}

function createSkillZoomButton(skill) {
  const zoom = document.createElement("button");
  zoom.type = "button";
  zoom.className = "skill-zoom-button";
  zoom.title = "放大查看「" + skill.name + "」";
  zoom.setAttribute("aria-label", "放大查看技能：" + skill.name);
  zoom.innerHTML =
    '<svg class="skill-zoom-glyph" aria-hidden="true" viewBox="0 0 24 24" focusable="false">' +
    '<circle cx="10.5" cy="10.5" r="6.5"></circle><path d="M15.5 15.5 21 21"></path></svg>';
  zoom.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showSkillPreview(skill, zoom);
  });
  return zoom;
}

function createSkillCatalogCard(skill, { selected = false, disabled = false, onSelect } = {}) {
  const card = document.createElement("article");
  card.className = "skill-card load-" + skill.load;
  card.dataset.skillId = skill.id;
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", skill.name + "技能卡");
  card.classList.toggle("selected", selected);

  const select = document.createElement("button");
  select.type = "button";
  select.className = "skill-card-select";
  select.disabled = disabled;
  select.setAttribute("aria-pressed", selected ? "true" : "false");
  select.setAttribute("aria-label", (selected ? "卸下" : "装备") + "技能：" + skill.name);
  const name = document.createElement("strong");
  const cost = document.createElement("small");
  const description = document.createElement("span");
  description.className = "skill-card-copy";
  name.textContent = skill.name;
  const passive = (skill.tags || []).includes("PASSIVE");
  const energyHint = skill.energyCosts
    ? " · 能量 " + Object.values(skill.energyCosts).join("/")
    : Number(skill.energyCost || 0) > 0
      ? passive ? " · 触发消耗 " + skill.energyCost : " · 能量 " + skill.energyCost
      : passive ? " · 自动触发" : " · 能量 0";
  cost.textContent = "负载 " + skill.load + energyHint;
  description.textContent = skill.shortDescription || skill.description || "";
  select.append(name, cost, description);
  if (typeof onSelect === "function") select.addEventListener("click", onSelect);

  const selectedMark = document.createElement("span");
  selectedMark.className = "skill-selection-mark";
  selectedMark.setAttribute("aria-hidden", "true");
  selectedMark.textContent = "✓ 已选择";

  card.append(select, selectedMark, createSkillZoomButton(skill));
  return card;
}

function renderSkillLab() {
  if (!el.skillLabCatalog) return;
  const validation = validateLoadoutIds(state.selectedLoadout);
  const load = state.selectedLoadout.reduce((sum, id) => {
    const def = state.skillCatalog.find((skill) => skill.id === id);
    return sum + (def?.load || 0);
  }, 0);
  const selectedNames = state.selectedLoadout
    .map((id) => state.skillCatalog.find((skill) => skill.id === id)?.name)
    .filter(Boolean);
  if (el.labLoadMeter) {
    el.labLoadMeter.textContent =
      state.selectedLoadout.length + " 项 · " + load + " / " + (state.skillConfig.maxLoad || 8);
  }
  if (el.skillLabStatus) {
    const selectionSummary = selectedNames.length
      ? "已选择：" + selectedNames.join("、")
      : "尚未选择技能";
    el.skillLabStatus.textContent = validation.ok
      ? selectionSummary + "。构筑有效，可保存。"
      : selectionSummary + " · " + (validation.error || `选择 ${state.skillConfig.minEquipped ?? 1}–${state.skillConfig.maxEquipped || 4} 个技能，总负载不超过 8。`);
  }
  if (el.btnSaveLoadout) el.btnSaveLoadout.disabled = !validation.ok;
  el.skillLabCatalog.textContent = "";
  state.skillCatalog.forEach((skill) => {
    const card = createSkillCatalogCard(skill, {
      selected: state.selectedLoadout.includes(skill.id),
      onSelect: () => {
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
      },
    });
    el.skillLabCatalog.appendChild(card);
  });
}

function saveLoadoutFromLab() {
  const validation = validateLoadoutIds(state.selectedLoadout);
  if (!validation.ok) return showToast(validation.error || "构筑无效", "error");
  state.savedLoadout = [...validation.skillIds];
  safeStorageSet("localStorage", STORAGE.skillLoadout, JSON.stringify(state.savedLoadout));
  updateSkillPrepUi();
  showToast("技能构筑已保存", "success");
  const pending = state.pendingRoomAction;
  state.pendingRoomAction = null;
  closeSkillLab();
  if (pending) {
    if (pending.type === "match") startMatchAction(pending.gameMode, pending.skillMode);
    else startRoomAction(pending.type, pending.gameMode, pending.skillMode);
  }
}

function requireLoadoutForSkillMode(skillMode, pendingAction) {
  if (skillMode !== "abyss") return true;
  if (isLoadoutConfigured()) return true;
  if (!beginUiRequest("room", 5000)) return false;
  state.pendingRoomAction = pendingAction;
  showToast("请先完成技能自定义配置", "error");
  ensureSkillCatalog()
    .then((catalog) => {
      if (catalog.length) openSkillLab(state.pendingRoomAction || pendingAction);
    })
    .finally(() => endUiRequest("room"));
  return false;
}

function laneLabel(gameMode, skillMode) {
  const mode = gameMode === GAME_MODE.OVERDRIVE ? "高爆局" : "标准局";
  const skill = skillMode === "abyss" ? " · 深渊技能" : " · 无技能";
  return mode + skill;
}

function stopMatchWaitTimer() {
  if (state.matchWaitRaf) cancelAnimationFrame(state.matchWaitRaf);
  state.matchWaitRaf = 0;
}

function updateMatchWaitTimer() {
  if (!state.matching || !state.matchQueuedAt) return;
  const seconds = Math.floor((Date.now() - state.matchQueuedAt) / 1000);
  if (el.matchWaitSeconds) el.matchWaitSeconds.textContent = String(seconds);
  state.matchWaitRaf = requestAnimationFrame(updateMatchWaitTimer);
}

function openMatchQueueUi(gameMode, skillMode) {
  state.matching = true;
  if (el.matchQueueLane) el.matchQueueLane.textContent = laneLabel(gameMode, skillMode);
  el.matchQueueModal?.classList.remove("hidden");
  el.matchContinueModal?.classList.add("hidden");
  syncModalIsolation();
  stopMatchWaitTimer();
  updateMatchWaitTimer();
}

function closeMatchQueueUi() {
  state.matching = false;
  state.matchQueuedAt = 0;
  stopMatchWaitTimer();
  el.matchQueueModal?.classList.add("hidden");
  el.matchContinueModal?.classList.add("hidden");
  syncModalIsolation();
}

function stopMatchInviteTimer() {
  if (state.matchInviteRaf) cancelAnimationFrame(state.matchInviteRaf);
  state.matchInviteRaf = 0;
}

function closeMatchInviteModal() {
  state.pendingMatchInvite = null;
  stopMatchInviteTimer();
  el.matchInviteModal?.classList.add("hidden");
  syncModalIsolation();
}

function updateMatchInviteCountdown() {
  const invite = state.pendingMatchInvite;
  if (!invite) return;
  const remainingMs = Math.max(0, invite.expiresAt - Date.now());
  if (el.matchInviteSeconds) {
    el.matchInviteSeconds.textContent = String(Math.ceil(remainingMs / 1000));
  }
  if (remainingMs <= 0) {
    closeMatchInviteModal();
    return;
  }
  state.matchInviteRaf = requestAnimationFrame(updateMatchInviteCountdown);
}

function openMatchInviteModal(payload) {
  state.pendingMatchInvite = {
    inviteId: payload.inviteId,
    targetGameMode: payload.targetGameMode,
    targetSkillMode: payload.targetSkillMode,
    expiresAt: Number(payload.expiresAt || Date.now() + 6000),
  };
  if (el.matchInviteText) {
    const lane = laneLabel(payload.targetGameMode, payload.targetSkillMode);
    const opponent = payload.opponentName ? `（${payload.opponentName}）` : "";
    el.matchInviteText.textContent = `邀请你切换到 ${lane} 立即开局${opponent}。`;
  }
  el.matchInviteModal?.classList.remove("hidden");
  syncModalIsolation();
  stopMatchInviteTimer();
  updateMatchInviteCountdown();
}

function cancelMatchmaking({ silent = false } = {}) {
  if (!state.matching && !state.matchQueuedAt) return;
  if (socket.connected && state.matching) {
    socket.emit("match:cancel");
  }
  closeMatchQueueUi();
  closeMatchInviteModal();
  endUiRequest("match");
  if (!silent) showToast("已取消匹配", "success");
}

function startMatchAction(gameMode, skillMode) {
  setProtocol(gameMode, skillMode);
  if (!requireLoadoutForSkillMode(skillMode, { type: "match", gameMode, skillMode })) return;
  if (!beginRealtimeRequest("match", 7000)) return;

  prepareManualRoomRequest();
  state.autoLoadoutSubmitted = false;
  state.myName = (el.inputName.value || "").trim() || "player1";
  // 入队成功后再离开大厅态，避免入队失败时卡在非大厅状态
  safeStorageSet("sessionStorage", STORAGE.playerName, state.myName);

  socket.emit("match:queue", {
    playerName: state.myName,
    playerId: state.playerId,
    reconnectToken: state.reconnectToken || undefined,
    gameMode: state.gameMode,
    skillMode: state.skillMode,
    // 跨邀进技能局需要双方有效构筑；与当前所选赛道无关
    hasSkillLoadout: isLoadoutConfigured(),
  });
}

function startRoomAction(type, gameMode, skillMode) {
  if (state.matching) cancelMatchmaking({ silent: true });
  setProtocol(gameMode, skillMode);
  if (!requireLoadoutForSkillMode(skillMode, { type, gameMode, skillMode })) return;
  if (!beginRealtimeRequest("room", 7000)) return;

  prepareManualRoomRequest();
  state.autoLoadoutSubmitted = false;
  state.myName = (el.inputName.value || "").trim() || "player1";
  state.atLobby = false;
  safeStorageSet("sessionStorage", STORAGE.playerName, state.myName);
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
  if (!beginRealtimeRequest("room", 7000)) return;
  el.joinPasswordModal?.classList.add("hidden");
  prepareManualRoomRequest();
  state.autoLoadoutSubmitted = false;
  state.myName = (el.inputName.value || "").trim() || "player2";
  state.atLobby = false;
  safeStorageSet("sessionStorage", STORAGE.playerName, state.myName);
  emitJoin(roomId, password);
}

function maybeAutoSubmitLoadout() {
  if (state.skillMode !== "abyss") return;
  if (!["waiting", "drafting"].includes(state.phase || "waiting")) return;
  if (!isLoadoutConfigured()) return;
  const me = getMe();
  if (me?.skills?.loadoutConfirmed) return;
  if (state.autoLoadoutSubmitted) return;
  if (!beginRealtimeRequest("loadout", 5000)) return;
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
  card.addEventListener("keydown", (event) => {
    if (event.target !== card) return;
    const cards = [...el.protocolCards];
    const index = cards.indexOf(card);
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const direction = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
      const next = cards[(index + direction + cards.length) % cards.length];
      setProtocol(next.dataset.gameMode || "standard", next.dataset.skillMode || "off");
      next.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setProtocol(card.dataset.gameMode || "standard", card.dataset.skillMode || "off");
    }
  });
});
el.protocolButtons?.forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const card = button.closest(".protocol-card");
    if (!card) return;
    const gameMode = card.dataset.gameMode || "standard";
    const skillMode = card.dataset.skillMode || "off";
    const action = button.dataset.roomAction;
    if (action === "match") {
      startMatchAction(gameMode, skillMode);
      return;
    }
    startRoomAction(action === "solo" ? "solo" : "create", gameMode, skillMode);
  });
});
el.btnMatchCancel?.addEventListener("click", () => cancelMatchmaking());
el.btnMatchContinue?.addEventListener("click", () => {
  if (!beginRealtimeRequest("match", 7000)) return;
  el.matchContinueModal?.classList.add("hidden");
  socket.emit("match:continue");
});
el.btnMatchStop?.addEventListener("click", () => cancelMatchmaking());
el.btnMatchAccept?.addEventListener("click", () => {
  const invite = state.pendingMatchInvite;
  if (!invite) return;
  if (!beginRealtimeRequest("match", 4000)) return;
  socket.emit("match:invite:accept", { inviteId: invite.inviteId });
  closeMatchInviteModal();
});
el.btnMatchDecline?.addEventListener("click", () => {
  const invite = state.pendingMatchInvite;
  if (!invite) return;
  if (!beginRealtimeRequest("match", 4000)) return;
  socket.emit("match:invite:decline", { inviteId: invite.inviteId });
  closeMatchInviteModal();
});
el.btnJoin.addEventListener("click", () => {
  if (state.matching) cancelMatchmaking({ silent: true });
  const roomId = (el.inputRoom.value || "").trim().toUpperCase();
  if (!roomId) return showToast("请输入房间号", "error");
  if (!beginRealtimeRequest("room", 7000)) return;
  prepareManualRoomRequest();
  state.autoLoadoutSubmitted = false;
  state.pendingJoinRoomId = roomId;
  state.myName = (el.inputName.value || "").trim() || "player2";
  state.atLobby = false;
  safeStorageSet("sessionStorage", STORAGE.playerName, state.myName);
  emitJoin(roomId, null);
});
el.inputRoom?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  el.btnJoin.click();
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
  if (!beginRealtimeRequest("password", 4000)) return;
  socket.emit("room:set_password", {
    password: (el.inputWaitPassword?.value || "").trim() || "",
  });
});
el.inputWaitPassword?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  el.btnSetRoomPassword.click();
});
el.btnOpenSkillLab?.addEventListener("click", async () => {
  if (el.btnOpenSkillLab.disabled) return;
  el.btnOpenSkillLab.disabled = true;
  try {
    const catalog = await ensureSkillCatalog();
    if (catalog.length) openSkillLab(null);
  } finally {
    el.btnOpenSkillLab.disabled = false;
  }
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
  if (!state.roomId || el.btnCopyRoom.disabled) return;
  el.btnCopyRoom.disabled = true;
  try {
    await navigator.clipboard.writeText(state.roomId);
    showToast("房间号已复制", "success");
  } catch (_error) {
    showToast("复制失败，请手动记录 " + state.roomId, "error");
  } finally {
    el.btnCopyRoom.disabled = false;
  }
});
el.btnBackWait.addEventListener("click", returnToLobby);
el.btnBackGame.addEventListener("click", returnToLobby);
el.btnBackLobby.addEventListener("click", returnToLobby);

el.actionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    if (!action || button.disabled) return;
    const payload = {
      action,
      handId: state.activeCommitment?.handId || null,
      turnId: state.turnId,
    };
    if (action === "raise") payload.amount = Number(el.raiseInput.value);
    if (!beginRealtimeRequest("action", 3000)) return;
    ensureAudioContext();
    setRaiseExpanded(false);
    socket.emit("player_action", payload);
  });
});
el.btnEndgameFire?.addEventListener("click", () => {
  if (!state.endgameWindow || el.btnEndgameFire.disabled) return;
  emitSkillUse("ENDGAME");
});
el.btnEndgameSkip?.addEventListener("click", () => {
  if (!state.endgameWindow || el.btnEndgameSkip.disabled) return;
  if (!beginRealtimeRequest("action", 3000)) return;
  socket.emit("player_action", {
    action: "skip_endgame",
    handId: state.activeCommitment?.handId || null,
    turnId: state.turnId,
  });
});
el.btnRaiseOptions?.addEventListener("click", () => {
  if (el.btnRaiseOptions.disabled) return;
  setRaiseExpanded(!el.raiseConsole?.classList.contains("expanded"));
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
  safeStorageSet("localStorage", STORAGE.revealCards, state.showMyCards ? "1" : "0");
  updateEyeButton();
  renderCards();
});

el.btnRematchYes.addEventListener("click", () => {
  if (!canSendRealtime()) return;
  el.btnRematchYes.disabled = true;
  socket.emit("rematch_response", { accepted: true });
});
el.btnRematchNo.addEventListener("click", () => {
  if (!canSendRealtime()) return;
  el.btnRematchYes.disabled = true;
  el.btnRematchNo.disabled = true;
  socket.emit("rematch_response", { accepted: false });
});

el.btnSettings.addEventListener("click", () => {
  el.settingsNavigation?.classList.toggle("hidden", el.auth.classList.contains("active"));
  el.settingsModal.classList.remove("hidden");
  el.btnCloseSettings.focus();
});
el.btnCloseSettings.addEventListener("click", () => {
  el.settingsModal.classList.add("hidden");
  el.btnSettings.focus();
});
el.btnSettingsLobby?.addEventListener("click", () => {
  el.settingsModal.classList.add("hidden");
  returnToLobby();
});
el.btnCloseSkillPreview?.addEventListener("click", closeSkillPreview);
el.btnSkillPreviewDone?.addEventListener("click", closeSkillPreview);
el.btnSkillPreviewNovice?.addEventListener("click", () => {
  state.settings.skillExpertText = false;
  saveSettings();
  if (previewingSkill) showSkillPreview(previewingSkill, skillPreviewReturnFocus);
});
el.btnSkillPreviewExpert?.addEventListener("click", () => {
  state.settings.skillExpertText = true;
  saveSettings();
  if (previewingSkill) showSkillPreview(previewingSkill, skillPreviewReturnFocus);
});
el.skillPreviewModal?.addEventListener("click", (event) => {
  if (event.target === el.skillPreviewModal) closeSkillPreview();
});
el.settingAnimation.addEventListener("change", () => {
  state.settings.animation = el.settingAnimation.value;
  saveSettings();
  applySettings();
});
el.settingAllInStyles.forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.checked || !ALL_IN_STYLES.includes(input.value)) return;
    state.settings.allInStyle = input.value;
    saveSettings();
    applySettings();
  });
});
el.btnPreviewAllIn?.addEventListener("click", () => {
  playAllInEffect(state.playerId, { preview: true });
});
el.settingProMode?.addEventListener("change", () => {
  state.settings.proPlayerMode = Boolean(el.settingProMode.checked);
  saveSettings();
  applySettings();
  showToast(
    state.settings.proPlayerMode ? "专家模式已开启 · TOURNAMENT DESK" : "已退出专家模式",
    "success"
  );
});
el.settingProFont?.addEventListener("change", () => {
  const next = el.settingProFont.value;
  if (!PRO_FONT_STYLES.includes(next)) return;
  state.settings.proFontStyle = next;
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
el.settingLowPerformance.addEventListener("change", () => {
  state.settings.lowPerformance = el.settingLowPerformance.checked;
  saveSettings();
  applySettings();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  setRaiseExpanded(false);
  const top = visibleModalLayers().at(-1);
  if (!top) return;
  if (top === el.skillPreviewModal) {
    closeSkillPreview();
  } else if (top === el.settingsModal) {
    top.classList.add("hidden");
    el.btnSettings.focus();
  } else if (top === el.leaveConfirmModal) {
    top.classList.add("hidden");
    el.btnBackGame.focus();
  } else if (top === el.joinPasswordModal) {
    closeJoinPasswordModal();
    el.inputRoom.focus();
  } else if (top === el.skillPrivateModal) {
    top.classList.add("hidden");
  }
});

socket.on("connect", () => {
  setConnectionUI(true, "连接正常");
  playTone("connect");
  const savedRoom = safeStorageGet("sessionStorage", STORAGE.roomId);
  const savedToken = safeStorageGet("sessionStorage", STORAGE.reconnectToken);
  if (savedRoom && savedToken && !state.deliberateLeave) {
    state.roomId = savedRoom;
    state.reconnectToken = savedToken;
    state.myName = safeStorageGet("sessionStorage", STORAGE.playerName) || state.myName;
    state.atLobby = false;
    state.reconnecting = true;
    showScreen("wait");
    emitJoin(savedRoom);
  }
});
socket.on("disconnect", () => {
  endAllUiRequests();
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

socket.on("match:queued", (payload) => {
  endUiRequest("match");
  state.atLobby = false;
  state.matchQueuedAt = Number(payload.queuedAt || Date.now());
  if (payload.playerId) {
    state.playerId = payload.playerId;
    safeStorageSet("sessionStorage", STORAGE.playerId, state.playerId);
  }
  openMatchQueueUi(payload.gameMode || state.gameMode, payload.skillMode || state.skillMode);
});

socket.on("match:found", () => {
  closeMatchQueueUi();
  closeMatchInviteModal();
  el.matchContinueModal?.classList.add("hidden");
  endUiRequest("match");
});

socket.on("match:cancelled", () => {
  closeMatchQueueUi();
  closeMatchInviteModal();
  endUiRequest("match");
  if (!state.roomId) state.atLobby = true;
});

socket.on("match:timeout", () => {
  stopMatchWaitTimer();
  closeMatchInviteModal();
});

socket.on("match:prompt_continue", () => {
  closeMatchInviteModal();
  el.matchQueueModal?.classList.add("hidden");
  el.matchContinueModal?.classList.remove("hidden");
  syncModalIsolation();
});

socket.on("match:invite", (payload) => {
  openMatchInviteModal(payload);
});

socket.on("match:invite:expired", () => {
  closeMatchInviteModal();
});

socket.on("match:error", (payload) => {
  endUiRequest("match");
  const msg = String(payload?.message || "匹配失败");
  // 取消与成局竞态：已不在队列时不弹错误
  if (/未在匹配/.test(msg) && (state.roomId || !state.matching)) return;
  if (!state.matching && !state.roomId) state.atLobby = true;
  showToast(msg, "error");
});

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
  if (Object.prototype.hasOwnProperty.call(payload, "handNo")) state.handNo = Number(payload.handNo || 0);
  if (Object.prototype.hasOwnProperty.call(payload, "hasPassword")) {
    state.hasPassword = Boolean(payload.hasPassword);
  }
  if (Array.isArray(payload.skillCatalog) && payload.skillCatalog.length) {
    state.skillCatalog = payload.skillCatalog;
    state.skillCatalogStatus = "ready";
  }
  state.playerId = payload.playerId || state.playerId;
  state.reconnectToken = payload.reconnectToken || state.reconnectToken;
  if (Object.prototype.hasOwnProperty.call(payload, "matchSource")) {
    state.matchSource = payload.matchSource || null;
  }
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
  endUiRequest("room");
  const enteringFromLobby = state.atLobby || !state.roomId || state.roomId !== payload.roomId;
  state.atLobby = false;
  state.reconnecting = false;
  state.deliberateLeave = false;
  applyRoomJoinedPayload(payload, { fromLobby: enteringFromLobby });

  if (enteringFromLobby && state.skillMode === "abyss" && !isLoadoutConfigured()) {
    showToast("技能局需先完成技能自定义配置", "error");
    completeReturnToLobby();
    ensureSkillCatalog().then((catalog) => {
      if (catalog.length) openSkillLab(null);
    });
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
  if (Object.prototype.hasOwnProperty.call(payload, "handNo")) state.handNo = Number(payload.handNo || 0);
  if (Object.prototype.hasOwnProperty.call(payload, "hasPassword")) {
    state.hasPassword = Boolean(payload.hasPassword);
  }
  state.chipViewHidden = Boolean(payload.chipViewHidden);
  el.game?.classList.toggle("chip-view-hidden", state.chipViewHidden);
  if (state.chipViewHidden) {
    state.pot = null;
    state.currentBet = null;
    state.toCall = null;
    state.minRaise = null;
    state.maxBet = null;
  } else {
    if (payload.pot != null) state.pot = payload.pot;
    if (payload.currentBet != null) state.currentBet = payload.currentBet;
  }
  state.dealer = payload.dealer || null;
  if (Object.prototype.hasOwnProperty.call(payload, "activePlayerId")) {
    state.currentTurnPlayerId = payload.activePlayerId;
  } else if (Object.prototype.hasOwnProperty.call(payload, "currentPlayer")) {
    state.currentTurnPlayerId = payload.currentPlayer;
  }
  state.communityCards = payload.communityCards || state.communityCards;
  state.nullifiedCommunityCardIds = payload.nullifiedCommunityCardIds || state.nullifiedCommunityCardIds;
  if (payload.skillState) {
    state.skillState = payload.skillState;
    state.endgameWindow = Boolean(payload.skillState.endgameWindow);
  }
  state.players = payload.players || state.players;
  if (!state.skillSelf) state.skillSelf = getMe()?.skills || null;
  if (Object.prototype.hasOwnProperty.call(payload, "actionDeadline")) {
    state.actionDeadline = payload.actionDeadline;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "turnId")) {
    state.turnId = payload.turnId || null;
  }
  if (payload.handId && payload.deckCommitment) {
    let record = state.commitments.get(payload.handId);
    if (!record) {
      record = {
        handId: payload.handId,
        mode: payload.gameMode || state.gameMode,
        skillMode: payload.skillMode || state.skillMode || "off",
        commitment: payload.deckCommitment,
      };
      state.commitments.set(record.handId, record);
      persistCommitments();
    }
    state.activeCommitment = record;
    refreshFairnessStatus();
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
  state.turnId = null;
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
    state.turnId = null;
  }
  renderState();
  if (state.communityCards.length > previousCount) triggerStreetEffect(state.phase);
});
socket.on("player_turn", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  endUiRequest("action");
  state.currentTurnPlayerId = payload.playerId;
  state.validActions = payload.playerId === state.playerId ? payload.validActions || [] : [];
  state.endgameWindow = Boolean(payload.endgameWindow);
  state.minRaise = payload.minRaise == null ? null : Number(payload.minRaise || 0);
  state.maxBet = payload.maxBet == null ? null : Number(payload.maxBet || 0);
  state.toCall = payload.toCall == null ? null : Number(payload.toCall || 0);
  state.actionDeadline = payload.actionDeadline || null;
  state.turnId = payload.turnId || null;
  if (payload.handId && state.commitments.has(payload.handId)) {
    state.activeCommitment = state.commitments.get(payload.handId);
  }
  logAction(payload.playerId === state.playerId ? "轮到你行动" : "对手正在行动");
  renderState();
});
socket.on("action_made", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  endUiRequest("action");
  state.currentTurnPlayerId = null;
  state.validActions = [];
  state.endgameWindow = false;
  state.actionDeadline = null;
  state.turnId = null;
  if (Array.isArray(payload.playerChips)) state.players = payload.playerChips;
  if (payload.pot === null && state.chipViewHidden) state.pot = null;
  else if (typeof payload.pot === "number") state.pot = payload.pot;
  const presentedAction = payload.forcePublicAllIn
    ? "allin"
    : payload.declaredAction === "allin" && (!state.chipViewHidden || payload.playerId === state.playerId)
      ? "allin"
      : payload.action;
  const label = ACTION_LABELS[presentedAction] || presentedAction;
  logAction("玩家 " + payload.playerId + " · " + label + (payload.amount ? " " + payload.amount : ""));
  if (["call", "raise", "allin"].includes(payload.action) && payload.amount > 0) {
    flyChip(payload.playerId);
    playTone("chips");
  }
  if ((presentedAction === "allin" || payload.forcePublicAllIn) && (!state.chipViewHidden || payload.forcePublicAllIn || payload.playerId === state.playerId)) {
    playAllInEffect(payload.playerId);
  } else playTone(payload.action);
  renderState();
});
socket.on("hand_result", queueHandSettlement);
socket.on("game_over", showGameOver);
socket.on("rematch_update", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  if (state.gameOver) updateRematch(payload);
});
socket.on("rematch_started", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  clearRematch();
  el.gameOverModal.classList.add("hidden");
  state.gameOver = false;
  state.phase = "waiting";
  state.handNo = 0;
  state.commitments = new Map();
  state.fairnessChecks = new Map();
  state.activeCommitment = null;
  state.fairnessStatus = "pending";
  safeStorageRemove("sessionStorage", STORAGE.commitments);
  if (Array.isArray(payload.players)) state.players = payload.players;
  logAction("双方确认，再来一局");
  renderState();
});
socket.on("hand_commitment", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  const record = {
    handId: payload.handId,
    mode: payload.mode,
    skillMode: payload.skillMode || state.skillMode || "off",
    commitment: payload.commitment,
  };
  state.commitments.set(record.handId, record);
  persistCommitments();
  state.activeCommitment = record;
  refreshFairnessStatus();
  renderFairness();
});
socket.on("hand_reveal", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  verifyHandReveal(payload).catch(() => {
    recordFairnessCheck(payload?.handId, "failed");
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
  if (shouldIgnoreSyncEvent(payload)) return;
  endAllUiRequests();
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
  endUiRequest("room");
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
  endUiRequest("password");
  state.hasPassword = Boolean(payload?.hasPassword);
  if (el.waitPasswordStatus) el.waitPasswordStatus.textContent = state.hasPassword ? "已设置" : "未设置";
  showToast(state.hasPassword ? "房间密码已设置" : "已清除房间密码", "success");
});
socket.on("action_error", (payload) => {
  endUiRequest("action");
  endUiRequest("password");
  showToast(payload.message || "操作失败", "error");
});

if (state.myName) el.inputName.value = state.myName;
if (state.roomId) el.inputRoom.value = state.roomId;
state.savedLoadout = loadSavedLoadout();
state.selectedLoadout = [...state.savedLoadout];
setMode(GAME_MODE.STANDARD);
setSkillMode("off");
applySettings();
updateEyeButton();
updateSkillPrepUi();
ensureSkillCatalog().then(() => {
  const validation = validateLoadoutIds(state.savedLoadout);
  if (state.skillCatalogStatus === "ready" && state.savedLoadout.length && !validation.ok) {
    state.selectedLoadout = [];
    showToast("检测到失效技能构筑，请重新配置。", "error");
  } else {
    state.selectedLoadout = [...state.savedLoadout];
  }
  updateSkillPrepUi();
  renderSkillDraft();
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
  const ownSkills = state.skillSelf || me?.skills || {};
  const confirmed = Boolean(ownSkills.loadoutConfirmed);
  const invalidBuild = ownSkills.buildStatus === "INVALID_BUILD";
  const equippedIds = Array.isArray(ownSkills.equippedSkillIds)
    ? ownSkills.equippedSkillIds
    : [];
  const draftIds = confirmed && equippedIds.length ? equippedIds : state.selectedLoadout;
  const load = loadoutLoad(draftIds);
  el.skillDraftPanel.classList.toggle("is-confirmed", confirmed);
  el.draftLoadMeter.textContent = load + " / 8 · " + draftIds.length + " / 4";
  el.draftStatus.textContent = invalidBuild
    ? "当前技能构筑包含重复或无效技能，请重新配置。"
    : confirmed
    ? "构筑已确认，等待对手…"
    : `选择 ${state.skillConfig.minEquipped ?? 1}–${state.skillConfig.maxEquipped || 4} 个技能，总负载不超过 8。`;
  el.btnConfirmLoadout.disabled =
    confirmed ||
    !socket.connected ||
    state.uiPending.loadout ||
    state.selectedLoadout.length < (state.skillConfig.minEquipped ?? 1) ||
    state.selectedLoadout.length > (state.skillConfig.maxEquipped || 4) ||
    load > 8;
  el.btnConfirmLoadout.classList.toggle("hidden", confirmed);
  el.skillCatalog.textContent = "";
  const visibleSkills = confirmed
    ? state.skillCatalog.filter((skill) => draftIds.includes(skill.id))
    : state.skillCatalog;
  visibleSkills.forEach((skill) => {
    const card = createSkillCatalogCard(skill, {
      selected: draftIds.includes(skill.id),
      disabled: confirmed || state.uiPending.loadout,
      onSelect: () => {
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
      },
    });
    el.skillCatalog.appendChild(card);
  });
}

function skillAvailability(def, skills, me) {
  const tags = new Set(def?.tags || []);
  if (tags.has("PASSIVE")) return { ready: false, kind: "passive", reason: "自动触发", cost: 0 };
  const cost = def?.id === "NULLIFICATION"
    ? Number(def.energyCosts?.board || def.energyCost || 0)
    : Number(def?.energyCost || 0);
  const handUsed = Number(skills?.skillUsesThisHand?.[def.id] || 0);
  const gameUsed = Number(skills?.skillUsesThisGame?.[def.id] || 0);
  let reason = "可发动";
  if (!socket.connected) reason = "等待网络恢复";
  else if (state.uiPending.skill) reason = "请求处理中";
  else if (!me || me.status === "folded" || me.status === "out") reason = "当前已退出本手";
  else if (Number(skills?.abyssEnergy || 0) < 0) reason = "负能量时不能发动";
  else if (skills?.lockedThisHand || state.skillState?.fairnessActive) reason = "本手技能已封锁";
  else if (Array.isArray(def.allowedPhases) && def.allowedPhases.length && !def.allowedPhases.includes(state.phase)) reason = "当前阶段不可用";
  else if (def.requiresActionTurn && state.currentTurnPlayerId !== state.playerId && !(def.id === "ENDGAME" && state.skillState?.endgameWindow?.playerId === state.playerId)) reason = "等待你的行动回合";
  else if (def.requiresActionTurn && me?.isAllIn && !(def.id === "ENDGAME" && state.skillState?.endgameWindow?.playerId === state.playerId)) reason = "All In 后没有下注行动回合";
  else if (def.requiresFirstSkillEvent && Number(skills?.skillEventsThisHand || 0) > 0) reason = "必须是本手第一个技能事件";
  else if (def.maxUsesPerHand != null && handUsed >= def.maxUsesPerHand) reason = "本手次数已用完";
  else if (def.maxUsesPerGame != null && gameUsed >= def.maxUsesPerGame) reason = "本场次数已用完";
  else if (Number(skills?.abyssEnergy || 0) < cost) reason = "能量不足";
  return { ready: reason === "可发动", kind: "active", reason, cost };
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
  if (el.selfEnergyCap) el.selfEnergyCap.textContent = String(selfSkills.energyCap || 8);
  el.opponentEnergy.textContent = String(opponent?.skills?.abyssEnergy ?? 0);
  const controlLabel = state.skillState?.fairnessActive
    ? "公平封锁"
    : state.skillState?.noFoldActive
      ? "恐吓 · 禁止弃牌"
      : selfSkills.lockedThisHand
        ? "技能封锁"
        : "";
  el.skillSilenceFlag.textContent = controlLabel;
  el.skillSilenceFlag.classList.toggle("hidden", !controlLabel);
  el.skillBar.textContent = "";
  const equippedSkillIds = selfSkills.equippedSkillIds || [];
  el.skillBar.dataset.count = String(equippedSkillIds.length);
  equippedSkillIds.forEach((skillId) => {
    const def = state.skillCatalog.find((skill) => skill.id === skillId) || {
      id: skillId,
      name: skillId,
      energyCost: 0,
      tags: [],
    };
    const availability = skillAvailability(def, selfSkills, me);
    const slot = document.createElement("div");
    slot.className = "skill-slot is-" + availability.kind;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "skill-use-btn is-" + availability.kind;
    btn.classList.toggle("is-ready", availability.ready);
    btn.disabled = !availability.ready;
    btn.dataset.reason = availability.reason;
    btn.title = skillDescriptionText(def) + "\n状态：" + availability.reason;
    btn.setAttribute("aria-label", def.name + "，" + availability.reason);
    btn.innerHTML =
      "<span class=\"skill-use-name\">" +
      def.name +
      "</span><span class=\"skill-use-cost\">" +
      (availability.kind === "passive" ? "被动" : availability.cost) +
      "</span>";
    btn.addEventListener("click", () => useSkill(skillId, def));
    slot.append(btn, createSkillZoomButton(def));
    el.skillBar.appendChild(slot);
  });

  if (el.opponentSkillBar) {
    const publicEffects = opponent?.skills?.publicEffects || [];
    const effectNames = publicEffects.map((id) =>
      state.skillCatalog.find((skill) => skill.id === id)?.name || id
    );
    const suspectedNames = (state.suspectedSkillIds || []).map((id) =>
      state.skillCatalog.find((skill) => skill.id === id)?.name || id
    );
    const parts = ["对手构筑已隐藏"];
    if (effectNames.length) parts.push("已确认：" + effectNames.join(" / "));
    if (suspectedNames.length) parts.push("本地怀疑：" + suspectedNames.join(" / "));
    el.opponentSkillBar.textContent = opponent ? parts.join(" · ") : "";
    el.opponentSkillBar.title = opponent
      ? el.opponentSkillBar.textContent + "（点击可标记怀疑技能，仅自己可见）"
      : "";
  }
}

function emitSkillUse(skillId, target = {}) {
  if (!beginRealtimeRequest("skill", 5000)) return false;
  socket.emit("skill:use", {
    skillId,
    target,
    requestId: "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    handId: state.activeCommitment?.handId || null,
    turnId: state.turnId,
    phase: state.phase,
  });
  return true;
}

function cardChoiceLabel(card) {
  if (!card) return "未知牌";
  return (card.rank === "T" ? "10" : card.rank) + suitText(card.suit);
}

function cardCodeLabel(code) {
  const suit = { S: "♠", H: "♥", C: "♣", D: "♦" }[code?.[0]] || "";
  const rank = code?.slice(1) === "T" ? "10" : code?.slice(1) || "?";
  return rank + suit;
}

function futureBoardIndexes() {
  const start = Math.max(0, Math.min(5, state.communityCards.length));
  return Array.from({ length: Math.max(0, 5 - start) }, (_unused, index) => start + index);
}

function openSkillTargetOptions({ skillId, title, text, options }) {
  if (!options.length) {
    showToast("当前没有可选择的牌", "error");
    return;
  }
  state.pendingChoice = { type: "SKILL_TARGET", skillId, payload: { target: {} } };
  el.skillChoiceTitle.textContent = title;
  el.skillChoiceText.textContent = text;
  el.skillChoiceBody.textContent = "";
  el.btnSkillChoiceConfirm.disabled = true;
  options.forEach((option) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "skill-choice-card target-card-choice";
    btn.textContent = option.label;
    if (option.tone) btn.dataset.tone = option.tone;
    btn.addEventListener("click", () => {
      [...el.skillChoiceBody.children].forEach((node) => node.classList.remove("selected"));
      btn.classList.add("selected");
      state.pendingChoice.payload.target = { ...option.target };
      el.btnSkillChoiceConfirm.disabled = false;
    });
    el.skillChoiceBody.appendChild(btn);
  });
  el.skillChoiceModal.classList.remove("hidden");
  el.skillChoiceBody.querySelector("button")?.focus();
}

function useSkill(skillId) {
  if (skillId === "INTEL_ONE") {
    const future = futureBoardIndexes();
    const options = [{ label: "随机读取一张对手底牌", target: { zone: "opponent" }, tone: "intel" }];
    future.forEach((boardIndex) => options.push({
      label: `查看未来公共牌 #${boardIndex + 1}`,
      target: { zone: "future", boardIndex },
      tone: "intel",
    }));
    return openSkillTargetOptions({ skillId, title: "情报", text: "先选择模式。扣费后不能改目标。", options });
  }
  if (skillId === "CHEAT") {
    const options = [];
    state.myCards.forEach((ownCard, ownIndex) => {
      [0, 1].forEach((index) => options.push({
        label: `${cardChoiceLabel(ownCard)} ↔ 对手底牌 #${index + 1}`,
        target: { ownIndex, zone: "opponent", index },
      }));
      state.communityCards.forEach((card, index) => options.push({
        label: `${cardChoiceLabel(ownCard)} ↔ 公共牌 #${index + 1} ${cardChoiceLabel(card)}`,
        target: { ownIndex, zone: "community", index },
      }));
      futureBoardIndexes().forEach((boardIndex) => options.push({
        label: `${cardChoiceLabel(ownCard)} ↔ 未来公共牌 #${boardIndex + 1}`,
        target: { ownIndex, zone: "future", index: boardIndex },
      }));
      if (futureBoardIndexes().length) options.push({
        label: `${cardChoiceLabel(ownCard)} ↔ 下一张有效发牌`,
        target: { ownIndex, zone: "next" },
      });
      options.push({
        label: `${cardChoiceLabel(ownCard)} ↔ 牌堆暗抽（非顶部）`,
        target: { ownIndex, zone: "deck_random" },
      });
    });
    return openSkillTargetOptions({ skillId, title: "千术", text: "选择自己的底牌与精确交换目标", options });
  }
  if (skillId === "NULLIFICATION") {
    const energy = Number((state.skillSelf || getMe()?.skills || {}).abyssEnergy || 0);
    const options = [];
    if (energy >= 7) {
      options.push({
        label: "零化对手一张随机底牌（7 能量）",
        target: { mode: "hole" },
      });
    }
    state.communityCards.forEach((card, boardIndex) => {
      options.push({
        label: `零化公共牌 #${boardIndex + 1} ${cardChoiceLabel(card)}（6 能量）`,
        target: { mode: "board", boardIndex },
      });
    });
    futureBoardIndexes().forEach((boardIndex) => options.push({
      label: `零化未来公共牌 #${boardIndex + 1}（6 能量）`,
      target: { mode: "board", boardIndex },
    }));
    return openSkillTargetOptions({ skillId, title: "零化", text: "选择模式与目标。双方可以点同一张公共牌。", options });
  }
  if (skillId === "LOAN") {
    const self = state.skillSelf || getMe()?.skills || {};
    const chipUses = Number(self.loanChipUsesThisHand || 0);
    const energyUses = Number(self.loanEnergyUsesThisHand || 0);
    const quota = self.loanQuota || { maxChip: 2, maxEnergy: 1, maxTotal: 3 };
    const credit = self.loanCreditState || "NORMAL_CREDIT";
    const totalUses = chipUses + energyUses;
    const totalLeft = Math.max(0, Number(quota.maxTotal) - totalUses);
    const chipLeft = Math.min(Math.max(0, Number(quota.maxChip) - chipUses), totalLeft);
    const energyLeft = Math.min(Math.max(0, Number(quota.maxEnergy) - energyUses), totalLeft);
    if (credit === "DEFAULTED" || Number(quota.maxTotal) <= 0) {
      showToast("贷款信用已违约，需先清偿剩余债务", "error");
      return;
    }
    const options = [];
    if (chipLeft > 0) {
      options.push({
        label: `筹码贷款：立即取得 100，下一手结束偿还 150（公开，本手还可 ${chipLeft} 次）`,
        target: { mode: "chip" },
        tone: "intel",
      });
    }
    if (energyLeft > 0) {
      options.push({
        label: "能量贷款：立即 +5 能量，下一手结束偿还 6（秘密）",
        target: { mode: "energy" },
      });
    }
    if (!options.length) {
      showToast(credit === "RESTRICTED_CREDIT" ? "信用受限：本手贷款只能发动 1 次" : "本手贷款次数已用完", "error");
      return;
    }
    const hint = credit === "RESTRICTED_CREDIT"
      ? "信用受限：本手所有贷款模式合计只能发动 1 次。"
      : "支付前锁定分支。正常信用：筹码最多 2 次，能量最多 1 次，合计最多 3 次。";
    return openSkillTargetOptions({
      skillId,
      title: "贷款",
      text: hint,
      options,
    });
  }
  if (skillId === "DESTINY") {
    const options = [];
    ["S", "H", "C", "D"].forEach((suit) => {
      ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"].forEach((rank) => {
        const cardCode = suit + rank;
        options.push({
          label: cardCodeLabel(cardCode),
          target: { cardCode },
          tone: ["H", "D"].includes(suit) ? "red" : "black",
        });
      });
    });
    return openSkillTargetOptions({ skillId, title: "天命", text: "转牌后指定一张牌立刻成为未来河牌；若不在可操作牌堆中，7 能量照付且失败", options });
  }
  emitSkillUse(skillId);
}

function openSuspectPicker() {
  const selected = new Set(state.suspectedSkillIds || []);
  state.pendingChoice = { type: "SUSPECT_SKILLS", skillIds: [...selected] };
  el.skillChoiceTitle.textContent = "怀疑技能";
  el.skillChoiceText.textContent = "仅保存在你本地，不会同步给对手，也不影响结算。";
  el.skillChoiceBody.textContent = "";
  el.btnSkillChoiceConfirm.disabled = false;
  state.skillCatalog.forEach((skill) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "skill-choice-card target-card-choice";
    btn.textContent = skill.name;
    btn.classList.toggle("selected", selected.has(skill.id));
    btn.addEventListener("click", () => {
      if (selected.has(skill.id)) selected.delete(skill.id);
      else selected.add(skill.id);
      btn.classList.toggle("selected", selected.has(skill.id));
      state.pendingChoice.skillIds = [...selected];
    });
    el.skillChoiceBody.appendChild(btn);
  });
  el.skillChoiceModal.classList.remove("hidden");
}

el.skillModeInputs?.forEach((input) =>
  input.addEventListener("change", () => setSkillMode(input.value))
);
el.btnConfirmLoadout?.addEventListener("click", () => {
  if (!beginRealtimeRequest("loadout", 5000)) return;
  socket.emit("skill:loadout:set", { skillIds: state.selectedLoadout });
});
el.btnSkillChoiceCancel?.addEventListener("click", () => {
  state.pendingChoice = null;
  el.skillChoiceModal.classList.add("hidden");
  renderSkillHud();
});
el.btnSkillChoiceConfirm?.addEventListener("click", () => {
  if (!state.pendingChoice) return;
  if (state.pendingChoice.type === "SKILL_TARGET") {
    if (!emitSkillUse(state.pendingChoice.skillId, state.pendingChoice.payload.target)) return;
    el.skillChoiceModal.classList.add("hidden");
    el.btnSkillChoiceConfirm.disabled = false;
    state.pendingChoice = null;
    return;
  }
  if (state.pendingChoice.type === "SUSPECT_SKILLS") {
    saveSuspectedSkillIds(state.pendingChoice.skillIds || []);
    el.skillChoiceModal.classList.add("hidden");
    state.pendingChoice = null;
    renderSkillHud();
  }
});
el.opponentSkillBar?.addEventListener("click", () => {
  if (state.skillMode !== "abyss" || !getOpponent()) return;
  openSuspectPicker();
});
el.btnSkillPrivateClose?.addEventListener("click", () => {
  el.skillPrivateModal.classList.add("hidden");
  const next = state.privateResultQueue.shift();
  if (next) {
    setTimeout(() => {
      el.skillPrivateText.textContent = next;
      el.skillPrivateModal.classList.remove("hidden");
    }, 0);
  }
});

socket.on("skill:state", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  endUiRequest("skill");
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
  const recentLog = payload.room?.recentLog || [];
  if (el.skillLog) {
    el.skillLog.textContent = "";
    recentLog.slice().reverse().forEach((entry) => {
      const line = document.createElement("div");
      line.textContent = entry.publicSummary || entry.skillId;
      el.skillLog.appendChild(line);
    });
  }
  renderSkillDraft();
  renderState();
});

socket.on("skill:loadout:confirmed", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  endUiRequest("loadout");
  if (!el.game.classList.contains("active")) {
    showToast((payload.playerId === state.playerId ? "你" : "对手") + " 已确认技能构筑", "success");
  }
  renderSkillDraft();
});

socket.on("skill:pending", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  logAction("技能发动：" + payload.skillId);
});

socket.on("skill:resolved", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  endUiRequest("skill");
  endUiRequest("choice");
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
  if (payload.skillId === "ENDGAME" && payload.publicData?.endgame) {
    playEndgameDeclare({ execution: Boolean(payload.publicData.execution) });
  }
  renderState();
});

socket.on("skill:failed", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  endUiRequest("skill");
  endUiRequest("choice");
  endUiRequest("loadout");
  if (payload.reason === "INVALID_BUILD") {
    state.autoLoadoutSubmitted = false;
    renderSkillDraft();
  }
  showToast(payload.message || "技能失败", "error");
});

socket.on("skill:private-result", (payload) => {
  if (shouldIgnoreSyncEvent(payload)) return;
  if (payload.resultId && state.seenPrivateResultIds.has(payload.resultId)) return;
  if (payload.resultId) state.seenPrivateResultIds.add(payload.resultId);
  endUiRequest("skill");
  endUiRequest("choice");
  if (payload.cards) state.myCards = payload.cards;
  const message = payload.message ||
    (payload.opponentEnergy != null ? `对手真实能量：${payload.opponentEnergy}` : "私有技能结果已更新。");
  if (el.skillPrivateModal.classList.contains("hidden")) {
    el.skillPrivateText.textContent = message;
    el.skillPrivateModal.classList.remove("hidden");
  } else {
    state.privateResultQueue.push(message);
  }
  renderState();
});
