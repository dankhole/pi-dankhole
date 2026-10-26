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
const { installThinkingCollapse, registerThinkingCollapse } = await local("thinking-collapse.ts");
const { installAssistantPanels } = await local("assistant-panels.ts");
const { installGrouping, getChildLineOffset } = await local("grouping.ts");
const { installPinnedPrompt } = await local("pinned-prompt.ts");
const { Container, Markdown, MouseRegion, ScrollView, Text, VStack } = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
const { AssistantMessageComponent } = await fromPi("dist/modes/interactive/components/assistant-message.js");
const { UserMessageComponent } = await fromPi("dist/modes/interactive/components/user-message.js");
const { ToolExecutionComponent } = await fromPi("dist/modes/interactive/components/tool-execution.js");
const { InteractiveMode } = await fromPi("dist/modes/interactive/interactive-mode.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
themes.initTheme("dark", false);
const text = text => ({ type: "text", text });
const thinking = thinking => ({ type: "thinking", thinking });
const toolCall = { type: "toolCall", id: "call", name: "read", arguments: {} };
const message = (content, extra = {}) => ({ role: "assistant", content, stopReason: "stop", ...extra });
const assistant = (content, hidden = false, extra = {}) => new AssistantMessageComponent(message(content, extra), hidden);
const plain = (component, width = 80) => component.render(width).map(stripVTControlCharacters);
const visible = component => plain(component).map(line => line.trim()).filter(Boolean);
function click(component, contains = "Thinking...", extra = {}) {
  const lines = plain(component);
  const y = lines.findIndex(line => line.includes(contains));
  assert.notEqual(y, -1, `missing clickable row: ${contains}`);
  return component.handleMouse({ type: "click", button: "left", x: 2, y, width: 80, height: lines.length, ...extra });
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
  let renders = 0;
  tui.requestRender = () => { renders++; };
  const warnings = [];
  const options = { theme: () => themes.theme, requestRender: () => tui.requestRender(), warn: value => warnings.push(value) };
  return { chat, document, tui, options, warnings, get renders() { return renders; }, install: () => installThinkingCollapse(tui, options) };
}
function tool(id) {
  const component = new ToolExecutionComponent("read", id, { path: "sample.txt" }, { showImages: false, outputPad: 1 }, undefined, { requestRender() {} }, process.cwd());
  component.updateResult({ content: [text("tool result")], details: undefined, isError: false });
  return component;
}

test("thinking run analysis scans once per native update and refreshes same-object mutations", () => {
  let reads = 0;
  const count = 100;
  const content = Array.from({ length: count }, () => [{ type: "thinking", get thinking() { reads++; return "reasoning"; } }, text("answer")]).flat();
  const source = message(content);
  const a = new AssistantMessageComponent(source);
  reads = 0;
  a.updateContent(source);
  const nativeReads = reads;
  const originalUpdate = a.updateContent;
  const f = fixture([a]);
  const dispose = f.install();
  reads = 0;
  a.updateContent(source);
  assert.equal(reads, nativeReads + count, "the adapter reads each thinking block once, not once for each run");
  content.push(thinking("trailing live"));
  a.updateContent(source, true);
  assert.ok(plain(a).some(line => line.includes("trailing live")));
  content.push(toolCall);
  a.updateContent(source, true);
  assert.ok(!plain(a).some(line => line.includes("trailing live")), "a same-array append closes the previous run");
  a.setHideThinkingBlock(false);
  assert.ok(plain(a).some(line => line.includes("trailing live")), "native global visibility remains authoritative");
  dispose();
  assert.equal(a.updateContent, originalUpdate);
  assert.equal(Object.hasOwn(a, "updateContent"), false);
});

test("thinking update wrapper restores owned descriptors and retains foreign replacements", () => {
  const a = assistant([thinking("reasoning")]);
  const original = a.updateContent.bind(a);
  a.updateContent = original;
  const descriptor = Object.getOwnPropertyDescriptor(a, "updateContent");
  const f = fixture([a]);
  const dispose = f.install();
  assert.notEqual(a.updateContent, original);
  dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(a, "updateContent"), descriptor);
  const second = f.install();
  const foreign = a.updateContent.bind(a);
  a.updateContent = foreign;
  second();
  assert.equal(a.updateContent, foreign);
});

