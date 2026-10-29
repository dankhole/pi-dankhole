/**
 * When completion notifications reach the parent, through the real extension:
 * held while the parent runs and sent at its turn's end, as in Claude Code, and
 * without sibling joins or delayed idle batching.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionContext, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../../src/workers/agent-manager.js";
import type * as AgentRunnerModule from "../../src/workers/agent-runner.js";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../../src/workers/agent-runner.js";
import subagentsExtension from "../../src/workers/index.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

let booted: BootedPi | undefined;
let hermetic: Hermetic | undefined;

afterEach(async () => {
  await booted?.lifecycle.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  vi.useRealTimers();
});

/** Boot the extension with a parent whose run state the test controls. */
async function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
  booted = makePi();
  subagentsExtension(booted.pi);
  const parent = { running: true };
  const signal = new AbortController().signal;
  const parentCtx = ctx({ isIdle: () => !parent.running });
  Object.defineProperty(parentCtx, "signal", { get: () => (parent.running ? signal : undefined) });
  await booted.lifecycle.get("session_start")({ type: "session_start" }, parentCtx);
  return { ...booted, parent, parentCtx };
}

/** Runs that settle only when `settle(description)` is called. */
function controllableRuns(sessionFile?: string) {
  const finishers = new Map<string, () => void>();
  vi.mocked(runAgent).mockImplementation((_c, prompt, options) => {
    const session = {
      dispose: vi.fn(), messages: [],
      sessionManager: { getSessionFile: () => sessionFile },
    } as unknown as AgentSession;
    // Archived reopen uses runAgent again, with a new session instance, rather
    // than resumeAgent's live-session path. Capture persistence the same way.
    if (sessionFile) options.onSessionCreated?.(session);
    return new Promise(resolve => {
      finishers.set(prompt, () => resolve({
        responseText: `${prompt} done`, session, aborted: false, steered: false,
      }));
    });
  });
  vi.mocked(resumeAgent).mockImplementation((_s: any, prompt: string) =>
    new Promise(resolve => { finishers.set(prompt, () => resolve({ text: `${prompt} done` })); }),
  );
  return { settle: (prompt: string) => finishers.get(prompt)!() };
}

const spawn = (b: BootedPi, parentCtx: any, prompt: string, extra: Record<string, unknown> = {}) =>
  b.tools.get("Agent").execute(
    `call-${prompt}`,
    { prompt, description: prompt, run_in_background: true, ...extra },
    undefined, undefined, parentCtx,
  );

const agentIdOf = (result: any): string => /Agent ID: (\S+)/.exec(result.content[0].text)![1];

const turnEnd = (b: BootedPi, stopReason = "toolUse") =>
  b.lifecycle.get("turn_end")?.({ type: "turn_end", message: { role: "assistant", stopReason } });

const sentContents = (b: BootedPi): string[] => b.pi.sendMessage.mock.calls.map((c: any[]) => c[0].content);

