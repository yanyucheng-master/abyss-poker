import { chromium } from "playwright";
import playwrightRuntime from "./playwright-runtime.js";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3002";

async function searchAndOpen(page, query, expectedTarget) {
  const search = page.locator("#rules-search");
  await search.fill(query);
  await page.waitForFunction(() => {
    const panel = document.getElementById("rules-search-results");
    return panel && !panel.classList.contains("hidden");
  });
  const target = page.locator(`[data-rule-search-target="${expectedTarget}"]`).first();
  if (!(await target.count())) {
    return {
      query,
      expectedTarget,
      found: false,
      resultCount: await page.locator("[data-rule-search-target]").count(),
    };
  }
  await target.click();
  await page.waitForTimeout(700);
  return page.evaluate(({ query: rawQuery, expectedTarget: targetId }) => {
    const article = document.getElementById("rules-article");
    const targetNode = document.getElementById(targetId);
    const articleRect = article?.getBoundingClientRect();
    const targetRect = targetNode?.getBoundingClientRect();
    const visible = Boolean(
      articleRect &&
      targetRect &&
      targetRect.bottom > articleRect.top &&
      targetRect.top < articleRect.bottom
    );
    const highlighted = Boolean(targetNode?.querySelector("mark[data-rule-highlight]"));
    return {
      query: rawQuery,
      expectedTarget: targetId,
      found: true,
      visible,
      highlighted,
      activeChapter: document.querySelector("#rules-toc [aria-current=true]")?.dataset.ruleTarget || "",
      scrollTop: article?.scrollTop || 0,
      maxScrollTop: article ? article.scrollHeight - article.clientHeight : 0,
      articleTop: articleRect?.top ?? null,
      articleBottom: articleRect?.bottom ?? null,
      targetTop: targetRect?.top ?? null,
      targetBottom: targetRect?.bottom ?? null,
      targetOffsetTop: targetNode?.offsetTop ?? null,
      modalScrollTop: document.getElementById("rules-handbook-modal")?.scrollTop || 0,
    };
  }, { query, expectedTarget });
}

