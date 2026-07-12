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
  });
});
