const fs = require("fs");
const path = require("path");

const publicDir = path.join(__dirname, "..", "public");

function collectMatches(text, regex) {
  const values = [];
  for (const match of text.matchAll(regex)) values.push(match[1]);
  return values;
}

describe("frontend DOM contract", () => {
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const client = fs.readFileSync(path.join(publicDir, "client.js"), "utf8");
  const style = fs.readFileSync(path.join(publicDir, "style.css"), "utf8");
  const salon = fs.readFileSync(path.join(publicDir, "salon.css"), "utf8");
  const tableV2 = fs.readFileSync(path.join(publicDir, "table-v2.css"), "utf8");

  test("HTML id 唯一", () => {
    const ids = collectMatches(html, /\bid=["']([^"']+)["']/g);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  test("client.js 的 getElementById 引用均存在", () => {
    const htmlIds = new Set(collectMatches(html, /\bid=["']([^"']+)["']/g));
    const referenced = new Set(
      collectMatches(client, /(?:byId|getElementById)\(["']([^"']+)["']\)/g)
    );
    const missing = [...referenced].filter((id) => !htmlIds.has(id));
    expect(referenced.size).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });

  test("所有静态按钮均声明 type 且不存在按钮嵌套", () => {
    const buttonTags = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
    expect(buttonTags.length).toBeGreaterThan(30);
    expect(buttonTags.filter((tag) => !/\btype=["']button["']/.test(tag))).toEqual([]);

    let depth = 0;
    let nested = false;
    for (const match of html.matchAll(/<\/?button\b[^>]*>/g)) {
      if (match[0].startsWith("</")) depth -= 1;
      else {
        if (depth > 0) nested = true;
        depth += 1;
      }
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    expect(nested).toBe(false);
    expect(html).toContain('id="btn-back-game" class="button button-ghost back-button" aria-label="离开牌桌"');
  });

  test("技能放大、四技能栏与单击加注控件已接入", () => {
    expect(html).toContain('id="skill-preview-modal"');
    expect(html).toContain('id="btn-close-skill-preview"');
    expect(html).toContain('id="btn-raise-options"');
    expect(html).toContain('<span>牌堆</span>');
    expect(client).toContain('className = "skill-zoom-button"');
    expect(client).toContain('className = "skill-selection-mark"');
    expect(client).toContain('className = "skill-slot is-"');
    expect(client).toContain('beginRealtimeRequest("action"');
    expect(client).toContain('beginRealtimeRequest("room"');
    expect(client).toContain('beginRealtimeRequest("skill"');
    expect(client).toContain("socket.connected &&");
  });

  test("牌桌倒计时与底池语义分离，四技能与专家操作字号具备回归契约", () => {
    const boardStageStart = html.indexOf('<section class="table-center"');
    const boardStageEnd = html.indexOf('id="btn-toggle-skill-feed"', boardStageStart);
    const boardStageMarkup = html.slice(boardStageStart, boardStageEnd);
    expect(boardStageStart).toBeGreaterThan(-1);
    expect(boardStageMarkup).toContain('class="board-stage-line"');
    expect(boardStageMarkup).toContain('id="action-countdown"');
    expect(boardStageMarkup).toContain('id="community-cards"');
    expect(boardStageMarkup.indexOf('id="action-countdown"')).toBeLessThan(
      boardStageMarkup.indexOf('id="community-cards"')
    );

    const instrumentsStart = html.indexOf('<div class="round-instruments">');
    const instrumentsEnd = html.indexOf('id="overdrive-profile"', instrumentsStart);
    const instrumentsMarkup = html.slice(instrumentsStart, instrumentsEnd);
    expect(instrumentsStart).toBeGreaterThan(-1);
    expect(instrumentsMarkup).toContain('id="pot-core"');
    expect(instrumentsMarkup).toContain('id="deck-stack"');
    expect(instrumentsMarkup).not.toContain('id="action-countdown"');

    expect(client).toContain('el.skillBar.dataset.count = String(equippedSkillIds.length)');
    expect(tableV2).toMatch(
      /\.skill-bar\[data-count="4"\][^{]*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s
    );
    expect(tableV2).toContain(
      'body.pro-player-mode.salon-ui #screen-game .action-button.fold .action-en'
    );
    expect(tableV2).toContain('font-size: clamp(1.28rem, 1.48vw, 1.58rem)');
  });

  test("storage failures and modal focus are handled defensively", () => {
    expect(client).toContain("function safeStorageGet");
    expect(client).toContain("function safeStorageSet");
    expect(client).not.toMatch(/\b(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)/);
    expect(client).toContain("mainContent.inert = hasModal");
    expect(client).toContain('event.key !== "Tab"');
  });

  test("按钮装饰层不拦截邻近按钮点击", () => {
    const decorativeRule = style.match(/\.button::before,\s*\.action-button::before\s*\{[^}]+\}/s)?.[0];
    expect(decorativeRule).toBeTruthy();
    expect(decorativeRule).toContain("pointer-events: none");
  });

  test("已发出的公共牌不会继承空牌位样式", () => {
    const renderCardRow = client.match(
      /function renderCardRow\(container, cards, options\) \{[\s\S]+?\n\}/
    )?.[0];
    expect(renderCardRow).toBeTruthy();
    expect(renderCardRow).toContain("slot: false");
    expect(renderCardRow).toContain("slot: Boolean(settings.slot)");
  });

  test("ALL IN 逻辑计时与视觉时长保持一致", () => {
    expect(client).toContain("const ALL_IN_EFFECT_MS = 2200");
    expect(style).toContain("--allin-duration: 2200ms");
  });

  test("ALL IN 提供四种可持久化样式且演出文字仅保留 ALL IN", () => {
    const styles = ["abyss", "verdict", "royal", "singularity"];
    expect(client).toContain(
      'const ALL_IN_STYLES = Object.freeze(["abyss", "verdict", "royal", "singularity"])'
    );
    expect(client).toContain("ALL_IN_STYLES.includes(stored.allInStyle)");
    expect(client).toContain("document.documentElement.dataset.allinStyle");
    expect(client).toContain("el.flash.dataset.allinStyle = state.settings.allInStyle");
    styles.forEach((styleId) => {
      expect(html).toContain(`name="allin-style" value="${styleId}"`);
      expect(style).toContain(`.flash-overlay[data-allin-style="${styleId}"]`);
    });

    const effectStart = html.lastIndexOf("<div", html.indexOf('id="flash-allin"'));
    const effectEnd = html.lastIndexOf("<div", html.indexOf('id="river-overload"'));
    const effectMarkup = html.slice(effectStart, effectEnd);
    const visibleText = effectMarkup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(visibleText).toBe("ALL IN");
    expect(effectMarkup).not.toMatch(/[\u3400-\u9fff]/);
  });

  test("手机端 ALL IN 触觉反馈具备兼容降级", () => {
    expect(client).toContain("const ALL_IN_VIBRATION_PATTERN");
    expect(client).toContain("function playAllInHaptics()");
    expect(client).toContain('typeof navigator.vibrate !== "function"');
    expect(client).toContain("state.settings.reduceMotion");
    expect(client).toContain("navigator.vibrate(pattern)");
    expect(client).toContain("playFxHaptics(ALL_IN_VIBRATION_PATTERN)");
    expect(client).toMatch(/playAllInHaptics\(\);\s+playTone\("allin"\)/);
    expect(client).toContain("if (!preview) playAllInHaptics()");
  });

  test("V2 精确目标选择已替代旧式反制弹窗", () => {
    expect(html).not.toContain('id="skill-reaction-modal"');
    expect(client).not.toContain('socket.emit("skill:counter:skip"');
    expect(client).toContain("function openSkillTargetOptions");
    ["INTEL_ONE", "CHEAT", "NULLIFICATION", "DESTINY"].forEach((skillId) => {
      expect(client).toContain(`skillId === "${skillId}"`);
    });
    expect(html).toContain('id="opponent-skill-field"');
    expect(html).toContain('id="btn-mark-opponent-skills"');
    expect(client).toContain("function renderOpponentSkillIntel()");
    expect(client).toContain('skillLoadout: "abyss_skill_loadout_v2"');
    expect(html).toContain('id="self-energy"');
    expect(html).toContain('id="self-energy-cap"');
    expect(html).toContain('id="btn-skill-preview-novice"');
    expect(html).toContain('id="btn-skill-preview-expert"');
    expect(client).toContain("shortDescription");
    expect(client).toContain("skillExpertText");
  });

  test("技能选择随权威回合失效，移动技能抽屉不会穿透或污染无技能局", () => {
    expect(client).toContain("function invalidateSkillChoiceIfStale");
    expect(client).toContain("context.turnId !== (state.turnId || null)");
    expect(client).toContain("closeSkillChoiceModal({ render: false, restoreFocus: false })");
    expect(client).toContain("function syncTableRailAccessibility");
    expect(client).toContain("el.opponentSkillField.inert = intelHidden");
    expect(client).toContain("rememberPublicSkillIntel(payload)");
    expect(tableV2).toContain(".poker-board.skills-disabled .table-rail-tab");
    expect(tableV2).toMatch(/\.poker-board\.skills-disabled \.table-rail-tab\s*\{\s*display:\s*none;/);
  });

  test("技能牌堆审计包含最终牌区守恒检查", () => {
    expect(client).toContain("const finalZoneCodes = [");
    expect(client).toContain("finalZoneCodes.length === 52");
    expect(client).toContain("技能审计发现牌张守恒异常");
  });

  test("设置面板提供安全返回大厅入口且设置触发器无边框", () => {
    expect(html).toContain('id="btn-settings-lobby"');
    expect(html).toContain('id="settings-navigation"');
    expect(client).toContain("el.btnSettingsLobby?.addEventListener");
    const triggerRule = salon.match(/\.salon-ui \.settings-trigger\s*\{[^}]+\}/s)?.[0];
    expect(triggerRule).toBeTruthy();
    expect(triggerRule).toContain("border: 0");
  });

  test("ALL IN 后仍完整展示按牌面分级的结算时长", () => {
    expect(client).toContain("const HAND_SETTLE_MS = 2000");
    expect(client).toContain("settleMs: totalSettleMs");
    expect(client).not.toContain("totalSettleMs - remainingEffectMs");
  });

  test("入口资源与模式选择控件存在", () => {
    expect(html).toContain('<script src="./client.js"></script>');
    expect(html).toContain('name="game-mode" value="standard"');
    expect(html).toContain('name="game-mode" value="overdrive"');
    expect(html).toContain('name="skill-mode" value="off"');
    expect(html).toContain('name="skill-mode" value="abyss"');
    expect(html).toContain('name="protocol" value="standard-off"');
    expect(html).toContain('name="protocol" value="overdrive-off"');
    expect(html).toContain('name="protocol" value="standard-abyss"');
    expect(html).toContain('name="protocol" value="overdrive-abyss"');
    expect(html).toContain('data-room-action="solo"');
    expect(html).toContain('data-room-action="create"');
    expect(html).toContain('id="btn-open-skill-lab"');
    expect(html).toContain('id="screen-skill-lab"');
    expect(html).toContain('id="skill-lab-catalog"');
    expect(html).toContain('data-raise-preset="max"');
    expect(html).toContain('id="skill-draft-panel"');
    expect(html).toContain('id="skill-hud"');
    expect(html).toContain('id="join-password-modal"');
    expect(html).toContain('id="input-wait-password"');
    expect(html).toContain('id="btn-set-room-password"');
    expect(html).not.toContain('id="input-password"');
    expect(html).not.toContain('id="input-join-password"');
  });
});
