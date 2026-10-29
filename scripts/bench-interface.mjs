import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

// Synthetic synchronous elapsed timings, NOT live process CPU or input latency.
// No Pi CLI/session, real terminal, provider, MCP, watcher or OS helper is started.
// Use this SAME harness with DANKHOLE_BENCH_ROOT selecting each source snapshot.
const source = realpathSync(process.env.DANKHOLE_BENCH_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
if (!process.env.PI_PACKAGE_DIR) throw new Error("Set PI_PACKAGE_DIR explicitly to the Pi package root; see docs/pi-live-measurement.md.");
const host = realpathSync(resolve(process.env.PI_PACKAGE_DIR));
const requirePi = createRequire(join(host, "package.json"));
const { createJiti } = requirePi("jiti");
const tuiPath = requirePi.resolve("@earendil-works/pi-tui");
const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
  "@earendil-works/pi-coding-agent": join(host, "dist/index.js"),
  "@earendil-works/pi-tui": tuiPath,
} });
const fromPi = path => import(pathToFileURL(join(host, path)).href);
const local = name => jiti.import(join(source, "src/styling", name));
const { installAssistantPanels } = await local("assistant-panels.ts");
const { installPinnedPrompt } = await local("pinned-prompt.ts");
const { installGrouping } = await local("grouping.ts");
const { registerTextPanels } = await local("text-panels.ts");
const { CompletionCards } = await jiti.import(join(source, "src/workers/ui/completion-card.ts"));
const { isTranscriptRendererSupported, registerTranscriptRenderer } = await local("transcript-measurement.ts");
const { QUESTION_CONTENT, questionListVisibility } = await jiti.import(join(source, "src/questions/question-viewport.ts"));
const { Container, Text, TuiAltScreen } = await import(pathToFileURL(tuiPath).href);
const { renderLayoutFrame } = await import(pathToFileURL(join(dirname(tuiPath), "layout.js")).href);
const { createChatViewport } = await fromPi("dist/modes/interactive/chat-viewport.js");
const { AssistantMessageComponent } = await fromPi("dist/modes/interactive/components/assistant-message.js");
const { UserMessageComponent } = await fromPi("dist/modes/interactive/components/user-message.js");
const { CustomMessageComponent } = await fromPi("dist/modes/interactive/components/custom-message.js");
const { ToolExecutionComponent } = await fromPi("dist/modes/interactive/components/tool-execution.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
themes.setThemeInstance(themes.getThemeByName("dark")); // Built-in, in-memory; no configuration/watcher.

function measure(render, samples = 15) {
  for (let index = 0; index < 5; index++) render();
  const times = [];
  for (let index = 0; index < samples; index++) {
    const start = performance.now();
    render();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { medianMs: Number(times[Math.floor(times.length / 2)].toFixed(3)), p95Ms: Number(times[Math.ceil(times.length * .95) - 1].toFixed(3)) };
}

function notificationDetails(index) {
  return {
    id: `worker-${index}`, description: `Review worker lifecycle ${index}`, status: "completed",
    toolUses: 12, turnCount: 3, totalTokens: 12000, totalCost: 0.25, durationMs: 65000,
    invocation: { modelName: "Synthetic model", thinking: "high" },
    resultPreview: "**Verified** notification delivery and cancellation. Unicode 認証 👩‍💻 é remains intact.\n\nNo live calls were made.",
  };
}

function fixture(count, unicode, panels, pin, grouping = false, completions = 0) {
  const chat = new Container();
  const prompt = "Compare a long conversation without changing its contents";
  chat.addChild(new UserMessageComponent(prompt));
  const prose = unicode ? "Unicode 界 😀 é — streaming and scrolling preserve terminal columns. " : "Stable history should not be decorated again during ordinary input. ";
  for (let index = 0; index < count; index++) {
    chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: `${index}: ${prose.repeat(8)}` }], stopReason: "stop" }));
  }
  for (let index = 0; index < completions; index++) {
    chat.addChild(new CustomMessageComponent({
      role: "custom", customType: "subagent-notification", display: true, timestamp: 0,
      content: "Synthetic completion", details: notificationDetails(index),
    }, (message, { expanded }, theme) => new CompletionCards(message.details, expanded, theme, true)));
  }
  const document = new Container();
  document.addChild(new Container()); document.addChild(new Container()); document.addChild(chat);
  const editor = new Container(); editor.addChild(new Text("Synthetic input", 0, 0));
  const viewport = createChatViewport({ document, pendingMessages: new Container(), status: new Container(),
    widgetsAbove: new Container(), editor, widgetsBelow: new Container(), footer: new Container(), scrollbar: "hidden" });
  const tui = { children: [document], layoutRoot: viewport.root, mode: "fullscreen", requestRender() {} };
  const disposeGrouping = installGrouping(tui, { groupConsecutive: grouping, defaultMode: "compact", tools: {}, backgrounds: "tool" },
    { theme: () => themes.theme, requestRender() {}, warn: message => { throw new Error(message); } });
  const disposePanels = panels ? installAssistantPanels(tui, { theme: () => themes.theme, requestRender() {}, warn: message => { throw new Error(message); } }) : undefined;
  const pinned = pin ? installPinnedPrompt(tui, () => themes.theme, () => ({ text: prompt, displayed: true, id: "prompt", rows: [{ id: "prompt", kind: "UserMessageComponent" }] }), message => { throw new Error(message); }, panels) : undefined;
  return { render: () => renderLayoutFrame(viewport.root, 120, 40, () => {}), dispose() { pinned?.dispose(); disposePanels?.(); disposeGrouping(); } };
}

