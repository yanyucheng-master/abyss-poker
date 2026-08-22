"use strict";

const rulebook = require("../public/rulebook-data");
const { listSkillDefinitions } = require("../game/skills/definitions");
const { SKILL_CONFIG } = require("../game/skillConfig");
const { HAND_RANK_BONUS } = require("../game/handRankBonus");
const {
  INITIAL_STACK,
  MATCH_TOTAL_CHIPS,
  SMALL_BLIND,
  BIG_BLIND,
} = require("../game/chipEconomy");

function textOf(value) {
  return JSON.stringify(value);
}

describe("官方规则手册 V1.0", () => {
  test("采用 18 章、24 个主体技能与 9 个协议的结构化数据", () => {
    expect(rulebook.version).toBe("1.0");
    expect(rulebook.sections).toHaveLength(18);
    expect(rulebook.skills).toHaveLength(24);
    expect(rulebook.protocols).toHaveLength(9);
    expect(rulebook.sections.map((section) => section.number)).toEqual(
      Array.from({ length: 18 }, (_, index) => String(index + 1).padStart(2, "0"))
    );
    expect(new Set(rulebook.sections.map((section) => section.id)).size).toBe(18);
    expect(new Set(rulebook.skills.map((skill) => skill.id)).size).toBe(24);
    expect(new Set(rulebook.protocols.map((protocol) => protocol.id)).size).toBe(9);
  });

  test("基础参数与现行权威常量一致", () => {
    const copy = textOf(rulebook.sections);
    expect(INITIAL_STACK).toBe(1000);
    expect(MATCH_TOTAL_CHIPS).toBe(2000);
    expect(SMALL_BLIND).toBe(25);
    expect(BIG_BLIND).toBe(50);
    expect(SKILL_CONFIG.INITIAL_ABYSS_ENERGY).toBe(4);
    expect(SKILL_CONFIG.MAX_ABYSS_ENERGY).toBe(8);
    expect(SKILL_CONFIG.DESTINY_MAX_ABYSS_ENERGY).toBe(10);
    expect(SKILL_CONFIG.MIN_FORTUNE_ENERGY).toBe(-4);
    ["1000", "2000", "25 / 50", "1～4", "不超过 8", "-4"].forEach((value) => {
      expect(copy).toContain(value);
    });
  });

  test("牌型基础奖励完整并与代码一致", () => {
    expect(HAND_RANK_BONUS).toEqual({
      HIGH_CARD: 0,
      ONE_PAIR: 0,
      TWO_PAIR: 0,
      THREE_OF_A_KIND: 25,
      STRAIGHT: 50,
      FLUSH: 75,
      FULL_HOUSE: 100,
      FOUR_OF_A_KIND: 250,
      STRAIGHT_FLUSH: 400,
      ROYAL_FLUSH: 500,
    });
    const bonus = rulebook.sections.find((section) => section.id === "rule-bonus");
    const copy = textOf(bonus);
    ["+0", "+25", "+50", "+75", "+100", "+250", "+400", "+500"].forEach((value) => {
      expect(copy).toContain(value);
    });
    ["摊牌产生唯一胜者", "普通弃牌", "撤退弃牌", "平局", "不会增加全场筹码总量"].forEach((value) => {
      expect(copy).toContain(value);
    });
  });

  test("主体技能名称和负载逐项对齐现行技能定义", () => {
    const definitions = listSkillDefinitions().filter((skill) => !skill.id.startsWith("PROTOCOL_"));
    expect(definitions).toHaveLength(24);
    expect(rulebook.skills.map((skill) => skill.name)).toEqual(definitions.map((skill) => skill.name));
    definitions.forEach((definition, index) => {
      const entry = rulebook.skills[index];
      expect(entry.meta.join(" ")).toContain(`负载 ${definition.load}`);
    });
  });

  test("关键冻结数值与现行技能规则一致", () => {
    const byName = Object.fromEntries(rulebook.skills.map((skill) => [skill.name, textOf(skill)]));
    expect(byName.感知).toMatch(/25%.*50%/);
    expect(byName.感知).toMatch(/75%.*25%/);
    expect(byName.感知).toContain("每手最多成功 3 次");
    expect(byName.强运).toContain("牌面改良 3");
    expect(byName.强运).toContain("-4");
    expect(byName.零化).toContain("公共牌 6 / 底牌 7");
    expect(byName.零化).toContain("尚未发出的公共牌位置");
    expect(byName.天命).toContain("真实能量上限由 8 提高至 10");
    expect(byName.贷款).toMatch(/100.*150/);
    expect(byName.贷款).toMatch(/获得 5.*偿还 6/);
    expect(byName.贷款).toContain("合计最多 3 次");
    expect(byName.撤退).toContain("同一行动窗口立即弃牌");
    expect(byName.绝路).toContain("负载 4");
    expect(byName.绝路).toContain("能量 5");
    expect(byName.绝路).toContain("普通弃牌");
    expect(byName.终局).toContain("能量 8");
    expect(byName.终局).toContain("等级完全相同");
    expect(byName.终局).toContain("皇家同花顺与普通同花顺属于不同等级");
  });

  test("协议名称与牌型归属逐项对齐现行定义", () => {
    const definitions = listSkillDefinitions().filter((skill) => skill.id.startsWith("PROTOCOL_"));
    expect(definitions).toHaveLength(9);
    expect(rulebook.protocols.map((protocol) => protocol.name)).toEqual(definitions.map((skill) => skill.name));
    expect(rulebook.protocols.at(-1).hand).toBe("同花顺、皇家同花顺");
  });

  test("全文搜索所需中文与英文术语均存在", () => {
    const copy = textOf(rulebook);
    [
      "弃牌", "全下", "能量", "贷款", "反制", "零化", "终局", "同花", "牌型基础奖励", "未匹配",
      "Fold", "All In", "Call", "Raise", "River", "Showdown", "Loan", "Endgame",
    ].forEach((term) => expect(copy).toContain(term));
  });

  test("玩家规则数据不包含开发字段或内部版本标记", () => {
    const copy = textOf(rulebook);
    [
      "FROZEN_V1",
      "soft-v1",
      "spec-25-50",
      "Loan Credit Restriction V2",
      "boardIndex",
      "deckIndex",
      "requestId",
      "skillRuntime",
      "private payload",
      "clamp(",
      "NORMAL_CREDIT",
      "RESTRICTED_CREDIT",
      "DEFAULTED",
    ].forEach((term) => expect(copy).not.toContain(term));
  });
});
