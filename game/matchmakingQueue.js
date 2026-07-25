const crypto = require("crypto");
const { normalizeGameMode } = require("./gameModes");
const { normalizeSkillMode, isSkillEnabled } = require("./skillModes");

const SESSION_MS = 60_000;
const CROSS_WAIT_MS = 10_000;
const INVITE_MS = 6_000;
const MAX_PAIR_FLOW_INVITES = 2;
const SCAN_MS = 500;

function laneKey(gameMode, skillMode) {
  return `${normalizeGameMode(gameMode)}:${normalizeSkillMode(skillMode)}`;
}

function parseLane(key) {
  const [gameMode, skillMode] = String(key || "").split(":");
  return {
    gameMode: normalizeGameMode(gameMode),
    skillMode: normalizeSkillMode(skillMode),
  };
}

function makeEntryId() {
  return crypto.randomBytes(8).toString("hex");
}

function makeInviteId() {
  return crypto.randomBytes(6).toString("hex");
}

function makeFlowId() {
  return crypto.randomBytes(6).toString("hex");
}

function pairKeyForEntries(a, b) {
  return [a.playerId, b.playerId].sort().join("\x1f");
}

function pairKeyInvolvesPlayer(pairKey, playerId) {
  const parts = String(pairKey || "").split("\x1f");
  return parts[0] === playerId || parts[1] === playerId;
}

function nowMs() {
  return Date.now();
}

function canJoinSkillLane(entry) {
  return entry.hasSkillLoadout === true;
}

function canInviteEntryToLane(entry, gameMode, skillMode) {
  if (!isSkillEnabled(skillMode)) return true;
  return canJoinSkillLane(entry);
}

class MatchmakingQueue {
  constructor(options = {}) {
    this.now = options.now || nowMs;
    this.scanIntervalMs = options.scanIntervalMs || SCAN_MS;
    this.sessionMs = options.sessionMs || SESSION_MS;
    this.crossWaitMs = options.crossWaitMs || CROSS_WAIT_MS;
    this.inviteMs = options.inviteMs || INVITE_MS;
    this.maxPairFlowInvites = options.maxPairFlowInvites || MAX_PAIR_FLOW_INVITES;

    this.entries = new Map();
    this.byPlayerId = new Map();
    this.bySocketId = new Map();
    this.lanes = new Map();

    this.pendingInvite = null;
    this.activePairFlow = null;
    this.blockedPairKeys = new Set();
    this.scanTimer = null;

    this.onMatch = null;
    this.onInvite = null;
    this.onInviteExpired = null;
    this.onSessionTimeout = null;
    this.onRemoved = null;
  }

  start() {
    if (this.scanTimer) return;
    this.scanTimer = setInterval(() => this.scan(), this.scanIntervalMs);
    if (typeof this.scanTimer.unref === "function") this.scanTimer.unref();
  }

