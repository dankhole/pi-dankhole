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
const tuiPath = dirname(requirePi.resolve("@earendil-works/pi-tui"));
const { Container, MouseRegion, Text } = await import(pathToFileURL(join(tuiPath, "index.js")).href);
const { renderLayoutFrame } = await import(pathToFileURL(join(tuiPath, "layout.js")).href);
const { createChatViewport } = await fromPi("dist/modes/interactive/chat-viewport.js");
const { UserMessageComponent } = await fromPi("dist/modes/interactive/components/user-message.js");
const { ToolExecutionComponent } = await fromPi("dist/modes/interactive/components/tool-execution.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
themes.initTheme("dark", false);
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
  "@earendil-works/pi-tui": requirePi.resolve("@earendil-works/pi-tui"),
} });
const source = path => jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src", path));
const { freshTranscriptChildren, isTranscriptRendererSupported, registerTranscriptRenderer, TranscriptMeasurement, withTranscriptMeasurement } = await source("styling/transcript-measurement.ts");
const { installPinnedPrompt } = await source("styling/pinned-prompt.ts");
const { installGrouping } = await source("styling/grouping.ts");
const { installAssistantPanels } = await source("styling/assistant-panels.ts");
const { QUESTION_CONTENT, questionListVisibility } = await source("questions/question-viewport.ts");

function fixture({ pin = true, grouping = true, count = 60, reminder = true, panels = false } = {}) {
  const chat = new Container();
  const header = new Container(); header.addChild(new Text("Header", 0, 0));
  const document = new Container();
  document.addChild(header); document.addChild(new Container()); document.addChild(chat);
  const user = new UserMessageComponent("Selected prompt"); chat.addChild(user);
  const pending = { toolCallId: `question-${count - 1}` };
  let nativeRenders = 0;
  let cardRenders = 0;
  let metadataReads = 0;
  const cards = [];
  const rendererDisposers = [];
  const definition = { renderShell: "self", renderCall: () => new Text("Ask user", 0, 0),
    renderResult: (_result, _options, _theme, context) => ({
      invalidate() {},
      render() { cardRenders++; return [`Question ${context.toolCallId}?`]; },
      [QUESTION_CONTENT]() { metadataReads++; return context.toolCallId === pending.toolCallId ? { identity: pending, rows: [0] } : undefined; },
    }),
  };
  for (let index = 0; index < count; index++) {
    const card = new ToolExecutionComponent("ask_user", `question-${index}`, {}, { showImages: false }, definition, { requestRender() {} }, process.cwd());
    card.updateResult({ content: [{ type: "text", text: "question" }], details: undefined, isError: false });
    const render = card.render;
    assert.equal(isTranscriptRendererSupported(card), true);
    card.render = function(width) { nativeRenders++; return render.call(this, width); };
    rendererDisposers.push(registerTranscriptRenderer(card, card.render));
    cards.push(card); chat.addChild(card);
  }
  const widgetsAbove = new Container();
  const viewport = createChatViewport({ document, pendingMessages: new Container(), status: new Container(), widgetsAbove,
    editor: new Text("Editor", 0, 0), footer: new Text("Footer", 0, 0), scrollbar: "hidden" });
  const tui = { mode: "fullscreen", children: [document], layoutRoot: viewport.root, terminal: { columns: 90, rows: 20 }, requestRender() {} };
  const disposeGrouping = installGrouping(tui, { groupConsecutive: grouping, defaultMode: "compact", tools: {}, backgrounds: "tool" },
    { theme: () => themes.theme, requestRender() {}, warn(message) { assert.fail(message); } });
  const disposePanels = panels ? installAssistantPanels(tui, { theme: () => themes.theme, requestRender() {}, warn: assert.fail }) : () => {};
  const pinned = pin ? installPinnedPrompt(tui, () => themes.theme,
    () => ({ id: "prompt", text: "Selected prompt", displayed: true, rows: [{ id: "prompt", kind: "UserMessageComponent" }] }), assert.fail) : undefined;
  const show = questionListVisibility(tui, [pending]);
  if (reminder) widgetsAbove.addChild({ invalidate() {}, render(width) { return show(width) ? ["Questions reminder"] : []; } });
  return { tui, chat, cards, pending, document, viewport, show, user, widgetsAbove,
    frame() { return renderLayoutFrame(viewport.root, tui.terminal.columns, tui.terminal.rows, () => {}); },
    reset() { nativeRenders = 0; cardRenders = 0; metadataReads = 0; },
    counts() { return { nativeRenders, cardRenders, metadataReads }; },
    dispose() { show.dispose(); pinned?.dispose(); disposePanels(); disposeGrouping(); for (const dispose of rendererDisposers) dispose(); },
  };
}

