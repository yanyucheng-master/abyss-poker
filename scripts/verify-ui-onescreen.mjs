import { chromium } from "playwright";
import playwrightRuntime from "./playwright-runtime.js";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3002";

async function fit(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const dock = document.querySelector(".action-dock");
    const join = document.getElementById("btn-join");
    const save = document.getElementById("btn-save-loadout");
    const waitPwd = document.getElementById("btn-set-room-password");
    const visible = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.bottom <= window.innerHeight + 2 && r.top >= -2 && r.height > 0;
    };
    return {
      needsScroll: de.scrollHeight > de.clientHeight + 1,
      scrollHeight: de.scrollHeight,
      clientHeight: de.clientHeight,
      bodyOverflow: getComputedStyle(document.body).overflowY,
      dockVisible: visible(dock),
      joinVisible: visible(join),
      saveVisible: visible(save),
      waitPwdVisible: visible(waitPwd),
      active: ["screen-auth", "screen-wait", "screen-game", "screen-skill-lab"].find((id) =>
        document.getElementById(id)?.classList.contains("active")
      ),
    };
  });
}

async function clickProtocol(page, gameMode, skillMode, action) {
  await page.evaluate(
    ({ gameMode, skillMode, action }) => {
      const card = document.querySelector(
        `.protocol-card[data-game-mode="${gameMode}"][data-skill-mode="${skillMode}"]`
      );
      const btn = card?.querySelector(`.protocol-btn[data-room-action="${action}"]`);
      if (!btn) throw new Error("protocol button missing");
      btn.click();
    },
    { gameMode, skillMode, action }
  );
}

