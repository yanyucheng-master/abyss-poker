const {
  getMinRaiseTo,
  getValidActions,
  collectBet,
  isStreetComplete,
} = require("../game/pokerLogic");

function mockRoom() {
  return {
    bigBlind: 50,
    currentBet: 50,
    lastRaiseSize: 50,
    pot: 0,
    players: [
      {
        playerId: "P1",
        chips: 1000,
        streetBet: 25,
        totalBet: 25,
        status: "active",
        isAllIn: false,
        hasActed: false,
      },
      {
        playerId: "P2",
        chips: 1000,
        streetBet: 50,
        totalBet: 50,
        status: "active",
        isAllIn: false,
        hasActed: false,
      },
    ],
  };
}

describe("pokerLogic", () => {
  test("标准最小加注额计算", () => {
    const room = mockRoom();
    expect(getMinRaiseTo(room)).toBe(100);
  });

  test("collectBet 更新筹码和底池", () => {
    const room = mockRoom();
    const paid = collectBet(room, room.players[0], 30);
    expect(paid).toBe(30);
    expect(room.players[0].chips).toBe(970);
    expect(room.pot).toBe(30);
  });

  test("有效动作包含 call/raise/allin", () => {
    const room = mockRoom();
    const turn = getValidActions(room, 0);
    expect(turn.validActions).toContain("call");
    expect(turn.validActions).toContain("raise");
    expect(turn.validActions).toContain("allin");
  });

  test("面对对手全押时不提供非法加注窗口，但允许跟注/全押", () => {
    const room = mockRoom();
    room.currentBet = 1000;
    room.lastRaiseSize = 679;
    room.players[0].streetBet = 729;
    room.players[0].chips = 271;
    room.players[1].streetBet = 1000;
    room.players[1].chips = 0;
    room.players[1].isAllIn = true;

    const turn = getValidActions(room, 0);
    expect(turn.toCall).toBe(271);
    expect(turn.validActions).toEqual(expect.arrayContaining(["fold", "call", "allin"]));
    expect(turn.validActions).not.toContain("raise");
    expect(turn.minRaiseTo).toBe(0);
    expect(turn.maxTotalBet).toBe(0);
  });

  test("短码无法满足最小加注时仍可全押，且不加注窗口", () => {
    const room = mockRoom();
    room.currentBet = 200;
    room.lastRaiseSize = 150;
    room.players[0].streetBet = 50;
    room.players[0].chips = 80;
    room.players[1].streetBet = 200;
    room.players[1].chips = 800;

    const turn = getValidActions(room, 0);
    expect(turn.validActions).toContain("call");
    expect(turn.validActions).toContain("allin");
    expect(turn.validActions).not.toContain("raise");
    expect(turn.minRaiseTo).toBe(0);
    expect(turn.maxTotalBet).toBe(0);
  });

  test("街结束判断", () => {
    const room = mockRoom();
    room.players[0].streetBet = 50;
    room.players[0].hasActed = true;
    room.players[1].hasActed = true;
    expect(isStreetComplete(room)).toBe(true);
  });
});
