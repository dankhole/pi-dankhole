import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const requirePi = createRequire(join(root, "package.json"));
const tuiPath = dirname(requirePi.resolve("@earendil-works/pi-tui"));
const { Container, Text, TuiAltScreen, VStack } = await import(pathToFileURL(join(tuiPath, "index.js")).href);
const { renderLayoutFrame } = await import(pathToFileURL(join(tuiPath, "layout.js")).href);
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
  "@earendil-works/pi-tui": requirePi.resolve("@earendil-works/pi-tui"),
} });
const { registerTranscriptRenderer, retainTranscriptFrames, TranscriptMeasurement, withTranscriptFrame, withTranscriptMeasurement } = await jiti.import(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styling/transcript-measurement.ts"));
const nodeKey = Symbol.for("@earendil-works/pi-tui/layout-node");

function fixture() {
  const terminal = { columns: 50, rows: 10, write() {}, hideCursor() {}, showCursor() {} };
  const tui = new TuiAltScreen(terminal, false);
  tui.requestRender = () => {};
  tui.stopped = false;
  tui.altScreenActive = true;
  let renders = 0;
  let text = "first";
  let fail = false;
  const component = { invalidate() {}, render() { renders++; if (fail) throw new Error("native render failed"); return [text]; } };
  const seen = [];
  const measure = () => withTranscriptMeasurement(tui, (measurement, nested) => {
    seen.push({ rows: measurement.render(component, 50), nested });
    return true;
  });
  const layout = new VStack([{ component: new Text("native paint", 0, 0), visible: () => { measure(); measure(); return true; } }]);
  tui.setLayoutRoot(layout);
  return { tui, layout, component, seen, measure,
    get renders() { return renders; },
    text(value) { text = value; },
    fail(value) { fail = value; },
    frame() { tui.doRender(); },
  };
}

test("real fullscreen frames share independent predicates but not later calls or mutable next frames", () => {
  const f = fixture();
  const original = f.tui.doRender;
  const descriptor = Object.getOwnPropertyDescriptor(f.layout, nodeKey);
  const release = retainTranscriptFrames(f.tui);
  try {
    f.frame();
    assert.equal(f.renders, 1);
    assert.deepEqual(f.seen.map(entry => entry.nested), [false, false], "a frame is not a nested pin/reminder calculation");
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.layout, nodeKey), descriptor);
    f.text("same-object streaming update");
    f.frame();
    assert.equal(f.renders, 2);
    assert.equal(f.seen.at(-1).rows[0], "same-object streaming update");
    f.text("outside frame");
    f.measure(); f.measure();
    assert.equal(f.renders, 4, "standalone calculations never inherit a finished frame");
    assert.equal(f.seen.at(-1).rows[0], "outside frame");
  } finally { release(); }
  assert.equal(f.tui.doRender, original);
});

test("later predicates reject a same-height foreign renderer or projection owner installed inside the frame", () => {
  const f = fixture();
  const release = retainTranscriptFrames(f.tui);
  f.layout.entries[0].visible = () => {
    f.measure();
    f.component.render = () => ["foreign same-height output"];
    f.measure();
    return true;
  };
  try {
    f.frame();
    assert.deepEqual(f.seen.map(entry => entry.rows[0]), ["first", "foreign same-height output"]);
  } finally { release(); }
  const g = fixture();
  const releaseOther = retainTranscriptFrames(g.tui);
  let unregister;
  g.layout.entries[0].visible = () => {
    g.measure();
    unregister = registerTranscriptRenderer(g.component, g.component.render);
    g.measure();
    return true;
  };
  try { g.frame(); assert.equal(g.renders, 2, "a changed projection owner cannot inherit a prior row snapshot"); }
  finally { unregister?.(); releaseOther(); }
});

