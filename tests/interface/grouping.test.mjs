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
const { getChildLineOffset, getChildLineOffsets, installGrouping, registerGrouping } = await jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styling/grouping.ts"));
const { freshTranscriptChildren } = await jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styling/transcript-measurement.ts"));
const { Container, MouseRegion, ScrollView, Text, VStack, visibleWidth } = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
const { ToolExecutionComponent } = await fromPi("dist/modes/interactive/components/tool-execution.js");
const { AssistantMessageComponent } = await fromPi("dist/modes/interactive/components/assistant-message.js");
const { InteractiveMode } = await fromPi("dist/modes/interactive/interactive-mode.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
const { createAllToolRenderers } = await fromPi("dist/core/tools/renderers/index.js");
themes.initTheme("dark", false);
const builtins = createAllToolRenderers();
const defaults = () => ({ defaultMode: "compact", errorPreview: false, groupConsecutive: true, backgrounds: "tool", tools: {} });
let id = 0;
const result = (text = "native result", extra = {}) => ({ content: [{ type: "text", text }], details: undefined, isError: false, ...extra });
function row(name = "read", completed = true) {
  const component = new ToolExecutionComponent(name, `group-test-${++id}`, { path: "sample.txt", command: "true" },
    { showImages: false, outputPad: 1 }, builtins[name], { requestRender() {} }, process.cwd());
  if (completed) component.updateResult(result());
  return component;
}
function assistant(content, hidden = false) {
  return new AssistantMessageComponent({ role: "assistant", content, stopReason: "toolUse" }, hidden);
}
function fixture(children = [], settings = defaults()) {
  const chat = new Container();
  for (const child of children) chat.addChild(child);
  const document = new Container();
  document.addChild(new Container());
  document.addChild(new Container());
  document.addChild(chat);
  const tui = new Container();
  tui.addChild(document);
  const warnings = [];
  let renders = 0;
  const options = { theme: () => themes.theme, requestRender: () => { renders++; }, warn: message => warnings.push(message) };
  const dispose = installGrouping(tui, settings, options);
  return { chat, document, tui, warnings, options, dispose, get renders() { return renders; } };
}
const plain = (component, width = 100) => component.render(width).map(stripVTControlCharacters);
const nonblank = (component, width) => plain(component, width).filter(line => line.trim());
function click(component, y, width = 100) {
  const lines = component.render(width);
  y ??= lines.findIndex(line => /^\s*[▴▸].*\d+ tools/.test(stripVTControlCharacters(line)));
  return component.handleMouse({ type: "click", button: "left", x: 3, y, screenX: 3, screenY: y, width, height: lines.length });
}

test("group footer reveals compact siblings above it; each tool expands independently", () => {
  const a = row();
  const b = row("bash");
  const f = fixture([a, b]);
  const originalChildren = f.chat.children;
  assert.equal(nonblank(f.chat).length, 1);
  assert.match(nonblank(f.chat)[0], /▸.*2 tools.*read, bash/);
  assert.equal(f.chat.children, originalChildren);
  assert.deepEqual(f.chat.children, [a, b]);
  assert.equal(click(f.chat)?.handled, true);
  assert.equal(a.expanded || b.expanded, false);
  assert.ok(nonblank(f.chat).length > 1);
  assert.match(plain(f.chat).at(-1), /▴.*2 tools/, "summary points toward children revealed above it");
  const firstToolY = plain(a).findIndex(line => line.trim());
  assert.equal(click(f.chat, firstToolY)?.handled, true); // First native tool's click region, not the footer.
  assert.equal(a.expanded, true);
  assert.equal(b.expanded, false);
  assert.match(plain(f.chat).at(-1), /▴.*2 tools/);
  assert.equal(click(f.chat)?.handled, true);
  assert.equal(nonblank(f.chat).length, 1);
  assert.match(nonblank(f.chat)[0], /▸.*2 tools/);
  assert.equal(a.expanded || b.expanded, false);
  click(f.chat); // Reopening starts with individually collapsed rows again.
  assert.equal(a.expanded || b.expanded, false);
  assert.match(plain(f.chat).at(-1), /▴.*2 tools/);
  f.dispose();
});

test("native global expansion action still reaches original tool siblings", () => {
  const a = row();
  const b = row("bash");
  const f = fixture([a, b]);
  const mode = { toolOutputExpanded: false, chatContainer: f.chat, loadedResourcesContainer: new Container(), pendingMessagesContainer: new Container(), showStatus() {} };
  InteractiveMode.prototype.setToolsExpanded.call(mode, true);
  assert.ok(a.expanded && b.expanded);
  assert.match(plain(f.chat).join("\n"), /native result/);
  assert.match(plain(f.chat).at(-1), /▴.*2 tools/, "global expansion also points upward");
  InteractiveMode.prototype.setToolsExpanded.call(mode, false);
  assert.equal(nonblank(f.chat).length, 1);
  f.dispose();
});

test("global detail toggles do not close a manually revealed compact list", () => {
  const a = row();
  const b = row("bash");
  const f = fixture([a, b]);
  click(f.chat);
  const mode = { toolOutputExpanded: false, chatContainer: f.chat, loadedResourcesContainer: new Container(), pendingMessagesContainer: new Container(), showStatus() {} };
  InteractiveMode.prototype.setToolsExpanded.call(mode, true);
  assert.ok(a.expanded && b.expanded);
  InteractiveMode.prototype.setToolsExpanded.call(mode, false);
  assert.equal(a.expanded || b.expanded, false);
  assert.ok(nonblank(f.chat).length > 1);
  assert.match(plain(f.chat).at(-1), /▴.*2 tools/);
  click(f.chat);
  assert.equal(nonblank(f.chat).length, 1);
  f.dispose();
});

test("expanding and collapsing anchor the footer while fullscreen scrollback grows upward", () => {
  const a = row();
  const b = row("bash");
  const f = fixture([new Text("prefix\n".repeat(30), 0, 0), a, b, new Text("suffix\n".repeat(50), 0, 0)]);
  const scroll = new ScrollView(f.document, { primary: true, follow: "end", scrollbar: "hidden" });
  f.tui.layoutRoot = new VStack([{ component: scroll, grow: 1 }]);
  scroll.updateLayout(f.document.render(100).length, 15, () => {});
  scroll.scrollTo(25, { disableFollow: true });
  const footerScreenY = () => plain(f.chat).findIndex(line => /2 tools/.test(line)) - scroll.scrollTop;
  const before = footerScreenY();
  click(f.chat);
  assert.equal(a.expanded || b.expanded, false);
  assert.ok(scroll.scrollTop > 25);
  assert.equal(footerScreenY(), before);
  assert.equal(scroll.isFollowingEnd, false);
  click(f.chat);
  assert.equal(scroll.scrollTop, 25);
  assert.equal(footerScreenY(), before);
  assert.equal(f.warnings.length, 0);
  f.dispose();
});

test("tool-only assistants are transparent; chat and hidden thinking break runs", () => {
  const empty = assistant([{ type: "toolCall", id: "empty", name: "read", arguments: {} }]);
  const f = fixture([row(), empty, row()]);
  assert.match(nonblank(f.chat)[0], /2 tools/);
  assert.equal(nonblank(f.chat).length, 1);
  empty.updateContent({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "chat boundary" }] });
  assert.doesNotMatch(plain(f.chat).join("\n"), /2 tools/);
  assert.match(plain(f.chat).join("\n"), /chat boundary/);
  const thinking = assistant([{ type: "thinking", thinking: "private reasoning" }, { type: "toolCall", id: "t", name: "read", arguments: {} }], true);
  f.chat.children = [row(), thinking, row()];
  assert.doesNotMatch(plain(f.chat).join("\n"), /2 tools/);
  assert.match(plain(f.chat).join("\n"), /Thinking/);
  f.dispose();
});

