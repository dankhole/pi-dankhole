import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRunningAgentStatus } from "../../src/workers/index.js";
import type { WidgetMode } from "../../src/workers/types.js";
import { type AgentActivity, AgentWidget, fgPreservingNestedStyles, formatCost, formatDuration, formatMs, formatSessionTokens } from "../../src/workers/ui/agent-widget.js";

// update() now owns animation re-arming as well as lifecycle refreshes.
// Keep these rendering-only fixtures from leaving real animation intervals.
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k token (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "thinking: xhigh · 4 tool uses", "thinking…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ thinking: xhigh · 4 tool uses",
      "  ⎿  thinking…",
    ]);
  });
});

describe("AgentWidget", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function makeActivity(): AgentActivity {
    return {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    };
  }

  function makeRecord(
    id: string,
    opts: { isBackground?: boolean } = {},
  ) {
    return {
      id,

      description: `${id} description`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      invocation: { modelName: "sonnet 4.6", modelId: "anthropic/claude-sonnet-4-6", thinking: "high" },
      isBackground: opts.isBackground,

    };
  }

  /** Render the widget for a manager and return the produced lines ("" if nothing rendered). */
  function renderLines(manager: unknown, activityId: string, mode?: () => WidgetMode, showModel = false): string {
    const widget = new AgentWidget(
      manager as any,
      new Map([[activityId, makeActivity()]]),
      mode,
      () => false,
      () => showModel,
    );
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.update();
    if (!factory) return "";
    return factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme)
      .render()
      .join("\n");
  }

  // "all" (and the no-policy constructor default) shows every agent.
  it("shows foreground agents in 'all' mode (and by default)", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground")).toContain("foreground description");
    expect(renderLines(manager, "foreground", () => "all")).toContain("foreground description");
  });

  it("excludes foreground agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground", () => "background")).toBe("");
  });

  // Also covers directly spawned agents (isBackground=true, no `invocation`
  // snapshot): if the filter still keyed off `invocation.runInBackground` —
  // #118's original approach — this would wrongly vanish.
  it("renders background agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    const lines = renderLines(manager, "background", () => "background");
    expect(lines).toContain("Agents");
    expect(lines).toContain("background description");
  });

  // 'background' excludes only agents *known* to be foreground; one with no
  // isBackground flag (e.g. a cross-extension RPC spawn) is kept, not hidden.
  it("keeps agents with no isBackground flag in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("unflagged", {})] };
    expect(renderLines(manager, "unflagged", () => "background")).toContain("unflagged description");
  });

  // The model is opt-in: the row is already dense, and the same pair is on the
  // tool result and in the conversation viewer either way.
  it("names the model and thinking on a running row under showModel", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    expect(renderLines(manager, "bg", () => "background", true))
      .toContain("sonnet 4.6 · thinking: high");
  });

  it("keeps a single goal label when showModel is off", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    const off = renderLines(manager, "bg", () => "background");
    expect(off).toContain("bg description");
    expect(off).not.toContain("sonnet 4.6");
    expect(off).not.toContain("thinking:");
    expect(off.match(/bg description/g)).toHaveLength(1);
    expect(off).not.toMatch(/general-purpose|\(twin\)|tool uses?/);
  });

  it("keeps live header/activity pairs with tight indentation and no tool counts", () => {
    const manager = {
      listAgents: () => [
        { ...makeRecord("first"), toolUses: 123 },
        { ...makeRecord("second"), toolUses: 456 },
      ],
    };
    const lines = renderLines(manager, "first").split("\n");
    expect(lines).toHaveLength(5); // heading plus two live row pairs
    expect(lines[1]).toContain("first description");
    expect(lines[2]).toBe("│  ⎿ thinking…");
    expect(lines[3]).toContain("second description");
    expect(lines[4]).toBe("   ⎿ thinking…");
    expect(lines.join("\n")).not.toMatch(/tool uses?|general-purpose|\(twin\)/);
  });

  it("carries the short label, never the canonical id, onto the row", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    expect(renderLines(manager, "bg", () => "background", true))
      .not.toContain("anthropic/claude-sonnet-4-6");
  });

  it("discloses a level the run did not honor", () => {
    const record = makeRecord("bg", { isBackground: true });
    record.invocation = { modelName: "haiku 4.5", thinking: "high", requestedThinking: "max" };
    const manager = { listAgents: () => [record] };

    expect(renderLines(manager, "bg", () => "background", true))
      .toContain("haiku 4.5 · thinking: high (asked max)");
  });

  // Queued agents stay a one-line count. A fan-out of ten would otherwise eat
  // the whole widget and push every finished agent out of it.
  it("keeps queued agents on one summary line and finished agents visible", () => {
    const records = [
      ...[1, 2, 3].map(i => ({ ...makeRecord(`run${i}`, { isBackground: true }), status: "running" })),
      ...[1, 2, 3, 4, 5, 6, 7].map(i => ({ ...makeRecord(`q${i}`, { isBackground: true }), status: "queued" })),
      ...[1, 2, 3].map(i => ({
        ...makeRecord(`fin${i}`, { isBackground: true }),
        status: "completed",
        completedAt: Date.now(),
      })),
    ];
    const widget = new AgentWidget(
      { listAgents: () => records } as any,
      new Map(),
      () => "background",
      () => false,
      () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_key, content) => { factory = content; } });
    for (const r of records) if (r.status === "completed") widget.markFinished(r.id);
    widget.update();
    const lines = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(lines).toContain("7 queued");
    expect(lines).not.toContain("q1 description");
    for (const i of [1, 2, 3]) expect(lines).toContain(`fin${i} description`);
    expect(lines).not.toContain("more (");
  });

  // "off" hides the widget entirely — even a background agent renders nothing.
  it("renders nothing in 'off' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    expect(renderLines(manager, "background", () => "off")).toBe("");
  });
});

