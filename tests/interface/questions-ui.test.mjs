import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const requirePi = createRequire(join(root, "package.json"));
const tuiModule = requirePi.resolve("@earendil-works/pi-tui");
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
  "@earendil-works/pi-tui": tuiModule,
} });
const { createQuestionComponent, QuestionComponent, sanitizeQuestionText, QUESTION_UI_LIMITS } = await jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/questions/question-ui.ts"));
const { questionPalette, questionStyle, questionPaint } = await jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/questions/question-palette.ts"));
const { CURSOR_MARKER, Text, Input, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, stripTerminalSequences, backgroundAnsi } = await import(pathToFileURL(tuiModule).href);
const { TuiAltScreen } = await import(pathToFileURL(join(dirname(tuiModule), "tui-alt-screen.js")).href);
const { InteractiveMode } = await import(pathToFileURL(join(root, "dist/modes/interactive/interactive-mode.js")).href);
const { CustomEditor } = await import(pathToFileURL(join(root, "dist/modes/interactive/components/custom-editor.js")).href);
const { KeybindingsManager: HostKeybindingsManager } = await import(pathToFileURL(join(root, "dist/core/keybindings.js")).href);
const themes = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")).href);
const dark = themes.getThemeByName("dark");
const light = themes.getThemeByName("light");
assert.ok(dark); assert.ok(light);
const question = { id: 7, question: "Which target should be used?", options: [
  { label: "First", description: "The first target" }, { label: "Second", description: "The second target" },
], recommended: 1, rationale: "Less disruption." };
const plain = lines => lines.map(stripTerminalSequences);
const roomyQuestion = { id: 42, question: "Fetching origin failed because the SSH connection closed. Local main is ahead of the cached origin/main and contains newer navigation work, while the worktree also contains validated end-of-day audit removal changes. "
  + "Should I merge the latest available local main, resolve any conflicts, and squash the feature changes onto local main without pushing, or pause until remote freshness can be verified? "
  + "The existing build, contracts, shell tests, and desktop browser scenario all pass. I will preserve those changes and the current ordinary editor draft. No remote branch will be updated by this decision.",
  options: [
    { label: "Use local main", description: "Merge the available local main, resolve conflicts, rerun the affected checks, and squash locally. Do not push or assume the cached remote is current." },
    { label: "Restore remote access first", description: "Pause Git changes and restore remote access so origin/main can be fetched and verified before choosing a merge base." },
    { label: "Keep the current branch", description: "Leave the validated feature branch unchanged for now. Report the local and remote freshness uncertainty without merging or squashing." },
  ], recommended: 0, rationale: "Local main contains the newer navigation work and the changes are validated. This is an advisory recommendation only; remote freshness remains unverified and no choice is selected automatically." };

// Decode SGR attributes from the installed compositor's actual ANSI output.
// In particular, padding with SGR 49/default is NOT an opaque filled cell.
function ansiCells(line) {
  const cells = [];
  let bg, fg, bold = false, dim = false, offset = 0;
  const emit = text => {
    for (const char of stripTerminalSequences(text)) {
      for (let i = 0; i < visibleWidth(char); i++) cells.push({ char, bg, fg, bold, dim });
    }
  };
  for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
    emit(line.slice(offset, match.index));
    const values = (match[1] || "0").split(";").map(Number);
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value === 0) { bg = fg = undefined; bold = dim = false; }
      else if (value === 49) bg = undefined;
      else if (value === 39) fg = undefined;
      else if (value === 1) bold = true;
      else if (value === 2) dim = true;
      else if (value === 22) bold = dim = false;
      else if (value === 38 || value === 48) {
        const count = values[i + 1] === 2 ? 4 : 2;
        const color = values.slice(i + 1, i + 1 + count).join(";");
        if (value === 48) bg = color; else fg = color;
        i += count;
      }
    }
    offset = match.index + match[0].length;
  }
  emit(line.slice(offset));
  return cells;
}
const background = (theme, token) => ansiCells(backgroundAnsi(questionPalette(theme)[token], theme.getColorMode()) + " ")[0].bg;
function setup(q = question, theme = dark, bindings = {}, getHeight) {
  const results = [];
  let renders = 0;
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  const ui = createQuestionComponent(q, theme, kb, result => results.push(result), () => { renders++; }, getHeight);
  ui.focused = true;
  return { ui, results, get renders() { return renders; },
    lines(width = 90) { return plain(ui.render(width)); },
    key(...data) { for (const value of data) ui.handleInput(value); },
    mouse(y, type = "click", extras = {}, width = 90) {
      const height = ui.render(width).length;
      const x = y === ui.inputRow ? ui.inputColumn + 2 : 3;
      return ui.handleMouse({ type, button: "left", x, y, width, height, screenX: x, screenY: y, shift: false, alt: false, ctrl: false, ...extras });
    },
    row(pattern, width = 90) { return this.lines(width).findIndex(line => pattern.test(line)); },
  };
}

// Use the installed overlay compositor and coordinate dispatch, with terminal
// rows supplied independently of the underlying transcript/editor/footer.
function overlay(q = question, height = 15, width = 90, maxHeight = "90%") {
  const terminal = { rows: height, columns: width, hideCursor() {} };
  const tui = new TuiAltScreen(terminal);
  const f = setup(q, dark, {}, () => terminal.rows);
  const handle = tui.showOverlay(f.ui, { anchor: "center", width: 76, margin: 1, ...(maxHeight ? { maxHeight } : {}) });
  const checkedFrame = () => {
    const lines = tui.compositeOverlays(Array(terminal.rows).fill("Underlying transcript"), terminal.columns, terminal.rows);
    const box = handle.getBounds();
    assert.ok(box);
    const rendered = f.ui.render(box.width);
    assert.equal(box.height, rendered.length, "overlay must not clip its controls or border");
    assert.ok(box.height <= Math.min(Math.floor(terminal.rows * .9), terminal.rows - 2));
    assert.equal(box.width, Math.min(76, terminal.columns - 2));
    assert.ok(box.row >= 1 && box.row + box.height <= terminal.rows - 1);
    assert.ok(plain(lines).some(line => /\[Submit(?: answer)?\]/.test(line)));
    assert.ok(plain(lines).some(line => /\[Close\]/.test(line)));
    assert.ok(plain(lines).some(line => /\[Dismiss\]/.test(line)));
    for (const line of lines) assert.ok(visibleWidth(line) <= terminal.columns);
    return { lines, box };
  };
  return { ...f, frame: checkedFrame,
    resize(height, width = terminal.columns) { terminal.rows = height; terminal.columns = width; return checkedFrame(); },
    click(pattern, column, type = "click") {
      const { box } = checkedFrame();
      const lines = f.lines(box.width);
      const y = lines.findIndex(line => pattern.test(line));
      assert.ok(y >= 0, `missing mouse target ${pattern}: ${lines.join("\n")}`);
      const x = column ?? Math.max(2, lines[y].search(pattern));
      const routed = tui.dispatchMouseToOverlay({ type, button: "left", x: box.col + x, y: box.row + y,
        screenX: box.col + x, screenY: box.row + y, width: terminal.columns, height: terminal.rows,
        shift: false, alt: false, ctrl: false });
      assert.equal(routed.hit, true);
      return routed.result;
    },
  };
}

