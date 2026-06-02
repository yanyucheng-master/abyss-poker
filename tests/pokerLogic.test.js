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

  test("街结束判断", () => {
    const room = mockRoom();
    room.players[0].streetBet = 50;
    room.players[0].hasActed = true;
    room.players[1].hasActed = true;
    expect(isStreetComplete(room)).toBe(true);
  });
});
