import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/workers/agent-runner.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/workers/agent-runner.js")>(),
  runAgent: vi.fn(),
}));
vi.mock("../../src/workers/ui/agent-widget.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/workers/ui/agent-widget.js")>(),
  AgentWidget: class {
    setUICtx() {} ensureTimer() {} update() {} onTurnStart() {} markFinished() {} markRunning() {} dispose() {}
  },
}));
let backgroundAction: ((record: AgentRecord, notify: (text: string) => void) => ViewerBackgroundAction) | undefined;
vi.mock("../../src/workers/ui/fleet-list.js", () => ({
  FleetList: class {
    constructor(...args: unknown[]) { backgroundAction = args[6] as typeof backgroundAction; }
    setUICtx() {} setEnabled() {} update() {} ensureTimer() {} onAgentFinished() {} dispose() {}
  },
}));

import { type RunOptions, runAgent } from "../../src/workers/agent-runner.js";
import workers from "../../src/workers/index.js";
import type { AgentRecord } from "../../src/workers/types.js";
import type { ViewerBackgroundAction } from "../../src/workers/ui/conversation-viewer.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const managerKey = Symbol.for("pi-subagents:manager");
let hermetic: Hermetic;
let booted: ReturnType<typeof makePi>;
let runOptions: RunOptions;
let finish: (text?: string) => void;
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  hermetic = hermeticDir({ settings: { outputTranscript: false, rememberAgents: false } });
  booted = makePi();
  vi.mocked(runAgent).mockReset();
  vi.mocked(runAgent).mockImplementation((_context, _prompt, options) => new Promise(resolve => {
    runOptions = options!;
    const session = { dispose: vi.fn(), subscribe: () => () => {}, messages: [] };
    options?.onSessionCreated?.(session as never);
    finish = (text = "DONE") => resolve({ responseText: text, session: session as never, aborted: false, steered: false });
  }));
  workers(booted.pi);
});
afterEach(async () => {
  finish?.();
  await drain();
  await booted.lifecycle.get("session_shutdown")?.();
  delete (globalThis as Record<symbol, unknown>)[managerKey];
  hermetic.restore();
  vi.useRealTimers();
});

function start(signal?: AbortSignal) {
  const onUpdate = vi.fn();
  const execution = booted.tools.get("Agent").execute("foreground", {
    prompt: "task", description: "task", run_in_background: false,
  }, signal, onUpdate, ctx());
  return { execution, onUpdate };
}

function deltas(count: number) {
  for (let i = 0; i < count; i++) runOptions.onTextDelta?.("x", "latest first line\n" + "x".repeat(i));
}

describe("foreground presentation coalescing", () => {
  it("samples a thousand deltas once per animation tick and immediately flushes tool/turn/usage transitions", async () => {
    const { execution, onUpdate } = start();
    await drain();
    onUpdate.mockClear();
    deltas(1000);
    expect(onUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(79);
    expect(onUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate.mock.lastCall![0].details.activity).toBe("latest first line");

    runOptions.onToolActivity?.({ type: "start", toolName: "read" });
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.lastCall![0].details.activity).toBe("reading…");
    runOptions.onToolActivity?.({ type: "end", toolName: "read" });
    expect(onUpdate.mock.lastCall![0].details.toolUses).toBe(1);
    runOptions.onTurnEnd?.(3);
    expect(onUpdate.mock.lastCall![0].details.turnCount).toBe(3);
    runOptions.onAssistantUsage?.({ input: 10, output: 2, cacheWrite: 0 });
    expect(onUpdate.mock.lastCall![0].details.tokens).toBe("12 token");
    expect(booted.pi.events.emit).toHaveBeenCalledWith("subagents:usage", expect.objectContaining({ usage: expect.objectContaining({ input: 10, output: 2 }) }));

    deltas(1000);
    finish("FINAL WITHOUT ANOTHER TICK");
    expect(textOf(await execution)).toContain("FINAL WITHOUT ANOTHER TICK");
    onUpdate.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("cancels animation and pending text presentation as soon as the caller aborts", async () => {
    const controller = new AbortController();
    const { execution, onUpdate } = start(controller.signal);
    await drain();
    deltas(1000);
    const before = vi.getTimerCount();
    controller.abort();
    expect(vi.getTimerCount()).toBe(before - 1);
    onUpdate.mockClear();
    runOptions.onToolActivity?.({ type: "start", toolName: "read" });
    deltas(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onUpdate).not.toHaveBeenCalled();
    finish("partial");
    await execution;
  });

  it("cancels presentation on handoff while state, usage and background completion stay live", async () => {
    const { execution, onUpdate } = start();
    await drain();
    deltas(1000);
    const manager = (globalThis as Record<symbol, unknown>)[managerKey] as { getRecord(id: string): AgentRecord };
    const record = manager.getRecord(runOptions.agentId!);
    const before = vi.getTimerCount();
    backgroundAction!(record, () => {}).send();
    expect(vi.getTimerCount()).toBe(before - 1);
    expect(textOf(await execution)).toContain("Agent started in background.");
    onUpdate.mockClear();
    deltas(1000);
    runOptions.onAssistantUsage?.({ input: 5, output: 3, cacheWrite: 0 });
    expect(record.lifetimeUsage).toMatchObject({ input: 5, output: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onUpdate).not.toHaveBeenCalled();
    finish("BACKGROUND FINAL");
    await drain();
    expect(booted.pi.sendMessage).toHaveBeenCalledOnce();
    expect(booted.pi.sendMessage.mock.lastCall![0].content).toContain("BACKGROUND FINAL");
  });

  it("removes the abort listener and timer after settlement", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const { execution, onUpdate } = start(controller.signal);
    await drain();
    deltas(1000);
    finish();
    await execution;
    expect(remove.mock.calls.some(([type]) => type === "abort")).toBe(true);
    onUpdate.mockClear();
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