test("compact framed overlay has one heading and intentional question/control spacing", () => {
  const f = setup({ id: 4, question: "Name?", options: [] });
  const lines = f.lines(76);
  assert.equal(lines.length, 9);
  assert.match(lines[0], /^╭.*Q4.*╮$/);
  assert.match(lines.at(-1), /^╰.*╯$/);
  assert.equal(lines.filter(line => line.includes("Name?")).length, 1);
  assert.equal(lines.filter(line => line.includes("Q4")).length, 1);
  assert.match(lines[1], /^│\s+│$/);
  assert.match(lines[3], /^│\s+│$/);
  assert.match(lines[5], /^│\s+│$/);
  assert.match(lines[7], /^│\s+│$/, "filled row under actions separates the footer hint");
  assert.equal(lines[2].indexOf("Name?"), 3, "two inner columns separate text from border");
  assert.doesNotMatch(lines.join("\n"), /Ready:|Space\/click|Dismiss: no answer/);
  assert.ok(lines.every(line => visibleWidth(line) === 76));
});

test("overlay geometry and custom Input survive terminal resize with or without caller maxHeight", () => {
  for (const maxHeight of ["90%", null]) {
    const f = overlay(question, 15, 90, maxHeight);
    f.key("\t", "answer");
    for (const [height, width] of [[15, 90], [8, 40], [12, 24], [15, 80], [8, 22]]) {
      const current = f.resize(height, width);
      assert.ok(current.lines.some(line => line.includes(CURSOR_MARKER)));
      assert.equal(f.ui.input.getValue(), "answer");
    }
    f.key("\t", "\t");
    assert.match(plain(f.frame().lines).join("\n"), />\s*\[Close/);
    f.key("\x1b[Z");
    f.click(/\[Submit/);
    assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "answer" } }]);
  }
});

test("installed overlay keeps controls and editable IME input visible at heights 8/12/15", () => {
  for (const height of [8, 12, 15]) for (const q of [question, { id: 8, question: "Name?", options: [] }]) {
    const f = overlay(q, height);
    f.frame();
    if (q.options.length) f.key("\t");
    assert.ok(f.ui.input.focused);
    let current = f.frame();
    assert.equal(current.lines.filter(line => line.includes(CURSOR_MARKER)).length, 1);
    f.key("alphe", "\x7f", "a");
    f.ui.focused = false;
    assert.ok(f.frame().lines.every(line => !line.includes(CURSOR_MARKER)));
    f.ui.focused = true;
    assert.ok(f.frame().lines.some(line => line.includes(CURSOR_MARKER)));
    f.key("\t"); // Navigation only; Enter now submits custom text.
    assert.deepEqual(f.results, []);
    assert.equal(f.ui.input.focused, false);
    assert.ok(f.frame().lines.every(line => !line.includes(CURSOR_MARKER)));
    f.key("\t"); // Defer focus remains visible too.
    assert.match(plain(f.frame().lines).join("\n"), />\s*\[Close/);
    f.key("\x1b[Z");
    assert.match(plain(f.frame().lines).join("\n"), />\s*\[Submit/);
    assert.equal(f.click(/\[Submit/).handled, true);
    assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "alpha" } }]);
  }
});

test("installed overlay mouse focuses custom Input and reaches both compact controls", () => {
  for (const height of [8, 12, 15]) {
    const choice = overlay(question, height);
    choice.key("\x1b[B");
    choice.click(/2\. Second/);
    assert.deepEqual(choice.results, []);
    choice.click(/\[Submit/);
    assert.deepEqual(choice.results, [{ kind: "answer", answer: { text: "Second", optionIndex: 1 } }]);
    const f = overlay(question, height, 40);
    f.frame();
    f.click(/Custom answer:/, undefined, "press"); // The visible label is part of the native hit target.
    assert.ok(f.ui.input.focused);
    f.key("mouse text");
    assert.ok(f.frame().lines.some(line => line.includes(CURSOR_MARKER)));
    assert.equal(f.click(/\[Submit/).handled, true);
    assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "mouse text" } }]);
    const g = overlay(question, height, 40);
    g.click(/\[Close/);
    assert.deepEqual(g.results, [{ kind: "defer" }]);
  }
});

test("resizing installed overlay preserves custom text and scroll reaches every card row at 8/12/15", () => {
  const q = { id: 9, question: "Heading\n" + Array.from({ length: 20 }, (_, i) => `Question line ${i}`).join("\n"),
    options: Array.from({ length: 20 }, (_, i) => ({ label: `Choice ${i}`, description: `Detail ${i}\nSecond detail ${i}` })),
    recommended: 19, rationale: "Recommendation rationale" };
  const f = overlay(q, 15, 80);
  f.key("\t", "preserved 界😀");
  for (const height of [8, 12, 15, 8]) {
    f.resize(height);
    assert.equal(f.ui.input.getValue(), "preserved 界😀");
    assert.ok(f.frame().lines.some(line => line.includes(CURSOR_MARKER)));
    f.key(...Array(100).fill("\x1b[5~"));
    const seen = new Set();
    for (let i = 0; i < 100; i++) {
      const current = f.frame();
      for (const line of f.lines(current.box.width)) seen.add(line.replace(/^│|│$/g, "").trim());
      f.key("\x1b[6~");
    }
    const text = [...seen].join("\n");
    for (let i = 0; i < 20; i++) {
      assert.match(text, new RegExp(`Question line ${i}(?:\\n|$)`));
      assert.match(text, new RegExp(`Choice ${i}(?: \\[recommended · advisory\\])?(?:\\n|$)`));
      assert.match(text, new RegExp(`Second detail ${i}(?:\\n|$)`));
    }
    assert.match(text, /Recommendation rationale/);
    assert.deepEqual(f.results, []);
  }
  // Returning to options reveals its current cursor, rather than leaving the
  // keyboard selection invisible at the bottom of a previously scrolled card.
  f.key("\x1b[Z");
  assert.match(plain(f.frame().lines).join("\n"), />  1\. Choice 0/);
  f.key(...Array(19).fill("\x1b[B"));
  assert.match(plain(f.frame().lines).join("\n"), /20\. Choice 19/);
  f.key("\r");
  assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "Choice 19", optionIndex: 19 } }]);
});

test("short overlay preserves hard defer keys through every focus transition", () => {
  for (const height of [8, 12, 15]) for (const cancel of ["\x1b", "\x03"]) for (let tabs = 0; tabs < 5; tabs++) {
    const f = overlay(question, height);
    for (let i = 0; i < tabs; i++) { f.key("\t"); f.frame(); }
    f.key(cancel, cancel, "\r");
    assert.deepEqual(f.results, [{ kind: "defer" }]);
  }
});

