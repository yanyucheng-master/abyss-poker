#!/usr/bin/env node
/**
 * Skill solo battle smoke: configure loadout → start abyss solo → act / use skill.
 */
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3002";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const notes = [];

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#screen-auth.active");

  await page.click("#btn-open-skill-lab");
  await page.waitForSelector("#skill-lab-catalog .skill-card");
  await page.click("#btn-clear-loadout");
  const cards = page.locator("#skill-lab-catalog .skill-card");
  const n = await cards.count();
  for (let i = 0; i < Math.min(n, 6); i++) {
    if (!(await page.locator("#btn-save-loadout").isDisabled())) break;
    await cards.nth(i).click({ force: true });
  }
  await page.click("#btn-save-loadout", { force: true });
  await page.waitForSelector("#screen-auth.active");
  notes.push("loadout-saved");

  await page.evaluate(() => {
    document
      .querySelector(
        '.protocol-card[data-game-mode="standard"][data-skill-mode="abyss"] .protocol-btn[data-room-action="solo"]'
      )
      ?.click();
  });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const active = await page.evaluate(() =>
      document.getElementById("screen-game")?.classList.contains("active")
    );
    if (active) break;
    await page.evaluate(() => {
      const confirm = document.getElementById("btn-confirm-loadout");
      if (confirm && !confirm.disabled) confirm.click();
    });
    await page.waitForTimeout(200);
  }

  if (!(await page.locator("#screen-game.active").count())) {
    console.log(JSON.stringify({ ok: false, error: "game not started", notes }, null, 2));
    process.exit(1);
  }
  notes.push("game-started");

  await page.waitForTimeout(800);
  const before = await page.evaluate(() => ({
    phase: document.getElementById("phase-text")?.textContent,
    energy: document.getElementById("self-energy")?.textContent,
    skills: [...document.querySelectorAll("#skill-bar .skill-use-btn, #skill-bar button")].map((b) => ({
      text: b.textContent.trim(),
      disabled: b.disabled,
    })),
    actions: [...document.querySelectorAll(".primary-actions button, #btn-raise")].map((b) => ({
      action: b.dataset.action || b.id,
      disabled: b.disabled,
      text: b.textContent.trim().replace(/\s+/g, " "),
    })),
    needsScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
  }));
  notes.push(before);

  // Try using first enabled skill
  const usedSkill = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("#skill-bar .skill-use-btn, #skill-bar button")].find((b) => !b.disabled);
    if (!btn) return null;
    btn.click();
    return btn.textContent.trim();
  });
  if (usedSkill) {
    notes.push({ usedSkill });
    await page.waitForTimeout(600);
  }

  // Take a betting action if available
  const acted = await page.evaluate(() => {
    const order = ["check", "call", "fold"];
    for (const a of order) {
      const btn = document.querySelector(`button[data-action="${a}"]`);
      if (btn && !btn.disabled) {
        btn.click();
        return a;
      }
    }
    return null;
  });
  notes.push({ acted });
  await page.waitForTimeout(1200);

  const after = await page.evaluate(() => ({
    phase: document.getElementById("phase-text")?.textContent,
    energy: document.getElementById("self-energy")?.textContent,
    log: document.getElementById("action-log")?.textContent,
    needsScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    dockInView: (() => {
      const d = document.querySelector(".action-dock");
      const r = d.getBoundingClientRect();
      return r.bottom <= innerHeight + 1 && r.top >= -1;
    })(),
  }));

  const ok = !after.needsScroll && after.dockInView && Boolean(before.phase);
  console.log(JSON.stringify({ ok, before, usedSkill, acted, after, notes }, null, 2));
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
