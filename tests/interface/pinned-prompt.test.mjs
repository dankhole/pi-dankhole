import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const root = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const fromPi = path => import(pathToFileURL(join(root, path)).href);
const requirePi = createRequire(join(root, "package.json"));
const tuiPath = dirname(requirePi.resolve("@earendil-works/pi-tui"));
const { Container, Text, visibleWidth } = await import(pathToFileURL(join(tuiPath, "index.js")).href);
const { renderLayoutFrame, getScrollViewBox } = await import(pathToFileURL(join(tuiPath, "layout.js")).href);
const { loadExtensions } = await fromPi("dist/core/extensions/loader.js");
const { KeybindingsManager } = await fromPi("dist/core/keybindings.js");
const { createChatViewport } = await fromPi("dist/modes/interactive/chat-viewport.js");
const { SessionManager } = await fromPi("dist/core/session-manager.js");
const { UserMessageComponent } = await fromPi("dist/modes/interactive/components/user-message.js");
const { SkillInvocationMessageComponent } = await fromPi("dist/modes/interactive/components/skill-invocation-message.js");
const { parseSkillBlock } = await fromPi("dist/core/agent-session.js");
const { AssistantMessageComponent } = await fromPi("dist/modes/interactive/components/assistant-message.js");
const { ToolExecutionComponent } = await fromPi("dist/modes/interactive/components/tool-execution.js");
const themeModule = await fromPi("dist/modes/interactive/theme/theme.js");
themeModule.initTheme("dark", false);
const scratch = mkdtempSync(join(tmpdir(), "pi-pinned-input-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = scratch;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(scratch, { recursive: true, force: true });
});
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let serial = 0;
async function load(enabled = true, grouping = false, conversationPanels = true) {
  const path = join(scratch, `extension-${serial++}.ts`);
  writeFileSync(path, `import { registerPinnedPrompt } from ${JSON.stringify(join(project, "src/styling/pinned-prompt.ts"))};
import { registerGrouping } from ${JSON.stringify(join(project, "src/styling/grouping.ts"))};
import { defaults } from ${JSON.stringify(join(project, "src/settings/interface.ts"))};
export default pi => { registerPinnedPrompt(pi, ${enabled}, ${conversationPanels}); ${grouping ? "registerGrouping(pi, defaults());" : ""} }`);
  const loaded = await loadExtensions([path], scratch);
  assert.deepEqual(loaded.errors, []);
  return loaded.extensions[0];
}
async function emit(extension, name, ctx) {
  for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name }, ctx);
}
function setup(identified = false) {
  const manager = identified ? SessionManager.inMemory(scratch) : undefined;
  const chat = new Container();
  const header = new Container();
  header.addChild(new Text("native header", 0, 0));
  const resources = new Container();
  const document = new Container();
  document.addChild(header); document.addChild(resources); document.addChild(chat);
  const widgetsAbove = new Container();
  const editorSlot = new Container();
  let editor = new Text("editor", 0, 0);
  let editorFactory;
  editorSlot.addChild(editor);
  const footerSlot = new Container();
  footerSlot.addChild(new Text("native footer", 0, 0));
  const viewport = createChatViewport({ document, pendingMessages: new Container(), status: new Container(),
    widgetsAbove, editor: editorSlot, widgetsBelow: new Container(), footer: footerSlot, scrollbar: "hidden" });
  const widgets = new Map();
  const notices = [];
  const statuses = new Map();
  let footer;
  let branch = [];
  const tui = { children: [document], layoutRoot: viewport.root, mode: "fullscreen",
    terminal: { rows: 15, columns: 90 }, requestRender() {} };
  const ctx = { mode: "tui", hasUI: true, thinkingLevel: "high", hasPendingMessages: () => false,
    getContextUsage: () => undefined,
    sessionManager: manager ?? {
      getSessionId: () => "test-session", getLeafId: () => null,
      getSessionName: () => undefined, getCwd: () => scratch,
      getEntries: () => branch, getBranch: () => branch,
      getHeader: () => ({ timestamp: new Date(Date.now() - 123000).toISOString() }),
    }, ui: {
    setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
    getEditorComponent: () => editorFactory,
    setEditorComponent(factory) {
      editorFactory = factory;
      editor = factory?.(tui, themeModule.getEditorTheme(), new KeybindingsManager()) ?? new Text("editor", 0, 0);
      editorSlot.clear();
      editorSlot.addChild(editor);
    },
    setFooter(factory) {
      footer?.dispose?.();
      footer = factory?.(tui, themeModule.theme, {
        onBranchChange: () => () => {}, getGitBranch: () => "test-branch",
        getExtensionStatuses: () => statuses,
      });
      footerSlot.clear();
      footerSlot.addChild(footer ?? new Text("native footer", 0, 0));
    },
    get theme() { return themeModule.theme; },
    notify: message => notices.push(message),
    setWidget(key, factory) {
      widgets.get(key)?.dispose?.();
      if (factory === undefined) widgets.delete(key);
      else widgets.set(key, typeof factory === "function" ? factory(tui, themeModule.theme) : new Text(factory.join("\n"), 0, 0));
      widgetsAbove.clear();
      for (const widget of widgets.values()) widgetsAbove.addChild(widget);
    },
  } };
  return { ...viewport, manager, chat, document, header, ctx, tui, widgets, notices, statuses, get footer() { return footer; }, get editor() { return editor; },
    branch(value) { branch = value; },
    frame(width = 90, height = 15) { return renderLayoutFrame(viewport.root, width, height, () => {}); },
    addUser(text) {
      manager?.appendMessage({ role: "user", content: text, timestamp: Date.now() });
      const user = new UserMessageComponent(text); chat.addChild(user); return user;
    },
  };
}
const plain = line => stripVTControlCharacters(line);
const pinVisible = view => plain(view.frame().lines[0]).includes("↑ You:");
const nativeTop = (view, frame = view.frame()) => getScrollViewBox(frame, view.transcript).rect.y;