test("installed fullscreen renderer manually opens a small overlay and preserves local mouse/IME cursor positions", () => {
  for (const [rows, columns] of [[8, 22], [8, 40], [12, 24], [15, 90]]) {
    const writes = [];
    const terminal = {
      rows, columns, kittyProtocolActive: false,
      start(input, resize) { this.input = input; this.resize = resize; },
      stop() {}, write(data) { writes.push(data); },
      hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {},
      clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
    };
    const tui = new TuiAltScreen(terminal, true);
    tui.addChild(new Text("Underlying transcript\n".repeat(20), 0, 0));
    let handle;
    try {
      tui.start();
      tui.renderNow();
      assert.equal(tui.hasOverlay(), false, "no overlay before manual opening");
      const f = setup(question, dark, {}, () => terminal.rows);
      // This explicit show represents the caller's manual /questions action;
      // the component itself has no activation side effects.
      handle = tui.showOverlay(f.ui, { anchor: "center", width: 76, margin: 1 });
      const check = () => {
        tui.renderNow();
        const box = handle.getBounds();
        assert.ok(box);
        const local = f.ui.render(box.width);
        assert.equal(box.height, local.length);
        assert.ok(box.height <= Math.min(Math.floor(terminal.rows * .9), terminal.rows - 2));
        const screen = plain(tui.getScreenLines());
        assert.equal(screen.length, terminal.rows);
        assert.ok(screen.some(line => /\[Submit(?: answer)?\]/.test(line)));
        assert.ok(screen.some(line => /\[Close\]/.test(line)));
        assert.ok(screen.some(line => /\[Dismiss\]/.test(line)));
        assert.ok(screen[box.row].includes("╭"));
        assert.ok(screen[box.row + box.height - 1].includes("╰"));
        assert.equal(tui.getFocusedComponent(), f.ui);
        const cursorRow = local.findIndex(line => line.includes(CURSOR_MARKER));
        if (cursorRow >= 0) {
          const cursorColumn = visibleWidth(local[cursorRow].split(CURSOR_MARKER)[0]);
          assert.ok(writes.at(-1).includes(
            "\x1b[" + (box.row + cursorRow + 1) + ";" + (box.col + cursorColumn + 1) + "H\x1b[?25h"),
          "installed renderer positions the hardware cursor inside the framed Input");
        }
        return { box, local: plain(local) };
      };
      const click = (pattern, column) => {
        const { box, local } = check();
        const row = local.findIndex(line => pattern.test(line));
        assert.ok(row >= 0);
        const x = box.col + (column ?? local[row].search(pattern)) + 1;
        const y = box.row + row + 1;
        terminal.input("\x1b[<0;" + x + ";" + y + "M");
        terminal.input("\x1b[<0;" + x + ";" + y + "m");
      };
      check();
      terminal.input("\t");
      terminal.input("abcd");
      check();
      // The component must subtract its frame inset before forwarding to Input.
      click(/abcd/, f.ui.inputColumn + 4);
      terminal.input("X");
      assert.equal(f.ui.input.getValue(), "abXcd");
      terminal.rows = rows === 8 ? 12 : 8;
      terminal.columns = columns === 22 ? 40 : 22;
      terminal.resize();
      check();
      terminal.input("\t"); // Navigation only; repeated renders must not reset focus.
      check();
      check();
      assert.deepEqual(f.results, []);
      click(/\[Submit/);
      assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "abXcd" } }]);
    } finally {
      handle?.hide();
      tui.stop();
    }
  }
});

test("real host mouse submission restores ordinary editor focus and accepts subsequent typing", async () => {
  const terminal = {
    rows: 24, columns: 90, kittyProtocolActive: false,
    start(input) { this.input = input; }, stop() {}, write() {},
    hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  themes.initTheme("dark", false);
  const tui = new TuiAltScreen(terminal);
  const keybindings = new HostKeybindingsManager();
  const editor = new CustomEditor(tui, themes.getEditorTheme(), keybindings);
  editor.setText("ordinary draft");
  tui.addChild(editor);
  tui.setFocus(editor);
  const host = Object.assign(Object.create(InteractiveMode.prototype), { ui: tui, editor, keybindings, extensionOverlays: new Map() });
  let component, handle;
  try {
    tui.start();
    const result = host.showExtensionCustom((ui, theme, kb, done) => {
      component = createQuestionComponent({ id: 1, question: "Name?", options: [] }, theme, kb, done,
        () => ui.requestRender(), () => ui.terminal.rows);
      return component;
    }, { overlay: true, overlayOptions: { anchor: "center", width: 76, margin: 1 },
      onHandle(value) { handle = value; } });
    await Promise.resolve();
    const clickSubmit = () => {
      tui.renderNow();
      const box = handle.getBounds();
      const lines = plain(component.render(box.width));
      const row = lines.findIndex(line => /\[Submit answer\]/.test(line));
      assert.ok(row >= 0);
      const x = box.col + lines[row].indexOf("[Submit answer]") + 1;
      const y = box.row + row + 1;
      terminal.input(`\x1b[<0;${x};${y}M`);
      terminal.input(`\x1b[<0;${x};${y}m`);
    };
    clickSubmit(); // Validation failure must retain focus on the still-open question.
    assert.equal(tui.hasOverlay(), true);
    assert.equal(tui.getFocusedComponent(), component);
    assert.match(plain(component.render(76)).join("\n"), /Choose an option or type an answer first/);
    terminal.input("\x1b[Z"); // Submit -> custom input.
    terminal.input("explicit answer");
    clickSubmit();
    assert.deepEqual(await result, { kind: "answer", answer: { text: "explicit answer" } });
    assert.equal(tui.hasOverlay(), false);
    assert.equal(tui.getFocusedComponent(), editor, "mouse result must not refocus the closed question");
    assert.equal(editor.focused, true);
    assert.equal(editor.getText(), "ordinary draft");
    terminal.input(" continued");
    assert.equal(editor.getText(), "ordinary draft continued", "typing reaches the restored ordinary editor");
  } finally {
    handle?.hide();
    tui.stop();
  }
});

test("native host keyboard and quick double-click submission restore the ordinary editor", async t => {
  t.mock.method(Date, "now", () => 1000);
  for (const action of ["first", "second", "custom", "close", "escape", "dismiss", "double-click", "double-click-drift"]) {
    const terminal = { rows: 32, columns: 120, kittyProtocolActive: false,
      start(input) { this.input = input; }, stop() {}, write() {}, hideCursor() {}, showCursor() {}, moveBy() {},
      clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
    themes.initTheme("dark", false);
    const tui = new TuiAltScreen(terminal);
    const keybindings = new HostKeybindingsManager();
    const editor = new CustomEditor(tui, themes.getEditorTheme(), keybindings);
    editor.setText("ordinary draft"); tui.addChild(editor); tui.setFocus(editor);
    const host = Object.assign(Object.create(InteractiveMode.prototype), { ui: tui, editor, keybindings, extensionOverlays: new Map() });
    let component, handle;
    try {
      tui.start();
      const pending = host.showExtensionCustom((ui, theme, kb, done) => {
        component = createQuestionComponent(question, theme, kb, done, () => ui.requestRender(), () => ui.terminal.rows);
        return component;
      }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", margin: 1 }, onHandle(value) { handle = value; } });
      await Promise.resolve(); tui.renderNow();
      const key = data => { terminal.input(data); tui.renderNow(); };
      key("\x1b[B"); key("\x1b[B");
      assert.equal(component.input.focused, true, "Down from the last choice reaches custom input");
      key("typed draft"); key("\x1b[A");
      assert.equal(component.cursor, 1); assert.equal(component.input.focused, false);
      key("\x1b[B");
      assert.equal(component.input.getValue(), "typed draft");
      assert.ok(tui.hasOverlay(), "navigation and editing alone do not send");
      assert.equal(tui.getFocusedComponent(), component);
      if (action === "first") { key("\x1b[A"); key("\x1b[A"); }
      if (action === "second") key("\x1b[A");
      if (action === "close") { key("\t"); key("\t"); }
      if (action === "dismiss") { key("\t"); key("\t"); key("\t"); }
      if (action.startsWith("double-click")) {
        const box = handle.getBounds();
        const lines = plain(component.render(box.width));
        const row = lines.findIndex(line => /2\. Second/.test(line));
        const x = box.col + lines[row].indexOf("Second") + 1;
        const y = box.row + row + 1;
        for (let click = 0; click < 2; click++) {
          const clickX = x + (action === "double-click-drift" ? click : 0);
          terminal.input(`\x1b[<0;${clickX};${y}M`);
          assert.equal(tui.hasActiveSelection(), false, "option presses must not start native word selection");
          terminal.input(`\x1b[<0;${clickX};${y}m`);
          if (!click) assert.equal(tui.hasOverlay(), true, "first native click only selects");
        }
        assert.equal(tui.hasOverlay(), false, "second native click submits and closes the overlay");
      } else key(action === "escape" ? "\x1b" : "\r");
      const expected = action === "custom" ? { kind: "answer", answer: { text: "typed draft" } }
        : ["first", "second", "double-click", "double-click-drift"].includes(action) ? { kind: "answer", answer: { text: action === "first" ? "First" : "Second", optionIndex: action === "first" ? 0 : 1 } }
        : { kind: action === "dismiss" ? "dismiss" : "defer" };
      assert.deepEqual(await pending, expected);
      assert.equal(tui.hasOverlay(), false);
      assert.equal(tui.getFocusedComponent(), editor);
      assert.equal(editor.focused, true);
      key(" continued");
      assert.equal(editor.getText(), "ordinary draft continued");
    } finally { tui.stop(); }
  }
});

test("frame borders and whitespace outside control labels are not action hit targets", () => {
  const f = setup();
  const input = f.row(/Type your own answer/);
  const control = f.row(/\[Submit/);
  assert.equal(f.mouse(input, "press", { x: 0 }), undefined);
  assert.equal(f.mouse(control, "click", { x: 0 }), undefined);
  assert.equal(f.mouse(control, "click", { x: 85 }), undefined);
  assert.deepEqual(f.results, []);
});

test("factory uses a real Input; navigation/Space only select, Enter sends highlighted choice", () => {
  const f = setup();
  assert.ok(f.ui instanceof QuestionComponent);
  assert.ok(f.ui.input instanceof Input);
  assert.match(f.lines().join("\n"), /Q7.*2\. Second \[recommended · advisory\]/s);
  assert.equal((f.lines().join("\n").match(/recommended/g) ?? []).length, 1);
  assert.match(f.lines().join("\n"), /Rationale: Less disruption/);
  f.key(" "); // Optional staging for mouse/Submit, not the recommendation.
  assert.deepEqual(f.results, []);
  assert.match(f.lines().join("\n"), />\* 1\. First/);
  f.key("\x1b[B");
  assert.deepEqual(f.results, []);
  assert.match(f.lines().join("\n"), />  2\. Second/);
  f.key("\r"); // Highlighted option wins over previously staged choice.
  assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "Second", optionIndex: 1 } }]);
  f.key("\r", "\x1b", "\x03");
  f.mouse(f.row(/Submit answer/));
  assert.equal(f.results.length, 1);
  assert.ok(f.renders > 0);
});

