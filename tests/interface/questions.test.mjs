import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

// Real installed loader, SessionManager, themes, keybindings, Input and tool shell; fake terminal
// lifecycle only. No API keys, model calls, settings writes, or interactive runtime are needed.
const root = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const requirePi = createRequire(join(root, "package.json"));
const fromPi = path => import(pathToFileURL(join(root, path)).href);
const { loadExtensions } = await fromPi("dist/core/extensions/loader.js");
const { SessionManager } = await fromPi("dist/core/session-manager.js");
const { AgentSession } = await fromPi("dist/core/agent-session.js");
const { KeybindingsManager } = await fromPi("dist/core/keybindings.js");
const { ToolExecutionComponent } = await fromPi("dist/modes/interactive/components/tool-execution.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
const tuiPath = requirePi.resolve("@earendil-works/pi-tui");
const { Container, Text, Input, Spacer, visibleWidth, stripTerminalSequences, wrapTextWithAnsi, backgroundAnsi, parseColor, getOsc8LinkAtColumn, getCapabilities, setCapabilities } = await import(pathToFileURL(tuiPath).href);
const { renderLayoutFrame, getLayoutBoxesAt, getScrollViewBox } = await import(pathToFileURL(join(dirname(tuiPath), "layout.js")).href);
const { createChatViewport } = await fromPi("dist/modes/interactive/chat-viewport.js");
themes.initTheme("dark", false);
const scratch = mkdtempSync(join(tmpdir(), "pi-questions-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const questionsPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/questions/questions.ts");
const entryType = "compact-tools:question";
const statusKey = "compact-tools:questions";
const deliveryStatusKey = "compact-tools:question-delivery";
let serial = 0;
const user = text => ({ role: "user", content: text, timestamp: Date.now() });
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() });
const plain = (component, width = 100) => component.render(width).map(stripVTControlCharacters).join("\n");

async function harness(options = {}) {
  const path = join(scratch, `questions-${serial++}.ts`);
  writeFileSync(path, `import {registerQuestions} from ${JSON.stringify(questionsPath)};
import {registerPinnedPrompt} from ${JSON.stringify(resolve(dirname(questionsPath), "../styling/pinned-prompt.ts"))};
import {registerGrouping} from ${JSON.stringify(resolve(dirname(questionsPath), "../styling/grouping.ts"))};
import {defaults} from ${JSON.stringify(resolve(dirname(questionsPath), "../settings/interface.ts"))};
export default pi => { registerQuestions(pi, ${options.enabled !== false}); ${options.pin ? "registerPinnedPrompt(pi, true);" : ""} ${options.grouping ? "registerGrouping(pi, defaults());" : ""} }`);
  const loaded = await loadExtensions([path], scratch);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const manager = options.manager ?? SessionManager.inMemory(scratch);
  const statuses = new Map([["other", "keep me"]]);
  const widgets = new Map();
  const notifications = [];
  const confirmations = [];
  const dialogs = [];
  const sent = [];
  let current;
  const ctx = {
    mode: options.mode ?? "tui", hasUI: options.hasUI ?? true,
    sessionManager: manager,
    hasPendingMessages: () => false,
    isIdle: () => true,
    waitForIdle() { assert.fail("must not deadlock an active question with waitForIdle"); },
    ui: {
      get theme() { return themes.theme; },
      setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
      setWidget(key, value, placement) { if (value === undefined) widgets.delete(key); else widgets.set(key, { factory: value, placement }); },
      notify(message, type) { notifications.push({ message, type }); },
      async confirm(title, message) {
        confirmations.push({ title, message });
        return options.confirmRetry ?? true; // Explicit simulated dialog acceptance in this fixture.
      },
      custom(factory, customOptions) {
        assert.equal(ctx.mode, "tui");
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        const dialog = { component: undefined, customOptions, closes: 0, renders: 0, done(value) { dialog.closes++; resolve(value); } };
        dialog.component = factory({ terminal: { rows: options.rows ?? 24 }, requestRender() { dialog.renders++; } }, themes.theme, new KeybindingsManager(), dialog.done);
        dialog.component.focused = true;
        dialogs.push(dialog);
        current = dialog;
        return promise;
      },
    },
  };
  loaded.runtime.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, structuredClone(data));
  loaded.runtime.sendUserMessage = (content, sendOptions) => { sent.push({ content, options: sendOptions }); };
  const emit = async (name, event = {}, context = ctx) => {
    const results = [];
    for (const handler of extension.handlers.get(name) ?? []) results.push(await handler({ type: name, ...event }, context));
    return results;
  };
  const tool = extension.tools.get("ask_user")?.definition;
  const updates = [];
  let call = 0;
  const ask = (params = { question: "Proceed?" }, signal) => tool.execute(`call-${++call}`, params, signal, update => updates.push(update), ctx);
  const resolutionTool = extension.tools.get("resolve_question")?.definition;
  const resolveQuestion = (params, signal) => resolutionTool.execute(`resolve-${++call}`, params, signal, undefined, ctx);
  const command = args => extension.commands.get("q").handler(args ?? "", ctx);
  const records = () => ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === entryType).map(entry => entry.data);
  const latest = () => records().at(-1);
  const message = async msg => {
    // Actual Pi ordering: message_end handlers run before appendMessage.
    await emit("message_end", { message: msg });
    ctx.sessionManager.appendMessage(msg);
  };
  const toolMessage = async result => message({ role: "toolResult", toolName: "ask_user", toolCallId: result.details.question.toolCallId, ...result, timestamp: Date.now() });
  const input = async (text, extra = {}) => {
    const results = await emit("input", { text, source: "interactive", ...extra });
    if (extra.persist !== false) await message(user(text));
    return results;
  };
  const widget = (width = 100) => {
    const stored = widgets.get(statusKey);
    if (!stored) return "";
    assert.equal(stored.placement.placement, "aboveEditor");
    return plain(stored.factory({ terminal: { rows: options.rows ?? 24 }, requestRender() {} }, themes.theme), width);
  };
  const widgetComponent = (terminal = { rows: options.rows ?? 24 }) => widgets.get(statusKey)?.factory({ terminal, requestRender() {} }, themes.theme);
  const submitCustom = text => { current.component.handleInput(text); current.component.handleInput("\r"); };
  const submitOption = () => {
    current.component.handleInput("\r"); // Enter sends the highlighted choice directly.
  };
  await emit("session_start");
  return { loaded, extension, ctx, manager, statuses, widgets, notifications, confirmations, dialogs, sent, tool, resolutionTool, resolveQuestion, updates, ask, command, emit, message, toolMessage, input, records, latest, widget, widgetComponent, submitCustom, submitOption, current: () => current };
}

// Use Pi's real event/persistence handler while bypassing unrelated model/tool runtime setup.
function orderingHost(h, beforeAppend = () => {}) {
  class Host extends AgentSession {
    _installAgentToolHooks() {}
    _installAgentNextTurnRefresh() {}
    _installAgentRequestProjection() {}
    _installAgentBoundaryHooks() {}
    _installHiddenDeclarationsProjection() {}
    _installAgentForcedPromptProjection() {}
    _buildRuntime() {}
    async _emitExtensionEvent(event) { await h.emit(event.type, event); }
    _emit(event) { beforeAppend(event); }
  }
  return new Host({ agent: { subscribe: () => () => {} }, sessionManager: h.manager, cwd: scratch });
}

// Legacy persisted tool answers remain supported after switching to manual-only dialogs.
async function legacyToolAnswer(h, text, question = "Proceed?") {
  const pending = await h.ask({ question });
  const record = { ...pending.details.question, status: "answered", answer: { text }, delivery: "tool", delivered: false };
  h.manager.appendCustomEntry(entryType, record);
  await h.emit("session_tree");
  return { content: [{ type: "text", text }], details: { status: "answered", question: record } };
}

function nativeQuestionView(h, { rows = 24, width = 80 } = {}) {
  const chat = new Container();
  const document = new Container();
  document.addChild(new Container()); document.addChild(new Container()); document.addChild(chat);
  const widgetsAbove = new Container();
  const editor = new Input(); editor.setValue("Unsent ordinary draft"); editor.focused = true;
  const pendingMessages = new Container();
  const viewport = createChatViewport({ document, pendingMessages, status: new Container(), widgetsAbove,
    editor, footer: new Text("Footer", 0, 0), scrollbar: "hidden" });
  const tui = { children: [document], layoutRoot: viewport.root, mode: "fullscreen", terminal: { rows, columns: width }, requestRender() {} };
  const instances = new Map();
  const sync = () => {
    for (const key of instances.keys()) if (!h.widgets.has(key)) { instances.get(key).component.dispose?.(); instances.delete(key); }
    for (const [key, widget] of h.widgets) if (instances.get(key)?.factory !== widget.factory) {
      instances.get(key)?.component.dispose?.();
      instances.set(key, { factory: widget.factory, component: widget.factory(tui, themes.theme) });
    }
    widgetsAbove.clear();
    widgetsAbove.addChild(new Spacer(1)); // InteractiveMode.renderWidgetContainer's native above-input separator.
    for (const { component } of instances.values()) widgetsAbove.addChild(component);
  };
  const frame = (columns = tui.terminal.columns, height = tui.terminal.rows) => {
    tui.terminal.columns = columns; tui.terminal.rows = height; sync();
    return renderLayoutFrame(viewport.root, columns, height, () => {});
  };
  return { ...viewport, tui, document, chat, widgetsAbove, pendingMessages, editor, frame,
    text: () => frame().lines.map(stripTerminalSequences).join("\n"),
    list: () => { sync(); return instances.get(statusKey)?.component; },
    reminderVisible: () => { frame(); return (instances.get(statusKey)?.component.render(tui.terminal.columns).length ?? 0) > 0; },
    add(result, args = { question: result.details.question.question }) {
      const component = new ToolExecutionComponent("ask_user", result.details.question.toolCallId, args, { showImages: false }, h.tool, tui, scratch);
      component.updateResult(result); chat.addChild(component); return component;
    },
    click(pattern) {
      const current = frame();
      const y = current.lines.map(stripTerminalSequences).findIndex(line => pattern.test(line));
      assert.ok(y >= 0, `native frame target ${pattern}`);
      const box = getLayoutBoxesAt(current, 3, y).find(box => box.component === document);
      assert.ok(box, "native layout contains transcript document at the target");
      return document.handleMouse({ type: "click", button: "left", x: 3 - box.rect.x, y: y - box.rect.y,
        screenX: 3, screenY: y, width: box.rect.width, height: box.rect.height });
    },
  };
}

test("registers model-only sequential question and resolution tools; disabled is inert", async () => {
  const h = await harness();
  assert.deepEqual([...h.extension.tools.keys()], ["ask_user", "resolve_question"]);
  assert.equal(h.resolutionTool.exposure, "model-only");
  assert.equal(h.resolutionTool.executionMode, "sequential");
  assert.match(h.resolutionTool.promptGuidelines.join("\n"), /not intent or authorization/);
  assert.match(h.resolutionTool.promptGuidelines.join("\n"), /later cancellations\/revocations/);
  assert.deepEqual([...h.extension.commands.keys()], ["q", "questions"]);
  assert.equal(h.extension.commands.get("q").handler, h.extension.commands.get("questions").handler);
  assert.match(h.tool.description, /Questions or \/q /);
  assert.doesNotMatch(h.tool.description, /\/questions/);
  assert.equal(h.tool.exposure, "model-only");
  assert.equal(h.tool.executionMode, "sequential");
  assert.equal(h.extension.toolRenderers?.length ?? 0, 0);
  assert.match(h.tool.promptGuidelines.join("\n"), /ALONE.*NOT an authorization gate/);
  assert.match(h.tool.promptGuidelines.join("\n"), /questions you would otherwise ask/);
  assert.match(h.tool.promptGuidelines.join("\n"), /do not ask extra questions/);
  const disabled = await harness({ enabled: false });
  assert.equal(disabled.extension.tools.size, 0);
  assert.equal(disabled.extension.handlers.size, 0);
  assert.equal(disabled.extension.commands.size, 0);
});

test("ask_user returns pending immediately without auto-open; recommendation only appears in manually opened overlay", async () => {
  const h = await harness();
  const result = await h.ask({ question: "Which database?", options: [{ label: "SQLite", description: "Local only" }, { label: "Postgres" }], recommended_option: 1, rationale: "No service required" });
  assert.equal(h.dialogs.length, 0);
  assert.equal(result.details.status, "pending");
  assert.equal(result.terminate, true);
  assert.equal(h.updates.length, 0, "no repeated pending tool update");
  assert.equal(h.widget().split("\n").length, 2, "one top spacer then the question, without a header or trailing blank rows");
  assert.doesNotMatch(h.widget(), /Questions ·|\d+ pending/);
  assert.match(h.widget(), /Q1: Which database/);
  assert.match(h.widget(), /Which database/);
  const pending = h.command("Q1");
  assert.equal(h.current().customOptions.overlay, true);
  assert.equal(h.current().customOptions.overlayOptions.anchor, "center");
  assert.match(plain(h.current().component), /recommended/);
  assert.equal(h.latest().status, "pending");
  h.current().component.handleInput("\x1b[B");
  h.current().component.handleInput("\x1b[A");
  assert.equal(h.current().closes, 0, "navigation does not approve");
  h.current().component.handleInput("\r");
  await pending;
  assert.equal(h.latest().answer.text, "SQLite");
  assert.equal(h.latest().answer.optionIndex, 0);
  assert.equal(h.widget(), "", "submitted questions clear immediately, before delivery confirmation");
  assert.equal(h.statuses.get(statusKey), undefined);
  assert.match(h.statuses.get(deliveryStatusKey), /saved answer.*delivery unconfirmed/);
  assert.equal(h.sent.length, 1);
  await h.message(user(h.sent[0].content));
  assert.equal(h.latest().delivered, false, "message_end confirmation is memory-only");
  assert.equal(h.statuses.get(deliveryStatusKey), undefined);
  assert.equal(h.statuses.get(statusKey), undefined);
  assert.equal(h.statuses.get("other"), "keep me");
});

test("everyday reminder omits its heading and command hints; /q and /questions remain manual entry points", async () => {
  const h = await harness();
  await h.ask();
  assert.doesNotMatch(h.widget().split("\n")[1], /\/q|▾|▸/);
  assert.equal(h.statuses.get(statusKey), undefined, "no redundant pending count in the status bar");
  assert.equal((h.widget().match(/Q\d+:/g) ?? []).length, 1);
  const opened = h.extension.commands.get("questions").handler("Q1", h.ctx);
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.current().customOptions.overlayOptions.width, "90%");
  h.current().component.handleInput("\x1b");
  await opened;
  assert.equal(h.latest().status, "pending");
  assert.equal(h.sent.length, 0);
});

test("headerless question entries are full-width colored click targets in both themes", async () => {
  for (const appearance of ["light", "dark"]) {
    themes.initTheme(appearance, false);
    const h = await harness();
    await h.ask({ question: "Readable scope?" });
    const widget = h.widgetComponent();
    for (const width of [1, 24, 100]) {
      const [, entry] = widget.render(width);
      assert.equal(visibleWidth(entry), width, "question background reaches the row edge");
      assert.match(entry, /\x1b\[(?:48;[25];[^m]+|4[0-7]|10[0-7])m/, "explicit theme background");
    }
    const lines = widget.render(100);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "", "one unfilled row separates the reminder from the transcript");
    assert.match(stripTerminalSequences(lines[1]), /Q1: Readable scope/);
    assert.doesNotMatch(lines.map(stripTerminalSequences).join("\n"), /Questions ·|\d+ pending/);
    assert.notEqual(stripTerminalSequences(lines.at(-1)).trim(), "", "content ends the widget, not extra blank rows");
    assert.equal(visibleWidth(lines[1]), 100, "entry padding is colored and clickable");
    assert.match(lines[1], /\x1b\[(?:48;[25];[^m]+|4[0-7]|10[0-7])m/);
    widget.handleMouse({ type: "click", button: "left", x: 99, y: 1 });
    assert.equal(h.dialogs.length, 1, "far-right padding opens the question");
    h.current().component.handleInput("\x1b");
    await h.emit("session_shutdown");
  }
  themes.initTheme("dark", false);
});

test("explicit Dismiss click removes pending without answering or sending and survives reload/tree changes", async () => {
  const h = await harness({ rows: 50 });
  await h.ask({ question: "Approve deployment?", options: [{ label: "Yes" }, { label: "No" }] });
  const branchRoot = h.manager.appendMessage(user("Before dismissal"));
  const opening = h.command("Q1");
  const component = h.current().component;
  component.handleInput(" "); // A staged option must never become an answer through Dismiss.
  const lines = component.render(100).map(stripVTControlCharacters);
  const y = lines.findIndex(line => line.includes("Dismiss"));
  assert.ok(y >= 0, "Dismiss is visible without scrolling");
  const result = component.handleMouse({ type: "click", button: "left", x: lines[y].indexOf("Dismiss"), y });
  assert.equal(result.handled, true);
  assert.notEqual(result.focus, true, "closed overlay must not reclaim host focus");
  await opening;
  assert.equal(h.latest().status, "dismissed");
  for (const field of ["answer", "delivery", "delivered", "continuation"]) assert.equal(h.latest()[field], undefined);
  assert.equal(h.widget(), "");
  assert.equal(h.statuses.get(statusKey), undefined);
  assert.equal(h.sent.length, 0, "dismissal never starts a model turn");
  assert.equal(h.dialogs.length, 1);
  const [reminder] = await h.emit("before_agent_start");
  assert.match(reminder.message.content, /Dismissed, still unanswered/);
  assert.match(reminder.message.content, /dismissed by the user/);
  assert.match(reminder.message.content, /Q1: Approve deployment/);
  assert.match(reminder.message.content, /NOT answers or approvals/);
  assert.match(reminder.message.content, /Do not re-ask or reuse dismissed IDs/);
  await h.command("Q1");
  await h.command("Q1 retry");
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.sent.length, 0);
  assert.equal((await h.ask({ question: "Approve deployment?", options: [{ label: "Yes" }, { label: "No" }], question_id: 1 })).isError, true);
  await h.message(assistant("Q1: Approve deployment?"));
  assert.equal(h.latest().status, "dismissed", "repeated prose cannot reopen a dismissed ID");
  await h.emit("session_shutdown");
  const resumed = await harness({ manager: h.manager });
  assert.equal(resumed.widget(), "");
  assert.equal(resumed.dialogs.length, 0);
  assert.equal(resumed.sent.length, 0);
  resumed.manager.branch(branchRoot);
  await resumed.emit("session_tree");
  assert.equal(resumed.widget(), "", "branching before dismissal does not resurrect it");
  const [treeReminder] = await resumed.emit("before_agent_start");
  assert.match(treeReminder.message.content, /Dismissed, still unanswered/);
  assert.match(treeReminder.message.content, /dismissed by the user/);
  assert.equal((await resumed.ask({ question: "Next?" })).details.question.id, 2);
});

