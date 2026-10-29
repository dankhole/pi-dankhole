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
const local = name => jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styling/" + name));
const { installAssistantPanels, registerAssistantPanels } = await local("assistant-panels.ts");
const { installGrouping, getChildLineOffset } = await local("grouping.ts");
const { installPinnedPrompt } = await local("pinned-prompt.ts");
const { freshTranscriptChildren, registerTranscriptRenderer } = await local("transcript-measurement.ts");
const { registerTextPanels } = await local("text-panels.ts");
const { assistantBackground, conversationProse, userBackground } = await local("palette.ts");
const { Container, Markdown, MouseRegion, ScrollView, Spacer, Text, VStack, backgroundAnsi, colorToRgb, mixColors, parseColor, visibleWidth } = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
const { AssistantMessageComponent } = await fromPi("dist/modes/interactive/components/assistant-message.js");
const { UserMessageComponent } = await fromPi("dist/modes/interactive/components/user-message.js");
const { ToolExecutionComponent } = await fromPi("dist/modes/interactive/components/tool-execution.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
themes.initTheme("dark", false);
// A native zero-width Spacer becomes a filled blank buffer; its textual content
// remains empty. Keep nonblank text (including code whitespace) byte-for-byte.
const plain = lines => lines.map(stripVTControlCharacters).map(line => line.trim() ? line : "");
const text = text => ({ type: "text", text });
const thinking = thinking => ({ type: "thinking", thinking });
const toolCall = { type: "toolCall", id: "call", name: "read", arguments: {} };
const message = (content, extra = {}) => ({ role: "assistant", content, stopReason: "stop", ...extra });
const assistant = (content, hidden = false, extra = {}) => new AssistantMessageComponent(message(content, extra), hidden);
const fill = () => assistantBackground(themes.theme);
function contrastAt(line, sample) {
  assert.ok(line.includes(sample));
  let fg, bg;
  for (const match of line.slice(0, line.indexOf(sample)).matchAll(/\x1b\[([\d;]*)m/g)) {
    const codes = match[1].split(";").map(Number);
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index];
      if (code === 0) fg = bg = undefined;
      else if (code === 39) fg = undefined;
      else if (code === 49) bg = undefined;
      else if (code === 38 || code === 48) {
        const mode = codes[++index];
        const color = mode === 5 ? colorToRgb(parseColor(codes[++index])) : { r: codes[++index], g: codes[++index], b: codes[++index] };
        if (code === 38) fg = color; else bg = color;
      }
    }
  }
  assert.ok(fg && bg, `${sample}: actual foreground/background must both be explicit`);
  const luminance = ({ r, g, b }) => [r, g, b].map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function fixture(children = []) {
  const chat = new Container();
  children.forEach(child => chat.addChild(child));
  const document = new Container();
  document.addChild(new Container());
  document.addChild(new Container());
  document.addChild(chat);
  const tui = new Container();
  tui.addChild(document);
  tui.requestRender = () => {};
  const warnings = [];
  const options = { theme: () => themes.theme, requestRender() {}, warn: value => warnings.push(value) };
  return { chat, document, tui, options, warnings, install: () => installAssistantPanels(tui, options), render: (width = 80) => document.render(width) };
}
function tool() {
  const row = new ToolExecutionComponent("read", "call", { path: "sample.txt" }, { showImages: false, outputPad: 1 }, undefined, { requestRender() {} }, process.cwd());
  row.updateResult({ content: [text("tool result")], details: undefined, isError: false });
  return row;
}

test("painted rows reuse one bounded layout and invalidate for native values, styles and explicit invalidation", () => {
  const a = assistant([text("payload")]);
  const md = a.contentContainer.children.find(child => child instanceof Markdown);
  const native = ["payload"];
  md.render = () => native;
  const originalRender = md.render;
  const originalInvalidate = md.invalidate;
  const f = fixture([a]);
  const previous = process.env.NO_COLOR;
  const dispose = f.install();
  try {
    const first = md.render(80);
    for (let repeat = 0; repeat < 20; repeat++) assert.equal(md.render(80), first, "unchanged rows are not decorated/allocated again");
    assert.equal(md.render(0), native);
    assert.equal(md.render(80), first, "zero-width height probes do not evict painted rows");
    const bottom = a.contentContainer.children.at(-1);
    const buffer = bottom.render(80);
    f.render(80);
    assert.equal(bottom.render(80), buffer, "reconciliation does not repaint unchanged buffer spacers");
    assert.deepEqual(native, ["payload"], "native arrays are never painted in place");
    native[0] = "updated";
    const updated = md.render(80);
    assert.notEqual(updated, first, "same-array mutation is observed");
    assert.match(updated[0], /updated/);
    native.push("second row");
    assert.equal(md.render(80).length, 2);
    const beforeInvalidate = md.render(80);
    md.invalidate();
    assert.notEqual(md.render(80), beforeInvalidate);
    const wide = md.render(80);
    const narrow = md.render(40);
    assert.notEqual(narrow, wide);
    assert.notEqual(md.render(80), wide, "only the current width is retained");
    const dark = md.render(80);
    themes.initTheme("light", false);
    const light = md.render(80);
    assert.notEqual(light, dark);
    assert.ok(light[0].includes(fill()));
    process.env.NO_COLOR = "";
    assert.equal(md.render(80), native);
    if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous;
    assert.notEqual(md.render(80), light, "plain output discards the painted cache");
    dispose();
    assert.equal(md.render, originalRender);
    assert.equal(md.invalidate, originalInvalidate);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous;
    dispose();
    themes.initTheme("dark", false);
  }
});

test("panel cache observes same-theme foreground/color-mode changes and native Markdown invalidation", () => {
  const a = assistant([text("answer")]);
  const f = fixture([a]);
  let foreground = "\x1b[38;2;1;2;3m";
  let mode = "truecolor";
  const theme = new Proxy(themes.theme, { get(target, key) {
    if (key === "getFgAnsi") return () => foreground;
    if (key === "getColorMode") return () => mode;
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  f.options.theme = () => theme;
  const dispose = f.install();
  const md = a.contentContainer.children.find(child => child instanceof Markdown);
  try {
    const first = md.render(80);
    foreground = "\x1b[38;2;4;5;6m";
    const recolored = md.render(80);
    assert.notEqual(recolored, first);
    assert.ok(recolored[0].includes(foreground));
    mode = "256color";
    const limited = md.render(80);
    assert.notEqual(limited, recolored);
    assert.ok(limited[0].includes(assistantBackground(theme)));
    md.setText("same component, changed source");
    const changed = md.render(80);
    assert.notEqual(changed, limited);
    assert.match(changed[0], /changed source/);
  } finally { dispose(); }
});

test("panel cache teardown retains foreign invalidation ownership", () => {
  const a = assistant([text("answer")]);
  const f = fixture([a]);
  const dispose = f.install();
  const md = a.contentContainer.children.find(child => child instanceof Markdown);
  const foreign = () => {};
  md.invalidate = foreign;
  dispose();
  assert.equal(md.invalidate, foreign);
});

test("conversation surfaces tint native user padding and assistant prose/buffers, not thinking/tools/custom", () => {
  const a = assistant([thinking("private reasoning"), text("answer one"), toolCall, thinking("more reasoning"), text("answer two")]);
  const user = new UserMessageComponent("user input");
  const t = tool();
  const custom = new Text("custom message", 0, 0);
  const f = fixture([user, a, t, custom]);
  const native = f.render();
  const userBefore = user.render(80);
  const toolBefore = t.render(80);
  const children = [...a.contentContainer.children];
  const mouseBefore = a.handleMouse;
  const dispose = f.install();
  const rendered = f.render();
  assert.equal(rendered.length, native.length + 2);
  const bottom = plain(rendered).findIndex(line => line.includes("answer two")) + 1;
  assert.ok(rendered[bottom].includes(fill()));
  assert.equal(stripVTControlCharacters(rendered[bottom]), " ".repeat(80));
  const gap = plain(rendered).findIndex(line => line.includes("answer one")) - 2;
  assert.equal(stripVTControlCharacters(rendered[gap]), "");
  assert.doesNotMatch(rendered[gap], /\x1b\[48;/);
  const aligned = rendered.filter((_, index) => index !== bottom && index !== gap);
  assert.deepEqual(plain(aligned), plain(native));
  const firstAnswer = plain(native).findIndex(line => line.includes("answer one"));
  for (let i = 0; i < native.length; i++) {
    if (i < userBefore.length) {
      assert.ok(aligned[i].includes(userBackground(themes.theme)));
      assert.equal(visibleWidth(aligned[i]), 80);
    } else if (i === firstAnswer - 1 || /answer (one|two)/.test(stripVTControlCharacters(native[i]))) {
      assert.ok(aligned[i].includes(fill()));
      assert.equal(visibleWidth(aligned[i]), 80);
    } else assert.equal(aligned[i], native[i], JSON.stringify(plain([native[i]])));
  }
  assert.deepEqual(plain(user.render(80)), plain(userBefore));
  assert.equal(user.render(80).length, userBefore.length, "native user padding is not increased");
  assert.deepEqual(t.render(80), toolBefore);
  assert.deepEqual(a.contentContainer.children.filter(child => children.includes(child)), children);
  assert.equal(a.handleMouse, mouseBefore);
  // Native thinking MouseRegion still toggles, at exactly the same line offset.
  const y = plain(a.render(80)).findIndex(line => line.includes("private reasoning"));
  assert.equal(a.handleMouse({ type: "click", button: "left", x: 2, y, width: 80, height: 20 })?.handled, true);
  const toggled = f.render();
  assert.ok(plain(toggled).some(line => line.includes("Thinking...")));
  assert.ok(toggled.find(line => line.includes("answer one")).includes(fill()));
  assert.ok(!toggled.find(line => line.includes("Thinking...")).includes(fill()));
  assert.equal(f.warnings.length, 0);
  dispose();
});

test("user green and assistant blue surfaces follow active appearances without changing the native theme", () => {
  try {
    for (const appearance of ["dark", "light"]) {
      themes.initTheme(appearance, false);
      const nativeUserBg = themes.theme.getBgAnsi("userMessageBg");
      const user = new UserMessageComponent("readable input");
      const f = fixture([user, assistant([text("readable answer")])]);
      const dispose = f.install();
      const lines = f.render();
      assert.ok(lines.find(line => line.includes("readable input")).includes(userBackground(themes.theme)));
      assert.ok(lines.find(line => line.includes("readable answer")).includes(fill()));
      assert.notEqual(userBackground(themes.theme), fill());
      assert.equal(themes.theme.getBgAnsi("userMessageBg"), nativeUserBg, "global/native theme is not mutated");
      dispose();
      assert.ok(user.render(80).some(line => line.includes(nativeUserBg)));
    }
  } finally { themes.initTheme("dark", false); }
});

test("one neutral gap plus blue top/bottom buffers use native layout without cache/mouse drift", () => {
  const a = assistant([thinking("thinking above"), text("first answer"), text("second answer"), thinking("thinking below")]);
  const f = fixture([a]);
  const before = f.render();
  const children = [...a.contentContainer.children];
  const nativeMouse = a.handleMouse;
  const dispose = f.install();
  for (let repeat = 0; repeat < 4; repeat++) {
    const lines = f.render();
    const first = plain(lines).findIndex(line => line.includes("first answer"));
    assert.equal(lines.length, before.length + 2);
    assert.equal(stripVTControlCharacters(lines[first - 2]), "");
    assert.doesNotMatch(lines[first - 2], /\x1b\[48;/);
    assert.equal(stripVTControlCharacters(lines[first - 1]), " ".repeat(80));
    assert.ok(lines[first - 1].includes(fill()));
    const last = plain(lines).findIndex(line => line.includes("second answer"));
    assert.equal(stripVTControlCharacters(lines[last + 1]), " ".repeat(80));
    assert.ok(lines[last + 1].includes(fill()));
    assert.equal(lines.filter(line => !stripVTControlCharacters(line).trim() && line.includes(fill())).length, 2);
    assert.ok(!lines.find(line => line.includes("thinking above")).includes(fill()));
    assert.ok(!lines.find(line => line.includes("thinking below")).includes(fill()));
    assert.deepEqual(a.contentContainer.children.filter(child => children.includes(child)), children);
    assert.equal(a.contentContainer.children.length, children.length + 2);
    assert.equal(a.handleMouse, nativeMouse);
  }
  const y = plain(a.render(80)).findIndex(line => line.includes("thinking below"));
  assert.equal(y, plain(before).findIndex(line => line.includes("thinking below")) + 2, "native layout accounts for the gap and bottom row");
  assert.equal(a.handleMouse({ type: "click", button: "left", x: 2, y, width: 80, height: before.length + 2 })?.handled, true);
  assert.ok(plain(f.render()).some(line => line.includes("Thinking...")));
  a.updateContent(message([thinking("thinking only")]));
  assert.ok(!f.render().some(line => line.includes(fill())), "removed prose releases its buffer");
  assert.ok(children.every(child => !Object.hasOwn(child, "render")));
  dispose();
});

test("owned gap and bottom spacer restore the exact tree and native mouse geometry before repaint", () => {
  const a = assistant([text("answer"), thinking("trailing thinking")]);
  const user = new UserMessageComponent("unchanged user padding");
  const clicks = [];
  const neighbor = new MouseRegion(new Text("next message", 0, 0), event => { clicks.push({ y: event.y, height: event.height }); return { handled: true }; });
  const f = fixture([user, a, neighbor]);
  const nativeChildren = a.contentContainer.children;
  const originalChildren = [...nativeChildren];
  const nativeMouse = a.handleMouse;
  const native = f.render();
  const nativeOffset = getChildLineOffset(f.chat, neighbor, 80);
  const dispose = f.install();
  const rendered = f.render();
  assert.equal(rendered.length, native.length + 2);
  assert.equal(a.contentContainer.children, nativeChildren);
  const owned = nativeChildren.filter(child => !originalChildren.includes(child));
  assert.equal(owned.length, 2);
  assert.ok(owned.every(child => child instanceof Spacer), "owned padding uses native Spacers");
  assert.equal(getChildLineOffset(f.chat, neighbor, 80), nativeOffset + 2);
  assert.equal(f.chat.handleMouse({ type: "click", button: "left", x: 2, y: nativeOffset + 2, width: 80, height: rendered.length })?.handled, true);
  assert.deepEqual(clicks.pop(), { y: 0, height: 1 });
  const bottomY = plain(a.render(80)).findIndex(line => line.includes("answer")) + 1;
  assert.equal(a.handleMouse({ type: "click", button: "left", x: 2, y: bottomY, width: 80, height: a.render(80).length }), undefined, "padding is not a thinking hit target");
  dispose();
  dispose();
  assert.equal(a.contentContainer.children, nativeChildren);
  assert.deepEqual(nativeChildren, originalChildren, "cleanup removes only the owned child and preserves exact ordering/identity");
  assert.equal(a.handleMouse, nativeMouse);
  assert.ok(owned.every(child => !Object.hasOwn(child, "render")));
  // Do not render after cleanup: native Container must discard its stale height
  // cache and dispatch using the restored tree before the scheduled repaint.
  assert.equal(f.document.handleMouse({ type: "click", button: "left", x: 2, y: nativeOffset, width: 80, height: native.length })?.handled, true);
  assert.deepEqual(clicks.pop(), { y: 0, height: 1 });
  assert.deepEqual(f.render(), native);
});

test("streaming/rebuild/history release detached spacers without duplicates or empty-message padding", () => {
  const a = assistant([text("initial")]);
  const f = fixture([a]);
  let children = a.contentContainer.children;
  let original = [...children];
  const dispose = f.install();
  let owned = children.find(child => !original.includes(child));
  for (let update = 0; update < 4; update++) {
    a.updateContent(message([thinking("leading thinking"), text(`stream ${update}`), thinking("trailing thinking")]), true);
    const previousChildren = children, previousOriginal = original, previousOwned = owned;
    children = a.contentContainer.children;
    original = [...children];
    for (let repeat = 0; repeat < 3; repeat++) {
      f.render();
      assert.equal(children.length, original.length + 2);
    }
    owned = children.find(child => !original.includes(child));
    assert.deepEqual(previousChildren, previousOriginal, "detached native array also loses our old spacer");
    assert.equal(Object.hasOwn(previousOwned, "render"), false);
    assert.equal(children.filter(child => child === owned).length, 1);
  }
  for (const content of [[thinking("thinking only")], [text("  ")], [], [toolCall]]) {
    const previousChildren = children, previousOriginal = original, previousOwned = owned;
    a.updateContent(message(content));
    const emptyChildren = a.contentContainer.children;
    const nativeEmpty = [...emptyChildren];
    const rendered = f.render();
    assert.deepEqual(previousChildren, previousOriginal);
    assert.equal(Object.hasOwn(previousOwned, "render"), false);
    assert.equal(a.contentContainer.children, emptyChildren);
    assert.deepEqual(emptyChildren, nativeEmpty);
    assert.ok(!rendered.some(line => line.includes(fill())));
  }
  a.updateContent(message([text("replacement history")]));
  children = a.contentContainer.children;
  original = [...children];
  f.render();
  owned = children.find(child => !original.includes(child));
  f.chat.clear();
  f.render();
  assert.deepEqual(children, original);
  assert.equal(Object.hasOwn(owned, "render"), false);
  dispose();
});

test("user tint restores native instance fields and follows padding rebuilds/history without adding rows", () => {
  const user = new UserMessageComponent("**input** [link](https://example.com)");
  const md = user.children[0];
  const nativeTheme = md.theme;
  const nativeStyle = md.defaultTextStyle;
  const before = user.render(60);
  const f = fixture([user]);
  const dispose = f.install();
  assert.equal(user.render(60).length, before.length);
  assert.deepEqual(plain(user.render(60)), plain(before));
  const tinted = user.render(60);
  for (let repeat = 0; repeat < 4; repeat++) { f.render(60); assert.deepEqual(user.render(60), tinted); }
  assert.notEqual(md.defaultTextStyle, nativeStyle);
  assert.equal(md.defaultTextStyle.color, nativeStyle.color, "native user foreground stays native");
  assert.equal(md.theme.code, nativeTheme.code);
  assert.equal(md.theme.highlightCode, nativeTheme.highlightCode);
  user.setOutputPad(3);
  const rebuilt = user.children[0];
  f.render();
  assert.equal(md.theme, nativeTheme);
  assert.equal(md.defaultTextStyle, nativeStyle);
  assert.equal(Object.hasOwn(md, "render"), false);
  assert.ok(user.render(60).find(line => line.includes("input")).includes(userBackground(themes.theme)));
  assert.match(plain(user.render(60))[1], /^   input/);
  const currentStyle = rebuilt.defaultTextStyle;
  dispose();
  assert.notEqual(rebuilt.defaultTextStyle, currentStyle);
  assert.equal(Object.hasOwn(rebuilt, "render"), false);
  assert.equal(rebuilt.render(60).length, before.length);
  assert.ok(user.render(60).some(line => line.includes(themes.theme.getBgAnsi("userMessageBg"))));
  const second = f.install();
  const foreignTheme = { ...rebuilt.theme };
  const foreignStyle = { ...rebuilt.defaultTextStyle };
  rebuilt.theme = foreignTheme;
  rebuilt.defaultTextStyle = foreignStyle;
  second();
  assert.equal(rebuilt.theme, foreignTheme);
  assert.equal(rebuilt.defaultTextStyle, foreignStyle);
});

test("semantic limited-color repairs render in both roles without changing code/diff/image payloads", () => {
  const source = "# Heading\n\nPlain body\n\n[linked label](https://example.com)\n\n> quote\n\n- bullet\n\n`inline payload`\n\n```diff\n+ added payload\n- removed payload\n```";
  const payloadFg = "\x1b[38;2;0;128;255m", payloadBg = "\x1b[48;2;0;64;0m";
  try {
    for (const appearance of ["dark", "light"]) for (const mode of ["truecolor", "256color"]) {
      themes.setThemeInstance(themes.loadThemeFromPath(join(root, `dist/modes/interactive/theme/${appearance}.json`), mode));
      const markdownTheme = { ...themes.getMarkdownTheme(), highlightCode: code => code.split("\n").map(line => payloadFg + payloadBg + line + "\x1b[0m") };
      const user = new UserMessageComponent(source, markdownTheme);
      const a = new AssistantMessageComponent(message([text(source)]), false, markdownTheme);
      const f = fixture([user, a]);
      const before = f.render();
      const userHeight = user.render(80).length;
      const dispose = f.install();
      const after = f.render();
      assert.equal(after.length, before.length + 2);
      assert.equal(user.render(80).length, userHeight);
      assert.deepEqual(plain(after.filter((_, index) => index !== userHeight && index !== after.length - 1)), plain(before));
      for (const component of [user.children[0], a.contentContainer.children.find(child => child instanceof Markdown)]) {
        assert.equal(component.theme.code, markdownTheme.code, "inline code callback untouched");
        assert.equal(component.theme.codeBlock, markdownTheme.codeBlock);
        assert.equal(component.theme.highlightCode, markdownTheme.highlightCode, "native syntax/diff callback untouched");
      }
      for (const [role, lines, background] of [["user", user.render(80), userBackground(themes.theme)], ["assistant", a.render(80), fill()]]) {
        assert.ok(lines.find(line => line.includes("Heading")).includes(background), `${appearance}/${mode}/${role}`);
        assert.ok(lines.find(line => line.includes("Plain body")).includes(themes.theme.getFgAnsi(role === "user" ? "userMessageText" : "text")), "body foreground is explicit, not terminal-default dependent");
        assert.ok(lines.find(line => line.includes("added payload")).includes(payloadFg + payloadBg));
        assert.ok(lines.find(line => line.includes("removed payload")).includes(payloadFg + payloadBg));
        const ratios = ["Plain body", "Heading", "linked label", "quote", "bullet"].map(sample => contrastAt(lines.find(line => line.includes(sample)), sample));
        ratios.push(contrastAt(lines.find(line => line.includes("bullet")), "- "));
        assert.ok(Math.min(...ratios) >= 4.5, `${appearance}/${mode}/${role}: composited visible prose foregrounds meet 4.5:1`);
        if (process.env.PALETTE_CONTRAST_REPORT) console.log("COMPOSITED_CONVERSATION " + JSON.stringify({ appearance, mode, role, minimum: Math.min(...ratios) }));
        if (mode === "256color") {
          const repairedForeground = conversationProse(themes.theme, "link", "label").match(/\x1b\[38;5;\d+m/)[0];
          assert.ok(lines.find(line => line.includes("linked label")).includes(repairedForeground));
        }
      }
      assert.ok(a.render(80).find(line => line.includes("inline payload")).includes(themes.theme.getFgAnsi("mdCode")));
      dispose();
      assert.deepEqual(f.render(), before, "cleanup restores full native rendering");
      // Native Markdown owns inline image protocols, bypassing bgColor. A user
      // adapter must not decorate opaque image rows even when they contain SGR.
      const image = "\x1b_Ga=T;\x1b[0mAAAA\x1b\\";
      user.children[0].render = () => [image];
      const imageDispose = f.install();
      assert.ok(f.render().some(line => line.includes(image)));
      assert.equal(user.children[0].render(80)[0], image);
      imageDispose();
    }
  } finally { themes.initTheme("dark", false); }
});

test("plain terminals add no assistant styling or change native layout", () => {
  const previous = { TERM: process.env.TERM, NO_COLOR: process.env.NO_COLOR };
  try {
    for (const variable of ["TERM", "NO_COLOR"]) {
      if (variable === "TERM") process.env.TERM = "dumb";
      else process.env.NO_COLOR = "";
      const f = fixture([new UserMessageComponent("plain input"), assistant([text("plain answer"), thinking("native thinking")])]);
      const native = f.render();
      const dispose = f.install();
      assert.deepEqual(f.render(), native);
      dispose();
      for (const key of ["TERM", "NO_COLOR"]) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
    }
  } finally {
    for (const key of ["TERM", "NO_COLOR"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test("separator, thinking-only, tool-only and failure rows are never background blocks", () => {
  for (const reason of ["stop", "length", "error", "aborted"]) {
    const a = assistant([text("partial answer")], false, { stopReason: reason, errorMessage: "failure detail" });
    const f = fixture([assistant([thinking("hidden reasoning")], true), assistant([toolCall]), a]);
    const native = f.render();
    const dispose = f.install();
    const rendered = f.render();
    const answer = plain(rendered).findIndex(line => line.includes("partial answer"));
    const bottom = answer + 1;
    assert.equal(rendered.length, native.length + (reason === "stop" ? 2 : 1), "one neutral gap; native failure bottom separator is reused");
    assert.ok(rendered[bottom].includes(fill()));
    assert.equal(stripVTControlCharacters(rendered[bottom]), " ".repeat(80));
    const gap = answer - 2;
    assert.equal(stripVTControlCharacters(rendered[gap]), "");
    assert.doesNotMatch(rendered[gap], /\x1b\[48;/);
    const aligned = rendered.filter((_, index) => index !== gap && (reason !== "stop" || index !== bottom));
    assert.deepEqual(plain(aligned), plain(native));
    for (let index = 0; index < aligned.length; index++) {
      if (index === answer - 1 || index === answer - 2 || reason !== "stop" && index === bottom - 1) assert.ok(aligned[index].includes(fill()));
      else assert.equal(aligned[index], native[index]);
    }
    dispose();
  }
});

test("neutral gap cleanup resets native mouse caches even when the bottom spacer is reused", () => {
  for (const reason of ["length", "error", "aborted"]) {
    const a = assistant([text("partial answer")], false, { stopReason: reason, errorMessage: "failure detail" });
    let clicks = 0;
    const neighbor = new MouseRegion(new Text("next message", 0, 0), () => { clicks++; return { handled: true }; });
    const f = fixture([a, neighbor]);
    const native = f.render();
    const children = a.contentContainer.children;
    const original = [...children];
    const offset = getChildLineOffset(f.chat, neighbor, 80);
    const dispose = f.install();
    const rendered = f.render();
    assert.equal(children.length, original.length + 1, "only the neutral gap is owned");
    assert.equal(rendered.length, native.length + 1);
    assert.equal(f.document.handleMouse({ type: "click", button: "left", x: 2, y: offset + 1, width: 80, height: rendered.length })?.handled, true);
    dispose();
    assert.deepEqual(children, original);
    // No render between cleanup and the next click: cached heights must be gone.
    assert.equal(f.document.handleMouse({ type: "click", button: "left", x: 2, y: offset, width: 80, height: native.length })?.handled, true);
    assert.equal(clicks, 2);
    assert.deepEqual(f.render(), native);
  }
});

test("streaming, invalidate, transcript rebuild and theme changes refresh without stale instances", () => {
  const a = assistant([text("first")]);
  const f = fixture([a]);
  const dispose = f.install();
  const old = a.contentContainer.children.find(child => child instanceof Markdown);
  assert.ok(Object.hasOwn(old, "render"));
  assert.ok(f.render().some(line => line.includes(fill())));
  a.updateContent(message([thinking("thinking stream"), text("second streamed answer"), toolCall]), true);
  assert.ok(f.render().find(line => line.includes("second streamed answer")).includes(fill()));
  assert.equal(Object.hasOwn(old, "render"), false);
  const backgrounds = [];
  for (const appearance of ["light", "dark"]) {
    themes.initTheme(appearance, false);
    f.document.invalidate();
    const lines = f.render(40);
    assert.ok(lines.find(line => line.includes("second streamed answer")).includes(fill()));
    assert.ok(!lines.find(line => line.includes("thinking stream")).includes(fill()));
    backgrounds.push(fill());
  }
  assert.notEqual(...backgrounds);
  const latest = a.contentContainer.children.find(child => child instanceof Markdown);
  f.chat.clear();
  f.chat.addChild(assistant([text("replacement history")]));
  assert.ok(f.render().find(line => line.includes("replacement history")).includes(fill()));
  assert.equal(Object.hasOwn(latest, "render"), false);
  assert.equal(f.warnings.length, 0);
  dispose();
});

test("plain-text panels and explicit inline/code backgrounds retain their own color", () => {
  const handlers = new Map();
  let transformer;
  registerTextPanels({ on(name, handler) { handlers.set(name, handler); }, registerMarkdownTransformer(value) { transformer = value; } }, true);
  handlers.get("session_start")({}, { mode: "tui", ui: { get theme() { return themes.theme; } } });
  for (const appearance of ["dark", "light"]) {
    themes.initTheme(appearance, false);
    const source = "before\n\n```text\n  root\n  └── child\n```\n\nafter\n\n```js\nconst x = 1;\n```";
    const a = new AssistantMessageComponent(message([text(source)]), false, themes.getMarkdownTheme(), "Thinking...", 1, [transformer]);
    const f = fixture([a]);
    const native = f.render();
    const dispose = f.install();
    const rendered = f.render();
    assert.deepEqual(plain(rendered.slice(1, -1)), plain(native));
    const panelBg = backgroundAnsi(mixColors(themes.theme.colors.userMessageBg, themes.theme.colors.text, 0.08), themes.theme.getColorMode());
    for (const word of ["root", "child"]) {
      const line = rendered.find(line => line.includes(word));
      assert.ok(line.includes(panelBg));
      // Panel background occurs after the outer fill, so the panel wins.
      assert.ok(line.indexOf(panelBg) > line.indexOf(fill()));
    }
    for (let index = 0; index < native.length; index++) {
      for (const bg of native[index].match(/\x1b\[48;[25];[\d;]+m/g) ?? []) assert.ok(rendered[index + 1].includes(bg));
    }
    assert.equal(f.warnings.length, 0);
    dispose();
  }
  themes.initTheme("dark", false);
});

test("ANSI resets and nested colors preserve foregrounds, OSC links/zones and image protocols", () => {
  const a = assistant([text("placeholder")]);
  const md = a.contentContainer.children.find(child => child instanceof Markdown);
  const link = "\x1b]8;;https://example.com/\x1b[0m\x07label\x1b]8;;\x07";
  const imageLines = ["\x1b_Ga=T;AAAA\x1b\\", "\x1b]1337;File=AAAA\x07", "\x1bPqAAAA\x1b\\"];
  const rows = ["\x1b[31mred\x1b[0mnormal", "\x1b[44mblue panel\x1b[49mnormal", "\x1b[38;2;0;49;100mfg\x1b[39m", "\x1b[0;48;2;1;2;3mnested\x1b[49mnormal", "\x1b[48:2::1:2:3mcolon\x1b[49mnormal", link, ...imageLines];
  const nativeRender = () => [...rows];
  md.render = nativeRender;
  const f = fixture([a]);
  const dispose = f.install();
  f.render();
  const rendered = md.render(80);
  const rootForeground = themes.theme.getFgAnsi("text");
  assert.ok(rendered[0].includes("\x1b[0m" + fill() + rootForeground + "normal"));
  assert.ok(rendered[1].includes("\x1b[44mblue panel\x1b[49m" + fill() + "normal"));
  assert.ok(rendered[2].includes(rows[2]));
  assert.ok(rendered[3].includes("\x1b[0;48;2;1;2;3m" + rootForeground + "nested"));
  assert.ok(rendered[4].includes("\x1b[48:2::1:2:3mcolon"));
  assert.ok(rendered[5].includes(link), "OSC URL payload is opaque");
  assert.deepEqual(rendered.slice(-3), imageLines);
  const zones = line => line.match(/\x1b\]133;[ABC]\x07/g) ?? [];
  const nativeAssistant = new AssistantMessageComponent(message([text("normal answer")]));
  const z = fixture([nativeAssistant]);
  const before = z.render();
  const disposeZ = z.install();
  const decorated = z.render();
  assert.deepEqual(decorated.flatMap(zones), before.flatMap(zones), "OSC zone bytes/order are preserved around the extra native child");
  assert.deepEqual(zones(decorated.at(-1)), ["\x1b]133;B\x07", "\x1b]133;C\x07"], "native assistant closes its zone on the bottom buffer");
  disposeZ();
  dispose();
  assert.equal(md.render, nativeRender);
});

test("narrow columns add only gap/bottom rows, not wrapping, and never mutate the native Markdown cache", () => {
  const content = [text("first **bold** 👩‍💻 中文 é\n\nsecond paragraph\n\n- list item\n- next")];
  for (const width of [0, 1, 2, 3, 4, 8, 20, 80]) {
    const a = assistant(content);
    const f = fixture([a]);
    const before = f.render(width);
    const md = a.contentContainer.children.find(child => child instanceof Markdown);
    const cached = md.render(width);
    const cacheCopy = [...cached];
    const dispose = f.install();
    const after = f.render(width);
    assert.equal(after.length, before.length + 2, `one gap and bottom row at ${width}`);
    assert.deepEqual(plain(after.slice(1, -1)), plain(before));
    assert.deepEqual(after.slice(2, -1).map(visibleWidth), before.slice(1).map(visibleWidth));
    assert.equal(visibleWidth(after[0]), 0, "neutral gap remains unpainted");
    if (width > 0) {
      assert.equal(visibleWidth(after[1]), width, "existing spacer becomes the full-width top buffer");
      assert.equal(visibleWidth(after.at(-1)), width, "owned spacer becomes the full-width bottom buffer");
    }
    assert.deepEqual(cached, cacheCopy);
    // Pi's minimum content width and wide glyphs can overflow tiny columns;
    // the adapter leaves those lines untouched instead of changing native layout.
    for (let index = 0; index < before.length; index++) {
      if (visibleWidth(before[index]) > width || width <= 0) {
        const withoutZones = line => line.replace(/\x1b\]133;[ABC]\x07/g, "");
        assert.equal(withoutZones(after[index + 1]), withoutZones(before[index]));
      }
      else assert.ok(visibleWidth(after[index + 1]) <= width);
    }
    dispose();
    assert.deepEqual(f.render(width), before);
  }
});

test("cleanup is idempotent, restores own descriptors and respects foreign replacements", () => {
  const a = assistant([text("answer")]);
  const md = a.contentContainer.children.find(child => child instanceof Markdown);
  const f = fixture([a]);
  const nativeDocumentRender = f.document.render;
  const nativeMdRender = md.render;
  const dispose = f.install();
  f.render();
  dispose();
  dispose();
  assert.equal(f.document.render, nativeDocumentRender);
  assert.equal(md.render, nativeMdRender);
  assert.equal(Object.hasOwn(f.document, "render"), false);
  assert.equal(Object.hasOwn(md, "render"), false);
  const second = f.install();
  const foreign = () => ["foreign"];
  const oldWrapper = md.render;
  md.render = foreign;
  f.document.render = foreign;
  second();
  assert.equal(md.render, foreign);
  assert.equal(f.document.render, foreign);
  assert.deepEqual(oldWrapper(80), nativeMdRender.call(md, 80));
});

test("unsupported layouts/shapes fail open and warn only once", () => {
  const warnings = [];
  const tui = new Container();
  const original = tui.render;
  installAssistantPanels(tui, { theme: () => themes.theme, requestRender() {}, warn: value => warnings.push(value) })();
  assert.equal(tui.render, original);
  assert.equal(warnings.length, 1);
  const a = assistant([text("native")]);
  const f = fixture([a]);
  const dispose = f.install();
  const md = a.contentContainer.children.find(child => child instanceof Markdown);
  a.contentContainer.addChild(new Markdown("unknown new direct block", 0, 0, themes.getMarkdownTheme()));
  const rendered = f.render();
  assert.ok(!rendered.some(line => line.includes(fill())));
  assert.equal(Object.hasOwn(md, "render"), false);
  f.render();
  assert.equal(f.warnings.length, 1);
  f.document.children.pop();
  f.render();
  assert.equal(Object.hasOwn(f.document, "render"), false);
  assert.equal(f.warnings.length, 1);
  dispose();
});

test("grouping and pinning compose in either install order without geometry or mouse changes", () => {
  for (const panelsFirst of [true, false]) {
    const a = assistant([text("final answer")]);
    const user = new UserMessageComponent("latest input");
    const f = fixture([tool(), assistant([toolCall]), tool(), a, user]);
    f.tui.mode = "fullscreen";
    const scroll = new ScrollView(f.document, { primary: true, follow: "end", scrollbar: "hidden" });
    f.tui.layoutRoot = new VStack([{ component: scroll, grow: 1 }]);
    const settings = { defaultMode: "compact", errorPreview: false, groupConsecutive: true, backgrounds: "tool", tools: {} };
    const cleanups = [];
    if (panelsFirst) cleanups.push(f.install());
    cleanups.push(installGrouping(f.tui, settings, f.options));
    const pin = installPinnedPrompt(f.tui, () => themes.theme, () => ({ text: "latest input", displayed: true }), value => f.warnings.push(value));
    assert.ok(pin);
    cleanups.push(() => pin.dispose());
    if (!panelsFirst) cleanups.push(f.install());
    const rendered = f.render();
    assert.ok(plain(rendered).some(line => /2 tools/.test(line)));
    assert.ok(rendered.find(line => line.includes("final answer")).includes(fill()));
    const offset = getChildLineOffset(f.chat, user, 80);
    assert.equal(offset, 2 + a.render(80).length);
    const y = plain(f.chat.render(80)).findIndex(line => /2 tools/.test(line));
    assert.equal(f.chat.handleMouse({ type: "click", button: "left", x: 2, y, width: 80, height: rendered.length })?.handled, true);
    assert.ok(getChildLineOffset(f.chat, user, 80) > offset);
    const bar = f.tui.layoutRoot.children[0];
    assert.ok(plain(bar.render(80))[0].includes("latest input"));
    pin.jump();
    assert.equal(f.warnings.length, 0);
    // Deliberately vary teardown order too.
    if (panelsFirst) cleanups.forEach(cleanup => cleanup());
    else cleanups.reverse().forEach(cleanup => cleanup());
    assert.equal(Object.hasOwn(f.document, "render"), false);
  }
});

test("fresh panel children prepare streaming wrappers and spacers without rendering historical messages", () => {
  const f = fixture();
  const dispose = f.install();
  const a = assistant([text("new answer")]);
  const originalRender = a.render;
  let renders = 0;
  a.render = function(width) { renders++; return originalRender.call(this, width); };
  f.chat.addChild(a);
  const md = a.contentContainer.children.find(child => child instanceof Markdown);
  const originalChildren = [...a.contentContainer.children];
  try {
    assert.equal(Object.hasOwn(md, "render"), false);
    assert.equal(freshTranscriptChildren(f.document), f.document.children);
    assert.equal(Object.hasOwn(md, "render"), true, "fresh preparation installs current panel wrappers before suffix measurement");
    assert.equal(a.contentContainer.children.length, originalChildren.length + 2);
    for (let index = 0; index < 10; index++) freshTranscriptChildren(f.document);
    assert.equal(a.contentContainer.children.length, originalChildren.length + 2, "preparation does not duplicate panel geometry");
    a.updateContent(message([text("streamed answer")]), true);
    const next = a.contentContainer.children.find(child => child instanceof Markdown);
    assert.equal(freshTranscriptChildren(f.document), f.document.children);
    assert.equal(Object.hasOwn(md, "render"), false);
    assert.equal(Object.hasOwn(next, "render"), true);
    assert.equal(renders, 0, "fresh reconciliation is not a hidden full render pass");
    f.chat.clear();
    freshTranscriptChildren(f.document);
    assert.equal(Object.hasOwn(next, "render"), false, "branch/compaction removals release detached wrappers during prepare too");
    f.document.render = () => ["foreign document"];
    assert.equal(freshTranscriptChildren(f.document), undefined);
  } finally { dispose(); }
});

test("panel freshness never certifies a foreign original or a merely preserving renderer", () => {
  for (const preserving of [false, true]) {
    const f = fixture([assistant([text("answer")])]);
    const native = f.document.render;
    f.document.render = function(width) { const lines = native.call(this, width); return preserving ? lines : lines.slice().reverse(); };
    const unregister = preserving ? registerTranscriptRenderer(f.document, f.document.render) : () => {};
    const dispose = f.install();
    try { assert.equal(freshTranscriptChildren(f.document), undefined); }
    finally { dispose(); unregister(); }
  }
});

test("registration guards modes and disabled setting, reattaches and cleans widget/shutdown", async () => {
  const disabled = new Map();
  registerAssistantPanels({ on(name, handler) { disabled.set(name, handler); } }, false);
  assert.equal(disabled.size, 0);
  const handlers = new Map();
  registerAssistantPanels({ on(name, handler) { handlers.set(name, handler); } }, true);
  const f = fixture([assistant([text("answer")])]);
  const native = f.document.render;
  let widget;
  let mode = "rpc";
  const ctx = { get mode() { return mode; }, hasUI: true, ui: {
    get theme() { return themes.theme; }, notify(message) { f.warnings.push(message); },
    setWidget(key, factory) { assert.equal(key, "compact-tools-assistant-panels"); widget = factory(f.tui); },
  } };
  for (mode of ["rpc", "print", "json"]) {
    await handlers.get("session_start")({}, ctx);
    assert.equal(widget, undefined);
  }
  mode = "tui";
  ctx.hasUI = false;
  await handlers.get("session_start")({}, ctx);
  assert.equal(widget, undefined);
  ctx.hasUI = true;
  await handlers.get("session_start")({}, ctx);
  assert.notEqual(f.document.render, native);
  assert.deepEqual(widget.render(80), []);
  const oldWidget = widget;
  await handlers.get("session_start")({}, ctx);
  oldWidget.dispose();
  assert.notEqual(f.document.render, native, "stale widget cannot dispose the new adapter");
  widget.dispose();
  assert.equal(f.document.render, native);
  await handlers.get("session_start")({}, ctx);
  await handlers.get("session_shutdown")({}, ctx);
  await handlers.get("session_shutdown")({}, ctx);
  assert.equal(f.document.render, native);
  assert.equal(f.warnings.length, 0);
});