/** Real Pi 1.4 doRender path, but NEVER start a terminal/session or load extensions.
 * Installers retain their guarded instance adapter themselves; baseline source
 * has no such adapter. Do not bracket renderLayoutFrame here: that would bypass
 * the production guard and could make an unwired implementation look faster.
 */
function sharedQuestionFrame(messages, pin, reminder) {
  const counts = { assistantRenders: 0, completionRenders: 0, questionRenders: 0, toolRenders: 0,
    questionBodyRenders: 0, metadataReads: 0, promptReads: 0, reminderRenders: 0, terminalWrites: 0, terminalBytes: 0 };
  const disposers = [];
  const observe = (component, key) => {
    assert.ok(isTranscriptRendererSupported(component), `Unsupported native fixture: ${component.constructor.name}`);
    const render = component.render;
    component.render = function(width) { counts[key]++; return render.call(this, width); };
    disposers.push(registerTranscriptRenderer(component, component.render));
    return component;
  };
  const chat = new Container();
  const prompt = "Compare shared pin and pending-question geometry";
  chat.addChild(new UserMessageComponent(prompt));
  const pending = { toolCallId: "question-0" };
  const questionCount = 20;
  const questionDefinition = {
    renderShell: "self", renderCall: () => new Text("Ask user", 0, 0),
    renderResult: (_result, _options, _theme, context) => {
      const text = new Text(`Q: Synthetic question ${context.toolCallId}?\n1. Keep the captured result.`, 0, 0);
      return {
        invalidate() { text.invalidate(); },
        render(width) { counts.questionBodyRenders++; return text.render(width); },
        [QUESTION_CONTENT]() {
          counts.metadataReads++;
          return context.toolCallId === pending.toolCallId ? { identity: pending, rows: [0] } : undefined;
        },
      };
    },
  };
  const addTool = (name, id, definition, key) => {
    const tool = new ToolExecutionComponent(name, id, {}, { showImages: false }, definition, { requestRender() {} }, source);
    tool.updateResult({ content: [{ type: "text", text: "Synthetic result" }], details: undefined, isError: false });
    chat.addChild(observe(tool, key));
  };
  for (let index = 0; index < messages; index++) {
    if (index % (messages / questionCount) === 0) addTool("ask_user", `question-${index / (messages / questionCount)}`, questionDefinition, "questionRenders");
    if (index % 100 === 0) for (const part of [0, 1]) addTool("bash", `group-${index}-${part}`, undefined, "toolRenders");
    chat.addChild(observe(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text",
      text: `${index}: Unicode 界 😀 é — stable history and pending questions. `.repeat(8) }], stopReason: "stop" }), "assistantRenders"));
  }
  for (let index = 0; index < 17; index++) {
    chat.addChild(observe(new CustomMessageComponent({ role: "custom", customType: "subagent-notification", display: true,
      timestamp: 0, content: "Synthetic completion", details: notificationDetails(index),
    }, (message, { expanded }, theme) => new CompletionCards(message.details, expanded, theme, true)), "completionRenders"));
  }
  const document = new Container();
  const header = new Container(); header.addChild(new Text("Synthetic native header", 0, 0));
  document.addChild(header); document.addChild(new Container()); document.addChild(chat);
  const status = new Text("Synthetic idle redraw 0", 0, 0);
  const widgetsAbove = new Container();
  const viewport = createChatViewport({ document, pendingMessages: new Container(), status, widgetsAbove,
    editor: new Text("Synthetic input", 0, 0), widgetsBelow: new Container(), footer: new Text("Synthetic native footer", 0, 0), scrollbar: "hidden" });
  const terminal = { columns: 120, rows: 40,
    write(buffer) { counts.terminalWrites++; counts.terminalBytes += Buffer.byteLength(buffer); }, hideCursor() {},
  };
  const tui = new TuiAltScreen(terminal);
  // Direct synchronous paints only. No start(), stdin, process hooks, timers,
  // terminal escapes, capability queries, logging, providers or global config.
  tui.requestRender = () => {};
  tui.addChild(document);
  tui.setLayoutRoot(viewport.root);
  tui.altScreenActive = true; // Enable native paint into the in-memory sink only.
  const nativeDoRender = tui.doRender;
  const warn = message => { throw new Error(message); };
  const ungroup = installGrouping(tui, { groupConsecutive: true, defaultMode: "compact", tools: {}, backgrounds: "tool" },
    { theme: () => themes.theme, requestRender() {}, warn });
  const unpanel = installAssistantPanels(tui, { theme: () => themes.theme, requestRender() {}, warn });
  const pinned = pin ? installPinnedPrompt(tui, () => themes.theme, () => {
    counts.promptReads++;
    return { text: prompt, displayed: true, id: "prompt", rows: [{ id: "prompt", kind: "UserMessageComponent" }] };
  }, warn) : undefined;
  if (pin) assert.ok(pinned, "Pinned prompt must install on the declared host");
  const visible = reminder ? questionListVisibility(tui, [pending]) : undefined;
  if (visible) widgetsAbove.addChild({ invalidate() {}, render(width) {
    counts.reminderRenders++;
    return visible(width) ? ["One synthetic question pending"] : [];
  } });
  let tick = 0;
  return {
    frameAdapter: tui.doRender !== nativeDoRender ? "guarded-instance" : "native-unadapted",
    render() { status.setText(`Synthetic idle redraw ${tick++ % 2}`); tui.doRender(); },
    observation() {
      for (const key of Object.keys(counts)) counts[key] = 0;
      this.render();
      assert.equal(counts.terminalWrites, 1, "Each sample must paint through native doRender");
      const screen = tui.getScreenLines();
      assert.equal(screen.length, 40);
      if (pin) assert.ok(screen.some(line => line.includes("↑ You:")), "Pinned prompt must be displayed");
      if (reminder) assert.ok(screen.some(line => line.includes("One synthetic question pending")), "Off-screen pending question must retain its reminder");
      return { operations: { ...counts }, screenSha256: sha256(screen.join("\n")),
        viewportHeight: viewport.transcript.viewportHeight, followEnd: viewport.transcript.isFollowingEnd };
    },
    dispose() { visible?.dispose(); pinned?.dispose(); unpanel(); ungroup(); for (const dispose of disposers) dispose(); tui.altScreenActive = false; },
  };
}

