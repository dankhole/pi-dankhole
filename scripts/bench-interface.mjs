import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

// Synthetic synchronous CPU timings, not end-to-end terminal/input latency.
// Point DANKHOLE_BENCH_ROOT at a source snapshot for an identical before/after run.
const source = process.env.DANKHOLE_BENCH_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const requirePi = createRequire(join(host, "package.json"));
const { createJiti } = requirePi("jiti");
const tuiPath = requirePi.resolve("@earendil-works/pi-tui");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(host, "dist/index.js"),
  "@earendil-works/pi-tui": tuiPath,
} });
const fromPi = path => import(pathToFileURL(join(host, path)).href);
const local = name => jiti.import(join(source, "src/styling", name));
const { installAssistantPanels } = await local("assistant-panels.ts");
const { installPinnedPrompt } = await local("pinned-prompt.ts");
const { registerTextPanels } = await local("text-panels.ts");
const { Container, Text } = await import(pathToFileURL(tuiPath).href);
const { renderLayoutFrame } = await import(pathToFileURL(join(dirname(tuiPath), "layout.js")).href);
const { createChatViewport } = await fromPi("dist/modes/interactive/chat-viewport.js");
const { AssistantMessageComponent } = await fromPi("dist/modes/interactive/components/assistant-message.js");
const { UserMessageComponent } = await fromPi("dist/modes/interactive/components/user-message.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
themes.initTheme("dark", false);

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

function fixture(count, unicode, panels, pin) {
  const chat = new Container();
  const prompt = "Compare a long conversation without changing its contents";
  chat.addChild(new UserMessageComponent(prompt));
  const prose = unicode ? "Unicode 界 😀 é — streaming and scrolling preserve terminal columns. " : "Stable history should not be decorated again during ordinary input. ";
  for (let index = 0; index < count; index++) {
    chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: `${index}: ${prose.repeat(8)}` }], stopReason: "stop" }));
  }
  const document = new Container();
  document.addChild(new Container()); document.addChild(new Container()); document.addChild(chat);
  const editor = new Container(); editor.addChild(new Text("Synthetic input", 0, 0));
  const viewport = createChatViewport({ document, pendingMessages: new Container(), status: new Container(),
    widgetsAbove: new Container(), editor, widgetsBelow: new Container(), footer: new Container(), scrollbar: "hidden" });
  const tui = { children: [document], layoutRoot: viewport.root, mode: "fullscreen", requestRender() {} };
  const disposePanels = panels ? installAssistantPanels(tui, { theme: () => themes.theme, requestRender() {}, warn: message => { throw new Error(message); } }) : undefined;
  const pinned = pin ? installPinnedPrompt(tui, () => themes.theme, () => ({ text: prompt, displayed: true, id: "prompt", rows: [{ id: "prompt", kind: "UserMessageComponent" }] }), message => { throw new Error(message); }, panels) : undefined;
  return { render: () => renderLayoutFrame(viewport.root, 120, 40, () => {}), dispose() { pinned?.dispose(); disposePanels?.(); } };
}

console.log(JSON.stringify({ source, host, node: process.version, width: 120, height: 40, warmups: 5, samples: 15 }));
const handlers = new Map();
let transform;
registerTextPanels({ on(name, handler) { handlers.set(name, handler); }, registerMarkdownTransformer(handler) { transform = handler; } }, true);
handlers.get("session_start")({}, { mode: "tui", ui: { get theme() { return themes.theme; } } });
for (const bytes of [10000, 100000]) {
  const markdown = "```text\n" + "literal ASCII text with punctuation <> & * _ ` and whitespace    \n".repeat(Math.ceil(bytes / 64)).slice(0, bytes) + "\n```";
  console.log(JSON.stringify({ transformBytes: bytes, ...measure(() => transform(markdown, { messageType: "assistant", isStreaming: false, availableWidth: 120 })) }));
}
handlers.get("session_shutdown")();
for (const count of [100, 500]) for (const unicode of [false, true]) for (const mode of ["native", "panels", "panels+pin"]) {
  const view = fixture(count, unicode, mode !== "native", mode === "panels+pin");
  try {
    console.log(JSON.stringify({ messages: count, text: unicode ? "unicode" : "ascii", mode, ...measure(view.render) }));
  } finally { view.dispose(); }
}
