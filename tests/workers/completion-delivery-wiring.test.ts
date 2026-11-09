/**
 * When completion notifications reach the parent, through the real extension:
 * held while the parent runs and sent at its turn's end, as in Claude Code, and
 * without sibling joins or delayed idle batching.
 */
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, type ExtensionContext, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type KeepAwakeBackend, registerKeepAwake } from "../../src/session/keep-awake.js";
import type { AgentManager } from "../../src/workers/agent-manager.js";
import type * as AgentRunnerModule from "../../src/workers/agent-runner.js";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../../src/workers/agent-runner.js";
import { CompletionJournal } from "../../src/workers/completion-journal.js";
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
async function boot(settings: Record<string, unknown> = {}, lowLevelRun = true) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
  booted = makePi();
  const sessionManager = SessionManager.inMemory(hermetic.dir);
  booted.pi.appendEntry.mockImplementation((type: string, data: unknown) => { sessionManager.appendCustomEntry(type, data); });
  // This fixture models a synchronous canonical transcript write, not a void-send acknowledgement.
  booted.pi.sendMessage.mockImplementation((message: Parameters<ExtensionAPI["sendMessage"]>[0]) => {
    sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  });
  subagentsExtension(booted.pi);
  const parent = { running: true, lowLevelRun };
  const signal = new AbortController().signal;
  const parentCtx = ctx({ sessionManager, isIdle: () => !parent.running, hasPendingMessages: () => false });
  Object.defineProperty(parentCtx, "signal", { get: () => (parent.running && parent.lowLevelRun ? signal : undefined) });
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
  it.each(["before_compact", "later_handler"])("recovers after real host compaction awaits later handlers when the worker settles in %s", async settlement => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 100 }, retry: { enabled: false } });
    const sessionManager = SessionManager.inMemory(hermetic.dir);
    sessionManager.appendMessage({ role: "user", content: "early history ".repeat(2_000), timestamp: Date.now() });
    sessionManager.appendMessage(fauxAssistantMessage("old reply ".repeat(2_000)));
    sessionManager.appendMessage({ role: "user", content: "recent message", timestamp: Date.now() });
    let parentCtx: ExtensionContext | undefined;
    let laterHandlerStage = 0;
    const loader = new DefaultResourceLoader({
      cwd: hermetic.dir, agentDir: getAgentDir(), settingsManager,
      extensionFactories: [pi => {
        // The lifecycle is real; shutdown's unrelated worktree-prune OS boundary
        // is fake so this test never executes Git or creates its timeout.
        vi.spyOn(pi, "exec").mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false });
        subagentsExtension(pi);
      }, pi => {
        pi.on("session_start", (_event, context) => { parentCtx = context; });
        pi.on("session_before_compact", event => {
          if (settlement === "before_compact") runs.settle("late completion");
          return { compaction: { summary: "synthetic checkpoint", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
        });
        // Real ExtensionRunner.emit awaits this after the worker handler.
        pi.on("session_compact", async () => {
          laterHandlerStage = 1;
          await new Promise<void>(resolve => setTimeout(resolve, 25));
          laterHandlerStage = 2;
          if (settlement === "later_handler") runs.settle("late completion");
          await new Promise<void>(resolve => setTimeout(resolve, 25));
          laterHandlerStage = 3;
        });
      }],
      noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      ...fauxModelBackend(faux.getModel()), cwd: hermetic.dir, model: faux.getModel(),
      resourceLoader: loader, settingsManager, sessionManager,
    });
    try {
      await session.bindExtensions({});
      const busyAtSend: boolean[] = [];
      // Capture delivery without starting a synthetic follow-up model turn.
      const send = vi.spyOn(session, "sendCustomMessage").mockImplementation(() => { busyAtSend.push(!parentCtx!.isIdle()); });
      await session.getToolDefinition("Agent")!.execute(
        "call-late", { prompt: "late completion", description: "late completion", run_in_background: true },
        undefined, undefined, session.extensionRunner.createToolContext("call-late", undefined),
      );
      const compaction = session.compact();
      await vi.advanceTimersByTimeAsync(0);
      expect(laterHandlerStage).toBe(1);
      expect(parentCtx!.isIdle()).toBe(false);
      expect(send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(25);
      expect(laterHandlerStage).toBe(2);
      expect(parentCtx!.isIdle()).toBe(false);
      expect(send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(25);
      await compaction;
      expect(parentCtx!.isIdle()).toBe(true);
      expect(send).not.toHaveBeenCalled(); // Even the late arrival was observed while still busy.
      await vi.advanceTimersByTimeAsync(500);
      expect(send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ content: expect.stringContaining("late completion done") }),
        { deliverAs: "steer", triggerTurn: true },
      );
      expect(busyAtSend).toEqual([false]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(send).toHaveBeenCalledOnce();
      expect(faux.state.callCount).toBe(0);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      faux.unregister();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the post-summary window when consumption empties the outbox", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const alpha = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    await spawn(b, b.parentCtx, "beta");
    b.parent.running = false;
    b.parentCtx.isIdle = () => false; // a later summary handler is awaiting I/O
    const timersBefore = vi.getTimerCount();
    b.lifecycle.get("session_compact")();
    expect(vi.getTimerCount()).toBe(timersBefore); // an empty window owns no timer
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(5);
    await b.tools.get("get_subagent_result").execute("read", { agent_id: alpha }, undefined, undefined, b.parentCtx);
    expect(vi.getTimerCount()).toBe(timersBefore);
    // Queue beta while still busy, then let its scheduled check observe cleanup.
    b.parentCtx.isIdle = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    runs.settle("beta");
    await vi.advanceTimersByTimeAsync(5);
    expect(sentContents(b)).toEqual([expect.stringContaining("beta done")]);
  });

  it("rearms after an empty drain only within the original compaction deadline", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({}, false);
    const baselineTimers = vi.getTimerCount();
    const first = agentIdOf(await spawn(b, b.parentCtx, "first arrival"));
    runs.settle("first arrival");
    await vi.advanceTimersByTimeAsync(0);
    b.lifecycle.get("session_compact")({ reason: "manual", willRetry: false }, b.parentCtx);
    await vi.advanceTimersByTimeAsync(0);
    await b.tools.get("get_subagent_result").execute("consume", { agent_id: first }, undefined, undefined, b.parentCtx);
    expect(vi.getTimerCount()).toBe(baselineTimers); // Empty queue cancels all observation ticking.
    await vi.advanceTimersByTimeAsync(29_000);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    await spawn(b, b.parentCtx, "second arrival");
    runs.settle("second arrival");
    await vi.advanceTimersByTimeAsync(750);
    expect(timeout.mock.calls.some(call => call[1] === 500)).toBe(true); // Same window was rearmed.
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250); // Original deadline, not 30s after the new arrival.
    expect(vi.getTimerCount()).toBe(baselineTimers + 1); // Only the pending diagnostic watchdog remains.
    b.parent.running = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    turnEnd(b);
    expect(sentContents(b)).toEqual([expect.stringContaining("second arrival done")]);
    expect(vi.getTimerCount()).toBe(baselineTimers);
    timeout.mockRestore();
  });

  it("does not rearm for a first arrival after an empty compaction window has expired", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({}, false);
    const baselineTimers = vi.getTimerCount();
    b.lifecycle.get("session_compact")({ reason: "manual", willRetry: false }, b.parentCtx);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(baselineTimers);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    await spawn(b, b.parentCtx, "expired arrival");
    const isIdle = vi.spyOn(b.parentCtx, "isIdle");
    runs.settle("expired arrival");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(timeout.mock.calls.filter(call => call[1] === 500)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(baselineTimers + 1);
    b.parent.running = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(isIdle).toHaveBeenCalledOnce(); // Enqueue only: arrival cannot open a new window.
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    turnEnd(b);
    expect(sentContents(b)).toEqual([expect.stringContaining("expired arrival done")]);
    expect(vi.getTimerCount()).toBe(baselineTimers);
    isIdle.mockRestore();
    timeout.mockRestore();
  });

  it("bounds busy compaction observation to 30 seconds and retains the completion/diagnostics on expiry", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({}, false);
    b.parentCtx.hasUI = true;
    const baselineTimers = vi.getTimerCount();
    await spawn(b, b.parentCtx, "budget");
    runs.settle("budget");
    await vi.advanceTimersByTimeAsync(0);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    b.lifecycle.get("session_compact")({ reason: "manual", willRetry: false }, b.parentCtx);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(timeout.mock.calls.filter(call => call[1] === 500)).toHaveLength(60);
    expect(vi.getTimerCount()).toBe(baselineTimers);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    expect(b.parentCtx.ui.notify).toHaveBeenCalledExactlyOnceWith(
      "1 worker result still waiting for delivery. Check /agents diagnostics or /agents recover.", "warning",
    );
    expect(b.parentCtx.ui.setStatus).toHaveBeenCalledWith("subagents:pending-completions", expect.stringContaining("1 worker result waiting"));
    await b.commands.get("agents").handler("diagnostics", b.parentCtx);
    expect(b.parentCtx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Completions pending: 1"), "info");
    expect(b.parentCtx.ui.notify.mock.calls.at(-1)[0]).toContain("idle observation=expired");
    expect(b.parentCtx.ui.notify.mock.calls.at(-1)[0]).toContain("Host-internal busy cause unknown");
    b.parent.running = false;
    const expired = timeout.mock.calls.filter(call => call[1] === 500).at(-1)![0] as () => void;
    expired(); // Even an already-dequeued retry cannot act after budget expiry.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled(); // No observation after the finite window.
    turnEnd(b, "stop");
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    timeout.mockRestore();
  });

  it.each(["consume", "deliver"])("cancels compaction retries when the outbox drains via %s, including an already-dequeued callback", async action => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({}, false);
    const baselineTimers = vi.getTimerCount();
    const id = agentIdOf(await spawn(b, b.parentCtx, "cancel retry"));
    runs.settle("cancel retry");
    await vi.advanceTimersByTimeAsync(0);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    b.lifecycle.get("session_compact")({ reason: "manual", willRetry: false }, b.parentCtx);
    await vi.advanceTimersByTimeAsync(0);
    const stale = timeout.mock.calls.at(-1)![0] as () => void;
    expect(timeout.mock.calls.at(-1)![1]).toBe(500);
    expect(timeout.mock.results.at(-1)!.value.hasRef()).toBe(false);
    if (action === "consume") {
      await b.tools.get("get_subagent_result").execute("consume", { agent_id: id }, undefined, undefined, b.parentCtx);
    } else {
      turnEnd(b);
    }
    expect(vi.getTimerCount()).toBe(baselineTimers);
    b.parent.running = false;
    stale();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.pi.sendMessage).toHaveBeenCalledTimes(action === "consume" ? 0 : 1);
    expect(vi.getTimerCount()).toBe(baselineTimers);
    timeout.mockRestore();
  });

  it("does not retry compaction observation when there are no pending completions", async () => {
    vi.useFakeTimers();
    const b = await boot({}, false);
    const baselineTimers = vi.getTimerCount();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    b.lifecycle.get("session_compact")({ reason: "manual", willRetry: false }, b.parentCtx);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(timeout.mock.calls.filter(call => call[1] === 500)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(baselineTimers);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    timeout.mockRestore();
  });

  it.each(["session_compact", "session_compact_failed"])("recovers manual %s completion delivery only after public idle in the next macrotask", async event => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({}, false);
    await spawn(b, b.parentCtx, "manual compact");
    runs.settle("manual compact");
    await vi.advanceTimersByTimeAsync(0);
    b.lifecycle.get(event)({ type: event, reason: "manual", willRetry: false }, b.parentCtx);
    expect(b.pi.sendMessage).not.toHaveBeenCalled(); // Handler still sees compaction busy.
    b.parent.running = false; // Host compaction finalizer runs after the event returns.
    await vi.advanceTimersByTimeAsync(0);
    expect(sentContents(b)).toEqual([expect.stringContaining("manual compact done")]);
    // No prompt, turn_end, or agent_settled was needed.
  });

  it.each(["session_compact", "session_compact_failed"])("does not deliver from %s while automatic retry/recovery remains publicly busy", async event => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({}, false);
    await spawn(b, b.parentCtx, "retry");
    runs.settle("retry");
    await vi.advanceTimersByTimeAsync(0);
    b.lifecycle.get(event)({ type: event, reason: "overflow", willRetry: true }, b.parentCtx);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    b.parent.running = false;
    b.lifecycle.get("agent_settled")({ aborted: false });
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("invalidates a deferred compaction check on a new session generation even if the context object is reused", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({}, false);
    await spawn(b, b.parentCtx, "pending");
    runs.settle("pending");
    await vi.advanceTimersByTimeAsync(0);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    b.lifecycle.get("session_compact")({ reason: "manual", willRetry: false }, b.parentCtx);
    const stale = timeout.mock.calls.at(-1)![0] as () => void;
    expect(timeout.mock.results.at(-1)!.value.hasRef()).toBe(false);
    b.parent.running = false;
    await b.lifecycle.get("session_start")({}, b.parentCtx);
    stale(); // Simulate an already-dequeued callback as well as normal timer cancellation.
    await vi.advanceTimersByTimeAsync(0);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    timeout.mockRestore();
  });

  it.each(["reload", "quit"])("cancels compaction idle recovery and rejects stale callbacks after %s shutdown/replacement", async reason => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const old = await boot({}, false);
    await spawn(old, old.parentCtx, "old compact");
    runs.settle("old compact");
    await vi.advanceTimersByTimeAsync(0);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    old.lifecycle.get("session_compact_failed")({ reason: "manual", willRetry: false }, old.parentCtx);
    await vi.advanceTimersByTimeAsync(0);
    const stale = timeout.mock.calls.at(-1)![0] as () => void;
    expect(timeout.mock.calls.at(-1)![1]).toBe(500);
    await old.lifecycle.get("session_shutdown")({ reason });
    expect(vi.getTimerCount()).toBe(0);
    old.parent.running = false;
    const replacement = makePi();
    subagentsExtension(replacement.pi);
    booted = replacement;
    await replacement.lifecycle.get("session_start")({}, ctx({ hasPendingMessages: () => false }));
    stale();
    await vi.advanceTimersByTimeAsync(0);
    expect(old.pi.sendMessage).not.toHaveBeenCalled();
    expect(replacement.pi.sendMessage).not.toHaveBeenCalled();
    timeout.mockRestore();
  });

  it("diagnoses the actual extension widget/fleet timers without claiming to measure the host spinner", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const original = vi.mocked(runAgent).getMockImplementation()!;
    vi.mocked(runAgent).mockImplementationOnce((context, prompt, options) => {
      options.onSessionCreated?.({ dispose: vi.fn(), messages: [] } as unknown as AgentSession);
      return original(context, prompt, options);
    });
    const b = await boot();
    b.parentCtx.ui.onTerminalInput = vi.fn(() => vi.fn());
    await b.lifecycle.get("tool_execution_start")({}, b.parentCtx);
    await spawn(b, b.parentCtx, "timer task");
    await b.commands.get("agents").handler("diagnostics", b.parentCtx);
    expect(b.parentCtx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("widget80ms=1, fleet200ms=1, foreground80ms=0"), "info");
    expect(b.parentCtx.ui.notify.mock.lastCall[0]).toContain("Host spinner not measured");
    runs.settle("timer task");
    await vi.advanceTimersByTimeAsync(4_000); // Finished fleet row has now aged out.
    await b.commands.get("agents").handler("diagnostics", b.parentCtx);
    expect(b.parentCtx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("widget80ms=0, fleet200ms=0, foreground80ms=0"), "info");
    expect(b.parentCtx.ui.notify.mock.lastCall[0]).toContain("idle=false");
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps busy wait details in diagnostics without warning, and result consumption clears the watchdog/status", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    b.parentCtx.hasUI = true;
    const baselineTimers = vi.getTimerCount(); // Manager maintenance, not presentation or diagnostics.
    const id = agentIdOf(await spawn(b, b.parentCtx, "private task"));
    runs.settle("private task");
    await vi.advanceTimersByTimeAsync(0);
    turnEnd(b, "error");
    b.lifecycle.get("agent_end")?.({ type: "agent_end", messages: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    expect(b.parentCtx.ui.notify).not.toHaveBeenCalled();
    expect(b.parentCtx.ui.setStatus).toHaveBeenCalledWith("subagents:pending-completions", expect.stringContaining("1 worker result waiting"));

    await b.commands.get("agents").handler("diagnostics", b.parentCtx);
    expect(b.parentCtx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("oldest 30s"), "info");
    const details = b.parentCtx.ui.notify.mock.calls.at(-1)[0];
    expect(details).toContain("Last observed lifecycle: agent_end");
    expect(details).toContain("Public parent idle=false");
    expect(details).not.toContain("private");
    await b.tools.get("get_subagent_result").execute("consume", { agent_id: id }, undefined, undefined, b.parentCtx);
    expect(b.parentCtx.ui.setStatus).toHaveBeenLastCalledWith("subagents:pending-completions", undefined);
    const calls = b.parentCtx.ui.notify.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(b.parentCtx.ui.notify).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(baselineTimers);
    b.lifecycle.get("agent_settled")?.({ aborted: false });
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("removes the old activation's pending watchdog before session replacement", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const old = await boot();
    old.parentCtx.hasUI = true;
    await spawn(old, old.parentCtx, "old task");
    runs.settle("old task");
    await vi.advanceTimersByTimeAsync(0);
    await old.lifecycle.get("session_shutdown")();
    expect(vi.getTimerCount()).toBe(0);
    old.parentCtx.ui.notify.mockClear(); // Ignore the earlier, legitimate unverified-durability notice.

    const replacement = makePi();
    subagentsExtension(replacement.pi);
    booted = replacement;
    const replacementCtx = ctx({ hasPendingMessages: () => false });
    await replacement.lifecycle.get("session_start")({}, replacementCtx);
    const baselineTimers = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(baselineTimers);
    expect(old.parentCtx.ui.notify).not.toHaveBeenCalled();
    expect(replacementCtx.ui.notify).not.toHaveBeenCalled();
    expect(old.pi.sendMessage).not.toHaveBeenCalled();
    expect(replacement.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the real keep-awake owner held through parent recovery and stalled notifications, then releases at settlement", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const bus = new EventEmitter();
    b.pi.events.on.mockImplementation((name: string, handler: (data: unknown) => void) => {
      bus.on(name, handler);
      return () => bus.off(name, handler);
    });
    b.pi.events.emit.mockImplementation((name: string, data: unknown) => bus.emit(name, data));
    const helper = new EventEmitter();
    const kill = vi.fn();
    Object.assign(helper, { kill, unref: vi.fn() });
    const backend: KeepAwakeBackend = {
      platform: "darwin", pid: 123,
      manager: () => (globalThis as Record<symbol, AgentManager>)[MANAGER_KEY],
      spawn: vi.fn(() => helper) as unknown as KeepAwakeBackend["spawn"],
      every(callback) { const timer = setInterval(callback, 500); timer.unref(); return () => clearInterval(timer); },
      onExit: () => () => {},
    };
    const keepLifecycle = new Map<string, (...args: any[]) => void>();
    registerKeepAwake({ ...b.pi, on: (name: string, handler: (...args: any[]) => void) => { keepLifecycle.set(name, handler); return () => {}; } }, true, backend);
    keepLifecycle.get("session_start")!({}, b.parentCtx);
    try {
      await spawn(b, b.parentCtx, "alpha");
      runs.settle("alpha");
      await vi.advanceTimersByTimeAsync(0);
      turnEnd(b, "error");
      b.lifecycle.get("agent_end")?.({ type: "agent_end", messages: [] });
      keepLifecycle.get("agent_end")?.({});
      await vi.advanceTimersByTimeAsync(60_000);
      expect((globalThis as Record<symbol, AgentManager>)[MANAGER_KEY].hasRunning()).toBe(false);
      expect(backend.spawn).toHaveBeenCalledOnce();
      expect(kill).not.toHaveBeenCalled(); // Public parent busy is genuine ownership, not a timeout leak.
      expect(b.pi.sendMessage).not.toHaveBeenCalled();
      b.parent.running = false;
      b.lifecycle.get("agent_settled")?.({ aborted: true });
      keepLifecycle.get("agent_settled")?.({ aborted: true });
      expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(b.pi.sendMessage).not.toHaveBeenCalled(); // Aborted settlement must not restart the parent.

      // The same root manager emits lifecycle ownership for foreground workers,
      // too: parent coverage is not limited to background notifications.
      b.parent.running = true;
      keepLifecycle.get("agent_start")?.({});
      const foreground = spawn(b, b.parentCtx, "foreground", { run_in_background: false });
      await vi.advanceTimersByTimeAsync(0);
      b.parent.running = false;
      keepLifecycle.get("agent_settled")?.({ aborted: false });
      expect(kill).toHaveBeenCalledOnce(); // Known foreground worker still owns work.
      runs.settle("foreground");
      await foreground;
      expect(kill).toHaveBeenCalledTimes(2);
      expect(backend.spawn).toHaveBeenCalledTimes(2);
    } finally {
      keepLifecycle.get("session_shutdown")?.({});
    }
    await b.lifecycle.get("session_shutdown")();
    expect(vi.getTimerCount()).toBe(0);
    expect(bus.eventNames()).toEqual([]);
  });

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

  it("retains an aborted turn's completion until deliberate recovery instead of restarting after Escape", async () => {
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
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    await b.commands.get("agents").handler("recover check", b.parentCtx);
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
      extensionFactories: [pi => {
        // Keep shutdown's unrelated worktree-prune OS boundary hermetic too.
        vi.spyOn(pi, "exec").mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false });
        subagentsExtension(pi);
      }, pi => {
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
      expect(send).not.toHaveBeenCalled(); // Escape is not authorization for another model turn.
      expect(faux.state.callCount).toBe(1);
      await session.prompt("/agents recover check");
      await session.waitForIdle();
      // Deliberate recovery uses the same public-idle check, not a forced boundary.
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

  it.each(["session_compact", "session_compact_failed", "session_tree"])("defers %s until one coalesced idle check", async event => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    const timersBefore = vi.getTimerCount();
    b.lifecycle.get(event)();
    b.lifecycle.get(event)();
    expect(vi.getTimerCount()).toBe(timersBefore + 1);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    b.parent.running = false; // Pi clears summary state after the extension hook returns.
    await vi.advanceTimersByTimeAsync(0);
    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);
    b.lifecycle.get("agent_settled")();
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it.each(["input", "before_agent_start", "agent_start", "session_start", "session_shutdown"])("does not rearm a canceled empty recovery window when a completion arrives after %s", async event => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({}, false);
    const baselineTimers = vi.getTimerCount();
    await spawn(b, b.parentCtx, "prepared input arrival");
    const isIdle = vi.fn(() => !b.parent.running);
    b.parentCtx.isIdle = isIdle;
    b.lifecycle.get("session_tree")(); // Empty queue: retain the window without ticking.
    await b.lifecycle.get(event)({}, ctx({ isIdle, signal: undefined, hasPendingMessages: () => false }));
    runs.settle("prepared input arrival");
    await vi.advanceTimersByTimeAsync(0);
    const shutDown = event === "session_shutdown";
    const replaced = event === "session_start";
    expect(vi.getTimerCount()).toBe(shutDown ? 0 : baselineTimers + (replaced ? 0 : 1)); // No old-session completion enters the replacement.
    b.parent.running = false;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(isIdle.mock.calls.length).toBeLessThanOrEqual(1); // Enqueue only: canceled windows never probe.
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    turnEnd(b);
    expect(sentContents(b)).toEqual(shutDown || replaced ? [] : [expect.stringContaining("prepared input arrival done")]);
    expect(vi.getTimerCount()).toBe(shutDown ? 0 : baselineTimers);
  });

  it("does not poll or deliver if queued work has made the parent busy again", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    const timersBefore = vi.getTimerCount();
    b.lifecycle.get("session_compact")();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timersBefore);
    b.parent.running = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    b.lifecycle.get("agent_settled")();
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("caps summary cleanup probes and unrefs every timed backoff", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    b.parent.running = false; // no low-level run, but later summary handlers remain busy
    const isIdle = vi.fn(() => false);
    b.parentCtx.isIdle = isIdle;
    const timersBefore = vi.getTimerCount();
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    try {
      b.lifecycle.get("session_compact")();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(isIdle).toHaveBeenCalledTimes(60);
      expect(timeouts.mock.calls.map(([, delay]) => delay)).toEqual([0, ...Array(60).fill(500)]);
      for (const result of timeouts.mock.results) {
        if (result.type === "return") expect(result.value.hasRef()).toBe(false);
      }
      expect(vi.getTimerCount()).toBe(timersBefore + 1);
      expect(b.pi.sendMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); // Deadline check plus the diagnostic's independent public-idle observation.
      expect(isIdle).toHaveBeenCalledTimes(62);
      expect(vi.getTimerCount()).toBe(timersBefore - 1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(isIdle).toHaveBeenCalledTimes(62);
      b.lifecycle.get("agent_settled")();
      expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    } finally {
      timeouts.mockRestore();
    }
  });

  it.each(["input", "before_agent_start", "session_start", "session_shutdown"])("cancels a timed summary backoff on %s", async event => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    b.parent.running = false;
    b.parentCtx.isIdle = () => false;
    const timersBefore = vi.getTimerCount();
    b.lifecycle.get("session_compact")();
    await vi.advanceTimersByTimeAsync(5);
    expect(vi.getTimerCount()).toBe(timersBefore + 1);
    await b.lifecycle.get(event)({}, ctx());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    if (event === "input" || event === "before_agent_start") {
      turnEnd(b);
      expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    }
  });

  it("stops on agent_start even after its low-level signal disappears during retry", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    b.parent.running = false;
    const isIdle = vi.fn(() => false);
    b.parentCtx.isIdle = isIdle;
    const timersBefore = vi.getTimerCount();
    b.lifecycle.get("session_compact")();
    await vi.advanceTimersByTimeAsync(5);
    b.lifecycle.get("agent_start")();
    const probes = isIdle.mock.calls.length;
    expect(b.parentCtx.signal).toBeUndefined();
    b.lifecycle.get("session_compact_failed")();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(isIdle).toHaveBeenCalledTimes(probes);
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    b.lifecycle.get("agent_settled")();
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it.each(["input", "before_agent_start", "session_start", "session_shutdown"])("cancels the post-summary immediate on %s", async event => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    b.lifecycle.get("session_compact")();
    await b.lifecycle.get(event)({}, ctx());
    await vi.advanceTimersByTimeAsync(0);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["agent_end", "agent_settled", "before_agent_start"] as const)("characterizes Pi 1.4 delivery while an awaited %s handler is blocked", async blockedEvent => {
    const runs = controllableRuns();
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    faux.setResponses([
      fauxAssistantMessage("Initial reply"),
      fauxAssistantMessage("First continuation"),
      fauxAssistantMessage("Second continuation"),
    ]);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const handlerEntered = new Promise<void>(resolve => { entered = resolve; });
    let blocked = false;
    let preparations = 0;
    const input = vi.fn();
    const laterSettlementHandler = vi.fn();
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: hermetic.dir, agentDir: getAgentDir(), settingsManager,
      extensionFactories: [pi => {
        // Keep shutdown's unrelated worktree-prune OS boundary hermetic.
        vi.spyOn(pi, "exec").mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false });
        subagentsExtension(pi);
      }, pi => {
        pi.on(blockedEvent, async () => {
          // Hold a reentrant run's preparation, not the first prompt.
          if (blocked || (blockedEvent === "before_agent_start" && ++preparations === 1)) return;
          blocked = true;
          entered();
          await held;
        });
        if (blockedEvent === "before_agent_start") {
          let wakeRequested = false;
          pi.on("agent_settled", () => {
            if (wakeRequested) return;
            wakeRequested = true;
            pi.sendMessage({ customType: "synthetic-wake", content: "Continue", display: false },
              { deliverAs: "steer", triggerTurn: true });
          });
        }
        pi.on("input", () => { input(); });
      }, pi => {
        pi.on("agent_settled", () => { laterSettlementHandler(); });
      }],
      noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      ...fauxModelBackend(faux.getModel()), cwd: hermetic.dir, model: faux.getModel(),
      resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(hermetic.dir),
    });
    let prompt: Promise<void> | undefined;
    try {
      await session.bindExtensions({});
      const send = vi.spyOn(session, "sendCustomMessage");
      await session.getToolDefinition("Agent")!.execute(
        "call-alpha", { prompt: "alpha", description: "alpha", run_in_background: true },
        undefined, undefined, session.extensionRunner.createToolContext("call-alpha", undefined),
      );
      prompt = session.prompt("Initial prompt");
      await handlerEntered;
      // Pi clears run-active BEFORE awaiting settled handlers, but a reentrant
      // run becomes active before preparation, without a new agent_start yet.
      expect(session.isIdle).toBe(blockedEvent === "agent_settled");
      send.mockClear();
      laterSettlementHandler.mockClear();
      runs.settle("alpha");
      await new Promise<void>(resolve => setImmediate(resolve));
      input.mockClear();
      await session.prompt("Input during the held handler", { streamingBehavior: "steer" });
      expect(session.messages.filter(message => message.role === "custom" && message.customType === "subagent-notification"))
        .toHaveLength(0);
      expect(session.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("Input during")))
        .toBe(false);
      expect(laterSettlementHandler).not.toHaveBeenCalled();
      if (blockedEvent === "agent_settled") {
        // The outbox has already flushed. Both this send and the user's input
        // wait in Pi's deferred-settled actions, not in CompletionOutbox.
        expect(send).toHaveBeenCalledOnce();
        expect(input).not.toHaveBeenCalled();
      } else {
        expect(send).not.toHaveBeenCalled();
        expect(input).toHaveBeenCalledOnce();
      }
      release();
      await prompt;
      await session.waitForIdle();
      expect(session.messages.filter(message => message.role === "custom" && message.customType === "subagent-notification"))
        .toHaveLength(1);
      expect(session.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("Input during")))
        .toBe(true);
      expect(laterSettlementHandler).toHaveBeenCalled();
      expect(session.isIdle).toBe(true);
    } finally {
      release();
      await session.abort();
      await prompt;
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

  it("restores an earlier pending background run after an archived foreground resume consumes only its own snapshot", async () => {
    vi.useFakeTimers();
    const b = await boot();
    const sessionFile = join(hermetic!.dir, "pending-worker.jsonl");
    writeFileSync(sessionFile, "");
    const runs = controllableRuns(sessionFile);
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    // A live foreground resume has no completion callback; reopening an evicted
    // worker does, and must not consume earlier snapshots for the same worker ID.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    const manager = Reflect.get(globalThis, MANAGER_KEY) as Pick<AgentManager, "getRecord">;
    expect(manager.getRecord(id)).toBeUndefined();
    const inline = resume(b, b.parentCtx, id, "inline resume", false);
    await vi.advanceTimersByTimeAsync(0);
    runs.settle("inline resume");
    const result = await inline;
    expect(result.content[0].text).toContain("inline resume done");
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    // Reopening must not mistake the inline run's consumption for delivery of
    // the earlier background notification that is still in the live outbox.
    const sessionManager = b.parentCtx.sessionManager;
    const restored = new CompletionJournal(sessionManager.getSessionId(), vi.fn());
    expect(restored.restore(sessionManager.getEntries())).toMatchObject({ pending: 1, consumed: 1, delivered: 0 });
    const runsAfterRestore = restored.list();
    expect(runsAfterRestore.map(item => [item.snapshot.record.result, item.state])).toEqual([
      ["alpha done", "pending"], ["inline resume done", "consumed"],
    ]);
    expect(new Set(runsAfterRestore.map(item => item.snapshot.deliveryId)).size).toBe(2);
    turnEnd(b);
    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);
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