test("offscreen pinned input uses the green conversation surface and respects the panel toggle", async () => {
  try {
    for (const appearance of ["dark", "light"]) for (const enabled of [true, false]) {
      themeModule.initTheme(appearance, false);
      const extension = await load(true, false, enabled);
      const view = setup(true);
      view.addUser("Pinned user message");
      view.chat.addChild(new Text("later output\n".repeat(30), 0, 0));
      await emit(extension, "session_start", view.ctx);
      const row = view.frame().lines[0];
      assert.match(plain(row), /↑ You: Pinned user message/);
      const native = themeModule.theme.bg("userMessageBg", " ").match(/\x1b\[48;[25];[\d;]+m/)[0];
      const expected = themeModule.theme.getColorMode() === "256color"
        ? `\x1b[48;5;${appearance === "dark" ? 22 : 194}m`
        : `\x1b[48;2;${appearance === "dark" ? "32;59;43" : "245;255;246"}m`;
      assert.ok(row.includes(enabled ? expected : native));
      assert.equal(visibleWidth(row), 90);
      await emit(extension, "session_shutdown", view.ctx);
    }
  } finally { themeModule.initTheme("dark", false); }
});

// These fixtures use the installed native viewport/components and actual in-memory
// session IDs/context projection, not text matching or synthetic visibility flags.
test("identified native latest input removes the whole redundant row and keeps native ownership", async () => {
  const extension = await load();
  const view = setup(true);
  const user = view.addUser("visible latest input");
  const originalHeader = view.header.children[0];
  const originalRender = user.render;
  const originalUpdateLayout = view.transcript.updateLayout;
  const before = view.frame();
  await emit(extension, "session_start", view.ctx);
  for (let index = 0; index < 8; index++) {
    const frame = view.frame();
    assert.equal(nativeTop(view, frame), 0, "no reserved row or gap");
    assert.deepEqual(frame.lines, before.lines, "native message/header/padding remain unchanged");
  }
  assert.equal(view.header.children[0], originalHeader);
  assert.equal(user.render, originalRender);
  assert.equal(view.transcript.updateLayout, originalUpdateLayout);
  assert.equal(view.root.children[0].handleMouse({ type: "click", button: "left", x: 1, y: 0 }), undefined,
    "hidden pin does not intercept native clicks");
  await extension.commands.get("latest-input").handler("", view.ctx);
  assert.equal(view.transcript.isFollowingEnd, false, "keyboard jump still works when hidden");
  assert.deepEqual(view.notices, []);
  await emit(extension, "session_shutdown", view.ctx);
});

test("offscreen above/below, partial text and padding-only intersections follow native scrolling without jitter", async () => {
  const extension = await load();
  const view = setup(true);
  view.chat.addChild(new Text("older response\n".repeat(30), 0, 0));
  const user = view.addUser("first real line\n\nlast real line");
  view.chat.addChild(new Text("newer response\n".repeat(40), 0, 0));
  await emit(extension, "session_start", view.ctx);
  assert.equal(pinVisible(view), true, "latest entry above follow-end viewport");
  const start = view.header.render(90).length + view.chat.children[0].render(90).length;
  const rows = user.render(90);
  const first = rows.findIndex(line => plain(line).trim());
  let last = rows.length - 1;
  while (!plain(rows[last]).trim()) last--;
  const fullHeight = 15 - view.root.children[2].render(90).length;
  const stable = (top, expected, label) => {
    view.transcript.scrollTo(top, { disableFollow: true });
    for (let index = 0; index < 12; index++) {
      const frame = view.frame();
      assert.equal(nativeTop(view, frame), expected ? 1 : 0, label);
      assert.equal(view.transcript.scrollTop, top, "visibility never changes the manual scroll anchor");
    }
  };
  stable(0, true, "latest entry below viewport");
  stable(start + first - fullHeight, true, "only leading padding would intersect without the pin");
  stable(start + first - fullHeight + 1, false, "one real line at viewport bottom is visible");
  stable(start + last, false, "one real line at viewport top is visible");
  stable(start + last + 1, true, "trailing padding alone is not visible text");
  view.transcript.scrollBy(-1);
  assert.equal(pinVisible(view), false, "public scrollBy immediately re-evaluates visibility");
  view.transcript.scrollToEnd();
  assert.equal(pinVisible(view), true);
  await emit(extension, "session_shutdown", view.ctx);
});

test("resize, streaming height and input-dock height changes are measured in the current frame", async () => {
  const extension = await load();
  const view = setup(true);
  view.addUser("latest " + "wrapped words ".repeat(8));
  const output = new Text("reply\n".repeat(14), 0, 0);
  view.chat.addChild(output);
  await emit(extension, "session_start", view.ctx);
  assert.equal(nativeTop(view, view.frame(90, 12)), 1);
  assert.equal(nativeTop(view, view.frame(90, 35)), 0, "taller viewport reveals input immediately");
  assert.equal(nativeTop(view, view.frame(18, 23)), 0, "wrapped final user lines remain partially visible");
  output.setText("responsive ".repeat(8));
  assert.equal(nativeTop(view, view.frame(90, 12)), 0, "wide output leaves the user visible");
  assert.equal(nativeTop(view, view.frame(12, 12)), 1, "width-only resize wraps output and hides the input");
  output.setText("reply\n".repeat(14));
  const widget = new Text("dock\n".repeat(12), 0, 0);
  view.widgets.set("height-changing-widget", widget);
  view.ctx.ui.setWidget("height-changing-widget", () => widget);
  assert.equal(nativeTop(view, view.frame(90, 25)), 1, "dock growth hides the native input");
  view.ctx.ui.setWidget("height-changing-widget", undefined);
  assert.equal(nativeTop(view, view.frame(90, 25)), 0, "dock shrink reveals it");
  output.setText("streamed response\n".repeat(60));
  assert.equal(pinVisible(view), true, "new output moves selected input offscreen");
  view.addUser("next latest user");
  assert.equal(pinVisible(view), false, "new selected entry is natively visible at the bottom");
  await emit(extension, "session_shutdown", view.ctx);
});

test("duplicate user text is associated with selected entry IDs, including branch replacement", async () => {
  const extension = await load();
  const view = setup(true);
  view.addUser("same text");
  const firstId = view.manager.getLeafId();
  view.chat.addChild(new Text("between\n".repeat(35), 0, 0));
  view.addUser("same text");
  view.chat.addChild(new Text("after\n".repeat(35), 0, 0));
  await emit(extension, "session_start", view.ctx);
  view.frame();
  view.transcript.scrollToStart();
  assert.equal(pinVisible(view), true, "older equal text being visible cannot conceal the latest pin");
  await extension.commands.get("latest-input").handler("", view.ctx);
  assert.equal(pinVisible(view), false, "jump targets the second ID, not the visible equal text");
  view.manager.branch(firstId);
  view.manager.appendMessage({ role: "user", content: "same text", timestamp: Date.now() });
  assert.equal(pinVisible(view), true, "old native row cannot be rebound to a different branch ID");
  const before = view.transcript.scrollTop;
  await extension.commands.get("latest-input").handler("", view.ctx);
  assert.equal(view.transcript.scrollTop, before);
  assert.match(view.notices.at(-1), /not in the displayed transcript/);
  view.chat.clear();
  view.chat.addChild(new UserMessageComponent("same text"));
  view.chat.addChild(new UserMessageComponent("same text"));
  assert.equal(pinVisible(view), false, "native branch rebuild maps the new selected entry");
  await emit(extension, "session_shutdown", view.ctx);
});

test("a compacted latest entry never hides or jumps to an older equal-text row", async () => {
  const extension = await load();
  const view = setup(true);
  const older = view.addUser("same compacted text");
  const keptId = view.manager.getLeafId();
  view.addUser("same compacted text");
  view.manager.appendCompaction("summary", null, 100);
  view.chat.clear();
  // Deliberately leave an equal-text native row, as during a transcript rebuild.
  view.chat.addChild(older);
  await emit(extension, "session_start", view.ctx);
  assert.equal(pinVisible(view), true);
  await extension.commands.get("latest-input").handler("", view.ctx);
  assert.match(view.notices.at(-1), /not in the displayed transcript/);
  view.chat.clear();
  view.chat.addChild(new Text("summary", 0, 0));
  assert.equal(pinVisible(view), true, "missing native message keeps history fallback");
  assert.notEqual(view.manager.getLeafId(), keptId);
  await emit(extension, "session_shutdown", view.ctx);
});

test("grouped native transcript height, selected-entry IDs and pin visibility compose", async () => {
  const extension = await load(true, true);
  const view = setup(true);
  const originalRender = view.chat.render;
  const tools = [];
  for (let index = 0; index < 4; index++) {
    const row = new ToolExecutionComponent("bash", `visibility-${index}`, { command: "echo test" }, { showImages: false, outputPad: 1 }, undefined, view.tui, scratch);
    row.updateResult({ content: [{ type: "text", text: "result\n".repeat(12) }], details: undefined, isError: false });
    tools.push(row);
    view.chat.addChild(row);
  }
  view.addUser("after grouped tools");
  view.chat.addChild(new Text("tail\n".repeat(8), 0, 0));
  const children = [...view.chat.children];
  await emit(extension, "session_start", view.ctx);
  view.frame();
  view.transcript.scrollToStart();
  assert.equal(pinVisible(view), false, "collapsed tools keep user text in the viewport");
  const groupY = view.chat.render(90).findIndex(line => /4 tools/.test(plain(line)));
  view.chat.handleMouse({ type: "click", button: "left", x: 4, y: groupY, width: 90, height: view.chat.render(90).length });
  tools[0].setExpanded(true);
  view.transcript.scrollToStart();
  assert.equal(pinVisible(view), true, "expanded group moves the latest entry below the viewport");
  await extension.commands.get("latest-input").handler("", view.ctx);
  assert.equal(pinVisible(view), false, "projected group offsets keep jump/visibility aligned");
  assert.deepEqual(view.chat.children, children, "native turn order and ownership survive");
  await emit(extension, "session_shutdown", view.ctx);
  assert.equal(view.chat.render, originalRender);
});

test("scroll/resize reuse selected history and reload leaves no visibility hooks", async () => {
  const extension = await load();
  const view = setup(true);
  view.addUser("history must not be polled");
  view.chat.addChild(new Text("tail\n".repeat(40), 0, 0));
  let scans = 0;
  const getBranch = view.manager.getBranch.bind(view.manager);
  view.manager.getBranch = (...args) => { scans++; return getBranch(...args); };
  const originalChildren = [...view.root.children];
  const originalEntries = [...view.root.entries];
  await emit(extension, "session_start", view.ctx);
  view.frame();
  const initialScans = scans;
  for (let index = 0; index < 20; index++) {
    view.transcript.scrollBy(index % 2 ? 1 : -1);
    view.frame(index % 2 ? 30 : 90, index % 2 ? 30 : 15);
  }
  assert.equal(scans, initialScans, "no branch scans on scroll or resize");
  for (let index = 0; index < 3; index++) {
    view.widgets.get("compact-tools-pinned-input").dispose();
    assert.deepEqual(view.root.children, originalChildren);
    assert.deepEqual(view.root.entries, originalEntries);
    await emit(extension, "session_start", view.ctx);
    assert.equal(view.root.entries.length, 3, "reload never accumulates rows");
    view.frame();
  }
  await emit(extension, "session_shutdown", view.ctx);
  assert.deepEqual(view.root.children, originalChildren);
  assert.deepEqual(view.root.entries, originalEntries);
});

test("actual skill inputs, image-only inputs and empty branch replacement keep selected provenance", async () => {
  const extension = await load();
  const view = setup(true);
  const skillText = '<skill name="example" location="/tmp/example/SKILL.md">\nSkill body\n</skill>';
  const block = parseSkillBlock(skillText);
  assert.ok(block);
  view.manager.appendMessage({ role: "user", content: skillText, timestamp: Date.now() });
  view.chat.addChild(new SkillInvocationMessageComponent(block));
  await emit(extension, "session_start", view.ctx);
  assert.equal(pinVisible(view), false, "a skill-only native row represents its entry");
  view.chat.addChild(new Text("tail\n".repeat(40), 0, 0));
  assert.equal(pinVisible(view), true);
  await extension.commands.get("latest-input").handler("", view.ctx);
  assert.equal(pinVisible(view), false, "skill jump reveals the selected native row");
  view.manager.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "" }], timestamp: Date.now() });
  assert.equal(pinVisible(view), true, "image-only input keeps its history fallback");
  assert.match(plain(view.frame().lines[0]), /Image attachment/);
  await extension.commands.get("latest-input").handler("", view.ctx);
  assert.match(view.notices.at(-1), /image-only input/);
  view.manager.resetLeaf();
  assert.equal(pinVisible(view), false, "an empty selected branch never pins stale native user text");
  assert.equal(nativeTop(view), 0);
  await emit(extension, "session_shutdown", view.ctx);
});

