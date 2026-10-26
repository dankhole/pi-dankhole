import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const requirePi = createRequire(join(root, "package.json"));
const fromPi = path => import(pathToFileURL(join(root, path)).href);
const { loadExtensions } = await fromPi("dist/core/extensions/loader.js");
const themeModule = await fromPi("dist/modes/interactive/theme/theme.js");
const { getThemeByName } = themeModule;
const { InteractiveMode } = await fromPi("dist/modes/interactive/interactive-mode.js");
const { KeybindingsManager } = await fromPi("dist/core/keybindings.js");
const { CustomEditor } = await fromPi("dist/modes/interactive/components/custom-editor.js");
const { Container, visibleWidth, CURSOR_MARKER, setKeybindings } = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
const scratch = mkdtempSync(join(tmpdir(), "pi-input-bar-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styling/status-line.ts");
const extensionPath = join(scratch, "input-test.ts");
// Pi's fake-cursor protocol is resolved by TUI rather than standard ANSI stripping.
const plainInput = line => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "").replaceAll(/\x1b_pi:\/?fc\x07/g, ""));
writeFileSync(extensionPath, `import { registerStatusLine } from ${JSON.stringify(sourcePath)};\nexport default pi => registerStatusLine({ ...pi, getAllTools: () => [], getThinkingLevel: () => "high" }, true);\n`);
async function emit(extension, name, ctx, fields = {}) {
  for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name, ...fields }, ctx);
}
function environment(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const set = entries => { for (const [key, value] of Object.entries(entries)) value === undefined ? delete process.env[key] : process.env[key] = value; };
  set(values); t.after(() => set(saved));
}
const awakeExtensionPath = join(scratch, "awake-input-test.ts");
writeFileSync(awakeExtensionPath, `import { registerStatusLine } from ${JSON.stringify(sourcePath)};\nexport default pi => registerStatusLine({ ...pi, getThinkingLevel: () => "high" }, true, true);\n`);
async function fixture(t, keepAwake = false, compactionNoticePercent) {
  let path = keepAwake ? awakeExtensionPath : extensionPath;
  if (compactionNoticePercent !== undefined) {
    path = join(scratch, `cutoff-${compactionNoticePercent}-${keepAwake}.ts`);
    writeFileSync(path, `import { registerStatusLine } from ${JSON.stringify(sourcePath)};\nexport default pi => registerStatusLine({ ...pi, getThinkingLevel: () => "high" }, true, ${keepAwake}, ${compactionNoticePercent});\n`);
  }
  const { extensions, errors, runtime } = await loadExtensions([path], scratch);
  const settings = {};
  runtime.getSettings = () => settings;
  assert.deepEqual(errors, []);
  const extension = extensions[0];
  let factory;
  let editor;
  let footer;
  let theme = getThemeByName("dark");
  let renders = 0;
  const tui = { terminal: { rows: 30, columns: 150 }, requestRender() { renders++; } };
  const keybindings = new KeybindingsManager();
  setKeybindings(keybindings);
  const style = value => theme.fg("accent", value);
  const editorTheme = { borderColor: style, selectList: { selectedPrefix: style, selectedText: style, description: style, scrollInfo: style, noMatch: style } };
  const statuses = new Map([["compact-tools:chat-timer", "12m"], ["questions:pending", "Q4 pending"], ["other", "worker idle"]]);
  const usage = { input: 19000, output: 7600, cacheRead: 28000, cacheWrite: 2000, totalTokens: 56600, cost: { total: .016 } };
  const entries = [{ type: "message", message: { role: "assistant", usage } }];
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/work/pi-playground", thinkingLevel: "high",
    model: { provider: "test", id: "test-model", name: "DeepSeek V4 Pro", reasoning: true, contextWindow: 1000000 },
    modelRegistry: { isUsingOAuth: () => false },
    getContextUsage: () => ({ tokens: 31000, contextWindow: 1000000, percent: 3.1 }),
    sessionManager: {
      getCwd: () => ctx.cwd, getSessionId: () => "session", getLeafId: () => "leaf",
      getEntries: () => entries, getBranch: () => entries,
    },
    ui: {
      get theme() { return theme; },
      getEditorComponent: () => factory,
      setEditorComponent(next) { factory = next; editor = next?.(tui, editorTheme, keybindings); },
      setFooter(next) {
        footer?.dispose();
        footer = next?.(tui, {
          fg: (...args) => theme.fg(...args), style: (...args) => theme.style(...args),
          get appearance() { return theme.appearance; },
        }, { getGitBranch: () => "main", getExtensionStatuses: () => statuses, onBranchChange: () => () => {} });
      },
    },
  };
  await emit(extension, "session_start", ctx);
  t.after(() => emit(extension, "session_shutdown", ctx));
  return {
    ctx, extension, tui, statuses, keybindings, entries, settings,
    get editor() { return editor; }, get footer() { return footer; }, get factory() { return factory; }, get renders() { return renders; },
    theme(name) { theme = getThemeByName(name); },
    lines(width) { return [...editor.render(width), ...footer.render(width)]; },
  };
}