test("dismissal cannot survive generation replacement as a late write into another session", async () => {
  const h = await harness();
  await h.ask();
  const opening = h.command();
  const old = h.current();
  await h.emit("session_shutdown");
  h.ctx.sessionManager = SessionManager.inMemory(scratch);
  await h.emit("session_start");
  old.done({ kind: "dismiss" });
  await opening;
  assert.equal(h.records().length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.widget(), "");
});

test("text-only question supports custom input with one Enter submission", async () => {
  const h = await harness();
  const result = await h.ask({ question: "What should this be named?" });
  assert.equal(h.dialogs.length, 0);
  const pending = h.command();
  h.current().component.handleInput("Project 雪");
  h.current().component.handleInput("\r");
  assert.equal(h.current().closes, 1);
  await pending;
  assert.deepEqual(result.details.question.options, []);
  assert.deepEqual(h.latest().answer, { text: "Project 雪" });
});

test("Escape keeps pending and ordinary /questions reopening never resends a saved answer", async () => {
  const h = await harness();
  const result = await h.ask();
  const opening = h.command();
  h.current().component.handleInput("\x1b"); await opening;
  assert.equal(result.details.status, "pending");
  assert.equal(result.details.question.answer, undefined);
  assert.equal(result.terminate, true);
  assert.equal((h.widget().match(/Q\d+:/g) ?? []).length, 1);
  assert.equal(h.statuses.get(statusKey), undefined, "no duplicate pending reminder in status bar");
  assert.equal((h.widget().match(/Q\d+:/g) ?? []).length, 1);
  const answering = h.command("Q1");
  h.submitCustom("No, do not proceed");
  await answering;
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].content, /Answer to Q1\nQuestion: Proceed\?\nUser answer: No, do not proceed/);
  assert.deepEqual(h.sent[0].options, { deliverAs: "steer", expandPromptTemplates: false });
  await h.command("Q1");
  assert.equal(h.sent.length, 1, "queued answer must not be repeated");
  await h.message(user(h.sent[0].content));
  await h.command("Q1");
  assert.equal(h.sent.length, 1, "confirmed answer must not be repeated");
  assert.equal(h.widget(), "");
});

test("void delivery rejects real model/auth preflight without settlement; only explicit retry resends", async () => {
  for (const failure of ["missing-model", "missing-auth"]) {
    const h = await harness();
    await h.ask();
    // Exercise the installed sendUserMessage -> prompt -> input/preflight path. Only the agent
    // run after successful preflight is faked; no provider or credential lookup is performed.
    const host = Object.create(AgentSession.prototype);
    host.agent = { state: { model: failure === "missing-model" ? undefined : { provider: "test-provider", id: "test-model" } } };
    host._extensionRunner = { hasHandlers: () => false };
    host._isAgentRunActive = false;
    let configuredAuth = false;
    host._modelRuntime = { hasConfiguredAuth: () => configuredAuth, checkAuth: async () => undefined, isUsingOAuth: () => false };
    host._emitAgentSettled = () => assert.fail("preflight rejection must not synthesize settlement");
    const attempts = [], errors = [], completions = [];
    let runs = 0;
    host._startRun = async trigger => { runs++; await h.message(user(trigger.prompt)); };
    h.ctx.isIdle = () => host.isIdle;
    h.loaded.runtime.sendUserMessage = (content, options) => {
      attempts.push({ content, options });
      // This is Pi's actual public extension-action contract: void, errors reported separately.
      completions.push(host.sendUserMessage(content, options).catch(error => { errors.push(error); }));
    };
    const answering = h.command("Q1"); h.submitCustom("No, preserve the current state"); await answering;
    await Promise.all(completions);
    assert.equal(attempts.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, failure === "missing-model" ? /model/i : /API key|auth/i);
    assert.equal(runs, 0);
    assert.equal(h.latest().delivered, false);
    assert.equal(h.widget(), "");
    assert.match(h.statuses.get(deliveryStatusKey), /saved answer.*delivery unconfirmed/);
    await h.command("Q1");
    assert.equal(attempts.length, 1, "normal reopen must never duplicate an unconfirmed answer");
    assert.match(h.notifications.at(-1).message, /Q1 retry.*duplicate/);
    host.agent.state.model = { provider: "test-provider", id: "test-model" };
    configuredAuth = true;
    await h.command("Q1 retry");
    await Promise.all(completions);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].content, attempts[0].content, "retry delivers only the already saved answer/scope");
    assert.equal(runs, 1);
    assert.equal(h.latest().delivered, false, "delivery is derived from durable messages, not rewritten snapshots");
    assert.equal(h.statuses.get(deliveryStatusKey), undefined);
    assert.equal(h.confirmations.length, 1);
    await h.command("Q1 retry");
    assert.equal(attempts.length, 2, "confirmed delivery blocks even explicit retry");
  }
});

test("real message_end ordering cannot durably confirm delivery before host appendMessage", async () => {
  const h = await harness();
  await h.ask();
  const opening = h.command(); h.submitCustom("Preserve current state"); await opening;
  const before = h.records().length;
  const msg = user(h.sent[0].content);
  const host = orderingHost(h, event => {
    assert.equal(event.type, "message_end");
    assert.equal(h.manager.getBranch().some(entry => entry.type === "message" && entry.message === msg), false);
    assert.equal(h.records().length, before, "extension event writes no confirmation snapshot before append");
    assert.equal(h.latest().delivered, false);
    assert.equal(h.statuses.get(deliveryStatusKey), undefined, "live event may confirm in memory");
    throw new Error("simulated crash before host appendMessage");
  });
  await assert.rejects(host._handleAgentEvent({ type: "message_end", message: msg }), /simulated crash/);
  const restored = await harness({ manager: h.manager, confirmRetry: false });
  assert.match(restored.statuses.get(deliveryStatusKey), /delivery unconfirmed/);
  assert.equal(restored.sent.length, 0);
  // Reproduce an older extension's false durable confirmation snapshot.
  restored.manager.appendCustomEntry(entryType, { ...restored.latest(), delivered: true });
  const repaired = await harness({ manager: restored.manager, confirmRetry: false });
  assert.match(repaired.statuses.get(deliveryStatusKey), /delivery unconfirmed/, "legacy delivered=true without a message cannot hide recovery");
  await repaired.command("Q1 retry");
  assert.equal(repaired.confirmations.length, 1);
  assert.equal(repaired.sent.length, 0);
  const normalHost = orderingHost(repaired);
  await normalHost._handleAgentEvent({ type: "message_end", message: msg });
  assert.ok(repaired.manager.getBranch().some(entry => entry.type === "message" && entry.message === msg));
  const delivered = await harness({ manager: repaired.manager });
  assert.equal(delivered.statuses.get(deliveryStatusKey), undefined, "actual durable history confirms on restoration");
  await delivered.command("Q1 retry");
  assert.equal(delivered.sent.length, 0);
  assert.equal(delivered.confirmations.length, 0);
});

test("retry during real asynchronous auth preflight requires fresh duplicate-risk confirmation", async () => {
  const h = await harness({ confirmRetry: false });
  await h.ask();
  const host = Object.create(AgentSession.prototype);
  host.agent = { state: { model: { provider: "test-provider", id: "test-model" } } };
  host._extensionRunner = { hasHandlers: () => false };
  host._isAgentRunActive = false;
  let resolveAuth, enteredAuth, configuredAuth = false, runs = 0;
  const authEntered = new Promise(resolve => { enteredAuth = resolve; });
  const auth = new Promise(resolve => { resolveAuth = resolve; });
  host._modelRuntime = { hasConfiguredAuth: () => configuredAuth, checkAuth: () => { enteredAuth(); return auth; }, isUsingOAuth: () => false };
  host._startRun = async trigger => { runs++; await h.message(user(trigger.prompt)); };
  const completions = [], errors = [];
  h.ctx.isIdle = () => host.isIdle;
  h.loaded.runtime.sendUserMessage = (content, options) => {
    h.sent.push({ content, options });
    completions.push(host.sendUserMessage(content, options).catch(error => { errors.push(error); }));
  };
  const opening = h.command(); h.submitCustom("Do not change anything"); await opening;
  await authEntered;
  assert.equal(host.isIdle, true, "Pi does not mark auth preflight as an active run");
  assert.equal(h.ctx.hasPendingMessages(), false);
  await h.command("Q1 retry");
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0].message, /earlier asynchronous send may still arrive.*Resending can duplicate.*another model run/);
  assert.equal(h.sent.length, 1, "declined confirmation cannot start a second preflight");
  assert.equal(runs, 0);
  await h.command("Q1");
  assert.equal(h.confirmations.length, 1, "ordinary reopen neither retries nor confirms");
  resolveAuth(undefined);
  await Promise.all(completions);
  assert.equal(errors.length, 1);
  assert.equal(runs, 0);
  h.ctx.ui.confirm = async (title, message) => { h.confirmations.push({ title, message }); return true; };
  configuredAuth = true;
  await h.command("Q1 retry");
  await Promise.all(completions);
  assert.equal(h.confirmations.length, 2, "failed preflight recovery needs a fresh explicit confirmation");
  assert.equal(h.sent.length, 2);
  assert.equal(runs, 1, "recovery is not blocked forever after a failed preflight");
  await h.command("Q1 retry");
  assert.equal(h.confirmations.length, 2);
  assert.equal(h.sent.length, 2);
});

test("retry confirmation cancellation and changed delivery/session/busy state never authorize a resend", async () => {
  for (const change of ["decline", "busy", "queued", "delivered", "session", "abort"]) {
    const h = await harness();
    await h.ask();
    const opening = h.command(); h.submitCustom("Keep it safe"); await opening;
    let confirm;
    h.ctx.ui.confirm = () => new Promise(resolve => { confirm = resolve; });
    const retrying = h.command("Q1 retry");
    assert.equal(typeof confirm, "function");
    await h.command("Q1 retry");
    assert.match(h.notifications.at(-1).message, /confirmation is already open/);
    if (change === "busy") h.ctx.isIdle = () => false;
    if (change === "queued") h.ctx.hasPendingMessages = () => true;
    if (change === "delivered") h.manager.appendMessage(user(h.sent[0].content));
    if (change === "session") {
      await h.emit("session_shutdown");
      h.ctx.sessionManager = SessionManager.inMemory(scratch);
      await h.emit("session_start");
    }
    if (change === "abort") { h.ctx.signal = AbortSignal.abort(); }
    confirm(change !== "decline");
    await retrying;
    assert.equal(h.sent.length, 1, `no resend after ${change}`);
  }
});

test("real busy host steers the next safe turn, clears pending, and never suggests queued delivery failed", async () => {
  const h = await harness();
  await h.ask({ question: "Approve only the stated scope?" });
  const host = Object.create(AgentSession.prototype);
  const steered = [], followedUp = [], completions = [];
  host.agent = { steer: message => steered.push(message), followUp: message => followedUp.push(message) };
  host._isAgentRunActive = true;
  host._extensionRunner = { hasHandlers: () => false };
  host._steeringMessages = [];
  host._followUpMessages = [];
  host._emitQueueUpdate = () => {};
  host.abort = () => assert.fail("submitting an answer must not abort active tools");
  h.ctx.isIdle = () => host.isIdle;
  h.ctx.hasPendingMessages = () => host._steeringMessages.length + host._followUpMessages.length > 0;
  h.loaded.runtime.sendUserMessage = (content, options) => {
    h.sent.push({ content, options });
    completions.push(host.sendUserMessage(content, options));
  };
  const opening = h.command();
  h.submitCustom("No, keep the current state");
  await opening;
  await Promise.all(completions);
  assert.equal(steered.length, 1, "installed sendUserMessage/prompt routes into the steering queue");
  assert.equal(followedUp.length, 0, "do not defer until the entire run settles");
  assert.equal(host._steeringMessages.length, 1);
  h.submitCustom("Repeated submit must not send again");
  const completed = h.current().component;
  const completedLines = completed.render(100).map(stripVTControlCharacters);
  const submitRow = completedLines.findIndex(line => line.includes("Submit"));
  assert.equal(completed.handleMouse({ type: "click", button: "left", x: completedLines[submitRow].indexOf("Submit"), y: submitRow }), undefined);
  assert.equal(h.sent.length, 1);
  assert.equal(h.latest().status, "answered");
  assert.equal(h.latest().delivered, false, "queuing is not durable delivery confirmation");
  assert.equal(h.widget(), "");
  assert.equal(h.statuses.get(statusKey), undefined);
  assert.equal(h.statuses.get(deliveryStatusKey), undefined, "native steering indicator is sufficient");
  for (let i = 0; i < 3; i++) {
    await h.command("Q1");
    assert.equal(h.notifications.at(-1).type, "info");
    assert.match(h.notifications.at(-1).message, /submitted; waiting for delivery/);
    assert.doesNotMatch(h.notifications.at(-1).message, /retry|failed|unconfirmed/);
  }
  assert.equal(h.sent.length, 1);
  const [beforeDelivery] = await h.emit("before_agent_start");
  assert.equal(beforeDelivery, undefined, "queued answer must not be supplied as model approval");
  host._isAgentRunActive = false; // A still-queued message is not a retry/recovery condition.
  await h.command("Q1");
  assert.equal(h.notifications.at(-1).type, "info");
  assert.equal(h.statuses.get(deliveryStatusKey), undefined);
  host._isAgentRunActive = true;
  host._steeringMessages = [];
  await h.message(steered[0]); // Model boundary consumes steering before the run settles.
  assert.equal(host._isAgentRunActive, true);
  host._isAgentRunActive = false;
  assert.equal(h.latest().delivered, false, "durable message, not a confirmation snapshot, proves delivery");
  assert.equal(h.statuses.get(deliveryStatusKey), undefined);
  const confirmedCount = h.records().length;
  await h.message(steered[0]);
  await h.command("Q1");
  await h.command("Q1 retry");
  assert.equal(h.records().length, confirmedCount, "duplicate message confirmation is idempotent");
  await h.emit("agent_settled");
  assert.equal(h.statuses.get(deliveryStatusKey), undefined);
  assert.equal(h.widget(), "");
  assert.equal(h.sent.length, 1);
});

test("pending list excludes saved answers while idle recovery stays separate and explicit", async () => {
  const h = await harness();
  await h.ask({ question: "First scope?" });
  await h.ask({ question: "Second scope?" });
  const opening = h.command("Q1"); h.submitCustom("Keep it unchanged"); await opening;
  assert.equal((h.widget().match(/Q\d+:/g) ?? []).length, 1);
  assert.doesNotMatch(h.widget(), /saved|retry/);
  const widget = h.widgetComponent();
  const text = plain(widget);
  assert.match(text, /Q2: Second scope/);
  assert.doesNotMatch(text, /Q1|First scope|saved|retry/);
  assert.match(h.statuses.get(deliveryStatusKey), /saved answer.*delivery unconfirmed.*\/q Q1 retry/);
  await h.command("Q1");
  assert.match(h.notifications.at(-1).message, /delivery is unconfirmed.*retry.*duplicate/);
  assert.equal(h.sent.length, 1);
});

test("synchronous send failure remains saved across reload and still requires explicit retry", async () => {
  const h = await harness();
  await h.ask();
  h.loaded.runtime.sendUserMessage = () => { throw new Error("send rejected"); };
  const pending = h.command(); h.submitCustom("No changes"); await pending;
  assert.equal(h.latest().status, "answered");
  assert.equal(h.latest().delivered, false);
  assert.match(h.notifications.at(-1).message, /Q1 retry/);
  const resumed = await harness({ manager: h.manager });
  await resumed.command();
  assert.equal(resumed.sent.length, 0);
  assert.equal(resumed.dialogs.length, 0);
  await resumed.command("Q1 retry");
  assert.equal(resumed.sent.length, 1);
  assert.match(resumed.sent[0].content, /User answer: No changes/);
});