test("normal overrides, arbitrary messages, and image-bearing rows are boundaries", () => {
  const settings = defaults();
  settings.tools.bash = "normal";
  const image = row();
  image.updateResult({ ...result(), content: [{ type: "image", data: "not rendered", mimeType: "image/png" }] });
  const f = fixture([row(), row("bash"), row(), new Text("user boundary"), row(), image, row()], settings);
  assert.doesNotMatch(plain(f.chat).join("\n"), /\d tools/);
  assert.match(plain(f.chat).join("\n"), /user boundary/);
  f.dispose();
});

test("questions are never hidden in groups, even with an explicit compact override", () => {
  const settings = { ...defaults(), tools: { ask_user: "compact" } };
  const question = row("ask_user", false);
  const f = fixture([row(), question, row()], settings);
  assert.doesNotMatch(plain(f.chat).join("\n"), /\d tools/);
  assert.match(plain(f.chat).join("\n"), /ask_user/);
  f.dispose();
});

test("streaming, failure, appended siblings, and late images reconcile on the next render", () => {
  const a = row("read", false);
  const b = row("read", false);
  const f = fixture([a, b]);
  assert.match(nonblank(f.chat)[0], /2 pending/);
  a.updateResult(result("partial"), true);
  b.updateResult(result("failed", { isError: true }));
  assert.match(nonblank(f.chat)[0], /✗.*1 failed.*1 pending/);
  click(f.chat);
  a.setExpanded(true); // Opening one tool must not expand appended siblings.
  const c = row();
  f.chat.addChild(c);
  assert.match(plain(f.chat).join("\n"), /3 tools/);
  assert.equal(c.expanded, false);
  assert.equal(a.expanded, true);
  assert.equal(b.expanded, false);
  assert.match(plain(f.chat).at(-1), /▴.*3 tools/);
  click(f.chat);
  a.updateResult({ ...result(), content: [{ type: "image", data: "not rendered", mimeType: "image/png" }] });
  assert.match(plain(f.chat).join("\n"), /2 tools/);
  assert.doesNotMatch(plain(f.chat).join("\n"), /3 tools/);
  f.dispose();
});