test("unsupported viewport measurement preserves the pin rather than guessing visibility", async () => {
  const extension = await load();
  for (const unsupported of ["bounds", "projection", "layout"]) {
    const view = setup(true);
    view.addUser("fallback input");
    if (unsupported === "bounds") Object.defineProperty(view.transcript, "scrollTop", { value: undefined });
    if (unsupported === "projection") view.manager.buildContextEntries = undefined;
    if (unsupported === "layout") view.root.gap = 1;
    await emit(extension, "session_start", view.ctx);
    assert.equal(pinVisible(view), true, unsupported);
    if (unsupported === "layout") {
      view.root.gap = 0;
      assert.equal(pinVisible(view), false, "restored supported layout is measured again");
      view.root.gap = 1;
      assert.equal(pinVisible(view), true, "later native layout changes fail open too");
    }
    await emit(extension, "session_shutdown", view.ctx);
  }
});

test("latest input stays in the first fullscreen row while the native transcript scrolls", async () => {
  const extension = await load();
  const view = setup();
  view.addUser("first input");
  const latest = view.addUser("latest user input\nsecond line");
  view.chat.addChild(new Text("long response\n".repeat(60), 0, 0));
  const children = [...view.chat.children];
  await emit(extension, "session_start", view.ctx);
  const frame = view.frame();
  assert.match(plain(frame.lines[0]), /You: latest user input second line/);
  assert.equal(getScrollViewBox(frame, view.transcript).rect.y, 1);
  assert.deepEqual(view.chat.children, children);
  assert.ok(frame.lines.some(line => plain(line).includes("native footer")));
  view.transcript.scrollToStart();
  assert.match(plain(view.frame().lines[0]), /latest user input/);
  assert.ok(view.chat.children.includes(latest));
  await emit(extension, "session_shutdown", view.ctx);
  assert.equal(view.root.children.length, 2);
  assert.equal(view.root.entries.length, 2);
});

