import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const requirePi = createRequire(join(root, "package.json"));
const fromPi = path => import(pathToFileURL(join(root, path)).href);
const { Container, Text, TuiAltScreen, backgroundAnsi, stripTerminalSequences } = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
const { AssistantMessageComponent } = await fromPi("dist/modes/interactive/components/assistant-message.js");
const { createChatViewport } = await fromPi("dist/modes/interactive/chat-viewport.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
themes.initTheme("dark", false);
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
  "@earendil-works/pi-tui": requirePi.resolve("@earendil-works/pi-tui"),
} });
const source = path => jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src", path));
const { questionListVisibility } = await source("questions/question-viewport.ts");
const { questionPalette } = await source("questions/question-palette.ts");

function fixture(choices, native = false) {
  const question = "How should I respond to Daniel's comment?";
  const message = { role: "assistant", content: [{ type: "text", text: `Ordinary context.\n\nQ5: ${question}\n${choices.join("\n")}\n\nOrdinary conclusion.` }], stopReason: "stop" };
  const component = new AssistantMessageComponent(message);
  const original = component.render;
  const chat = new Container(); chat.addChild(component);
  const document = new Container(); document.addChild(new Container()); document.addChild(new Container()); document.addChild(chat);
  const viewport = createChatViewport({ document, pendingMessages: new Container(), status: new Container(), widgetsAbove: new Container(), editor: new Text("Editor", 0, 0), footer: new Text("Footer", 0, 0), scrollbar: "hidden" });
  const terminal = { columns: 90, rows: 40, kittyProtocolActive: false, start(input) { this.input = input; }, stop() {}, write() {}, hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
  const tui = native ? new TuiAltScreen(terminal, true)
    : { mode: "fullscreen", children: [document], layoutRoot: viewport.root, terminal, requestRender() {} };
  if (native) { tui.addChild(document); tui.setLayoutRoot(viewport.root); }
  const identity = {};
  let opened = 0;
  const show = questionListVisibility(tui, [identity], () => [{ message, questions: [{ identity, id: 5, question, choices }] }], () => { opened++; return true; }, () => themes.theme);
  return { component, original, show, tui, viewport, opened: () => opened };
}

const choices = [
  "- A (**my recommendation**): keep the behaviour, fix the wording, and draft a reply for approval.",
  "- B: apply the fix to START only, leaving activation unchanged.",
  "- C: apply the fix to both START and ACTIVATE.",
];

test("screenshot prose choices form one amber clickable block without changing native geometry", () => {
  const f = fixture(choices);
  try {
    for (const width of [90, 42, 26]) {
      assert.equal(f.show(width), false);
      const rows = f.component.render(width);
      assert.deepEqual(rows.map(stripTerminalSequences), f.original.call(f.component, width).map(stripTerminalSequences));
      const amber = backgroundAnsi(questionPalette(themes.theme).question, themes.theme.getColorMode());
      const start = rows.findIndex(line => stripTerminalSequences(line).includes("Q5:"));
      const end = rows.findIndex(line => stripTerminalSequences(line).includes("ACTIVATE."));
      assert.ok(start >= 0 && end > start);
      for (let y = start; y <= end; y++) {
        assert.ok(rows[y].includes(amber), `choice block row ${y} at ${width} columns has the question background`);
        assert.equal(f.component.handleMouse({ type: "click", button: "left", x: 3, y, width, height: rows.length })?.handled, true);
      }
      for (const label of ["Ordinary context.", "Ordinary conclusion."]) {
        const y = rows.findIndex(line => stripTerminalSequences(line).includes(label));
        assert.ok(y >= 0);
        assert.equal(rows[y].includes(amber), false);
        assert.equal(f.component.handleMouse({ type: "click", button: "left", x: 3, y, width, height: rows.length }), undefined);
      }
    }
    assert.ok(f.opened() > 3);
    f.tui.mode = "regular";
    assert.equal(f.show(90), true);
    assert.equal(f.component.render, f.original);
  } finally { f.show.dispose(); }
});

test("numbered prose choices keep their native numbering in the clickable block", () => {
  const f = fixture(["1. Keep the existing behaviour.", "2. Apply the proposed fix."]);
  try {
    assert.equal(f.show(90), false);
    const rows = f.component.render(90);
    const amber = backgroundAnsi(questionPalette(themes.theme).question, themes.theme.getColorMode());
    for (const label of ["1. Keep", "2. Apply"]) {
      const y = rows.findIndex(line => stripTerminalSequences(line).includes(label));
      assert.ok(y > 0);
      assert.ok(rows[y].includes(amber));
      assert.equal(f.component.handleMouse({ type: "click", button: "left", x: 3, y, width: 90, height: rows.length })?.handled, true);
    }
  } finally { f.show.dispose(); }
});

test("real terminal press and release opens the heading and each prose choice", () => {
  const f = fixture(choices, true);
  try {
    f.tui.start();
    assert.equal(f.show(90), false);
    f.tui.renderNow();
    const screen = f.tui.getScreenLines().map(stripTerminalSequences);
    for (const pattern of [/Q5:/, /A \(my recommendation\)/, /B: apply/, /C: apply/]) {
      const y = screen.findIndex(line => pattern.test(line));
      assert.ok(y >= 0, `screen contains ${pattern}`);
      const before = f.opened();
      f.tui.terminal.input(`\x1b[<0;4;${y + 1}M`);
      f.tui.terminal.input(`\x1b[<0;4;${y + 1}m`);
      assert.equal(f.opened(), before + 1, `native mouse gesture opens ${pattern}`);
    }
  } finally { f.tui.stop(); f.show.dispose(); }
});

test("choice-only visibility does not hide the question reminder", () => {
  const f = fixture(choices);
  try {
    assert.equal(f.show(42), false);
    const rows = f.component.render(42);
    const firstChoice = rows.findIndex(line => /^\s*[-•] A/.test(stripTerminalSequences(line)));
    assert.ok(firstChoice > 0);
    f.tui.terminal.rows = 7;
    f.viewport.transcript.scrollTo(firstChoice, { disableFollow: true });
    assert.equal(f.show(42), true, "visible choices cannot substitute for question wording");
  } finally { f.show.dispose(); }
});

test("mismatched choice source never colors or binds unrelated following prose", () => {
  const sourceChoices = [...choices];
  const f = fixture(sourceChoices);
  sourceChoices[1] = "- B: Different wording that is not in this message.";
  try {
    assert.equal(f.show(90), false, "the exact question heading is still usable");
    const rows = f.component.render(90);
    const amber = backgroundAnsi(questionPalette(themes.theme).question, themes.theme.getColorMode());
    const y = rows.findIndex(line => stripTerminalSequences(line).includes("START only"));
    assert.ok(y > 0);
    assert.equal(rows[y].includes(amber), false, "a partial match cannot claim any of the choices");
    assert.equal(f.component.handleMouse({ type: "click", button: "left", x: 3, y, width: 90, height: rows.length }), undefined);
  } finally { f.show.dispose(); }
});