test("one visibility calculation shares a fresh transcript pass with nested pinning", t => {
  for (const pin of [false, true]) for (const grouping of [false, true]) {
    const f = fixture({ pin, grouping });
    try {
      f.frame(); f.reset();
      assert.equal(f.show(90), false, "last pending question is visible at follow-end");
      assert.deepEqual(f.counts(), { nativeRenders: 60, cardRenders: 60, metadataReads: 1 },
        "each historical native/card renderer runs once; only pending metadata is inspected");
      f.reset();
      f.frame();
      const counts = f.counts();
      assert.equal(counts.cardRenders, counts.nativeRenders, "metadata traversal never rerenders a card body");
      assert.ok(counts.nativeRenders <= 4 * 60, "bounded native layout/visibility passes, independent of history size");
      t.diagnostic(`pin=${pin}, grouping=${grouping}: ${counts.nativeRenders / 60} native/card render passes per fullscreen frame`);
    } finally { f.dispose(); }
  }
});

test("pin-only follow-end measures a bounded fresh suffix with owned grouping and panel projections too", () => {
  const counts = [];
  for (const grouping of [false, true]) for (const panels of [false, true]) for (const count of [60, 600]) {
    const f = fixture({ grouping, panels, count, reminder: false });
    try {
      f.frame(); f.reset();
      const entry = f.viewport.root.entries[0];
      for (let index = 0; index < 10; index++) assert.equal(entry.visible({ width: 90, height: 20 }), true);
      const measured = f.counts();
      assert.equal(measured.cardRenders, measured.nativeRenders);
      assert.equal(measured.metadataReads, 0);
      assert.equal(measured.nativeRenders, 60,
        "each of ten calculations freshly renders six native self-shell cards, independent of history size");
      counts.push(measured.nativeRenders);
      f.reset();
      f.viewport.transcript.scrollToStart();
      assert.equal(entry.visible({ width: 90, height: 20 }), false);
      assert.equal(f.counts().nativeRenders, count, "manual scrolling uses fresh full coordinates immediately");
    } finally { f.dispose(); }
  }
  assert.ok(counts.every(count => count === counts[0]), "history size and owned wrappers do not increase suffix rendering work");
});

test("default panels/grouping/pin bound actual grouped suffix rendering; pending reminders retain one shared pass", () => {
  for (const reminder of [false, true]) for (const count of [60, 600]) {
    const f = fixture({ grouping: true, panels: true, count, reminder });
    try {
      f.chat.children = [f.user, ...f.cards.flatMap((card, index) => {
        const tools = [0, 1].map(part => {
          const tool = new ToolExecutionComponent("bash", `grouped-${index}-${part}`, {}, { showImages: false }, undefined, { requestRender() {} }, process.cwd());
          tool.updateResult({ content: [{ type: "text", text: "done" }], details: undefined, isError: false });
          return tool;
        });
        return [...tools, card];
      })];
      f.frame();
      const groups = freshTranscriptChildren(f.chat).filter(child => child.constructor.name === "ToolGroup");
      assert.equal(groups.length, count, "the fixture contains real collapsed groups between question-card boundaries");
      let groupRenders = 0;
      for (const group of groups) {
        const render = group.render;
        group.render = function(width) { groupRenders++; return render.call(this, width); };
      }
      f.reset();
      if (reminder) {
        assert.equal(f.show(90), false, "the last pending question remains visible through both projections");
        assert.equal(f.counts().nativeRenders, count);
        assert.equal(groupRenders, count, "nested pin/reminder calculation renders each group only once");
      } else {
        assert.equal(f.viewport.root.entries[0].visible({ width: 90, height: 20 }), true);
        assert.equal(f.counts().nativeRenders, 4);
        assert.equal(groupRenders, 3, "only a viewport-filling suffix of actual group summaries is rendered");
      }
      assert.equal(f.counts().metadataReads, reminder ? 1 : 0);
    } finally { f.dispose(); }
  }
});

