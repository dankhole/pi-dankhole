import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../../src/workers/agent-runner.js";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../../src/workers/agent-runner.js";
import subagentsExtension from "../../src/workers/index.js";
import { type BootedPi, ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
let booted: BootedPi | undefined;
let environment: Hermetic | undefined;
const priorManager = Reflect.get(globalThis, MANAGER_KEY);

afterEach(async () => {
  await booted?.lifecycle.get("session_shutdown")?.();
  if (priorManager === undefined) Reflect.deleteProperty(globalThis, MANAGER_KEY);
  else Reflect.set(globalThis, MANAGER_KEY, priorManager);
  booted = undefined;
  environment?.restore();
  environment = undefined;
  vi.mocked(runAgent).mockReset();
});

async function boot(running: boolean) {
  environment = hermeticDir({ settings: { outputTranscript: false } });
  Reflect.deleteProperty(globalThis, MANAGER_KEY);
  booted = makePi();
  subagentsExtension(booted.pi);
  const context = ctx({ isIdle: () => !running, signal: running ? new AbortController().signal : undefined });
  await booted.lifecycle.get("session_start")({}, context);
  return { ...booted, context };
}

function completedRun() {
  return {
    responseText: "done", session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false,
  } as Awaited<ReturnType<typeof runAgent>>;
}

const spawn = (b: Awaited<ReturnType<typeof boot>>, description: string) => b.tools.get("Agent").execute(
  description, { prompt: "reply done", description, run_in_background: true }, undefined, undefined, b.context,
);

const turnEnd = (b: BootedPi) => b.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "toolUse" } });