async function hostFixture(t) {
  const f = await fixture(t);
  await emit(f.extension, "session_shutdown", f.ctx);
  themeModule.initTheme("dark", false);
  // Use the installed host's real editor replacement and key wiring; only the
  // terminal, selection teardown and unrelated UI containers are test doubles.
  const host = Object.create(InteractiveMode.prototype);
  host.ui = f.tui;
  host.ui.setFocus = editor => { editor.focused = true; };
  host.keybindings = f.keybindings;
  host.runtimeHost = { session: { thinkingLevel: "high" } };
  host.isBashMode = false;
  host.defaultEditor = new CustomEditor(host.ui, themeModule.getEditorTheme(), host.keybindings);
  host.editor = host.defaultEditor;
  host.editorContainer = new Container();
  host.disposeActiveSelector = () => {};
  host.setupKeyHandlers();
  host.updateEditorBorderColor();
  f.ctx.ui.getEditorComponent = () => host.editorComponentFactory;
  f.ctx.ui.setEditorComponent = factory => host.setCustomEditorComponent(factory);
  await emit(f.extension, "session_start", f.ctx);
  return { ...f, host };
}

test("actual idle frame has outer whitespace and three native input rows with top-border stats", async t => {
  environment(t, { TERM: "xterm-256color", NO_COLOR: undefined, PI_NERD_FONTS: "0" });
  const f = await fixture(t);
  f.editor.focused = true;
  for (const width of [100, 150]) {
    const lines = f.lines(width);
    const plain = lines.map(stripVTControlCharacters);
    assert.equal(lines.length, 5, `${width}: outer spacing, no separate footer/status row`);
    assert.equal(lines[0], "");
    assert.equal(lines.at(-1), "");
    assert.deepEqual(f.footer.render(width), []);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.match(plain[1], /^─ DeepSeek V4 Pro high › pi-playground ─/);
    assert.equal(plain[3], "─".repeat(width));
    assert.ok(lines[2].includes(CURSOR_MARKER), "native IME cursor marker survives");
    assert.equal(visibleWidth(lines[2].slice(0, lines[2].indexOf(CURSOR_MARKER))), 1, "idle input cursor has one column of left padding");
    const expected = width >= 150 ? ["main", "31k/1.0M", "↑19k", "↓7.6k", "$0", "12m", "Q4 pending", "worker idle"] : ["31k/1.0M", "12m", "Q4 pending", "worker idle"];
    for (const field of expected) assert.ok(plain[1].includes(field), `${width}: ${field}: ${plain[1]}`);
    assert.ok(!/R28k|W2.0k|CH|MCP/.test(plain[1]));
    assert.ok(plain[1].endsWith("Q4 pending"), "stats end at the right edge, not padded on their right");
    assert.equal(visibleWidth(lines[1]), width);
    if (process.env.COMPACT_INPUT_SAMPLE_DIR) {
      mkdirSync(process.env.COMPACT_INPUT_SAMPLE_DIR, { recursive: true });
      // Resolve Pi's zero-width cursor protocol as TUI does for terminal output.
      const ansi = lines.map(line => line.replaceAll(CURSOR_MARKER, "")
        .replaceAll("\x1b_pi:fc\x07", "\x1b[7m").replaceAll("\x1b_pi:/fc\x07", "\x1b[27m"));
      writeFileSync(join(process.env.COMPACT_INPUT_SAMPLE_DIR, `width-${width}.ansi`), ansi.join("\n") + "\n");
      writeFileSync(join(process.env.COMPACT_INPUT_SAMPLE_DIR, `width-${width}.txt`), ansi.map(stripVTControlCharacters).join("\n") + "\n");
    }
  }
});

test("typed input has exactly one native left-padding column without adding a blank row", async t => {
  const f = await fixture(t);
  const editor = f.editor;
  editor.focused = true;
  editor.handleInput("hello");
  let rows = editor.render(100);
  assert.equal(editor.getPaddingX(), 1);
  assert.equal(rows.length, 5, "existing outer blanks and three native rows only");
  assert.equal(rows[0], ""); assert.equal(rows.at(-1), "");
  assert.match(stripVTControlCharacters(rows[2]), /^ hello/);
  assert.equal(visibleWidth(rows[2].slice(0, rows[2].indexOf(CURSOR_MARKER))), 6);
  assert.equal(editor.getText(), "hello", "padding is geometry, not inserted text");
  editor.handleInput("\x05"); editor.handleInput("\n"); editor.handleInput("world");
  rows = editor.render(100);
  assert.equal(rows.length, 6, "multiline input adds only its native text row");
  assert.match(stripVTControlCharacters(rows[2]), /^ hello/);
  assert.match(stripVTControlCharacters(rows[3]), /^ world/);
  assert.equal(visibleWidth(rows[3].slice(0, rows[3].indexOf(CURSOR_MARKER))), 6);
  assert.ok(rows.every(line => visibleWidth(line) <= 100));
  assert.deepEqual(f.footer.render(100), []);
});

test("real host appearance copying cannot remove or expand the one-column input inset", async t => {
  const f = await hostFixture(t);
  const editor = f.host.editor;
  assert.equal(f.host.defaultEditor.getPaddingX(), 0, "host starts with native zero padding");
  editor.handleInput("host draft");
  let rows = editor.render(100);
  assert.match(stripVTControlCharacters(rows[2]), /^ host draft/);
  assert.equal(editor.getPaddingX(), 1);
  f.host.defaultEditor.setPaddingX(3);
  editor.setPaddingX(3); // Same public appearance update used by the host.
  rows = editor.render(100);
  assert.match(stripVTControlCharacters(rows[2]), /^ host draft/);
  assert.equal(editor.getPaddingX(), 1, "local inset stays one column after native appearance updates");
  assert.equal(f.host.defaultEditor.getPaddingX(), 3, "the extension never changes native host settings");
  assert.equal(editor.getText(), "host draft");
});

