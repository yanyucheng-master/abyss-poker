const { GAME_MODE } = require("../game/gameModes");
const { SKILL_MODE } = require("../game/skillModes");
const { SKILL_CONFIG } = require("../game/skillConfig");
const { RoomManager } = require("../game/roomManager");
const { GameEngine } = require("../game/gameEngine");
const { createDeck } = require("../utils/deck");
const {
  beginHandSkills,
  setPlayerLoadout,
  LOAN_CREDIT,
  getLoanCreditState,
  getLoanQuota,
} = require("../game/skills/skillEngine");
const logger = require("../utils/logger");
const eventBus = require("../utils/eventBus");

function makeIoStub() {
  const emits = [];
  return {
    emits,
    to: (target) => ({ emit: (event, payload) => emits.push({ target, event, payload }) }),
  };
}

function setupRoom({
  loadoutA = ["LOAN", "FAIRNESS"],
  loadoutB = ["DEFENSE", "RECYCLE"],
  v2,
} = {}) {
  const io = makeIoStub();
  const roomManager = new RoomManager({ logger, eventBus });
  const engine = new GameEngine({ io, roomManager, logger, eventBus, deckFactory: createDeck });
  if (v2 !== undefined) engine.skillEngine.experiment.loanCreditRestrictionV2 = Boolean(v2);
  const room = roomManager.createRoom(null, GAME_MODE.STANDARD, SKILL_MODE.ABYSS);
  const a = roomManager.joinRoom({ roomId: room.roomId, playerName: "A", playerId: "PA", socketId: "s1" }).player;
  const b = roomManager.joinRoom({ roomId: room.roomId, playerName: "B", playerId: "PB", socketId: "s2" }).player;
  expect(setPlayerLoadout(a, loadoutA).ok).toBe(true);
  expect(setPlayerLoadout(b, loadoutB).ok).toBe(true);
  engine.startHand(room);
  engine.clearActionTimer(room);
  a.skillRuntime.abyssEnergy = 8;
  return { io, engine, room, a, b };
}

function use(engine, room, player, skillId, target = {}, requestId = `${skillId}-${Math.random()}`) {
  room.currentPlayerIndex = room.players.findIndex((item) => item.playerId === player.playerId);
  room.phase = "pre_flop";
  player.isAllIn = false;
  return engine.handleSkillUse(room, player, { skillId, target, requestId });
}

function nextHand(engine, room) {
  room.handNo = (Number(room.handNo) || 0) + 1;
  room.phase = "pre_flop";
  room.players.forEach((player) => {
    player.status = "active";
    player.isAllIn = false;
  });
  beginHandSkills(room);
  engine.clearActionTimer(room);
}

function credit(player) {
  return getLoanCreditState(player.skillRuntime);
}