test("search-triggered second native layout starts a fresh predicate snapshot", () => {
  const f = fixture();
  const release = retainTranscriptFrames(f.tui);
  let layouts = 0;
  f.tui.refreshSearch = () => {
    layouts++;
    f.text("changed between layout traversals");
    return true;
  };
  try {
    f.frame();
    assert.equal(layouts, 1);
    assert.equal(f.renders, 2, "two native layout traversals have two independently fresh measurements");
    assert.deepEqual(f.seen.map(entry => entry.rows[0]), ["first", "first", "changed between layout traversals", "changed between layout traversals"]);
  } finally { release(); }
});

test("exceptions unwind both native frame hooks and measurements", () => {
  const f = fixture();
  const originalNode = f.layout[nodeKey];
  const release = retainTranscriptFrames(f.tui);
  try {
    f.fail(true);
    assert.throws(() => f.frame(), /native render failed/);
    assert.equal(f.layout[nodeKey], originalNode);
    f.fail(false); f.text("after failure");
    f.frame();
    assert.equal(f.renders, 2);
    assert.equal(f.seen.at(-1).rows[0], "after failure");
    f.measure();
    assert.equal(f.renders, 3);
  } finally { release(); }
});

test("reentrant native frames invalidate the suspended outer predicate too", () => {
  const f = fixture();
  const release = retainTranscriptFrames(f.tui);
  let nesting = false;
  f.layout.entries[0].visible = () => {
    f.measure();
    if (!nesting) {
      nesting = true;
      f.text("inner update");
      f.frame();
      f.text("outer resumed update");
      f.measure();
      nesting = false;
    }
    return true;
  };
  try {
    f.frame();
    assert.equal(f.renders, 3);
    assert.deepEqual(f.seen.map(entry => entry.rows[0]), ["first", "inner update", "outer resumed update"]);
    f.measure();
    assert.equal(f.renders, 4, "the reentrant transaction cannot outlive its outer render");
  } finally { release(); }
});

test("a native render interrupted by reentry cannot repopulate rows for a later predicate", () => {
  function run(replacement, sharing, nested = false) {
    const terminal = { columns: 50, rows: 10, write() {}, hideCursor() {}, showCursor() {} };
    const tui = new TuiAltScreen(terminal, false);
    tui.requestRender = () => {};
    tui.stopped = false;
    tui.altScreenActive = true;
    const text = new Text("first", 0, 0);
    const history = new Container();
    let entered = false;
    let inner = false;
    const trigger = { invalidate() {}, render() {
      if (!entered) {
        entered = true;
        inner = true;
        try { tui.renderNow(); } finally { inner = false; }
        text.setText(replacement);
      }
      return ["trigger"];
    } };
    history.addChild(text);
    history.addChild(trigger);
    const seen = [];
    const layout = new VStack([{ component: history, visible: () => {
      const first = withTranscriptMeasurement(tui, measurement => {
        const rows = measurement.render(history, 50);
        if (nested && !inner) withTranscriptMeasurement(tui, (resumed, shared) => {
          assert.equal(shared, true);
          assert.equal(resumed, measurement, "the interrupted calculation still holds the same measurement");
          assert.equal(resumed.render(history, 50)[0].trimEnd(), "outer resumed");
        });
        return rows;
      });
      const last = withTranscriptMeasurement(tui, measurement => ({
        rows: measurement.render(history, 50).map(line => line.trimEnd()),
        height: measurement.height(history, 50),
        triggerOffset: measurement.offsets(history, 50)?.get(trigger),
      }));
      if (!inner) seen.push({ first: first.map(line => line.trimEnd()), last });
      return true;
    } }]);
    tui.setLayoutRoot(layout);
    const release = sharing ? retainTranscriptFrames(tui) : () => {};
    try {
      tui.renderNow();
      const expected = [...replacement.split("\n"), "trigger"];
      const paint = tui.currentLayout.lines.slice(0, expected.length).map(line => line.trimEnd());
      assert.deepEqual(paint, expected, "the final native paint uses the resumed state");
      return { ...seen.at(-1), paint };
    } finally { release(); }
  }
  for (const replacement of ["outer resumed", "outer resumed\nsecond row\nthird row"]) {
    const baseline = run(replacement, false);
    const result = run(replacement, true);
    assert.equal(result.first[0], "first", "reentry happens during native concatenation, after the preceding child rendered");
    assert.deepEqual(result.last.rows, result.paint, "the later predicate must match fresh native paint");
    assert.equal(result.last.height, result.paint.length);
    assert.equal(result.last.triggerOffset, replacement.split("\n").length);
    assert.deepEqual(result, baseline, "sharing must preserve native predicate and height behavior after interrupted rendering");
    assert.deepEqual(run(replacement, true, true), baseline, "an active nested calculation cannot reintroduce interrupted rows");
  }
});