test("native padded wrapping, cursor geometry and Unicode stay bounded through narrow resizes", async t => {
  const f = await fixture(t);
  const editor = f.editor;
  const style = value => value;
  const native = new CustomEditor(f.tui, {
    borderColor: style,
    selectList: { selectedPrefix: style, selectedText: style, description: style, scrollInfo: style, noMatch: style },
  }, f.keybindings, { paddingX: 1 });
  editor.focused = native.focused = true;
  for (const value of ["", "hello world\nnext", "界e\u0301🙂界\n界🙂"]) {
    editor.setText(value); native.setText(value);
    // A two-column grapheme cannot fit a one-column terminal, even natively.
    const widths = value.includes("界") ? [3, 4, 5, 8, 16, 40, 100, 3, 100] : value ? [2, 3, 4, 8, 40, 100, 2, 100] : [1, 2, 3, 4, 100];
    for (const width of widths) {
      native.setPaddingX(width >= 4 ? 1 : 0);
      const rows = editor.render(width);
      const reference = native.render(width);
      assert.deepEqual(rows.slice(2, -2), reference.slice(1, -1), `${width}: native text wrapping and cursor are unchanged`);
      assert.ok(rows.every(line => visibleWidth(line) <= width), `${width}: ${JSON.stringify(rows)}`);
      assert.equal(rows[0], ""); assert.equal(rows.at(-1), "");
      assert.equal(editor.getText(), value);
      assert.equal(editor.getPaddingX(), width >= 4 ? 1 : 0);
    }
  }
});

test("keep-awake mode adds only a leading cup with bounded native borders and plain fallback", async t => {
  environment(t, { TERM: "xterm-256color", NO_COLOR: undefined, PI_NERD_FONTS: "0" });
  const off = await fixture(t);
  assert.doesNotMatch(stripVTControlCharacters(off.editor.render(150)[1]), /☕|\[awake\]/);
  const f = await fixture(t, true);
  for (const appearance of ["dark", "light"]) {
    f.theme(appearance); f.editor.invalidate();
    const lines = f.lines(150);
    assert.equal(lines.length, 5, "no extra status row");
    assert.match(stripVTControlCharacters(lines[1]), /^─ ☕─ DeepSeek V4 Pro high › pi-playground /);
    assert.equal(visibleWidth(lines[1]), 150, "metrics remain aligned to the right edge");
    assert.deepEqual(f.footer.render(150), []);
  }
  f.editor.setWorkingStatusIndicator({ renderInBorder: () => "Working", renderSpinnerInBorder: () => "*" });
  assert.match(stripVTControlCharacters(f.editor.render(150)[1]), /☕.*Working/);
  for (const width of [1, 2, 8, 15, 16, 20, 30, 40, 80, 150]) {
    assert.ok(f.editor.render(width).every(line => visibleWidth(line) <= width), `width ${width}`);
  }
  for (const [key, value] of [["NO_COLOR", "1"], ["TERM", "dumb"]]) {
    process.env[key] = value;
    const row = f.editor.render(150)[1];
    assert.ok(row.startsWith("- [awake] - DeepSeek V4 Pro high > pi-playground "));
    assert.doesNotMatch(row.slice(0, row.indexOf("pi-playground")), /\x1b/);
    for (const width of [8, 16, 20, 40, 150]) assert.ok(f.editor.render(width).every(line => visibleWidth(line) <= width));
    delete process.env.NO_COLOR;
  }
});

