import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3002";
const LOADOUT = ["ABYSS_BREATH", "EMBER_RECYCLE", "ADVERSITY_CIRCUIT", "ECHO_SCAN"];

async function visible(page, selector) {
  return page.locator(selector).isVisible().catch(() => false);
}

async function skillGeometry(page) {
  return page.evaluate(() => {
    const bar = document.getElementById("skill-bar");
    const slots = [...document.querySelectorAll("#skill-bar .skill-slot")];
    if (!bar) return { count: 0, allInside: false, overflows: true, rects: [] };
    const bounds = bar.getBoundingClientRect();
    const rects = slots.map((slot) => {
      const rect = slot.getBoundingClientRect();
      return {
        left: Math.round(rect.left * 10) / 10,
        right: Math.round(rect.right * 10) / 10,
        top: Math.round(rect.top * 10) / 10,
        bottom: Math.round(rect.bottom * 10) / 10,
      };
    });
    return {
      count: slots.length,
      allInside: rects.every(
        (rect) =>
          rect.left >= bounds.left - 1 &&
          rect.right <= bounds.right + 1 &&
          rect.top >= bounds.top - 1 &&
          rect.bottom <= bounds.bottom + 1
      ),
      overflows: bar.scrollWidth > bar.clientWidth + 1,
      columns: new Set(rects.map((rect) => rect.left)).size,
      rows: new Set(rects.map((rect) => rect.top)).size,
      rects,
    };
  });
}

