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
  const socketHandlers = fs.readFileSync(
    path.join(__dirname, "..", "socket", "socketHandlers.js"),
    "utf8"
  );

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
  });

  test("技能放大、四技能栏与单击加注控件已接入", () => {
    expect(html).toContain('id="skill-preview-modal"');
    expect(html).toContain('id="btn-close-skill-preview"');
    expect(html).toContain('id="btn-raise-options"');
    expect(html).toContain('<span>牌堆</span>');
    expect(client).toContain('className = "skill-zoom-button"');
    expect(client).toContain('className = "skill-slot is-"');
    expect(client).toContain('beginRealtimeRequest("action"');
    expect(client).toContain('beginRealtimeRequest("room"');
    expect(client).toContain('beginRealtimeRequest("skill"');
    expect(client).toContain("socket.connected &&");
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
    expect(client).toContain("const ALL_IN_EFFECT_MS = 4200");
    expect(style).toContain("--allin-duration: 4200ms");
  });

  test("手机端 ALL IN 触觉反馈具备兼容降级", () => {
    expect(client).toContain("const ALL_IN_VIBRATION_PATTERN");
    expect(client).toContain("function playAllInHaptics()");
    expect(client).toContain('typeof navigator.vibrate !== "function"');
    expect(client).toContain("state.settings.reduceMotion");
    expect(client).toContain("navigator.vibrate(ALL_IN_VIBRATION_PATTERN)");
    expect(client).toMatch(/playAllInHaptics\(\);\s+playTone\("allin"\)/);
  });

  test("反制跳过会通知服务端并立即结算", () => {
    expect(client).toContain('socket.emit("skill:counter:skip"');
    expect(socketHandlers).toContain('socket.on("skill:counter:skip"');
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