  stop() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.clearPendingInvite("shutdown");
    for (const entry of [...this.entries.values()]) {
      this.clearSessionTimer(entry);
    }
  }

  getEntry(entryId) {
    const entry = this.entries.get(entryId);
    if (!entry || entry.removed) return null;
    return entry;
  }

  getEntryByPlayerId(playerId) {
    const entryId = this.byPlayerId.get(playerId);
    return entryId ? this.getEntry(entryId) : null;
  }

  getEntryBySocketId(socketId) {
    const entryId = this.bySocketId.get(socketId);
    return entryId ? this.getEntry(entryId) : null;
  }

  isQueued(playerId) {
    const entry = this.getEntryByPlayerId(playerId);
    return Boolean(entry && !entry.sessionExpired);
  }

  enqueue(payload) {
    const playerId = String(payload.playerId || "");
    const socketId = String(payload.socketId || "");
    if (!playerId || !socketId) {
      return { ok: false, error: "玩家标识缺失" };
    }

    const existing = this.getEntryByPlayerId(playerId);
    if (existing) {
      this.cancelByEntryId(existing.entryId, { reason: "requeue" });
    } else if (this.bySocketId.has(socketId)) {
      const oldEntryId = this.bySocketId.get(socketId);
      this.cancelByEntryId(oldEntryId, { reason: "requeue" });
    }

    const entry = {
      entryId: makeEntryId(),
      playerId,
      socketId,
      playerName: String(payload.playerName || "").trim() || "player",
      gameMode: normalizeGameMode(payload.gameMode),
      skillMode: normalizeSkillMode(payload.skillMode),
      hasSkillLoadout: payload.hasSkillLoadout === true,
      reconnectToken: payload.reconnectToken || null,
      queuedAt: this.now(),
      sessionStartedAt: this.now(),
      invitesReceivedThisSession: 0,
      /** 本段 60s 内作为被邀请方收到的邀请次数 */
      sessionInvitesUsed: 0,
      /** 本段 60s 内参与过的已发出跨邀次数（invitee 或 partner），用于全局上限 2 */
      sessionCrossInvitesInvolved: 0,
      generation: 1,
      removed: false,
      sessionExpired: false,
      sessionTimer: null,
    };

    this.entries.set(entry.entryId, entry);
    this.byPlayerId.set(playerId, entry.entryId);
    this.bySocketId.set(socketId, entry.entryId);
    this.pushLane(entry);
    this.resetSessionTimer(entry);

    if (isSkillEnabled(entry.skillMode) && !canJoinSkillLane(entry)) {
      this.cancelByEntryId(entry.entryId, { reason: "invalid_loadout" });
      return { ok: false, error: "技能局需有效构筑" };
    }

    return {
      ok: true,
      entry: this.publicEntry(entry),
    };
  }

  pushLane(entry) {
    const key = laneKey(entry.gameMode, entry.skillMode);
    if (!this.lanes.has(key)) this.lanes.set(key, []);
    this.lanes.get(key).push(entry.entryId);
  }

  removeFromLane(entry) {
    const key = laneKey(entry.gameMode, entry.skillMode);
    const lane = this.lanes.get(key);
    if (!lane) return;
    const index = lane.indexOf(entry.entryId);
    if (index >= 0) lane.splice(index, 1);
    if (lane.length === 0) this.lanes.delete(key);
  }

  publicEntry(entry) {
    return {
      entryId: entry.entryId,
      playerId: entry.playerId,
      gameMode: entry.gameMode,
      skillMode: entry.skillMode,
      queuedAt: entry.queuedAt,
      sessionStartedAt: entry.sessionStartedAt,
      sessionEndsAt: entry.sessionStartedAt + this.sessionMs,
      waitMs: Math.max(0, this.now() - entry.queuedAt),
    };
  }

  resetSessionTimer(entry) {
    this.clearSessionTimer(entry);
    entry.sessionTimer = setTimeout(() => {
      if (entry.removed || entry.sessionExpired) return;
      entry.sessionExpired = true;
      this.onSessionTimeout?.(entry);
    }, this.sessionMs);
    if (typeof entry.sessionTimer.unref === "function") entry.sessionTimer.unref();
  }

  clearSessionTimer(entry) {
    if (!entry?.sessionTimer) return;
    clearTimeout(entry.sessionTimer);
    entry.sessionTimer = null;
  }

  continueSession(playerId) {
    const entry = this.getEntryByPlayerId(playerId);
    if (!entry) return { ok: false, error: "未在匹配队列中" };
    if (!entry.sessionExpired) return { ok: false, error: "当前匹配会话尚未结束" };

    entry.sessionExpired = false;
    entry.sessionStartedAt = this.now();
    entry.invitesReceivedThisSession = 0;
    entry.sessionInvitesUsed = 0;
    entry.sessionCrossInvitesInvolved = 0;
    for (const key of [...this.blockedPairKeys]) {
      if (pairKeyInvolvesPlayer(key, entry.playerId)) this.blockedPairKeys.delete(key);
    }
    this.resetSessionTimer(entry);
    return { ok: true, entry: this.publicEntry(entry) };
  }

  cancelByPlayerId(playerId, options = {}) {
    const entry = this.getEntryByPlayerId(playerId);
    if (!entry) return { ok: false, error: "未在匹配队列中" };
    return this.cancelByEntryId(entry.entryId, options);
  }

  cancelBySocketId(socketId, options = {}) {
    const entry = this.getEntryBySocketId(socketId);
    if (!entry) return { ok: false, error: "未在匹配队列中" };
    return this.cancelByEntryId(entry.entryId, options);
  }

  cancelByEntryId(entryId, options = {}) {
    const entry = this.entries.get(entryId);
    if (!entry || entry.removed) return { ok: false, error: "未在匹配队列中" };

    entry.removed = true;
    entry.generation += 1;
    this.clearSessionTimer(entry);
    this.removeFromLane(entry);
    this.byPlayerId.delete(entry.playerId);
    this.bySocketId.delete(entry.socketId);
    this.entries.delete(entryId);

    if (this.pendingInvite) {
      const invite = this.pendingInvite;
      if (
        invite.inviteeEntryId === entryId ||
        invite.partnerEntryId === entryId
      ) {
        this.clearPendingInvite("cancelled");
      }
    }

    if (this.activePairFlow) {
      const flow = this.activePairFlow;
      if (flow.entryAId === entryId || flow.entryBId === entryId) {
        this.activePairFlow = null;
      }
    }

    this.onRemoved?.(entry, options.reason || "cancel");
    return { ok: true, entry };
  }

  invalidateInviteForEntry(entryId) {
    if (!this.pendingInvite) return;
    const invite = this.pendingInvite;
    if (invite.inviteeEntryId !== entryId && invite.partnerEntryId !== entryId) return;
    this.clearPendingInvite("invalidated");
  }

  updateSocketId(playerId, socketId) {
    const entry = this.getEntryByPlayerId(playerId);
    if (!entry) return null;
    if (entry.socketId === socketId) return entry;
    this.bySocketId.delete(entry.socketId);
    entry.socketId = socketId;
    this.bySocketId.set(socketId, entry.entryId);
    return entry;
  }

  scan() {
    if (this.pendingInvite) return;
    this.trySameLaneMatches();
    if (!this.pendingInvite && !this.activePairFlow) {
      this.tryStartCrossLaneFlow();
    }
  }

  isMatchable(entry) {
    return (
      entry &&
      !entry.removed &&
      !entry.sessionExpired &&
      this.entries.has(entry.entryId)
    );
  }

  trySameLaneMatches() {
    for (const [key, laneEntryIds] of [...this.lanes.entries()]) {
      while (laneEntryIds.length >= 2 && !this.pendingInvite) {
        const firstId = laneEntryIds[0];
        const secondId = laneEntryIds[1];
        const first = this.getEntry(firstId);
        const second = this.getEntry(secondId);
        if (!this.isMatchable(first) || !this.isMatchable(second)) {
          if (!this.isMatchable(first)) laneEntryIds.shift();
          else if (!this.isMatchable(second)) laneEntryIds.splice(1, 1);
          else break;
          continue;
        }
        const lane = parseLane(key);
        this.commitMatch(first, second, lane);
      }
    }
  }

  commitMatch(entryA, entryB, lane) {
    const genA = entryA.generation;
    const genB = entryB.generation;
    const removedA = this.removeForMatch(entryA.entryId, genA);
    const removedB = this.removeForMatch(entryB.entryId, genB);
    if (!removedA || !removedB) {
      if (removedA && !removedB) this.reinsertEntry(entryA);
      if (removedB && !removedA) this.reinsertEntry(entryB);
      return;
    }
    this.activePairFlow = null;
    this.onMatch?.(removedA, removedB, lane);
  }

  removeForMatch(entryId, expectedGeneration) {
    const entry = this.entries.get(entryId);
    if (!entry || entry.removed || entry.generation !== expectedGeneration) return null;
    entry.removed = true;
    entry.generation += 1;
    this.clearSessionTimer(entry);
    this.removeFromLane(entry);
    this.byPlayerId.delete(entry.playerId);
    this.bySocketId.delete(entry.socketId);
    this.entries.delete(entryId);
    return entry;
  }

  reinsertEntry(entry) {
    if (!entry || this.entries.has(entry.entryId)) return;
    entry.removed = false;
    entry.generation += 1;
    this.entries.set(entry.entryId, entry);
    this.byPlayerId.set(entry.playerId, entry.entryId);
    this.bySocketId.set(entry.socketId, entry.entryId);
    this.pushLane(entry);
    this.resetSessionTimer(entry);
  }

  hasSessionInviteBudget(entry) {
    return (entry?.sessionCrossInvitesInvolved || 0) < this.maxPairFlowInvites;
  }

  findCrossLanePair() {
    const candidates = [];
    for (const entry of this.entries.values()) {
      if (!this.isMatchable(entry)) continue;
      if (!this.hasSessionInviteBudget(entry)) continue;
      if (this.now() - entry.queuedAt < this.crossWaitMs) continue;
      candidates.push(entry);
    }

    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const a = candidates[i];
        const b = candidates[j];
        if (laneKey(a.gameMode, a.skillMode) === laneKey(b.gameMode, b.skillMode)) continue;
        const pairKey = pairKeyForEntries(a, b);
        if (this.blockedPairKeys.has(pairKey)) continue;
        return { a, b, pairKey };
      }
    }
    return null;
  }

  tryStartCrossLaneFlow() {
    const pair = this.findCrossLanePair();
    if (!pair) return;

    const firstIsA = Math.random() < 0.5;
    this.activePairFlow = {
      flowId: makeFlowId(),
      entryAId: pair.a.entryId,
      entryBId: pair.b.entryId,
      pairKey: pair.pairKey,
      invitesSent: 0,
      firstIsA,
      firstInviteSkipped: false,
      completed: false,
    };

    this.tryNextCrossInvite();
  }

  tryNextCrossInvite() {
    const flow = this.activePairFlow;
    if (!flow || flow.completed) return;

    const entryA = this.getEntry(flow.entryAId);
    const entryB = this.getEntry(flow.entryBId);
    if (!this.isMatchable(entryA) || !this.isMatchable(entryB)) {
      this.endPairFlowWithoutMatch();
      return;
    }

    if (flow.invitesSent >= this.maxPairFlowInvites) {
      this.endPairFlowWithoutMatch();
      return;
    }

    const steps = flow.firstIsA
      ? [
          { invitee: entryA, partner: entryB, lane: entryB },
          { invitee: entryB, partner: entryA, lane: entryA },
        ]
      : [
          { invitee: entryB, partner: entryA, lane: entryA },
          { invitee: entryA, partner: entryB, lane: entryB },
        ];

    const stepIndex = flow.invitesSent;
    if (stepIndex >= steps.length) {
      this.endPairFlowWithoutMatch();
      return;
    }

    const step = steps[stepIndex];
    const targetGameMode = step.lane.gameMode;
    const targetSkillMode = step.lane.skillMode;

    if (!canInviteEntryToLane(step.invitee, targetGameMode, targetSkillMode)) {
      if (stepIndex === 0 && flow.invitesSent === 0) {
        const reverse = steps[1];
        if (
          canInviteEntryToLane(reverse.invitee, reverse.lane.gameMode, reverse.lane.skillMode)
        ) {
          flow.firstInviteSkipped = true;
          this.sendInvite({
            flow,
            invitee: reverse.invitee,
            partner: reverse.partner,
            targetGameMode: reverse.lane.gameMode,
            targetSkillMode: reverse.lane.skillMode,
          });
          return;
        }
        this.endPairFlowWithoutMatch();
        return;
      }
      this.endPairFlowWithoutMatch();
      return;
    }

    this.sendInvite({
      flow,
      invitee: step.invitee,
      partner: step.partner,
      targetGameMode,
      targetSkillMode,
    });
  }

  sendInvite({ flow, invitee, partner, targetGameMode, targetSkillMode }) {
    if (this.pendingInvite) return;
    if (!this.isMatchable(invitee) || !this.isMatchable(partner)) {
      this.endPairFlowWithoutMatch();
      return;
    }

    if (!this.hasSessionInviteBudget(invitee) || !this.hasSessionInviteBudget(partner)) {
      this.endPairFlowWithoutMatch();
      return;
    }

    if (
      isSkillEnabled(targetSkillMode) &&
      (!canJoinSkillLane(invitee) || !canJoinSkillLane(partner))
    ) {
      this.endPairFlowWithoutMatch();
      return;
    }

    const inviteId = makeInviteId();
    const expiresAt = this.now() + this.inviteMs;
    flow.invitesSent += 1;
    invitee.invitesReceivedThisSession += 1;
    invitee.sessionInvitesUsed = (invitee.sessionInvitesUsed || 0) + 1;
    invitee.sessionCrossInvitesInvolved = (invitee.sessionCrossInvitesInvolved || 0) + 1;
    partner.sessionCrossInvitesInvolved = (partner.sessionCrossInvitesInvolved || 0) + 1;

    this.pendingInvite = {
      inviteId,
      flowId: flow.flowId,
      inviteeEntryId: invitee.entryId,
      partnerEntryId: partner.entryId,
      targetGameMode,
      targetSkillMode,
      expiresAt,
      resolved: false,
      timer: setTimeout(() => this.handleInviteTimeout(inviteId), this.inviteMs),
    };
    if (typeof this.pendingInvite.timer.unref === "function") {
      this.pendingInvite.timer.unref();
    }

    const delivered = this.onInvite?.({
      inviteId,
      invitee,
      partner,
      targetGameMode,
      targetSkillMode,
      expiresAt,
      flowInvitesSent: flow.invitesSent,
    });

    if (delivered === false) {
      // 计次保留，避免投递失败时同步重试同一 step 造成死循环
      const invite = this.pendingInvite;
      if (invite?.timer) clearTimeout(invite.timer);
      this.pendingInvite = null;
      this.onInviteExpired?.(invite, "undeliverable");
      this.afterInviteRejected();
    }
  }

  clearPendingInvite(reason) {
    if (!this.pendingInvite) return null;
    const invite = this.pendingInvite;
    if (invite.timer) clearTimeout(invite.timer);
    this.pendingInvite = null;
    if (!invite.resolved) {
      this.onInviteExpired?.(invite, reason);
    }
    return invite;
  }

  handleInviteTimeout(inviteId) {
    const invite = this.pendingInvite;
    if (!invite || invite.inviteId !== inviteId || invite.resolved) return;
    invite.resolved = true;
    this.pendingInvite = null;
    this.onInviteExpired?.(invite, "timeout");
    this.afterInviteRejected();
  }

  acceptInvite(inviteId, playerId) {
    const invite = this.pendingInvite;
    if (!invite || invite.inviteId !== inviteId) {
      return { ok: false, error: "邀请不存在或已失效" };
    }
    const invitee = this.getEntry(invite.inviteeEntryId);
    if (!invitee || invitee.playerId !== playerId) {
      return { ok: false, error: "无权接受该邀请" };
    }

    const partner = this.getEntry(invite.partnerEntryId);
    if (!this.isMatchable(invitee) || !this.isMatchable(partner)) {
      this.clearPendingInvite("invalid");
      return { ok: false, error: "邀请已失效" };
    }

    if (
      isSkillEnabled(invite.targetSkillMode) &&
      (!canJoinSkillLane(invitee) || !canJoinSkillLane(partner))
    ) {
      this.clearPendingInvite("invalid");
      return { ok: false, error: "技能局需双方有效构筑" };
    }

    invite.resolved = true;
    if (invite.timer) clearTimeout(invite.timer);
    this.pendingInvite = null;
    this.activePairFlow = null;

    const lane = {
      gameMode: invite.targetGameMode,
      skillMode: invite.targetSkillMode,
    };
    this.commitMatch(invitee, partner, lane);
    return { ok: true, lane };
  }

  declineInvite(inviteId, playerId) {
    const invite = this.pendingInvite;
    if (!invite || invite.inviteId !== inviteId) {
      return { ok: false, error: "邀请不存在或已失效" };
    }
    const invitee = this.getEntry(invite.inviteeEntryId);
    if (!invitee || invitee.playerId !== playerId) {
      return { ok: false, error: "无权拒绝该邀请" };
    }

    invite.resolved = true;
    if (invite.timer) clearTimeout(invite.timer);
    this.pendingInvite = null;
    this.onInviteExpired?.(invite, "declined");
    this.afterInviteRejected();
    return { ok: true };
  }

  endPairFlowWithoutMatch() {
    const flow = this.activePairFlow;
    if (flow?.pairKey) this.blockedPairKeys.add(flow.pairKey);
    this.activePairFlow = null;
  }

  afterInviteRejected() {
    const flow = this.activePairFlow;
    if (!flow || flow.completed) return;

    if (flow.firstInviteSkipped && flow.invitesSent === 1) {
      this.endPairFlowWithoutMatch();
      return;
    }

    if (flow.invitesSent >= this.maxPairFlowInvites) {
      this.endPairFlowWithoutMatch();
      return;
    }

    this.tryNextCrossInvite();
  }

  getStats() {
    return {
      queued: this.entries.size,
      lanes: [...this.lanes.entries()].map(([key, ids]) => ({ key, count: ids.length })),
      pendingInvite: Boolean(this.pendingInvite),
      activePairFlow: Boolean(this.activePairFlow),
    };
  }
}

module.exports = {
  MatchmakingQueue,
  laneKey,
  parseLane,
  pairKeyForEntries,
  pairKeyInvolvesPlayer,
  SESSION_MS,
  CROSS_WAIT_MS,
  INVITE_MS,
  MAX_PAIR_FLOW_INVITES,
  canInviteEntryToLane,
  canJoinSkillLane,
};