test("click and /latest-input jump to the current prompt without following future output", async () => {
  const extension = await load();
  const view = setup();
  view.chat.addChild(new Text("older output\n".repeat(30), 0, 0));
  const user = view.addUser("jump target");
  view.chat.addChild(new Text("newer output\n".repeat(60), 0, 0));
  await emit(extension, "session_start", view.ctx);
  view.frame();
  const expected = view.header.render(90).length + view.chat.children[0].render(90).length;
  const result = view.root.children[0].handleMouse({ type: "click", button: "left", x: 8, y: 0, width: 90, height: 1 });
  assert.equal(result.handled, true);
  assert.equal(view.transcript.scrollTop, expected);
  assert.equal(view.transcript.isFollowingEnd, false);
  view.transcript.scrollToEnd(); view.frame();
  await extension.commands.get("latest-input").handler("", view.ctx);
  assert.equal(view.transcript.scrollTop, expected);
  assert.ok(view.chat.children.includes(user));
  await emit(extension, "session_shutdown", view.ctx);
});

test("jump offsets account for collapsed tool groups before the prompt", async () => {
  const extension = await load(true, true);
  const view = setup();
  for (let index = 0; index < 4; index++) {
    const row = new ToolExecutionComponent("bash", `tool-${index}`, { command: "echo test" }, { showImages: false, outputPad: 1 }, undefined, view.tui, scratch);
    row.updateResult({ content: [{ type: "text", text: "done" }], details: undefined, isError: false });
    view.chat.addChild(row);
  }
  view.addUser("after grouped tools");
  view.chat.addChild(new Text("tail\n".repeat(60), 0, 0));
  await emit(extension, "session_start", view.ctx);
  view.frame();
  const rendered = view.chat.render(90);
  assert.match(rendered.map(plain).join("\n"), /4 tools/);
  assert.deepEqual(view.notices, []);
  const promptLine = rendered.findIndex(line => line.includes("\x1b]133;A\x07"));
  assert.ok(promptLine >= 0);
  await extension.commands.get("latest-input").handler("", view.ctx);
  assert.equal(view.transcript.scrollTop, view.header.render(90).length + promptLine);
  await emit(extension, "session_shutdown", view.ctx);
});