test("thinking is separately colored beside the model and follows live selection without replacing the editor", async t => {
  environment(t, { TERM: "xterm-256color", NO_COLOR: undefined, PI_NERD_FONTS: "0" });
  const f = await fixture(t);
  const editor = f.editor;
  editor.setText("preserved draft");
  const fieldColor = (line, field) => [...line.slice(0, line.indexOf(field)).matchAll(/\x1b\[[0-9;]*m/g)].at(-1)?.[0];
  for (const name of ["dark", "light"]) {
    f.theme(name); editor.invalidate();
    const row = editor.render(100)[1];
    assert.match(stripVTControlCharacters(row), /DeepSeek V4 Pro high › pi-playground/);
    assert.notEqual(fieldColor(row, "DeepSeek"), fieldColor(row, "high"), `${name}: model and thinking colors differ`);
    assert.ok(fieldColor(row, "high"));
  }
  const before = f.renders;
  await emit(f.extension, "thinking_level_select", f.ctx, { level: "xhigh" });
  assert.equal(f.renders, before + 1);
  assert.match(stripVTControlCharacters(editor.render(100)[1]), /DeepSeek V4 Pro xhi ›/);
  assert.deepEqual(f.footer.render(150), []);
  // The event is the fresh source; ctx may still contain the previous level.
  assert.equal(f.ctx.thinkingLevel, "high");
  const next = { ...f.ctx, thinkingLevel: "off", model: { ...f.ctx.model, name: "New Model" } };
  await emit(f.extension, "model_select", next);
  assert.match(stripVTControlCharacters(editor.render(100)[1]), /New Model thinking off ›/);
  next.model = { ...next.model, reasoning: false };
  await emit(f.extension, "model_select", next);
  assert.match(stripVTControlCharacters(editor.render(100)[1]), /New Model ›/);
  assert.equal(f.editor, editor);
  assert.equal(editor.getText(), "preserved draft");
  next.model = { ...next.model, reasoning: true };
  await emit(f.extension, "model_select", next);
  editor.setText(""); // Native nonempty editor lanes need at least two columns.
  for (const width of [1, 2, 3, 7, 8, 10, 12, 20, 40, 80, 100]) {
    assert.ok(editor.render(width).every(line => visibleWidth(line) <= width), String(width));
  }
  process.env.NO_COLOR = "1";
  assert.ok(editor.render(100)[1].startsWith("- New Model thinking off > pi-playground "));
  assert.ok(!/\x1b/.test(editor.render(100)[1].split("pi-playground")[0]), "breadcrumb is uncolored");
  delete process.env.NO_COLOR; process.env.TERM = "dumb";
  assert.ok(editor.render(100)[1].startsWith("- New Model thinking off > pi-playground "));
});

test("all native input, cursor editing, multiline submit, history and bracketed paste are unchanged", async t => {
  const f = await fixture(t);
  const e = f.editor;
  assert.ok(e instanceof CustomEditor);
  // The wrapper only restores missing history, then delegates every key to CustomEditor.
  e.handleInput("hello"); e.handleInput("\x1b[D"); e.handleInput("!");
  assert.equal(e.getText(), "hell!o");
  e.handleInput("\x05"); e.handleInput("\n"); e.handleInput("world");
  assert.equal(e.getText(), "hell!o\nworld");
  let submitted;
  e.onSubmit = value => { submitted = value; };
  e.handleInput("\r");
  assert.equal(submitted, "hell!o\nworld");
  e.addToHistory("older prompt"); e.setText("");
  e.render(100); e.handleInput("\x1b[A");
  assert.equal(e.getText(), "older prompt");
  assert.match(plainInput(e.render(100)[2]), /^ older prompt/, "history uses the native padded text lane");
  e.handleInput("\x1b[B"); assert.equal(e.getText(), "");
  const pasted = "pasted\n".repeat(20);
  e.handleInput("\x1b[200~" + pasted + "\x1b[201~");
  assert.equal(e.getExpandedText(), pasted);
  assert.ok(e.render(8).every(line => visibleWidth(line) <= 8), "bracketed-paste rendering respects the padded width");
  e.insertTextAtCursor("[image:1]");
  assert.ok(e.getExpandedText().includes("[image:1]"));
});

test("app actions, extension shortcuts, clipboard image paste and autocomplete keep native dispatch", async t => {
  const f = await fixture(t);
  const e = f.editor;
  let escaped = 0, images = 0, actions = 0, shortcuts = 0;
  e.onEscape = () => escaped++;
  e.onPasteImage = () => images++;
  e.onAction("app.model.select", () => actions++);
  e.onExtensionShortcut = key => { if (key === "!") { shortcuts++; return true; } return false; };
  e.handleInput("\x1b"); e.handleInput("\x16"); e.handleInput("\x0c"); e.handleInput("!");
  assert.deepEqual([escaped, images, actions, shortcuts], [1, 1, 1, 1]);
  assert.equal(e.getText(), "");
  let completed = 0;
  e.setAutocompleteProvider({
    async getSuggestions() { return { prefix: "he", items: [{ value: "hello", label: "hello" }, { value: "help", label: "help" }] }; },
    applyCompletion(_lines, _line, _col, item) { completed++; return { lines: [item.value], cursorLine: 0, cursorCol: item.value.length }; },
  });
  e.setText("he"); e.render(100); e.handleInput("\t");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(e.isShowingAutocomplete(), true);
  assert.ok(e.render(100).length > 5, "native completion menu can temporarily extend the input");
  e.handleInput("\x1b");
  assert.equal(e.isShowingAutocomplete(), false);
  assert.equal(escaped, 1, "escape closes completions before aborting");
  e.handleInput("\t"); await new Promise(resolve => setImmediate(resolve));
  e.handleInput("\t");
  assert.equal(completed, 1);
  assert.equal(e.getText(), "hello");
});

test("outer spacing translates native text and autocomplete mouse coordinates", async t => {
  const f = await fixture(t);
  const editor = f.editor;
  editor.focused = true;
  editor.setText("hello\nworld");
  let rows = editor.render(100);
  const click = (x, y) => editor.handleMouse({ type: "click", button: "left", x, y, width: 100, height: rows.length });
  assert.equal(click(0, 2)?.handled, true, "left-padding clicks clamp to the start of native text");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  assert.equal(click(1, 2)?.handled, true);
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  assert.equal(click(3, 2)?.handled, true);
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  assert.equal(click(2, 3)?.handled, true);
  assert.deepEqual(editor.getCursor(), { line: 1, col: 1 });
  const cursor = editor.getCursor();
  assert.equal(click(0, 0), undefined, "top whitespace is not an input row");
  assert.equal(click(0, rows.length - 1), undefined, "bottom whitespace is not an input row");
  assert.deepEqual(editor.getCursor(), cursor);
  assert.ok(rows[3].includes(CURSOR_MARKER), "cursor marker tracks native second line");
  let completed;
  editor.setAutocompleteProvider({
    async getSuggestions() { return { prefix: "he", items: [{ value: "hello", label: "hello" }, { value: "help", label: "help" }] }; },
    applyCompletion(_lines, _line, _col, item) { completed = item.value; return { lines: [item.value], cursorLine: 0, cursorCol: item.value.length }; },
  });
  editor.setText("he"); editor.render(100); editor.handleInput("\t");
  await new Promise(resolve => setImmediate(resolve));
  rows = editor.render(100);
  const choiceRow = rows.findIndex(line => stripVTControlCharacters(line).includes("help"));
  assert.ok(choiceRow >= 4, "completion remains below the shifted bottom border");
  assert.ok(stripVTControlCharacters(rows[choiceRow]).startsWith(" "), "native completion list shares the text inset");
  for (const width of [4, 8, 16, 40, 100]) {
    assert.ok(editor.render(width).every(line => visibleWidth(line) <= width), `${width}: padded completions stay bounded`);
  }
  rows = editor.render(100);
  assert.equal(click(4, choiceRow)?.handled, true);
  assert.equal(completed, "help");
  assert.equal(editor.getText(), "help");
  assert.equal(editor.render(100).at(-1), "");
  editor.setText("界e\u0301🙂"); rows = editor.render(100);
  assert.equal(click(1, 2)?.handled, true);
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  assert.equal(click(3, 2)?.handled, true);
  assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
  assert.equal(click(4, 2)?.handled, true);
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 }, "native grapheme hit testing includes the left inset");
  rows = editor.render(100);
  assert.match(plainInput(rows[2]), /^ 界e\u0301🙂/);
  assert.equal(visibleWidth(rows[2].slice(0, rows[2].indexOf(CURSOR_MARKER))), 4, "IME cursor follows the native wide/combining click position");
});