describe("completion delivery to a running parent", () => {
  it("holds a completion until the parent's turn ends, then steers it in", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");

    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    turnEnd(b);
    expect(b.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: expect.stringContaining("alpha done") }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  it("sends a completion that landed after the run's last turn once the run ends", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    turnEnd(b, "stop"); // the run's final turn: nothing pending yet

    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    b.lifecycle.get("agent_end")?.({ type: "agent_end", messages: [] });
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    b.parent.running = false;
    b.lifecycle.get("agent_settled")?.({ type: "agent_settled", aborted: false });

    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);
  });

  it("sends a completion that landed while the ending run was still open, once the run settles", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    turnEnd(b, "stop");
    b.lifecycle.get("agent_end")?.({ type: "agent_end", messages: [] });

    runs.settle("alpha"); // lands while a later agent_end listener still holds the run open
    await vi.advanceTimersByTimeAsync(0);
    b.parent.running = false;
    b.lifecycle.get("agent_settled")?.({ type: "agent_settled", aborted: false });
    await vi.advanceTimersByTimeAsync(200);

    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);
  });

  it("drops what is still pending when the session shuts down", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    await b.lifecycle.get("session_shutdown")();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("delivers an aborted turn's completion once the run ends, starting a turn, as Claude Code does after Esc", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    turnEnd(b, "aborted");
    // Sent now, it would land in the queue pi clears on Esc.
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    b.parent.running = false;
    b.lifecycle.get("agent_settled")?.({ type: "agent_settled", aborted: true });
    expect(b.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: expect.stringContaining("alpha done") }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });
  it("retains a completion through the real host's retry signal gap and Esc queue cleanup", async () => {
    const runs = controllableRuns();
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" }),
      fauxAssistantMessage("Completion received after abort"),
    ]);
    let parentCtx: ExtensionContext | undefined;
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 },
    });
    const loader = new DefaultResourceLoader({
      cwd: hermetic.dir,
      agentDir: getAgentDir(),
      settingsManager,
      extensionFactories: [subagentsExtension, pi => {
        pi.on("session_start", (_event, context) => { parentCtx = context; });
      }],
      noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      ...fauxModelBackend(faux.getModel()),
      cwd: hermetic.dir,
      model: faux.getModel(),
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(hermetic.dir),
    });
    try {
      await session.bindExtensions({});
      const send = vi.spyOn(session, "sendCustomMessage");
      await session.getToolDefinition("Agent")!.execute(
        "call-alpha", { prompt: "alpha", description: "alpha", run_in_background: true },
        undefined, undefined, session.extensionRunner.createToolContext("call-alpha", undefined),
      );
      const retryStarted = new Promise<void>(resolve => {
        session.subscribe(event => { if (event.type === "auto_retry_start") resolve(); });
      });
      const prompt = session.prompt("Start a retryable request");
      await retryStarted;
      // isIdle is the session-level contract; signal covers only a low-level
      // attempt. This is a real retry backoff, not a hand-written context mock.
      expect(parentCtx!.signal).toBeUndefined();
      expect(parentCtx!.isIdle()).toBe(false);
      expect(session.isRetrying).toBe(true);
      runs.settle("alpha");
      await new Promise<void>(resolve => setImmediate(resolve));
      const sentDuringRetry = send.mock.calls.length;

      session.clearQueue(); // Esc discards Pi's queued steering before aborting.
      await session.abort();
      await prompt;
      await session.waitForIdle();
      // Pi 1.4 defers a triggerTurn send from agent_settled and re-enters
      // sendCustomMessage to start the deferred run. Count delivered messages,
      // not internal method entries: the notification must still arrive once.
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("alpha done") }),
        { deliverAs: "steer", triggerTurn: true },
      );
      expect(session.messages.filter(message => message.role === "custom" && message.customType === "subagent-notification"))
        .toHaveLength(1);
      expect(sentDuringRetry).toBe(0);
      expect(session.getLastAssistantText()).toBe("Completion received after abort");
      expect(faux.state.callCount).toBe(2);
    } finally {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      faux.unregister();
    }
  });

  it("drops a completion whose result another extension consumed over RPC before the boundary", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    const [, consume] = b.pi.events.on.mock.calls.find(([channel]: any[]) => channel === "subagents:rpc:consume");
    await consume({ requestId: "r1", agentId: id });
    turnEnd(b);

    expect(b.pi.events.emit).toHaveBeenCalledWith("subagents:rpc:consume:reply:r1", expect.objectContaining({ success: true }));
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("a completion pending while its agent is resumed", () => {
  const resume = (b: BootedPi, parentCtx: any, id: string, prompt: string, background: boolean) =>
    b.tools.get("Agent").execute(
      `call-${prompt}`,
      { prompt, description: prompt, resume: id, run_in_background: background },
      undefined, undefined, parentCtx,
    );

  it("still reports the first run when a background resume starts before the boundary", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    await resume(b, b.parentCtx, id, "again", true);
    turnEnd(b);
    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);

    runs.settle("again");
    await vi.advanceTimersByTimeAsync(0);
    turnEnd(b);
    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done"), expect.stringContaining("again done")]);
  });

  it("batches both run snapshots when a background resume also finishes before the boundary", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    await resume(b, b.parentCtx, id, "again", true);
    runs.settle("again");
    await vi.advanceTimersByTimeAsync(0);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    turnEnd(b);
    expect(b.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: expect.stringMatching(/alpha done[\s\S]*again done/),
        details: expect.objectContaining({
          id, description: "alpha", resultPreview: "alpha done",
          others: [expect.objectContaining({ id, description: "again", resultPreview: "again done" })],
        }),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );
    const [content] = sentContents(b);
    expect(content).toContain("<tool-use-id>call-alpha</tool-use-id>");
    expect(content).toContain("<tool-use-id>call-again</tool-use-id>");
    turnEnd(b);
    b.parent.running = false;
    b.lifecycle.get("agent_settled")?.({ aborted: false });
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("still reports the first run, not the inline result, when a foreground resume runs before the boundary", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    const inline = resume(b, b.parentCtx, id, "again", false);
    await vi.advanceTimersByTimeAsync(0);
    runs.settle("again");
    await inline;
    turnEnd(b);

    const sent = sentContents(b);
    expect(sent).toEqual([expect.stringContaining("alpha done")]);
    expect(sent[0]).not.toContain("again done");
  });

  it("does not report a run whose result was read before a background resume", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    await b.tools.get("get_subagent_result").execute("read", { agent_id: id }, undefined, undefined, b.parentCtx);
    await resume(b, b.parentCtx, id, "again", true);
    turnEnd(b);

    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    runs.settle("again");
    await vi.advanceTimersByTimeAsync(0);
    turnEnd(b);
    expect(sentContents(b)).toEqual([expect.stringContaining("again done")]);
    expect(sentContents(b)[0]).not.toContain("alpha done");
  });

  it.each(["tool", "RPC"])("cancels pending same-ID runs consumed through %s", async consumer => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    await resume(b, b.parentCtx, id, "again", true);
    runs.settle("again");
    await vi.advanceTimersByTimeAsync(0);

    if (consumer === "tool") {
      await b.tools.get("get_subagent_result").execute("read", { agent_id: id }, undefined, undefined, b.parentCtx);
    } else {
      const [, consume] = b.pi.events.on.mock.calls.find(([channel]: string[]) => channel === "subagents:rpc:consume");
      await consume({ requestId: "consume-runs", agentId: id });
    }
    turnEnd(b);
    b.parent.running = false;
    b.lifecycle.get("agent_settled")?.({ aborted: false });
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("completion delivery after a consumed worker is archived and reopened", () => {
  async function archivedWorker() {
    const b = await boot();
    const sessionFile = join(hermetic!.dir, "worker.jsonl");
    writeFileSync(sessionFile, "");
    const runs = controllableRuns(sessionFile);
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    const manager = (globalThis as unknown as Record<symbol, Pick<AgentManager, "getRecord">>)[MANAGER_KEY];
    const original = manager.getRecord(id)!;
    const originalSession = original.session!;
    runs.settle("alpha");
    await original.promise;
    const consumed = await b.tools.get("get_subagent_result").execute(
      "read-original", { agent_id: id }, undefined, undefined, b.parentCtx,
    );
    expect(consumed.content[0].text).toContain("alpha done");
    expect(original.resultConsumed).toBe(true);

    // Drive the actual minute cleanup interval past the ten-minute cutoff;
    // neither eviction nor consumption is simulated by changing record fields.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(manager.getRecord(id)).toBeUndefined();
    expect(originalSession.dispose).toHaveBeenCalledOnce();
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    return { b, runs, id, manager, sessionFile, originalSession };
  }

  const reopen = (b: BootedPi, parentCtx: ExtensionContext, id: string, background = true) =>
    b.tools.get("Agent").execute(
      "call-reopened",
      { resume: id, prompt: "again", run_in_background: background },
      undefined, undefined, parentCtx,
    );

  it.each(["running", "idle"])("delivers the reopened run exactly once when the parent is %s", async parentState => {
    vi.useFakeTimers();
    const { b, runs, id, manager, sessionFile, originalSession } = await archivedWorker();
    b.parent.running = parentState === "running";
    const resumed = await reopen(b, b.parentCtx, id);
    expect(agentIdOf(resumed)).toBe(id);
    expect(manager.getRecord(id)).toMatchObject({ id, toolCallId: "call-reopened", status: "running" });
    expect(manager.getRecord(id)?.session).toBeDefined();
    expect(manager.getRecord(id)?.session).not.toBe(originalSession);
    expect(runAgent).toHaveBeenLastCalledWith(b.parentCtx, "again", expect.objectContaining({
      resumeSessionFile: sessionFile, agentId: id,
    }));
    expect(resumeAgent).not.toHaveBeenCalled();

    runs.settle("again");
    await manager.getRecord(id)!.promise; // Idle delivery needs no clock advance.
    if (parentState === "running") {
      expect(b.pi.sendMessage).not.toHaveBeenCalled();
      turnEnd(b);
    }
    expect(b.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: expect.stringContaining("again done"),
        details: expect.objectContaining({ id, resultPreview: "again done" }),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );
    expect(sentContents(b)[0]).toContain("<tool-use-id>call-reopened</tool-use-id>");
    expect(sentContents(b)[0]).not.toContain("<tool-use-id>call-alpha</tool-use-id>");
    expect(sentContents(b)[0]).not.toContain("alpha done");

    turnEnd(b);
    b.parent.running = false;
    b.lifecycle.get("agent_settled")?.({ aborted: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it.each(["tool", "RPC"])("suppresses a reopened result consumed through %s before the boundary", async consumer => {
    vi.useFakeTimers();
    const { b, runs, id, manager } = await archivedWorker();
    expect(agentIdOf(await reopen(b, b.parentCtx, id))).toBe(id);
    runs.settle("again");
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)).toMatchObject({ result: "again done", resultConsumed: false });
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    if (consumer === "tool") {
      const result = await b.tools.get("get_subagent_result").execute(
        "read-reopened", { agent_id: id }, undefined, undefined, b.parentCtx,
      );
      expect(result.content[0].text).toContain("again done");
    } else {
      const [, consume] = b.pi.events.on.mock.calls.find(([channel]: string[]) => channel === "subagents:rpc:consume");
      await consume({ requestId: "consume-reopened", agentId: id });
      expect(b.pi.events.emit).toHaveBeenCalledWith(
        "subagents:rpc:consume:reply:consume-reopened", expect.objectContaining({ success: true }),
      );
    }
    turnEnd(b);
    b.parent.running = false;
    b.lifecycle.get("agent_settled")?.({ aborted: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("returns a foreground archived reopen inline without a completion notification", async () => {
    vi.useFakeTimers();
    const { b, runs, id, manager, sessionFile } = await archivedWorker();
    const inline = reopen(b, b.parentCtx, id, false);
    await vi.advanceTimersByTimeAsync(0);
    runs.settle("again");
    const result = await inline;
    expect(result.content[0].text).toBe("again done");
    expect(manager.getRecord(id)).toMatchObject({ id, status: "completed", isBackground: false });
    expect(runAgent).toHaveBeenLastCalledWith(b.parentCtx, "again", expect.objectContaining({
      resumeSessionFile: sessionFile, agentId: id,
    }));
    expect(resumeAgent).not.toHaveBeenCalled();
    turnEnd(b);
    b.parent.running = false;
    b.lifecycle.get("agent_settled")?.({ aborted: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("unconditional safe-boundary delivery", () => {
  it("does not wait for a still-running sibling", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    await Promise.all([spawn(b, b.parentCtx, "first"), spawn(b, b.parentCtx, "sibling")]);
    runs.settle("first");
    await vi.advanceTimersByTimeAsync(0);
    turnEnd(b);

    expect(sentContents(b)).toEqual([expect.stringContaining("first done")]);
    expect(sentContents(b)[0]).not.toContain("sibling done");
  });

  it("delivers an idle parent's completion without waiting for a timer", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    b.parent.running = false;
    await spawn(b, b.parentCtx, "idle");
    runs.settle("idle");
    await vi.advanceTimersByTimeAsync(0);

    expect(sentContents(b)).toEqual([expect.stringContaining("idle done")]);
  });
});