// The widget caps itself at MAX_WIDGET_LINES (12) and, past that, hands out a
// line budget in priority order: running pairs, then the queued summary, then
// finished lines. Running and finished increment `hiddenRunning`/`hiddenFinished`
// when they don't fit; the queued line is dropped with NO counter at all, so the
// footer under-reports and — worse — the queue vanishes from the UI entirely.
// That happens exactly when the concurrency limit is saturated, i.e. when the
// queue is the thing the user most needs to see.
describe("formatCost", () => {
  it.each([
    [0.00002, "~$0"], [0.0042, "~$0"], [0.4999, "~$0"],
    [0.5, "~$1"], [0.8534, "~$1"], [1.239, "~$1"],
    [1.4999, "~$1"], [1.5, "~$2"], [12, "~$12"],
  ])("rounds %s to whole estimated dollars (%s)", (cost, expected) => {
    expect(formatCost(cost)).toBe(expected);
  });

  it("keeps exact zero/unpriced, negative and invalid costs hidden", () => {
    expect(formatCost(0)).toBe("");
    expect(formatCost(Number.NaN)).toBe("");
    expect(formatCost(-1)).toBe("");
  });
});

describe("elapsed minute formatting", () => {
  it.each([
    [0, "0m"], [29_999, "0m"], [30_000, "1m"], [60_000, "1m"],
    [89_999, "1m"], [90_000, "2m"], [811_100, "14m"],
    [3_600_000, "60m"], [-1, "0m"],
  ])("rounds %sms to %s", (ms, expected) => {
    expect(formatMs(ms)).toBe(expected);
  });

  it("counts up live and freezes the completed duration without changing timestamps", () => {
    const now = vi.spyOn(Date, "now");
    const start = 100_000;
    try {
      now.mockReturnValue(start + 29_999);
      expect(formatDuration(start)).toBe("0m (running)");
      now.mockReturnValue(start + 30_000);
      expect(formatDuration(start)).toBe("1m (running)");
      now.mockReturnValue(start + 90_000);
      expect(formatDuration(start)).toBe("2m (running)");
      expect(formatDuration(start, start + 30_000)).toBe("1m");
    } finally {
      now.mockRestore();
    }
  });
});