test("a fresh card cannot submit an implicit default or empty answer", () => {
  const f = setup();
  f.mouse(f.row(/Submit answer/));
  assert.deepEqual(f.results, []);
  assert.match(f.lines().join("\n"), /Choose an option or type an answer first/);
  f.key("\x1b[Z"); // Custom field.
  f.key("  ", "\r");
  assert.deepEqual(f.results, []);
  assert.match(f.lines().join("\n"), /Type an answer first/);
});

test("text-only questions accept real editable input and Enter immediately submits", () => {
  const f = setup({ id: 11, question: "What is the name?", options: [] });
  assert.ok(f.ui.input.focused);
  assert.ok(f.ui.render(50).some(line => line.includes(CURSOR_MARKER)));
  f.key("alphe", "\x7f", "a", "\r");
  assert.equal(f.ui.input.focused, false);
  assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "alpha" } }]);
});

test("custom focus replaces the candidate; selecting an option again wins without losing the draft", () => {
  const f = setup();
  f.key(" ", "\t", "different");
  assert.deepEqual(f.results, []);
  assert.equal(f.ui.selected, undefined);
  assert.deepEqual(f.ui.candidate(), { text: "different" });
  assert.doesNotMatch(f.lines().join("\n"), /\* [12]\./);
  f.mouse(f.row(/2\. Second/));
  assert.match(f.lines().join("\n"), />\* 2\. Second/);
  assert.equal(f.ui.input.getValue(), "different");
  f.mouse(f.row(/Submit answer/));
  assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "Second", optionIndex: 1 } }]);
});

test("screenshot regression: Popcorn selection clears when custom is activated, including an empty draft", () => {
  const snack = { id: 4, question: "Which snack would you pick for a coding break?", options: [
    { label: "Fruit", description: "A light snack." }, { label: "Popcorn", description: "Something crunchy." },
    { label: "Chocolate", description: "Something sweet." },
  ] };
  for (const activate of ["down", "tab", "label", "input"]) {
    const f = setup(snack, dark, {}, () => 40);
    f.mouse(f.row(/2\. Popcorn/));
    assert.match(f.lines().join("\n"), />\* 2\. Popcorn/);
    if (activate === "down") f.key("\x1b[B", "\x1b[B");
    else if (activate === "tab") f.key("\t");
    else {
      const row = f.row(/Custom answer:/);
      const x = activate === "label" ? f.lines()[row].indexOf("Custom answer") + 3 : f.ui.inputColumn + 3;
      assert.equal(f.mouse(row, "click", { x }).handled, true);
    }
    assert.equal(f.ui.input.focused, true);
    assert.equal(f.ui.selected, undefined);
    assert.equal(f.ui.answerSource, "custom");
    assert.doesNotMatch(f.lines().join("\n"), /\* [123]\.|Ready:/);
    assert.deepEqual(f.results, []);
    f.mouse(f.row(/Submit answer/));
    assert.deepEqual(f.results, [], "Submit must not send the earlier Popcorn answer");
    assert.match(f.lines().join("\n"), /Choose an option or type an answer first/);
    f.key("\x1b[Z", "pretzels", "\r");
    assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "pretzels" } }]);
  }
});

test("Submit uses the navigated choice, never an older option or preserved custom draft", () => {
  for (const previous of ["option", "custom"]) for (const submit of ["mouse", "keyboard"]) {
    const f = setup();
    if (previous === "option") { f.key(" ", "\x1b[B"); }
    else { f.key("\t", "preserved draft", "\x1b[A"); }
    assert.deepEqual(f.ui.candidate(), { text: "Second", optionIndex: 1 });
    assert.deepEqual(f.results, []);
    if (submit === "mouse") f.mouse(f.row(/Submit answer/));
    else f.key("\x1b[Z", "\x1b[Z", "\x1b[Z", "\r"); // Reach Submit without activating custom.
    assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "Second", optionIndex: 1 } }]);
  }
});

