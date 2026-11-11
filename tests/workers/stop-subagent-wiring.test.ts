import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/workers/agent-runner.js")>("../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../../src/workers/agent-runner.js";
import { COMPLETION_JOURNAL_TYPE } from "../../src/workers/completion-journal.js";
import subagentsExtension from "../../src/workers/index.js";
import type { AgentRecord } from "../../src/workers/types.js";
import { ctx, flush, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const KEY = Symbol.for("pi-subagents:manager");
const priorManager = Reflect.get(globalThis, KEY);

describe("parent stop_subagent wiring", () => {
  let environment: ReturnType<typeof hermeticDir>;
  let booted: ReturnType<typeof makePi>;
  let context: ReturnType<typeof ctx>;
  let sessionManager: SessionManager;
  let runs: Map<string, { signal: AbortSignal; finish: (text?: string) => void; session: AgentSession }>;

  beforeEach(async () => {
    environment = hermeticDir({ settings: { maxConcurrent: 1, outputTranscript: false, rememberAgents: false, reportUsage: true } });
    Reflect.deleteProperty(globalThis, KEY);
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
    booted = makePi();
    sessionManager = SessionManager.inMemory(environment.dir);
    booted.pi.appendEntry.mockImplementation((type: string, data: unknown) => sessionManager.appendCustomEntry(type, data));
    subagentsExtension(booted.pi);
    context = ctx({ sessionManager, isIdle: () => false, hasPendingMessages: () => false });
    await booted.lifecycle.get("session_start")({}, context);
    runs = new Map();
    vi.mocked(runAgent).mockImplementation((_ctx, prompt, options) => new Promise(resolve => {
      const session = { dispose: vi.fn(), messages: [], subscribe: vi.fn(() => () => {}) } as unknown as AgentSession;
      options.onSessionCreated?.(session);
      runs.set(prompt, {
        signal: options.signal!, session,
        finish: (text = "partial work") => resolve({ responseText: text, session, aborted: false, steered: false }),
      });
    }));
  });

  afterEach(async () => {
    for (const run of runs.values()) run.finish();
    await flush();
    await booted.lifecycle.get("session_shutdown")();
    if (priorManager === undefined) Reflect.deleteProperty(globalThis, KEY);
    else Reflect.set(globalThis, KEY, priorManager);
    environment.restore();
  });

  async function spawn(prompt: string) {
    const result = await booted.tools.get("Agent").execute("launch", { prompt, description: prompt, run_in_background: true }, undefined, undefined, context);
    return /Agent ID: (\S+)/.exec(textOf(result))![1];
  }
  function record(id: string): AgentRecord { return Reflect.get(globalThis, KEY).getRecord(id); }
  function stop(id: string) { return booted.tools.get("stop_subagent").execute("stop", { agent_id: id }, undefined, undefined, context); }
  function read(id: string) { return booted.tools.get("get_subagent_result").execute("read", { agent_id: id }, undefined, undefined, context); }
  function boundary() { booted.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "toolUse" } }); }

  it("registers a direct, narrowly parameterized parent tool", () => {
    const tool = booted.tools.get("stop_subagent");
    expect(tool.exposure ?? "direct").toBe("direct");
    expect(tool.parameters.required).toEqual(["agent_id"]);
    expect(Object.keys(tool.parameters.properties)).toEqual(["agent_id"]);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.description).toContain("not when execution settles");
  });

  it("returns promptly for a cancellation-ignoring provider without freeing its slot or claiming settlement", async () => {
    const id = await spawn("stuck provider");
    await flush();
    const run = runs.get("stuck provider")!;
    expect(run.signal.aborted).toBe(false);
    const result = await stop(id); // The run promise deliberately remains unresolved.
    expect(run.signal.aborted).toBe(true);
    expect(textOf(result)).toContain("Stop requested");
    expect(textOf(result)).toContain("not proof of settlement");
    expect(record(id).status).toBe("stopped");
    expect(record(id).resultConsumed).not.toBe(true);
    expect(booted.pi.events.emit.mock.calls.filter(([event]) => event === "subagents:failed")).toEqual([]);

    const queued = await spawn("waiting sibling");
    expect(record(queued).status).toBe("queued");
    expect(runs.has("waiting sibling")).toBe(false);
    run.finish();
    await record(id).promise;
    await flush();
    expect(runs.has("waiting sibling")).toBe(true);
    expect(record(id).status).toBe("stopped");
  });

  it("stops a worker before session creation and keeps that signal aborted for startup", async () => {
    let signal: AbortSignal | undefined;
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation((_ctx, _prompt, options) => new Promise(resolve => {
      signal = options.signal;
      finish = () => resolve({ responseText: "", session: { dispose: vi.fn() } as unknown as AgentSession, aborted: false, steered: false });
    }));
    const id = await spawn("starting worker");
    expect(record(id).session).toBeUndefined();
    await stop(id);
    expect(signal?.aborted).toBe(true);
    finish();
    await record(id).promise;
    expect(record(id).status).toBe("stopped");
  });

  it("removes queued work without starting it, preserving the existing queued-stop lifecycle", async () => {
    const active = await spawn("active");
    const queued = await spawn("queued");
    expect(record(queued).status).toBe("queued");
    const result = await stop(queued);
    expect(textOf(result)).toContain("removed from the queue");
    expect(textOf(result)).not.toContain("abort signal was sent");
    expect(record(queued)).toMatchObject({ status: "stopped", completedAt: expect.any(Number) });
    expect(record(queued).promise).toBeUndefined();
    expect(record(queued).resultConsumed).not.toBe(true);
    runs.get("active")!.finish();
    await record(active).promise;
    await flush();
    expect(runs.has("queued")).toBe(false);
    expect(booted.pi.events.emit).not.toHaveBeenCalledWith("subagents:failed", expect.objectContaining({ id: queued }));
    expect(textOf(await read(queued))).toContain("the task was NOT finished");
  });

  it("captures partial results and lifecycle only on settlement; retrieval suppresses the pending notification", async () => {
    const id = await spawn("partial");
    await stop(id);
    expect(sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === COMPLETION_JOURNAL_TYPE)).toHaveLength(0);
    runs.get("partial")!.finish("verified partial answer");
    await record(id).promise;
    expect(booted.pi.events.emit).toHaveBeenCalledWith("subagents:failed", expect.objectContaining({ id, status: "stopped", result: "verified partial answer" }));
    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
    const captured = sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === COMPLETION_JOURNAL_TYPE);
    expect(captured).toHaveLength(1);
    const output = textOf(await read(id));
    expect(output).toContain("verified partial answer");
    expect(output).toContain("STOPPED before completion");
    expect(output).not.toContain("BY THE USER");
    boundary();
    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("leaves an unconsumed stopped result eligible for normal safe-boundary delivery", async () => {
    const id = await spawn("notify");
    await stop(id);
    runs.get("notify")!.finish();
    await record(id).promise;
    boundary();
    expect(booted.pi.sendMessage).toHaveBeenCalledOnce();
    expect(booted.pi.sendMessage.mock.calls[0][0].content).toContain("STOPPED before completion");
  });

  it("reports pending worker usage through the stop result exactly once", async () => {
    const id = await spawn("accounted");
    vi.mocked(runAgent).mock.calls[0][2].onAssistantUsage?.({ input: 100, output: 50, cacheRead: 0, cacheWrite: 10, cost: 0.0123 });
    const result = await stop(id);
    expect(result.usage.cost.total).toBe(0.0123);
    expect((await read(id)).usage).toBeUndefined();
    expect(record(id).lifetimeUsage.cost).toBe(0.0123);
  });

  it("rejects unknown IDs, goal labels and repeated stops as tool errors", async () => {
    await expect(stop("another-parents-worker")).rejects.toThrow("Agent not found");
    const id = await spawn("visible goal");
    await expect(stop("visible goal")).rejects.toThrow("Agent not found");
    await stop(id);
    await expect(stop(id)).rejects.toThrow("not running or queued (status: stopped)");
    expect(record(id).resultConsumed).not.toBe(true);
  });

  it("rejects terminal work without consuming it, and can resume a stopped conversation after settlement", async () => {
    const id = await spawn("resume later");
    await stop(id);
    runs.get("resume later")!.finish();
    await record(id).promise;
    const session = record(id).session;
    vi.mocked(resumeAgent).mockResolvedValue({ text: "continued answer", aborted: false, steered: false });
    await booted.tools.get("Agent").execute("resume", { resume: id, prompt: "continue", run_in_background: true }, undefined, undefined, context);
    await record(id).promise;
    expect(resumeAgent).toHaveBeenCalledWith(session, "continue", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(record(id).status).toBe("completed");
    await expect(stop(id)).rejects.toThrow("not running or queued (status: completed)");
    expect(record(id).resultConsumed).not.toBe(true);
    expect(textOf(await read(id))).toContain("continued answer");
  });
});