test("default projected suffix visibility matches fresh native rows through group toggles, late images and replacements", () => {
  const f = fixture({ grouping: true, panels: true, count: 0, reminder: false });
  try {
    const tools = [0, 1].map(index => {
      const tool = new ToolExecutionComponent("bash", `toggle-${index}`, { command: "echo result" }, { showImages: false }, undefined, { requestRender() {} }, process.cwd());
      tool.updateResult({ content: [{ type: "text", text: "result\n".repeat(40) }], details: undefined, isError: false });
      return tool;
    });
    f.chat.children = [f.user, ...tools];
    const check = () => {
      // Evaluate the optimized predicate first: no full document render may
      // prepare membership/wrappers for it after the mutation under test.
      const actual = f.viewport.root.entries[0].visible({ width: 90, height: 20 });
      const lines = f.document.render(90);
      const row = lines.findIndex(line => line.includes("Selected prompt"));
      assert.ok(row >= 0);
      const viewport = 20 - f.viewport.root.entries.at(-1).component.render(90).length;
      assert.equal(actual, row < Math.max(0, lines.length - viewport));
      return actual;
    };
    assert.equal(check(), false, "collapsed groups leave native user text visible");
    tools[0].setExpanded(true);
    assert.equal(check(), true, "native global/detail expansion is sampled immediately");
    tools[0].setExpanded(false);
    assert.equal(check(), false);
    const click = () => {
      const lines = f.chat.render(90);
      const y = lines.findIndex(line => /2 tools/.test(line));
      assert.ok(y >= 0);
      assert.equal(f.chat.handleMouse({ type: "click", button: "left", x: 3, y, screenX: 3, screenY: y, width: 90, height: lines.length })?.handled, true);
    };
    click();
    assert.equal(check(), true, "manual list expansion is retained by fresh preparation");
    for (const tool of tools) tool.setExpanded(true);
    check();
    for (const tool of tools) tool.setExpanded(false);
    assert.equal(check(), true, "global collapse does not close a manually opened list");
    click();
    assert.equal(check(), false);
    tools[0].updateResult({ content: [{ type: "image", data: "not rendered", mimeType: "image/png" }], details: undefined, isError: false });
    check();
    f.chat.children[1] = new Text("replacement\n".repeat(40), 0, 0);
    assert.equal(check(), true, "same-length replacement is not hidden by previous grouping membership");
  } finally { f.dispose(); }
});

test("outer pin visibility uses its own viewport after a nested reminder checks a larger one", () => {
  for (const grouping of [false, true]) {
    const f = fixture({ grouping, count: 10 });
    try {
      // Keep the pending question above the selected prompt. Only its reminder
      // should consume the extra row that hides the prompt's last text row.
      f.pending.toolCallId = "question-0";
      f.chat.children = [f.cards[0], f.user, ...f.cards.slice(1)];
      const widget = f.widgetsAbove.children.pop();
      const dock = f.viewport.root.entries.at(-1).component.render(90).length;
      f.widgetsAbove.addChild(widget);
      const rows = f.user.render(90);
      const target = rows.findIndex(line => line.includes("Selected prompt"));
      assert.ok(target >= 0);
      const after = f.cards.slice(1).reduce((sum, card) => sum + card.render(90).length, 0);
      f.tui.terminal.rows = dock + after + rows.length - target;
      assert.equal(f.viewport.root.entries[0].visible({ width: 90, height: f.tui.terminal.rows }), true,
        "nested visibility without the reminder cannot overwrite the outer result with it");
      assert.equal(f.show(90), true, "the earlier pending question still needs its reminder");
    } finally { f.dispose(); }
  }
});

