/** Real extension/manager/widget wiring; only the provider-facing runner is stubbed. */
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/workers/agent-runner.js")>("../../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../../../src/workers/agent-runner.js";
import workersExtension from "../../../src/workers/index.js";
import type { AgentRecord } from "../../../src/workers/types.js";
import { SPINNER, type Theme, type UICtx } from "../../../src/workers/ui/agent-widget.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "../helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let shutdown: (() => Promise<void>) | undefined;
afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  hermetic?.restore();
  hermetic = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("mounts and animates a sole settled live worker on foreground resume without a start callback", async () => {
  // Keep ordinary timeout/immediate helpers real; only animation intervals and
  // wall-clock labels are under test. The manager retains its cleanup interval.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  hermetic = hermeticDir({ settings: { outputTranscript: false, widgetMode: "all", fleetView: false } });
  const boot = makePi();
  workersExtension(boot.pi);
  shutdown = () => boot.lifecycle.get("session_shutdown")();

  const theme: Theme = { fg: (_color, text) => text, bold: text => text };
  const requestRender = vi.fn();
  const tui = { terminal: { columns: 120 }, requestRender };
  let component: { render(): string[] } | undefined;
  const setWidget: UICtx["setWidget"] = (key, factory) => {
    if (key === "agents") component = factory?.(tui, theme);
  };
  const setStatus = vi.fn();
  const parent = ctx({ hasUI: true, ui: {
    setWidget, setStatus, notify: vi.fn(), onTerminalInput: () => () => {}, getEditorText: () => "",
  } });
  await boot.lifecycle.get("session_start")({}, parent);

  const session = {
    messages: [], dispose: vi.fn(), subscribe: () => () => {}, getActiveToolNames: () => [],
  };
  vi.mocked(runAgent).mockImplementation(async (_context, _prompt, options) => {
    options?.onSessionCreated?.(session as never);
    return { responseText: "first answer", session, aborted: false, steered: false } as never;
  });
  const tool = boot.tools.get("Agent");
  const first = await tool.execute("first", {
    description: "sole worker", prompt: "first task", run_in_background: false,
  }, undefined, undefined, parent);
  const id = first.details.agentId as string;
  expect(id).toBeTruthy();
  const registry = (globalThis as unknown as Record<symbol, { getRecord(id: string): AgentRecord }>)[Symbol.for("pi-subagents:manager")];
  expect(registry.getRecord(id).status).toBe("completed");

  // Let the old row stop animating, then age it out as the next parent tool
  // starts. No sibling worker or leftover timer can rescue this resume.
  vi.advanceTimersByTime(80);
  await boot.lifecycle.get("tool_execution_start")({}, parent);
  expect(component).toBeUndefined();
  const idleTimers = vi.getTimerCount();
  requestRender.mockClear();
  vi.advanceTimersByTime(160);
  expect(requestRender).not.toHaveBeenCalled();
  const startsBefore = boot.pi.events.emit.mock.calls.filter(([event]: [string]) => event === "subagents:started").length;

  let finish!: () => void;
  vi.mocked(resumeAgent).mockImplementation(() => new Promise(resolve => {
    finish = () => resolve({ text: "resumed answer", aborted: false, steered: false });
  }));
  const resuming = tool.execute("resume", {
    resume: id, prompt: "continue", run_in_background: false,
  }, undefined, undefined, parent);

  expect(registry.getRecord(id).status).toBe("running");
  expect(resumeAgent).toHaveBeenCalledTimes(1);
  expect(boot.pi.events.emit.mock.calls.filter(([event]: [string]) => event === "subagents:started")).toHaveLength(startsBefore);
  expect(component?.render().join("\n")).toContain("sole worker");
  expect(setStatus).toHaveBeenLastCalledWith("subagents", "1 running agent");
  expect(vi.getTimerCount()).toBe(idleTimers + 1);
  requestRender.mockClear();
  vi.advanceTimersByTime(160);
  expect(requestRender).toHaveBeenCalledTimes(2);
  expect(component?.render().some(line => SPINNER.some(frame => line.includes(frame)))).toBe(true);

  finish();
  const result = await resuming;
  expect(result.content[0].text).toContain("resumed answer");
  vi.advanceTimersByTime(80);
  expect(registry.getRecord(id).status).toBe("completed");
  expect(vi.getTimerCount()).toBe(idleTimers);
  expect(component?.render().join("\n")).toContain("✓ sole worker");
});
