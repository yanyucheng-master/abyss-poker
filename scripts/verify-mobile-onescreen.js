#!/usr/bin/env node
/**
 * Mobile one-screen verification + skill solo smoke.
 */
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3002";
const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "375x667", width: 375, height: 667 },
];

const CRITICAL = {
  auth: [
    "#btn-open-skill-lab",
    "#btn-join",
    ".protocol-card[data-skill-mode='off'] .protocol-btn[data-room-action='solo']",
    ".protocol-card[data-skill-mode='abyss'] .protocol-btn[data-room-action='create']",
  ],
  skillLab: ["#btn-back-skill-lab", "#btn-save-loadout", "#btn-clear-loadout", "#skill-lab-catalog"],
  wait: ["#btn-back-wait", "#btn-copy-room", "#wait-room-id", "#btn-set-room-password"],
  game: [
    "#btn-back-game",
    ".action-dock",
    ".primary-actions",
    "button[data-action='fold']",
    "button[data-action='allin']",
    "#btn-raise",
    "#skill-hud",
  ],
};

async function measure(page, screenId, selectors) {
  return page.evaluate(
    ({ screenId, selectors }) => {
      const de = document.documentElement;
      const body = document.body;
      const screen = document.getElementById(screenId);
      const vh = window.innerHeight;
      const items = selectors.map((s) => {
        const el = document.querySelector(s);
        if (!el) return { s, exists: false, inView: false };
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          s,
          exists: true,
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          height: Math.round(r.height),
          inView: r.top >= -1 && r.bottom <= vh + 1 && r.height > 0 && r.width > 0,
          visible: style.display !== "none" && style.visibility !== "hidden",
        };
      });
      return {
        needsScroll: de.scrollHeight > de.clientHeight + 1 || body.scrollHeight > body.clientHeight + 1,
        doc: { scrollHeight: de.scrollHeight, clientHeight: de.clientHeight, vh },
        screen: screen
          ? {
              scrollHeight: screen.scrollHeight,
              clientHeight: screen.clientHeight,
              overflowY: getComputedStyle(screen).overflowY,
            }
          : null,
        items,
        activeScreen: ["screen-auth", "screen-skill-lab", "screen-wait", "screen-game"].find((id) =>
          document.getElementById(id)?.classList.contains("active")
        ),
      };
    },
    { screenId, selectors }
  );
}

async function showScreenOnly(page, key) {
  await page.evaluate(async (k) => {
    const map = {
      auth: "screen-auth",
      skillLab: "screen-skill-lab",
      wait: "screen-wait",
      game: "screen-game",
    };
    Object.values(map).forEach((id) => document.getElementById(id)?.classList.remove("active"));
    document.getElementById(map[k])?.classList.add("active");

    if (k === "skillLab") {
      const cat = document.getElementById("skill-lab-catalog");
      if (cat && cat.children.length < 8) {
        try {
          const res = await fetch("/api/skills");
          const data = await res.json();
          cat.textContent = "";
          (data.skills || []).forEach((skill) => {
            const card = document.createElement("button");
            card.type = "button";
            card.className = "skill-card";
            card.innerHTML = `<strong>${skill.name}</strong><small>负载 ${skill.load}</small><span>${skill.description}</span>`;
            cat.appendChild(card);
          });
        } catch (_e) {
          for (let i = 0; i < 10; i++) {
            const card = document.createElement("button");
            card.type = "button";
            card.className = "skill-card";
            card.innerHTML = `<strong>技能 ${i + 1}</strong><small>负载 2</small><span>布局压测描述</span>`;
            cat.appendChild(card);
          }
        }
      }
    }
    if (k === "wait") {
      const room = document.getElementById("wait-room-id");
      if (room) room.textContent = "A3B7K9";
      document.getElementById("wait-password-panel")?.classList.remove("hidden");
    }
    if (k === "game") {
      document.getElementById("skill-hud")?.classList.remove("hidden");
      // inject a couple skill buttons for realistic HUD height
      const bar = document.getElementById("skill-bar");
      if (bar && !bar.children.length) {
        for (let i = 0; i < 3; i++) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "skill-use-btn";
          b.textContent = "SKILL" + (i + 1);
          bar.appendChild(b);
        }
      }
    }
  }, key);
  await page.waitForTimeout(120);
}