test("captured heights and offsets do not allocate child line slices", () => {
  const content = new Text("one\ntwo", 0, 0);
  const region = new MouseRegion(content, () => undefined);
  const container = new Container(); container.addChild(region);
  const measurement = new TranscriptMeasurement();
  const lines = measurement.render(container, 40);
  let slices = 0;
  const slice = lines.slice;
  lines.slice = function(...args) { slices++; return slice.apply(this, args); };
  assert.equal(measurement.height(region, 40), 2);
  assert.equal(measurement.height(content, 40), 2);
  assert.equal(measurement.offsets(container, 40).get(region), 0);
  assert.equal(measurement.offsets(region, 40).get(content), 0);
  assert.equal(measurement.offsets(content, 40), undefined);
  assert.equal(slices, 0, "height/offset/overlap checks need only the captured native metadata");
  assert.equal(measurement.render(content, 40).length, 2);
  assert.equal(slices, 1, "rows remain lazily available when content visibility needs them");
});

test("snapshots expire after calculation, including same-object streaming and same-length replacements", () => {
  const f = fixture({ count: 3 });
  try {
    f.frame();
    assert.equal(f.show(90), false);
    f.chat.addChild(new Text("Streaming output\n".repeat(40), 0, 0));
    assert.equal(f.show(90), true, "same selected session and width cannot retain old transcript height");
    f.viewport.transcript.scrollToStart();
    assert.equal(f.show(90), true);
    f.chat.children[f.chat.children.length - 1].setText("short");
    f.viewport.transcript.scrollToEnd();
    assert.equal(f.show(90), false, "same component shrinks without explicit root invalidation");
    f.chat.children[f.chat.children.indexOf(f.cards.at(-1))] = new Text("Same-length native replacement", 0, 0);
    assert.equal(f.show(90), true, "replacement cannot reuse a prior question identity/offset");
    f.tui.terminal.columns = 18; f.tui.terminal.rows = 8;
    f.frame();
    assert.equal(f.show(18), true);
  } finally { f.dispose(); }
});

test("native concatenation and MouseRegion rows are reused without render patches or stale layout guesses", () => {
  let renders = 0;
  const content = { invalidate() {}, render() { renders++; return ["one", "two"]; } };
  const region = new MouseRegion(content, () => undefined);
  const container = new Container(); container.addChild(region);
  const original = content.render;
  withTranscriptMeasurement(container, (measurement, shared) => {
    assert.equal(shared, false);
    assert.equal(measurement.offsets(container, 40).get(region), 0);
    assert.equal(measurement.offsets(region, 40).get(content), 0);
    assert.deepEqual(measurement.render(content, 40), ["one", "two"]);
    assert.equal(content.render, original);
    assert.equal(renders, 1);
    withTranscriptMeasurement(container, (nested, shared) => { assert.equal(nested, measurement); assert.equal(shared, true); });
  });
  assert.equal(new TranscriptMeasurement().offsets(container, 40).get(region), 0);
  assert.equal(renders, 2, "a later calculation refreshes native rendering");
  container.render = () => ["Foreign layout", "same height"];
  assert.equal(new TranscriptMeasurement().offsets(container, 40), undefined, "foreign same-height output cannot reuse stale mouse layout");
});

test("mixed-width nested calculations retain the coordinates captured at each width", () => {
  const first = new Text("wide words ".repeat(10), 0, 0);
  const target = new Text("target", 0, 0);
  const chat = new Container(); chat.addChild(first); chat.addChild(target);
  const document = new Container(); document.addChild(chat);
  const owner = {};
  withTranscriptMeasurement(owner, measurement => {
    const narrow = measurement.render(document, 12);
    withTranscriptMeasurement(owner, nested => {
      assert.equal(nested, measurement);
      nested.render(document, 80);
      assert.equal(nested.offsets(chat, 80).get(target), first.render(80).length);
    });
    assert.equal(measurement.offsets(chat, 12).get(target), first.render(12).length);
    assert.equal(measurement.render(document, 12), narrow);
    assert.ok(measurement.offsets(chat, 12).get(target) > measurement.offsets(chat, 80).get(target));
  });
});