test("working status embeds in the SAME frame; scroll indicators, Unicode, resize and theme changes stay bounded", async t => {
  environment(t, { TERM: "xterm-256color", NO_COLOR: undefined, PI_NERD_FONTS: "0" });
  const f = await fixture(t);
  const e = f.editor;
  assert.equal(e.embedWorkingStatus, true, "Pi does not allocate a standalone working indicator row");
  e.setWorkingStatusIndicator({ renderInBorder: () => "Working", renderSpinnerInBorder: () => "*" });
  const busy = e.render(100).map(stripVTControlCharacters);
  assert.equal(busy.length, 5);
  assert.ok(busy[1].includes("DeepSeek V4 Pro") && busy[1].includes("Working"));
  e.setWorkingStatusIndicator(undefined);
  e.setText(Array.from({ length: 30 }, (_, i) => `${i} 界e\u0301🙂`).join("\n"));
  let rows = e.render(100).map(stripVTControlCharacters);
  assert.match(rows[1], /↑ \d+ more/);
  e.handleInput("\x01"); e.handleInput("\x1b[H");
  // Native Editor cannot wrap a two-column grapheme into a one-column text lane.
  // Keep that upstream behavior; usable narrow frames, and every footer, remain bounded.
  for (const width of [3, 8, 10, 20, 40, 100, 150]) {
    rows = e.render(width);
    assert.ok(rows.every(line => visibleWidth(line) <= width), `${width}: ${JSON.stringify(rows)}`);
    assert.deepEqual(f.footer.render(width), []);
  }
  e.setText("");
  for (const width of [1, 2]) assert.ok(e.render(width).every(line => visibleWidth(line) <= width));
  const dark = e.render(100);
  f.theme("light"); e.invalidate();
  const light = e.render(100);
  assert.notEqual(light[1], dark[1]);
  assert.equal(stripVTControlCharacters(light[1]), stripVTControlCharacters(dark[1]));
  f.ctx.model = { ...f.ctx.model, name: "New Model" };
  f.ctx.cwd = "/new/location";
  await emit(f.extension, "model_select", f.ctx);
  assert.match(stripVTControlCharacters(e.render(100)[1]), /New Model high › location/);
});

test("border text sanitizes untrusted model/path and has ASCII/uncolored fallback", async t => {
  environment(t, { TERM: "xterm", NO_COLOR: undefined, PI_NERD_FONTS: "0" });
  const f = await fixture(t);
  f.ctx.model.name = "safe\x1b[2J\x1b]0;evil\x07model\r\n界";
  f.ctx.cwd = "/work/folder\x1b]52;c;bad\x07\tname";
  let line = f.editor.render(100)[1];
  assert.ok(!/\x1b\]|\x1b\[2J|[\r\n\t]/.test(line));
  assert.ok(stripVTControlCharacters(line).includes("safemodel"));
  process.env.NO_COLOR = "1";
  f.ctx.model.name = "Model"; f.ctx.cwd = "/work/folder";
  const lines = f.lines(100);
  assert.deepEqual(f.footer.render(100), []);
  assert.ok(lines[1].startsWith("- Model high > folder "), "local breadcrumb decoration uncolored; remaining native border keeps its styling");
});

