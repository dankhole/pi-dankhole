/** Deterministic work-count guards: no elapsed-time CI thresholds or providers. */
import { createAgentSession, createExtensionRuntime, type ResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../../../src/workers/agent-manager.js";
import type { AgentRecord, WidgetMode } from "../../../src/workers/types.js";
import { type AgentActivity, AgentWidget, describeActivity, type Theme, type UICtx } from "../../../src/workers/ui/agent-widget.js";
import { FleetList, type FleetUICtx } from "../../../src/workers/ui/fleet-list.js";
import { getSessionContextPercent, toReportedUsage } from "../../../src/workers/usage.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

const theme: Theme = { fg: (_color, text) => text, bold: text => text };
const disposables: { dispose(): void }[] = [];
afterEach(() => {
  for (const item of disposables.splice(0)) item.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function record(id: string, status: AgentRecord["status"] = "running"): AgentRecord {
  return {
    id, description: `worker ${id}`, status, toolUses: 0, startedAt: Date.now() - 1000,
    completedAt: status === "running" || status === "queued" ? undefined : Date.now(),
    compactionCount: 0, lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
  } as AgentRecord;
}

function widgetHarness(records: AgentRecord[], mode: () => WidgetMode = () => "all") {
  const activities = new Map<string, AgentActivity>();
  for (const agent of records) activities.set(agent.id, {
    activeTools: new Map(), responseText: "first line\n" + "long response\n".repeat(10_000),
    toolUses: 0, turnCount: 1,
    session: { getContextUsage: vi.fn(() => ({ tokens: 100, contextWindow: 1000, percent: 10 })) },
  });
  const manager = { listAgents: vi.fn(() => records) };
  const widget = new AgentWidget(manager as unknown as AgentManager, activities, mode);
  disposables.push(widget);
  const requestRender = vi.fn();
  const tui = { terminal: { columns: 180 }, requestRender };
  let component: { render(): string[]; invalidate(): void } | undefined;
  let liveTheme = theme;
  const setWidget: UICtx["setWidget"] = (_key, factory) => { component = factory?.(tui, liveTheme); };
  const setStatus = vi.fn();
  widget.setUICtx({ setStatus, setWidget });
  widget.update();
  return {
    widget, activities, manager, requestRender, setStatus, render: () => component?.render() ?? [],
    invalidate: () => component?.invalidate(), setTheme: (next: Theme) => { liveTheme = next; },
  };
}

describe("widget visibility and activity work", () => {
  it("formats only five running pairs, not the other 95 workers or hidden finished rows", () => {
    vi.useFakeTimers();
    const records = Array.from({ length: 100 }, (_, i) => record(`r${i}`));
    const finished = Array.from({ length: 100 }, (_, i) => record(`f${i}`, "completed"));
    const h = widgetHarness([...records, ...finished]);
    const hiddenDescription = vi.fn(() => "hidden finished worker");
    Object.defineProperty(finished[0], "description", { get: hiddenDescription });
    const rendered = h.render().join("\n");
    expect(rendered).toContain("+195 more (95 running, 100 finished)");
    for (let i = 0; i < records.length; i++) {
      const session = h.activities.get(records[i].id)?.session;
      expect(session?.getContextUsage).toHaveBeenCalledTimes(i < 5 ? 1 : 0);
    }
    expect(hiddenDescription).not.toHaveBeenCalled();
  });

  it("reserves the queue summary before choosing expensive rows", () => {
    vi.useFakeTimers();
    const records = [...Array.from({ length: 20 }, (_, i) => record(`r${i}`)), record("q", "queued"), record("f", "completed")];
    const h = widgetHarness(records);
    expect(h.render().join("\n")).toContain("1 queued");
    expect(h.render()).toHaveLength(12);
    records.forEach((agent, index) => {
      expect(h.activities.get(agent.id)?.session?.getContextUsage).toHaveBeenCalledTimes(index < 4 ? 2 : 0);
    });
  });

  it("takes only the first nonblank line without splitting the whole streamed response", () => {
    const text = " \n\t\n  Opening sentence  \n" + "ignored\n".repeat(100_000);
    const split = vi.spyOn(String.prototype, "split");
    expect(describeActivity(new Map(), text)).toBe("Opening sentence");
    expect(split).not.toHaveBeenCalled();
    expect(describeActivity(new Map(), "\n\t \n")).toBe("thinking…");
    expect(describeActivity(new Map(), "a".repeat(70))).toBe("a".repeat(60) + "…");
    expect(describeActivity(new Map([["call", "read"]]), text)).toBe("reading…");
  });
});

describe("widget animation and age lifecycle", () => {
  it("never ticks for settled/queued-only rows; resumes ticking for running rows and stops on settlement", () => {
    vi.useFakeTimers();
    const agent = record("worker", "completed");
    const h = widgetHarness([agent]);
    h.widget.markFinished(agent.id);
    h.widget.ensureTimer();
    expect(h.render().join("\n")).toContain("✓ worker worker");
    vi.advanceTimersByTime(800);
    expect(h.requestRender).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    agent.status = "queued";
    h.widget.update();
    h.requestRender.mockClear();
    h.widget.ensureTimer();
    vi.advanceTimersByTime(800);
    expect(h.requestRender).not.toHaveBeenCalled();
    expect(h.setStatus).toHaveBeenLastCalledWith("subagents", "1 queued agent");

    agent.status = "running";
    h.widget.markRunning(agent.id);
    h.widget.update();
    h.requestRender.mockClear();
    vi.advanceTimersByTime(160);
    expect(h.requestRender).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    agent.status = "completed";
    h.widget.markFinished(agent.id);
    h.widget.update();
    h.requestRender.mockClear();
    vi.advanceTimersByTime(800);
    expect(h.requestRender).not.toHaveBeenCalled();
    expect(h.render().join("\n")).toContain("✓ worker worker");
    h.widget.onTurnStart();
    expect(h.render()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes live settings, errors and resumed rows without a settled timer", () => {
    vi.useFakeTimers();
    let mode: WidgetMode = "all";
    const agent = record("error", "error");
    const h = widgetHarness([agent], () => mode);
    h.widget.markFinished(agent.id);
    h.widget.onTurnStart();
    expect(h.render().join("\n")).toContain("worker error");
    h.widget.onTurnStart();
    expect(h.render()).toEqual([]);
    agent.status = "running";
    h.widget.markRunning(agent.id);
    h.widget.update();
    expect(vi.getTimerCount()).toBe(1);
    mode = "off";
    h.widget.update();
    expect(h.render()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    mode = "all";
    h.widget.update();
    expect(vi.getTimerCount()).toBe(1);
    h.widget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes a settled widget's theme on invalidation without an animation timer", () => {
    vi.useFakeTimers();
    const h = widgetHarness([record("settled", "completed")]);
    h.setTheme({ fg: (_color, text) => `[new-theme:${text}]`, bold: text => text });
    h.invalidate();
    expect(h.render().join("\n")).toContain("new-theme:");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prunes evicted completion metadata during ongoing work, not only the empty state", () => {
    vi.useFakeTimers();
    const records = [record("running")];
    const h = widgetHarness(records);
    for (let i = 0; i < 1000; i++) {
      const finished = record(`done-${i}`, "completed");
      records.push(finished);
      h.widget.markFinished(finished.id);
      h.widget.update();
      records.pop();
      h.widget.update();
    }
    // Instrument the bounded bookkeeping directly, not a timing or heap threshold.
    const ages = (h.widget as unknown as { finishedTurnAge: Map<string, number> }).finishedTurnAge;
    expect(ages.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
  });
});

it("Fleet operations fetch/sort one roster, including navigation and viewer close", async () => {
  vi.useFakeTimers();
  const session = { messages: [], subscribe: () => () => {} };
  const records = Array.from({ length: 20 }, (_, i) => ({ ...record(String(i)), session }) as unknown as AgentRecord);
  const manager = { listAgents: vi.fn(() => records), abort: vi.fn(), steer: vi.fn() };
  const fleet = new FleetList(manager as unknown as AgentManager, new Map());
  disposables.push(fleet);
  let component: { render(width: number): string[] } | undefined;
  let close: (() => void) | undefined;
  const tui = { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() };
  const ui: FleetUICtx = {
    setWidget: (_key, factory) => { component = factory?.(tui, theme); },
    onTerminalInput: () => () => {}, getEditorText: () => "", notify: () => {},
    custom: factory => new Promise(resolve => {
      factory(tui, theme, undefined, result => resolve(result));
      close = () => resolve(undefined as never);
    }),
  };
  fleet.setUICtx(ui);
  for (const operation of [
    () => fleet.update(),
    () => component?.render(120),
    () => fleet.handleKey("\x1b[B"), // activate
    () => fleet.handleKey("\x1b[B"), // next
    () => fleet.handleKey("\r"), // viewer
  ]) {
    manager.listAgents.mockClear();
    operation();
    expect(manager.listAgents).toHaveBeenCalledTimes(1);
  }
  manager.listAgents.mockClear();
  close?.();
  await Promise.resolve();
  expect(manager.listAgents).toHaveBeenCalledTimes(1);
});

// The full-control SDK loader keeps all discovery/config/extension side effects
// out of these real AgentSession API checks. No prompts or provider streams run.
const resources: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => "",
  getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
};

it("caches the real Pi context API across frames and invalidates append/edit/branch/compaction/session/model changes", async () => {
  const faux = registerFauxProvider({ provider: "widget-perf", models: [{ id: "context", contextWindow: 200_000 }] });
  const model = faux.getModel();
  const backend = fauxModelBackend(model);
  let physicalModel = model;
  backend.modelRuntime.getPhysicalModel = () => physicalModel;
  const { session } = await createAgentSession({
    cwd: process.cwd(), sessionManager: SessionManager.inMemory(), model,
    modelRuntime: backend.modelRuntime,
    resourceLoader: resources, settingsManager: SettingsManager.inMemory(), tools: [],
  });
  disposables.push(session);
  try {
    const context = vi.spyOn(session, "getContextUsage");
    const aggregate = vi.spyOn(session, "getSessionStats").mockImplementation(() => { throw new Error("aggregate stats are forbidden on the presentation path"); });
    const projection = vi.spyOn(session.sessionManager, "buildSessionProjection");
    const read = () => getSessionContextPercent(session);
    const first = read();
    for (let i = 0; i < 100; i++) expect(read()).toBe(first);
    expect(context).toHaveBeenCalledTimes(1);
    expect(projection).toHaveBeenCalledTimes(1);
    const user = session.sessionManager.appendMessage({ role: "user", content: "Context text", timestamp: 1 });
    expect(read()).toBeGreaterThan(first ?? -1);
    session.sessionManager.appendContextEdit(user, { content: "A longer context replacement sentence." });
    read();
    session.sessionManager.branch(user);
    read();
    expect(context).toHaveBeenCalledTimes(4);
    session.sessionManager.appendCompaction("Compacted context", user, 10_000);
    expect(read()).toBeNull();
    expect(read()).toBeNull();
    expect(context).toHaveBeenCalledTimes(5);
    const usage = toReportedUsage({ input: 1000, output: 500, cacheWrite: 0 });
    if (!usage) throw new Error("expected usage");
    session.sessionManager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "Fresh response" }],
      api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 2,
    });
    const afterCompaction = read();
    expect(afterCompaction).not.toBeNull();
    expect(context).toHaveBeenCalledTimes(6);
    await session.setModel({ ...model, contextWindow: 100_000 });
    expect(read()).toBeCloseTo((afterCompaction ?? 0) * 2);
    expect(context).toHaveBeenCalledTimes(7);

    // A virtual selection takes its limits from the public routedModel getter.
    // A routed catalog replacement can change those limits without appending or
    // changing selected model/history/messages. Read the real Pi API throughout.
    await session.setModel({ ...model, api: "pi-virtual" });
    session.refreshContext();
    const beforeRouteSwitch = read();
    const leaf = session.sessionManager.getLeafId();
    const entryCount = session.sessionManager.getEntryCount();
    physicalModel = { ...model, id: "other-route", contextWindow: 50_000 };
    expect(read()).toBeCloseTo((beforeRouteSwitch ?? 0) * 4);
    expect(session.sessionManager.getLeafId()).toBe(leaf);
    expect(session.sessionManager.getEntryCount()).toBe(entryCount);
    expect(context).toHaveBeenCalledTimes(9);
    physicalModel.contextWindow = 100_000;
    expect(read()).toBeCloseTo((beforeRouteSwitch ?? 0) * 2);
    expect(context).toHaveBeenCalledTimes(10);
    expect(read()).toBeCloseTo((beforeRouteSwitch ?? 0) * 2);
    expect(context).toHaveBeenCalledTimes(10);

    session.sessionManager.newSession();
    read();
    expect(context).toHaveBeenCalledTimes(11);
    expect(aggregate).not.toHaveBeenCalled();
  } finally { faux.unregister(); }
}, 30_000);