test("native history thinking collapses to its native row; clicks expand intact reasoning and stay expanded", () => {
  const content = [thinking("first **thought**\n\nsecond paragraph\n\n- 中文\n- last"), thinking("adjacent thought"), text("answer")];
  const a = assistant(content);
  const f = fixture([a]);
  const native = a.render(80);
  const source = JSON.stringify(a.lastMessage);
  const nativeRender = a.render;
  const nativeMouse = a.handleMouse;
  const mapPrototypeGet = Map.prototype.get;
  const dispose = f.install();
  assert.deepEqual(visible(a), ["Thinking...", "answer"]);
  const region = a.contentContainer.children.find(child => child instanceof MouseRegion);
  assert.ok(region.child instanceof Text, "native collapsed Text, not an adapter renderer");
  assert.equal(click(a)?.handled, true);
  assert.ok(a.contentContainer.children.find(child => child instanceof MouseRegion).child instanceof Markdown);
  assert.deepEqual(a.render(80), native, "expansion uses identical native markdown and OSC zones");
  assert.equal(a.thinkingVisibilityOverrides.get(0), false);
  assert.equal(a.thinkingVisibilityOverrides.size, 1, "only native click writes a map entry");
  for (let index = 0; index < 3; index++) {
    f.document.invalidate();
    f.document.render(80);
    assert.deepEqual(a.render(80), native);
  }
  assert.equal(a.render, nativeRender);
  assert.equal(a.handleMouse, nativeMouse);
  assert.equal(Map.prototype.get, mapPrototypeGet);
  assert.equal(JSON.stringify(a.lastMessage), source);
  assert.equal(click(a, "first thought")?.handled, true);
  assert.ok(visible(a).some(line => line.includes("Thinking...")));
  assert.equal(click(a, "Thinking...", { button: "right" }), undefined);
  dispose();
  assert.equal(a.thinkingVisibilityOverrides.get(0), true, "manual collapse survives cleanup");
  assert.equal(f.warnings.length, 0);
});

test("actual InteractiveMode message_start/update/end flags keep streaming full then collapse once", async () => {
  const f = fixture();
  const dispose = f.install();
  const host = {
    isInitialized: true, footer: { invalidate() {} }, programStatus: { handleEvent() {} },
    chatContainer: f.chat, ui: f.tui, hideThinkingBlock: false, hiddenThinkingLabel: "Thinking...", outputPad: 1,
    getMarkdownThemeWithSettings: () => themes.getMarkdownTheme(), getMarkdownTransformers: () => [],
    maybeShowThinkingDropNotice() {}, maybeShowCacheMissNotice() {}, pendingTools: new Map(),
  };
  const emit = event => InteractiveMode.prototype.handleEvent.call(host, event);
  const initial = message([thinking("live first line\n\nsecond line")]);
  await emit({ type: "message_start", message: initial });
  const a = host.streamingComponent;
  assert.equal(a.isStreaming, true);
  assert.ok(plain(f.document).some(line => line.includes("live first line")));
  const updated = message([thinking("live first line\n\nsecond line\n\nthird line")]);
  await emit({ type: "message_update", message: updated });
  assert.ok(plain(f.document).some(line => line.includes("third line")));
  assert.ok(!plain(a).some(line => line.includes("Thinking...")));
  await emit({ type: "message_end", message: updated });
  assert.equal(a.isStreaming, false);
  assert.equal(host.streamingComponent, undefined);
  assert.deepEqual(visible(a), ["Thinking..."]);
  assert.equal(click(f.document)?.handled, true);
  const expanded = a.render(80);
  for (const width of [40, 80, 100]) {
    f.document.render(width);
    a.invalidate();
    assert.ok(plain(a, width).some(line => line.includes("third line")));
  }
  assert.deepEqual(a.render(80), expanded);
  dispose();
  assert.ok(plain(a).some(line => line.includes("third line")));
});