async function main() {
  const browser = await chromium.launch(playwrightRuntime.chromiumLaunchOptions({ headless: true }));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const report = [];

  await page.goto(BASE + "/?verify=1", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem(
      "abyss_skill_loadout_v1",
      JSON.stringify(["ABYSS_BREATH", "EMBER_RECYCLE"])
    );
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  const lobbyFields = await page.evaluate(() => ({
    hasCreatePwd: Boolean(document.getElementById("input-password")),
    hasJoinPwd: Boolean(document.getElementById("input-join-password")),
    hasName: Boolean(document.getElementById("input-name")),
    hasRoom: Boolean(document.getElementById("input-room")),
    hasPwdModal: Boolean(document.getElementById("join-password-modal")),
    hasWaitPwd: Boolean(document.getElementById("input-wait-password")),
    status: document.getElementById("skill-prep-status")?.textContent || "",
  }));
  report.push({ step: "lobby", lobbyFields, lobbyFit: await fit(page) });

  await page.click("#btn-open-skill-lab");
  await page.waitForSelector("#screen-skill-lab.active", { timeout: 5000 });
  await page.waitForTimeout(700);
  const lab = await page.evaluate(() => ({
    active: document.getElementById("screen-skill-lab")?.classList.contains("active"),
    cards: document.querySelectorAll("#skill-lab-catalog .skill-card").length,
  }));
  report.push({ step: "skill-lab", lab, labFit: await fit(page) });
  await page.click("#btn-back-skill-lab");
  await page.waitForSelector("#screen-auth.active");

  await clickProtocol(page, "standard", "off", "create");
  await page.waitForSelector("#screen-wait.active", { timeout: 8000 });
  await page.waitForTimeout(500);
  const wait = await page.evaluate(() => ({
    active: document.getElementById("screen-wait")?.classList.contains("active"),
    roomId: document.getElementById("wait-room-id")?.textContent || "",
    pwdPanelHidden: document.getElementById("wait-password-panel")?.classList.contains("hidden"),
    pwdStatus: document.getElementById("wait-password-status")?.textContent || "",
  }));
  report.push({ step: "wait-create", wait, waitFit: await fit(page) });

  if (!wait.pwdPanelHidden) {
    await page.fill("#input-wait-password", "secret1");
    await page.click("#btn-set-room-password");
    await page.waitForTimeout(500);
    report.push({
      step: "set-password",
      pwdUpdated: await page.evaluate(
        () => document.getElementById("wait-password-status")?.textContent || ""
      ),
    });
  }

  await page.click("#btn-back-wait");
  await page.waitForSelector("#screen-auth.active");
  await page.waitForTimeout(300);

  await clickProtocol(page, "standard", "abyss", "solo");
  await page.waitForSelector("#screen-game.active", { timeout: 10000 });
  await page.waitForTimeout(1200);
  const game = await page.evaluate(() => ({
    active: document.getElementById("screen-game")?.classList.contains("active"),
    phase: document.getElementById("phase-text")?.textContent || "",
    skills: [...document.querySelectorAll("#skill-bar .skill-use-btn")].map((b) =>
      b.textContent.trim()
    ),
    energy: document.getElementById("self-energy")?.textContent || "",
    hudHidden: document.getElementById("skill-hud")?.classList.contains("hidden"),
  }));
  report.push({ step: "abyss-solo", game, gameFit: await fit(page) });

  const acted = await page.evaluate(() => {
    const check = document.querySelector('[data-action="check"]');
    const call = document.querySelector('[data-action="call"]');
    if (check && !check.disabled) {
      check.click();
      return "check";
    }
    if (call && !call.disabled) {
      call.click();
      return "call";
    }
    return "none";
  });
  await page.waitForTimeout(900);
  report.push({
    step: "action",
    acted,
    after: await page.evaluate(() => ({
      phase: document.getElementById("phase-text")?.textContent || "",
      pot: document.getElementById("pot-value")?.textContent || "",
    })),
  });

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(BASE + "/?mobile=1", { waitUntil: "networkidle" });
  await mobilePage.waitForSelector("#screen-auth.active", { timeout: 5000 });
  await mobilePage.waitForTimeout(400);
  report.push({ step: "mobile-lobby", mobileLobby: await fit(mobilePage) });
  await mobileContext.close();

  await browser.close();

  const failures = [];
  const lobbyFit = report.find((r) => r.step === "lobby")?.lobbyFit;
  const labFit = report.find((r) => r.step === "skill-lab")?.labFit;
  const waitFit = report.find((r) => r.step === "wait-create")?.waitFit;
  const gameFit = report.find((r) => r.step === "abyss-solo")?.gameFit;
  const mobileLobby = report.find((r) => r.step === "mobile-lobby")?.mobileLobby;
  const setPwd = report.find((r) => r.step === "set-password");

  if (lobbyFields.hasCreatePwd || lobbyFields.hasJoinPwd) failures.push("lobby still has password fields");
  if (!lobbyFields.hasName || !lobbyFields.hasRoom || !lobbyFields.hasPwdModal || !lobbyFields.hasWaitPwd) {
    failures.push("missing required lobby/wait/modal controls");
  }
  if (lobbyFit?.needsScroll) failures.push("lobby scrolls");
  if (!lab.active || lab.cards < 8) failures.push("skill lab incomplete");
  if (labFit?.needsScroll && labFit?.bodyOverflow !== "hidden") failures.push("skill lab page scrolls");
  if (!wait.active || !wait.roomId || wait.roomId === "——") failures.push("wait screen failed");
  if (waitFit?.needsScroll) failures.push("wait screen scrolls");
  if (setPwd && setPwd.pwdUpdated !== "已设置") failures.push("password set failed");
  if (!game.active || game.hudHidden || game.skills.length < 2) failures.push("abyss solo skills missing");
  if (gameFit?.needsScroll || gameFit?.dockVisible === false) failures.push("game screen overflow");
  if (mobileLobby?.active !== "screen-auth") failures.push("mobile lobby assertion ran on the wrong screen");
  if (mobileLobby?.needsScroll) failures.push("mobile lobby scrolls");

  console.log(JSON.stringify({ ok: failures.length === 0, failures, report }, null, 2));
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