test("history/rebuilds replace rows without retaining prior groups", () => {
  const f = fixture([row(), row()]);
  click(f.chat);
  f.chat.clear();
  const a = row();
  const b = row();
  f.chat.addChild(a);
  f.chat.addChild(b);
  assert.equal(nonblank(f.chat).length, 1);
  assert.equal(a.expanded || b.expanded, false);
  click(f.chat);
  assert.equal(a.expanded || b.expanded, false);
  assert.match(plain(f.chat).at(-1), /▴.*2 tools/);
  f.dispose();
});

test("widths, themes, and stale mouse layouts remain safe", () => {
  const f = fixture([row(), row()]);
  for (const appearance of ["light", "dark"]) {
    themes.initTheme(appearance, false);
    for (const width of [0, 1, 2, 12, 40, 100]) {
      const lines = f.chat.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
    }
    assert.equal(click(f.chat, undefined, 40)?.handled, true);
    assert.equal(click(f.chat, undefined, 40)?.handled, true);
  }
  assert.equal(f.warnings.length, 0);
  f.dispose();
});

test("group status chrome uses warm/neutral colors in every background mode and theme", async () => {
  const { toolBackground, toolStatusText } = await jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styling/palette.ts"));
  try {
    for (const appearance of ["dark", "light"]) {
      themes.initTheme(appearance, false);
      for (const backgrounds of ["tool", "status", "none"]) {
        for (const status of ["success", "pending", "error"]) {
          const a = row("read", status !== "pending");
          if (status === "error") a.updateResult(result("failed", { isError: true }));
          const f = fixture([a, row()], { ...defaults(), backgrounds });
          try {
            for (const expanded of [false, true]) {
              if (expanded) click(f.chat);
              const footer = f.chat.render(100).at(-1);
              const expected = toolBackground(themes.theme, "", backgrounds === "none" ? "none" : "status", status);
              if (expected) assert.ok(footer.startsWith(expected));
              else assert.doesNotMatch(footer, /\x1b\[48;/);
              assert.ok(footer.includes(toolStatusText(themes.theme, status, stripVTControlCharacters(footer))));
              assert.ok(!footer.includes(themes.theme.getFgAnsi("success")), "no native green success chrome");
              assert.ok(!footer.includes(themes.theme.getBgAnsi("toolSuccessBg")), "no native green group surface");
              assert.match(stripVTControlCharacters(footer), status === "error" ? /✗.*1 failed/ : status === "pending" ? /●.*1 pending/ : /✓/);
            }
          } finally { f.dispose(); }
        }
      }
    }
  } finally { themes.initTheme("dark", false); }
});

test("cleanup restores original instance descriptors and is idempotent", () => {
  const a = row();
  const f = fixture([a, row()]);
  const prototypeRender = Object.getPrototypeOf(f.chat).render;
  assert.equal(Object.hasOwn(f.chat, "render"), true);
  f.dispose();
  f.dispose();
  assert.equal(Object.hasOwn(f.chat, "render"), false);
  assert.equal(Object.hasOwn(f.chat, "handleMouse"), false);
  assert.equal(f.chat.render, prototypeRender);
  assert.doesNotMatch(plain(f.chat).join("\n"), /2 tools/);
  assert.equal(f.chat.children[0], a);
});

test("unsupported layouts warn and fail open; foreign replacements are not clobbered", () => {
  const warnings = [];
  const tui = new Container();
  const original = tui.render;
  const dispose = installGrouping(tui, defaults(), { theme: () => themes.theme, requestRender() {}, warn: message => warnings.push(message) });
  assert.equal(warnings.length, 1);
  assert.equal(tui.render, original);
  dispose();
  const f = fixture([row(), row()]);
  const replacement = () => ["another extension"];
  f.chat.render = replacement;
  f.dispose();
  assert.equal(f.chat.render, replacement);
});

test("an incompatible row update restores rendering and warns once", () => {
  const f = fixture([row(), row()]);
  f.chat.addChild({ render: () => ["fallback"], invalidate() {}, get toolName() { throw new Error("incompatible row"); } });
  assert.match(plain(f.chat).join("\n"), /fallback/);
  assert.equal(f.warnings.length, 1);
  assert.equal(Object.hasOwn(f.chat, "render"), false);
  plain(f.chat);
  assert.equal(f.warnings.length, 1);
  f.dispose();
});

test("child offsets follow collapsed/expanded projection, rebuilds, and native fallback", () => {
  const a = row();
  const target = new Text("latest user prompt", 0, 0);
  const prefix = new Text("earlier chat", 0, 0);
  const f = fixture([prefix, a, row(), target]);
  assert.equal(getChildLineOffset(f.chat, target, 100), 3); // One chat line and a two-line group.
  assert.equal(getChildLineOffset(f.chat, a, 100), undefined);
  // The collapsed footer follows prefix, so its click line is now y=2.
  click(f.chat, 2);
  const expected = plain(f.chat).findIndex(line => line.trim() === "latest user prompt");
  assert.equal(getChildLineOffset(f.chat, target, 100), expected);
  f.chat.clear();
  f.chat.addChild(new Text("replacement history", 0, 0));
  f.chat.addChild(target);
  assert.equal(getChildLineOffset(f.chat, target, 100), 1);
  f.dispose();
  f.chat.children = [a, target];
  assert.equal(getChildLineOffset(f.chat, target, 100), a.render(100).length);
  assert.equal(getChildLineOffset(f.chat, new Text("missing"), 100), undefined);
  assert.equal(getChildLineOffset({}, target, 100), undefined);
});

test("unchanged groups retain projection, summary widgets and native slots while live primitives stay fresh", () => {
  const a = row("read", false);
  const b = row("read");
  const f = fixture([a, b]);
  try {
    const group = [...getChildLineOffsets(f.chat, 100).keys()][0];
    const members = group.members;
    const slots = group.slots;
    const closedChildren = group.view.children;
    const spacer = closedChildren[0];
    const footer = closedChildren[1];
    for (let index = 0; index < 100; index++) {
      assert.equal([...getChildLineOffsets(f.chat, 100).keys()][0], group);
      assert.equal(group.members, members);
      assert.equal(group.slots, slots);
      assert.equal(group.view.children, closedChildren);
      assert.equal(group.view.children[1], footer);
    }
    assert.match(plain(f.chat).at(-1), /read ×2.*1 pending/);
    a.updateResult(result("failed", { isError: true }));
    b.toolName = "bash";
    assert.match(plain(f.chat).at(-1), /read, bash.*1 failed/);
    click(f.chat);
    const openChildren = group.view.children;
    for (let index = 0; index < 10; index++) f.chat.render(100);
    assert.equal(group.view.children, openChildren);
    assert.equal(openChildren.at(-2), spacer);
    assert.equal(openChildren.at(-1), footer);
    assert.equal(openChildren[0], a);
    a.setExpanded(true);
    assert.match(plain(f.chat).join("\n"), /failed/);
  } finally { f.dispose(); }
});

test("fresh displayed children reconcile live boundaries and late images without rendering history", () => {
  const a = row();
  const b = row();
  const transparent = assistant([{ type: "toolCall", id: "fresh", name: "read", arguments: {} }]);
  const f = fixture([a, transparent, b]);
  let renders = 0;
  for (const child of [a, b, transparent]) {
    const render = child.render;
    child.render = function(width) { renders++; return render.call(this, width); };
  }
  try {
    const group = freshTranscriptChildren(f.chat)[0];
    assert.equal(group.constructor.name, "ToolGroup");
    assert.equal(renders, 0);
    transparent.updateContent({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "new boundary" }] });
    assert.deepEqual(freshTranscriptChildren(f.chat), [a, transparent, b], "same-object semantic mutation breaks the run before painting");
    transparent.updateContent({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "fresh", name: "read", arguments: {} }] });
    assert.equal(freshTranscriptChildren(f.chat)[0], group, "unchanged leading member retains its owned group");
    a.updateResult({ ...result(), content: [{ type: "image", data: "not rendered", mimeType: "image/png" }] });
    assert.deepEqual(freshTranscriptChildren(f.chat), [a, transparent, b], "late images cannot remain hidden in a cached group");
    const c = row();
    f.chat.children = [b, transparent, c];
    assert.deepEqual(freshTranscriptChildren(f.chat)[0].members, [b, c], "same-length replacement and rebuild use current native children");
    assert.equal(renders, 0, "membership reconciliation never calls a historical renderer");
    const foreign = () => ["foreign rows"];
    f.chat.render = foreign;
    assert.equal(freshTranscriptChildren(f.chat), undefined, "a foreign replacement cannot inherit the grouping capability");
    f.dispose();
    assert.equal(f.chat.render, foreign);
  } finally { f.dispose(); }
});