test("resizing, unicode, terminal controls, and rebuilt history keep the correct prompt", async () => {
  const extension = await load();
  const view = setup();
  view.addUser("old");
  await emit(extension, "session_start", view.ctx);
  view.frame();
  view.chat.clear();
  view.addUser("new 😀界é\n\x1b[31mred\x1b[0m\x07");
  for (const width of [1, 2, 12, 40, 90]) {
    const frame = view.frame(width);
    assert.ok(visibleWidth(frame.lines[0]) <= width);
    assert.doesNotMatch(plain(frame.lines[0]), /[\x00-\x1f\x7f-\x9f]/);
  }
  assert.match(plain(view.frame().lines[0]), /new 😀界é red/);
  assert.doesNotMatch(plain(view.frame().lines[0]), /old/);
  await emit(extension, "session_shutdown", view.ctx);
});

test("empty sessions have no pinned row; compacted prompts use history without a false jump", async () => {
  const extension = await load();
  const view = setup();
  await emit(extension, "session_start", view.ctx);
  assert.doesNotMatch(plain(view.frame().lines[0]), /You:/);
  view.branch([{ type: "message", message: { role: "user", content: [{ type: "text", text: "compacted user input" }] } }]);
  assert.match(plain(view.frame().lines[0]), /compacted user input/);
  await extension.commands.get("latest-input").handler("", view.ctx);
  assert.match(view.notices[0], /not in the displayed transcript/);
  await emit(extension, "session_shutdown", view.ctx);
});