test("mixed prose, empty/adjacent thinking and multiple runs close independently during streaming", () => {
  const a = new AssistantMessageComponent();
  const f = fixture();
  const dispose = f.install();
  f.chat.addChild(a);
  const content = [thinking("  "), text("before"), thinking("first run"), thinking("adjacent"), text("middle"), thinking("last live\n\nmore")];
  a.updateContent(message(content), true);
  assert.deepEqual(visible(a), ["before", "Thinking...", "middle", "last live", "more"]);
  assert.equal(a.thinkingVisibilityOverrides.size, 0, "automatic defaults do not replace native override data");
  assert.equal(click(a)?.handled, true);
  a.updateContent(message([...content.slice(0, -1), thinking("last live\n\nmore\n\nnew token")]), true);
  assert.ok(plain(a).some(line => line.includes("first run")), "prior manual expansion survives live updates");
  assert.ok(plain(a).some(line => line.includes("new token")));
  const final = message([...content, toolCall]);
  a.updateContent(final, true);
  assert.ok(plain(a).some(line => line.includes("first run")));
  assert.ok(plain(a).some(line => line.includes("Thinking...")), "tool boundary closes previous run without waiting for message_end");
  a.updateContent(final, false);
  assert.ok(plain(a).some(line => line.includes("first run")));
  assert.equal(click(a)?.handled, true);
  assert.ok(plain(a).some(line => line.includes("last live")));
  assert.equal(JSON.stringify(a.lastMessage), JSON.stringify(final));
  dispose();
});

test("native global visibility preferences, explicit overrides, labels and failed endings remain authoritative", () => {
  for (const reason of ["stop", "length", "aborted", "error"]) {
    const a = assistant([thinking("reasoning body"), text("prose")], false, { stopReason: reason, errorMessage: "native error" });
    const f = fixture([a]);
    const dispose = f.install();
    assert.ok(plain(a).some(line => line.includes("Thinking...")));
    a.setHiddenThinkingLabel("Reasoning details");
    assert.ok(plain(a).some(line => line.includes("Reasoning details")));
    a.setHideThinkingBlock(false);
    assert.ok(plain(a).some(line => line.includes("reasoning body")), "native show action wins over completed default");
    a.invalidate();
    assert.ok(plain(a).some(line => line.includes("reasoning body")));
    a.setHideThinkingBlock(true);
    assert.ok(plain(a).some(line => line.includes("Reasoning details")));
    assert.equal(click(a, "Reasoning details")?.handled, true);
    assert.ok(plain(a).some(line => line.includes("reasoning body")));
    if (reason === "length") assert.ok(plain(a).some(line => line.includes("truncated")));
    if (["aborted", "error"].includes(reason)) assert.ok(plain(a).some(line => line.includes("native error")));
    dispose();
    assert.equal(a.hideThinkingBlock, true);
    assert.equal(a.thinkingVisibilityOverrides.get(0), false);
  }
  const a = new AssistantMessageComponent(undefined, true);
  const f = fixture();
  const dispose = f.install();
  f.chat.addChild(a);
  a.updateContent(message([thinking("globally hidden live reasoning")]), true);
  assert.ok(plain(a).some(line => line.includes("Thinking...")), "global hide preference remains effective while live");
  dispose();
});

test("collapsed rows retain native width/theme/label semantics and expanded reasoning recolors without recollapsing", () => {
  const content = [thinking("**thought** 中文 é 👩‍💻\n\nsecond paragraph"), text("answer")];
  const a = assistant(content);
  const nativeHidden = assistant(content, true);
  const f = fixture([a]);
  const dispose = f.install();
  try {
    for (const appearance of ["light", "dark"]) {
      themes.initTheme(appearance, false);
      f.document.invalidate();
      nativeHidden.invalidate();
      for (const width of [0, 1, 4, 12, 20, 80]) {
        assert.deepEqual(a.render(width), nativeHidden.render(width), `native collapsed geometry at ${appearance}/${width}`);
      }
    }
    click(a);
    for (const appearance of ["light", "dark"]) {
      themes.initTheme(appearance, false);
      f.document.invalidate();
      assert.ok(plain(a).some(line => line.includes("thought")));
      assert.ok(!plain(a).some(line => line.includes("Thinking...")));
    }
  } finally { dispose(); themes.initTheme("dark", false); }
});

