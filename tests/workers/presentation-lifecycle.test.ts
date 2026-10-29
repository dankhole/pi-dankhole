import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../../src/workers/agent-manager.js";
import type { AgentRecord } from "../../src/workers/types.js";
import { AgentWidget, type UICtx } from "../../src/workers/ui/agent-widget.js";
import { FleetList, type FleetUICtx } from "../../src/workers/ui/fleet-list.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function fixture() {
  const record = {
    id: "worker", description: "Worker", status: "running", startedAt: Date.now(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    session: { messages: [], subscribe: () => () => {} },
  } as AgentRecord;
  const listAgents = vi.fn(() => [record]);
  const manager = { listAgents } as unknown as AgentManager;
  const ui = {
    setWidget: vi.fn(), setStatus: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: () => "", notify: vi.fn(), custom: vi.fn(),
  };
  return { record, listAgents, manager, ui };
}

describe("worker presentation timer ownership", () => {
  it("keeps the running widget's 80ms cadence but stops for settled and queued rows", () => {
    const h = fixture();
    const widget = new AgentWidget(h.manager, new Map());
    widget.setUICtx(h.ui);
    widget.update();
    const before = h.listAgents.mock.calls.length;
    vi.advanceTimersByTime(79);
    expect(h.listAgents).toHaveBeenCalledTimes(before);
    vi.advanceTimersByTime(1);
    expect(h.listAgents).toHaveBeenCalledTimes(before + 1);
    h.record.status = "completed";
    h.record.completedAt = Date.now();
    widget.markFinished(h.record.id);
    widget.update();
    expect(vi.getTimerCount()).toBe(0);
    h.record.status = "queued";
    widget.update();
    widget.ensureTimer();
    expect(vi.getTimerCount()).toBe(0);
    widget.dispose();
  });

  it("does not resurrect disposed widget UI/timers from late completion or invalidation callbacks", () => {
    const h = fixture();
    const widget = new AgentWidget(h.manager, new Map());
    widget.setUICtx(h.ui);
    widget.update();
    const factory = h.ui.setWidget.mock.calls[0][1] as Exclude<Parameters<UICtx["setWidget"]>[1], undefined>;
    const component = factory({ terminal: { columns: 100 }, requestRender: vi.fn() }, { fg: (_color, text) => text, bold: text => text });
    h.ui.setWidget.mockImplementation((_key, content) => {
      if (content === undefined) component.invalidate();
    });
    widget.dispose();
    h.ui.setWidget.mockClear();
    h.ui.setStatus.mockClear();
    widget.ensureTimer();
    widget.markFinished(h.record.id);
    widget.update();
    component.invalidate();
    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.ui.setWidget).not.toHaveBeenCalled();
    expect(h.ui.setStatus).not.toHaveBeenCalled();
  });

  it("does not arm the fleet's 200ms interval before UI binding or after disposal", () => {
    const h = fixture();
    const fleet = new FleetList(h.manager, new Map());
    fleet.ensureTimer();
    expect(vi.getTimerCount()).toBe(0);
    fleet.setUICtx(h.ui as FleetUICtx);
    fleet.update();
    const before = h.listAgents.mock.calls.length;
    vi.advanceTimersByTime(199);
    expect(h.listAgents).toHaveBeenCalledTimes(before);
    vi.advanceTimersByTime(1);
    expect(h.listAgents).toHaveBeenCalledTimes(before + 1);
    fleet.dispose();
    fleet.ensureTimer();
    fleet.onAgentFinished(h.record.id);
    fleet.update();
    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.ui.onTerminalInput.mock.results[0].value).toHaveBeenCalledOnce();
  });

  it("does not revive disposed fleet UI from theme invalidation during removal or a late callback", () => {
    const h = fixture();
    const fleet = new FleetList(h.manager, new Map());
    fleet.setUICtx(h.ui as FleetUICtx);
    fleet.update();
    const factory = h.ui.setWidget.mock.calls[0][1] as Exclude<Parameters<FleetUICtx["setWidget"]>[1], undefined>;
    const component = factory({ terminal: { columns: 100 }, requestRender: vi.fn() }, { fg: (_color, text) => text, bold: text => text });
    h.ui.setWidget.mockImplementation((_key, content) => {
      if (content === undefined) component.invalidate();
    });
    fleet.dispose();
    h.ui.setWidget.mockClear();
    component.invalidate();
    fleet.ensureTimer();
    vi.advanceTimersByTime(1_000);
    expect(fleet.getRefreshTimerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.ui.setWidget).not.toHaveBeenCalled();
  });

  it("stops fleet ticking on disable and once a completed row's linger expires", () => {
    const h = fixture();
    const fleet = new FleetList(h.manager, new Map());
    fleet.setUICtx(h.ui as FleetUICtx);
    fleet.update();
    fleet.setEnabled(false);
    fleet.ensureTimer();
    expect(vi.getTimerCount()).toBe(0);
    fleet.setEnabled(true);
    expect(vi.getTimerCount()).toBe(1);
    h.record.status = "completed";
    h.record.completedAt = Date.now();
    fleet.onAgentFinished(h.record.id);
    vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.ui.setWidget).toHaveBeenLastCalledWith("fleet", undefined);
    fleet.dispose();
  });
});