test("an image-only latest input never pins or jumps to an older text prompt", async () => {
  const extension = await load();
  const view = setup();
  view.addUser("older text prompt");
  view.chat.addChild(new Text("output\n".repeat(60), 0, 0));
  view.branch([
    { type: "message", message: { role: "user", content: "older text prompt" } },
    { type: "message", message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "" }] } },
  ]);
  await emit(extension, "session_start", view.ctx);
  assert.match(plain(view.frame().lines[0]), /\[Image attachment\]/);
  assert.doesNotMatch(plain(view.frame().lines[0]), /older text prompt/);
  const before = view.transcript.scrollTop;
  await extension.commands.get("latest-input").handler("", view.ctx);
  assert.equal(view.transcript.scrollTop, before);
  assert.match(view.notices[0], /image-only input/);
  view.branch([{ type: "message", message: { role: "user", content: "newer compacted prompt" } }]);
  assert.match(plain(view.frame().lines[0]), /newer compacted prompt/);
  await emit(extension, "session_shutdown", view.ctx);
});

test("switching regular and fullscreen reconciles the bar without reload", async () => {
  const extension = await load();
  const view = setup();
  view.addUser("switch modes");
  view.tui.mode = "regular";
  delete view.tui.layoutRoot;
  await emit(extension, "session_start", view.ctx);
  assert.equal(view.root.children.length, 2);
  const widget = view.widgets.get("compact-tools-pinned-input");
  view.tui.mode = "fullscreen";
  view.tui.layoutRoot = view.root;
  widget.render(90);
  assert.equal(view.root.children.length, 3);
  assert.match(plain(view.frame().lines[0]), /switch modes/);
  view.tui.mode = "regular";
  delete view.tui.layoutRoot;
  widget.render(90);
  assert.equal(view.root.children.length, 2);
  view.tui.mode = "fullscreen";
  view.tui.layoutRoot = view.root;
  widget.render(90);
  assert.equal(view.root.children.length, 3);
  assert.deepEqual(view.notices, []);
  await emit(extension, "session_shutdown", view.ctx);
  assert.equal(view.root.children.length, 2);
});