test("a nonextensible native visibility map fails open and never blocks future chat additions", () => {
  const a = assistant([thinking("native reasoning")]);
  Object.preventExtensions(a.thinkingVisibilityOverrides);
  const f = fixture([a]);
  const dispose = f.install();
  assert.ok(plain(a).some(line => line.includes("native reasoning")));
  assert.equal(f.warnings.length, 1);
  const b = assistant([thinking("next message")]);
  f.chat.addChild(b);
  assert.ok(plain(b).some(line => line.includes("Thinking...")));
  dispose();
  assert.equal(Object.hasOwn(a.thinkingVisibilityOverrides, "get"), false);
  assert.equal(Object.hasOwn(b.thinkingVisibilityOverrides, "get"), false);
});

test("history rebuild/removal, reload and shutdown release only instance adapters without losing manual expansion", () => {
  const a = assistant([thinking("history reasoning")]);
  const f = fixture([a]);
  const nativeMethods = [f.chat.addChild, f.chat.removeChild, f.chat.clear];
  const nativeGet = a.thinkingVisibilityOverrides.get;
  const dispose = f.install();
  assert.notEqual(a.thinkingVisibilityOverrides.get, nativeGet);
  f.chat.removeChild(a);
  assert.equal(a.thinkingVisibilityOverrides.get, nativeGet);
  assert.ok(plain(a).some(line => line.includes("history reasoning")));
  f.chat.addChild(a);
  assert.ok(plain(a).some(line => line.includes("Thinking...")));
  click(a);
  f.chat.clear();
  assert.equal(a.thinkingVisibilityOverrides.get, nativeGet);
  f.chat.addChild(a);
  assert.ok(plain(a).some(line => line.includes("history reasoning")));
  dispose();
  dispose();
  assert.deepEqual([f.chat.addChild, f.chat.removeChild, f.chat.clear], nativeMethods);
  const second = f.install();
  assert.ok(plain(a).some(line => line.includes("history reasoning")), "manual expansion survives reinstallation");
  second();
  assert.equal(a.thinkingVisibilityOverrides.get, nativeGet);
  assert.equal(Object.hasOwn(a.thinkingVisibilityOverrides, "get"), false);
  assert.equal(Object.hasOwn(a.thinkingVisibilityOverrides, "clear"), false);
  assert.equal(f.warnings.length, 0);
});

test("grouping, assistant panels and pinned input compose in both install/teardown orders", () => {
  for (const thinkingFirst of [true, false]) {
    const a = assistant([thinking("hidden reasoning"), text("final answer")]);
    const user = new UserMessageComponent("latest input");
    const t1 = tool("one");
    const t2 = tool("two");
    const f = fixture([t1, assistant([toolCall]), t2, a, user]);
    const toolBefore = t1.render(80);
    const userBefore = user.render(80);
    const nativeRender = f.document.render;
    f.tui.mode = "fullscreen";
    const scroll = new ScrollView(f.document, { primary: true, follow: "end", scrollbar: "hidden" });
    f.tui.layoutRoot = new VStack([{ component: scroll, grow: 1 }]);
    const cleanups = [];
    if (thinkingFirst) cleanups.push(f.install());
    cleanups.push(installAssistantPanels(f.tui, f.options));
    cleanups.push(installGrouping(f.tui, { defaultMode: "compact", errorPreview: false, groupConsecutive: true, backgrounds: "tool", tools: {} }, f.options));
    const pin = installPinnedPrompt(f.tui, () => themes.theme, () => ({ text: "latest input", displayed: true }), value => f.warnings.push(value));
    assert.ok(pin);
    cleanups.push(() => pin.dispose());
    if (!thinkingFirst) cleanups.push(f.install());
    const rendered = f.document.render(80);
    assert.ok(rendered.find(line => line.includes("final answer")).includes("\x1b[48;"));
    assert.ok(!rendered.find(line => line.includes("Thinking...")).includes("\x1b[48;"));
    assert.ok(plain(f.document).some(line => line.includes("2 tools")));
    const offset = getChildLineOffset(f.chat, user, 80);
    assert.equal(click(f.chat)?.handled, true);
    f.document.render(80);
    assert.ok(plain(f.chat).some(line => line.includes("hidden reasoning")));
    assert.ok(getChildLineOffset(f.chat, user, 80) >= offset);
    assert.ok(f.document.render(80).find(line => line.includes("final answer")).includes("\x1b[48;"));
    assert.equal(click(f.chat, "2 tools")?.handled, true);
    assert.ok(getChildLineOffset(f.chat, user, 80) > offset);
    assert.deepEqual(t1.render(80), toolBefore);
    assert.notDeepEqual(user.render(80), userBefore, "conversation panels tint the user green");
    assert.deepEqual(user.render(80).map(stripVTControlCharacters), userBefore.map(stripVTControlCharacters), "user padding and text stay native");
    assert.ok(plain(f.tui.layoutRoot.children[0])[0].includes("latest input"));
    pin.jump();
    if (thinkingFirst) cleanups.forEach(cleanup => cleanup());
    else cleanups.reverse().forEach(cleanup => cleanup());
    assert.equal(f.document.render, nativeRender);
    assert.deepEqual(user.render(80), userBefore, "cleanup restores native user styling");
    assert.equal(Object.hasOwn(f.document, "render"), false);
    assert.equal(Object.hasOwn(f.chat, "addChild"), false);
    assert.equal(f.warnings.length, 0);
  }
});