test("tiny expanded pending list scrolls bounded rows and selects the actual clicked question", async () => {
  const h = await harness({ rows: 8 });
  for (let i = 1; i <= 7; i++) await h.ask({ question: `Question ${i}?` });
  const widget = h.widgetComponent();
  assert.equal(widget.render(48).length, 4, "tiny viewport keeps top spacing, two body rows and an overflow hint without trailing padding");
  assert.match(plain(widget, 48), /Q1: Question 1/);
  for (let i = 0; i < 10; i++) {
    widget.handleMouse({ type: "wheel", x: 2, y: 2, wheelDelta: 1 });
    widget.render(48);
  }
  assert.match(plain(widget, 48), /Q6: Question 6/);
  widget.handleMouse({ type: "click", button: "left", x: 2, y: 1 });
  assert.match(plain(h.current().component), /Q6/);
  h.current().component.handleInput("\x1b");
  await h.emit("session_shutdown");
  assert.equal(h.sent.length, 0);
});

test("expanded list word-wraps complete questions and every continuation opens its own ID", async () => {
  const h = await harness({ rows: 40 });
  const questions = [
    "First question has enough ordinary words to wrap naturally across several readable rows?",
    "Second question also wraps across several rows and must never open the first question?",
  ];
  for (const question of questions) await h.ask({ question });
  const widget = h.widgetComponent();
  const painted = widget.render(40);
  if (process.env.QUESTION_LIST_SAMPLE) writeFileSync(process.env.QUESTION_LIST_SAMPLE, painted.join("\n") + "\n");
  const lines = painted.map(stripTerminalSequences);
  assert.equal(lines.slice(1).map(line => line.trim()).filter(Boolean).join(" "),
    questions.map((question, i) => `Q${i + 1}: ${question}`).join(" "), "word wrapping preserves all question text");
  const second = lines.findIndex(line => /Q2:/.test(line));
  assert.ok(second > 2);
  assert.equal(lines[second - 1].trim(), "", "one blank row separates the questions");
  assert.notEqual(lines[second - 2].trim(), "", "no extra inter-question gaps");
  for (let y = 1; y < lines.length; y++) {
    if (!lines[y].trim()) {
      assert.equal(widget.handleMouse({ type: "click", button: "left", x: 39, y }), undefined);
      continue;
    }
    assert.equal(widget.handleMouse({ type: "click", button: "left", x: 39, y }).handled, true);
    assert.match(plain(h.current().component), new RegExp(`Q${y < second ? 1 : 2} ·`));
    h.current().done({ kind: "defer" });
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(h.sent.length, 0);
  assert.ok(h.records().every(record => record.status === "pending"));
});

test("every scrolled continuation row keeps its question ID at the smallest list widths", async () => {
  for (const width of [1, 2, 5, 11, 12]) {
    const h = await harness({ rows: 8 });
    const questions = ["First abc?", "Second xyz?"];
    for (const question of questions) await h.ask({ question });
    const indent = width >= 12 ? "  " : "";
    const expected = [];
    for (const [index, question] of questions.entries()) {
      if (index) expected.push({ text: "" });
      for (const line of wrapTextWithAnsi(`Q${index + 1}: ${question}`, width - indent.length)) {
        expected.push({ text: indent + line, id: index + 1 });
      }
    }
    const widget = h.widgetComponent();
    const visited = new Set();
    for (let offset = 0; offset <= expected.length - 2; offset++) {
      const lines = widget.render(width);
      assert.equal(lines.length, 4, "tiny list reserves two scrollable content rows and a hint");
      assert.equal(lines[0], "", "only one top separator remains");
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      for (let y = 1; y <= 2; y++) {
        const row = expected[offset + y - 1];
        visited.add(offset + y - 1);
        assert.equal(stripTerminalSequences(lines[y]).trim(), row.text.trim());
        const hit = widget.handleMouse({ type: "click", button: "left", x: width - 1, y });
        if (row.id === undefined) {
          assert.equal(lines[y], "", "internal list separation stays unfilled");
          assert.equal(hit, undefined, "separator has no question target");
        } else {
          assert.equal(hit?.handled, true, `width ${width}: continuation row opens its own question`);
          assert.match(plain(h.current().component), new RegExp(`Q${row.id} ·`));
          h.current().done({ kind: "defer" });
          await new Promise(resolve => setImmediate(resolve));
        }
      }
      assert.equal(widget.handleMouse({ type: "click", button: "left", x: width - 1, y: 3 }), undefined, "scroll hint is not an answer target");
      assert.equal(widget.handleMouse({ type: "click", button: "left", x: width - 1, y: 4 }), undefined, "removed trailing gap is out of bounds");
      widget.handleMouse({ type: "wheel", x: 0, y: 1, wheelDelta: 1 });
    }
    assert.equal(visited.size, expected.length, "every wrapped row remains reachable and keeps its own target");
    assert.equal(h.sent.length, 0);
    assert.ok(h.records().every(record => record.status === "pending"));
  }
});

test("a question taller than the viewport scrolls to every word and continuation rows remain clickable", async () => {
  const h = await harness();
  const words = Array.from({ length: 100 }, (_, i) => `word${i}`);
  await h.ask({ question: `${words.join(" ")} END_OF_QUESTION` });
  const widget = h.widgetComponent();
  const seen = new Set();
  let bottom;
  for (let step = 0; step < 120; step++) {
    const lines = widget.render(30);
    assert.equal(lines.length, 16, "large questions use a bounded row viewport");
    const text = lines.map(stripTerminalSequences).join("\n");
    for (const word of text.match(/word\d+/g) ?? []) seen.add(word);
    if (/END_OF_QUESTION/.test(text)) { bottom = text; break; }
    widget.handleMouse({ type: "wheel", x: 3, y: 3, wheelDelta: 1 });
  }
  assert.ok(bottom, "the question's ending is reachable instead of permanently truncated");
  assert.deepEqual([...seen], words);
  assert.doesNotMatch(bottom, /Q1:/, "viewport can begin within a single long question");
  widget.handleMouse({ type: "click", button: "left", x: 29, y: 3 });
  assert.match(plain(h.current().component), /Q1 ·/);
  h.current().done({ kind: "defer" });
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 120; i++) { widget.handleMouse({ type: "wheel", x: 3, y: 3, wheelDelta: -1 }); widget.render(30); }
  assert.match(plain(widget, 30), /Q1: word0/);
  const top = plain(widget, 30);
  widget.handleMouse({ type: "wheel", x: 3, y: 3, wheelDelta: -1 });
  assert.equal(plain(widget, 30), top, "wheel clamps at the first content row");
  assert.equal(h.sent.length, 0);
});

test("expanded list handles narrow graphemes, width/height resize and row-target remapping", async () => {
  const h = await harness();
  for (let i = 1; i <= 20; i++) await h.ask({ question: `Question ${i} has 界 emoji 👩‍💻 and aLongUnbrokenWordThatMustWrap without losing its ending.` });
  const terminal = { rows: 24 };
  const widget = h.widgetComponent(terminal);
  for (const width of [1, 2, 5, 11, 12, 20, 48]) {
    for (const rows of [8, 12, 24, 50]) {
      terminal.rows = rows;
      const lines = widget.render(width);
      assert.ok(lines.length <= Math.max(4, Math.min(16, rows - 5)));
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `width ${width}, height ${rows}`);
        assert.doesNotMatch(stripTerminalSequences(line), /[\r\n\x1b]/);
      }
      widget.handleMouse({ type: "wheel", x: 0, y: 2, wheelDelta: 1 });
    }
  }
  terminal.rows = 24;
  for (let i = 0; i < 250; i++) { widget.render(20); widget.handleMouse({ type: "wheel", x: 0, y: 3, wheelDelta: 1 }); }
  const wide = widget.render(200).map(stripTerminalSequences);
  const y = wide.findIndex(line => /Q\d+:/.test(line));
  assert.ok(y >= 1, "widening after deep scrolling clamps the offset to nonempty content");
  const id = Number(/Q(\d+):/.exec(wide[y])[1]);
  assert.equal(widget.handleMouse({ type: "click", button: "left", x: 199, y }).handled, true);
  assert.match(plain(h.current().component), new RegExp(`Q${id} ·`));
  h.current().done({ kind: "defer" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(widget.render(0), []);
  assert.equal(widget.handleMouse({ type: "click", button: "left", x: 0, y: 3 }), undefined, "zero width leaves no stale hit targets");
});

test("explicit retry refuses known queued/busy work and reconciles a persisted answer first", async () => {
  const h = await harness();
  await h.ask();
  const answering = h.command("Q1"); h.submitCustom("Only development"); await answering;
  h.ctx.hasPendingMessages = () => true;
  await h.command("Q1 retry");
  assert.equal(h.sent.length, 1);
  h.ctx.hasPendingMessages = () => false;
  h.ctx.isIdle = () => false;
  await h.command("Q1 retry");
  assert.equal(h.sent.length, 1);
  assert.match(h.notifications.at(-1).message, /busy or has queued/);
  h.ctx.isIdle = () => true;
  // Persistence can happen without our message_end callback (e.g. another hook or missed event).
  h.manager.appendMessage(user(h.sent[0].content));
  await h.command("Q1 retry");
  assert.equal(h.sent.length, 1);
  assert.equal(h.widget(), "");
});

test("list is always expanded and headerless across refresh; only entries open overlays", async () => {
  const h = await harness();
  const question = "Approve this exact scope?\nDevelopment only\r\nDo not touch production";
  await h.ask({ question });
  const widget = h.widgetComponent();
  assert.doesNotMatch(plain(widget), /Questions ·|\d+ pending/);
  assert.match(plain(widget), /exact scope\? Development only Do not touch production/);
  assert.equal(h.latest().question, question.replace(/\r\n/g, "\n"));
  assert.equal(widget.handleMouse({ type: "click", button: "left", x: 3, y: 0 }), undefined, "top separation is inert");
  for (const width of [1, 15, 100]) {
    const lines = widget.render(width);
    assert.ok(lines.length >= 2);
    assert.equal(lines[0], "");
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  await h.emit("agent_settled");
  await h.ask({ question: "Another?" });
  await h.message(assistant("Q3: One prose question?"));
  await h.emit("session_tree");
  for (const id of [1, 2, 3]) assert.match(h.widget(), new RegExp(`Q${id}:`));
  assert.match(h.widget(), /One prose question/);
  assert.doesNotMatch(h.widget(), /▾|▸|\/q/);
  assert.equal(h.dialogs.length, 0);
  const refreshed = h.widgetComponent(); refreshed.render(100);
  assert.equal(refreshed.handleMouse({ type: "click", button: "left", x: 3, y: 1 }).handled, true);
  assert.equal(h.current().customOptions.overlay, true);
  h.current().component.handleInput("\x1b");
  await new Promise(resolve => setImmediate(resolve));
  await h.ask({ question: "Fourth question?" });
  for (const id of [1, 2, 3, 4]) assert.match(h.widget(), new RegExp(`Q${id}:`));
  assert.equal(h.dialogs.length, 1, "new questions never open automatically");
});

test("Questions widget has unfilled padding, one inter-question gap and no residual empty padding", async () => {
  const h = await harness();
  assert.equal(h.widgets.has(statusKey), false);
  for (const question of ["First?", "Second?"]) await h.ask({ question });
  const widget = h.widgetComponent();
  const lines = widget.render(80);
  assert.equal(lines.length, 4, "one top spacer and separated entries; no heading or trailing blank rows");
  assert.doesNotMatch(lines.map(stripTerminalSequences).join("\n"), /Questions ·|\d+ pending/);
  for (const y of [0, 2]) {
    assert.equal(lines[y], "", "padding and separator have no background fill");
    assert.equal(widget.handleMouse({ type: "click", button: "left", x: 3, y }), undefined, "padding and separator are not click targets");
  }
  assert.match(stripTerminalSequences(lines[1]), /Q1: First/);
  assert.match(stripTerminalSequences(lines[3]), /Q2: Second/);
  const background = line => line.match(/\x1b\[48;[^m]+m/)?.[0];
  assert.ok(background(lines[1]), "question row has an explicit background");
  assert.equal(background(lines[3]), background(lines[1]), "question rows share the same amber fill");
  assert.notEqual(stripTerminalSequences(lines.at(-1)).trim(), "");
  for (const [x, y] of [[3, 4], [3, 5], [80, 3], [-1, 3], [3, -1]]) {
    assert.equal(widget.handleMouse({ type: "click", button: "left", x, y }), undefined, "removed padding and out-of-bounds positions are inert");
  }
  widget.handleMouse({ type: "click", button: "left", x: 79, y: 3 });
  assert.match(plain(h.current().component), /Q2/);
  h.current().done({ kind: "dismiss" });
  await Promise.resolve(); await Promise.resolve();
  const first = h.command("Q1"); h.current().done({ kind: "dismiss" }); await first;
  assert.equal(h.widget(), "");
  assert.equal(h.widgets.has(statusKey), false, "empty widget leaves neither bar nor spacing");
});

test("installed viewport keeps Questions outer spacing and ordinary input intact; visible entry is a mouse target", async () => {
  for (const rows of [8, 12, 24]) {
    const h = await harness({ rows });
    assert.equal(h.widget(), "", "no pending questions consume no rows");
    await h.ask({ question: "Proceed with this carefully scoped development change, keeping all production resources untouched?" });
    for (let id = 2; id <= 20; id++) await h.ask({ question: `Question ${id}: this long pending question must wrap without consuming the editor or growing the widget to fullscreen.` });
    const widget = h.widgetComponent();
    const editor = new Input();
    editor.setValue("Unsent ordinary draft");
    editor.focused = true;
    const widgets = new Container(); widgets.addChild(widget);
    const viewport = createChatViewport({ document: new Text("Transcript\n".repeat(20), 0, 0),
      pendingMessages: new Container(), status: new Container(), widgetsAbove: widgets,
      editor, footer: new Text("One row footer", 0, 0), scrollbar: "hidden" });
    const frame = () => renderLayoutFrame(viewport.root, 48, rows, () => {});
    const click = pattern => {
      const current = frame();
      const y = current.lines.map(stripVTControlCharacters).findIndex(line => pattern.test(line));
      assert.ok(y >= 0, `visible target: ${pattern}`);
      const box = getLayoutBoxesAt(current, 3, y).find(box => box.component === widgets);
      assert.ok(box, "installed layout exposes widget container as hit target");
      const result = box.component.handleMouse({ type: "click", button: "left", x: 3 - box.rect.x, y: y - box.rect.y,
        screenX: 3, screenY: y, width: box.rect.width, height: box.rect.height });
      assert.equal(result?.target.component, widget, "container routes clicks to the actual list");
      return result;
    };
    assert.match(plain(widget, 48), /Q1: Proceed/);
    assert.doesNotMatch(plain(widget, 48), /Questions ·|\d+ pending/);
    assert.match(frame().lines.map(stripTerminalSequences).join("\n"), /Unsent ordinary draft/);
    assert.equal(h.dialogs.length, 0);
    const beforePaddingClick = widget.render(48);
    assert.equal(beforePaddingClick[0], "");
    assert.equal(widget.handleMouse({ type: "click", button: "left", x: 3, y: 0 }), undefined);
    assert.deepEqual(widget.render(48), beforePaddingClick, "top spacing is not a collapse control");
    assert.equal(h.dialogs.length, 0);
    assert.ok(widget.render(48).length <= Math.max(4, Math.min(16, rows - 5)), "twenty wrapped questions stay within the list budget");
    assert.match(frame().lines.map(stripTerminalSequences).join("\n"), /Unsent ordinary draft/);
    assert.match(frame().lines.map(stripTerminalSequences).join("\n"), /One row footer/);
    assert.equal(click(/Q1: Proceed/).handled, true);
    assert.equal(h.dialogs.length, 1);
    assert.equal(h.current().customOptions.overlay, true);
    assert.equal(editor.getValue(), "Unsent ordinary draft");
    assert.equal(editor.focused, true, "list clicks do not take editor focus");
    h.current().component.handleInput("\x1b");
    await h.emit("session_shutdown");
  }
});

test("unknown/mixed batch history is not a gate and cannot open UI or infer an approval", async () => {
  const h = await harness();
  const msg = assistant("");
  msg.content = [{ type: "toolCall", id: "unknown-question", name: "ask_user", arguments: { question: "Approve?" } },
    { type: "toolCall", id: "unknown-action", name: "bash", arguments: { command: "action" } }];
  h.manager.appendMessage(msg);
  const result = await h.ask({ question: "Approve?" });
  assert.equal(result.details.status, "pending");
  assert.equal(result.terminate, true, "Pi still requires all siblings to agree to termination");
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.latest().status, "pending");
  assert.equal(h.latest().answer, undefined);
});

test("stale list callbacks after branch change cannot open a question in the replacement session", async () => {
  const h = await harness();
  await h.ask();
  const stale = h.widgetComponent(); stale.render(80);
  stale.handleMouse({ type: "click", button: "left", x: 2, y: 0 }); stale.render(80);
  h.ctx.sessionManager = SessionManager.inMemory(scratch);
  await h.emit("session_start");
  stale.handleMouse({ type: "click", button: "left", x: 2, y: 1 });
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.widget(), "");
});

test("/questions while a manual dialog is open never calls waitForIdle or replaces its UI", async () => {
  const h = await harness();
  await h.ask();
  const pending = h.command();
  await h.command();
  assert.equal(h.dialogs.length, 1);
  assert.match(h.notifications.at(-1).message, /already open/);
  h.current().component.handleInput("\x1b");
  await pending;
});

