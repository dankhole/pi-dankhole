import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentManager } from "../../src/workers/agent-manager.js";
import type { AgentRecord } from "../../src/workers/types.js";
import type { Theme } from "../../src/workers/ui/agent-widget.js";
import { FleetList, type FleetUICtx } from "../../src/workers/ui/fleet-list.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); });

function record(id: string): AgentRecord {
  return { id, description: id, status: "running", startedAt: Date.now(), toolUses: 0,
    lifetimeUsage: { input: 10, output: 0, cacheWrite: 0 }, compactionCount: 0,
    session: { messages: [], subscribe: () => () => {} } as never };
}

function harness(records: AgentRecord[]) {
  const requestRender = vi.fn();
  const tui = { mode: "regular", terminal: { columns: 120, rows: 40 }, requestRender };
  let theme: Theme = { fg: (_color, text) => `\x1b[31m${text}\x1b[39m`, bold: text => text };
  let component: Component | undefined;
  let overlay: Component | undefined;
  let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const setWidget = vi.fn<FleetUICtx["setWidget"]>((_key, factory) => { component = factory?.(tui, theme); });
  const ui: FleetUICtx = {
    setWidget, getEditorText: () => "", notify() {},
    onTerminalInput(handler) { input = handler; return () => { input = undefined; }; },
    custom: factory => new Promise(resolve => { overlay = factory(tui, theme, undefined, resolve); }),
  };
  const manager = { listAgents: () => records, abort: () => true, steer: () => true } as unknown as AgentManager;
  const fleet = new FleetList(manager, new Map());
  fleet.setUICtx(ui);
  fleet.update();
  return { fleet, requestRender, setWidget,
    render: () => component?.render(120).join("\n") ?? "",
    openFirst() { input?.("\x1b[B"); input?.("\x1b[B"); input?.("\r"); expect(overlay).toBeDefined(); },
    async close() { overlay?.handleInput?.("\x1b"); await Promise.resolve(); },
    changeTheme() {
      theme = { fg: (_color, text) => `\x1b[32m${text}\x1b[39m`, bold: text => text };
      component?.invalidate();
    },
  };
}

it("refreshes a static viewed result on theme invalidation without reviving the interval", async () => {
  const worker = record("viewed-result");
  const h = harness([worker]);
  try {
    h.openFirst();
    worker.status = "completed"; worker.completedAt = Date.now();
    h.fleet.onAgentFinished(worker.id);
    vi.advanceTimersByTime(4000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.render()).toContain("viewed-result");
    const registrations = h.setWidget.mock.calls.length;
    h.changeTheme();
    expect(h.setWidget).toHaveBeenCalledTimes(registrations + 1);
    expect(h.render()).toContain("\x1b[32m");
    expect(h.render()).not.toContain("\x1b[31m");
    expect(vi.getTimerCount()).toBe(0);
    h.requestRender.mockClear();
    vi.advanceTimersByTime(120_000);
    expect(h.requestRender.mock.calls).toHaveLength(0);
    await h.close();
    expect(h.render()).toBe("");
  } finally { h.fleet.dispose(); }
});

it.each(["running", "queued"] as const)("keeps the fleet timer for a %s worker awaiting its session beside a viewed result", async status => {
  const viewed = record("viewed-result");
  const records = [viewed];
  const h = harness(records); // Fleet only: no above-editor widget/timer can rescue discovery.
  try {
    h.openFirst();
    viewed.status = "completed"; viewed.completedAt = Date.now();
    h.fleet.onAgentFinished(viewed.id);
    vi.advanceTimersByTime(4000);
    expect(vi.getTimerCount()).toBe(0);

    const pending = record("delayed-session");
    pending.status = status;
    pending.session = undefined;
    records.push(pending);
    h.fleet.ensureTimer(); h.fleet.update();
    expect(h.render()).not.toContain("delayed-session");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(1);

    // Background/programmatic session-created callbacks need not call update
    // or ensureTimer: the existing fleet tick must discover the session itself.
    pending.session = record("session-source").session;
    h.requestRender.mockClear();
    vi.advanceTimersByTime(200);
    expect(h.requestRender).toHaveBeenCalledTimes(1);
    expect(h.render()).toContain("delayed-session");
    pending.status = "completed"; pending.completedAt = Date.now();
    h.fleet.onAgentFinished(pending.id);
    vi.advanceTimersByTime(4000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.render()).toContain("viewed-result");
    expect(h.render()).not.toContain("delayed-session");
    h.requestRender.mockClear();
    vi.advanceTimersByTime(120_000);
    expect(h.requestRender.mock.calls).toHaveLength(0);
    await h.close();
  } finally { h.fleet.dispose(); }
});

it("discovers an active sessionless worker even without another visible row", () => {
  const pending = record("first-delayed-session");
  pending.session = undefined;
  const h = harness([pending]);
  try {
    expect(h.render()).toBe("");
    expect(h.fleet.getRefreshTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(h.fleet.getRefreshTimerCount()).toBe(1);
    pending.session = record("session-source").session;
    vi.advanceTimersByTime(200);
    expect(h.render()).toContain("first-delayed-session");
    pending.status = "completed"; pending.completedAt = Date.now();
    h.fleet.onAgentFinished(pending.id);
    vi.advanceTimersByTime(4_000);
    expect(h.render()).toBe("");
    expect(h.fleet.getRefreshTimerCount()).toBe(0);
  } finally { h.fleet.dispose(); }
});

it("expires sibling linger rows, retains the viewed result, and rearms live stats on resume", async () => {
  const viewed = record("viewed-result");
  const sibling = record("sibling-result");
  const h = harness([viewed, sibling]);
  try {
    h.openFirst();
    viewed.status = "completed"; viewed.completedAt = Date.now();
    h.fleet.onAgentFinished(viewed.id);
    vi.advanceTimersByTime(2000);
    sibling.status = "completed"; sibling.completedAt = Date.now();
    h.fleet.onAgentFinished(sibling.id);
    vi.advanceTimersByTime(2000);
    expect(vi.getTimerCount()).toBe(1);
    expect(h.render()).toContain("sibling-result");
    vi.advanceTimersByTime(2000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.render()).toContain("viewed-result");
    expect(h.render()).not.toContain("sibling-result");

    viewed.status = "running"; viewed.completedAt = undefined;
    h.fleet.ensureTimer(); h.fleet.update();
    h.requestRender.mockClear();
    vi.advanceTimersByTime(400);
    expect(h.requestRender).toHaveBeenCalledTimes(2);
    viewed.status = "completed"; viewed.completedAt = Date.now();
    h.fleet.onAgentFinished(viewed.id);
    vi.advanceTimersByTime(4000);
    expect(vi.getTimerCount()).toBe(0);
    await h.close();
    expect(h.render()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  } finally { h.fleet.dispose(); }
});