async function layoutPass(page, vpName) {
  const screens = [
    { key: "auth", id: "screen-auth" },
    { key: "skillLab", id: "screen-skill-lab" },
    { key: "wait", id: "screen-wait" },
    { key: "game", id: "screen-game" },
  ];
  const results = [];
  for (const s of screens) {
    await showScreenOnly(page, s.key);
    const m = await measure(page, s.id, CRITICAL[s.key]);
    const pass = !m.needsScroll && m.items.every((i) => i.exists && i.inView && i.visible !== false);
    results.push({ viewport: vpName, screen: s.key, pass, needsScroll: m.needsScroll, items: m.items, doc: m.doc, screenBox: m.screen });
  }
  return results;
}

async function skillSoloPass(page, vpName) {
  await showScreenOnly(page, "auth");
  // open lab via UI
  await page.click("#btn-open-skill-lab");
  await page.waitForSelector("#screen-skill-lab.active");
  await page.waitForSelector("#skill-lab-catalog .skill-card");

  await page.click("#btn-clear-loadout");
  const cards = page.locator("#skill-lab-catalog .skill-card");
  const n = await cards.count();
  for (let i = 0; i < Math.min(n, 6); i++) {
    if (!(await page.locator("#btn-save-loadout").isDisabled())) break;
    await cards.nth(i).click({ force: true });
  }
  if (await page.locator("#btn-save-loadout").isDisabled()) {
    return { viewport: vpName, screen: "skillSolo", pass: false, error: "save still disabled" };
  }
  await page.click("#btn-save-loadout", { force: true });
  await page.waitForSelector("#screen-auth.active", { timeout: 10000 });
  await page.waitForTimeout(300);

  // start solo abyss via DOM click to avoid intercept issues
  await page.evaluate(() => {
    const btn = document.querySelector(
      '.protocol-card[data-game-mode="standard"][data-skill-mode="abyss"] .protocol-btn[data-room-action="solo"]'
    );
    btn?.click();
  });

  // drafting may show wait briefly
  const deadline = Date.now() + 25000;
  let active = null;
  while (Date.now() < deadline) {
    active = await page.evaluate(() =>
      ["screen-game", "screen-wait", "screen-skill-lab", "screen-auth"].find((id) =>
        document.getElementById(id)?.classList.contains("active")
      )
    );
    if (active === "screen-game") break;
    // if stuck on wait drafting, try confirm loadout button if present
    if (active === "screen-wait") {
      await page.evaluate(() => {
        const confirm = document.getElementById("btn-confirm-loadout");
        if (confirm && !confirm.disabled) confirm.click();
      });
    }
    await page.waitForTimeout(250);
  }

  if (active !== "screen-game") {
    const dbg = await page.evaluate(() => ({
      active: ["screen-auth", "screen-skill-lab", "screen-wait", "screen-game"].find((id) =>
        document.getElementById(id)?.classList.contains("active")
      ),
      phase: document.getElementById("phase-text")?.textContent,
      prep: document.getElementById("skill-prep-status")?.textContent,
      loadout: localStorage.getItem("abyss_skill_loadout_v1"),
      draftStatus: document.getElementById("draft-status")?.textContent,
      toast: document.body.innerText.includes("请先完成") ? "need-loadout" : null,
    }));
    return { viewport: vpName, screen: "skillSolo", pass: false, error: "did not reach game", dbg };
  }

  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById("skill-hud")?.classList.remove("hidden"));
  const m = await measure(page, "screen-game", CRITICAL.game);
  const pass = !m.needsScroll && m.items.every((i) => i.exists && i.inView);
  return {
    viewport: vpName,
    screen: "skillSolo",
    pass,
    needsScroll: m.needsScroll,
    items: m.items,
    phase: await page.locator("#phase-text").textContent(),
    energy: await page.locator("#self-energy").textContent().catch(() => null),
  };
}

async function runViewport(browser, vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#screen-auth.active");

  const layout = await layoutPass(page, vp.name);
  const solo = await skillSoloPass(page, vp.name);
  await context.close();
  return { viewport: vp.name, layout, solo, ok: layout.every((r) => r.pass) && solo.pass };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const vp of VIEWPORTS) results.push(await runViewport(browser, vp));
  } finally {
    await browser.close();
  }
  const ok = results.every((r) => r.ok);
  const failed = results.flatMap((r) => [
    ...r.layout.filter((x) => !x.pass).map((x) => ({ viewport: r.viewport, ...x })),
    ...(r.solo.pass ? [] : [{ viewport: r.viewport, ...r.solo }]),
  ]);
  console.log(JSON.stringify({ ok, failed, results }, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