describe("Loan Credit Restriction V2", () => {
  test("生产默认启用信用受限", () => {
    const { engine } = setupRoom();
    expect(engine.skillEngine.experiment.loanCreditRestrictionV2).toBe(true);
    expect(engine.skillEngine.creditRestrictionOn()).toBe(true);
  });

  test("显式关闭开关时保持旧额度与洗债后仍可 2+1", () => {
    const { engine, room, a, b } = setupRoom({ v2: false });
    expect(engine.skillEngine.experiment.loanCreditRestrictionV2).toBe(false);
    expect(getLoanQuota(a.skillRuntime, { creditRestriction: false }).maxChip).toBe(2);
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "LOAN", { mode: "energy" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "FAIRNESS").status).toBe("SUCCESS");
    nextHand(engine, room);
    a.skillRuntime.abyssEnergy = 8;
    expect(credit(a)).toBe(LOAN_CREDIT.NORMAL);
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "LOAN", { mode: "energy" }).status).toBe("SUCCESS");
    expect(b.chips).toBeLessThan(1000);
  });

  test("CR01 NORMAL_CREDIT 同手允许 Chip×2 + Energy×1", () => {
    const { engine, room, a } = setupRoom();
    expect(credit(a)).toBe(LOAN_CREDIT.NORMAL);
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "LOAN", { mode: "energy" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).ok).toBe(false);
    expect(use(engine, room, a, "LOAN", { mode: "energy" }).ok).toBe(false);
  });

  test("CR02 Fairness 洗 pending debt 进入 RESTRICTED", () => {
    const { engine, room, a } = setupRoom();
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(a.skillRuntime.chipLoan.repay).toBe(150);
    expect(use(engine, room, a, "FAIRNESS").status).toBe("SUCCESS");
    expect(a.skillRuntime.chipLoan).toBeNull();
    expect(credit(a)).toBe(LOAN_CREDIT.RESTRICTED);
    expect(a.skillRuntime.loanCreditMetrics.washDebts).toBe(1);
  });

  test("CR03 / CR04 RESTRICTED 同手只能 Loan 1 次，不能 Energy+Chip", () => {
    const { engine, room, a } = setupRoom();
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "FAIRNESS").status).toBe("SUCCESS");
    nextHand(engine, room);
    a.skillRuntime.abyssEnergy = 8;
    expect(credit(a)).toBe(LOAN_CREDIT.RESTRICTED);
    expect(use(engine, room, a, "LOAN", { mode: "energy" }).status).toBe("SUCCESS");
    const secondChip = use(engine, room, a, "LOAN", { mode: "chip" });
    const secondEnergy = use(engine, room, a, "LOAN", { mode: "energy" });
    expect(secondChip.ok).toBe(false);
    expect(secondEnergy.ok).toBe(false);
    expect(a.skillRuntime.loanCreditMetrics.deniedByCredit).toBeGreaterThanOrEqual(1);
  });

  test("CR05 RESTRICTED 下借 1 次并全额真实偿还后恢复 NORMAL", () => {
    const { engine, room, a, b } = setupRoom();
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "FAIRNESS").status).toBe("SUCCESS");
    nextHand(engine, room);
    a.skillRuntime.abyssEnergy = 8;
    const chipsB = b.chips;
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(a.skillRuntime.chipLoans[0].originCredit).toBe(LOAN_CREDIT.RESTRICTED);
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    a.chips = 400;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(a.skillRuntime.chipLoan).toBeNull();
    expect(a.skillRuntime.chipDebt).toBe(0);
    expect(credit(a)).toBe(LOAN_CREDIT.NORMAL);
    expect(b.chips).toBe(chipsB + 50);
    nextHand(engine, room);
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "LOAN", { mode: "energy" }).status).toBe("SUCCESS");
  });

  test("CR06 部分真实偿还后 Fairness 清剩余，不得恢复 NORMAL", () => {
    const { engine, room, a } = setupRoom();
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "FAIRNESS").status).toBe("SUCCESS");
    nextHand(engine, room);
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "LOAN", { mode: "energy" }).status).toBe("SUCCESS");
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    a.skillRuntime.abyssEnergy = 3;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(a.skillRuntime.energyDebt).toBe(3);
    expect(credit(a)).toBe(LOAN_CREDIT.DEFAULTED);
    nextHand(engine, room);
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "FAIRNESS").status).toBe("SUCCESS");
    expect(a.skillRuntime.energyDebt).toBe(0);
    expect(credit(a)).toBe(LOAN_CREDIT.RESTRICTED);
  });

  test("CR07 / CR08 到期无法全额偿还进入 DEFAULTED 并禁止所有 Loan", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    expect(use(engine, room, a, "LOAN", { mode: "energy" }).status).toBe("SUCCESS");
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    a.skillRuntime.abyssEnergy = 2;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(a.skillRuntime.energyDebt).toBeGreaterThan(0);
    expect(credit(a)).toBe(LOAN_CREDIT.DEFAULTED);
    nextHand(engine, room);
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).ok).toBe(false);
    expect(use(engine, room, a, "LOAN", { mode: "energy" }).ok).toBe(false);
  });

  test("CR09 DEFAULTED residual 被真实全部还清后恢复 NORMAL", () => {
    const { engine, room, a, b } = setupRoom({ loadoutA: ["LOAN", "RECYCLE"], loadoutB: ["DEFENSE", "RECYCLE"] });
    expect(use(engine, room, a, "LOAN", { mode: "energy" }).status).toBe("SUCCESS");
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    a.skillRuntime.abyssEnergy = 0;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(credit(a)).toBe(LOAN_CREDIT.DEFAULTED);
    const debt = Number(a.skillRuntime.energyDebt) || 0;
    expect(debt).toBeGreaterThan(0);
    for (let i = 0; i < debt; i += 1) {
      engine.skillEngine.endHand(room, { reason: "fold", winner: b, tie: false });
    }
    expect(a.skillRuntime.energyDebt).toBe(0);
    expect(credit(a)).toBe(LOAN_CREDIT.NORMAL);
  });

  test("CR10 DEFAULTED residual 被 Fairness 清除后是 RESTRICTED 不是 NORMAL", () => {
    const { engine, room, a } = setupRoom();
    expect(use(engine, room, a, "LOAN", { mode: "energy" }).status).toBe("SUCCESS");
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    a.skillRuntime.abyssEnergy = 1;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(credit(a)).toBe(LOAN_CREDIT.DEFAULTED);
    nextHand(engine, room);
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "FAIRNESS").status).toBe("SUCCESS");
    expect(a.skillRuntime.energyDebt).toBe(0);
    expect(credit(a)).toBe(LOAN_CREDIT.RESTRICTED);
    expect(credit(a)).not.toBe(LOAN_CREDIT.NORMAL);
  });

  test("CR11 Counter 抓 Loan 不改变 creditState", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["LOAN", "FAIRNESS"],
      loadoutB: ["COUNTER", "RECYCLE"],
    });
    b.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, b, "COUNTER").status).toBe("SUCCESS");
    const before = credit(a);
    const result = use(engine, room, a, "LOAN", { mode: "chip" });
    expect(result.status).toBe("COUNTERED");
    expect(a.skillRuntime.chipLoan).toBeNull();
    expect(credit(a)).toBe(before);
    expect(credit(a)).toBe(LOAN_CREDIT.NORMAL);
  });

  test("CR12 Match End 清空信用，新 Match 为 NORMAL", () => {
    const { engine, room, a, b } = setupRoom();
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "FAIRNESS").status).toBe("SUCCESS");
    expect(credit(a)).toBe(LOAN_CREDIT.RESTRICTED);
    b.chips = 0;
    engine.skillEngine.endHand(room, { reason: "showdown", winner: a, tie: false });
    expect(a.skillRuntime.chipLoan).toBeNull();
    expect(a.skillRuntime.chipDebt).toBe(0);
    expect(credit(a)).toBe(LOAN_CREDIT.NORMAL);
  });

  test("CR13 Fairness 无 Loan 债务不得改变 creditState", () => {
    const { engine, room, a } = setupRoom({ loadoutA: ["FAIRNESS", "RECYCLE"], loadoutB: ["BLOOD_BATTLE", "DEFENSE"] });
    expect(credit(a)).toBe(LOAN_CREDIT.NORMAL);
    expect(use(engine, room, a, "FAIRNESS").status).toBe("SUCCESS");
    expect(credit(a)).toBe(LOAN_CREDIT.NORMAL);
  });

  test("CR14 多次 Fairness 清债不能洗回 NORMAL", () => {
    const { engine, room, a } = setupRoom();
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "FAIRNESS").status).toBe("SUCCESS");
    expect(credit(a)).toBe(LOAN_CREDIT.RESTRICTED);
    nextHand(engine, room);
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "FAIRNESS").status).toBe("SUCCESS");
    expect(credit(a)).toBe(LOAN_CREDIT.RESTRICTED);
    nextHand(engine, room);
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "LOAN", { mode: "energy" }).status).toBe("SUCCESS");
    expect(use(engine, room, a, "FAIRNESS").status).toBe("SUCCESS");
    expect(credit(a)).toBe(LOAN_CREDIT.RESTRICTED);
    expect(a.skillRuntime.loanCreditMetrics.restores).toBe(0);
  });

  test("回归：100/150、能量 +5/-6、Fairness 免疫 Counter、不回滚已转移筹码", () => {
    const { engine, room, a, b } = setupRoom({
      loadoutA: ["LOAN", "FAIRNESS"],
      loadoutB: ["COUNTER", "RECYCLE"],
    });
    expect(SKILL_CONFIG.LOAN_CHIP_TAKE).toBe(100);
    expect(SKILL_CONFIG.LOAN_CHIP_REPAY).toBe(150);
    expect(SKILL_CONFIG.LOAN_ENERGY_GAIN).toBe(5);
    expect(SKILL_CONFIG.LOAN_ENERGY_REPAY).toBe(6);
    const beforeB = b.chips;
    a.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, a, "LOAN", { mode: "chip" }).status).toBe("SUCCESS");
    expect(b.chips).toBe(beforeB - 100);
    b.skillRuntime.abyssEnergy = 8;
    expect(use(engine, room, b, "COUNTER").status).toBe("SUCCESS");
    expect(use(engine, room, a, "FAIRNESS").status).toBe("SUCCESS");
    expect(b.chips).toBe(beforeB - 100);
    expect(a.skillRuntime.chipLoan).toBeNull();
    expect(room.skillState.fairnessActive).toBe(true);
  });
});