test("sequential labels span calls/prose/explicit answers, and answered IDs cannot be reassigned", async () => {
  const h = await harness({ mode: "print", hasUI: false });
  await h.message(assistant("Q5: Which target?"));
  await h.input("Q5: UAT");
  assert.equal(h.latest().status, "answered");
  const next = await h.ask({ question: "Next question?" });
  assert.equal(next.details.question.id, 6);
  const rejected = await h.ask({ question: "Which target?", question_id: 5 });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /cannot be reassigned/);
  await h.input("Q10: explicit answer to an untracked old question");
  assert.equal((await h.ask()).details.question.id, 11);
});

test("every accepted untracked answer-label spelling reserves its ID after reload", async () => {
  for (const [text, nextId] of [["Q1:no", 2], ["Q7:yes", 8], ["Q1:no\nQ17: yes", 18], [" Q9:\tyes ", 10]]) {
    const h = await harness({ mode: "print", hasUI: false });
    await h.input(text);
    assert.equal(h.records().length, 0, "untracked answer does not fabricate a question record");
    await h.emit("session_shutdown");
    const resumed = await harness({ manager: h.manager, mode: "print", hasUI: false });
    assert.equal((await resumed.ask({ question: "Unrelated next question?" })).details.question.id, nextId);
  }
});

test("unchanged ask_user re-ask preserves an open dialog's Submit and Dismiss actions", async () => {
  for (const action of ["submit", "dismiss"]) {
    const h = await harness();
    await h.ask({ question: "Proceed with this scope?" });
    const opening = h.command("Q1");
    h.current().component.handleInput("Staged user text");
    const before = h.records().length;
    const repeated = await h.ask({ question: "Proceed with this scope?", question_id: 1 });
    assert.equal(repeated.details.status, "unavailable");
    assert.match(repeated.content[0].text, /already open.*preserved/);
    assert.equal(h.records().length, before, "re-ask cannot replace the active record");
    assert.equal(h.dialogs.length, 1);
    if (action === "submit") { h.current().component.handleInput("\r"); h.current().component.handleInput("\r"); }
    else h.current().done({ kind: "dismiss" });
    await opening;
    assert.equal(h.latest().status, action === "submit" ? "answered" : "dismissed");
    assert.equal(h.sent.length, action === "submit" ? 1 : 0);
    if (action === "submit") assert.equal(h.latest().answer.text, "Staged user text");
    else assert.equal(h.latest().answer, undefined);
    assert.equal(h.widget(), "");
  }
});

test("unchanged unanswered question ID can reopen; changed scope/options are rejected", async () => {
  const h = await harness({ mode: "print", hasUI: false });
  const first = await h.ask();
  const second = await h.ask({ question: "Proceed?", question_id: 1 });
  assert.equal(second.details.question.id, first.details.question.id);
  assert.equal((await h.ask({ question: "Delete everything?", question_id: 1 })).isError, true);
  assert.equal((await h.ask({ question: "Proceed?", question_id: 1, options: [{ label: "yes" }] })).isError, true);
  assert.equal((await h.ask({ question: "Next?" })).details.question.id, 2);
});

test("restart restores deferred questions and resumes sequence without automatically showing/answering", async () => {
  const first = await harness();
  await first.ask();
  await first.emit("session_shutdown");
  const resumed = await harness({ manager: first.manager });
  assert.equal((resumed.widget().match(/Q\d+:/g) ?? []).length, 1);
  assert.equal(resumed.dialogs.length, 0);
  const next = await resumed.ask({ question: "Next?" });
  assert.equal(next.details.question.id, 2);
  assert.equal(resumed.dialogs.length, 0);
  assert.equal(resumed.widget().split("\n").length, 4, "restored questions start expanded without a header or opening a dialog");
});

test("tree restoration keeps only branch pending questions but high-water includes abandoned Q5/prose", async () => {
  const h = await harness({ mode: "print", hasUI: false });
  const rootId = h.manager.appendMessage(user("branch root"));
  await h.message(assistant("Q5: Abandoned branch question?"));
  await h.ask({ question: "Also abandoned?" }); // Q6 custom record.
  h.manager.branch(rootId);
  await h.emit("session_tree");
  const [reminder] = await h.emit("before_agent_start");
  assert.equal(reminder, undefined, "abandoned pending questions must not be resurrected");
  const next = await h.ask({ question: "Current branch question?" });
  assert.equal(next.details.question.id, 7);
  assert.equal(h.records().length, 1);
});

test("a dismissal on another branch cannot discard this branch's explicit saved answer", async () => {
  const h = await harness();
  await h.ask();
  const root = h.manager.appendMessage(user("Branch root"));
  const answering = h.command(); h.submitCustom("No changes"); await answering;
  const answeredLeaf = h.manager.getLeafId();
  h.manager.branch(root);
  await h.emit("session_tree");
  const dismissing = h.command();
  h.current().done({ kind: "dismiss" });
  await dismissing;
  assert.equal(h.latest().status, "dismissed");
  h.manager.branch(answeredLeaf);
  await h.emit("session_tree");
  assert.equal(h.widget(), "");
  assert.match(h.statuses.get(deliveryStatusKey), /saved answer/);
  await h.command("Q1 retry");
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].content, /No changes/);
});

test("restore confirms legacy recorded tool answers rather than treating delivery=false as pending", async () => {
  const h = await harness();
  const result = await legacyToolAnswer(h, "yes");
  h.manager.appendMessage({ role: "toolResult", toolName: "ask_user", ...result, timestamp: Date.now() });
  h.manager.appendCustomEntry(entryType, result.details.question);
  const restored = await harness({ manager: h.manager });
  assert.equal(restored.widget(), "");
  await restored.command("Q1");
  assert.equal(restored.sent.length, 0);
});

test("legacy tool-answer delivered=true snapshots still require an actual durable tool result", async () => {
  const h = await harness();
  const result = await legacyToolAnswer(h, "Only the original scope");
  h.manager.appendCustomEntry(entryType, { ...result.details.question, delivered: true });
  const restored = await harness({ manager: h.manager, confirmRetry: false });
  assert.match(restored.statuses.get(deliveryStatusKey), /delivery unconfirmed/);
  assert.equal(restored.sent.length, 0);
  await restored.command("Q1 retry");
  assert.equal(restored.confirmations.length, 1);
  assert.equal(restored.sent.length, 0);
  await restored.toolMessage(result);
  const delivered = await harness({ manager: restored.manager });
  assert.equal(delivered.statuses.get(deliveryStatusKey), undefined);
  await delivered.command("Q1 retry");
  assert.equal(delivered.confirmations.length, 0);
  assert.equal(delivered.sent.length, 0);
});

test("unrelated settlements never append redundant confirmed question snapshots", async () => {
  const h = await harness();
  const result = await legacyToolAnswer(h, "yes, development only");
  await h.toolMessage(result);
  const count = h.records().length;
  for (let i = 0; i < 4; i++) {
    await h.message(assistant(`Unrelated response ${i}.`));
    await h.emit("agent_settled");
  }
  assert.equal(h.records().length, count);
  const secondResult = await legacyToolAnswer(h, "no", "Another?");
  h.manager.appendMessage({ role: "toolResult", toolName: "ask_user", ...secondResult, timestamp: Date.now() });
  const beforeReconcile = h.records().length;
  await h.emit("agent_settled");
  assert.equal(h.records().length, beforeReconcile);
  assert.equal(h.widget(), "");
  const restored = await harness({ manager: h.manager });
  assert.equal(restored.widget(), "");
});

test("crash before result delivery preserves saved answer; only explicit retry recovers as user continuation", async () => {
  const h = await harness();
  await legacyToolAnswer(h, "yes, only for development");
  const resumed = await harness({ manager: h.manager });
  assert.equal(resumed.widget(), "");
  assert.match(resumed.statuses.get(deliveryStatusKey), /saved answer.*delivery unconfirmed/);
  assert.equal(resumed.sent.length, 0, "never replay approvals automatically at startup");
  await resumed.command("Q1");
  assert.equal(resumed.dialogs.length, 0);
  assert.equal(resumed.sent.length, 0, "plain reopen is not permission to resend");
  await resumed.command("Q1 retry");
  assert.match(resumed.sent[0].content, /yes, only for development/);
  await resumed.message(user(resumed.sent[0].content));
  const again = await harness({ manager: h.manager });
  assert.equal(again.widget(), "");
  await again.command("Q1 retry");
  assert.equal(again.sent.length, 0);
});

test("cleared/failed queued answer remains discoverable and is retryable only explicitly", async () => {
  const h = await harness();
  await h.ask();
  const command = h.command(); h.submitCustom("not now"); await command;
  await h.emit("agent_settled"); // no actual user message and no pending queue.
  assert.equal(h.widget(), "");
  assert.match(h.statuses.get(deliveryStatusKey), /saved answer.*delivery unconfirmed/);
  assert.equal(h.sent.length, 1);
  await h.command();
  assert.equal(h.sent.length, 1, "settlement without a queued message does not prove the send failed");
  await h.command("Q1 retry");
  assert.equal(h.sent.length, 2);
});

test("abort closes the manual UI callback without recording a selected answer", async () => {
  const h = await harness();
  await h.ask({ question: "Approve?", options: [{ label: "Yes" }] });
  const controller = new AbortController();
  h.ctx.signal = controller.signal;
  const pending = h.command();
  h.current().component.handleInput(" ");
  controller.abort();
  await pending;
  assert.equal(h.current().closes, 1);
  assert.equal(h.latest().status, "pending");
  assert.equal(h.sent.length, 0);
  assert.equal((h.widget().match(/Q\d+:/g) ?? []).length, 1);
});

test("shutdown/reload closes manually opened UI; late callback cannot write into the next session", async () => {
  const h = await harness();
  await h.ask();
  const pending = h.command();
  const old = h.current();
  await h.emit("session_shutdown");
  const replacement = SessionManager.inMemory(scratch);
  h.ctx.sessionManager = replacement;
  await h.emit("session_start");
  old.component.handleInput("yes"); old.component.handleInput("\r"); old.component.handleInput("\r");
  await pending;
  assert.equal(replacement.getBranch().length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(old.closes, 1);
  assert.equal(h.widget(), "");
});

test("already-aborted, print/json/RPC, no UI and busy calls cannot hang or invent answers", async () => {
  for (const overrides of [{ mode: "print", hasUI: false }, { mode: "json", hasUI: false }, { mode: "rpc", hasUI: true }, { hasUI: false }]) {
    const h = await harness(overrides);
    const result = await h.ask();
    assert.equal(h.dialogs.length, 0);
    assert.equal(result.details.status, "unavailable");
    assert.equal(result.details.question.status, "pending");
    assert.equal(result.terminate, true);
    assert.match(result.content[0].text, /no answer or approval was given/i);
  }
  const h = await harness();
  const controller = new AbortController(); controller.abort();
  assert.equal((await h.ask(undefined, controller.signal)).details.status, "unavailable");
  await h.ask({ question: "Active?" });
  const active = h.command("Q2");
  assert.equal((await h.ask({ question: "Concurrent?" })).details.status, "unavailable");
  h.current().component.handleInput("\x1b"); await active;
});

test("mixed batches are explicitly deferred and never represented as an authorization fence", async () => {
  const h = await harness();
  const msg = assistant("");
  msg.content = [{ type: "toolCall", id: "call-1", name: "ask_user", arguments: { question: "Approve?" } }, { type: "toolCall", id: "danger", name: "bash", arguments: { command: "action" } }];
  h.manager.appendMessage(msg);
  const result = await h.ask({ question: "Approve?" });
  assert.equal(h.dialogs.length, 0);
  assert.equal(result.details.status, "unavailable");
  assert.equal(result.details.question.status, "pending");
  assert.equal(result.terminate, true);
  assert.match(result.content[0].text, /does not block sibling tools/);
  // Pi, not this extension, controls sibling execution and all-results-agree termination.
});

test("fallback captures labeled assistant prose, skips fences/quotes/examples/thinking/tool output", async () => {
  const h = await harness();
  await h.message(assistant("Q3: Real clarification?\n\n```text\nQ90: Code example?\n```\n> Q91: Quoted?\n    Q92: Indented code?\nExample:\nQ93: Example question?\n\n**Q4:** Real second question?"));
  const thought = assistant(""); thought.content = [{ type: "thinking", thinking: "Q100: Hidden thought?" }];
  await h.message(thought);
  await h.message({ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "Q101: Tool output?" }], timestamp: Date.now() });
  assert.deepEqual(h.records().map(record => record.id), [3, 4]);
  assert.equal((h.widget().match(/Q\d+:/g) ?? []).length, 2);
  assert.equal(h.widget().split("\n").length, 4);
  assert.deepEqual(h.latest().options, []);
  assert.equal(h.latest().recommended, undefined);
  const result = await h.ask({ question: "Next?" });
  assert.equal(result.details.question.id, 5);
  assert.equal(h.dialogs.length, 0);
});

test("long code fences cannot be closed by a shorter embedded fence", async () => {
  const h = await harness({ mode: "print", hasUI: false });
  await h.message(assistant("````markdown\n```\nQ99: Still an example?\n```\n````\nQ2: Actual question?"));
  assert.deepEqual(h.records().map(record => record.id), [2]);
  assert.equal((await h.ask()).details.question.id, 3);
});

test("corrupt question snapshots are ignored rather than hiding or falsely answering questions", async () => {
  const h = await harness({ mode: "print", hasUI: false });
  await h.ask();
  for (const patch of [{ id: 99, delivered: "yes" }, { id: 99, rationale: {} }, { id: 99, status: "answered", answer: { text: "yes", optionIndex: 4 }, delivery: "tool" }]) {
    h.manager.appendCustomEntry(entryType, { ...h.records()[0], ...patch });
  }
  await h.emit("session_tree");
  const next = await h.ask({ question: "Next?" });
  assert.equal(next.details.question.id, 2);
  const [reminder] = await h.emit("before_agent_start");
  assert.match(reminder.message.content, /Q1: Proceed/);
  assert.doesNotMatch(reminder.message.content, /Q99:/);
});

test("fallback repeated IDs do not overwrite original scope or an answered question", async () => {
  const h = await harness();
  await h.message(assistant("Q3: Original?"));
  await h.message(assistant("Q3: Changed?"));
  assert.equal(h.latest().question, "Original?");
  await h.input("Q3: no");
  await h.message(assistant("Q3: Changed again?"));
  assert.equal(h.latest().status, "answered");
  assert.equal(h.latest().answer.text, "no");
});

test("prose answer hook is match-only; generated, unrelated, extra instructions and images are never consumed", async () => {
  const h = await harness();
  await h.message(assistant("Q1: Approve?"));
  for (const [text, extra] of [["yes", {}], ["Q1: yes", { source: "extension" }], ["Q1: yes\nalso change another file", {}], ["Q1: yes", { images: [{ type: "image" }] }]]) {
    assert.deepEqual(await h.input(text, extra), [undefined]);
    assert.equal(h.latest().status, "pending");
  }
  assert.deepEqual(await h.input("Q1: no, keep current state"), [undefined]);
  assert.equal(h.latest().status, "answered");
  assert.equal(h.latest().delivered, false, "input hook saves before actual message delivery");
  assert.equal(h.statuses.get(deliveryStatusKey), undefined);
  assert.equal(h.latest().answer.text, "no, keep current state");
  assert.equal(h.sent.length, 0, "original user message delivers the answer; do not duplicate it");
});

test("native tool renderers remain readable at all expansion states and widths with hostile controls", async () => {
  const h = await harness({ mode: "print", hasUI: false });
  const args = { question: "Choose 雪e\u0301?\x1b[2J\x1b]0;bad-title\x07", options: [{ label: "Keep", description: "Safe option" }], recommended_option: 1, rationale: "Preserves current data" };
  const result = await h.ask(args);
  const component = new ToolExecutionComponent("ask_user", "call-1", args, { showImages: false, outputPad: 1 }, h.tool, { requestRender() {} }, scratch);
  component.updateResult(result);
  for (const appearance of ["light", "dark"]) {
    themes.initTheme(appearance, false);
    for (const expanded of [false, true]) {
      component.setExpanded(expanded);
      for (const width of [1, 8, 32, 80, 120]) {
        const lines = component.render(width);
        assert.ok(lines.every(line => visibleWidth(line) <= width), JSON.stringify({ width, expanded, lines: lines.map(line => [visibleWidth(line), stripVTControlCharacters(line)]) }));
        assert.ok(lines.every(line => !line.includes("\x1b[2J") && !line.includes("\x1b]0;")));
      }
      const text = plain(component, 100);
      assert.equal((text.match(/Q1: Choose/g) ?? []).length, 1);
      assert.equal((text.match(/1\. Keep/g) ?? []).length, 1);
      assert.match(text, /Recommended/);
      assert.match(text, /Safe option/);
      assert.match(text, /Preserves current data/);
      assert.match(text, /Q1/);
      assert.doesNotMatch(text, /Pending|click to answer/);
      assert.doesNotMatch(text, /\/q/);
    }
  }
  themes.initTheme("dark", false);
});