test("the entire custom row activates input; label clicks preserve draft cursor and text clicks position it", () => {
  for (const [height, width] of [[8, 22], [12, 40], [40, 90]]) {
    const f = setup(question, dark, {}, () => height);
    f.key("\t", "abcd", "\x1b[D", "\x1b[D", "\x1b[A");
    let row = f.row(/Custom(?: answer)?:|A:/, width);
    assert.equal(f.mouse(row, "press", { x: f.ui.bodyColumn + 1 }, width).handled, true);
    f.key("X");
    assert.equal(f.ui.input.getValue(), "abXcd", "label activation does not move the editable cursor");
    f.key("\x1b[A");
    row = f.row(/Custom(?: answer)?:|A:/, width);
    assert.equal(f.mouse(row, "click", { x: f.ui.inputColumn + 3 }, width).handled, true);
    f.key("Y");
    assert.equal(f.ui.input.getValue(), "aYbXcd", "actual input clicks are relative to Input, including its prompt");
    f.key("\x1b[A");
    row = f.row(/Custom(?: answer)?:|A:/, width);
    f.mouse(row, "click", { x: f.ui.bodyColumn + f.ui.bodyWidth - 1 }, width);
    assert.equal(f.ui.input.focused, true, "trailing custom-row padding activates input too");
    assert.equal(f.ui.selected, undefined);
    assert.deepEqual(f.results, []);
  }
});

test("roomy spacing keeps question/custom/control hit targets aligned and blank rows inert", () => {
  const f = setup(question, dark, {}, () => 40);
  const lines = f.lines();
  const questionRow = lines.findIndex(line => line.includes(question.question));
  const customRow = lines.findIndex(line => line.includes("Custom answer:"));
  const buttonRow = lines.findIndex(line => line.includes("[Submit answer]"));
  for (const row of [questionRow - 1, customRow - 1, buttonRow - 1, buttonRow + 1]) {
    assert.match(lines[row], /^│\s+│$/);
    assert.equal(f.mouse(row), undefined, "spacing is not a stale input or button hit target");
  }
  assert.match(lines[questionRow + 1], /^│\s+│$/);
  assert.equal(f.ui.inputRow, customRow);
  assert.equal(f.ui.buttons[0].row, buttonRow);
  f.mouse(f.row(/2\. Second/));
  assert.equal(f.ui.selected, 1);
  f.mouse(customRow, "click", { x: lines[customRow].indexOf("Custom answer:") });
  assert.equal(f.ui.input.focused, true);
  f.key("spaced answer");
  f.mouse(f.row(/Submit answer/));
  assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "spaced answer" } }]);
});

test("focus reaches the real child only when custom text owns keyboard focus", () => {
  const f = setup();
  assert.equal(f.ui.input.focused, false);
  f.key("\t");
  assert.equal(f.ui.input.focused, true);
  assert.ok(f.ui.render(60).some(line => line.includes(CURSOR_MARKER)));
  f.ui.focused = false;
  assert.equal(f.ui.input.focused, false);
  assert.ok(f.ui.render(60).every(line => !line.includes(CURSOR_MARKER)));
  f.ui.focused = true;
  assert.equal(f.ui.input.focused, true);
  f.key("\t");
  assert.equal(f.ui.input.focused, false);
});

test("Escape and Ctrl+C always defer, from every keyboard focus, exactly once", () => {
  for (const cancel of ["\x1b", "\x03"]) for (let tabs = 0; tabs < 5; tabs++) {
    const f = setup();
    f.key(...Array(tabs).fill("\t"), cancel, cancel, "\r");
    assert.deepEqual(f.results, [{ kind: "defer" }]);
    assert.equal(f.ui.input.focused, false);
  }
  const f = setup();
  f.mouse(f.row(/\[Close\]/), "click", { x: f.lines().find(line => /\[Close\]/.test(line)).indexOf("[Close") });
  assert.deepEqual(f.results, [{ kind: "defer" }]);
});

test("fullscreen mouse stages options, focuses/edits custom text, and explicitly submits", () => {
  const f = setup();
  const y = f.row(/2\. Second/);
  assert.equal(f.mouse(y, "press").handled, true, "own the gesture instead of falling back to text selection");
  assert.equal(f.mouse(y).handled, true);
  assert.deepEqual(f.results, [], "a single click only stages the option");
  assert.equal(f.mouse(f.row(/>\* 2\./), "click", { button: "right" }), undefined);
  const inputY = f.row(/Type your own answer/);
  assert.equal(f.mouse(inputY, "press").focus, true);
  assert.equal(f.ui.input.focused, true);
  f.key("mouse answer");
  f.mouse(f.row(/Submit answer/));
  assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "mouse answer" } }]);
});

test("only quick repeated clicks submit an option, exactly once, without requiring native click counts", t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  for (const clickCount of [undefined, 1, 2]) for (const delay of [0, 100, 300, 301, 500]) {
    const f = setup();
    const y = f.row(/2\. Second/);
    f.mouse(y, "click", { clickCount: 1 });
    assert.deepEqual(f.results, []);
    now += delay;
    const result = f.mouse(y, "click", { clickCount });
    if (delay <= 300) {
      assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "Second", optionIndex: 1 } }]);
      assert.equal(result.focus, false, "a completed overlay must not reclaim editor focus");
      f.mouse(y, "click", { clickCount: 3 });
      assert.equal(f.results.length, 1);
    } else assert.deepEqual(f.results, [], "slow repeat clicks remain selection only");
  }
});

test("double-click submission requires the same option without an intervening interaction", t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  for (const interrupt of [
    f => f.mouse(f.row(/1\. First/)),
    f => f.key("\x1b[A"),
    f => f.mouse(f.row(/2\. Second/), "wheel", { button: "none", wheelDelta: 1 }),
    f => f.mouse(f.row(/Which target/)),
    f => f.mouse(f.row(/Custom answer:/), "press"),
    f => f.mouse(f.row(/Which target/), "press"),
    f => f.mouse(f.row(/2\. Second/), "press", { ctrl: true }),
    f => f.mouse(f.row(/2\. Second/), "drag"),
    f => f.mouse(-1, "drag"),
    f => { f.ui.focused = false; f.ui.focused = true; },
    f => f.lines(60),
  ]) {
    const f = setup();
    f.mouse(f.row(/2\. Second/), "click", { clickCount: 1 });
    interrupt(f);
    now += 100;
    f.mouse(f.row(/2\. Second/), "click", { clickCount: 2 });
    assert.deepEqual(f.results, []);
  }
  const fresh = setup();
  fresh.mouse(fresh.row(/2\. Second/), "click", { clickCount: 2 });
  assert.deepEqual(fresh.results, [], "an opening click cannot double-click-submit a fresh overlay");
});

test("double-clicks tolerate small pointer drift but not distant clicks on the same option", t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  for (const [dx, dy, submits] of [[1, 0, true], [2, 1, true], [3, 0, false]]) {
    const f = setup();
    const y = f.row(/2\. Second/);
    f.mouse(y, "press"); f.mouse(y, "release"); f.mouse(y);
    now += 100;
    f.mouse(y + dy, "press", { x: 3 + dx });
    f.mouse(y + dy, "release", { x: 3 + dx });
    f.mouse(y + dy, "click", { x: 3 + dx, clickCount: 1 });
    assert.equal(f.results.length, submits ? 1 : 0);
  }
});

test("long cards stay bounded and all content is reachable through keyboard and wheel scrolling", () => {
  const f = setup({ id: 12, question: "Heading\n" + "Long question paragraph\n".repeat(30),
    options: Array.from({ length: 30 }, (_, i) => ({ label: `Choice ${i}`, description: `detail ${i}\n` + "description\n".repeat(10) })),
    recommended: 29, rationale: "Final recommendation" });
  assert.ok(f.lines(40).length <= 16);
  f.key("\x1b[6~");
  assert.equal(f.ui.scroll, f.ui.bodyRows, "page size follows the actual viewport, not a fixed eight rows");
  assert.match(f.lines(40).join("\n"), new RegExp(`${f.ui.scroll + 1}-${f.ui.scroll + f.ui.bodyRows}/`));
  const before = f.ui.scroll;
  assert.equal(f.mouse(2, "wheel", { wheelDelta: 3, button: "none" }, 40).handled, true);
  assert.equal(f.ui.scroll, before + 3);
  f.key(...Array(29).fill("\x1b[B"));
  assert.match(f.lines(40).join("\n"), /30\. Choice 29/);
  const line = f.row(/30\. Choice 29/, 40);
  f.mouse(line, "click", {}, 40);
  f.mouse(f.row(/\[Submit/, 40), "click", {}, 40);
  assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "Choice 29", optionIndex: 29 } }]);
});

