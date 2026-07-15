const { chromium } = require("playwright");
const { chromiumLaunchOptions } = require("./playwright-runtime");

(async () => {
  const browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto("http://127.0.0.1:3002", { waitUntil: "networkidle" });
  await page.evaluate(() => {
    document
      .querySelector(
        '.protocol-card[data-skill-mode="off"] .protocol-btn[data-room-action="solo"]'
      )
      ?.click();
  });
  await page.waitForSelector("#screen-game.active", { timeout: 15000 });
  await page.waitForTimeout(800);
  const result = await page.evaluate(async () => {
    const btn = document.querySelector('button[data-action="allin"]');
    if (!btn) return { ok: false, error: "no allin btn" };
    btn.disabled = false;
    btn.click();
    await new Promise((r) => setTimeout(r, 200));
    const modal = document.getElementById("allin-confirm-modal");
    return {
      ok: !modal,
      modalExists: Boolean(modal),
      visibleModals: [...document.querySelectorAll(".modal-layer:not(.hidden)")].map((el) => el.id),
    };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  process.exit(result.ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
