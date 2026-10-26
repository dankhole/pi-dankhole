/**
 * widget.bench.ts — the two always-on surfaces, `AgentWidget` and `FleetList`.
 *
 * Both surfaces read a fresh roster on each operation, while widget context
 * percentages reuse canonical session state and hidden rows skip formatting.
 * Both can render on every TUI frame, not just on their own timers, because
 * they sit beside the editor: a keystroke in the main session redraws them.
 * Context-aware fixtures below exercise the public-reader cache, not the
 * getSessionStats-only legacy shared stub or an exception/catch fast path.
 *
 * `render` and `update` are measured apart because they run at different rates
 * (per frame vs. an 80 ms timer plus ~10 call sites in index.ts) and a
 * regression in one says nothing about the other.
 *
 * Cleanup is in `afterAll`, NOT in tinybench's per-task `teardown`: that hook
 * fires between the warmup and sampling phases, and `dispose()` unregisters the
 * widget by calling `setWidget(key, undefined)`. The first version of this file
 * disposed in `teardown` and reported 33 million renders per second — it was
 * measuring an unregistered widget returning an empty array.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, bench, describe } from "vitest";
import { AgentWidget } from "../../../src/workers/ui/agent-widget.js";
import { FleetList } from "../../../src/workers/ui/fleet-list.js";
import { makeActivity, makeFleet, makeManager, mountFleet, perfTheme, perfTui } from "../helpers/perf-fixtures.js";

/** Local modern-API fixture; keep the cross-revision shared fixtures unchanged. */
function mountWidget(Widget: typeof AgentWidget, records: ReturnType<typeof makeFleet>, opts: { mode?: "all" | "background"; showCost?: boolean; showModel?: boolean } = {}) {
  const activities = makeActivity(records);
  for (const activity of activities.values()) {
    activity.session = {
      sessionManager: SessionManager.inMemory(),
      messages: [],
      getContextUsage: () => ({ tokens: 84_000, contextWindow: 200_000, percent: 42 }),
    };
    activity.responseText = "Working on the fixture\n" + "Historical response line\n".repeat(10_000);
  }
  const widget = new Widget(makeManager(records), activities, () => opts.mode ?? "all", () => opts.showCost ?? false, () => opts.showModel ?? false);
  let component: { render(): string[] } | undefined;
  const tui = perfTui();
  widget.setUICtx({
    setStatus: () => {},
    setWidget: (_key, factory) => { component = factory?.(tui, perfTheme); },
  });
  widget.update();
  component?.render();
  return { render: () => component?.render() ?? [], update: () => widget.update(), dispose: () => widget.dispose() };
}

/** Fleet sizes: one agent, a normal fan-out, and a pathological one. */
const SIZES = [1, 10, 100];

/** Everything mounted here, torn down once at the end (FleetList holds a timer). */
const mounted: { dispose: () => void }[] = [];
function track<T extends { dispose: () => void }>(m: T): T {
  mounted.push(m);
  return m;
}
afterAll(() => {
  for (const m of mounted) m.dispose();
});

describe("AgentWidget.render (per TUI frame)", () => {
  for (const n of SIZES) {
    const w = track(mountWidget(AgentWidget, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      w.render();
    });
  }
});

describe("AgentWidget.update (80ms timer + ~10 call sites)", () => {
  for (const n of SIZES) {
    const w = track(mountWidget(AgentWidget, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      w.update();
    });
  }
});

describe("AgentWidget.render — the widget's real mix", () => {
  // What a fan-out actually looks like on screen: a few running, a queue behind
  // them, and finished rows still lingering. This is the shape the twelve-line
  // overflow logic has to resolve, which the flat "n running" cases never reach.
  const mix = () => makeFleet({ running: 3, queued: 7, finished: 3 });

  const off = track(mountWidget(AgentWidget, mix(), { mode: "background" }));
  bench("3 running / 7 queued / 3 finished — showModel off", () => {
    off.render();
  });

  const on = track(mountWidget(AgentWidget, mix(), { mode: "background", showModel: true }));
  bench("3 running / 7 queued / 3 finished — showModel on", () => {
    on.render();
  });

  const cost = track(mountWidget(AgentWidget, mix(), { mode: "background", showCost: true }));
  bench("3 running / 7 queued / 3 finished — showCost on", () => {
    cost.render();
  });
});

describe("FleetList.render (per TUI frame, below the editor)", () => {
  for (const n of SIZES) {
    const f = track(mountFleet(FleetList, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      f.render(120);
    });
  }
});

describe("FleetList.update (200ms timer)", () => {
  for (const n of SIZES) {
    const f = track(mountFleet(FleetList, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      f.update();
    });
  }
});
