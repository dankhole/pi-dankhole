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
const { installAssistantPanels } = await jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styling/assistant-panels.ts"));
const { Container, Markdown, mixColors, visibleWidth } = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
const { AssistantMessageComponent } = await fromPi("dist/modes/interactive/components/assistant-message.js");
const { UserMessageComponent } = await fromPi("dist/modes/interactive/components/user-message.js");
const { ExtensionRunner } = await fromPi("dist/core/extensions/runner.js");
const { loadExtensionFromFactory, createExtensionRuntime } = await fromPi("dist/core/extensions/loader.js");
const { createEventBus } = await fromPi("dist/core/event-bus.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
themes.initTheme("dark", false);
const plain = (component, width = 100) => component.render(width).map(stripVTControlCharacters);
const source = "before\n\n```text\nroot\n├── child\n│   └── leaf\n└── end\n```\n\nafter";

// Track effective colors at each character, rather than merely finding an ANSI
// opener: a later syntax reset must not punch holes through the panel background.
function styledCharacters(line) {
  const characters = [];
  let fg;
  let bg;
  // Native assistant rows can carry OSC shell-integration markers. They are
  // zero-width terminal commands, not visible characters needing a background.
  for (const match of line.matchAll(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
    if (match[0].startsWith("\x1b]")) continue;
    if (match[2] !== undefined) {
      for (const character of match[2]) characters.push({ character, fg, bg });
      continue;
    }
    const codes = (match[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) { fg = undefined; bg = undefined; }
      else if (code === 39) fg = undefined;
      else if (code === 49) bg = undefined;
      else if (code === 38 || code === 48) {
        const count = codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0;
        const color = codes.slice(i + 1, i + count + 1).join(";");
        if (code === 38) fg = color;
        else bg = color;
        i += count;
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = String(code);
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = String(code);
    }
  }
  return characters;
}

function assertSolidBackground(line, width) {
  assert.equal(visibleWidth(line), width);
  const backgrounds = new Set(styledCharacters(line).map(cell => cell.bg));
  assert.equal(backgrounds.size, 1, "every content and padding character has the same background: "
    + JSON.stringify({ text: stripVTControlCharacters(line), backgrounds: [...backgrounds] }));
  assert.ok(!backgrounds.has(undefined), "background remains active after syntax/ANSI resets");
}

function conversationSurface(assistant, enabled) {
  const chat = new Container();
  chat.addChild(assistant);
  const document = new Container();
  document.addChild(new Container());
  document.addChild(new Container());
  document.addChild(chat);
  const tui = new Container();
  tui.addChild(document);
  const dispose = enabled ? installAssistantPanels(tui, {
    theme: () => themes.theme, requestRender() {}, warn: message => assert.fail(message),
  }) : () => {};
  return { render: width => document.render(width), dispose };
}

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

test("printable ASCII panels skip segmentation while Unicode stays grapheme-aware and source controls are sanitized", () => {
  const segment = Intl.Segmenter.prototype.segment;
  let calls = 0;
  const inputs = [];
  Intl.Segmenter.prototype.segment = function (value) { calls++; inputs.push(value); return segment.call(this, value); };
  try {
    const f = fixture();
    const rows = ["", "    a  b\tc  ", "` [literal](path) ~", "a".repeat(100_000)];
    const source = "~~~~text\n" + rows.join("\n") + "\n~~~~";
    const transformed = f.transform(source, { availableWidth: 12 });
    assert.equal(calls, 0, "ASCII wrapping performs no per-character segmentation");
    assert.doesNotMatch(transformed, /~~~~text/);
    for (const width of [1, 2, 3, 4, 12, 40]) {
      const padding = width >= 4 ? 1 : 0;
      const available = Math.max(1, width - padding * 2);
      const row = "  a\tb  ` ]](path) trailing  ".replace(/\t/g, "   ");
      const rendered = f.transform("~~~~text\n" + row + "\n~~~~", { availableWidth: width }).split("\n").filter(Boolean)
        .map(line => stripVTControlCharacters(/^(`+) ([\s\S]*) \1$/.exec(line)[2]));
      const expected = [];
      for (let offset = 0; offset < row.length; offset += available) {
        expected.push(" ".repeat(padding) + row.slice(offset, offset + available).padEnd(width - padding));
      }
      assert.deepEqual(rendered, expected, `literal ASCII output at width ${width}`);
    }
    inputs.length = 0;
    const sanitized = f.transform("```text\n中文 é 👩‍💻\n\u001b[0mcontrol\n```", { availableWidth: 12 });
    assert.ok(inputs.includes("中文 é 👩‍💻"), "Unicode retains grapheme-aware processing");
    assert.ok(!inputs.includes("\u001b[0mcontrol"), "source controls are stripped before wrapping, as on master");
    assert.ok(stripVTControlCharacters(sanitized).includes("control"), "sanitizing controls retains literal text");
    inputs.length = 0;
    const code = '{"name": "a   b", "count": 42, "ok": true}';
    f.transform("```json\n" + code + "\n```", { availableWidth: 12 });
    assert.ok(!inputs.includes(code), "highlighted ASCII walks style state without segmenting its source");
  } finally { Intl.Segmenter.prototype.segment = segment; }
});

test("ordinary Markdown without candidate fences skips line splitting", () => {
  const f = fixture();
  const source = "ordinary prose\n".repeat(1000);
  const split = String.prototype.split;
  let splits = 0;
  String.prototype.split = function (...args) {
    if (this.valueOf() === source) splits++;
    return split.apply(this, args);
  };
  try {
    assert.equal(f.transform(source), source);
    assert.equal(splits, 0);
  } finally { String.prototype.split = split; }
});

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

test("Mermaid, nested/list/quote fences, raw HTML and thinking retain native rendering", () => {
  const f = fixture();
  const excluded = [
    "```mermaid\ngraph TD; A-->B\n```", "~~~MERMAID title=flow\ngraph TD; A-->B\n~~~",
    "  ```text\n  nested\n  ```", " ```json\n {\"nested\": true}\n ```",
    "    ```js\n    const nested = true;\n    ```",
    "> ```text\n> quoted\n> ```", "> ```json\n> {}\n> ```",
    "- item\n  ```json\n  {}\n  ```", "1. item\n   ~~~js\n   const nested = 1;\n   ~~~",
    "<pre>\n\n```json\n{}\n```\n</pre>", "<!--\n```text\nliteral\n```\n-->",
    "<script>\n```js\nconst literal = 1;\n```\n</script>",
    "<div>\n```json\n{}\n```\n</div>", "<custom>\n```json\n{}\n```\n</custom>",
  ];
  for (const text of excluded) {
    assert.equal(f.transform(text), text, text);
    assert.deepEqual(f.markdown(text).render(80), new Markdown(text, 0, 0, themes.getMarkdownTheme()).render(80), text);
  }
  const thinking = "```json\n{\"thinking\": true}\n```\n\n" + source;
  assert.equal(f.transform(thinking, { messageType: "assistant-thinking" }), thinking);
  const message = { role: "assistant", content: [{ type: "thinking", thinking }], stopReason: "stop" };
  assert.deepEqual(
    new AssistantMessageComponent(message, false, themes.getMarkdownTheme(), "Thinking...", 0, [f.transformer]).render(80),
    new AssistantMessageComponent(message, false, themes.getMarkdownTheme(), "Thinking...", 0).render(80),
  );
});

test("a list-prefixed fence does not swallow the following top-level panel", () => {
  const f = fixture();
  const list = "- ```js\n  const a = 1;\n  ```";
  const text = list + "\n\n```text\ntop-level\n```";
  const transformed = f.transform(text);
  assert.ok(transformed.startsWith(list + "\n"), "list source remains byte-for-byte native");
  assert.doesNotMatch(transformed, /```text/);
  const rendered = f.markdown(text).render(80);
  const panelRow = rendered.find(line => stripVTControlCharacters(line).trim() === "top-level");
  assertSolidBackground(panelRow, 80);
  assert.ok(rendered.some(line => stripVTControlCharacters(line).includes("const a = 1;")));
});

for (const [kind, nested] of [["quote", "> ```js\n> nested"], ["list", "- ```js\n  nested"]]) {
  test(`an unclosed ${kind} fence stops at its container instead of swallowing a later top-level panel`, () => {
    const f = fixture();
    const text = nested + "\n\n```text\nTOP-LEVEL\n```";
    const transformed = f.transform(text);
    assert.ok(transformed.startsWith(nested + "\n\n"), "nested source is byte-for-byte unchanged");
    assert.doesNotMatch(transformed, /```text/, "container exit allows the next top-level panel");
    const nestedNative = new Markdown(nested, 0, 0, themes.getMarkdownTheme()).render(80);
    for (const isStreaming of [true, false]) {
      const rendered = f.markdown(text, { isStreaming }).render(80);
      const top = rendered.findIndex(row => stripVTControlCharacters(row).trim() === "TOP-LEVEL");
      assert.ok(top >= 0, `${nested}/${isStreaming}`);
      assertSolidBackground(rendered[top], 80);
      // Only native inter-block blank rows may differ before the new panel.
      assert.deepEqual(rendered.slice(0, top).filter(row => stripVTControlCharacters(row).trim()),
        nestedNative.filter(row => stripVTControlCharacters(row).trim()), "nested code retains exact native styling");
    }
  });
}

test("assistant JSON and code retain Pi syntax foregrounds over a solid panel in both themes", () => {
  const f = fixture();
  const cases = [
    ["json", '{"name": "tree", "count": 42, "ok": true, "nil": null}'],
    ["ts", 'const label: string = "hello"; // comment'],
    ["python", 'def greet(name): return "hello"'],
  ];
  try {
    for (const appearance of ["dark", "light"]) {
      themes.initTheme(appearance, false);
      for (const [language, body] of cases) {
        const text = `before\n\n\`\`\`${language} title=ignored\n${body}\n\`\`\`\n\nafter`;
        for (const conversationPanels of [false, true]) {
          const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
          const component = new AssistantMessageComponent(message, false, themes.getMarkdownTheme(), "Thinking...", 0, [f.transformer]);
          const surface = conversationSurface(component, conversationPanels);
          try {
            const rendered = surface.render(100);
            const row = rendered.find(line => stripVTControlCharacters(line).trim() === body);
            assert.ok(row, JSON.stringify({ language, appearance, conversationPanels, rendered: rendered.map(stripVTControlCharacters) }));
            assertSolidBackground(row, 100);
            const expected = styledCharacters(themes.highlightCode(body, language)[0]);
            const actual = styledCharacters(row).slice(1, 1 + [...body].length);
            const highlighted = expected.filter(cell => cell.fg !== undefined);
            assert.ok(new Set(highlighted.map(cell => cell.fg)).size >= 2, "fixture exercises distinct syntax colors");
            for (let i = 0; i < expected.length; i++) {
              assert.equal(actual[i]?.character, expected[i].character);
              if (expected[i].fg !== undefined) assert.equal(actual[i]?.fg, expected[i].fg, `${appearance}/${language}/${conversationPanels}/${i}`);
            }
            const label = rendered.find(line => stripVTControlCharacters(line).trim().toLowerCase() === language);
            assert.ok(label, "named non-plaintext blocks have a language-only label");
            assertSolidBackground(label, 100);
            assert.doesNotMatch(rendered.map(stripVTControlCharacters).join("\n"), /```|title=ignored/);
          } finally { surface.dispose(); }
        }
      }
    }
  } finally { themes.initTheme("dark", false); }
});

test("language info strings select only the first word; aliases, unknown and unlabeled blocks stay literal", () => {
  const f = fixture();
  const body = "  **literal** \\[x\\] $x^2$ ]](path) `inline` └── 中文 👩‍💻 é   ";
  for (const [opening, closing, language] of [
    ["```json title=sample", "```", "json"],
    ["~~~~js linenos", "~~~~~", "js"],
    ["`````made-up-lang file=tree", "``````", "made-up-lang"],
    ["```", "```", undefined],
    ["~~~   ", "~~~~", undefined],
    ["```TEXT title=sample", "```", undefined],
    ["~~~plaintext extra", "~~~", undefined],
    ["````txt", "`````", undefined],
  ]) {
    const rendered = f.markdown(`${opening}\r\n${body}\r\n${closing}`).render(100);
    const row = rendered.find(line => stripVTControlCharacters(line) === " " + body + " ".repeat(99 - visibleWidth(body)));
    assert.ok(row, opening);
    assertSolidBackground(row, 100);
    const otherRows = rendered.map(stripVTControlCharacters).filter(line => line.trim() && !line.includes(body));
    assert.deepEqual(otherRows.map(line => line.trim().toLowerCase()), language ? [language] : [], opening);
    assert.doesNotMatch(rendered.map(stripVTControlCharacters).join("\n"), /title=sample|file=tree|linenos|```|~~~~/);
    if (opening.includes("made-up") || !language) {
      const foregrounds = new Set(styledCharacters(row).filter(cell => cell.character.trim()).map(cell => cell.fg));
      assert.equal(foregrounds.size, 1, "unknown, unlabeled, and explicit plaintext do not guess syntax highlighting");
    }
  }
  // An outer code fence must protect apparent inner Markdown fences as literal code.
  const nestedExample = "`````unknown\n```text\n**literal** $x^2$\n```\n`````";
  const rendered = plain(f.markdown(nestedExample));
  assert.ok(rendered.some(line => line.trim() === "```text"));
  assert.ok(rendered.some(line => line.trim() === "**literal** $x^2$"));
  assert.ok(rendered.some(line => line.trim() === "```"));
});

test("user code remains byte-for-byte native except existing explicit plaintext panels", () => {
  const f = fixture();
  for (const text of ["```json\n{\"user\": true}\n```", "```js title=demo\nconst user = 1;\n```", "```\n**raw**\n```", "~~~unknown\nraw\n~~~", "```text extra\nraw\n```", "```mermaid\ngraph TD; A-->B\n```", "  ```text\n  nested\n  ```"]) {
    assert.equal(f.transform(text, { messageType: "user" }), text, text);
    const actual = new UserMessageComponent(text, themes.getMarkdownTheme(), 0, [f.transformer]);
    const native = new UserMessageComponent(text, themes.getMarkdownTheme(), 0);
    assert.deepEqual(actual.render(80), native.render(80), text);
  }
  for (const language of ["text", "plaintext", "txt", "TEXT"]) {
    const text = `\`\`\`${language}\n  user tree\n\`\`\``;
    const actual = new UserMessageComponent(text, themes.getMarkdownTheme(), 0, [f.transformer]);
    assert.doesNotMatch(plain(actual, 80).join("\n"), /```/);
    const row = actual.render(80).find(line => stripVTControlCharacters(line).trim() === "user tree");
    assertSolidBackground(row, 80);
  }
});

test("highlighted hard wrapping retains repeated and trailing spaces instead of word-wrapping them away", () => {
  const f = fixture();
  const body = '{"a":  1,   "b": "a   b"}   ';
  for (const language of ["json", "unknown", "text", ""]) {
    for (const width of [1, 2, 3, 4, 5, 8, 12]) {
      const available = width >= 4 ? width - 2 : width;
      const padding = width >= 4 ? " " : "";
      const chunks = body.match(new RegExp(`.{1,${available}}`, "g"));
      const expected = chunks.map(chunk => (padding + chunk).padEnd(width));
      const rendered = f.markdown(`\`\`\`${language}\n${body}\n\`\`\``).render(width);
      const panelRows = rendered.filter(line => styledCharacters(line).some(cell => cell.bg !== undefined));
      const bodyRows = language && language !== "text" ? panelRows.slice(1) : panelRows;
      assert.deepEqual(bodyRows.map(stripVTControlCharacters), expected, `${language || "unlabeled"}/${width}`);
      for (const row of panelRows) assertSolidBackground(row, width);
    }
  }
});

test("syntax ANSI boundaries preserve a combining grapheme in streaming/final assistant rows and across wraps", () => {
  const f = fixture();
  const body = "return\u0301";
  const panels = [];
  // Pi highlights `return` separately from its combining mark. Wrapping must
  // segment the visible grapheme, not the intervening highlighter SGR/reset.
  for (const [width, chunks] of [[80, [body]], [8, [body]], [7, ["retur", "n\u0301"]]]) {
    const expected = chunks.map(chunk => " " + chunk + " ".repeat(width - 1 - visibleWidth(chunk)));
    const initial = { role: "assistant", content: [{ type: "text", text: "```js\nreturn" }], stopReason: "stop" };
    const component = new AssistantMessageComponent(initial, false, themes.getMarkdownTheme(), "Thinking...", 0, [f.transformer]);
    component.updateContent(initial, true);
    component.render(width); // The combining mark arrives after the base word.
    for (const isStreaming of [true, false]) {
      const text = "```js\n" + body + (isStreaming ? "" : "\n```");
      const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
      const original = structuredClone(message);
      component.updateContent(message, isStreaming);
      const rendered = component.render(width);
      const panelRows = rendered.filter(row => /\x1b\[48;[25];/.test(row));
      assert.equal(stripVTControlCharacters(panelRows[0]).trim(), "js");
      assert.deepEqual(panelRows.slice(1).map(stripVTControlCharacters), expected, `${width}/${isStreaming}: accent stays attached to n`);
      panels.push({ rows: panelRows, width });
      assert.deepEqual(message, original);
    }
  }
  for (const { rows, width } of panels) for (const row of rows) assertSolidBackground(row, width);
});

test("long single-line JSON wraps with bounded ANSI output and renders through the actual assistant", () => {
  const f = fixture();
  const panels = [];
  const payload = count => JSON.stringify(Array.from({ length: count }, (_, id) => ({ id, ok: true })));
  const boundedTransform = (body, width) => {
    const text = `\`\`\`json\n${body}\n\`\`\``;
    const transformed = f.transform(text, { availableWidth: width });
    // Generous linear allowance for syntax colors, per-row state and Markdown
    // protection. Replaying all prefix ANSI at every wrap exceeds this quickly.
    assert.ok(transformed.length <= body.length * 100 + 8192,
      `${body.length} source characters at width ${width} produced ${transformed.length} transformed characters`);
    return { text, size: transformed.length };
  };

  // Fail cheaply before exercising the former multi-megabyte/RangeError cases.
  // These sizes differ by 2x; quadratic prefix replay grows by approximately 4x.
  const small = boundedTransform(payload(40), 20).size;
  const doubled = boundedTransform(payload(80), 20).size;
  assert.ok(doubled <= small * 2.75, `doubling the input grew ANSI output from ${small} to ${doubled}`);

  const spaced = "  " + JSON.stringify(Array.from({ length: 400 }, (_, id) => ({ id, ok: true, label: "a   b" }))) + "   ";
  for (const [body, width] of [[payload(400), 20], [payload(800), 80], [spaced, 80]]) {
    const { text } = boundedTransform(body, width);
    const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
    const original = structuredClone(message);
    const component = new AssistantMessageComponent(message, false, themes.getMarkdownTheme(), "Thinking...", 0, [f.transformer]);
    let rendered;
    assert.doesNotThrow(() => { rendered = component.render(width); }, `${body.length} source characters at width ${width}`);
    assert.ok(rendered.reduce((size, row) => size + row.length, 0) <= body.length * 120 + 16384,
      "the host-rendered ANSI output remains bounded too");
    const panelRows = rendered.filter(row => /\x1b\[48;[25];/.test(row));
    assert.equal(stripVTControlCharacters(panelRows[0]).trim(), "json");
    const available = width - 2;
    const expected = Array.from({ length: Math.ceil(body.length / available) }, (_, index) =>
      (" " + body.slice(index * available, (index + 1) * available)).padEnd(width));
    assert.deepEqual(panelRows.slice(1).map(stripVTControlCharacters), expected,
      "every plain chunk, repeated source space and row-padding space survives");
    panels.push({ rows: panelRows, width });
    assert.deepEqual(message, original);
  }
  for (const { rows, width } of panels) for (const row of rows) assertSolidBackground(row, width);
});

test("language labels are literal-protected, not Markdown/math, and fit narrow rows", () => {
  const f = fixture();
  for (const language of ["**literal**", "[link](path)", "$x^2$", "]](path)", "wide-中文-👩‍💻"]) {
    const text = `~~~${language} ignored-title\nbody\n~~~`;
    const rendered = f.markdown(text).render(80);
    const label = rendered.find(line => stripVTControlCharacters(line).trim() === language);
    assert.ok(label, language);
    assertSolidBackground(label, 80);
    assert.doesNotMatch(rendered.map(stripVTControlCharacters).join("\n"), /ignored-title/);
    for (const width of [1, 2, 4, 8, 12]) {
      const rows = f.markdown(text).render(width);
      assert.ok(rows.every(row => visibleWidth(row) <= width), `${language}/${width}`);
    }
  }
});

test("literal ANSI resets cannot break solid code-panel backgrounds", () => {
  const f = fixture();
  try {
    for (const appearance of ["dark", "light"]) {
      themes.initTheme(appearance, false);
      for (const language of ["text", "unknown", "js"]) {
        const body = "left \x1b[0m right \x1b[39m middle \x1b[49m end";
        const rows = f.markdown(`\`\`\`${language}\n${body}\n\`\`\``).render(70);
        const row = rows.find(line => stripVTControlCharacters(line).includes("left"));
        assert.equal(stripVTControlCharacters(row).trim(), "left  right  middle  end");
        assertSolidBackground(row, 70);
      }
    }
  } finally { themes.initTheme("dark", false); }
});

test("streaming openings wait for an info line; partial closings hide only until the message is final", () => {
  const f = fixture();
  for (const opening of ["`", "``", "```", "```j", "```json title=", "~~~", "~~~~text"]) {
    assert.equal(f.transform(opening, { isStreaming: true }), opening, "wait for a complete opening info line");
    assert.deepEqual(f.markdown(opening, { isStreaming: true }).render(50), new Markdown(opening, 0, 0, themes.getMarkdownTheme()).render(50));
  }
  for (const [marker, language] of [["```", "text"], ["```", "json title=demo"], ["~~~~", "unknown"], ["`````", ""]]) {
    for (const eol of ["\n", "\r\n"]) {
      for (const closingSize of [0, 1, 2, marker.length - 1, marker.length, marker.length + 1]) {
        const ending = eol + marker[0].repeat(closingSize);
        const text = marker + language + eol + "  root" + eol + "  └── child" + ending;
        const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
        const component = new AssistantMessageComponent(message, false, themes.getMarkdownTheme(), "Thinking...", 0, [f.transformer]);
        component.updateContent(message, true);
        const rendered = plain(component, 50).join("\n");
        assert.ok(rendered.includes("   root"));
        assert.ok(rendered.includes("   └── child"));
        assert.doesNotMatch(rendered, /`|~/);
        if (closingSize > 0 && closingSize < marker.length) {
          component.updateContent(message, false);
          assert.ok(plain(component, 50).some(line => line.trim() === marker[0].repeat(closingSize)), "final literal fence glyphs are restored");
        }
      }
      assert.doesNotMatch(plain(f.markdown(marker + language + eol, { isStreaming: true })).join("\n"), /`|~/);
    }
  }
});

test("streaming partial closing markers accept allowed indentation and trailing whitespace", () => {
  const f = fixture();
  for (const marker of ["```", "~~~~"]) {
    for (let size = 1; size < marker.length; size++) {
      for (const [indent, trailing] of [["", " "], [" ", "\t"], ["   ", "  \t"]]) {
        const last = indent + marker[0].repeat(size) + trailing;
        const text = `${marker}unknown\nroot\n${last}`;
        const streamed = plain(f.markdown(text, { isStreaming: true }), 40).join("\n");
        assert.doesNotMatch(streamed, /`|~/, JSON.stringify(last));
        const final = plain(f.markdown(text), 40);
        const expanded = last.replace(/\t/g, "   ");
        assert.ok(final.includes(" " + expanded + " ".repeat(39 - visibleWidth(expanded))), JSON.stringify(last));
      }
    }
    const completed = plain(f.markdown(`${marker}unknown\nroot\n   ${marker} \t`, { isStreaming: true }), 40).join("\n");
    assert.doesNotMatch(completed, /`|~/);
  }
});

test("hard wraps without dropping spaces, changes width and theme without stale styling", () => {
  const f = fixture();
  const text = "```text\n    a  b  c  d  e  f\n└── 👩‍💻 中文 é\n```";
  const backgrounds = [];
  for (const appearance of ["light", "dark"]) {
    themes.initTheme(appearance, false);
    const component = f.markdown(text);
    for (const width of [1, 2, 3, 4, 5, 8, 12, 40, 100]) {
      const rendered = component.render(width);
      const nativeLimit = Math.max(width, ...new Markdown("👩‍💻 中文", 0, 0, themes.getMarkdownTheme()).render(width).map(visibleWidth));
      assert.deepEqual(rendered.filter(line => visibleWidth(line) > nativeLimit).map(stripVTControlCharacters), [], `panel rows must not exceed native grapheme constraints at width ${width}`);
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

test("highlighted and fallback panels resize to one/two columns and retain wide graphemes when they fit", () => {
  const f = fixture();
  try {
    for (const appearance of ["dark", "light"]) {
      themes.initTheme(appearance, false);
      for (const language of ["json", "unknown", ""]) {
        const body = '  {"glyphs": "👩‍💻 中文 é", "n": 42}   ';
        const component = f.markdown(`\`\`\`${language}\n${body}\n\`\`\``);
        for (const width of [1, 2, 3, 4, 5, 8, 12, 40, 100, 2, 80]) {
          const rendered = component.render(width);
          const nativeLimit = Math.max(width, ...new Markdown("👩‍💻 中文", 0, 0, themes.getMarkdownTheme()).render(width).map(visibleWidth));
          assert.deepEqual(rendered.filter(line => visibleWidth(line) > nativeLimit).map(stripVTControlCharacters), [], `${appearance}/${language || "unlabeled"}: no overflow beyond native grapheme constraints at width ${width}`);
          assert.doesNotMatch(rendered.map(stripVTControlCharacters).join("\n"), /```/);
          assert.doesNotMatch(rendered.map(stripVTControlCharacters).join("\n"), /\ufffd/);
        }
        const row = component.render(100).find(line => stripVTControlCharacters(line).includes("glyphs"));
        assert.equal(stripVTControlCharacters(row), " " + body + " ".repeat(99 - visibleWidth(body)));
        assertSolidBackground(row, 100);
      }
    }
    themes.initTheme("dark", false);
    const component = f.markdown('```json\n{"live": true, "n": 42}\n```');
    const dark = component.render(80);
    themes.initTheme("light", false);
    component.invalidate();
    const light = component.render(80);
    assert.notDeepEqual(light, dark, "one existing component picks up a live theme change");
    assert.deepEqual(light.map(stripVTControlCharacters), dark.map(stripVTControlCharacters));
    const lightBody = light.find(line => stripVTControlCharacters(line).includes('"live"'));
    const darkBody = dark.find(line => stripVTControlCharacters(line).includes('"live"'));
    assert.notEqual(styledCharacters(lightBody)[0].bg, styledCharacters(darkBody)[0].bg);
  } finally { themes.initTheme("dark", false); }
});

test("real assistant and user components use supported transform without transcript mutation", () => {
  const f = fixture();
  const transcriptText = source + '\n\n```json title=example\n{"name": "tree", "count": 42}\n```\n\n```unknown\n**literal** $x^2$\n```';
  const message = { role: "assistant", content: [{ type: "text", text: transcriptText }], stopReason: "stop" };
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

test("native assistant trimming and tiny output padding remain host-owned, without rewriting the message", () => {
  const f = fixture();
  const text = "```unknown\nline   \n\n";
  const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
  const original = structuredClone(message);
  const seen = [];
  const transformer = (markdown, context) => { seen.push(markdown); return f.transformer(markdown, context); };
  const component = new AssistantMessageComponent(message, false, themes.getMarkdownTheme(), "Thinking...", 0, [transformer]);
  component.render(80);
  assert.equal(seen[0], text.trim(), "Pi trims assistant text before calling the display transformer");
  assert.deepEqual(message, original, "saved/model-facing text remains untouched despite host display trimming");
  const glyphText = '```json\n{"glyphs": "👩‍💻 中文 é"}\n```';
  for (const padding of [0, 1, 2]) {
    for (const width of [1, 2, 3, 4, 8, 20]) {
      const message = { role: "assistant", content: [{ type: "text", text: glyphText }], stopReason: "stop" };
      const native = new AssistantMessageComponent(message, false, themes.getMarkdownTheme(), "Thinking...", padding);
      const styled = new AssistantMessageComponent(message, false, themes.getMarkdownTheme(), "Thinking...", padding, [f.transformer]);
      const nativeLimit = Math.max(width, ...native.render(width).map(visibleWidth));
      assert.ok(styled.render(width).every(row => visibleWidth(row) <= nativeLimit), `${padding}/${width}: no extra overflow beyond native output padding/graphemes`);
    }
  }
});

test("registration is runtime-local, mode guarded, disabled cleanly and released on shutdown", async () => {
  const disabled = fixture(false);
  assert.equal(disabled.handlers.size, 0);
  assert.equal(disabled.transformer, undefined);
  const sources = [source, '```json\n{"count": 42}\n```', "```unknown\nraw\n```", "```\nunlabeled\n```"];
  for (const text of sources) {
    assert.equal(disabled.transform(text), text);
    for (const mode of ["rpc", "json", "print"]) assert.equal(fixture(true, mode).transform(text), text);
  }
  const f = fixture();
  assert.notEqual(f.transform(source), source);
  await f.handlers.get("session_shutdown")({}, f.ctx);
  await f.handlers.get("session_shutdown")({}, f.ctx);
  for (const text of sources) assert.equal(f.transform(text), text);
  await f.handlers.get("session_start")({}, f.ctx);
  assert.notEqual(f.transform(source), source);
  const loaded = await loadExtensionFromFactory(pi => registerTextPanels(pi, true), process.cwd(), createEventBus(), createExtensionRuntime());
  assert.equal(loaded.tools.size, 0);
  assert.equal(loaded.commands.size, 0);
  assert.deepEqual([...loaded.handlers.keys()], ["session_start", "session_shutdown"]);
  // Resolve the registration through the host, just as the real transcript does.
  const transformers = ExtensionRunner.prototype.getMarkdownTransformers.call({ extensions: [loaded] });
  assert.equal(transformers.length, 1);
  assert.equal(typeof transformers[0], "function");
  await loaded.handlers.get("session_start")[0]({}, f.ctx);
  const message = { role: "assistant", content: [{ type: "text", text: source }], stopReason: "stop" };
  const component = new AssistantMessageComponent(message, false, themes.getMarkdownTheme(), "Thinking...", 0, transformers);
  assert.doesNotMatch(plain(component, 80).join("\n"), /```/);
  await loaded.handlers.get("session_shutdown")[0]({}, f.ctx);
  assert.equal(transformers[0](source, { messageType: "assistant", isStreaming: false, availableWidth: 80 }), source);
});
