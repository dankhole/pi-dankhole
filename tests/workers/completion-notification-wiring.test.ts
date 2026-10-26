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