test("narrow, Unicode, resize, and light/dark themes never exceed terminal columns", () => {
  for (const theme of [dark, light]) {
    const f = setup({ id: 1, question: "😀界é 👩‍💻\n".repeat(12), options: [{ label: "界".repeat(40), description: "description 😀" }], recommended: 0 }, theme);
    f.key("\t", "😀界é".repeat(30));
    for (const width of [0, 1, 2, 3, 5, 12, 80, 20, 100]) {
      const lines = f.ui.render(width);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
      assert.ok(lines.length <= 16);
    }
    f.ui.invalidate();
    assert.ok(f.ui.render(80).some(line => line.includes(CURSOR_MARKER)));
  }
});

test("theme styling is evaluated again after invalidation, not stored in question state", () => {
  let theme = dark;
  const proxy = { fg: (...args) => theme.fg(...args), bg: (...args) => theme.bg(...args),
    style: (...args) => theme.style(...args), get colors() { return theme.colors; }, get appearance() { return theme.appearance; }, getColorMode: () => theme.getColorMode() };
  const f = setup(question, proxy);
  const first = f.ui.render(90);
  theme = light; f.ui.invalidate();
  const second = f.ui.render(90);
  assert.notDeepEqual(first, second);
  assert.deepEqual(plain(first), plain(second));
});

test("controls, terminal links/cursor markers, bidi overrides, and pasted controls are plain text", () => {
  const dirty = "plain\x1b[31mred\x1b[0m\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\x1b_pi:c\x07\x00\x07\x9b\u202e\u2066\r\nnext\tcell";
  const cleaned = sanitizeQuestionText(dirty);
  assert.match(cleaned, /plainredlink/);
  assert.match(cleaned, /\nnext cell/);
  assert.doesNotMatch(cleaned, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e\u2066]/);
  const f = setup({ id: 1, question: dirty, options: [{ label: dirty, description: dirty }], rationale: dirty });
  assert.doesNotMatch(f.ui.render(200).join("\n"), /https:\/\/evil|\x1b_pi:c/);
  f.key("\x1b[200~", dirty, "\x1b[201~\r");
  assert.deepEqual(f.results, []);
  assert.equal(f.ui.input.getValue(), cleaned.replaceAll("\n", " "));
  f.key("\r", "\r");
  assert.deepEqual(f.results, [{ kind: "answer", answer: { text: cleaned.replaceAll("\n", " ").trim() } }]);
});

test("surrogate sanitization preserves valid emoji and replaces only malformed UTF-16", () => {
  assert.equal(sanitizeQuestionText("😀👩‍💻界é\ud800x\udfff"), "😀👩‍💻界é\ufffdx\ufffd");
});

test("maximum-size paste accepts a split terminator, and unfinished paste can be deferred", () => {
  const f = setup({ id: 3, question: "Name?", options: [] });
  f.key("\x1b[200~", "x".repeat(QUESTION_UI_LIMITS.answerCharacters), "\x1b[20", "1~");
  assert.equal(f.ui.input.getValue().length, QUESTION_UI_LIMITS.answerCharacters);
  assert.deepEqual(f.results, []);
  f.key("\x1b[200~unfinished", "\x03");
  assert.deepEqual(f.results, [{ kind: "defer" }]);
});

test("bracketed paste may split its terminator; oversized pastes are rejected atomically", () => {
  const f = setup({ id: 2, question: "Name?", options: [] });
  f.key("ok", "\x1b[200~", "x".repeat(QUESTION_UI_LIMITS.answerCharacters + 100), "more", "\x1b[20", "1~\r");
  assert.equal(f.ui.input.getValue(), "ok");
  assert.deepEqual(f.results, []);
  assert.match(f.lines().join("\n"), /Paste too long/);
  f.key("\x1b[200~hi\x1b[20", "1~");
  assert.equal(f.ui.input.getValue(), "okhi");
  f.key("\r", "\r");
  assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "okhi" } }]);
});

test("injected navigation/confirm bindings are honored, but hard cancel keys remain safe", () => {
  const f = setup(question, dark, { "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+o", "tui.input.tab": "ctrl+t", "tui.select.cancel": "ctrl+x" });
  f.key("\x0e", "\x0f", "\x14", "\x14", "\x0f");
  assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "Second", optionIndex: 1 } }]);
  const g = setup(question, dark, { "tui.select.cancel": "ctrl+x" });
  g.key("\x03");
  assert.deepEqual(g.results, [{ kind: "defer" }]);
});

test("invalid recommendations are omitted, view is snapshotted, oversized cards fail closed", () => {
  for (const recommended of [-1, 2, 0.5, NaN]) {
    const f = setup({ ...question, recommended });
    assert.doesNotMatch(f.lines().join("\n"), /recommended|advisory/);
  }
  const q = { id: 5, question: "Original", options: [{ label: "Original option" }] };
  const f = setup(q);
  q.question = "Mutated"; q.options[0].label = "Mutated";
  f.key("\r", "\t", "\t", "\r");
  assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "Original option", optionIndex: 0 } }]);
  assert.throws(() => setup({ ...question, question: "x".repeat(QUESTION_UI_LIMITS.cardCharacters + 1) }), /exceeds UI limits/);
  assert.throws(() => setup({ ...question, options: Array(129).fill({ label: "x" }) }), /exceeds UI limits/);
  assert.throws(() => setup({ ...question, id: 0 }), /positive safe integer/);
});

