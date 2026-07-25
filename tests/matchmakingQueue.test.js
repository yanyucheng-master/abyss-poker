const {
  MatchmakingQueue,
  laneKey,
  pairKeyInvolvesPlayer,
  SESSION_MS,
  CROSS_WAIT_MS,
  INVITE_MS,
} = require("../game/matchmakingQueue");
const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");

function makeQueue(options = {}) {
  let clock = 0;
  const queue = new MatchmakingQueue({
    now: () => clock,
    scanIntervalMs: 50,
    ...options,
  });
  return {
    queue,
    tick: (ms) => {
      clock += ms;
    },
  };
}

function enqueuePlayer(queue, overrides = {}) {
  return queue.enqueue({
    playerId: overrides.playerId || `P_${Math.random().toString(36).slice(2, 8)}`,
    socketId: overrides.socketId || `S_${Math.random().toString(36).slice(2, 8)}`,
    playerName: overrides.playerName || "Tester",
    gameMode: overrides.gameMode || GAME_MODE.STANDARD,
    skillMode: overrides.skillMode || SKILL_MODE.OFF,
    hasSkillLoadout: overrides.hasSkillLoadout === true,
    ...overrides,
  });
}

describe("matchmakingQueue", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("同赛道 FIFO 直接配 2 人", () => {
    const { queue } = makeQueue();
    const matches = [];
    queue.onMatch = (a, b, lane) => matches.push({ a: a.playerId, b: b.playerId, lane });
    queue.start();

    enqueuePlayer(queue, { playerId: "P1", socketId: "S1" });
    enqueuePlayer(queue, { playerId: "P2", socketId: "S2" });
    queue.scan();

    expect(matches).toHaveLength(1);
    expect(matches[0].a).toBe("P1");
    expect(matches[0].b).toBe("P2");
    queue.stop();
  });

  test("cancel 后不会再被配进房", () => {
    const { queue } = makeQueue();
    const matches = [];
    queue.onMatch = (a, b) => matches.push([a.playerId, b.playerId]);
    queue.start();

    enqueuePlayer(queue, { playerId: "P1", socketId: "S1" });
    enqueuePlayer(queue, { playerId: "P2", socketId: "S2" });
    queue.cancelByPlayerId("P1");
    queue.scan();

    expect(matches).toHaveLength(0);
    expect(queue.isQueued("P2")).toBe(true);
    queue.stop();
  });

  test("特殊场景：跳过 A 改邀 B", () => {
    const { queue, tick } = makeQueue();
    const invites = [];
    queue.onInvite = (payload) => invites.push(payload);
    queue.start();

    enqueuePlayer(queue, {
      playerId: "A",
      socketId: "SA",
      gameMode: GAME_MODE.STANDARD,
      skillMode: SKILL_MODE.OFF,
      hasSkillLoadout: false,
    });
    enqueuePlayer(queue, {
      playerId: "B",
      socketId: "SB",
      gameMode: GAME_MODE.OVERDRIVE,
      skillMode: SKILL_MODE.ABYSS,
      hasSkillLoadout: true,
    });
    tick(CROSS_WAIT_MS + 1);
    queue.scan();

    expect(invites).toHaveLength(1);
    expect(invites[0].invitee.playerId).toBe("B");
    expect(invites[0].targetSkillMode).toBe(SKILL_MODE.OFF);
    expect(queue.getEntryByPlayerId("A").invitesReceivedThisSession).toBe(0);
    expect(queue.getEntryByPlayerId("A").sessionInvitesUsed).toBe(0);
    expect(queue.getEntryByPlayerId("B").invitesReceivedThisSession).toBe(1);
    expect(queue.getEntryByPlayerId("B").sessionInvitesUsed).toBe(1);
    expect(queue.getEntryByPlayerId("A").sessionCrossInvitesInvolved).toBe(1);
    expect(queue.getEntryByPlayerId("B").sessionCrossInvitesInvolved).toBe(1);
    queue.stop();
  });

  test("双方有构筑时可邀入技能局", () => {
    const { queue, tick } = makeQueue();
    const invites = [];
    queue.onInvite = (payload) => invites.push(payload);
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0);
    queue.start();

    enqueuePlayer(queue, {
      playerId: "A",
      socketId: "SA",
      gameMode: GAME_MODE.STANDARD,
      skillMode: SKILL_MODE.OFF,
      hasSkillLoadout: true,
    });
    enqueuePlayer(queue, {
      playerId: "B",
      socketId: "SB",
      gameMode: GAME_MODE.OVERDRIVE,
      skillMode: SKILL_MODE.ABYSS,
      hasSkillLoadout: true,
    });
    tick(CROSS_WAIT_MS + 1);
    queue.scan();

    expect(invites).toHaveLength(1);
    expect(invites[0].invitee.playerId).toBe("A");
    expect(invites[0].targetSkillMode).toBe(SKILL_MODE.ABYSS);
    randomSpy.mockRestore();
    queue.stop();
  });

  test("60s 会话内跨邀参与满 2 次后不再与其他候选跨邀", () => {
    const { queue, tick } = makeQueue();
    const invites = [];
    queue.onInvite = (payload) => {
      invites.push(payload);
      return true;
    };
    queue.start();

    enqueuePlayer(queue, {
      playerId: "A",
      socketId: "SA",
      gameMode: GAME_MODE.STANDARD,
      skillMode: SKILL_MODE.OFF,
      hasSkillLoadout: false,
    });
    enqueuePlayer(queue, {
      playerId: "B",
      socketId: "SB",
      gameMode: GAME_MODE.OVERDRIVE,
      skillMode: SKILL_MODE.OFF,
      hasSkillLoadout: false,
    });
    tick(CROSS_WAIT_MS + 1);
    queue.scan();
    expect(invites.length).toBeGreaterThanOrEqual(1);
    queue.declineInvite(invites[0].inviteId, invites[0].invitee.playerId);
    if (invites[1]) {
      queue.declineInvite(invites[1].inviteId, invites[1].invitee.playerId);
    } else {
      queue.scan();
      if (invites[1]) {
        queue.declineInvite(invites[1].inviteId, invites[1].invitee.playerId);
      }
    }

    const before = invites.length;
    enqueuePlayer(queue, {
      playerId: "C",
      socketId: "SC",
      gameMode: GAME_MODE.OVERDRIVE,
      skillMode: SKILL_MODE.ABYSS,
      hasSkillLoadout: true,
    });
    tick(CROSS_WAIT_MS + 1);
    queue.scan();
    queue.scan();

    expect(invites.length).toBe(before);
    expect(queue.getEntryByPlayerId("A").sessionCrossInvitesInvolved).toBeGreaterThanOrEqual(2);
    queue.stop();
  });

  test("邀请投递失败时计次并结束/推进，不死循环", () => {
    const { queue, tick } = makeQueue();
    let calls = 0;
    queue.onInvite = () => {
      calls += 1;
      return false;
    };
    queue.start();

    enqueuePlayer(queue, {
      playerId: "A",
      socketId: "SA",
      gameMode: GAME_MODE.STANDARD,
      skillMode: SKILL_MODE.OFF,
    });
    enqueuePlayer(queue, {
      playerId: "B",
      socketId: "SB",
      gameMode: GAME_MODE.OVERDRIVE,
      skillMode: SKILL_MODE.OFF,
    });
    tick(CROSS_WAIT_MS + 1);
    queue.scan();

    expect(calls).toBeLessThanOrEqual(2);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(queue.pendingInvite).toBeNull();
    expect(queue.activePairFlow).toBeNull();
    queue.stop();
  });

  test("pairKeyInvolvesPlayer 不误伤子串 playerId", () => {
    expect(pairKeyInvolvesPlayer("AB\x1fCD", "A")).toBe(false);
    expect(pairKeyInvolvesPlayer("AB\x1fCD", "AB")).toBe(true);
    expect(pairKeyInvolvesPlayer("AB\x1fCD", "CD")).toBe(true);
  });

  test("成局回滚可重新入队", () => {
    const { queue } = makeQueue();
    const matches = [];
    queue.onMatch = (a, b) => {
      matches.push([a.playerId, b.playerId]);
      queue.reinsertEntry(a);
      queue.reinsertEntry(b);
    };
    queue.start();
    enqueuePlayer(queue, { playerId: "P1", socketId: "S1" });
    enqueuePlayer(queue, { playerId: "P2", socketId: "S2" });
    queue.scan();
    expect(matches).toHaveLength(1);
    expect(queue.isQueued("P1")).toBe(true);
    expect(queue.isQueued("P2")).toBe(true);
    queue.stop();
  });

  test("B 拒绝后不再邀 A", () => {
    const { queue, tick } = makeQueue();
    const invites = [];
    queue.onInvite = (payload) => invites.push(payload);
    queue.start();

    enqueuePlayer(queue, {
      playerId: "A",
      socketId: "SA",
      gameMode: GAME_MODE.STANDARD,
      skillMode: SKILL_MODE.OFF,
      hasSkillLoadout: false,
    });
    enqueuePlayer(queue, {
      playerId: "B",
      socketId: "SB",
      gameMode: GAME_MODE.OVERDRIVE,
      skillMode: SKILL_MODE.ABYSS,
      hasSkillLoadout: true,
    });
    tick(CROSS_WAIT_MS + 1);
    queue.scan();
    queue.declineInvite(invites[0].inviteId, "B");
    queue.scan();

    expect(invites).toHaveLength(1);
    expect(queue.activePairFlow).toBeNull();
    queue.stop();
  });

  test("laneKey 规范化赛道", () => {
    expect(laneKey(" OVERDRIVE ", " ABYSS ")).toBe(`${GAME_MODE.OVERDRIVE}:${SKILL_MODE.ABYSS}`);
  });
});

describe("matchmakingQueue timers", () => {
  test("60s 会话超时", () => {
    jest.useFakeTimers();
    const queue = new MatchmakingQueue();
    const timeouts = [];
    queue.onSessionTimeout = (entry) => timeouts.push(entry.playerId);
    queue.start();
    enqueuePlayer(queue, { playerId: "P1", socketId: "S1" });
    jest.advanceTimersByTime(SESSION_MS);
    expect(timeouts).toEqual(["P1"]);
    queue.stop();
    jest.useRealTimers();
  });
});