test("fresh projection clears parent mouse heights before a suffix-only repaint", () => {
  const a = row();
  const b = row();
  let clicks = 0;
  const target = new MouseRegion(new Text("target", 0, 0), () => { clicks++; return { handled: true }; });
  const f = fixture([a, b, target]);
  try {
    f.chat.render(100); // Parent hit metadata initially contains a two-line group.
    a.updateResult({ ...result(), content: [{ type: "image", data: "not rendered", mimeType: "image/png" }] });
    assert.deepEqual(freshTranscriptChildren(f.chat), [a, b, target]);
    const y = a.render(100).length + b.render(100).length;
    assert.equal(f.chat.handleMouse({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width: 100, height: y + 1 })?.handled, true);
    assert.equal(clicks, 1, "the native pre-paint fallback measures current projected children rather than old group heights");
  } finally { f.dispose(); }
});

test("registration guards modes and cleans both widget disposal and shutdown", async () => {
  const handlers = new Map();
  registerGrouping({ on(name, handler) { handlers.set(name, handler); } }, defaults());
  const f = fixture();
  f.dispose();
  const original = f.chat.render;
  let widget;
  let mode = "rpc";
  const ctx = { get mode() { return mode; }, ui: {
    get theme() { return themes.theme; },
    notify(message) { f.warnings.push(message); },
    setWidget(key, factory) { assert.equal(key, "compact-tools-grouping"); widget = factory({ children: f.tui.children, requestRender() {} }); },
  } };
  await handlers.get("session_start")({}, ctx);
  assert.equal(widget, undefined);
  mode = "tui";
  await handlers.get("session_start")({}, ctx);
  assert.deepEqual(widget.render(80), []);
  assert.notEqual(f.chat.render, original);
  widget.dispose();
  assert.equal(f.chat.render, original);
  await handlers.get("session_start")({}, ctx);
  assert.notEqual(f.chat.render, original);
  await handlers.get("session_shutdown")({}, ctx);
  assert.equal(f.chat.render, original);
  widget.dispose();
  const disabled = new Map();
  registerGrouping({ on(name, handler) { disabled.set(name, handler); } }, { ...defaults(), groupConsecutive: false });
  assert.equal(disabled.size, 0);
});