test("same-height foreign self-shell output cannot hide the reminder using stale native children", () => {
  const f = fixture({ pin: false, grouping: false, count: 1 });
  try {
    f.frame();
    assert.equal(f.show(90), false, "the native question is initially visible");
    const card = f.cards[0];
    const native = card.render(90);
    card.render = () => native.map(() => "Foreign output without question text");
    f.reset();
    assert.equal(f.show(90), true, "same-height foreign rows cannot inherit native question metadata");
    assert.deepEqual(f.counts(), { nativeRenders: 0, cardRenders: 0, metadataReads: 0 },
      "visibility never descends into the foreign self-shell's stale child tree");
  } finally { f.dispose(); }
});

test("reordered native rows are unsupported even when the foreign wrapper refreshes mouseLayout", () => {
  const document = new Container();
  const before = new Text("before\n".repeat(30), 0, 0);
  const target = new Text("target", 0, 0);
  document.addChild(before); document.addChild(target);
  const native = document.render;
  const measurement = new TranscriptMeasurement();
  assert.equal(measurement.offsets(document, 80).get(target), 31);
  document.render = function(width) { return native.call(this, width).slice().reverse(); };
  assert.equal(new TranscriptMeasurement().render(document, 80)[0].trim(), "target");
  assert.equal(new TranscriptMeasurement().offsets(document, 80), undefined,
    "fresh native mouse metadata does not verify the foreign wrapper's row ordering");
});

test("assistant-panel registration preserves only a verified original renderer and releases ownership", () => {
  for (const foreignOriginal of [false, true]) {
    const f = fixture({ pin: false, count: 1 });
    let disposePanels;
    try {
      if (foreignOriginal) {
        const native = f.document.render;
        f.document.render = function(width) { return native.call(this, width).slice().reverse(); };
      }
      const original = f.document.render;
      disposePanels = installAssistantPanels(f.tui, { theme: () => themes.theme, requestRender() {}, warn: assert.fail });
      assert.equal(isTranscriptRendererSupported(f.document), !foreignOriginal);
      assert.equal(f.show(90), foreignOriginal, "only a preserving wrapper around a verified renderer can hide the reminder");
      assert.equal(new TranscriptMeasurement().offsets(f.document, 90) !== undefined, !foreignOriginal);
      const panelRenderer = f.document.render;
      f.document.render = function(width) { return panelRenderer.call(this, width).slice().reverse(); };
      assert.equal(isTranscriptRendererSupported(f.document), false);
      assert.equal(new TranscriptMeasurement().offsets(f.document, 90), undefined, "a later replacement cannot inherit panel registration");
      disposePanels(); disposePanels = undefined;
      assert.notEqual(f.document.render, original, "panel disposal does not overwrite a foreign replacement");
      assert.equal(isTranscriptRendererSupported(f.document), false);
    } finally { disposePanels?.(); f.dispose(); }
  }
});

test("exceptions unwind active measurements and never leak rendered history into a later calculation", () => {
  const owner = {};
  const component = new Text("before", 0, 0);
  let failed;
  assert.throws(() => withTranscriptMeasurement(owner, measurement => {
    failed = measurement;
    assert.deepEqual(measurement.render(component, 40).map(line => line.trimEnd()), ["before"]);
    withTranscriptMeasurement(owner, nested => {
      assert.equal(nested, measurement);
      throw new Error("renderer failed");
    });
  }), /renderer failed/);
  component.setText("after");
  withTranscriptMeasurement(owner, measurement => {
    assert.notEqual(measurement, failed);
    assert.deepEqual(measurement.render(component, 40).map(line => line.trimEnd()), ["after"]);
  });
});
