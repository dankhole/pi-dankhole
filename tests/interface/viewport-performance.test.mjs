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
const { isTranscriptRendererSupported, registerTranscriptRenderer, TranscriptMeasurement, withTranscriptMeasurement } = await source("styling/transcript-measurement.ts");
const { installPinnedPrompt } = await source("styling/pinned-prompt.ts");
const { installGrouping } = await source("styling/grouping.ts");
const { installAssistantPanels } = await source("styling/assistant-panels.ts");
const { QUESTION_CONTENT, questionListVisibility } = await source("questions/question-viewport.ts");

function fixture({ pin = true, grouping = true, count = 60 } = {}) {
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
  const pinned = pin ? installPinnedPrompt(tui, () => themes.theme,
    () => ({ id: "prompt", text: "Selected prompt", displayed: true, rows: [{ id: "prompt", kind: "UserMessageComponent" }] }), assert.fail) : undefined;
  const show = questionListVisibility(tui, [pending]);
  widgetsAbove.addChild({ invalidate() {}, render(width) { return show(width) ? ["Questions reminder"] : []; } });
  return { tui, chat, cards, pending, document, viewport, show, user,
    frame() { return renderLayoutFrame(viewport.root, tui.terminal.columns, tui.terminal.rows, () => {}); },
    reset() { nativeRenders = 0; cardRenders = 0; metadataReads = 0; },
    counts() { return { nativeRenders, cardRenders, metadataReads }; },
    dispose() { show.dispose(); pinned?.dispose(); disposeGrouping(); for (const dispose of rendererDisposers) dispose(); },
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
  withTranscriptMeasurement(container, measurement => {
    assert.equal(measurement.offsets(container, 40).get(region), 0);
    assert.equal(measurement.offsets(region, 40).get(content), 0);
    assert.deepEqual(measurement.render(content, 40), ["one", "two"]);
    assert.equal(content.render, original);
    assert.equal(renders, 1);
    withTranscriptMeasurement(container, nested => assert.equal(nested, measurement));
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
