// The 10-minute record GC (AgentManager.cleanup) has never run in a test: the
// main agent-manager suite uses real timers throughout, and nothing calls the
// private method. Its two guards are load-bearing in opposite directions —
// inverting the cutoff disposes results the LLM hasn't read yet, and dropping
// the running/queued skip disposes a LIVE agent's session mid-run.
//
// It lives in its own file because vi.useFakeTimers() has to be installed
// BEFORE `new AgentManager()` (the constructor starts the interval), and fake
// timers are hostile to the promise-settling style of the main suite.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type SpawnOptions } from "../../src/workers/agent-manager.js";

vi.mock("../../src/workers/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
  getDefaultMaxTurns: vi.fn(() => 0),
  getRememberAgents: vi.fn(() => true),
}));

vi.mock("../../src/workers/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { resumeAgent, runAgent } from "../../src/workers/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const TEN_MINUTES = 10 * 60_000;
const TICK = 60_000;

describe("AgentManager — record GC", () => {
  let manager: AgentManager;

  beforeEach(() => {
    // Before construction: the cleanup interval is started in the constructor.
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  /** Spawn a background agent and settle it, returning its id and record. */
  async function settled(prompt: string) {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    manager ??= new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, prompt, { description: prompt, isBackground: true });
    await manager.getRecord(id)!.promise;
    return { id, record: manager.getRecord(id)! };
  }

  it("keeps a record that completed inside the retention window", async () => {
    manager = new AgentManager();
    const { id, record } = await settled("recent");
    // Age at sweep time is (TEN_MINUTES - 2*TICK) + TICK — just inside the window.
    // Advancing the timers moves Date.now() too, so the margin has to outlast it.
    record.completedAt = Date.now() - (TEN_MINUTES - 2 * TICK);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeDefined();
  });

  it("evicts a record that completed before the cutoff and disposes its session", async () => {
    manager = new AgentManager();
    const { id, record } = await settled("stale");
    const dispose = vi.fn();
    record.session = { dispose } as any;
    record.completedAt = Date.now() - (TEN_MINUTES + 30_000);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeUndefined();
    expect(manager.listAgents().map(a => a.id)).not.toContain(id);
    expect(dispose).toHaveBeenCalled();
  });

  it("closes the evicted session's extension lifecycle before disposing it (#242)", async () => {
    // The reported crash, on its own path: this sweep is what fires ~10 min after a
    // subagent finishes. Disposing only invalidates the ExtensionRunner, so whatever
    // an extension armed in `session_start` stayed armed — and its next tick threw
    // `assertActive()` from a bare timer callback, killing interactive pi.
    manager = new AgentManager();
    const { id, record } = await settled("stale");
    const emit = vi.fn(async () => {});
    const dispose = vi.fn();
    record.session = {
      dispose,
      extensionRunner: { hasHandlers: (event: string) => event === "session_shutdown", emit },
    } as any;
    record.completedAt = Date.now() - (TEN_MINUTES + 30_000);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeUndefined();
    expect(emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    // After dispose() the runner is invalidated and every ctx getter throws, so an
    // emit that landed afterwards would be worse than none.
    expect(emit.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]);
  });

  it("never evicts a running agent, however old its timestamp looks", async () => {
    // A live agent's session being disposed mid-run is the worst failure this
    // guard prevents, and `completedAt` on a running record is meaningless.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "live", { description: "live", isBackground: true });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    record.completedAt = Date.now() - 10 * TEN_MINUTES;
    const dispose = vi.fn();
    record.session = { dispose } as any;

    await vi.advanceTimersByTimeAsync(TICK * 5);

    expect(manager.getRecord(id)).toBeDefined();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("never evicts a queued agent", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager(undefined, 1);
    manager.spawn(mockPi, mockCtx, "holder", { description: "holder", isBackground: true });
    const queuedId = manager.spawn(mockPi, mockCtx, "waiter", { description: "waiter", isBackground: true });
    const queued = manager.getRecord(queuedId)!;
    expect(queued.status).toBe("queued");
    queued.completedAt = Date.now() - 10 * TEN_MINUTES;

    await vi.advanceTimersByTimeAsync(TICK * 5);

    expect(manager.getRecord(queuedId)?.status).toBe("queued");
  });

  it("sweeps repeatedly, not just once", async () => {
    // The interval must keep firing: a record that ages past the cutoff on a
    // later tick has to be collected too.
    manager = new AgentManager();
    const { id, record } = await settled("ages-out");
    record.completedAt = Date.now() - (TEN_MINUTES - 3 * TICK);

    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.getRecord(id)).toBeDefined(); // still inside the window

    await vi.advanceTimersByTimeAsync(TICK * 4);
    expect(manager.getRecord(id)).toBeUndefined(); // aged out on a later tick
  });
});

// Retain only bounded, in-session metadata needed to reopen a persisted worker.
// Descriptions are labels, not lookup keys; archived records remain ID-addressed.
describe("AgentManager — ID-based resume after eviction", () => {
  let manager: AgentManager;
  let sessionDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionDir = mkdtempSync(join(tmpdir(), "manager-resume-"));
  });
  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  async function evictable(description: string, persist = true) {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    manager ??= new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "original task", {
      description,
      isBackground: true,
      config: { extensions: false, skills: false, instructions: "Keep this configuration", maxTurns: 7 },
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    if (persist) {
      record.sessionFile = join(sessionDir, `${id}.jsonl`);
      writeFileSync(record.sessionFile, "");
    }
    record.completedAt = Date.now() - (TEN_MINUTES + 30_000);
    return { id, record };
  }

  it("retains persisted metadata by ID after disposing the live record", async () => {
    manager = new AgentManager();
    const { id, record } = await evictable("audit the RPC path");
    const dispose = vi.fn();
    record.session = { dispose } as any;
    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.getResumableRecord(id)).toMatchObject({
      id,
      description: "audit the RPC path",
      sessionFile: record.sessionFile,
      config: record.config,
    });
    expect(manager.getResumableRecord(id)?.session).toBeUndefined();
    expect(manager.getResumableRecord(id)?.promise).toBeUndefined();
  });

  it("retains nothing for an in-memory worker", async () => {
    manager = new AgentManager();
    const { id } = await evictable("ephemeral", false);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.getRecord(id)).toBeUndefined();
    expect(manager.getResumableRecord(id)).toBeUndefined();
    expect(await manager.resume(id, "more")).toBeUndefined();
  });

  it("keeps archived IDs distinct when descriptions repeat", async () => {
    manager = new AgentManager();
    const first = await evictable("same goal");
    await vi.advanceTimersByTimeAsync(TICK);
    const second = await evictable("same goal");
    expect(second.id).not.toBe(first.id);
    expect(manager.getResumableRecord(first.id)?.id).toBe(first.id);
    expect(manager.getRecord(second.id)?.id).toBe(second.id);
  });

  it("resumes the current record without reopening an archived session", async () => {
    manager = new AgentManager();
    const { id } = await evictable("live record");
    vi.mocked(runAgent).mockClear();
    vi.mocked(resumeAgent).mockResolvedValue({ text: "continued" });
    expect((await manager.resume(id, "more"))?.id).toBe(id);
    expect(resumeAgent).toHaveBeenCalledWith(expect.anything(), "more", expect.anything());
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("drops the oldest metadata once the archive cap is reached", async () => {
    manager = new AgentManager();
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) {
      const { id } = await evictable(`run-${i}`);
      ids.push(id);
      // Archive each in order so map insertion order, not equal timestamps,
      // establishes which metadata is oldest.
      await vi.advanceTimersByTimeAsync(TICK);
    }
    expect(ids.filter(id => manager.getResumableRecord(id))).toHaveLength(100);
    expect(manager.getResumableRecord(ids[0])).toBeUndefined();
    expect(manager.getResumableRecord(ids[100])?.id).toBe(ids[100]);
  });

  it("reopens a persisted session with its stable ID and launch configuration", async () => {
    manager = new AgentManager();
    const { id, record } = await evictable("audit");
    record.lifetimeUsage = { input: 10, output: 5, cacheWrite: 0, cost: 0.01 };
    record.compactionCount = 2;
    await vi.advanceTimersByTimeAsync(TICK);
    const archived = manager.getResumableRecord(id)!;
    const session = { dispose: vi.fn() } as unknown as AgentSession;
    vi.mocked(runAgent).mockClear();
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _prompt, options) => {
      options.onSessionCreated?.(session);
      options.onAssistantUsage?.({ input: 3, output: 2, cacheWrite: 1, cost: 0.02 });
      options.onCompaction?.({ reason: "manual", tokensBefore: 100 });
      return { responseText: "continued", session, aborted: false, steered: false };
    });

    const resumed = await manager.resume(id, "continue");

    expect(resumed).toBe(archived);
    expect(resumed).toMatchObject({
      id, description: "audit", status: "completed", config: record.config,
      lifetimeUsage: { input: 13, output: 7, cacheWrite: 1, cost: 0.03 }, compactionCount: 3,
      session,
    });
    expect(manager.listAgents().map(record => record.id)).toEqual([id]);
    expect(manager.getResumableRecord(id)).toBeUndefined();
    expect(runAgent).toHaveBeenCalledWith(mockCtx, "continue", expect.objectContaining({
      resumeSessionFile: record.sessionFile,
      config: record.config,
    }));
  });

  const launchModel = {
    provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6",
  } as NonNullable<SpawnOptions["model"]>;
  const actualModel = {
    provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6",
  } as NonNullable<SpawnOptions["model"]>;
  const modelCases: { name: string; options: Partial<SpawnOptions>; explicit: boolean }[] = [
    { name: "inherited model object", options: { model: launchModel, modelFromParams: false }, explicit: false },
    { name: "implicit session model", options: {}, explicit: false },
    {
      name: "explicit selector despite a false flag",
      options: { config: { extensions: false, skills: false, model: "anthropic/claude-sonnet-4-6" }, modelFromParams: false },
      explicit: true,
    },
    { name: "model object without a flag", options: { model: launchModel }, explicit: true },
  ];

  it.each(modelCases)("keeps $name provenance and the actual model across eviction and reopening", async ({ options, explicit }) => {
    manager = new AgentManager();
    const sessionFile = join(sessionDir, "worker.jsonl");
    writeFileSync(sessionFile, "");
    vi.mocked(runAgent).mockClear();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _prompt, runOptions) => {
      await Promise.resolve();
      const session = {
        dispose: vi.fn(), model: actualModel,
        sessionManager: { getSessionFile: () => sessionFile },
      } as unknown as AgentSession;
      runOptions.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });
    const id = manager.spawn(mockPi, mockCtx, "original", { description: "worker", ...options });
    const original = manager.getRecord(id)!;
    expect(original.modelFromParams).toBe(explicit);
    await original.promise;
    expect(original.config?.model).toBe(options.config?.model);
    expect(original.invocation?.modelId).toBe("anthropic/claude-sonnet-4-6");
    expect(vi.mocked(runAgent).mock.lastCall![2].modelFromParams).toBe(explicit);

    // Repeat to catch a reopen accidentally promoting inherited state to explicit.
    for (let cycle = 0; cycle < 2; cycle++) {
      const live = manager.getRecord(id)!;
      live.completedAt = Date.now() - (TEN_MINUTES + 30_000);
      await vi.advanceTimersByTimeAsync(TICK);
      expect(manager.getRecord(id)).toBeUndefined();
      const archived = manager.getResumableRecord(id)!;
      expect(archived.modelFromParams).toBe(explicit);
      expect(archived.config?.model).toBe(options.config?.model);
      expect(archived.session).toBeUndefined();
      expect(archived.invocation?.modelId).toBe("anthropic/claude-sonnet-4-6");

      const reopened = await manager.resume(id, "continue");

      expect(reopened).toBe(archived);
      expect(reopened?.status).toBe("completed");
      expect(reopened?.modelFromParams).toBe(explicit);
      expect(reopened?.config?.model).toBe(options.config?.model);
      expect(reopened?.invocation?.modelId).toBe("anthropic/claude-sonnet-4-6");
      expect(manager.getResumableRecord(id)).toBeUndefined();
      const runOptions = vi.mocked(runAgent).mock.lastCall![2];
      // Resume must carry the session's actual model, not the old launch object,
      // without turning that inherited object into an explicit caller selection.
      expect(runOptions.model).toBe(actualModel);
      expect(runOptions.modelFromParams).toBe(explicit);
      expect(runOptions.config?.model).toBe(options.config?.model);
      expect(runOptions.resumeSessionFile).toBe(sessionFile);
    }
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  for (const isBackground of [false, true]) {
    it(`reports a failed archived reopen under the original ID (background: ${isBackground})`, async () => {
      manager = new AgentManager();
      const { id, record } = await evictable("failed reopen");
      record.lifetimeUsage = { input: 10, output: 5, cacheWrite: 0, cost: 0.01 };
      await vi.advanceTimersByTimeAsync(TICK);
      vi.mocked(runAgent).mockRejectedValueOnce(new Error("corrupt persisted session"));

      const reopened = await manager.resume(id, "continue", undefined, { isBackground });
      await reopened?.promise;

      expect(reopened).toBe(manager.getRecord(id));
      expect(reopened).toMatchObject({
        id, status: "error", error: "corrupt persisted session", config: record.config,
        lifetimeUsage: { input: 10, output: 5, cacheWrite: 0, cost: 0.01 },
      });
      expect(reopened?.result).toBeUndefined();
      expect(reopened?.completedAt).toBeGreaterThan(0);
      expect(manager.listAgents().map(record => record.id)).toEqual([id]);
      expect(manager.getResumableRecord(id)).toBeUndefined();
    });
  }

  it("publishes the relabeled goal before an evicted worker starts again", async () => {
    const startedGoals: string[] = [];
    manager = new AgentManager(undefined, 10, record => { startedGoals.push(record.description); });
    const { id } = await evictable("original goal");
    await vi.advanceTimersByTimeAsync(TICK);
    manager.getResumableRecord(id)!.description = "Updated goal";
    startedGoals.length = 0;

    await manager.resume(id, "continue");

    expect(startedGoals).toEqual(["Updated goal"]);
    expect(manager.getRecord(id)?.description).toBe("Updated goal");
  });

  it("refuses to reopen a session file that has disappeared", async () => {
    manager = new AgentManager();
    const { id, record } = await evictable("missing file");
    await vi.advanceTimersByTimeAsync(TICK);
    rmSync(record.sessionFile!);
    vi.mocked(runAgent).mockClear();
    expect(await manager.resume(id, "continue")).toBeUndefined();
    expect(runAgent).not.toHaveBeenCalled();
    expect(manager.getRecord(id)).toBeUndefined();
    expect(manager.getResumableRecord(id)?.sessionFile).toBe(record.sessionFile);
  });

  it("does not carry archived IDs into another manager instance", async () => {
    manager = new AgentManager();
    const { id } = await evictable("prior manager");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.getResumableRecord(id)).toBeDefined();
    await manager.dispose();
    manager = new AgentManager();
    expect(manager.getResumableRecord(id)).toBeUndefined();
    expect(await manager.resume(id, "continue")).toBeUndefined();
  });

  it("forgets archived IDs at the parent session boundary", async () => {
    manager = new AgentManager();
    const { id } = await evictable("prior session");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.getResumableRecord(id)).toBeDefined();
    manager.clearCompleted(true);
    expect(manager.getResumableRecord(id)).toBeUndefined();
    expect(await manager.resume(id, "continue")).toBeUndefined();
  });
});