test("stats share the top border with native busy/overflow cues, stay live, and never add a row", async t => {
  environment(t, { TERM: "xterm-256color", NO_COLOR: undefined, PI_NERD_FONTS: "0" });
  const f = await fixture(t);
  const editor = f.editor;
  f.ctx.model.name = "GPT-6 Astra"; f.ctx.cwd = "/work/Projects";
  f.ctx.getContextUsage = () => ({ tokens: 134912, contextWindow: 272000, percent: 49.6 });
  f.ctx.modelRegistry = { isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }) };
  f.entries[0].message.usage = { input: 2200000, output: 317000, cacheRead: 58000000, cacheWrite: 123000, cost: { total: 32.448 } };
  f.statuses.clear(); f.statuses.set("compact-tools:chat-timer", "1h 16m");
  f.statuses.set("mcp", "MCP 6 registered"); f.statuses.set("subagents", "6 agents running");
  const fields = ["135k/272k", "↑2.2M", "↓317k", "~$32", "1h 16m"];
  const fieldColor = (line, field) => [...line.slice(0, line.indexOf(field)).matchAll(/\x1b\[[0-9;]*m/g)].at(-1)?.[0];
  const palettes = [];
  for (const name of ["dark", "light"]) {
    f.theme(name); editor.invalidate(); f.footer.invalidate();
    const row = editor.render(150)[1];
    const text = stripVTControlCharacters(row);
    assert.match(text, /^─ GPT-6 Astra high › Projects /);
    for (const field of fields) assert.ok(text.includes(field), field);
    assert.doesNotMatch(text, /% to compact/, "default cutoff hides the countdown while more than 20% remains");
    assert.ok(text.endsWith("1h 16m"));
    assert.ok(!/MCP|agents running|R58M|W123k|CH|\(sub\)/.test(text));
    const colors = fields.map(field => fieldColor(row, field));
    assert.equal(new Set(colors).size, 5);
    palettes.push(colors);
    assert.equal(editor.render(150).length, 5);
    assert.deepEqual(f.footer.render(150), []);
  }
  assert.ok(palettes[0].every((color, index) => color !== palettes[1][index]));
  f.statuses.set("compact-tools:chat-timer", "1h 17m");
  assert.ok(stripVTControlCharacters(editor.render(150)[1]).endsWith("1h 17m"));
  editor.setWorkingStatusIndicator({ renderInBorder: () => "Working", renderSpinnerInBorder: () => "*" });
  let rows = editor.render(150).map(stripVTControlCharacters);
  assert.ok(rows[1].includes("Working"));
  for (const field of fields.slice(0, -1)) assert.ok(rows[1].includes(field), field);
  editor.setText(Array.from({ length: 30 }, (_, i) => `${i} 界e\u0301🙂`).join("\n"));
  rows = editor.render(150).map(stripVTControlCharacters);
  assert.match(rows[1], /↑ \d+ more/);
  assert.ok(rows[1].includes("Working") || rows[1].includes("*"), "Pi chooses the native spinner when both cues compete");
  assert.ok(rows[1].endsWith("1h 17m"));
  for (const width of [3, 8, 15, 16, 20, 25, 40, 60, 80, 100, 150]) {
    assert.ok(editor.render(width).every(line => visibleWidth(line) <= width), String(width));
    assert.deepEqual(f.footer.render(width), []);
  }
  editor.setText(""); editor.setWorkingStatusIndicator(undefined);
  for (const [key, value] of [["NO_COLOR", "1"], ["TERM", "dumb"]]) {
    process.env[key] = value;
    const row = editor.render(150)[1];
    assert.ok(stripVTControlCharacters(row).includes("in:2.2M"));
    assert.ok(!row.slice(row.indexOf("135k/272k")).includes("\x1b"), "stats are uncolored");
  }
  if (process.env.COMPACT_INPUT_SAMPLE_DIR) {
    delete process.env.NO_COLOR; process.env.TERM = "xterm-256color"; f.theme("dark");
    mkdirSync(process.env.COMPACT_INPUT_SAMPLE_DIR, { recursive: true });
    for (const width of [100, 150]) {
      const ansi = f.lines(width).map(line => line.replaceAll(CURSOR_MARKER, "")
        .replaceAll("\x1b_pi:fc\x07", "\x1b[7m").replaceAll("\x1b_pi:/fc\x07", "\x1b[27m")).join("\n") + "\n";
      writeFileSync(join(process.env.COMPACT_INPUT_SAMPLE_DIR, `requested-${width}.ansi`), ansi);
      writeFileSync(join(process.env.COMPACT_INPUT_SAMPLE_DIR, `requested-${width}.txt`), stripVTControlCharacters(ansi));
    }
  }
});