test("real compositor paints every dialog cell with neutral opaque surfaces in dark/light", () => {
  for (const theme of [dark, light]) for (const [columns, rows] of [[180, 50], [40, 8], [24, 8]]) {
    const terminal = { columns, rows, hideCursor() {} };
    const tui = new TuiAltScreen(terminal);
    const f = setup(roomyQuestion, theme, {}, () => terminal.rows);
    const handle = tui.showOverlay(f.ui, { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 });
    // A deliberately different underlying color catches inherited backgrounds.
    const under = "\x1b[48;2;251;1;250m" + "U".repeat(columns) + "\x1b[49m";
    try {
      const screen = tui.compositeOverlays(Array(rows).fill(under), columns, rows);
      const box = handle.getBounds();
      const local = f.lines(box.width);
      assert.equal(box.height, local.length, "no compositor clipping");
      assert.ok(box.height <= rows - 2);
      for (let y = 0; y < box.height; y++) {
        const cells = ansiCells(screen[box.row + y]);
        for (let x = 0; x < box.width; x++) {
          assert.ok(cells[box.col + x]?.bg, `unfilled ${theme.name} cell ${x},${y}`);
          assert.notEqual(cells[box.col + x].bg, "2;251;1;250", `inherited transcript at ${x},${y}`);
        }
        assert.equal(cells[box.col - 1].bg, "2;251;1;250", "outside the dialog stays untouched");
        assert.equal(cells[box.col + box.width].bg, "2;251;1;250");
        assert.equal(cells[box.col].bg, background(theme, "surface"), "left border is filled");
        assert.equal(cells[box.col + box.width - 1].bg, background(theme, "surface"), "right border is filled");
      }
      const buttonColors = [];
      for (const label of [/\[Submit(?: answer)?\]/, /\[Close\]/, /\[Dismiss\]/]) {
        const row = local.findIndex(line => label.test(line));
        assert.ok(row >= 0);
        const text = label.exec(local[row])[0];
        const start = local[row].indexOf(text) - 1; // clickable focus/padding cell
        const cells = ansiCells(screen[box.row + row]);
        const expected = background(theme, "choice");
        for (let x = start; x < start + text.length + 1; x++) assert.equal(cells[box.col + x].bg, expected);
        buttonColors.push(expected);
      }
      assert.equal(new Set(buttonColors).size, 1, "controls use neutral fills, not purple/blue backgrounds");
      if (rows === 50) {
        assert.equal(box.width, 162);
        assert.equal(f.ui.bodyRows, f.ui.rows.length, "roomy cards show every question/choice/rationale row");
        assert.ok(f.ui.bodyRows > 8);
        assert.equal(f.ui.scroll, 0);
        assert.ok(box.height < rows * .7, "content-sized height avoids giant whitespace");
        assert.equal((local.join("\n").match(/recommended/g) ?? []).length, 1);
        assert.match(local.join("\n"), /Custom answer:/);
        for (const option of roomyQuestion.options) assert.ok(local.some(line => line.includes(option.label)));
        const heading = local.findIndex(line => line.includes("Fetching origin failed"));
        const questionCell = local[heading].indexOf("Fetching");
        assert.equal(ansiCells(screen[box.row + heading])[box.col + questionCell].bold, true);
        const rationale = local.findIndex(line => line.includes("Rationale:"));
        assert.equal(ansiCells(screen[box.row + rationale])[box.col + local[rationale].indexOf("Rationale:")].bold, false);
        for (let index = 0; index < roomyQuestion.options.length; index++) {
          const y = local.findIndex(line => line.includes(roomyQuestion.options[index].label));
          const cells = ansiCells(screen[box.row + y]);
          const expected = background(theme, index === 0 ? "focused" : "choice");
          for (let x = f.ui.bodyColumn; x < f.ui.bodyColumn + f.ui.bodyWidth; x++) assert.equal(cells[box.col + x].bg, expected, "choice content fills its inner width");
          for (const x of [1, 2, box.width - 3, box.width - 2]) assert.equal(cells[box.col + x].bg, background(theme, "surface"), "opaque inner gutters separate content from frame");
          assert.ok(/^│\s*│$/.test(local[y - 1]), "choices are visually separated");
        }
      }
    } finally { handle.hide(); }
  }
});

function rgbFromAnsi(value) {
  assert.ok(value, "text and backgrounds must be explicit, not inherited");
  const parts = value.split(";").map(Number);
  if (parts[0] === 2) return parts.slice(1);
  assert.equal(parts[0], 5);
  const index = parts[1];
  assert.ok(index >= 16, "avoid terminal-defined ANSI colors in contrast-critical cards");
  if (index >= 232) return Array(3).fill(8 + (index - 232) * 10);
  const cube = [0, 95, 135, 175, 215, 255];
  return [cube[Math.floor((index - 16) / 36)], cube[Math.floor((index - 16) / 6) % 6], cube[(index - 16) % 6]];
}
function contrast(fg, bg) {
  const luminance = value => rgbFromAnsi(value).map(channel => channel / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const first = luminance(fg), second = luminance(bg);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

test("amber transcript/list cards match the header, contrast with gray chrome, and keep readable text", () => {
  for (const appearance of ["dark", "light"]) for (const mode of ["truecolor", "256color"]) {
    const theme = themes.loadThemeFromPath(join(root, `dist/modes/interactive/theme/${appearance}.json`), mode);
    const header = ansiCells(questionStyle(theme, "Header", "questionText", "question"))[0];
    const body = ansiCells(questionStyle(theme, "Body", "text", "question"))[0];
    const modal = ansiCells(questionStyle(theme, "Modal", "text", "surface"))[0];
    assert.ok(contrast(header.fg, header.bg) >= 4.5, "restored warm header retains readable contrast");
    assert.equal(body.fg, header.fg, "question text matches the header foreground");
    assert.equal(body.bg, header.bg, "question text matches the header background");
    const expectedForeground = appearance === "light" ? [95, 0, 0] : mode === "truecolor" ? [255, 255, 128] : [255, 255, 135];
    assert.deepEqual(rgbFromAnsi(body.fg), expectedForeground, "question foreground uses vivid lemon yellow/dark red");
    if (appearance === "dark" && mode === "truecolor") {
      const previous = "2;255;240;191";
      assert.ok(contrast(body.fg, body.bg) > contrast(previous, body.bg), "lemon yellow improves contrast over the previous cream text");
      assert.ok(contrast(body.fg, body.bg) >= 8.6, "dark-mode question text retains strong luminance contrast");
    }
    if (appearance === "dark") {
      const previous = ansiCells(questionStyle(theme, "Previous", "warning", "question"))[0];
      assert.ok(contrast(body.fg, body.bg) > contrast(previous.fg, previous.bg), "question text stands out more than the previous amber-yellow text");
    }
    const expectedBackground = mode === "truecolor"
      ? appearance === "dark" ? [89, 69, 21] : [255, 240, 191]
      : appearance === "dark" ? [95, 95, 0] : [255, 255, 175];
    assert.deepEqual(rgbFromAnsi(body.bg), expectedBackground, "amber survives terminal color quantization");
    const chrome = ansiCells(questionStyle(theme, "Chrome", "text", "choice"))[0];
    assert.notEqual(body.bg, chrome.bg, "cards no longer blend into generic gray controls");
    assert.ok(contrast(body.bg, chrome.bg) >= (appearance === "dark" ? 1.6 : 1.1), "question fill is separated from gray chrome");
    for (const width of [1, 2, 5, 80]) {
      const cells = ansiCells(questionPaint(theme, " ".repeat(width), "question"));
      assert.equal(cells.length, width);
      assert.ok(cells.every(cell => cell.char === " " && cell.bg === body.bg && cell.fg === body.fg), "intentional blank buffers retain the exact question palette across every cell");
    }
    assert.notEqual(body.fg, modal.fg, "popup text retains its separate palette");
    for (const tone of ["text", "muted", "accent", "success", "warning"]) {
      const line = questionPaint(theme, questionStyle(theme, "Question", tone, "question") + "  ", "question");
      for (const cell of ansiCells(line)) {
        assert.equal(cell.bg, header.bg, `${appearance}/${mode}: body matches header`);
        const [red, green, blue] = rgbFromAnsi(cell.bg);
        assert.ok(red >= green && green > blue, "question fills stay yellow/amber, never neutral gray or blue");
        assert.ok(contrast(cell.fg, cell.bg) >= 4.5, `${appearance}/${mode}/${tone}: readable amber panel`);
      }
    }
  }
});

test("blank question separators keep a darker amber tint rather than terminal-gray stripes", () => {
  for (const appearance of ["dark", "light"]) for (const mode of ["truecolor", "256color"]) {
    const theme = themes.loadThemeFromPath(join(root, `dist/modes/interactive/theme/${appearance}.json`), mode);
    const body = ansiCells(questionPaint(theme, " ", "question"))[0];
    const cells = ansiCells(questionPaint(theme, " ".repeat(80), "questionSeparator"));
    const [red, green, blue] = rgbFromAnsi(cells[0].bg);
    assert.ok(red >= green && green > blue, `${appearance}/${mode}: separators remain yellow/amber`);
    assert.equal(cells.length, 80);
    assert.ok(cells.every(cell => cell.bg === cells[0].bg), "every spacer cell is opaque");
    const brightness = bg => rgbFromAnsi(bg).reduce((sum, channel) => sum + channel, 0);
    assert.ok(brightness(cells[0].bg) <= brightness(body.bg));
    if (mode === "truecolor") assert.ok(brightness(cells[0].bg) < brightness(body.bg), "spacers are darker than text rows");
    if (appearance === "dark" && mode === "truecolor") {
      const ratios = rgbFromAnsi(cells[0].bg).map((channel, index) => channel / rgbFromAnsi(body.bg)[index]);
      assert.ok(ratios.every(ratio => ratio > .9 && ratio < .95), "separators are only subtly darker");
      assert.ok(Math.max(...ratios) - Math.min(...ratios) < .04, "channels dim proportionally to preserve the same amber hue");
    }
    // The 256-color cube has only one sufficiently dark amber; its two shades may coincide.
  }
});

test("actual ANSI paint pairs meet text/state contrast in dark/light truecolor and 256color", () => {
  for (const appearance of ["dark", "light"]) for (const mode of ["truecolor", "256color"]) {
    const theme = themes.loadThemeFromPath(join(root, `dist/modes/interactive/theme/${appearance}.json`), mode);
    const f = setup(question, theme, {}, () => 50);
    const samples = [];
    const check = state => {
      const lines = f.ui.render(108);
      samples.push(`\x1b[0m${appearance} / ${mode} / ${state}\n` + lines.join("\n") + "\x1b[0m\n");
      for (const [row, line] of lines.entries()) for (const cell of ansiCells(line)) {
        assert.ok(cell.bg, `${appearance} ${state} row ${row}: every cell opaque`);
        if (!cell.char.trim()) continue;
        assert.equal(cell.dim, false, "supporting text must not be made faint after contrast validation");
        const ratio = contrast(cell.fg, cell.bg);
        const required = /[╭╮╰╯│─]/u.test(cell.char) ? 3 : 4.5;
        assert.ok(ratio >= required, `${appearance}/${mode}/${state} row ${row} ${JSON.stringify(cell)} contrast ${ratio.toFixed(2)} < ${required}`);
      }
      return plain(lines).join("\n");
    };
    assert.match(check("initial placeholder and options"), /Type your own answer/);
    f.key(" ", "\x1b[B");
    const staged = check("focused Second replaces selected First");
    assert.doesNotMatch(staged, /\* 1\. First/); assert.match(staged, />  2\. Second/);
    f.key("\x1b[B"); check("focused custom placeholder");
    f.key("\r"); assert.deepEqual(f.results, []); check("empty custom validation");
    f.key("readable input"); check("custom text without redundant Ready status");
    for (const state of ["Submit", "Close", "Dismiss"]) { f.key("\t"); check(`focused ${state}`); }
    if (process.env.QUESTION_UI_SAMPLE_PREFIX && mode === "truecolor") {
      writeFileSync(`${process.env.QUESTION_UI_SAMPLE_PREFIX}-${appearance}.ansi`, samples.join("\n"));
    }
  }
});

test("plain mode keeps labels/focus markers and editable cursor without color or faint text", () => {
  const original = { noColor: process.env.NO_COLOR, term: process.env.TERM };
  try {
    for (const variable of ["NO_COLOR", "TERM"]) {
      if (variable === "NO_COLOR") process.env.NO_COLOR = "1";
      else { delete process.env.NO_COLOR; process.env.TERM = "dumb"; }
      const f = setup();
      f.key(" ", "\x1b[B");
      assert.doesNotMatch(f.lines().join("\n"), /\* 1\. First/);
      assert.match(f.lines().join("\n"), />  2\. Second/);
      f.key("\x1b[B", "plain input");
      const lines = f.ui.render(90);
      assert.ok(lines.some(line => line.includes(CURSOR_MARKER)));
      assert.doesNotMatch(lines.join("\n"), /\x1b\[[0-9;]*m/);
      f.key("\r");
      assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "plain input" } }]);
    }
  } finally {
    if (original.noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = original.noColor;
    if (original.term === undefined) delete process.env.TERM; else process.env.TERM = original.term;
  }
});