test("invalidation rejects in-flight memo commits without dropping committed row-independent values", () => {
  for (const all of [false, true]) {
    const measurement = new TranscriptMeasurement();
    const stable = {};
    const interrupted = {};
    measurement.memo(stable, () => "committed");
    assert.equal(measurement.memo(interrupted, () => {
      if (all) measurement.invalidate();
      else measurement.invalidateRows();
      return "interrupted";
    }), "interrupted", "the running calculation still gets its own result");
    assert.equal(measurement.memo(interrupted, () => "fresh"), "fresh", "later predicates cannot inherit a pre-invalidation memo");
    assert.equal(measurement.memo(stable, () => "replaced"), all ? "replaced" : "committed");
  }
});

test("frame ownership is ref-counted, idempotent and does not overwrite foreign renderers", () => {
  const f = fixture();
  const original = f.tui.doRender;
  const first = retainTranscriptFrames(f.tui);
  const wrapped = f.tui.doRender;
  const second = retainTranscriptFrames(f.tui);
  assert.equal(f.tui.doRender, wrapped);
  first(); first();
  assert.equal(f.tui.doRender, wrapped, "one surviving consumer retains the adapter");
  second();
  assert.equal(f.tui.doRender, original);
  const third = retainTranscriptFrames(f.tui);
  const retained = f.tui.doRender;
  const foreign = () => retained();
  f.tui.doRender = foreign;
  const rejected = retainTranscriptFrames(f.tui);
  f.frame();
  assert.equal(f.renders, 2, "a retained wrapper called by a foreign owner cannot share a frame");
  third(); rejected();
  assert.equal(f.tui.doRender, foreign);
  const unsupported = { mode: "fullscreen", doRender() {}, layoutRoot: f.layout };
  const unsupportedRender = unsupported.doRender;
  retainTranscriptFrames(unsupported)();
  assert.equal(unsupported.doRender, unsupportedRender);
});

test("foreign layout-node replacement and root replacement disable sharing without stealing ownership", () => {
  const f = fixture();
  const original = f.layout[nodeKey];
  const release = retainTranscriptFrames(f.tui);
  const foreign = () => original.call(f.layout);
  f.layout[nodeKey] = foreign;
  try {
    f.frame();
    assert.equal(f.renders, 2);
    assert.equal(f.layout[nodeKey], foreign);
    delete f.layout[nodeKey];
    withTranscriptFrame(f.tui, () => {
      f.layout[nodeKey] = foreign;
      renderLayoutFrame(f.layout, 50, 10, () => {});
    });
    assert.equal(f.layout[nodeKey], foreign, "finally does not restore over a replacement installed inside the frame");
    delete f.layout[nodeKey];
    withTranscriptFrame(f.tui, () => {
      renderLayoutFrame(f.layout, 50, 10, () => {});
      f.tui.layoutRoot = new Container();
      f.measure(); f.measure();
    });
    assert.equal(f.renders, 7, "a root no longer owned by the active frame cannot reuse that snapshot");
  } finally { release(); }
});
