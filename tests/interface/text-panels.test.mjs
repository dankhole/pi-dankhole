import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";

const root = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const requirePi = createRequire(join(root, "package.json"));
const fromPi = path => import(pathToFileURL(join(root, path)).href);
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
  "@earendil-works/pi-tui": requirePi.resolve("@earendil-works/pi-tui"),
} });
const { registerTextPanels } = await jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styling/text-panels.ts"));
const { Markdown, mixColors, visibleWidth } = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
const { AssistantMessageComponent } = await fromPi("dist/modes/interactive/components/assistant-message.js");
const { UserMessageComponent } = await fromPi("dist/modes/interactive/components/user-message.js");
const { createMarkdownTransform } = await fromPi("dist/modes/interactive/components/markdown-transform.js");
const { loadExtensionFromFactory, createExtensionRuntime } = await fromPi("dist/core/extensions/loader.js");
const { createEventBus } = await fromPi("dist/core/event-bus.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
themes.initTheme("dark", false);
const plain = (component, width = 100) => component.render(width).map(stripVTControlCharacters);
const source = "before\n\n```text\nroot\n├── child\n│   └── leaf\n└── end\n```\n\nafter";
function fixture(enabled = true, mode = "tui") {
  const handlers = new Map();
  let transformer;
  registerTextPanels({ on(name, handler) { handlers.set(name, handler); }, registerMarkdownTransformer(value) { transformer = value; } }, enabled);
  const ctx = { mode, ui: { get theme() { return themes.theme; } } };
  handlers.get("session_start")?.({}, ctx);
  const transform = (text, extra = {}) => transformer?.(text, { messageType: "assistant", isStreaming: false, availableWidth: 98, ...extra }) ?? text;
  const markdown = (text, extra = {}, padding = 0) => new Markdown(text, padding, 0, themes.getMarkdownTheme(), undefined, {
    transform: (text, availableWidth) => transform(text, { ...extra, availableWidth }),
  });
  return { handlers, transformer, ctx, transform, markdown };
}

test("native Pi synthesizes visible fence borders; panels replace only the display", () => {
  assert.match(plain(new Markdown(source, 0, 0, themes.getMarkdownTheme())).join("\n"), /```text/);
  const f = fixture();
  const component = f.markdown(source);
  const rendered = plain(component).join("\n");
  assert.doesNotMatch(rendered, /```/);
  for (const row of ["before", "root", "├── child", "│   └── leaf", "└── end", "after"]) assert.ok(rendered.includes(row), row);
  assert.ok(component.render(100).some(line => /\x1b\[48;[25];/.test(line)));
  assert.equal(source, "before\n\n```text\nroot\n├── child\n│   └── leaf\n└── end\n```\n\nafter");
});

test("literal content, whitespace, Markdown, math, HTML and tree characters survive rendering", () => {
  const f = fixture();
  const rows = ["    deeply indented", "  ", "", "<tag>&amp; &#39;", "**bold** _italic_ ~~strike~~", "[link](https://example.com)", "# title | x", "\\[x\\] $x^2$ \\alpha", "\\path\\to\\file", "`inline` ```", "`", "````", "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~", "├── 👩‍💻 中文 é", "trailing   "];
  const component = f.markdown("~~~~plaintext\n" + rows.join("\n") + "\n~~~~");
  const rendered = plain(component, 100);
  for (const row of rows) assert.ok(rendered.includes(" " + row + " ".repeat(99 - visibleWidth(row))), JSON.stringify({ row, rendered }));
  assert.doesNotMatch(rendered.join("\n"), /~~~~plaintext/);
});

test("ANSI styling cannot become a Markdown link opener and preserves literal panel rows", () => {
  const rows = ["]](path)", "    ]](path)", "]](https://example.com)", "  \\[x\\] [link](path)", "```` ]](path)"];
  const text = "~~~~text\n" + rows.join("\n") + "\n~~~~";
  for (const appearance of ["light", "dark"]) {
    themes.initTheme(appearance, false);
    const f = fixture();
    const background = themes.theme.style("probe", { bg: mixColors(themes.theme.colors.userMessageBg, themes.theme.colors.text, 0.08) }).match(/\x1b\[48;[25];[\d;]+m/)?.[0];
    assert.ok(background);
    const components = [f.markdown(text),
      new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }, false, themes.getMarkdownTheme(), "Thinking...", 0, [f.transformer]),
      new UserMessageComponent(text, themes.getMarkdownTheme(), 0, [f.transformer])];
    for (const component of components) {
      const rendered = component.render(80);
      for (const row of rows) {
        const expected = " " + row + " ".repeat(79 - visibleWidth(row));
        const styled = rendered.find(line => stripVTControlCharacters(line) === expected);
        assert.ok(styled, JSON.stringify({ appearance, row, rendered: rendered.map(stripVTControlCharacters) }));
        assert.ok(styled.includes(background), "the panel's own background survives Markdown and user-message styling");
        assert.ok(visibleWidth(styled) === 80);
      }
    }
  }
  themes.initTheme("dark", false);
});

test("URL and email autolinks do not suppress subsequent panels; real raw HTML stays opaque", () => {
  const f = fixture();
  for (const opener of ["<https://example.com>", "<mailto:user@example.com>", "<user@example.com>"]) {
    const text = opener + "\n```text\n  tree\n```";
    const transformed = f.transform(text);
    assert.ok(transformed.startsWith(opener + "\n"));
    assert.doesNotMatch(transformed, /```text/);
    assert.ok(plain(f.markdown(text), 80).includes("   tree" + " ".repeat(73)));
  }
  for (const [open, close] of [["<div>inline", "</div>"], ["<custom data-x='value'>", "</custom>"], ["</custom>", ""], ["<!-- comment", "-->"], ["<?processing", "?>"], ["<!DOCTYPE html", ">"], ["<![CDATA[", "]]>"]]) {
    const text = open + "\n```text\n  literal\n```\n" + close;
    assert.equal(f.transform(text), text, open);
  }
});

test("matches explicit aliases, tilde and long fences, CRLF, and multiple blocks", () => {
  const f = fixture();
  for (const [open, close] of [["```txt", "```"], ["~~~TEXT", "~~~~"], ["````plaintext ", "`````"]]) {
    const text = `${open}\r\n  a\r\n\r\n b\r\n${close}`;
    const rendered = plain(f.markdown(text), 30).join("\n");
    assert.ok(rendered.includes("   a"));
    assert.ok(rendered.includes("  b"));
    assert.doesNotMatch(rendered, /`|~/);
  }
  const rendered = plain(f.markdown("```txt\na\n```\n\nparagraph\n\n~~~plaintext\nb\n~~~")).join("\n");
  assert.ok(rendered.includes("paragraph"));
  assert.doesNotMatch(rendered, /`|~/);
});

test("leaves other code, Mermaid, unlabeled/nested fences, HTML and thinking unchanged", () => {
  const f = fixture();
  for (const text of ["```js\nconst a = 1;\n```", "```mermaid\ngraph TD; A-->B\n```", "```\nraw\n```", "  ```text\n  nested\n  ```", "> ```text\n> quoted\n> ```", "```markdown\n```text\nexample\n```\n```", "<pre>\n\n```text\nliteral\n```\n</pre>", "<!--\n```text\nliteral\n```\n-->"]) assert.equal(f.transform(text), text);
  assert.equal(f.transform(source, { messageType: "assistant-thinking" }), source);
  const js = "```js\nconst a = 1;\n```";
  assert.deepEqual(f.markdown(js).render(80), new Markdown(js, 0, 0, themes.getMarkdownTheme()).render(80));
});

test("streaming open blocks and partial closing fences do not expose borders or lose body", () => {
  const f = fixture();
  for (const ending of ["", "\n", "\n`", "\n``", "\n```", "\n````"]) {
    const rendered = plain(f.markdown("```text\n  root\n  └── child" + ending, { isStreaming: true }), 50).join("\n");
    assert.ok(rendered.includes("   root"));
    assert.ok(rendered.includes("   └── child"));
    assert.doesNotMatch(rendered, /`/);
  }
  assert.ok(plain(f.markdown("```text\na\n``", { isStreaming: false })).some(line => line.includes("``")));
  assert.equal(f.transform("```text", { isStreaming: true }), "```text"); // Wait for completed info line.
  assert.doesNotMatch(plain(f.markdown("```text\n", { isStreaming: true })).join("\n"), /```/);
});

test("hard wraps without dropping spaces, changes width and theme without stale styling", () => {
  const f = fixture();
  const text = "```text\n    a  b  c  d  e  f\n└── 👩‍💻 中文 é\n```";
  const backgrounds = [];
  for (const appearance of ["light", "dark"]) {
    themes.initTheme(appearance, false);
    const component = f.markdown(text);
    for (const width of [2, 3, 4, 5, 8, 12, 40, 100]) {
      const rendered = component.render(width);
      assert.ok(rendered.every(line => visibleWidth(line) <= width), JSON.stringify({ width, rendered }));
      assert.doesNotMatch(plain(component, width).join("\n"), /```/);
    }
    backgrounds.push(component.render(80).find(line => line.includes("a"))?.match(/\x1b\[48;[25];[\d;]+m/)?.[0]);
    const raw = "a   b  c";
    const wrapped = plain(f.markdown("```text\n" + raw + "\n```"), 3).filter(line => line.trim());
    assert.equal(wrapped.join(""), raw.padEnd(9));
  }
  assert.ok(backgrounds.every(Boolean));
  assert.notEqual(backgrounds[0], backgrounds[1]);
  themes.initTheme("dark", false);
});

test("real assistant and user components use supported transform without transcript mutation", () => {
  const f = fixture();
  const message = { role: "assistant", content: [{ type: "text", text: source }], stopReason: "stop" };
  const original = structuredClone(message);
  const assistant = new AssistantMessageComponent(message, false, themes.getMarkdownTheme(), "Thinking...", 1, [f.transformer]);
  assert.doesNotMatch(plain(assistant, 80).join("\n"), /```/);
  assert.deepEqual(message, original);
  assistant.updateContent({ ...message, content: [{ type: "text", text: "```text\n  partial\n``" }] }, true);
  assert.doesNotMatch(plain(assistant, 80).join("\n"), /`/);
  assistant.invalidate();
  assert.ok(plain(assistant, 20).some(line => line.includes("partial")));
  const user = new UserMessageComponent(source, themes.getMarkdownTheme(), 1, [f.transformer]);
  assert.doesNotMatch(plain(user, 80).join("\n"), /```/);
  assert.ok(user.render(80).find(line => stripVTControlCharacters(line).includes("root")).match(/\x1b\[48;[25];/));
  const themed = f.markdown(source);
  const dark = themed.render(80);
  themes.initTheme("light", false);
  themed.invalidate();
  assert.notDeepEqual(themed.render(80), dark);
  assert.doesNotMatch(plain(themed, 80).join("\n"), /```/);
  themes.initTheme("dark", false);
});

test("registration is runtime-local, mode guarded, disabled cleanly and released on shutdown", async () => {
  const disabled = fixture(false);
  assert.equal(disabled.handlers.size, 0);
  assert.equal(disabled.transformer, undefined);
  for (const mode of ["rpc", "json", "print"]) assert.equal(fixture(true, mode).transform(source), source);
  const f = fixture();
  assert.notEqual(f.transform(source), source);
  await f.handlers.get("session_shutdown")({}, f.ctx);
  await f.handlers.get("session_shutdown")({}, f.ctx);
  assert.equal(f.transform(source), source);
  await f.handlers.get("session_start")({}, f.ctx);
  assert.notEqual(f.transform(source), source);
  const loaded = await loadExtensionFromFactory(pi => registerTextPanels(pi, true), process.cwd(), createEventBus(), createExtensionRuntime());
  assert.equal(loaded.tools.size, 0);
  assert.equal(loaded.commands.size, 0);
  assert.deepEqual([...loaded.handlers.keys()], ["session_start", "session_shutdown"]);
  assert.equal(typeof loaded.markdownTransformer, "function");
  await loaded.handlers.get("session_start")[0]({}, f.ctx);
  const renderTransform = createMarkdownTransform("assistant", false, [loaded.markdownTransformer]);
  const markdown = new Markdown(source, 0, 0, themes.getMarkdownTheme(), undefined, { transform: renderTransform });
  assert.doesNotMatch(plain(markdown, 80).join("\n"), /```/);
  await loaded.handlers.get("session_shutdown")[0]({}, f.ctx);
  assert.equal(loaded.markdownTransformer(source, { messageType: "assistant", isStreaming: false, availableWidth: 80 }), source);
});
