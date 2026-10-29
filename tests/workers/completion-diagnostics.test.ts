import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPLETION_WAIT_WARNING_MS, CompletionDiagnostics, describeCompletionDiagnostic, type ParentObservation } from "../../src/workers/completion-diagnostics.js";
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
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ count: 2, oldestAgeMs: 30_000 }), true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(600_000);
    expect(publish).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    timeout.mockRestore();
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

  it.each(["error", "aborted"])("does not lose an %s turn's pending notification and clears at settlement", reason => {
    outbox.add("a", message);
    diagnostics.observe("turn_end", reason);
    outbox.onTurnEnd(reason);
    vi.advanceTimersByTime(COMPLETION_WAIT_WARNING_MS);
    expect(send).not.toHaveBeenCalled();
    diagnostics.observe("agent_settled");
    outbox.onSettled();
    expect(send).toHaveBeenCalledExactlyOnceWith(message);
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
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ count: 1, oldestAgeMs: 30_000 }), true);
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
    expect(publish.mock.calls.filter(call => call[1])).toHaveLength(1);
  });

  it("rate limits warnings across short pending episodes and count changes", () => {
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

  it("cancels timers/status on disposal and cannot affect a replacement activation", () => {
    outbox.add("a", message);
    diagnostics.dispose();
    outbox.dispose();
    diagnostics.pendingChanged();
    vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    const replacement = new CompletionDiagnostics(() => ({ count: 1, oldestAgeMs: 0 }), () => parent, publish);
    replacement.pendingChanged();
    vi.advanceTimersByTime(30_000);
    expect(publish).toHaveBeenCalledOnce();
    replacement.dispose();
    expect(publish).toHaveBeenLastCalledWith(undefined, false);
    replacement.pendingChanged();
    expect(vi.getTimerCount()).toBe(0);
  });
});