test("live compaction thresholds and rounded costs agree in the input border and fallback across themes/plain/narrow widths", async t => {
  environment(t, { TERM: "xterm-256color", NO_COLOR: undefined, PI_NERD_FONTS: "0" });
  const f = await fixture(t, true);
  f.statuses.clear(); f.statuses.set("compact-tools:chat-timer", "12m");
  let contextReads = 0, entryReads = 0, leaf = "initial";
  f.ctx.getContextUsage = () => { contextReads++; return { tokens: 203000, contextWindow: 272000, percent: 1 }; };
  f.ctx.sessionManager.getEntries = () => { entryReads++; return f.entries; };
  f.ctx.sessionManager.getLeafId = () => leaf;
  f.settings.compaction = { enabled: true, reserveTokens: 22000 };
  f.entries[0].message.usage.cost.total = 97.9;
  f.ctx.modelRegistry = { isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }) };
  const fields = ["203k/272k", "19% to compact", "~$98"];
  for (const name of ["dark", "light"]) {
    f.theme(name); f.editor.invalidate(); f.footer.invalidate();
    const row = f.editor.render(150)[1];
    for (const field of fields) assert.ok(stripVTControlCharacters(row).includes(field), `${name}: ${field}`);
    assert.match(stripVTControlCharacters(row), /^─ ☕─/);
    assert.equal(visibleWidth(row), 150);
    assert.equal(f.editor.render(150).length, 5);
  }
  const contextBefore = contextReads, entriesBefore = entryReads;
  f.settings.compaction.reserveTokens = 72000;
  assert.ok(stripVTControlCharacters(f.editor.render(150)[1]).includes("0% to compact"));
  f.settings.compaction.enabled = false;
  assert.match(stripVTControlCharacters(f.editor.render(150)[1]), /auto off/);
  assert.doesNotMatch(stripVTControlCharacters(f.editor.render(150)[1]), /% to compact/);
  f.settings.compaction.enabled = true;
  f.settings.compaction.modelOverrides = { "test/test-model": { reserveTokens: 22000 } };
  assert.ok(stripVTControlCharacters(f.editor.render(150)[1]).includes("19% to compact"));
  assert.equal(contextReads, contextBefore, "effective settings changes retain the context projection cache");
  assert.equal(entryReads, entriesBefore, "effective settings changes retain precise cumulative accounting");
  for (const [key, value] of [["NO_COLOR", "1"], ["TERM", "dumb"]]) {
    process.env[key] = value;
    const row = f.editor.render(150)[1];
    for (const field of fields) assert.ok(stripVTControlCharacters(row).includes(field));
    assert.doesNotMatch(row.slice(row.indexOf("203k/272k")), /\x1b/);
    for (let width = 1; width <= 160; width++) assert.ok(f.editor.render(width).every(line => visibleWidth(line) <= width));
    delete process.env.NO_COLOR;
  }
  f.ctx.ui.setEditorComponent((tui, theme, keys) => new CustomEditor(tui, theme, keys));
  const fallback = f.footer.render(150);
  assert.equal(fallback.length, 1);
  for (const field of fields) assert.ok(stripVTControlCharacters(fallback[0]).includes(field), field);
  f.ctx.modelRegistry = { isUsingOAuth: () => false };
  for (const [cost, expected] of [[.1, "$0"], [.6, "$1"], [97.9, "$98"]]) {
    f.entries[0].message.usage.cost.total = cost; leaf = String(cost);
    const row = stripVTControlCharacters(f.footer.render(150)[0]);
    assert.ok(row.includes(` ${expected} `), row);
    assert.doesNotMatch(row, /\$\d+\./);
    assert.equal(f.entries[0].message.usage.cost.total, cost);
  }
  for (let width = 1; width <= 160; width++) assert.ok(f.footer.render(width).every(line => visibleWidth(line) <= width));
});

test("input-border countdown honors default, zero, full and custom cutoffs without stale notice text", async t => {
  environment(t, { TERM: "xterm-256color", NO_COLOR: undefined, PI_NERD_FONTS: "0" });
  for (const [cutoff, cases] of [
    [undefined, [[79999, undefined], [80000, 20], [99999, 1], [100000, 0], [50000, undefined]]],
    [0, [[99999, undefined], [100000, 0]]],
    [100, [[0, 100], [50000, 50]]],
    [7, [[92999, undefined], [93000, 7]]],
  ]) {
    const f = await fixture(t, false, cutoff);
    f.statuses.clear();
    f.settings.compaction = { reserveTokens: 100000 };
    let tokens = 0;
    f.ctx.getContextUsage = () => ({ tokens, contextWindow: 200000 });
    f.ctx.sessionManager.getLeafId = () => String(tokens);
    for (const [nextTokens, countdown] of cases) {
      tokens = nextTokens;
      const rows = f.lines(150);
      const row = stripVTControlCharacters(rows[1]);
      assert.equal(rows.length, 5);
      assert.equal(visibleWidth(rows[1]), 150);
      assert.match(row, /\/200k/);
      if (countdown === undefined) assert.doesNotMatch(row, /% to compact/);
      else assert.match(row, new RegExp(`(?:^| )${countdown}% to compact(?: |$)`));
      assert.deepEqual(f.footer.render(150), []);
    }
    f.settings.compaction.reserveTokens = 200000; // Invalid/nonpositive trigger cannot leave an old countdown.
    assert.doesNotMatch(stripVTControlCharacters(f.editor.render(150)[1]), /% to compact/);
    await emit(f.extension, "session_shutdown", f.ctx);
  }
});