test("unsupported shapes fail open, descriptor cleanup respects foreign replacements", () => {
  const warnings = [];
  installThinkingCollapse(new Container(), { requestRender() {}, warn: value => warnings.push(value) })();
  assert.equal(warnings.length, 1);
  const a = assistant([thinking("native")]);
  a.thinkingVisibilityOverrides = undefined;
  const f = fixture([a]);
  const dispose = f.install();
  assert.equal(f.warnings.length, 1);
  f.chat.addChild(a);
  assert.equal(f.warnings.length, 1);
  dispose();
  const b = assistant([thinking("foreign ownership")]);
  const g = fixture([b]);
  const second = g.install();
  const foreignAdd = () => {};
  const foreignGet = () => undefined;
  g.chat.addChild = foreignAdd;
  b.thinkingVisibilityOverrides.get = foreignGet;
  second();
  assert.equal(g.chat.addChild, foreignAdd);
  assert.equal(b.thinkingVisibilityOverrides.get, foreignGet);
  assert.ok(plain(b).some(line => line.includes("foreign ownership")));
});

test("registration is disabled/mode safe and stale widgets cannot dispose a replacement session", async () => {
  const disabled = new Map();
  registerThinkingCollapse({ on(name, handler) { disabled.set(name, handler); } }, false);
  assert.equal(disabled.size, 0);
  const handlers = new Map();
  registerThinkingCollapse({ on(name, handler) { handlers.set(name, handler); } }, true);
  const a = assistant([thinking("session reasoning")]);
  const f = fixture([a]);
  const native = f.chat.addChild;
  let widget;
  let mode = "rpc";
  const ctx = { get mode() { return mode; }, hasUI: true, ui: {
    notify(message) { f.warnings.push(message); },
    setWidget(key, factory) { assert.equal(key, "compact-tools-thinking-collapse"); widget = factory(f.tui); },
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
  assert.deepEqual(widget.render(80), []);
  assert.ok(plain(a).some(line => line.includes("Thinking...")));
  const oldWidget = widget;
  await handlers.get("session_start")({}, ctx);
  oldWidget.dispose();
  assert.notEqual(f.chat.addChild, native);
  assert.ok(plain(a).some(line => line.includes("Thinking...")));
  widget.dispose();
  assert.equal(f.chat.addChild, native);
  assert.ok(plain(a).some(line => line.includes("session reasoning")));
  await handlers.get("session_start")({}, ctx);
  await handlers.get("session_shutdown")({}, ctx);
  await handlers.get("session_shutdown")({}, ctx);
  assert.equal(f.chat.addChild, native);
  assert.equal(f.warnings.length, 0);
});