describe("AgentWidget cost display", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function render(showCost: boolean, cost: number, elapsed = 0): string {
    const agent = {
      id: "a1",

      description: "spending agent",
      status: "running",
      toolUses: 1,
      startedAt: Date.now() - elapsed,
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
      compactionCount: 0,
    };
    // Carries figures of its own, in the shape the tracker used to have: spend
    // is read from the record now, so these must not reach the line. Only the
    // record outlives the run and retains lifetime spend across resume.
    const activity = new Map([["a1", {
      activeTools: new Map(),
      toolUses: 1,
      responseText: "",
      turnCount: 1,
      lifetimeUsage: { input: 9, output: 9, cacheWrite: 0, cost: 0.9 },
    } as unknown as AgentActivity]]);
    const widget = new AgentWidget(
      { listAgents: () => [agent] } as any,
      activity,
      () => "all",
      () => showCost,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    return factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");
  }

  it("rounds the widget’s cost and elapsed time without seconds or fractional dollars", () => {
    expect(render(true, 0.8534, 811_100)).toContain("~$1 · 14m");
    expect(render(true, 0.0042)).toContain("~$0 · 0m");
    expect(render(true, 0.8534, 811_100)).not.toMatch(/\$\d+\.|\d+(?:\.\d+)?s\b/);
  });

  it("shows the cost beside the token count when enabled", () => {
    const line = render(true, 0.0042);
    expect(line).toContain("1.2k token");
    expect(line).toContain("~$0");
  });

  it("shows no cost when disabled", () => {
    const line = render(false, 0.0042);
    expect(line).toContain("1.2k token");
    expect(line).not.toContain("$");
  });

  it("shows no cost for an unpriced model, even when enabled", () => {
    const line = render(true, 0);
    expect(line).toContain("1.2k token");
    expect(line).not.toContain("$");
  });

  it("keeps the cost visible after the agent finishes", () => {
    // The activity entry is deleted the moment an agent finishes, so a finished
    // line reading from it would drop the number precisely when the question
    // "what did that cost" gets asked.
    const finished = {
      id: "a1", description: "done agent", status: "completed",
      toolUses: 2, startedAt: Date.now() - 1000, completedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.0042 },
      compactionCount: 0,
    };
    const widget = new AgentWidget(
      { listAgents: () => [finished] } as any, new Map(), () => "all", () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(out).toContain("done agent");
    expect(out.match(/done agent/g)).toHaveLength(1);
    expect(out).not.toMatch(/tool uses?|general-purpose|\(twin\)/);
    expect(out).toContain("~$0");
  });

  it("shows stats for an agent nobody is tracking live", () => {
    // An RPC worker has no activity entry — it spawns through the manager
    // directly — and used to render with no tokens and no cost at all.
    const running = {
      id: "rpc", description: "RPC worker", status: "running",
      toolUses: 1, startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.0042 },
      compactionCount: 0,
    };
    const widget = new AgentWidget(
      { listAgents: () => [running] } as any, new Map(), () => "all", () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(out).toContain("1.2k token");
    expect(out).toContain("~$0");
  });

  it("defaults to hiding it", () => {
    const agent = {
      id: "a1", description: "d", status: "running",
      toolUses: 0, startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.5 }, compactionCount: 0,
    };
    const activity = new Map([["a1", {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1,
    } as AgentActivity]]);
    const widget = new AgentWidget({ listAgents: () => [agent] } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    expect(factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n"))
      .not.toContain("$");
  });
});

describe("AgentWidget overflow accounting", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function record(id: string, status: string) {
    return {
      id,

      description: `${id} description`,
      status,
      toolUses: 0,
      startedAt: Date.now(),
      completedAt: status === "completed" ? Date.now() : undefined,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: true,
    };
  }

  /** Render a whole fleet (mixed statuses) and return the produced lines. */
  function renderFleet(counts: { running: number; queued: number; finished: number }): string[] {
    const agents = [
      ...Array.from({ length: counts.running }, (_, i) => record(`run${i}`, "running")),
      ...Array.from({ length: counts.queued }, (_, i) => record(`q${i}`, "queued")),
      ...Array.from({ length: counts.finished }, (_, i) => record(`fin${i}`, "completed")),
    ];
    const activity = new Map(agents.map(a => [a.id, {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    } as AgentActivity]));
    const widget = new AgentWidget({ listAgents: () => agents } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    if (!factory) return [];
    return factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render();
  }

  /** The `+N more (…)` footer, if the widget overflowed. */
  const footer = (lines: string[]) => lines.find(l => l.includes("more ("));

  /** Every fleet shape worth rendering — swept, not sampled. */
  const SHAPES: { running: number; queued: number; finished: number }[] = [];
  for (let running = 0; running <= 8; running++)
    for (let queued = 0; queued <= 8; queued++)
      for (let finished = 0; finished <= 8; finished++) SHAPES.push({ running, queued, finished });

  // Swept rather than sampled: reserving the queued row moves `budget` around by
  // hand, and an off-by-one there overflows the cap only for specific shapes.
  it("never exceeds the line cap, for any fleet shape", () => {
    for (const counts of SHAPES) {
      expect(renderFleet(counts).length, JSON.stringify(counts)).toBeLessThanOrEqual(12);
    }
  });

  it("never prints a footer that miscounts what it hid, for any fleet shape", () => {
    for (const counts of SHAPES) {
      const f = footer(renderFleet(counts));
      if (!f) continue;
      const total = Number(/\+(\d+) more/.exec(f)?.[1]);
      const where = `${JSON.stringify(counts)} → ${f}`;
      // A visible footer means something was dropped, so "+0 more ()" is a lie...
      expect(total, where).toBeGreaterThan(0);
      // ...and it counts agents that have their own row, so it can never exceed
      // them — in particular the queued summary must not be counted as an agent.
      expect(total, where).toBeLessThanOrEqual(counts.running + counts.finished);
    }
  });

  it("keeps the queued summary visible when the running agents fill the widget", () => {
    // 5 running (10 lines) consume the entire budget, so the queued line is
    // dropped — and with it, any sign that 3 agents are waiting to start.
    const lines = renderFleet({ running: 5, queued: 3, finished: 1 });
    expect(lines.join("\n")).toContain("3 queued");
  });

  it("counts everything it hid — the footer total matches what is missing", () => {
    // Computed rather than hardcoded, so this survives a scenario change but not
    // a change to what the footer counts.
    const counts = { running: 5, queued: 3, finished: 1 };
    const lines = renderFleet(counts);
    const body = lines.join("\n");

    const shownRunning = counts.running - [...Array(counts.running).keys()]
      .filter(i => !body.includes(`run${i} description`)).length;
    const shownFinished = counts.finished - [...Array(counts.finished).keys()]
      .filter(i => !body.includes(`fin${i} description`)).length;
    const actuallyHidden = (counts.running - shownRunning) + (counts.finished - shownFinished);

    const reported = Number(/\+(\d+) more/.exec(footer(lines) ?? "")?.[1] ?? -1);
    expect(reported).toBe(actuallyHidden);
  });

  it("gives the queued summary priority over finished lines", () => {
    const lines = renderFleet({ running: 4, queued: 2, finished: 3 });
    expect(lines.join("\n")).toContain("2 queued");
  });

  it("renders everything with no footer when the fleet fits", () => {
    const lines = renderFleet({ running: 2, queued: 1, finished: 1 });
    expect(lines.join("\n")).toContain("1 queued");
    expect(footer(lines)).toBeUndefined();
  });

  // A background resume runs an agent that already finished once. markFinished
  // only seeds an age it has not seen before, so without markRunning the agent
  // carries its previous run's age — already past the linger limit — and the
  // resumed run's ✓ line never renders: the agent just disappears.
  it("shows the completion line again after a finished agent is resumed", () => {
    const agent = record("resumed", "completed");
    const activity = new Map([[agent.id, {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    } as AgentActivity]]);
    const widget = new AgentWidget({ listAgents: () => [agent] } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k: any, c: any) => { factory = c; } } as any);
    const render = () => {
      widget.update();
      return (factory?.({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render() ?? []).join("\n");
    };

    // First run finishes and ages out of the widget.
    widget.markFinished(agent.id);
    widget.onTurnStart();
    widget.onTurnStart();
    expect(render()).not.toContain("resumed description");

    // Background resume puts it back on the running list.
    agent.status = "running";
    widget.markRunning(agent.id);
    expect(render()).toContain("resumed description");

    // ...and its completion is visible when the resumed run settles.
    agent.status = "completed";
    widget.markFinished(agent.id);
    expect(render()).toContain("resumed description");
  });
});