test("replacing the editor restores a single stats fallback row without taking the new editor's ownership", async t => {
  environment(t, { TERM: "xterm-256color", NO_COLOR: undefined, PI_NERD_FONTS: "0" });
  const f = await fixture(t);
  assert.deepEqual(f.footer.render(150), []);
  const ours = f.factory;
  const replacement = (tui, theme, keys) => new CustomEditor(tui, theme, keys);
  f.ctx.ui.setEditorComponent(replacement);
  const rows = f.footer.render(150);
  assert.equal(rows.length, 1);
  for (const field of ["31k/1.0M", "↑19k", "↓7.6k", "$0", "12m"]) assert.ok(stripVTControlCharacters(rows[0]).includes(field), field);
  f.statuses.set("compact-tools:chat-timer", "13m");
  assert.ok(stripVTControlCharacters(f.footer.render(150)[0]).includes("13m"));
  f.ctx.ui.setEditorComponent(ours);
  assert.deepEqual(f.footer.render(150), [], "reactivating our editor removes the fallback row");
  f.ctx.ui.setEditorComponent(replacement);
  await emit(f.extension, "session_shutdown", f.ctx);
  assert.equal(f.factory, replacement);
});

test("shutdown restores previous editor only while our factory still owns the public slot", async t => {
  const f = await fixture(t);
  const previous = () => undefined;
  await emit(f.extension, "session_shutdown", f.ctx);
  f.ctx.ui.setEditorComponent(previous);
  await emit(f.extension, "session_start", f.ctx);
  assert.notEqual(f.factory, previous);
  await emit(f.extension, "session_shutdown", f.ctx);
  assert.equal(f.factory, previous);
  await emit(f.extension, "session_start", f.ctx);
  const replacement = () => undefined;
  f.ctx.ui.setEditorComponent(replacement);
  await emit(f.extension, "session_shutdown", f.ctx);
  assert.equal(f.factory, replacement, "later extensions retain their editor");
});

test("real host reload restores chronological active-branch history without startup duplication or losing the draft", async t => {
  const f = await hostFixture(t);
  const user = content => ({ type: "message", message: { role: "user", content } });
  const branch = [
    user("first prompt"),
    user([{ type: "text", text: "multi" }, { type: "image", data: "image", mimeType: "image/png" }, { type: "text", text: "block" }]),
    { type: "custom_message", customType: "control", content: "not an input", display: false },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "not user history" }] } },
    user("last prompt"), user("last prompt"),
    user([{ type: "image", data: "image", mimeType: "image/png" }]),
    { ...user("extension user followup"), source: "extension" },
  ];
  f.ctx.sessionManager.getEntries = () => [...branch, user("abandoned branch prompt")];
  let branchReads = 0;
  f.ctx.sessionManager.getBranch = () => { branchReads++; return branch; };
  // The native initial renderer calls addToHistory in this order after session_start.
  for (const entry of branch) if (entry.type === "message" && entry.message.role === "user") {
    f.host.editor.addToHistory(f.host.getUserMessageText(entry.message));
  }
  const browse = () => {
    const editor = f.host.editor;
    editor.setText(""); editor.render(100);
    for (const expected of ["extension user followup", "last prompt", "multiblock", "first prompt", "first prompt"]) {
      editor.handleInput("\x1b[A");
      assert.equal(editor.getText(), expected);
      // Keep the cursor on the first logical line for native Up history navigation.
      editor.handleInput("\x01");
    }
  };
  browse();
  assert.equal(branchReads, 0, "host-populated startup history is not seeded a second time");
  let active = f.extension;
  t.after(() => emit(active, "session_shutdown", f.ctx));
  for (let reload = 0; reload < 2; reload++) {
    f.host.editor.setText("unsubmitted draft");
    await emit(active, "session_shutdown", f.ctx, { reason: "reload" });
    const loaded = await loadExtensions([extensionPath], scratch);
    assert.deepEqual(loaded.errors, []);
    active = loaded.extensions[0];
    await emit(active, "session_start", f.ctx);
    assert.equal(f.host.editor.getText(), "unsubmitted draft", "real host transfers the existing draft");
    const before = branchReads;
    browse();
    assert.equal(branchReads, before + 1, "rehydrate once per replacement, never on every key/frame");
  }
});

test("assigned native border functions survive renders, and real host ! bash/thinking colors remain visible", async t => {
  environment(t, { TERM: "xterm-256color", NO_COLOR: undefined, PI_NERD_FONTS: "0" });
  const f = await hostFixture(t);
  const editor = f.host.editor;
  const assigned = text => `\x1b[35m${text}\x1b[39m`;
  editor.borderColor = assigned;
  for (const width of [20, 100, 150]) {
    const lines = editor.render(width);
    assert.equal(editor.borderColor, assigned);
    assert.ok(lines[1].includes("\x1b[35m"));
    assert.equal(lines.at(-2), assigned("─".repeat(width)));
  }
  editor.setText("!echo test");
  assert.equal(f.host.isBashMode, true, "real host onChange enters bash mode");
  const bashBorder = editor.borderColor;
  for (let i = 0; i < 3; i++) {
    const lines = editor.render(100);
    assert.equal(editor.borderColor, bashBorder);
    assert.equal(lines.at(-2), themeModule.theme.getBashModeBorderColor()("─".repeat(100)));
  }
  editor.setText("ordinary input");
  assert.equal(f.host.isBashMode, false);
  const thinkingBorder = editor.borderColor;
  const lines = editor.render(100);
  assert.equal(editor.borderColor, thinkingBorder);
  assert.equal(lines.at(-2), themeModule.theme.getThinkingBorderColor("high")("─".repeat(100)));
  assert.notEqual(lines.at(-2), bashBorder("─".repeat(100)));
});