describe("background completion notification wiring", () => {
  const statusKey = "subagents:pending-completions";
  const pendingStatuses = (b: Awaited<ReturnType<typeof boot>>) => b.context.ui.setStatus.mock.calls
    .filter(([key]: [string, unknown]) => key === statusKey)
    .map(([, value]: [string, unknown]) => value);

  it("shows and coalesces waiting counts without sending until a boundary, then clears", async () => {
    vi.mocked(runAgent).mockResolvedValue(completedRun());
    const b = await boot(true);
    b.context.hasUI = true;
    await spawn(b, "first child");
    await flush();
    expect(b.context.ui.setStatus).toHaveBeenCalledWith(statusKey, "1 worker result waiting for the main agent");
    await spawn(b, "second child");
    await flush();
    expect(pendingStatuses(b)).toEqual(["1 worker result waiting for the main agent", "2 worker results waiting for the main agent"]);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    turnEnd(b);
    expect(b.context.ui.setStatus).toHaveBeenLastCalledWith(statusKey, undefined);
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    const calls = b.context.ui.setStatus.mock.calls.length;
    turnEnd(b);
    expect(b.context.ui.setStatus).toHaveBeenCalledTimes(calls);
  });

  it("clears the original UI's pending status on shutdown", async () => {
    vi.mocked(runAgent).mockResolvedValue(completedRun());
    const b = await boot(true);
    b.context.hasUI = true;
    await spawn(b, "waiting child");
    await flush();
    await b.lifecycle.get("session_shutdown")();
    expect(pendingStatuses(b)).toEqual(["1 worker result waiting for the main agent", undefined]);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("restores the unchanged pending count on the replacement UI and clears the original", async () => {
    vi.mocked(runAgent).mockResolvedValue(completedRun());
    const b = await boot(true);
    b.context.hasUI = true;
    await spawn(b, "waiting child");
    await flush();
    const replacement = ctx({ hasUI: true });
    replacement.ui.onTerminalInput = vi.fn(() => vi.fn());
    await b.lifecycle.get("session_start")({}, replacement);
    expect(pendingStatuses(b)).toEqual(["1 worker result waiting for the main agent", undefined]);
    expect(replacement.ui.setStatus).toHaveBeenCalledWith(statusKey, "1 worker result waiting for the main agent");
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    turnEnd(b);
    expect(replacement.ui.setStatus).toHaveBeenLastCalledWith(statusKey, undefined);
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("keeps the post-summary delivery check when a UI context getter throws", async () => {
    vi.mocked(runAgent).mockResolvedValue(completedRun());
    const b = await boot(true);
    b.context.hasUI = true;
    await spawn(b, "waiting child");
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      Object.defineProperty(b.context, "hasUI", { get: () => { throw new Error("stale UI getter"); } });
      expect(() => b.lifecycle.get("session_compact")()).not.toThrow();
      b.context.isIdle = () => true;
      b.context.signal = undefined;
      await flush();
      // The reconciled bounded idle check uses a timeout, not only immediates.
      // Advance its initial probe deterministically instead of racing the timer phase.
      await vi.advanceTimersByTimeAsync(0);
      expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("updates an existing pending count when compaction starts and ends, without polling", async () => {
    vi.mocked(runAgent).mockResolvedValue(completedRun());
    const b = await boot(true);
    b.context.hasUI = true;
    await spawn(b, "waiting child");
    await flush();
    b.lifecycle.get("session_before_compact")();
    expect(pendingStatuses(b)).toEqual([
      "1 worker result waiting for the main agent",
      "1 worker result waiting for compaction — Esc to cancel",
    ]);
    b.lifecycle.get("session_compact_failed")();
    expect(pendingStatuses(b).at(-1)).toBe("1 worker result waiting for the main agent");
    await flush(); // an active low-level run stops the bounded idle check
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    expect(pendingStatuses(b)).toHaveLength(3);
    turnEnd(b);
    expect(pendingStatuses(b).at(-1)).toBeUndefined();
  });

  it("labels completions arriving during compaction, without promising Escape in RPC mode", async () => {
    vi.mocked(runAgent).mockResolvedValue(completedRun());
    const b = await boot(true);
    b.context.hasUI = true;
    b.context.mode = "rpc";
    b.lifecycle.get("session_before_compact")();
    await spawn(b, "waiting child");
    await flush();
    expect(pendingStatuses(b)).toEqual(["1 worker result waiting for compaction"]);
  });

  it("does not set UI status in a headless parent", async () => {
    vi.mocked(runAgent).mockResolvedValue(completedRun());
    const b = await boot(true);
    await spawn(b, "headless child");
    await flush();
    expect(b.context.ui.setStatus).not.toHaveBeenCalledWith(statusKey, expect.anything());
    turnEnd(b);
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("steers an individual completion immediately when already idle", async () => {
    vi.mocked(runAgent).mockResolvedValue(completedRun());
    const b = await boot(false);
    await spawn(b, "individual child");
    await flush();

    expect(b.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ customType: "subagent-notification", content: expect.stringContaining("individual child") }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  it("delivers all pending completions in one steering message at the real tool boundary", async () => {
    let settleRuns!: () => void;
    const runsSettled = new Promise<void>(resolve => { settleRuns = resolve; });
    vi.mocked(runAgent).mockImplementation(async () => {
      await runsSettled;
      return completedRun();
    });
    const b = await boot(true);
    await Promise.all([spawn(b, "first child"), spawn(b, "second child")]);
    settleRuns();
    await flush();
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    turnEnd(b);

    expect(b.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("2 background tasks finished"),
        details: expect.objectContaining({ description: "first child", others: [expect.objectContaining({ description: "second child" })] }),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  it("snapshots the effective completion model and thinking, not launch requests or later changes", async () => {
    const run = completedRun();
    const initialSession = { ...run.session, model: { provider: "test", id: "initial", name: "Initial Model" }, thinkingLevel: "low" } as typeof run.session;
    const finalSession = { ...run.session, model: { provider: "test", id: "resolved", name: "Resolved Model" }, thinkingLevel: "off" } as typeof run.session;
    vi.mocked(runAgent).mockImplementation(async (_config, _prompt, options) => {
      options.onSessionCreated?.(initialSession);
      return { ...run, session: finalSession };
    });
    const b = await boot(true);
    await b.tools.get("Agent").execute("model-run", {
      prompt: "reply done", description: "model run", thinking: "high", run_in_background: true,
    }, undefined, undefined, b.context);
    await flush();
    // This run has settled, but its notification is still waiting for a safe boundary.
    Reflect.set(finalSession, "thinkingLevel", "high");
    Reflect.set(initialSession.model!, "name", "Later Model");
    turnEnd(b);
    expect(b.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        details: expect.objectContaining({
          invocation: expect.objectContaining({ modelName: "resolved model", modelId: "test/resolved", thinking: "off" }),
        }),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  it("delivers runs settling during startup exactly once at the boundary", async () => {
    vi.mocked(runAgent).mockResolvedValue(completedRun());
    const b = await boot(true);
    await Promise.all([spawn(b, "first instant child"), spawn(b, "second instant child")]);
    await flush();
    turnEnd(b);
    turnEnd(b);
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
  });
});
