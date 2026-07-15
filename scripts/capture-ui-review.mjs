import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import playwrightRuntime from "./playwright-runtime.js";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3002";
const OUTPUT = path.resolve(process.env.UI_REVIEW_DIR || "artifacts/ui-review");
const LOADOUT = ["ABYSS_BREATH", "EMBER_RECYCLE", "ADVERSITY_CIRCUIT", "ECHO_SCAN"];

async function primeLoadout(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate((loadout) => {
    localStorage.setItem("abyss_skill_loadout_v1", JSON.stringify(loadout));
  }, LOADOUT);
  await page.reload({ waitUntil: "networkidle" });
}

async function captureDesktop(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await primeLoadout(page);
  await page.screenshot({ path: path.join(OUTPUT, "desktop-lobby.png"), fullPage: true });

  await page.click("#btn-settings");
  await page.screenshot({ path: path.join(OUTPUT, "desktop-settings.png"), fullPage: true });
  await page.click("#btn-close-settings");

  await page.click("#btn-open-skill-lab");
  await page.waitForSelector("#screen-skill-lab.active");
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUTPUT, "desktop-skill-lab.png"), fullPage: true });

  await page.click("#btn-back-skill-lab");
  await page.waitForSelector("#screen-auth.active");
  await page.evaluate(() => {
    document
      .querySelector(
        '.protocol-card[data-game-mode="standard"][data-skill-mode="off"] .protocol-btn[data-room-action="create"]'
      )
      ?.click();
  });
  await page.waitForSelector("#screen-wait.active", { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUTPUT, "desktop-wait.png"), fullPage: true });
  await page.click("#btn-back-wait");
  await page.waitForSelector("#screen-auth.active");
  await page.evaluate(() => {
    document
      .querySelector(
        '.protocol-card[data-game-mode="standard"][data-skill-mode="abyss"] .protocol-btn[data-room-action="solo"]'
      )
      ?.click();
  });
  await page.waitForSelector("#screen-game.active", { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUTPUT, "desktop-game.png"), fullPage: true });
  await page.click("#btn-settings");
  await page.screenshot({ path: path.join(OUTPUT, "desktop-game-settings.png"), fullPage: true });
  await context.close();
}

async function captureMobile(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await primeLoadout(page);
  await page.screenshot({ path: path.join(OUTPUT, "mobile-lobby.png"), fullPage: true });

  await page.click("#btn-settings");
  await page.screenshot({ path: path.join(OUTPUT, "mobile-settings.png"), fullPage: true });
  await page.click("#btn-close-settings");

  await page.click("#btn-open-skill-lab");
  await page.waitForSelector("#screen-skill-lab.active");
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUTPUT, "mobile-skill-lab.png"), fullPage: true });
  await page.click("#btn-back-skill-lab");
  await page.waitForSelector("#screen-auth.active");

  await page.evaluate(() => {
    document
      .querySelector(
        '.protocol-card[data-game-mode="standard"][data-skill-mode="off"] .protocol-btn[data-room-action="create"]'
      )
      ?.click();
  });
  await page.waitForSelector("#screen-wait.active", { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUTPUT, "mobile-wait.png"), fullPage: true });
  await page.click("#btn-back-wait");
  await page.waitForSelector("#screen-auth.active");

  await page.evaluate(() => {
    document
      .querySelector(
        '.protocol-card[data-game-mode="overdrive"][data-skill-mode="abyss"] .protocol-btn[data-room-action="solo"]'
      )
      ?.click();
  });
  await page.waitForSelector("#screen-game.active", { timeout: 20000 });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: path.join(OUTPUT, "mobile-game.png"), fullPage: true });
  await page.click("#btn-settings");
  await page.screenshot({ path: path.join(OUTPUT, "mobile-game-settings.png"), fullPage: true });
  await context.close();
}

async function captureCompactGame(browser, width, height, filename) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await primeLoadout(page);
  await page.evaluate(() => {
    document
      .querySelector(
        '.protocol-card[data-game-mode="standard"][data-skill-mode="abyss"] .protocol-btn[data-room-action="solo"]'
      )
      ?.click();
  });
  await page.waitForSelector("#screen-game.active", { timeout: 20000 });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: path.join(OUTPUT, filename), fullPage: true });
  await context.close();
}

await fs.mkdir(OUTPUT, { recursive: true });
const browser = await chromium.launch(playwrightRuntime.chromiumLaunchOptions({ headless: true }));
try {
  await captureDesktop(browser);
  await captureMobile(browser);
  await captureCompactGame(browser, 375, 667, "mobile-short-game.png");
  await captureCompactGame(browser, 320, 568, "mobile-compact-game.png");
  console.log(OUTPUT);
} finally {
  await browser.close();
}