async function main() {
  const browser = await chromium.launch(playwrightRuntime.chromiumLaunchOptions({ headless: true }));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem("overlimit_quickstart_v1", "seen");
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(`${BASE}/?verify-rulebook=1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#screen-auth.active", { timeout: 10000 });
  await page.click("#btn-open-rules");
  await page.waitForSelector("#rules-handbook-modal:not(.hidden)");

  const report = {};
  report.desktop = await page.evaluate(() => {
    const panel = document.querySelector(".rules-handbook-panel")?.getBoundingClientRect();
    const article = document.getElementById("rules-article");
    const toc = document.getElementById("rules-toc");
    const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
    return {
      chapterCount: document.querySelectorAll("#rules-toc [data-rule-target]").length,
      skillCount: document.querySelectorAll("#rule-skills .rules-skill-entry").length,
      protocolCount: document.querySelectorAll("#rule-protocols .rules-protocol-entry").length,
      duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
      panelInsideViewport: Boolean(
        panel && panel.left >= -1 && panel.top >= -1 && panel.right <= innerWidth + 1 && panel.bottom <= innerHeight + 1
      ),
      independentScroll: Boolean(
        article && toc && article.scrollHeight > article.clientHeight && toc.scrollHeight > toc.clientHeight
      ),
      backgroundLocked: document.documentElement.classList.contains("has-modal-layer"),
      modalScrollTop: document.getElementById("rules-handbook-modal")?.scrollTop || 0,
      bodyColumns: getComputedStyle(document.querySelector(".rules-handbook-body")).gridTemplateColumns,
      scrollContainers: [...document.querySelectorAll("#rules-handbook-modal *")]
        .map((node) => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return {
            id: node.id || "",
            className: typeof node.className === "string" ? node.className : "",
            overflowY: style.overflowY,
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
            left: Math.round(rect.left),
            right: Math.round(rect.right),
          };
        })
        .filter((item) => item.scrollHeight > item.clientHeight + 1 && ["auto", "scroll"].includes(item.overflowY)),
    };
  });

  report.search = [];
  report.search.push(await searchAndOpen(page, "终局", "skill-endgame"));
  report.search.push(await searchAndOpen(page, "All In", "rule-action-allin"));
  report.search.push(await searchAndOpen(page, "零化", "skill-nullification"));
  report.search.push(await searchAndOpen(page, "牌型奖励", "rule-bonus"));

  await page.locator("#rules-search").fill("");
  await page.locator('[data-rule-target="rule-protocols"]').click();
  await page.waitForTimeout(700);
  report.navigation = await page.evaluate(() => {
    const article = document.getElementById("rules-article");
    const chapter = document.getElementById("rule-protocols");
    const articleRect = article?.getBoundingClientRect();
    const chapterRect = chapter?.getBoundingClientRect();
    return {
      active: document.querySelector("#rules-toc [aria-current=true]")?.dataset.ruleTarget || "",
      targetVisible: Boolean(
        articleRect && chapterRect && chapterRect.top >= articleRect.top - 20 && chapterRect.top < articleRect.bottom
      ),
      documentScrollY: window.scrollY,
      modalScrollTop: document.getElementById("rules-handbook-modal")?.scrollTop || 0,
      articleScrollTop: article?.scrollTop || 0,
    };
  });

  await page.locator('[data-rule-target="rule-skills"]').click();
  await page.locator('[data-rule-anchor-target="skill-loan"]').click();
  await page.waitForTimeout(700);
  const beforeResize = await page.locator("#rules-article").evaluate((node) => node.scrollTop);
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.waitForTimeout(100);
  report.resize = await page.evaluate((before) => {
    const article = document.getElementById("rules-article");
    const target = document.getElementById("skill-loan");
    const articleRect = article?.getBoundingClientRect();
    const targetRect = target?.getBoundingClientRect();
    return {
      before,
      after: article?.scrollTop || 0,
      positionRetained: Boolean(
        articleRect && targetRect && targetRect.bottom > articleRect.top && targetRect.top < articleRect.bottom
      ),
    };
  }, beforeResize);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  await page.click("#btn-rules-menu");
  report.mobile = await page.evaluate(() => {
    const article = document.getElementById("rules-article");
    const body = document.querySelector(".rules-handbook-body");
    const toc = document.getElementById("rules-toc");
    const wrapper = document.querySelector("#rule-interactions .rules-table-wrap");
    const table = document.querySelector("#rule-interactions .rules-table");
    const articleRect = article?.getBoundingClientRect();
    const wrapperRect = wrapper?.getBoundingClientRect();
    return {
      menuOpen: toc?.classList.contains("is-open") || false,
      menuExpanded: document.getElementById("btn-rules-menu")?.getAttribute("aria-expanded"),
      singleColumn: getComputedStyle(body).gridTemplateColumns.split(" ").length === 1,
      articleInsideViewport: Boolean(
        articleRect && articleRect.left >= -1 && articleRect.right <= innerWidth + 1
      ),
      tableContainedByScroller: Boolean(
        wrapperRect && articleRect && wrapperRect.left >= articleRect.left - 1 && wrapperRect.right <= articleRect.right + 1 &&
        table && wrapper && table.scrollWidth >= wrapper.clientWidth
      ),
      pageHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      bodyFontSize: parseFloat(getComputedStyle(article).fontSize),
    };
  });
  await page.click("#rules-toc-backdrop");

  await page.click("#btn-close-rules");
  await page.waitForSelector("#rules-handbook-modal", { state: "hidden" });
  report.close = await page.evaluate(() => ({
    closed: document.getElementById("rules-handbook-modal")?.classList.contains("hidden") || false,
    backgroundUnlocked: !document.documentElement.classList.contains("has-modal-layer"),
  }));

  await browser.close();

  const failures = [];
  if (report.desktop.chapterCount !== 18) failures.push("chapter count is not 18");
  if (report.desktop.skillCount !== 24) failures.push("skill count is not 24");
  if (report.desktop.protocolCount !== 9) failures.push("protocol count is not 9");
  if (report.desktop.duplicateIds.length) failures.push("duplicate DOM ids");
  if (!report.desktop.panelInsideViewport) failures.push("desktop panel clipped");
  if (!report.desktop.independentScroll) failures.push("desktop independent scroll missing");
  if (!report.desktop.backgroundLocked) failures.push("background scroll not locked");
  if (report.desktop.modalScrollTop !== 0) failures.push("rulebook modal outer layer scrolled");
  report.search.forEach((item) => {
    if (!item.found || !item.visible || !item.highlighted) failures.push(`search failed: ${item.query}`);
    if (item.modalScrollTop !== 0) failures.push(`search scrolled modal outer layer: ${item.query}`);
  });
  if (report.navigation.active !== "rule-protocols" || !report.navigation.targetVisible) failures.push("chapter navigation failed");
  if (report.navigation.documentScrollY !== 0 || report.navigation.articleScrollTop <= 0) failures.push("wrong scroll container");
  if (report.navigation.modalScrollTop !== 0) failures.push("chapter navigation scrolled modal outer layer");
  if (!report.resize.positionRetained) failures.push("resize lost reading position");
  if (!report.mobile.menuOpen || report.mobile.menuExpanded !== "true") failures.push("mobile chapter drawer failed");
  if (!report.mobile.singleColumn || !report.mobile.articleInsideViewport) failures.push("mobile single-column layout failed");
  if (!report.mobile.tableContainedByScroller || report.mobile.pageHorizontalOverflow) failures.push("mobile table overflow failed");
  if (report.mobile.bodyFontSize < 14) failures.push("mobile rule text too small");
  if (!report.close.closed || !report.close.backgroundUnlocked) failures.push("rulebook close or scroll unlock failed");
  if (consoleErrors.length) failures.push("browser console errors");

  console.log(JSON.stringify({ ok: failures.length === 0, failures, consoleErrors, report }, null, 2));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