async function buttonHitAudit(page, scopeSelector) {
  return page.evaluate((scopeSelector) => {
    const scope = document.querySelector(scopeSelector) || document;
    const failures = [];
    let checked = 0;
    [...scope.querySelectorAll("button")].forEach((button) => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      if (
        button.disabled ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        rect.width < 1 ||
        rect.height < 1 ||
        rect.bottom <= 0 ||
        rect.top >= innerHeight ||
        rect.right <= 0 ||
        rect.left >= innerWidth
      ) {
        return;
      }
      checked += 1;
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(x, y);
      if (!hit || hit.closest("button") !== button) {
        failures.push({
          id: button.id || null,
          label: button.getAttribute("aria-label") || button.textContent.trim().replace(/\s+/g, " "),
          hit: hit ? hit.id || hit.className || hit.tagName : null,
          x: Math.round(x),
          y: Math.round(y),
        });
      }
    });
    return { checked, failures };
  }, scopeSelector);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  const report = {
    staticButtons: null,
    lobby: {},
    lab: {},
    room: {},
    game: {},
    mobile: {},
    compact: {},
    landscape: {},
    smallLandscape: {},
    allin: {},
  };

  await page.goto(BASE + "/?verify-interactions=1", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#screen-auth.active", { timeout: 10000 });
  await page.waitForSelector("#btn-open-skill-lab:not([disabled])", { timeout: 10000 });

  report.staticButtons = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    return {
      count: buttons.length,
      missingType: buttons.filter((button) => button.getAttribute("type") !== "button").length,
      nested: document.querySelectorAll("button button").length,
      unnamed: buttons.filter(
        (button) =>
          !(button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent.trim())
      ).length,
    };
  });
  report.lobby.hitAudit = await buttonHitAudit(page, "#screen-auth");

  await page.click("#btn-settings");
  report.lobby.settingsOpened = await visible(page, "#settings-modal:not(.hidden)");
  await page.click("#btn-close-settings");
  report.lobby.settingsClosed = !(await visible(page, "#settings-modal:not(.hidden)"));

  await page.click("#btn-open-skill-lab");
  await page.waitForSelector("#screen-skill-lab.active");
  await page.waitForSelector("#skill-lab-catalog .skill-card-select");
  const cards = page.locator("#skill-lab-catalog .skill-card");
  const zoomButtons = page.locator("#skill-lab-catalog .skill-zoom-button");
  report.lab.cards = await cards.count();
  report.lab.zoomButtons = await zoomButtons.count();
  const selectedBeforeZoom = await page.locator("#skill-lab-catalog .skill-card.selected").count();
  await zoomButtons.first().click();
  report.lab.previewOpened = await visible(page, "#skill-preview-modal:not(.hidden)");
  report.lab.zoomDidNotSelect =
    selectedBeforeZoom === (await page.locator("#skill-lab-catalog .skill-card.selected").count());
  await page.click("#btn-close-skill-preview");
  report.lab.previewClosed = !(await visible(page, "#skill-preview-modal:not(.hidden)"));
  report.lab.hitAudit = await buttonHitAudit(page, "#screen-skill-lab");

  await page.click("#btn-clear-loadout");
  for (const skillId of LOADOUT) {
    await page.click(`#skill-lab-catalog .skill-card[data-skill-id="${skillId}"] .skill-card-select`);
  }
  report.lab.selected = await page.locator("#skill-lab-catalog .skill-card.selected").count();
  report.lab.saveEnabled = await page.locator("#btn-save-loadout").isEnabled();
  await page.click("#btn-save-loadout");
  await page.waitForSelector("#screen-auth.active");

  report.room.doubleClickGate = await page.evaluate(() => {
    const button = document.querySelector(
      '.protocol-card[data-game-mode="standard"][data-skill-mode="abyss"] .protocol-btn[data-room-action="solo"]'
    );
    if (!button) return { found: false, disabledAfterFirst: false };
    button.click();
    const disabledAfterFirst = button.disabled;
    button.click();
    return { found: true, disabledAfterFirst };
  });
  await page.waitForSelector("#screen-game.active", { timeout: 20000 });
  await page.waitForTimeout(500);

  report.game.skillGeometry = await skillGeometry(page);
  report.game.zoomButtons = await page.locator("#skill-bar .skill-zoom-button").count();
  report.game.deckLabel = await page.locator(".fairness-stat > span").innerText();
  await page.locator("#skill-bar .skill-zoom-button").first().click();
  report.game.previewOpened = await visible(page, "#skill-preview-modal:not(.hidden)");
  await page.click("#btn-skill-preview-done");
  report.game.hitAudit = await buttonHitAudit(page, "#screen-game");

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".primary-actions button, #btn-raise")].some(
        (button) => !button.disabled && !button.classList.contains("hidden")
      ),
    null,
    { timeout: 12000 }
  );

  report.game.raiseOptions = await page.evaluate(() => {
    const options = document.getElementById("btn-raise-options");
    const panel = document.getElementById("raise-panel");
    if (!options || options.disabled) return { available: false };
    options.click();
    const opened = options.getAttribute("aria-expanded") === "true" && getComputedStyle(panel).display !== "none";
    options.click();
    const closed = options.getAttribute("aria-expanded") === "false";
    return { available: true, opened, closed };
  });

  report.game.actionGate = await page.evaluate(() => {
    const order = ["check", "call", "fold"];
    const button = order
      .map((action) => document.querySelector(`button[data-action="${action}"]`))
      .find((candidate) => candidate && !candidate.disabled && !candidate.classList.contains("hidden"));
    if (!button) return { found: false, allDisabledAfterFirst: false, action: null };
    const action = button.dataset.action;
    button.click();
    const allDisabledAfterFirst = [...document.querySelectorAll(".action-button[data-action]")].every(
      (candidate) => candidate.disabled
    );
    button.click();
    return { found: true, allDisabledAfterFirst, action };
  });

  const effectFunction = await page.evaluate(() => typeof window.playAllInEffect === "function");
  report.allin.functionAvailable = effectFunction;
  if (effectFunction) {
    await page.evaluate(() => window.playAllInEffect("ui-audit-opponent"));
    await page.waitForTimeout(3000);
    report.allin.visibleAfter3000ms = await visible(page, "#flash-allin:not(.hidden)");
    report.allin.subtitle = await page.locator("#allin-subtitle").innerText();
    await page.waitForTimeout(1500);
    report.allin.hiddenAfter4500ms = !(await visible(page, "#flash-allin:not(.hidden)"));
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  report.mobile.skillGeometry = await skillGeometry(page);
  report.mobile.layout = await page.evaluate(() => {
    const dock = document.querySelector(".action-dock")?.getBoundingClientRect();
    const board = document.getElementById("board")?.getBoundingClientRect();
    return {
      scrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      dockInside: Boolean(dock && dock.top >= -1 && dock.bottom <= innerHeight + 1),
      boardDockOverlap: Boolean(board && dock && board.bottom > dock.top + 1),
    };
  });
  report.mobile.hitAudit = await buttonHitAudit(page, "#screen-game");

  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(200);
  report.compact.skillGeometry = await skillGeometry(page);
  report.compact.layout = await page.evaluate(() => {
    const dock = document.querySelector(".action-dock")?.getBoundingClientRect();
    const board = document.getElementById("board")?.getBoundingClientRect();
    return {
      scrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      dockInside: Boolean(dock && dock.top >= -1 && dock.bottom <= innerHeight + 1),
      boardDockOverlap: Boolean(board && dock && board.bottom > dock.top + 1),
    };
  });
  report.compact.hitAudit = await buttonHitAudit(page, "#screen-game");

  const landscapeLayout = () => page.evaluate(() => {
    const dock = document.querySelector(".action-dock")?.getBoundingClientRect();
    const board = document.getElementById("board")?.getBoundingClientRect();
    const self = document.getElementById("self-area")?.getBoundingClientRect();
    const community = [...document.querySelectorAll("#community-cards .card")].map((card) =>
      card.getBoundingClientRect()
    );
    return {
      scrolls:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 ||
        document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      dockInside: Boolean(
        dock && dock.left >= -1 && dock.right <= innerWidth + 1 && dock.bottom <= innerHeight + 1
      ),
      selfInsideBoard: Boolean(
        board && self && self.top >= board.top - 1 && self.bottom <= board.bottom + 1
      ),
      communityInsideBoard: Boolean(
        board && community.length === 5 && community.every(
          (card) => card.top >= board.top - 1 && card.bottom <= board.bottom + 1
        )
      ),
    };
  });

  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(200);
  report.landscape.skillGeometry = await skillGeometry(page);
  report.landscape.layout = await landscapeLayout();
  report.landscape.hitAudit = await buttonHitAudit(page, "#screen-game");

  await page.setViewportSize({ width: 667, height: 375 });
  await page.waitForTimeout(200);
  report.smallLandscape.skillGeometry = await skillGeometry(page);
  report.smallLandscape.layout = await landscapeLayout();
  report.smallLandscape.hitAudit = await buttonHitAudit(page, "#screen-game");

  await browser.close();

  const failures = [];
  if (report.staticButtons.missingType || report.staticButtons.nested || report.staticButtons.unnamed) {
    failures.push("button DOM contract failed");
  }
  if (!report.lobby.settingsOpened || !report.lobby.settingsClosed) failures.push("settings button routing failed");
  if (report.lobby.hitAudit.failures.length) failures.push("lobby button hit targets blocked");
  if (report.lab.cards < 12 || report.lab.zoomButtons !== report.lab.cards) failures.push("skill zoom buttons incomplete");
  if (!report.lab.previewOpened || !report.lab.previewClosed || !report.lab.zoomDidNotSelect) {
    failures.push("skill preview interaction failed");
  }
  if (report.lab.hitAudit.failures.length) failures.push("skill lab button hit targets blocked");
  if (report.lab.selected !== 4 || !report.lab.saveEnabled) failures.push("four-skill loadout failed");
  if (!report.room.doubleClickGate.found || !report.room.doubleClickGate.disabledAfterFirst) {
    failures.push("room request double-click gate failed");
  }
  if (report.game.skillGeometry.count !== 4 || !report.game.skillGeometry.allInside || report.game.skillGeometry.overflows) {
    failures.push("desktop four-skill HUD overflow");
  }
  if (report.game.zoomButtons !== 4 || report.game.deckLabel.trim() !== "牌堆" || !report.game.previewOpened) {
    failures.push("game HUD controls failed");
  }
  if (report.game.hitAudit.failures.length) failures.push("game button hit targets blocked");
  if (!report.game.actionGate.found || !report.game.actionGate.allDisabledAfterFirst) {
    failures.push("poker action double-click gate failed");
  }
  if (report.game.raiseOptions.available && (!report.game.raiseOptions.opened || !report.game.raiseOptions.closed)) {
    failures.push("raise options button failed");
  }
  if (
    !report.allin.functionAvailable ||
    !report.allin.visibleAfter3000ms ||
    !report.allin.hiddenAfter4500ms ||
    report.allin.subtitle !== "OPPONENT IS ALL IN"
  ) {
    failures.push("ALL IN duration failed");
  }
  if (
    report.mobile.skillGeometry.count !== 4 ||
    !report.mobile.skillGeometry.allInside ||
    report.mobile.skillGeometry.overflows ||
    report.mobile.layout.scrolls ||
    !report.mobile.layout.dockInside ||
    report.mobile.layout.boardDockOverlap
  ) {
    failures.push("mobile four-skill layout failed");
  }
  if (report.mobile.hitAudit.failures.length) failures.push("mobile button hit targets blocked");
  if (
    report.compact.skillGeometry.count !== 4 ||
    !report.compact.skillGeometry.allInside ||
    report.compact.skillGeometry.overflows ||
    report.compact.layout.scrolls ||
    !report.compact.layout.dockInside ||
    report.compact.layout.boardDockOverlap
  ) {
    failures.push("compact four-skill layout failed");
  }
  if (report.compact.hitAudit.failures.length) failures.push("compact button hit targets blocked");
  for (const [name, label] of [
    ["landscape", "landscape"],
    ["smallLandscape", "small landscape"],
  ]) {
    const current = report[name];
    if (
      current.skillGeometry.count !== 4 ||
      !current.skillGeometry.allInside ||
      current.skillGeometry.overflows ||
      current.layout.scrolls ||
      !current.layout.dockInside ||
      !current.layout.selfInsideBoard ||
      !current.layout.communityInsideBoard
    ) {
      failures.push(`${label} table layout failed`);
    }
    if (current.hitAudit.failures.length) failures.push(`${label} button hit targets blocked`);
  }
  if (consoleErrors.length) failures.push("browser console errors");

  console.log(JSON.stringify({ ok: failures.length === 0, failures, consoleErrors, report }, null, 2));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
