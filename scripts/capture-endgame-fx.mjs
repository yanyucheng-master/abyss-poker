import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { chromiumLaunchOptions } = require("./playwright-runtime.js");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3002";
const OUTPUT = path.resolve("docs/endgame-fx-review");

const DECLARE_FRAMES = [
  { file: "01-declare-bars.png", ms: 180, label: "电影黑边压入" },
  { file: "02-declare-seal.png", ms: 500, label: "法阵砸入 + 「终」字" },
  { file: "03-declare-lockup.png", ms: 1100, label: "「终局」落定 + 副标题" },
  { file: "04-declare-hold.png", ms: 1800, label: "法阵持场" },
];

const EXECUTION_DECLARE_FRAMES = [
  { file: "05-declare-execution.png", ms: 1200, label: "处决模式猩红变体" },
];

const KILL_FRAMES = [
  { file: "06-kill-whiteout.png", ms: 80, label: "白闪开场" },
  { file: "07-kill-slash.png", ms: 320, label: "刀光横扫" },
  { file: "08-kill-split.png", ms: 700, label: "屏幕一刀两断" },
  { file: "09-kill-char.png", ms: 950, label: "「斩」字砸入" },
  { file: "10-kill-lockup.png", ms: 1500, label: "「斩杀」落定" },
  { file: "11-kill-hold.png", ms: 2100, label: "处决持场" },
];

async function freezeOverlay(page, selector, ms, extras = {}) {
  await page.evaluate(
    ({ selector, ms, extras }) => {
      const hide = (id) => document.getElementById(id)?.classList.add("hidden");
      hide("flash-endgame-declare");
      hide("flash-endgame-kill");
      hide("flash-allin");
      const fx = document.querySelector(selector);
      if (!fx) throw new Error(`missing ${selector}`);
      if (extras.mode) fx.dataset.mode = extras.mode;
      fx.classList.remove("hidden");
      void fx.offsetWidth;
      fx.getAnimations({ subtree: true }).forEach((animation) => {
        try {
          animation.pause();
          animation.currentTime = ms;
        } catch (_error) {
          // Some infinite animations reject a seek past their local timeline.
        }
      });
    },
    { selector, ms, extras }
  );
  await page.waitForTimeout(40);
}

async function capture(page, frames, selector, extras = {}) {
  for (const frame of frames) {
    await freezeOverlay(page, selector, frame.ms, extras);
    await page.screenshot({
      path: path.join(OUTPUT, frame.file),
      type: "png",
    });
  }
}

async function main() {
  await fs.mkdir(OUTPUT, { recursive: true });
  const browser = await chromium.launch({
    ...chromiumLaunchOptions({ headless: true }),
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("overlimit_quickstart_v1", "seen");
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    document.body.classList.add("reduce-motion");
    document.body.classList.remove("reduce-motion");
    const shell = document.querySelector(".app-shell");
    if (shell) shell.style.visibility = "hidden";
    const settings = document.getElementById("btn-settings");
    if (settings) settings.style.visibility = "hidden";
    document.body.style.background = "#050308";
  });

  await capture(page, DECLARE_FRAMES, "#flash-endgame-declare", {
    mode: "declare",
  });
  await capture(page, EXECUTION_DECLARE_FRAMES, "#flash-endgame-declare", {
    mode: "execution",
  });
  await capture(page, KILL_FRAMES, "#flash-endgame-kill");

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.addInitScript(() => {
    localStorage.setItem("overlimit_quickstart_v1", "seen");
  });
  await mobilePage.goto(BASE, { waitUntil: "networkidle" });
  await mobilePage.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    if (shell) shell.style.visibility = "hidden";
    const settings = document.getElementById("btn-settings");
    if (settings) settings.style.visibility = "hidden";
    document.body.style.background = "#050308";
  });
  await freezeOverlay(mobilePage, "#flash-endgame-declare", 1100, {
    mode: "declare",
  });
  await mobilePage.screenshot({ path: path.join(OUTPUT, "12-mobile-declare.png"), type: "png" });
  await freezeOverlay(mobilePage, "#flash-endgame-kill", 1500);
  await mobilePage.screenshot({ path: path.join(OUTPUT, "13-mobile-kill.png"), type: "png" });

  const index = [
    ...DECLARE_FRAMES,
    ...EXECUTION_DECLARE_FRAMES,
    ...KILL_FRAMES,
    { file: "12-mobile-declare.png", ms: 1100, label: "手机竖屏 · 终局落定" },
    { file: "13-mobile-kill.png", ms: 1500, label: "手机竖屏 · 斩杀落定" },
  ];
  await fs.writeFile(
    path.join(OUTPUT, "index.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), frames: index }, null, 2)
  );

  await context.close();
  await mobile.close();
  await browser.close();
  console.log(`saved ${index.length} frames to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