test("short/narrow installed overlay makes every choice reachable and its full row clickable", () => {
  const q = { id: 16, question: "Which target?", options: Array.from({ length: 6 }, (_, index) => ({
    label: `Target ${index + 1}`, description: `Details for target ${index + 1}; approval-relevant content remains scrollable.`,
  })), recommended: 5, rationale: "A separate advisory explanation." };
  for (const [rows, columns] of [[8, 22], [8, 40], [12, 24], [15, 40]]) {
    const f = overlay(q, rows, columns);
    f.key("\x1b[A"); // Reveal the first choice even when the initial viewport shows only the question.
    for (let index = 0; index < q.options.length; index++) {
      if (index) f.key("\x1b[B");
      f.frame();
      const label = new RegExp(`${index + 1}\\. Target ${index + 1}`);
      assert.ok(f.lines(f.ui.lastWidth).some(line => label.test(line)));
      f.click(label, f.ui.bodyColumn + f.ui.bodyWidth - 1);
      assert.equal(f.ui.selected, index, "choice padding is a real hit target");
      assert.deepEqual(f.results, []);
    }
    const result = f.click(/\[Submit/);
    assert.notEqual(result.focus, true, "completion must never reacquire focus");
    assert.deepEqual(f.results, [{ kind: "answer", answer: { text: "Target 6", optionIndex: 5 } }]);
  }
  const f = setup();
  f.mouse(f.row(/The second target/), "click", { x: f.ui.bodyColumn + f.ui.bodyWidth - 1 });
  assert.equal(f.ui.selected, 1, "description and trailing padding select the same option");
  for (const x of [0, 1, 2, 87, 88, 89]) assert.equal(f.mouse(f.row(/The second target/), "click", { x }), undefined, "frame/gutters are never choice hit targets");
});

test("Dismiss is explicit and answer-free; Close/Escape preserve defer semantics after staging", () => {
  for (const action of ["mouse", "keyboard"]) {
    const f = setup();
    f.key(" ", "\t", "staged but not submitted");
    if (action === "mouse") {
      const row = f.row(/\[Dismiss\]/);
      const x = f.lines()[row].indexOf("[Dismiss]") - 1;
      const result = f.mouse(row, "click", { x });
      assert.notEqual(result.focus, true);
    } else f.key("\t", "\t", "\t", "\r");
    f.key("\r", "\x1b");
    assert.deepEqual(f.results, [{ kind: "dismiss" }]);
    assert.equal(f.ui.input.focused, false);
  }
  for (const action of ["close", "escape"]) {
    const f = setup();
    f.key(" ", "\t", "preserve as pending");
    if (action === "escape") f.key("\x1b");
    else {
      const row = f.row(/\[Close\]/);
      const result = f.mouse(row, "click", { x: f.lines()[row].indexOf("[Close]") });
      assert.notEqual(result.focus, true);
    }
    assert.deepEqual(f.results, [{ kind: "defer" }]);
  }
});