const sha256 = value => createHash("sha256").update(value).digest("hex");
const sourceFiles = ["styling/assistant-panels.ts", "styling/grouping.ts", "styling/pinned-prompt.ts", "styling/text-panels.ts",
  "styling/transcript-measurement.ts", "questions/question-viewport.ts", "workers/ui/completion-card.ts"];
console.log(JSON.stringify({ source, host, piVersion: JSON.parse(readFileSync(join(host, "package.json"), "utf8")).version,
  tuiVersion: JSON.parse(readFileSync(join(dirname(tuiPath), "../package.json"), "utf8")).version,
  node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch,
  theme: "dark", colorMode: themes.theme.getColorMode(), width: 120, height: 40, warmups: 5, samples: 15,
  harnessSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  sourceFiles: Object.fromEntries(sourceFiles.map(name => [name, sha256(readFileSync(join(source, "src", name)))])),
}));
// The incident had 17 settled cards in history. Keep their instances alive, as
// Pi's CustomMessageComponent does between expansion/theme invalidations.
for (const count of [1, 17]) {
  const cards = Array.from({ length: count }, (_, index) => new CompletionCards(notificationDetails(index), false, themes.theme, true));
  console.log(JSON.stringify({ completionCards: count, ...measure(() => {
    for (const card of cards) card.render(120);
  }) }));
}
const completionFrame = fixture(500, true, true, true, true, 17);
try {
  console.log(JSON.stringify({ messages: 500, completionCards: 17, text: "unicode", mode: "panels+grouping+pin", ...measure(completionFrame.render) }));
} finally { completionFrame.dispose(); }
const handlers = new Map();
let transform;
registerTextPanels({ on(name, handler) { handlers.set(name, handler); }, registerMarkdownTransformer(handler) { transform = handler; } }, true);
handlers.get("session_start")({}, { mode: "tui", ui: { get theme() { return themes.theme; } } });
for (const bytes of [10000, 100000]) {
  const markdown = "```text\n" + "literal ASCII text with punctuation <> & * _ ` and whitespace    \n".repeat(Math.ceil(bytes / 64)).slice(0, bytes) + "\n```";
  console.log(JSON.stringify({ transformBytes: bytes, ...measure(() => transform(markdown, { messageType: "assistant", isStreaming: false, availableWidth: 120 })) }));
}
handlers.get("session_shutdown")();
for (const count of [100, 500]) for (const unicode of [false, true]) for (const mode of ["native", "panels", "panels+pin", "panels+grouping+pin"]) {
  const view = fixture(count, unicode, mode !== "native", mode.endsWith("+pin"), mode.includes("grouping"));
  try {
    console.log(JSON.stringify({ messages: count, text: unicode ? "unicode" : "ascii", mode, ...measure(view.render) }));
  } finally { view.dispose(); }
}
// Additional rows; legacy card/transform/layout workloads above remain intact.
for (const messages of [100, 500]) for (const pin of [false, true]) for (const reminder of [false, true]) {
  const view = sharedQuestionFrame(messages, pin, reminder);
  try {
    const timing = measure(() => view.render());
    console.log(JSON.stringify({ workload: "shared-pin-question-frame", driver: "TuiAltScreen.doRender", messages,
      completionCards: 17, questionCards: 20, pendingQuestions: 1, groupedToolPairs: messages / 100,
      text: "unicode", mode: "panels+grouping", pin, reminder, frameAdapter: view.frameAdapter,
      ...timing, ...view.observation() }));
  } finally { view.dispose(); }
}