test("transcript separates the question, each choice, rationale and recorded answer with blank rows", async () => {
  const h = await harness();
  const args = { question: "Choose the next step for this deliberately long question that wraps?", options: [
    { label: "Keep local", description: "Preserve the current workspace without remote changes." },
    { label: "Pause", description: "Leave everything unchanged until the next check." },
  ], recommended_option: 1, rationale: "This preserves the current workspace." };
  const result = await h.ask(args);
  const snapshot = JSON.stringify(result);
  const native = new ToolExecutionComponent("ask_user", "call-1", args, { showImages: false }, h.tool, { requestRender() {} }, scratch);
  native.updateResult(result);
  const check = (width, answered = false) => {
    const lines = native.render(width).map(stripTerminalSequences);
    const groups = [/1\. Keep local/, /2\. Pause/, /Recommendation rationale:/, ...(answered ? [/Answer:/] : [])];
    for (const pattern of groups) {
      const row = lines.findIndex(line => pattern.test(line));
      assert.ok(row > 0, `missing group ${pattern}`);
      assert.equal(lines[row - 1].trim(), "", `${pattern} starts after a blank row, not the previous text block`);
      assert.equal(lines.filter(line => pattern.test(line)).length, 1);
    }
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  };
  for (const width of [48, 120]) check(width);
  await h.input("Q1: Keep local for now");
  for (const width of [48, 120]) check(width, true);
  assert.equal(JSON.stringify(result), snapshot, "spacing is presentation-only");
  assert.equal(h.sent.length, 0);
});