test("widget disposal, shutdown and repeated starts restore only the added bar", async () => {
  const extension = await load();
  const view = setup();
  view.addUser("input");
  const originalChildren = [...view.root.children];
  const originalEntries = [...view.root.entries];
  await emit(extension, "session_start", view.ctx);
  await emit(extension, "session_start", view.ctx);
  assert.equal(view.root.children.length, 3);
  view.widgets.get("compact-tools-pinned-input").dispose();
  assert.deepEqual(view.root.children, originalChildren);
  assert.deepEqual(view.root.entries, originalEntries);
  await emit(extension, "session_shutdown", view.ctx);
  assert.deepEqual(view.root.children, originalChildren);
});

test("full extension wiring combines all UI features and cleans on reload", async () => {
  const loaded = await loadExtensions([join(project, "src/styling/index.ts")], scratch);
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.getAllTools = () => [];
  const extension = loaded.extensions[0];
  const view = setup();
  view.addUser("full extension input");
  const resolver = extension.toolRenderers[0];
  for (let index = 0; index < 2; index++) {
    const row = new ToolExecutionComponent("bash", `full-${index}`, { command: "echo test" }, { showImages: false, outputPad: 1 }, resolver("bash", () => undefined), view.tui, scratch);
    row.updateResult({ content: [{ type: "text", text: "done" }], details: undefined, isError: false });
    view.chat.addChild(row);
  }
  const originalRender = view.chat.render;
  await emit(extension, "session_start", view.ctx);
  try {
    assert.match(plain(view.frame().lines[0]), /full extension input/);
    assert.match(view.chat.render(90).map(plain).join("\n"), /2 tools/);
    const clickChat = y => {
      const lines = view.chat.render(90);
      return view.chat.handleMouse({ type: "click", button: "left", x: 5, y, width: 90, height: lines.length });
    };
    const footerY = () => view.chat.render(90).findIndex(line => /2 tools/.test(plain(line)));
    assert.equal(clickChat(footerY())?.handled, true);
    let revealed = view.chat.render(90).map(plain);
    assert.match(revealed.at(-1), /▴.*2 tools/);
    assert.equal(revealed.filter(line => /✓ bash/.test(line)).length, 2);
    assert.doesNotMatch(revealed.join("\n"), /done/); // No result details just from opening the group.
    const firstToolY = revealed.findIndex(line => /✓ bash/.test(line));
    assert.equal(clickChat(firstToolY)?.handled, true);
    assert.equal(view.chat.children[1].expanded, true);
    assert.equal(view.chat.children[2].expanded, false);
    assert.match(view.chat.render(90).map(plain).join("\n"), /done/);
    assert.equal(clickChat(footerY())?.handled, true);
    revealed = view.chat.render(90).map(plain);
    assert.match(revealed.at(-1), /▸.*2 tools/);
    assert.doesNotMatch(revealed.join("\n"), /✓ bash|done/);
    assert.equal(view.statuses.get("compact-tools:chat-timer"), "2m");
    assert.match(plain(view.editor.render(90)[1]), /test-branch/);
    assert.match(plain(view.editor.render(90)[1]), /2m/);
    assert.equal(view.footer.render(90).length, 0, "stats share the input top border, not another row");
    assert.equal(view.editor.render(90).length, 5, "empty input has two borders, one editable row and outer whitespace");
    assert.equal(view.editor.render(90)[0], "");
    assert.equal(view.editor.render(90).at(-1), "");
    assert.match(plain(view.editor.render(90)[1]), /no-model/);
    view.editor.setText("draft survives pending questions");
    const ordinaryEditor = view.editor;
    assert.ok(extension.tools.has("ask_user"));
    assert.ok(extension.commands.has("q"));
    assert.ok(extension.commands.has("questions"));
    // Registering a question must not steal the editor or open the answer UI.
    const entries = [];
    loaded.runtime.appendEntry = (customType, data) => {
      entries.push({ type: "custom", customType, data });
      view.branch(entries);
    };
    let dialogs = 0;
    view.ctx.ui.custom = () => { dialogs++; throw new Error("Question UI must be user-opened"); };
    const question = await extension.tools.get("ask_user").definition.execute("integration-question",
      { question: "Keep the ordinary input available?", options: [{ label: "Yes" }, { label: "No" }] },
      undefined, undefined, view.ctx);
    assert.equal(dialogs, 0);
    assert.equal(view.editor, ordinaryEditor);
    assert.equal(view.editor.getText(), "draft survives pending questions");
    assert.equal(question.details.status, "pending");
    assert.equal(question.terminate, true);
    const pending = view.widgets.get("compact-tools:questions");
    assert.equal(pending.render(90).length, 4, "new questions start expanded without a trailing spacer");
    assert.equal(plain(pending.render(90)[0]).trim(), "");
    assert.match(plain(pending.render(90).at(-1)), /Keep the ordinary input available/);
    assert.match(pending.render(90).map(plain).join("\n"), /question/i);
    assert.doesNotMatch(plain(view.editor.render(90)[1]), /pending question|· \/q/);
    assert.equal(view.statuses.has("compact-tools:questions"), false, "only the widget shows pending questions");
    assert.match(plain(view.frame().lines[0]), /full extension input/);
    assert.match(view.chat.render(90).map(plain).join("\n"), /2 tools/);
    const answer = new AssistantMessageComponent({ role: "assistant", content: [
      { type: "thinking", thinking: "Reasoning stays unshaded" },
      { type: "text", text: "Assistant answer has a panel" },
    ], stopReason: "stop" });
    view.chat.addChild(answer);
    view.frame(); // The document adapter discovers newly streamed/native message components.
    const answerLines = answer.render(90);
    assert.match(answerLines.find(line => plain(line).includes("Assistant answer has a panel")), /\x1b\[(?:48[;:]|10[0-7]m)/);
    const thinkingRow = answerLines.findIndex(line => plain(line).includes("Thinking..."));
    assert.ok(thinkingRow >= 0, "completed thinking is collapsed by the fully registered extension");
    assert.doesNotMatch(answerLines[thinkingRow], /\x1b\[(?:48[;:]|10[0-7]m)/);
    assert.equal(answer.handleMouse({ type: "click", button: "left", x: 3, y: thinkingRow, width: 90, height: answerLines.length })?.handled, true);
    view.frame();
    assert.doesNotMatch(answer.render(90).find(line => plain(line).includes("Reasoning stays unshaded")), /\x1b\[(?:48[;:]|10[0-7]m)/);
    assert.deepEqual(view.notices, []);
    // /reload disposes extension widgets before session_shutdown.
    for (const widget of view.widgets.values()) widget.dispose?.();
    assert.equal(view.root.children.length, 2);
    assert.equal(view.chat.render, originalRender);
  } finally { await emit(extension, "session_shutdown", view.ctx); }
  assert.equal(view.statuses.size, 0);
});

test("disabled, non-TUI, regular and incompatible layouts leave native UI intact", async () => {
  for (const scenario of ["disabled", "rpc", "regular", "incompatible"]) {
    const extension = await load(scenario !== "disabled");
    const view = setup();
    view.addUser("input");
    if (scenario === "rpc") view.ctx.mode = "rpc";
    if (scenario === "regular") { view.tui.mode = "regular"; delete view.tui.layoutRoot; }
    if (scenario === "incompatible") view.root.entries = [];
    const originalChildren = [...view.root.children];
    await emit(extension, "session_start", view.ctx);
    assert.deepEqual(view.root.children, originalChildren);
    if (scenario === "incompatible") assert.match(view.notices[0], /unavailable/);
    else assert.deepEqual(view.notices, []);
    await extension.commands.get("latest-input").handler("", view.ctx);
    assert.match(view.notices.at(-1), /requires fullscreen/);
    await emit(extension, "session_shutdown", view.ctx);
  }
});
