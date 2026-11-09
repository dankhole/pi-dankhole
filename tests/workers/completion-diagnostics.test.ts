import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPLETION_WAIT_WARNING_MS, CompletionDiagnostics, describeCompletionDiagnostic, describeCompletionWarning, observePublicParent, type ParentObservation } from "../../src/workers/completion-diagnostics.js";
import { CompletionOutbox, type OutboxMessage } from "../../src/workers/completion-outbox.js";

const message: OutboxMessage = {
  content: "SECRET prompt/result must never enter diagnostics",
  details: { id: "private-id", description: "private task", status: "completed", toolUses: 0, turnCount: 1, totalTokens: 0, durationMs: 0, resultPreview: "private result" },
};

describe("completion wait diagnostics", () => {
  let outbox: CompletionOutbox;
  let diagnostics: CompletionDiagnostics;
  let parent: ParentObservation;
  let publish: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    parent = { idle: false, queuedMessages: false, signal: "absent" };
    publish = vi.fn();
    send = vi.fn();
    diagnostics = new CompletionDiagnostics(() => outbox.getPendingState(), () => parent, publish);
    outbox = new CompletionOutbox(send, () => !parent.idle, () => diagnostics.pendingChanged());
  });
  afterEach(() => { diagnostics.dispose(); outbox.dispose(); vi.useRealTimers(); });

  it("uses a single unref'ed one-shot only while pending, with no delivery or UI tick", () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    outbox.add("a", message);
    const handle = timeout.mock.results.at(-1)!.value;
    expect(handle.hasRef()).toBe(false);
    outbox.add("b", message);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS - 1);
    expect(publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ count: 2, oldestAgeMs: 30_000 }), false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(600_000);
    expect(publish).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    timeout.mockRestore();
  });

  it.each(["tool_execution_start", "before_provider_request"] as const)("does not mistake a long %s for a stall", event => {
    diagnostics.observe(event);
    parent.signal = "active";
    outbox.add("a", message);
    vi.advanceTimersByTime(10 * COMPLETION_WAIT_WARNING_MS);
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ lastLifecycle: event }), false);
    expect(vi.getTimerCount()).toBe(0);
    expect(diagnostics.snapshot()).toMatchObject({ count: 1, oldestAgeMs: 300_000 });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps ordinary progressing parent work quiet while retaining detailed diagnostics", () => {
    diagnostics.observe("agent_start");
    outbox.add("a", message);
    for (let turn = 0; turn < 10; turn++) {
      diagnostics.observe("before_provider_request");
      vi.advanceTimersByTime(10_000);
      diagnostics.observe("after_provider_response");
      diagnostics.observe("tool_execution_start");
      vi.advanceTimersByTime(10_000);
      diagnostics.observe("tool_execution_end");
    }
    expect(publish.mock.calls.some(call => call[1])).toBe(false);
    expect(describeCompletionDiagnostic(diagnostics.snapshot())).toContain("oldest 200s");
    expect(describeCompletionDiagnostic(diagnostics.snapshot())).toContain("Host-internal busy cause unknown");
    expect(vi.getTimerCount()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("rechecks a quiet settlement after active work, without warning before its delivery handler", () => {
    outbox.add("a", message);
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS);
    expect(publish.mock.calls.some(call => call[1])).toBe(false);
    parent.idle = true;
    diagnostics.observe("agent_settled");
    diagnostics.pendingChanged(); // Boundary state changes must retain the quiet-window check.
    expect(publish.mock.calls.some(call => call[1])).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS - 1);
    expect(publish.mock.calls.some(call => call[1])).toBe(false);
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ idle: true, lifecycleAgeMs: 30_000 }), true);
    expect(vi.getTimerCount()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("clears a quiet-boundary recheck when the pending result is consumed", () => {
    outbox.add("a", message);
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS);
    diagnostics.observe("agent_settled");
    expect(vi.getTimerCount()).toBe(1);
    outbox.cancel("a");
    expect(vi.getTimerCount()).toBe(0);
    expect(publish).toHaveBeenLastCalledWith(undefined, false);
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS);
    expect(publish.mock.calls.some(call => call[1])).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("cancels a quiet-boundary recheck when ordinary work resumes", () => {
    outbox.add("a", message);
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS);
    diagnostics.observe("agent_settled");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_000);
    diagnostics.observe("agent_start");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(publish.mock.calls.some(call => call[1])).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("warns on an expired bounded summary check without inventing the host busy cause", () => {
    outbox.add("a", message);
    diagnostics.observe("summary_abort");
    parent.idleObservation = "expired";
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ idle: false, idleObservation: "expired" }), true);
    const warning = describeCompletionWarning(diagnostics.snapshot());
    expect(warning).toContain("1 worker result still waiting for delivery");
    expect(warning).toContain("/agents diagnostics");
    expect(warning).not.toMatch(/idle=|signal=|timers|stalled|SECRET|private/);
    expect(send).not.toHaveBeenCalled();
  });

  it("can warn on newly uncertain delivery after suppressing the ordinary wait", () => {
    outbox.add("a", message);
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS);
    expect(publish.mock.calls.some(call => call[1])).toBe(false);
    parent.uncertainDeliveries = 1;
    diagnostics.pendingChanged();
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ uncertainDeliveries: 1 }), true);
    expect(describeCompletionWarning(diagnostics.snapshot())).toBe(
      "Delivery unconfirmed for 1 worker result. Check /agents recover before retrying (duplicates possible).",
    );
    expect(describeCompletionWarning({ ...diagnostics.snapshot(), count: 3 })).toContain("for 1 worker result.");
    expect(describeCompletionWarning({ ...diagnostics.snapshot(), uncertainDeliveries: 2 })).toContain("for 2 worker results.");
    diagnostics.pendingChanged();
    expect(publish.mock.calls.filter(call => call[1])).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["active", "unknown"] as const)("does not treat idle=true with an %s signal as a safe-idle delay", signal => {
    outbox.add("a", message);
    parent.idle = true;
    parent.signal = signal;
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ idle: true, signal }), false);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not warn about pending parent messages or unavailable observations alone", () => {
    outbox.add("a", message);
    parent.idle = true;
    parent.queuedMessages = true;
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ queuedMessages: true }), false);
    parent.queuedMessages = undefined;
    diagnostics.pendingChanged();
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ queuedMessages: undefined }), false);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps restored counts truthful but watches only non-held recovery (uncertain=%s)", uncertain => {
    diagnostics.dispose();
    outbox.dispose();
    diagnostics = new CompletionDiagnostics(() => outbox.getPendingState(), () => parent, publish, undefined,
      () => outbox.getWatchdogState());
    outbox = new CompletionOutbox(send, () => true, undefined, {
      getOwnerSessionId: () => "owner",
      onStateChange: () => diagnostics.pendingChanged(),
    });
    parent.uncertainDeliveries = uncertain ? 1 : 0;
    outbox.restore("restored", message, { ownerSessionId: "owner", deliveryId: "saved-run" }, uncertain);
    expect(diagnostics.snapshot().count).toBe(1);
    expect(vi.getTimerCount()).toBe(uncertain ? 1 : 0);
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS);
    if (uncertain) expect(publish).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }), true);
    else expect(publish).not.toHaveBeenCalled();
    expect(diagnostics.snapshot().count).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["fresh", "held retry"])("waits a full eligibility window for %s after an older held restoration", action => {
    diagnostics.dispose();
    outbox.dispose();
    diagnostics = new CompletionDiagnostics(() => outbox.getPendingState(), () => parent, publish, undefined,
      () => outbox.getWatchdogState());
    outbox = new CompletionOutbox(send, () => true, undefined, {
      getOwnerSessionId: () => "owner", onStateChange: () => diagnostics.pendingChanged(),
    });
    outbox.restore("held", message, { ownerSessionId: "owner", deliveryId: "held-run" });
    vi.advanceTimersByTime(60_000);
    expect(publish).not.toHaveBeenCalled();
    if (action === "fresh") outbox.add("fresh", message);
    else expect(outbox.retry("held-run")).toBe(true);
    const count = action === "fresh" ? 2 : 1;
    expect(diagnostics.snapshot()).toMatchObject({ count, oldestAgeMs: 60_000 });
    expect(outbox.getWatchdogState()).toEqual({ count: 1, oldestAgeMs: 0 });
    expect(publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS - 1);
    expect(publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ count, oldestAgeMs: 90_000 }), false);
    expect(vi.getTimerCount()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("reports monotonic age, public observations and lifecycle, not content or an inferred retry cause", () => {
    diagnostics.observe("agent_start");
    outbox.add("a", message);
    vi.advanceTimersByTime(10_000);
    diagnostics.observe("turn_end", "error");
    outbox.onTurnEnd("error");
    diagnostics.observe("agent_end"); // explicitly not final
    vi.setSystemTime(new Date("1999-01-01"));
    vi.advanceTimersByTime(20_000);
    expect(diagnostics.snapshot()).toMatchObject({ count: 1, oldestAgeMs: 30_000, lifecycleAgeMs: 20_000, lastLifecycle: "agent_end", lastTurnOutcome: "error", idle: false, queuedMessages: false, signal: "absent" });
    const text = describeCompletionDiagnostic(diagnostics.snapshot());
    expect(text).toContain("Host-internal busy cause unknown");
    expect(text).not.toMatch(/SECRET|private|retrying/);
    expect(JSON.stringify(publish.mock.calls)).not.toMatch(/SECRET|private/);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["error", "aborted"])("retains an %s turn's pending notification until a permitted send and receipt", reason => {
    outbox.add("a", message);
    diagnostics.observe("turn_end", reason);
    outbox.onTurnEnd(reason);
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS);
    expect(send).not.toHaveBeenCalled();
    diagnostics.observe("agent_settled");
    outbox.onSettled(reason === "aborted");
    if (reason === "aborted") {
      expect(send).not.toHaveBeenCalled();
      outbox.onTurnEnd("stop");
    }
    expect(send).toHaveBeenCalledExactlyOnceWith(message);
    expect(outbox.getPendingState().count).toBe(1); // Void send is not a receipt.
    outbox.acknowledge(outbox.entries().map(entry => entry.deliveryId));
    expect(publish).toHaveBeenLastCalledWith(undefined, false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancellation removes only the consumed snapshots and re-ages the oldest pending run", () => {
    outbox.add("a", message);
    vi.advanceTimersByTime(15_000);
    outbox.add("b", message);
    outbox.cancel("a");
    vi.advanceTimersByTime(15_000);
    expect(publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15_000);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ count: 1, oldestAgeMs: 30_000 }), false);
    outbox.cancel("b");
    expect(publish).toHaveBeenLastCalledWith(undefined, false);
    expect(vi.getTimerCount()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a published count accurate when consumption removes the oldest run, without a second watchdog", () => {
    outbox.add("a", message);
    vi.advanceTimersByTime(30_000);
    outbox.add("b", message);
    outbox.cancel("a");
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 1, oldestAgeMs: 0 }), false);
    expect(vi.getTimerCount()).toBe(0);
    expect(publish.mock.calls.filter(call => call[1])).toHaveLength(0);
  });

  it("rate limits warnings across short pending episodes and count changes", () => {
    parent.uncertainDeliveries = 1;
    outbox.add("a", message);
    vi.advanceTimersByTime(30_000);
    outbox.add("b", message);
    expect(publish.mock.calls.filter(call => call[1])).toHaveLength(1);
    outbox.cancel("a");
    outbox.cancel("b");
    outbox.add("c", message);
    vi.advanceTimersByTime(30_000);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 1 }), false);
    expect(publish.mock.calls.filter(call => call[1])).toHaveLength(1);
    outbox.cancel("c");
    outbox.add("d", message);
    vi.advanceTimersByTime(30_000);
    expect(publish.mock.calls.filter(call => call[1])).toHaveLength(2);
  });

  it("stale UI failures in the watchdog and cleanup cannot affect delivery", () => {
    publish.mockImplementation(() => { throw new Error("stale UI"); });
    outbox.add("a", message);
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    expect(() => outbox.onSettled()).not.toThrow();
    expect(send).toHaveBeenCalledExactlyOnceWith(message);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("public idle observed on timeout is diagnostic only, not permission to send", () => {
    outbox.add("a", message);
    parent.idle = true;
    vi.advanceTimersByTime(30_000);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ idle: true }), true);
    expect(send).not.toHaveBeenCalled();
    outbox.onTurnEnd("stop");
    expect(send).toHaveBeenCalledOnce();
  });

  it("reports unknown parent state when a public getter throws, including inside the watchdog", () => {
    diagnostics.dispose();
    diagnostics = new CompletionDiagnostics(() => outbox.getPendingState(), () => { throw new Error("SECRET stale parent"); }, publish);
    outbox.add("a", message);
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    expect(diagnostics.snapshot()).toMatchObject({ idle: undefined, queuedMessages: undefined, signal: "unknown", unavailableObservations: ["parent"] });
    expect(JSON.stringify(publish.mock.calls)).not.toContain("SECRET stale parent");
    expect(publish.mock.calls.some(call => call[1])).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("isolates individual public getters without converting unknown into idle or absent", () => {
    const context = {
      isIdle: () => { throw new Error("private"); },
      hasPendingMessages: () => true,
      get signal(): AbortSignal { throw new Error("private"); },
    };
    expect(observePublicParent(context as never)).toEqual({ idle: undefined, queuedMessages: true, signal: "unknown" });
  });

  it("observes content-free preparation, provider and tree phases without token hooks", () => {
    diagnostics.observe("before_agent_start");
    expect(diagnostics.snapshot().observedPhase).toBe("run preparation");
    diagnostics.observe("before_provider_request");
    expect(diagnostics.snapshot().observedPhase).toBe("provider request");
    diagnostics.observe("after_provider_response");
    expect(diagnostics.snapshot().observedPhase).toBe("provider response");
    diagnostics.observe("session_before_tree");
    expect(diagnostics.snapshot().observedPhase).toBe("tree navigation hook");
    diagnostics.observe("summary_abort");
    expect(describeCompletionDiagnostic(diagnostics.snapshot())).toContain("not settled");
  });

  it("cancels timers/status on disposal and cannot affect a replacement activation", () => {
    outbox.add("a", message);
    diagnostics.dispose();
    outbox.dispose();
    diagnostics.pendingChanged();
    vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    const replacementStarted = performance.now();
    const replacement = new CompletionDiagnostics(() => ({ count: 1, oldestAgeMs: performance.now() - replacementStarted }), () => parent, publish);
    replacement.pendingChanged();
    vi.advanceTimersByTime(30_000);
    expect(publish).toHaveBeenCalledOnce();
    replacement.dispose();
    expect(publish).toHaveBeenLastCalledWith(undefined, false);
    replacement.pendingChanged();
    expect(vi.getTimerCount()).toBe(0);
  });
});