test("question transcript uses amber buffers and darker amber separators without expanded duplicates", async () => {
  const h = await harness({ mode: "print", hasUI: false });
  const args = { question: "Choose 界?\n\nKeep this internal gap.", options: [{ label: "Keep", description: "Local only" }] };
  const result = await h.ask(args);
  for (const appearance of ["dark", "light"]) for (const mode of ["truecolor", "256color"]) {
    const theme = themes.loadThemeFromPath(join(root, `dist/modes/interactive/theme/${appearance}.json`), mode);
    const fg = mode === "truecolor" ? (appearance === "dark" ? "38;2;255;240;191" : "38;2;95;0;0") : (appearance === "dark" ? "38;5;229" : "38;5;52");
    const bg = backgroundAnsi(parseColor(appearance === "dark" ? "#594515" : "#fff0bf"), mode).slice(2, -1);
    for (const width of [1, 2, 5, 12, 80]) {
      const render = expanded => h.tool.renderResult(result, { expanded }, theme).render(width);
      const lines = render(false);
      assert.deepEqual(render(true), lines, "expansion adds neither buffers nor repeated unavailable/provenance caveats");
      const buffer = `\x1b[${fg}m\x1b[${bg}m${" ".repeat(width)}\x1b[0m`;
      assert.equal(lines[0], buffer, `${appearance}/${mode}/${width}: exact top fill`);
      assert.notEqual(stripTerminalSequences(lines[1]).trim(), "", "pending question starts directly after its top buffer");
      assert.ok(lines[1].includes(`\x1b[${fg}m`), "actual question uses the dedicated readable question foreground");
      assert.doesNotMatch(lines.map(stripTerminalSequences).join("\n"), /Pending|click to answer/);
      if (width === 80) assert.match(stripTerminalSequences(lines[1]), /Q1: Choose/);
      assert.equal(lines.at(-1), buffer, `${appearance}/${mode}/${width}: exact bottom fill`);
      if (mode === "truecolor") assert.equal(lines.filter(line => line === buffer).length, 2);
      const separatorBg = backgroundAnsi(parseColor(appearance === "dark" ? "#3d351b" : "#e6d58c"), mode);
      const separators = lines.slice(1, -1).filter(line => !stripTerminalSequences(line).trim());
      assert.ok(separators.length >= 2, "internal question gap and choice separation remain present");
      assert.ok(separators.every(line => line.includes(separatorBg) && visibleWidth(line) === width), "blank card rows have full-width amber fill, never terminal-gray gaps");
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      const call = h.tool.renderCall(args, theme, { toolCallId: "call-1" }).render(width);
      assert.equal(call[0], buffer, "native call header gets exactly one full-width top buffer");
      assert.notEqual(stripTerminalSequences(call[1]).trim(), "", "title begins immediately after its top buffer");
      assert.ok(call[1].includes(`\x1b[${fg}m`), "title matches the actual question foreground");
      assert.notEqual(stripTerminalSequences(call.at(-1)).trim(), "", "title has no extra bottom buffer");
      if (width === 80) {
        assert.equal(call.filter(line => line === buffer).length, 1, "exactly one title buffer when spaces do not wrap onto their own rows");
        assert.match(stripTerminalSequences(call[1]), /Ask user · Q1/);
      }
    }
  }
  const native = new ToolExecutionComponent("ask_user", "call-1", args, { showImages: false }, h.tool, { requestRender() {} }, scratch);
  native.updateResult(result);
  for (const expanded of [false, true]) {
    native.setExpanded(expanded);
    const lines = native.render(80);
    const tintedBlanks = rows => rows.filter(line => !stripTerminalSequences(line).trim() && /\x1b\[48;/.test(line)).length;
    const resultRows = h.tool.renderResult(result, { expanded }, themes.theme).render(80);
    assert.equal(tintedBlanks(lines), tintedBlanks(resultRows) + 1, "native shell retains exactly the one new title top buffer");
    assert.doesNotMatch(lines.map(stripTerminalSequences).join("\n"), /No answer or approval|receipt|Interactive question UI unavailable/);
  }
});

test("question transcript plain modes retain buffer geometry without painting internal or widget gaps", async () => {
  const h = await harness();
  const result = await h.ask({ question: "Proceed?\n\nPreserve the internal blank." });
  const original = { noColor: process.env.NO_COLOR, term: process.env.TERM };
  try {
    for (const mode of ["NO_COLOR", "TERM"]) {
      if (mode === "NO_COLOR") process.env.NO_COLOR = "1";
      else { delete process.env.NO_COLOR; process.env.TERM = "dumb"; }
      for (const width of [1, 2, 5, 80]) {
        const lines = h.tool.renderResult(result, { expanded: false }, themes.theme).render(width);
        assert.equal(lines[0], " ".repeat(width));
        assert.equal(lines.at(-1), " ".repeat(width));
        assert.ok(lines.slice(1, -1).filter(line => !line.trim()).every(line => line === ""));
        assert.doesNotMatch(lines.join("\n"), /\x1b\[[0-9;]*m/);
        assert.ok(lines.every(line => visibleWidth(line) <= width));
        const call = h.tool.renderCall({ question: result.details.question.question }, themes.theme, { toolCallId: "call-1" }).render(width);
        assert.equal(call[0], " ".repeat(width), "plain title retains its full-width top buffer");
        assert.notEqual(call[1].trim(), "", "plain title starts directly after its top buffer");
        assert.notEqual(call.at(-1).trim(), "", "plain title has no bottom buffer");
        assert.doesNotMatch(call.join("\n"), /\x1b\[[0-9;]*m/);
        const widget = h.widgetComponent().render(width);
        assert.equal(widget[0], "");
        assert.doesNotMatch(widget.join("\n"), /\x1b\[[0-9;]*m/);
        assert.notEqual(widget.at(-1).trim(), "", "no added trailing widget spacing in plain mode");
      }
    }
  } finally {
    if (original.noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = original.noColor;
    if (original.term === undefined) delete process.env.TERM; else process.env.TERM = original.term;
  }
  assert.equal(h.dialogs.length, 0);
});

test("native transcript keeps one question/choice copy and live Answered/Dismissed status without rewriting history", async () => {
  const h = await harness({ rows: 50 });
  const args = { question: "Choose a target?", options: [{ label: "Local", description: "No remote changes" }, { label: "Remote" }], recommended_option: 1 };
  const first = await h.ask(args);
  await h.toolMessage(first);
  const immutable = JSON.stringify(first);
  let requested = 0;
  const component = new ToolExecutionComponent("ask_user", "call-1", args, { showImages: false }, h.tool,
    { requestRender() { requested++; } }, scratch);
  component.updateResult(first);
  const document = new Container(); document.addChild(component);
  const viewport = createChatViewport({ document, pendingMessages: new Container(), status: new Container(),
    widgetsAbove: new Container(), editor: new Input(), footer: new Text("Footer", 0, 0), scrollbar: "hidden" });
  const frame = () => renderLayoutFrame(viewport.root, 100, 50, () => {}).lines.map(stripTerminalSequences).join("\n");
  const check = text => {
    assert.equal((text.match(/Q1: Choose a target\?/g) ?? []).length, 1);
    assert.equal((text.match(/1\. Local/g) ?? []).length, 1);
    assert.equal((text.match(/2\. Remote/g) ?? []).length, 1);
    assert.match(text, /No remote changes/);
  };
  check(frame());
  assert.doesNotMatch(frame(), /Q1 · Pending|click to answer/);
  const painted = component.render(100);
  const header = painted.find(line => stripTerminalSequences(line).includes("Ask user"));
  const body = painted.find(line => stripTerminalSequences(line).includes("Q1: Choose"));
  assert.match(body, /\x1b\[48;/, "question body has a full-width colored panel");
  assert.equal(body.match(/\x1b\[48;[^m]+m/)?.[0], header.match(/\x1b\[48;[^m]+m/)?.[0], "transcript body shares the header background");
  assert.equal(visibleWidth(body), 100);
  const resultRows = h.tool.renderResult(first, { expanded: false }, themes.theme).render(100);
  const background = line => line.match(/\x1b\[48;[^m]+m/)?.[0];
  assert.equal(background(resultRows[0]), background(body), "transcript top buffer matches the question body");
  assert.equal(background(resultRows.at(-1)), background(body), "transcript bottom buffer matches the question body");
  assert.equal(visibleWidth(resultRows[0]), 100);
  assert.match(stripTerminalSequences(resultRows[1]), /Q1: Choose a target/, "pending question begins immediately after top fill");
  assert.equal(visibleWidth(resultRows.at(-1)), 100);
  const separatorBg = backgroundAnsi(parseColor("#3d351b"), themes.theme.getColorMode());
  assert.ok(resultRows.slice(1, -1).filter(line => !stripTerminalSequences(line).trim()).every(line => line.includes(separatorBg)), "internal transcript separators retain a darker amber fill");
  if (process.env.QUESTION_TRANSCRIPT_SAMPLE) {
    const widget = h.widgetComponent();
    writeFileSync(process.env.QUESTION_TRANSCRIPT_SAMPLE, [...painted, "", ...widget.render(100)].join("\n") + "\n");
  }
  const before = requested;
  const opening = h.command("Q1");
  h.current().component.handleInput("\x1b[B");
  assert.equal(h.sent.length, 0);
  h.current().component.handleInput("\r");
  await opening;
  assert.ok(requested > before, "native renderer context invalidation requests a fresh layout");
  check(frame());
  assert.match(frame(), /Q1 · Answered · saved, delivery unconfirmed/);
  const answeredRows = h.tool.renderResult(first, { expanded: false }, themes.theme).render(100);
  assert.match(stripTerminalSequences(answeredRows[1]), /Q1 · Answered/);
  assert.equal(stripTerminalSequences(answeredRows[2]).trim(), "", "resolved status retains its separator before the question");
  assert.ok(answeredRows[2].includes(separatorBg), "resolved status separator retains darker amber fill");
  assert.match(stripTerminalSequences(answeredRows[3]), /Q1: Choose a target/);
  assert.doesNotMatch(frame(), /Q1 · Pending/);
  await h.message(user(h.sent[0].content));
  await h.message(assistant("Using the chosen target."));
  assert.match(frame(), /Q1 · Answered/);
  assert.doesNotMatch(frame(), /delivery unconfirmed|Pending/);
  const count = h.records().length;
  await h.emit("agent_settled");
  assert.equal(h.records().length, count, "live status never appends confirmation snapshots");
  const secondArgs = { question: "Proceed further?", options: [{ label: "Pause" }] };
  const second = await h.ask(secondArgs);
  await h.toolMessage(second);
  const secondComponent = new ToolExecutionComponent("ask_user", "call-2", secondArgs, { showImages: false }, h.tool, { requestRender() {} }, scratch);
  secondComponent.updateResult(second); document.addChild(secondComponent);
  assert.match(frame(), /Q1 · Answered/);
  assert.match(frame(), /Q2: Proceed further/);
  assert.doesNotMatch(frame(), /Q2 · Pending|click to answer/);
  const dismissing = h.command("Q2"); h.current().done({ kind: "dismiss" }); await dismissing;
  assert.match(frame(), /Q2 · Dismissed/);
  const dismissedRows = h.tool.renderResult(second, { expanded: false }, themes.theme).render(100);
  assert.match(stripTerminalSequences(dismissedRows[1]), /Q2 · Dismissed/);
  assert.ok(dismissedRows[2].includes(separatorBg), "dismissed status keeps the darker amber separator");
  assert.match(stripTerminalSequences(dismissedRows[3]), /Q2: Proceed further/);
  assert.doesNotMatch(frame(), /Q[12] · Pending/);
  assert.equal(h.sent.length, 1, "dismissal and live rendering send no extra messages");
  assert.equal(JSON.stringify(first), immutable, "old tool result remains an immutable historical pending result");
  assert.equal(h.manager.getBranch().filter(entry => entry.type === "message" && entry.message.customType === "compact-tools:question-status").length, 0);
  component.setExpanded(true); check(frame());
  const resumed = await harness({ manager: h.manager });
  assert.match(plain(resumed.tool.renderResult(first, { expanded: false }, themes.theme)), /Q1 · Answered/);
  assert.match(plain(resumed.tool.renderResult(second, { expanded: false }, themes.theme)), /Q2 · Dismissed/);
});

test("live transcript keeps delivery uncertainty truthful after failed sends and labeled input", async () => {
  const h = await harness();
  const result = await h.ask();
  const rendered = h.tool.renderResult(result, { expanded: false }, themes.theme);
  h.loaded.runtime.sendUserMessage = () => { throw new Error("preflight rejected"); };
  const opening = h.command(); h.submitCustom("Preserve it"); await opening;
  assert.match(plain(rendered), /Answered · saved, delivery unconfirmed/);
  assert.doesNotMatch(plain(rendered), /Pending/);
  const second = await h.ask({ question: "Second?" });
  const secondRendered = h.tool.renderResult(second, { expanded: false }, themes.theme);
  await h.input("Q2: No", { persist: false });
  assert.match(plain(secondRendered), /Answered · saved, delivery unconfirmed/);
  await h.message(user("Q2: No"));
  assert.match(plain(secondRendered), /Q2 · Answered/);
  assert.doesNotMatch(plain(secondRendered), /unconfirmed|Pending/);
  assert.match(plain(rendered), /unconfirmed/, "unrelated message cannot confirm Q1");
  await h.emit("session_tree");
  assert.match(plain(rendered), /unconfirmed/);
  assert.doesNotMatch(plain(secondRendered), /unconfirmed/);
});

test("resolve_question anchors observed native input with visible chat, refreshes UI, and never resends", async () => {
  const h = await harness();
  const pending = await h.ask({ question: "Which database should this local tool use?" });
  let invalidations = 0;
  const transcript = h.tool.renderResult(pending, { expanded: false }, themes.theme,
    { toolCallId: pending.details.question.toolCallId, invalidate() { invalidations++; } });
  const original = JSON.stringify(pending);
  const body = "Use SQLite for this local tool.\nKeep everything on disk.";
  await h.input(body);
  assert.equal(h.latest().status, "pending", "unlabelled input must not automatically resolve anything");
  const before = h.records().length;
  const result = await h.resolveQuestion({ question_id: 1, resolution: "answered", reason: "The user explicitly chose the database for this local tool.", user_message: body });
  assert.notEqual(result.isError, true);
  assert.equal(h.records().length, before + 1);
  const resolved = h.latest();
  assert.equal(resolved.version, 1, "minimal additive schema, not a migration");
  assert.equal(resolved.question, pending.details.question.question);
  assert.equal(resolved.answer.text, body, "persist the full observed input text, not an agent-authored answer");
  assert.equal(resolved.resolution.actor, "agent");
  assert.equal(resolved.resolution.evidence.text, body);
  assert.equal(resolved.resolution.evidence.inputSource, "interactive");
  const source = h.manager.getEntry(resolved.resolution.evidence.chatEntryId);
  assert.equal(source.type, "message"); assert.equal(source.message.role, "user");
  assert.equal(source.message.content, body);
  assert.equal(h.manager.getEntry(resolved.resolution.evidence.inputEntryId).customType, "compact-tools:question-input");
  assert.equal(resolved.delivered, true);
  assert.equal(resolved.continuation, undefined);
  assert.equal(h.widget(), "");
  assert.equal(h.statuses.get(deliveryStatusKey), undefined);
  assert.match(plain(transcript), /Q1 · Answered/);
  assert.match(plain(transcript), /Answer: Use SQLite for this local tool/);
  for (const expanded of [false, true]) {
    const frame = plain(h.tool.renderResult(pending, { expanded }, themes.theme));
    assert.doesNotMatch(frame, /agent-recorded|Observed input|Matching chat|receipt|Agent resolution|proof|authorization/);
    assert.doesNotMatch(frame, /The user explicitly chose/, "answer rationale remains internal");
  }
  assert.doesNotMatch(plain(transcript), /unconfirmed|Pending/);
  assert.ok(invalidations > 0, "existing public transcript invalidation is reused");
  assert.equal(JSON.stringify(pending), original, "old pending tool result remains immutable");
  await h.command("Q1 retry");
  assert.equal(h.dialogs.length, 0); assert.equal(h.sent.length, 0);
  assert.equal(result.content[0].text, "Q1: marked answered.");
  assert.deepEqual(result.details, { status: "answered", question_id: 1 }, "tool output does not duplicate the saved audit record");
});

test("resolve_question rejects missing, fabricated, excerpt, assistant, tool, extension and summary evidence", async () => {
  for (const kind of ["missing", "fabricated", "excerpt", "assistant", "tool", "extension", "extension-receipt", "summary", "assistant-with-receipt", "tool-with-receipt", "summary-with-receipt", "unobserved", "undurable", "before-question"]) {
    const h = await harness();
    const body = "Use Postgres for this application.";
    if (kind === "before-question") await h.input(body);
    await h.ask({ question: "Which database?" });
    if (kind === "excerpt") await h.input(`${body}\nDo not change production.`);
    if (kind.endsWith("-with-receipt")) await h.input(body, { persist: false });
    if (kind === "assistant" || kind === "assistant-with-receipt") await h.message(assistant(body));
    if (kind === "tool" || kind === "tool-with-receipt") await h.message({ role: "toolResult", toolName: "bash", toolCallId: "tool-body", content: [{ type: "text", text: body }], timestamp: Date.now() });
    if (kind === "extension") await h.input(body, { source: "extension" });
    if (kind === "extension-receipt") {
      h.manager.appendCustomEntry("compact-tools:question-input", { version: 1, source: "extension", text: body, pendingIds: [1] });
      await h.message(user(body));
    }
    if (kind === "summary" || kind === "summary-with-receipt") h.manager.appendCustomMessageEntry("compact-tools:question-reminder", body, false);
    if (kind === "unobserved") await h.message(user(body));
    if (kind === "undurable") await h.input(body, { persist: false });
    const entries = h.manager.getEntries().length;
    const snapshots = JSON.stringify(h.records());
    const result = await h.resolveQuestion({ question_id: 1, resolution: "answered", reason: "Record the user's choice.", ...(kind === "missing" ? {} : { user_message: body }) });
    assert.equal(result.isError, true, kind);
    assert.equal(JSON.stringify(h.records()), snapshots, kind);
    assert.equal(h.manager.getEntries().length, entries, `${kind}: failed resolution appends nothing`);
    assert.equal((h.widget().match(/Q\d+:/g) ?? []).length, 1);
    assert.equal(h.latest().answer, undefined);
    assert.equal(h.sent.length, 0); assert.equal(h.dialogs.length, 0);
  }
});

test("agent dismissal is auditable, preserves snapshots and never claims user dismissal or approval", async () => {
  const h = await harness();
  const first = await h.ask({ question: "Which retired API should be used?", options: [{ label: "Old API" }] });
  const transcript = h.tool.renderResult(first, { expanded: false }, themes.theme);
  const root = h.manager.getLeafId();
  const reason = "The API integration was removed from the requested scope; no decision is needed.";
  const result = await h.resolveQuestion({ question_id: 1, resolution: "dismissed", reason });
  assert.notEqual(result.isError, true);
  assert.equal(h.records().length, 2);
  assert.equal(h.records()[0].status, "pending");
  assert.equal(h.latest().status, "dismissed");
  assert.deepEqual(h.latest().options, first.details.question.options);
  assert.equal(h.latest().resolution.actor, "agent");
  assert.equal(h.latest().resolution.reason, reason);
  assert.equal(h.latest().answer, undefined); assert.equal(h.latest().delivery, undefined);
  assert.equal(h.latest().resolution.evidence, undefined);
  assert.match(plain(transcript), /Dismissed by agent/);
  assert.match(plain(transcript), /Reason: The API integration/);
  assert.equal(result.content[0].text, "Q1: dismissed as obsolete.");
  assert.deepEqual(result.details, { status: "dismissed", question_id: 1 });
  assert.equal(h.widget(), ""); assert.equal(h.sent.length, 0); assert.equal(h.dialogs.length, 0);
  const [reminder] = await h.emit("before_agent_start");
  assert.match(reminder.message.content, /agent dismissal: The API integration/);
  assert.doesNotMatch(reminder.message.content, /dismissed by the user/i);
  assert.match(reminder.message.content, /Dismissal authorizes no action/);
  const resumed = await harness({ manager: h.manager });
  assert.equal(resumed.widget(), "");
  resumed.manager.branch(root); await resumed.emit("session_tree");
  assert.equal((resumed.widget().match(/Q\d+:/g) ?? []).length, 1, "agent obsolescence is branch-local, unlike manual user dismissal");
  assert.notEqual((await resumed.ask({ question: first.details.question.question, options: first.details.question.options, question_id: 1 })).isError, true);
  assert.equal((await resumed.ask({ question: "A genuinely different question?" })).details.question.id, 2);
});

test("agent dismissal stays on its branch while manual user dismissal remains global and another branch can answer", async () => {
  const h = await harness();
  const first = await h.ask({ question: "Which database?" });
  await h.ask({ question: "Which obsolete optional feature?" });
  const ancestor = h.manager.getLeafId();
  const reason = "Branch A no longer includes the database feature.";
  await h.resolveQuestion({ question_id: 1, resolution: "dismissed", reason });
  const manual = h.command("Q2"); h.current().done({ kind: "dismiss" }); await manual;
  const branchA = h.manager.getLeafId();
  assert.equal(h.widget(), "");

  h.manager.branch(ancestor); await h.emit("session_tree");
  assert.equal((h.widget().match(/Q\d+:/g) ?? []).length, 1, "Q1 is still relevant on the sibling branch");
  const [pendingReminder] = await h.emit("before_agent_start");
  assert.match(pendingReminder.message.content, /Unanswered user questions.*\nQ1: Which database/);
  assert.match(pendingReminder.message.content, /Q2: Which obsolete optional feature\? — dismissed by the user/);
  assert.doesNotMatch(pendingReminder.message.content, /agent dismissal/);
  const dialogs = h.dialogs.length;
  await h.command("Q2");
  assert.equal(h.dialogs.length, dialogs, "manual user dismissal is honored across branches");
  await h.input("Use SQLite for the database.");
  await h.resolveQuestion({ question_id: 1, resolution: "answered", reason: "The user specified the database for branch B.", user_message: "Use SQLite for the database." });
  const branchB = h.manager.getLeafId();
  const branchBAnswer = structuredClone(h.latest());
  assert.equal(branchBAnswer.status, "answered");
  assert.equal(h.widget(), "");
  assert.equal(h.statuses.get(deliveryStatusKey), undefined);

  h.manager.branch(branchA); await h.emit("session_tree");
  const transcript = plain(h.tool.renderResult(first, { expanded: false }, themes.theme));
  assert.match(transcript, /Dismissed by agent/);
  assert.match(transcript, /Branch A no longer includes/);
  assert.doesNotMatch(transcript, /Answer:/);
  assert.equal(h.widget(), "");
  const [dismissedReminder] = await h.emit("before_agent_start");
  assert.match(dismissedReminder.message.content, /Q1: Which database\? — agent dismissal:/);
  assert.match(dismissedReminder.message.content, /Q2: Which obsolete optional feature\? — dismissed by the user/);

  h.manager.branch(branchB); await h.emit("session_tree");
  assert.deepEqual(h.latest(), branchBAnswer, "neither kind of sibling dismissal overwrites branch B's answer");
  assert.match(plain(h.tool.renderResult(first, { expanded: false }, themes.theme)), /Q1 · Answered/);
  assert.equal(h.widget(), ""); assert.equal(h.statuses.get(deliveryStatusKey), undefined);
  await h.command("Q1 retry"); assert.equal(h.sent.length, 0);
});

test("unknown agent-dismissed IDs do not leak into unrelated branches but still reserve the session ID", async () => {
  const h = await harness();
  const ancestor = h.manager.appendMessage(user("Shared root before any question."));
  await h.ask({ question: "Branch A only question?" });
  const params = { question_id: 1, resolution: "dismissed", reason: "Branch A dropped this optional feature." };
  await h.resolveQuestion(params);
  const branchA = h.manager.getLeafId();
  h.manager.branch(ancestor); await h.emit("session_tree");
  assert.equal(h.widget(), "");
  assert.equal((await h.emit("before_agent_start"))[0], undefined, "unrelated branch has no leaked dismissed record/reminder");
  const entries = h.manager.getEntries().length;
  assert.equal((await h.resolveQuestion(params)).isError, true, "unknown branch-local ID cannot resolve or return an idempotent success");
  assert.equal(h.manager.getEntries().length, entries);
  assert.equal((await h.ask({ question: "Branch A only question?", question_id: 1 })).isError, true);
  const next = await h.ask({ question: "Branch B question?" });
  assert.equal(next.details.question.id, 2, "session-wide high-water still includes the agent-dismissed ID");
  assert.equal((h.widget().match(/Q\d+:/g) ?? []).length, 1);
  const [reminder] = await h.emit("before_agent_start");
  assert.match(reminder.message.content, /Q2: Branch B question/);
  assert.doesNotMatch(reminder.message.content, /Q1:|Branch A/);
  h.manager.branch(branchA); await h.emit("session_tree");
  assert.equal(h.widget(), "");
  assert.equal(h.latest().status, "dismissed");
  assert.equal(h.latest().resolution.reason, params.reason);
  assert.notEqual((await h.resolveQuestion(params)).isError, true);
});

test("resolution provenance and answered state survive disk reopen without resend or retry recovery", async () => {
  const manager = SessionManager.create(scratch, join(scratch, "resolution-sessions"));
  manager.appendMessage(assistant("Begin isolated persistence fixture."));
  const h = await harness({ manager });
  await h.ask({ question: "Which color?" });
  const body = "Use blue for the icon.";
  await h.input(body);
  const params = { question_id: 1, resolution: "answered", reason: "The user chose the icon color.", user_message: body };
  await h.resolveQuestion(params);
  const resolved = structuredClone(h.latest());
  await h.emit("session_shutdown");
  const resumed = await harness({ manager: SessionManager.open(manager.getSessionFile()) });
  assert.deepEqual(resumed.latest(), resolved);
  assert.equal(resumed.widget(), ""); assert.equal(resumed.statuses.get(deliveryStatusKey), undefined);
  const count = resumed.manager.getEntries().length;
  const result = await resumed.resolveQuestion(params);
  assert.notEqual(result.isError, true);
  assert.equal(resumed.manager.getEntries().length, count, "idempotent retry is append-free after reload");
  await resumed.command("Q1 retry"); await resumed.emit("agent_settled");
  assert.equal(resumed.sent.length, 0); assert.equal(resumed.dialogs.length, 0);
  assert.equal(resumed.confirmations.length, 0);
});

test("answered provenance is branch-local and requires the durable user entry, not abandoned evidence", async () => {
  const h = await harness();
  await h.ask({ question: "Which color?" });
  const root = h.manager.getLeafId();
  const body = "Use green for the icon.";
  await h.input(body);
  const params = { question_id: 1, resolution: "answered", reason: "User supplied the icon color.", user_message: body };
  await h.resolveQuestion(params);
  const answeredLeaf = h.manager.getLeafId();
  h.manager.branch(root); await h.emit("session_tree");
  assert.equal((h.widget().match(/Q\d+:/g) ?? []).length, 1);
  assert.equal((await h.resolveQuestion(params)).isError, true, "same-session abandoned user evidence is not current-branch evidence");
  assert.equal(h.latest().status, "pending");
  h.manager.branch(answeredLeaf); await h.emit("session_tree");
  assert.equal(h.widget(), ""); assert.equal(h.statuses.get(deliveryStatusKey), undefined);
  assert.notEqual((await h.resolveQuestion(params)).isError, true);
  const otherSession = await harness();
  await otherSession.ask({ question: "Which color?" });
  assert.equal((await otherSession.resolveQuestion(params)).isError, true, "another session cannot supply evidence");
  assert.equal(h.sent.length, 0); assert.equal(otherSession.sent.length, 0);
});

test("resolution unknown IDs, conflicting retries, malformed and aborted requests leave history untouched", async () => {
  const h = await harness();
  await h.ask();
  for (const params of [
    { question_id: 99, resolution: "dismissed", reason: "Obsolete." },
    { question_id: 1, resolution: "dismissed", reason: "   " },
    { question_id: 1, resolution: "dismissed", reason: "Obsolete.", user_message: "yes" },
    { question_id: 1, resolution: "approve", reason: "No such resolution." },
  ]) {
    const count = h.manager.getEntries().length;
    assert.equal((await h.resolveQuestion(params)).isError, true);
    assert.equal(h.manager.getEntries().length, count);
    assert.equal(h.latest().status, "pending");
  }
  const controller = new AbortController(); controller.abort();
  assert.equal((await h.resolveQuestion({ question_id: 1, resolution: "dismissed", reason: "Obsolete." }, controller.signal)).isError, true);
  assert.equal(h.latest().status, "pending");
  const params = { question_id: 1, resolution: "dismissed", reason: "This question is obsolete." };
  await h.resolveQuestion(params);
  const snapshots = JSON.stringify(h.records());
  const count = h.manager.getEntries().length;
  assert.notEqual((await h.resolveQuestion(params)).isError, true);
  assert.equal((await h.resolveQuestion({ ...params, reason: "A changed reason." })).isError, true);
  assert.equal((await h.resolveQuestion({ ...params, resolution: "answered", user_message: "yes" })).isError, true);
  assert.equal(h.manager.getEntries().length, count); assert.equal(JSON.stringify(h.records()), snapshots);
  const answered = await harness();
  await answered.ask(); await answered.input("No changes are wanted.");
  const answerParams = { question_id: 1, resolution: "answered", reason: "The user declined changes.", user_message: "No changes are wanted." };
  await answered.resolveQuestion(answerParams);
  const original = JSON.stringify(answered.records());
  assert.notEqual((await answered.resolveQuestion(answerParams)).isError, true);
  assert.equal((await answered.resolveQuestion({ ...answerParams, user_message: "Yes, do everything." })).isError, true);
  assert.equal((await answered.resolveQuestion({ question_id: 1, resolution: "dismissed", reason: "Obsolete." })).isError, true);
  assert.equal(JSON.stringify(answered.records()), original);
  assert.equal(answered.sent.length, 0);
});

test("resolution closes manual UI safely; stale Submit/Dismiss and list callbacks cannot replace it", async () => {
  for (const resolution of ["answered", "dismissed"]) {
    const h = await harness();
    await h.ask({ question: "Which database?" });
    const widget = h.widgetComponent(); widget.render(80);
    widget.handleMouse({ type: "click", button: "left", x: 3, y: 0 }); widget.render(80);
    const opening = h.command("Q1");
    const stale = h.current();
    const body = "Use SQLite for the database.";
    if (resolution === "answered") await h.input(body); // Active dialog prevents automatic label processing, not provenance.
    const result = await h.resolveQuestion({ question_id: 1, resolution, reason: resolution === "answered" ? "The user specified the database." : "Database selection is no longer in scope.",
      ...(resolution === "answered" ? { user_message: body } : {}) });
    assert.notEqual(result.isError, true);
    await opening;
    assert.equal(stale.closes, 1, "resolved dialog closes promptly without waiting for a user action");
    const snapshots = JSON.stringify(h.records());
    stale.component.handleInput("Forged late answer"); stale.component.handleInput("\r");
    stale.done({ kind: "dismiss" });
    widget.handleMouse({ type: "click", button: "left", x: 3, y: 1 });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(JSON.stringify(h.records()), snapshots);
    assert.equal(h.dialogs.length, 1, "stale pending list cannot reopen a resolved ID");
    assert.equal(h.sent.length, 0); assert.equal(h.widget(), "");
  }
});

test("native host persistence boundary rejects a user message until it is actually durable", async () => {
  const h = await harness();
  await h.ask({ question: "Which color?" });
  const body = "Use amber for the warning icon.";
  await h.input(body, { persist: false });
  const params = { question_id: 1, resolution: "answered", reason: "The user specified the warning color.", user_message: body };
  let preAppend;
  const host = orderingHost(h, event => {
    if (event.type === "message_end") preAppend = h.resolveQuestion(params);
  });
  await host._handleAgentEvent({ type: "message_end", message: user(body) });
  assert.equal((await preAppend).isError, true, "message_end is not yet durable");
  assert.equal(h.latest().status, "pending");
  assert.notEqual((await h.resolveQuestion(params)).isError, true);
  assert.equal(h.sent.length, 0);
});

test("headless resolution uses the same provenance rules and never opens UI or fabricates an answer", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const h = await harness({ mode, hasUI: mode === "rpc" });
    await h.ask({ question: "Which color?" });
    const params = { question_id: 1, resolution: "answered", reason: "The user chose the icon color.", user_message: "Use violet for the icon." };
    assert.equal((await h.resolveQuestion(params)).isError, true);
    await h.input(params.user_message, { source: "rpc" });
    assert.notEqual((await h.resolveQuestion(params)).isError, true);
    assert.equal(h.latest().resolution.evidence.inputSource, "rpc");
    await h.ask({ question: "Obsolete question?" });
    assert.notEqual((await h.resolveQuestion({ question_id: 2, resolution: "dismissed", reason: "This optional feature was dropped." })).isError, true);
    assert.equal(h.dialogs.length, 0); assert.equal(h.sent.length, 0);
    assert.equal(h.statuses.get(deliveryStatusKey), undefined);
  }
});

test("native failed preflight plus image-bearing or transformed extension echo uses only the observed input as source", async () => {
  for (const variant of ["images", "transformed", "empty-transformed"]) for (const observedInput of [true, false]) {
    const h = await harness();
    const pending = await h.ask({ question: "Which database?" });
    const body = "Use SQLite.";
    const host = Object.create(AgentSession.prototype);
    host.agent = { state: { model: undefined } };
    host._isAgentRunActive = false;
    host._modelRuntime = { hasConfiguredAuth: () => true, checkAuth: async () => undefined };
    host._extensionRunner = {
      hasHandlers: name => name === "input",
      async emitInput(text, images, source) {
        await h.emit("input", { text, images, source });
        // A later extension handler may transform after compact-tools observes the input.
        return source === "extension" && variant !== "images" ? { action: "transform", text: body } : { action: "continue" };
      },
    };
    let runs = 0;
    host._startRun = async trigger => {
      runs++;
      await h.message(trigger.images?.length
        ? { role: "user", content: [{ type: "text", text: trigger.prompt }, ...trigger.images], timestamp: Date.now() }
        : user(trigger.prompt));
    };
    if (observedInput) await assert.rejects(host.prompt(body, { expandPromptTemplates: false }), /model/i);
    assert.equal(runs, 0);
    host.agent.state.model = { provider: "fixture", id: "fixture" };
    const generated = variant === "images" ? [{ type: "text", text: body }, { type: "image", data: "fixture-image", mimeType: "image/png" }]
      : variant === "empty-transformed" ? "" : "Generated extension payload transformed later.";
    await host.sendUserMessage(generated, { expandPromptTemplates: false });
    assert.equal(runs, 1, "installed extension-send -> input -> prompt path produces only the echo");
    const receipts = h.manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "compact-tools:question-input");
    assert.equal(receipts.length, observedInput ? 1 : 0, "extension inputs create neither native receipts nor permanent seals");
    const params = { question_id: 1, resolution: "answered", reason: "The observed database choice remains relevant; original delivery is not asserted.", user_message: body };
    const result = await h.resolveQuestion(params);
    if (!observedInput) {
      assert.equal(result.isError, true, `${variant}: extension-only evidence is insufficient`);
      assert.equal(h.latest().status, "pending");
      await host.prompt("Use Postgres instead.", { expandPromptTemplates: false });
      assert.notEqual((await h.resolveQuestion({ ...params, user_message: "Use Postgres instead." })).isError, true, "prior extension input never seals later native evidence");
    } else {
      assert.notEqual(result.isError, true, variant);
      assert.equal(h.latest().resolution.evidence.inputEntryId, receipts[0].id);
      assert.equal(h.latest().resolution.evidence.inputSource, "interactive");
      const frame = plain(h.tool.renderResult(pending, { expanded: false }, themes.theme));
      assert.match(frame, /Q1 · Answered/);
      assert.match(frame, /Answer: Use SQLite/);
      assert.doesNotMatch(frame, /receipt|Matching chat|already received|delivery confirmed|Source: user chat/);
      assert.equal(result.content[0].text, "Q1: marked answered.");
      assert.equal(runs, 1, "recording must not resend or trigger any native host run");
    }
    const resumed = await harness({ manager: h.manager });
    assert.equal(resumed.widget(), ""); assert.equal(resumed.statuses.get(deliveryStatusKey), undefined);
    await resumed.command("Q1 retry");
    assert.equal(resumed.dialogs.length, 0); assert.equal(resumed.sent.length, 0); assert.equal(h.sent.length, 0);
  }
});

test("extension inputs before or during questions do not seal native observed-input evidence", async () => {
  const h = await harness();
  await h.input("Before any question.", { source: "extension" });
  await h.ask({ question: "Which color?" });
  await h.input("Use blue.");
  await h.input("Later generated text.", { source: "extension" });
  const params = { question_id: 1, resolution: "answered", reason: "The observed input selects blue; no later cancellation was observed.", user_message: "Use blue." };
  assert.notEqual((await h.resolveQuestion(params)).isError, true);
  const resumed = await harness({ manager: h.manager });
  assert.equal(resumed.widget(), ""); assert.equal(resumed.statuses.get(deliveryStatusKey), undefined);
  assert.notEqual((await resumed.resolveQuestion(params)).isError, true);
  assert.equal(h.sent.length, 0); assert.equal(resumed.sent.length, 0);
});

test("input receipts describe our hook position, not raw keystrokes or later transformed delivery", async () => {
  for (const order of ["before", "after"]) {
    const h = await harness();
    const pending = await h.ask({ question: "Which database?" });
    const raw = "Pick the local database.";
    const observed = order === "before" ? "Use SQLite." : raw;
    const visible = order === "before" ? observed : "Later-hook replacement.";
    const host = Object.create(AgentSession.prototype);
    host.agent = { state: { model: { provider: "fixture", id: "fixture" } } };
    host._isAgentRunActive = false;
    host._modelRuntime = { hasConfiguredAuth: () => true };
    host._extensionRunner = {
      hasHandlers: name => name === "input",
      async emitInput(text, images, source) {
        const atOurHook = source === "interactive" ? observed : text;
        await h.emit("input", { text: atOurHook, images, source });
        return { action: "transform", text: source === "interactive" ? visible : text };
      },
    };
    let runs = 0;
    host._startRun = async trigger => { runs++; await h.message(user(trigger.prompt)); };
    await host.prompt(raw, { expandPromptTemplates: false });
    const receipt = h.manager.getBranch().find(entry => entry.type === "custom" && entry.customType === "compact-tools:question-input");
    assert.equal(receipt.data.text, observed, "receipt faithfully records only what our input hook observed");
    const params = { question_id: 1, resolution: "answered", reason: "Observed database input remains relevant after considering later messages.", user_message: observed };
    if (order === "after") {
      assert.equal((await h.resolveQuestion({ ...params, user_message: visible })).isError, true, "visible transformed text alone has no matching native receipt");
      assert.equal((await h.resolveQuestion(params)).isError, true, "observed input alone has no matching visible chat yet");
      await host.sendUserMessage(observed, { expandPromptTemplates: false }); // Explicitly an echo, not original delivery.
    }
    const beforeResolution = runs;
    assert.notEqual((await h.resolveQuestion(params)).isError, true);
    assert.equal(runs, beforeResolution);
    assert.equal(h.latest().resolution.evidence.inputEntryId, receipt.id);
    const frame = plain(h.tool.renderResult(pending, { expanded: false }, themes.theme));
    assert.match(frame, /Q1 · Answered/);
    assert.doesNotMatch(frame, /proof|Matching chat|receipt/);
    assert.equal(h.sent.length, 0);
  }
});

test("native queue removal preserves observed text only; later echo is corroboration, not delivery or current-intent proof", async () => {
  const h = await harness();
  const pending = await h.ask({ question: "Which database?" });
  const body = "Use SQLite.";
  const queued = [];
  const host = Object.create(AgentSession.prototype);
  host.agent = { state: { model: { provider: "fixture", id: "fixture" } }, steer(message) { queued.push(message); }, clearAllQueues() { queued.length = 0; } };
  host._isAgentRunActive = true;
  host._steeringMessages = []; host._followUpMessages = [];
  host._emitQueueUpdate = () => {};
  host._modelRuntime = { hasConfiguredAuth: () => true };
  host._extensionRunner = {
    hasHandlers: name => name === "input",
    async emitInput(text, images, source) { await h.emit("input", { text, images, source }); return { action: "continue" }; },
  };
  let runs = 0;
  host._startRun = async trigger => { runs++; await h.message(user(trigger.prompt)); };
  await host.prompt(body, { streamingBehavior: "steer", expandPromptTemplates: false });
  assert.equal(queued.length, 1);
  assert.deepEqual(host.clearQueue(), { steering: [body], followUp: [] });
  assert.equal(queued.length, 0);
  const params = { question_id: 1, resolution: "answered", reason: "Agent curation records observed database text only, not queue delivery or current intent.", user_message: body };
  assert.equal((await h.resolveQuestion(params)).isError, true, "a durable receipt alone is insufficient without visible corroboration");
  host._isAgentRunActive = false;
  await host.sendUserMessage(body, { expandPromptTemplates: false });
  assert.equal(runs, 1, "only the explicit fixture echo starts a host run");
  assert.notEqual((await h.resolveQuestion(params)).isError, true);
  assert.equal(runs, 1, "resolution starts no run");
  const frame = plain(h.tool.renderResult(pending, { expanded: false }, themes.theme));
  assert.match(frame, /Q1 · Answered/);
  assert.match(frame, /Answer: Use SQLite/);
  assert.doesNotMatch(frame, /receipt|Matching chat|proof|authorization/);
  assert.doesNotMatch(frame, /delivery confirmed|already received/);
  const resumed = await harness({ manager: h.manager });
  await resumed.command("Q1 retry");
  assert.equal(resumed.statuses.get(deliveryStatusKey), undefined);
  assert.equal(h.sent.length, 0); assert.equal(resumed.sent.length, 0); assert.equal(resumed.confirmations.length, 0);
});

test("restoration validates exact input/chat IDs, source and question-input-chat-resolution chronology", async () => {
  const h = await harness();
  const pending = await h.ask({ question: "Which database?" });
  const body = "Use SQLite.";
  await h.input(body);
  await h.resolveQuestion({ question_id: 1, resolution: "answered", reason: "The observed input chooses SQLite.", user_message: body });
  for (const variant of ["valid", "chat-before-input", "input-before-question", "chat-after-resolution", "wrong-source", "wrong-input-id", "wrong-chat-id", "assistant-chat"]) {
    const timestamp = new Date().toISOString();
    const resolved = structuredClone(h.latest());
    resolved.resolution.evidence = { inputEntryId: "input", inputSource: "interactive", chatEntryId: "chat", text: body };
    const entries = {
      question: { id: "question", type: "custom", customType: entryType, data: structuredClone(pending.details.question) },
      input: { id: "input", type: "custom", customType: "compact-tools:question-input", data: { version: 1, source: "interactive", text: body, pendingIds: [1] } },
      chat: { id: "chat", type: "message", message: user(body) },
      resolution: { id: "resolution", type: "custom", customType: entryType, data: resolved },
    };
    let order = ["question", "input", "chat", "resolution"];
    if (variant === "chat-before-input") order = ["question", "chat", "input", "resolution"];
    if (variant === "input-before-question") order = ["input", "question", "chat", "resolution"];
    if (variant === "chat-after-resolution") order = ["question", "input", "resolution", "chat"];
    if (variant === "wrong-source") resolved.resolution.evidence.inputSource = "rpc";
    if (variant === "wrong-input-id") resolved.resolution.evidence.inputEntryId = "chat";
    if (variant === "wrong-chat-id") resolved.resolution.evidence.chatEntryId = "input";
    if (variant === "assistant-chat") entries.chat.message = assistant(body);
    // Independent in-memory corruption/ordering fixture; no stored session history is edited.
    const fixture = SessionManager.inMemory(scratch, undefined, [h.manager.getHeader(), ...order.map((key, index) => ({ ...entries[key], timestamp, parentId: index ? order[index - 1] : null }))]);
    const resumed = await harness({ manager: fixture });
    if (variant === "valid") {
      assert.equal(resumed.widget(), "");
      assert.match(plain(resumed.tool.renderResult(pending, { expanded: false }, themes.theme)), /Q1 · Answered/);
    } else {
      assert.equal((resumed.widget().match(/Q\d+:/g) ?? []).length, 1, variant);
      await resumed.command("Q1 retry");
      assert.match(resumed.notifications.at(-1).message, /no saved answer/, variant);
    }
    assert.equal(resumed.statuses.get(deliveryStatusKey), undefined);
    assert.equal(resumed.sent.length, 0); assert.equal(resumed.dialogs.length, 0);
  }
});

test("repeated queued native text cannot invalidate the exact recorded evidence tuple on reload", async () => {
  const h = await harness();
  await h.ask({ question: "Which database?" });
  const body = "Use SQLite.";
  await h.input(body, { persist: false });
  await h.input(body, { persist: false });
  await h.message(user(body));
  const params = { question_id: 1, resolution: "answered", reason: "The user selected SQLite.", user_message: body };
  assert.notEqual((await h.resolveQuestion(params)).isError, true);
  const original = structuredClone(h.latest());
  const originalEvidence = original.resolution.evidence;
  await h.message(user(body)); // The second pending native input becomes durable only after resolution.
  const duplicate = h.manager.getBranch().at(-1);
  assert.notEqual(duplicate.id, originalEvidence.chatEntryId);
  const resumed = await harness({ manager: h.manager });
  assert.equal(resumed.widget(), "", "a later same-text turn must not resurrect the resolved question");
  assert.equal(resumed.statuses.get(deliveryStatusKey), undefined);
  assert.deepEqual(resumed.latest(), original, "already-recorded source/answer/history remain immutable");
  assert.equal(resumed.latest().resolution.evidence.chatEntryId, originalEvidence.chatEntryId);
  const count = resumed.manager.getEntries().length;
  assert.notEqual((await resumed.resolveQuestion(params)).isError, true);
  await resumed.command("Q1 retry"); await resumed.emit("agent_settled");
  assert.equal(resumed.manager.getEntries().length, count);
  assert.equal(resumed.dialogs.length, 0); assert.equal(resumed.sent.length, 0);
});

test("restore rejects answer snapshots with fabricated provenance instead of exposing duplicate-send recovery", async () => {
  const h = await harness();
  const result = await h.ask();
  const body = "Fabricated saved answer";
  h.manager.appendCustomEntry(entryType, { ...result.details.question, status: "answered", answer: { text: body },
    delivery: "user", delivered: true, resolution: { actor: "agent", reason: "Claimed reconciliation.", toolCallId: "fake-resolution",
      evidence: { chatEntryId: "missing-user-entry", inputEntryId: "missing-input-entry", inputSource: "interactive", text: body } } });
  await h.emit("session_tree");
  assert.equal((h.widget().match(/Q\d+:/g) ?? []).length, 1);
  assert.equal(h.statuses.get(deliveryStatusKey), undefined);
  await h.command("Q1 retry");
  assert.equal(h.dialogs.length, 0); assert.equal(h.sent.length, 0);
  assert.match(h.notifications.at(-1).message, /no saved answer/);
});

test("resolution persistence failure leaves the pending UI and question untouched", async () => {
  const h = await harness();
  await h.ask();
  const opening = h.command("Q1");
  const append = h.loaded.runtime.appendEntry;
  const snapshots = JSON.stringify(h.records());
  h.loaded.runtime.appendEntry = () => { throw new Error("fixture storage failure"); };
  await assert.rejects(h.resolveQuestion({ question_id: 1, resolution: "dismissed", reason: "Obsolete." }), /storage failure/);
  assert.equal(JSON.stringify(h.records()), snapshots);
  assert.equal(h.current().closes, 0);
  assert.equal((h.widget().match(/Q\d+:/g) ?? []).length, 1);
  h.loaded.runtime.appendEntry = append;
  h.current().component.handleInput("\x1b"); await opening;
  assert.equal(h.sent.length, 0);
});

test("native tool card routes heading, question and option clicks to the answer overlay, never expansion", async () => {
  const h = await harness();
  const view = nativeQuestionView(h, { rows: 35 });
  const args = { question: "Choose the development target?", options: [{ label: "Local only" }, { label: "Leave unchanged" }] };
  const result = await h.ask(args);
  const component = view.add(result, args);
  assert.equal(h.dialogs.length, 0);
  assert.doesNotMatch(view.text(), /Q1 · Pending|click to answer/);
  for (const pattern of [/Ask user/, /Q1: Choose/, /1\. Local only/]) {
    assert.equal(view.click(pattern)?.handled, true);
    assert.equal(component.expanded, false, "child handler wins over native expansion MouseRegion");
    assert.equal(h.current().customOptions.overlay, true);
    assert.equal(view.editor.getValue(), "Unsent ordinary draft");
    assert.equal(view.editor.focused, true);
    h.current().component.handleInput("\x1b");
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(h.sent.length, 0);
  assert.equal(h.latest().status, "pending");
  view.click(/Q1: Choose/);
  h.current().component.handleInput("\r");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sent.length, 1);
  assert.equal(h.latest().answer.text, "Local only");
  assert.match(view.text(), /Q1 · Answered/);
  view.click(/Q1: Choose/);
  assert.equal(h.dialogs.length, 4, "answered cards cannot open a new answer overlay");
  await h.emit("session_shutdown");
});

test("native fullscreen hides the entire list when any actual question row is visible, including partial questions", async () => {
  const h = await harness();
  const view = nativeQuestionView(h, { rows: 18, width: 42 });
  view.chat.addChild(new Text("before\n".repeat(30), 0, 0));
  const args = { question: "First actual question text wraps over multiple rows and ends here?", options: [{ label: "An option far below the question" }] };
  const result = await h.ask(args);
  const card = view.add(result, args);
  view.chat.addChild(new Text("after\n".repeat(30), 0, 0));
  view.frame();
  const before = view.chat.children[0].render(42).length;
  const rows = card.render(42).map(stripTerminalSequences);
  const first = rows.findIndex(line => /Q1: First/.test(line));
  const last = rows.findIndex(line => /ends here/.test(line));
  const option = rows.findIndex(line => /1\. An option/.test(line));
  const dock = view.root.entries.at(-1).component;
  const withoutList = () => {
    const list = view.list();
    const children = [...view.widgetsAbove.children]; view.widgetsAbove.removeChild(list);
    const height = dock.render(42).length;
    view.widgetsAbove.clear(); for (const child of children) view.widgetsAbove.addChild(child);
    return { list, viewport: 18 - Math.max(1, height) };
  };
  const { viewport } = withoutList();
  const stable = (top, hidden, label) => {
    view.transcript.scrollTo(top, { disableFollow: true });
    for (let i = 0; i < 5; i++) {
      view.frame();
      assert.equal(view.list().render(42).length === 0, hidden, label);
      assert.equal(view.reminderVisible(), !hidden, `${label}: no residual reminder rows/gap`);
      assert.doesNotMatch(view.text(), /Questions ·/);
    }
  };
  assert.ok(first > 0, "pending question follows the call title and its filled buffers");
  stable(before + first - viewport, false, "call/title/padding without actual text keeps reminder");
  stable(before + first - viewport + 1, true, "first text row at viewport bottom counts");
  stable(before + last, true, "only final wrapped question row at viewport top counts");
  stable(before + last + 1, false, "options or padding alone do not count");
  stable(before + option, false, "visible option is not visible question text");
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.sent.length, 0);
});

test("native grouped tool projection preserves question visibility and click identity across group expansion", async () => {
  const h = await harness({ grouping: true });
  const view = nativeQuestionView(h, { rows: 35 });
  for (let i = 0; i < 3; i++) {
    const tool = new ToolExecutionComponent("bash", `bash-${i}`, { command: "echo before question" }, { showImages: false }, undefined, view.tui, scratch);
    tool.updateResult({ content: [{ type: "text", text: "output\n".repeat(3) }] });
    view.chat.addChild(tool);
  }
  view.add(await h.ask({ question: "Question after grouped tools?" }));
  assert.match(view.text(), /3 tools/);
  assert.equal(view.reminderVisible(), false);
  assert.equal(view.click(/3 tools/)?.handled, true);
  assert.equal(view.reminderVisible(), false, "expanded grouped rows retain accurate native question offsets");
  assert.equal(view.click(/Q1: Question after/)?.handled, true);
  assert.equal(h.dialogs.length, 1);
  h.current().component.handleInput("\x1b");
  await new Promise(resolve => setImmediate(resolve));
  await h.emit("session_shutdown");
});

test("native fullscreen resize and follow-end decisions do not feed the reminder height back into visibility", async () => {
  const h = await harness();
  const view = nativeQuestionView(h, { rows: 24, width: 64 });
  const result = await h.ask({ question: "A visible question near the end?" });
  view.add(result);
  assert.equal(view.reminderVisible(), false);
  assert.deepEqual(view.list().render(64), []);
  assert.equal(view.list().handleMouse({ type: "click", button: "left", x: 3, y: 1 }), undefined, "hidden reminder has no stale hit rows");
  const filler = new Text("tail\n".repeat(22), 0, 0); view.chat.addChild(filler);
  for (const [width, height] of [[64, 24], [28, 12], [90, 50], [64, 24]]) {
    const first = view.frame(width, height);
    assert.doesNotMatch(first.lines.map(stripTerminalSequences).join("\n"), /Questions ·/);
    const expected = view.reminderVisible();
    for (let i = 0; i < 8; i++) assert.equal(view.reminderVisible(), expected);
    assert.equal(view.transcript.isFollowingEnd, true);
    assert.match(view.text(), /Unsent ordinary draft/);
  }
  view.chat.removeChild(filler);
  assert.equal(view.reminderVisible(), false, "newly visible question restores full transcript space immediately");
  assert.equal(getScrollViewBox(view.frame(), view.transcript).rect.height, 24 - view.root.entries.at(-1).component.render(64).length);
});

test("one offscreen question shows every pending question and stale/mismatched native cards prove no visibility", async () => {
  const h = await harness();
  const view = nativeQuestionView(h, { rows: 24 });
  const first = await h.ask({ question: "First pending scope?" });
  const oldCard = view.add(first);
  view.chat.addChild(new Text("middle\n".repeat(40), 0, 0));
  view.add(await h.ask({ question: "Second pending scope?" }));
  assert.match(view.text(), /Second pending scope/);
  assert.match(plain(view.list()), /Q1: First pending scope/);
  assert.match(plain(view.list()), /Q2: Second pending scope/);
  await h.input("Q1: not now");
  assert.equal(view.reminderVisible(), false, "all remaining pending questions are visible");
  const staleWidget = view.list();
  view.chat.clear();
  view.chat.addChild(new Text("Q2: Second pending scope?", 0, 0));
  assert.equal(view.reminderVisible(), true, "an arbitrary matching row cannot hide a question");
  const mismatched = new ToolExecutionComponent("ask_user", "unrelated-call", { question: "Second pending scope?" }, { showImages: false }, h.tool, view.tui, scratch);
  const secondSnapshot = h.records().find(record => record.id === 2);
  mismatched.updateResult({ content: [{ type: "text", text: "" }], details: { status: "pending", question: secondSnapshot } });
  view.chat.clear(); view.chat.addChild(mismatched);
  assert.equal(view.reminderVisible(), true, "a result snapshot attached to a different native call has no identity");
  h.ctx.sessionManager = SessionManager.inMemory(scratch);
  await h.emit("session_start");
  await h.ask({ question: "First pending scope?" }); // same ID, words and call shape in another session
  view.chat.clear(); view.chat.addChild(oldCard);
  assert.equal(view.reminderVisible(), true, "an old session card cannot hide a new question");
  view.click(/Q1: First pending scope/);
  assert.equal(h.dialogs.length, 0, "old session card cannot open a new scope");
  assert.equal(staleWidget?.handleMouse({ type: "click", button: "left", x: 3, y: 1 }), undefined);
  await h.emit("session_shutdown");
  assert.equal(view.reminderVisible(), false);
});

test("native prose visibility uses current entry message identity, never arbitrary matching transcript text", async () => {
  const h = await harness();
  const view = nativeQuestionView(h, { rows: 24, width: 50 });
  const { AssistantMessageComponent } = await fromPi("dist/modes/interactive/components/assistant-message.js");
  const msg = assistant("Q3: First prose question with words wrapping across several rows?\n\nQ4: Second prose question?");
  await h.message(msg);
  const native = new AssistantMessageComponent(msg);
  view.chat.addChild(native);
  assert.equal(view.reminderVisible(), false, "both entry-identified prose question texts are visible");
  for (const id of [3, 4]) {
    assert.equal(view.click(new RegExp(`Q${id}:`))?.handled, true, "visible prose retains a native transcript entry point");
    assert.match(plain(h.current().component), new RegExp(`Q${id} ·`));
    assert.equal(view.editor.getValue(), "Unsent ordinary draft");
    assert.equal(view.editor.focused, true);
    h.current().component.handleInput("\x1b");
    await new Promise(resolve => setImmediate(resolve));
  }
  view.chat.addChild(new Text("tail\n".repeat(40), 0, 0));
  assert.equal(view.reminderVisible(), true);
  view.transcript.scrollTo(0, { disableFollow: true });
  assert.equal(view.reminderVisible(), false);
  view.chat.clear();
  view.chat.addChild(new Text("Q3: First prose question with words wrapping across several rows?\n\nQ4: Second prose question?", 0, 0));
  assert.equal(view.reminderVisible(), true, "text-only coincidences cannot supply native entry identity");
  view.chat.clear();
  view.chat.addChild(new AssistantMessageComponent(structuredClone(msg)));
  assert.equal(view.reminderVisible(), true, "even a same-text assistant from outside this branch cannot prove visibility");
  assert.equal(h.dialogs.length, 2);
  assert.equal(h.sent.length, 0);
});

test("one pending question with many historical native cards has linear per-frame render counts", async t => {
  const samples = [];
  for (const count of [20, 50]) {
    const h = await harness();
    const view = nativeQuestionView(h);
    const history = [];
    for (let i = 1; i <= count; i++) {
      history.push(await h.ask({ question: `Historical question ${i}?` }));
      await h.input(`Q${i}: already handled`);
    }
    const pending = await h.ask({ question: "The only pending question?" });
    const cards = [...history, pending].map(result => view.add(result));
    view.frame();
    let renders = 0;
    for (const card of cards) {
      const render = card.render;
      card.render = function(width) { renders++; return render.call(this, width); };
    }
    const frame = view.frame();
    assert.equal(view.list().render(view.tui.terminal.columns).length, 0, "visible pending question removes all reminder rows");
    assert.doesNotMatch(frame.lines.map(stripTerminalSequences).join("\n"), /Questions ·/);
    samples.push(renders);
    assert.ok(renders <= 12 * cards.length, `${count} historical cards: ${renders} native renders, bounded passes not per-card rescans`);
    await h.emit("session_shutdown");
  }
  assert.ok(samples[1] < samples[0] * 3, `render work scales linearly: ${samples.join(" -> ")}`);
  t.diagnostic(`20/50 historical cards, one pending: ${samples.join(" / ")} native renders per frame`);
});

test("native prose adapters preserve links, selection and existing handlers; refresh and shutdown restore ownership", async t => {
  const capabilities = getCapabilities();
  setCapabilities({ ...capabilities, hyperlinks: true });
  t.after(() => setCapabilities(capabilities));
  const h = await harness();
  const view = nativeQuestionView(h, { rows: 30, width: 90 });
  const { AssistantMessageComponent } = await fromPi("dist/modes/interactive/components/assistant-message.js");
  const msg = assistant("Ordinary prose above the question.\n\nQ1: Is https://example.com the correct endpoint?");
  await h.message(msg);
  const native = new AssistantMessageComponent(msg);
  const inherited = native.handleMouse;
  let nativeCalls = 0;
  const original = function(event) {
    nativeCalls++;
    if (event.alt) return { handled: true };
    return inherited.call(this, event);
  };
  native.handleMouse = original;
  const descriptor = Object.getOwnPropertyDescriptor(native, "handleMouse");
  view.chat.addChild(native);
  assert.equal(view.reminderVisible(), false);
  assert.notEqual(native.handleMouse, original);
  const lines = native.render(90);
  const y = lines.map(stripTerminalSequences).findIndex(line => /Q1:/.test(line));
  const event = { type: "click", button: "left", x: 3, y, width: 90, height: lines.length };
  for (const type of ["press", "drag", "release", "wheel"]) assert.equal(native.handleMouse({ ...event, type }), undefined, `${type} remains available to native selection/scrolling`);
  assert.equal(native.handleMouse({ ...event, button: "right" }), undefined);
  for (const modifier of ["shift", "ctrl"]) assert.equal(native.handleMouse({ ...event, [modifier]: true }), undefined, "modified question clicks retain native selection behavior");
  assert.equal(native.handleMouse({ ...event, y: y - 2 }), undefined, "ordinary prose does not become a question target");
  assert.equal(native.handleMouse({ ...event, alt: true })?.handled, true, "existing native handlers win");
  const linkX = Array.from({ length: 90 }, (_, x) => x).find(x => getOsc8LinkAtColumn(lines[y], x));
  assert.notEqual(linkX, undefined, "actual native Markdown emitted an OSC8 link on the question row");
  assert.equal(native.handleMouse({ ...event, x: linkX }), undefined, "question clicks never intercept hyperlink cells");
  assert.equal(h.dialogs.length, 0);
  assert.ok(nativeCalls >= 8);
  assert.equal(view.click(/Q1:/)?.handled, true);
  h.current().component.handleInput("\x1b");
  await new Promise(resolve => setImmediate(resolve));
  const stale = native.handleMouse;
  await h.emit("session_tree");
  assert.deepEqual(Object.getOwnPropertyDescriptor(native, "handleMouse"), descriptor, "refresh restores the exact original property");
  assert.equal(stale.call(native, event), undefined, "retained callbacks from the disposed adapter cannot reopen questions");
  view.frame();
  assert.notEqual(native.handleMouse, original);
  view.tui.mode = "regular"; view.frame();
  assert.equal(native.handleMouse, original, "leaving fullscreen removes prose mouse routing");
  view.tui.mode = "fullscreen"; view.frame();
  const replacement = function() { return { handled: true }; };
  native.handleMouse = replacement;
  assert.equal(view.reminderVisible(), true, "a handler replaced by another extension cannot justify hiding the reminder");
  assert.equal(native.handleMouse, replacement, "cleanup never overwrites another owner's handler");
  native.handleMouse = original; view.frame();
  const shutdownCallback = native.handleMouse;
  await h.emit("session_shutdown");
  assert.equal(native.handleMouse, original);
  assert.equal(shutdownCallback.call(native, event), undefined);
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.sent.length, 0);
});

test("native prose answer submission retires click targets without duplicating delivery", async () => {
  const h = await harness();
  const view = nativeQuestionView(h, { rows: 30 });
  const { AssistantMessageComponent } = await fromPi("dist/modes/interactive/components/assistant-message.js");
  const msg = assistant("Q1: First pending prose question?\n\nQ2: Second pending prose question?");
  await h.message(msg);
  const native = new AssistantMessageComponent(msg);
  const original = native.handleMouse;
  view.chat.addChild(native);
  assert.equal(view.reminderVisible(), false);
  view.frame(28, 30);
  assert.equal(view.click(/Q2:/)?.handled, true, "resize keeps the second question's native row bound to Q2");
  assert.match(plain(h.current().component), /Q2 ·/);
  const stale = native.handleMouse;
  h.submitCustom("Keep the existing scope");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(native.handleMouse, original, "answer refresh removes old targets immediately");
  assert.equal(h.latest().id, 2);
  assert.equal(h.latest().status, "answered");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].content, /Answer to Q2/);
  const event = { type: "click", button: "left", x: 3, y: 1, width: 28, height: 8 };
  assert.equal(stale.call(native, event), undefined);
  assert.equal(view.click(/Q2:/), undefined, "answered prose is no longer an answer target");
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(view.editor.getValue(), "Unsent ordinary draft");
  await h.emit("session_shutdown");
});

test("native prose click callbacks reject replaced sessions before lifecycle reconstruction", async () => {
  const h = await harness();
  const view = nativeQuestionView(h);
  const { AssistantMessageComponent } = await fromPi("dist/modes/interactive/components/assistant-message.js");
  const msg = assistant("Q1: Same words do not identify a session?");
  await h.message(msg);
  const native = new AssistantMessageComponent(msg);
  const original = native.handleMouse;
  view.chat.addChild(native); view.frame();
  const lines = native.render(80).map(stripTerminalSequences);
  const event = { type: "click", button: "left", x: 3, y: lines.findIndex(line => /Q1:/.test(line)), width: 80, height: lines.length };
  h.ctx.sessionManager = SessionManager.inMemory(scratch);
  assert.equal(native.handleMouse(event), undefined);
  assert.equal(h.dialogs.length, 0);
  await h.emit("session_start");
  assert.equal(native.handleMouse, original);
  assert.equal(h.sent.length, 0);
});

test("regular/unsupported layouts keep the reminder; pin and other input widgets preserve stable native boundaries", async () => {
  const h = await harness({ pin: true });
  const view = nativeQuestionView(h, { rows: 24 });
  const { UserMessageComponent } = await fromPi("dist/modes/interactive/components/user-message.js");
  await h.message(user("Pinned prompt before question"));
  view.chat.addChild(new UserMessageComponent("Pinned prompt before question"));
  view.chat.addChild(new Text("between\n".repeat(25), 0, 0));
  view.add(await h.ask({ question: "Question near the bottom?" }));
  view.pendingMessages.addChild(new Text("queued input", 0, 0));
  const extra = new Text("Other extension widget", 0, 0);
  h.widgets.set("unrelated", { factory: () => extra });
  for (const height of [14, 24, 40, 18]) {
    view.frame(64, height);
    const seen = [];
    for (let i = 0; i < 8; i++) seen.push(view.frame().lines.map(stripTerminalSequences).join("\n"));
    assert.ok(seen.every(text => text === seen[0]), "pin/list decisions converge in the same frame, not alternating frames");
    assert.match(seen[0], /Unsent ordinary draft/);
    assert.match(seen[0], /Other extension widget/);
    assert.match(seen[0], /queued input/);
  }
  view.frame(64, 18);
  const contentHeight = view.document.render(64).length;
  for (let top = 0; top <= contentHeight; top++) {
    view.transcript.scrollTo(top, { disableFollow: true });
    const expected = view.text();
    for (let repeat = 0; repeat < 4; repeat++) assert.equal(view.text(), expected, `pin/list boundary at scroll row ${top} is stable`);
  }
  view.tui.mode = "regular";
  assert.match(plain(view.list(), 64), /Q1: Question near the bottom/);
  view.tui.mode = "fullscreen";
  const originalGap = view.root.gap; view.root.gap = 1;
  assert.match(plain(view.list(), 64), /Q1: Question near the bottom/, "unknown layout is conservative");
  view.root.gap = originalGap;
  assert.equal(h.sent.length, 0);
  assert.equal(h.dialogs.length, 0);
  await h.emit("session_shutdown");
});

test("invalid recommendation/reuse and manual UI rejection safely leave actionable unanswered results", async () => {
  const h = await harness();
  for (const args of [
    { question: "Choose?", options: [], recommended_option: 1 },
    { question: "Choose?", rationale: "Unattached recommendation" },
  ]) {
    const invalid = await h.ask(args);
    assert.equal(invalid.details.status, "error");
    assert.match(plain(h.tool.renderResult(invalid, { expanded: false }, themes.theme)), /Not answered \(error\)/, "error status remains visible despite removing the pending status row");
  }
  assert.equal(h.records().length, 0);
  h.ctx.ui.custom = () => Promise.reject(new Error("terminal is closing"));
  const result = await h.ask();
  assert.equal(result.details.status, "pending");
  await h.command();
  assert.equal((h.widget().match(/Q\d+:/g) ?? []).length, 1);
  assert.equal(h.sent.length, 0);
});
