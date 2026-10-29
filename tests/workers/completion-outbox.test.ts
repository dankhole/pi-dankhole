import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompletionOutbox } from "../../src/workers/completion-outbox.js";
import type { NotificationDetails } from "../../src/workers/types.js";

function details(id: string): NotificationDetails {
  return {
    id, description: `task ${id}`, status: "completed", toolUses: 0, turnCount: 1,
    totalTokens: 0, durationMs: 1, resultPreview: "",
  };
}

const message = (id: string) => ({ content: `<done ${id}>`, details: details(id) });

describe("CompletionOutbox", () => {
  let running: boolean;
  let send: ReturnType<typeof vi.fn>;
  let outbox: CompletionOutbox;
  let pendingChanged: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    running = true;
    // Most legacy batching cases use a transport with immediate persisted
    // receipt confirmation. Tests below override it to exercise Pi's void API.
    send = vi.fn(() => outbox.acknowledge(outbox.entries().filter(entry => entry.state === "inFlight").map(entry => entry.deliveryId)));
    pendingChanged = vi.fn();
    outbox = new CompletionOutbox(send, () => running, pendingChanged);
  });

  afterEach(() => {
    outbox.dispose();
    vi.useRealTimers();
  });

  it("delivers immediately when the parent is already idle, without a hold timer", () => {
    running = false;
    outbox.add("a", message("a"));
    expect(send).toHaveBeenCalledExactlyOnceWith(message("a"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds busy-parent completions until its tool boundary, not a timeout", () => {
    outbox.add("a", message("a"));
    outbox.add("b", message("b"));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(send).not.toHaveBeenCalled();

    outbox.onTurnEnd("toolUse");
    expect(send).toHaveBeenCalledExactlyOnceWith({
      content: "2 background tasks finished.\n\n<done a>\n\n<done b>",
      details: { ...details("a"), others: [details("b")] },
    });
    outbox.onSettled();
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(["aborted", "error"])("keeps completions through an %s turn until settlement", (reason) => {
    outbox.add("a", message("a"));
    outbox.onTurnEnd(reason);
    expect(send).not.toHaveBeenCalled();
    outbox.onSettled();
    expect(send).toHaveBeenCalledExactlyOnceWith(message("a"));
  });

  it("can deliver at the next successful turn after a failed one", () => {
    outbox.add("a", message("a"));
    outbox.onTurnEnd("error");
    outbox.onTurnEnd("stop");
    expect(send).toHaveBeenCalledExactlyOnceWith(message("a"));
  });

  it("delivers completions arriving after the final turn at settlement", () => {
    outbox.onTurnEnd("stop");
    outbox.add("a", message("a"));
    outbox.onSettled();
    expect(send).toHaveBeenCalledExactlyOnceWith(message("a"));
  });

  it("suppresses the consumed result but delivers other pending results", () => {
    outbox.add("a", message("a"));
    outbox.add("b", message("b"));
    outbox.cancel("a");
    outbox.onTurnEnd("toolUse");
    expect(send).toHaveBeenCalledExactlyOnceWith(message("b"));
  });

  it("sends nothing when every pending result was consumed", () => {
    outbox.add("a", message("a"));
    outbox.cancel("a");
    outbox.onSettled();
    expect(send).not.toHaveBeenCalled();
  });

  it("retains each unseen run of the same worker in one boundary notification", () => {
    outbox.add("a", message("a"));
    outbox.add("b", message("b"));
    outbox.add("a", { content: "<done a again>", details: { ...details("a"), resultPreview: "resumed" } });
    outbox.onTurnEnd("toolUse");
    expect(send).toHaveBeenCalledExactlyOnceWith({
      content: "3 background tasks finished.\n\n<done a>\n\n<done b>\n\n<done a again>",
      details: { ...details("a"), others: [details("b"), { ...details("a"), resultPreview: "resumed" }] },
    });
    outbox.onSettled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("cancels all pending runs for a consumed worker without dropping siblings or future runs", () => {
    outbox.add("a", message("a"));
    outbox.add("b", message("b"));
    outbox.add("a", { content: "<done a again>", details: details("a") });
    outbox.cancel("a");
    outbox.onTurnEnd("toolUse");
    expect(send).toHaveBeenCalledExactlyOnceWith(message("b"));

    outbox.add("a", message("a"));
    outbox.onSettled();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(message("a"));
  });

  it("retains an uncertain snapshot when a send throws, without automatic retries", () => {
    send.mockImplementation(() => { throw new Error("stale extension context"); });
    outbox.add("a", message("a"));
    expect(() => outbox.onSettled()).not.toThrow();
    expect(outbox.getState()).toMatchObject({ count: 1, queued: 0, inFlight: 0, uncertain: 1 });
    outbox.onTurnEnd("toolUse");
    outbox.onSettled();
    running = false;
    outbox.onIdle();
    expect(send).toHaveBeenCalledOnce();
    expect(outbox.entries()[0].message).toEqual(message("a"));
  });

  it("public-idle recovery rechecks busy state and is inert after disposal", () => {
    outbox.add("a", message("a"));
    outbox.onIdle();
    expect(send).not.toHaveBeenCalled();
    running = false;
    outbox.onIdle();
    expect(send).toHaveBeenCalledExactlyOnceWith(message("a"));
    outbox.dispose();
    outbox.onIdle();
    expect(send).toHaveBeenCalledOnce();
  });

  it("diagnostic observer failures cannot prevent safe-boundary delivery", () => {
    outbox = new CompletionOutbox(send, () => running, () => { throw new Error("stale diagnostic UI"); });
    expect(() => outbox.add("a", message("a"))).not.toThrow();
    expect(() => outbox.onSettled()).not.toThrow();
    expect(send).toHaveBeenCalledExactlyOnceWith(message("a"));
  });

  it("retains monotonic pending ages while count notifications are deduplicated", () => {
    outbox.add("a", message("a"));
    vi.advanceTimersByTime(1_000);
    vi.setSystemTime(Date.now() - 60_000);
    expect(outbox.getPendingState()).toEqual({ count: 1, oldestAgeMs: 1_000 });
    outbox.cancel("absent");
    expect(pendingChanged.mock.calls).toEqual([[1]]);
    outbox.add("b", message("b"));
    outbox.cancel("a");
    expect(outbox.getPendingState()).toEqual({ count: 1, oldestAgeMs: 0 });
    vi.advanceTimersByTime(500);
    expect(outbox.getPendingState()).toEqual({ count: 1, oldestAgeMs: 500 });
    expect(pendingChanged.mock.calls).toEqual([[1], [2], [1]]);
  });

  it("ages only non-held watchdog entries and restarts held eligibility without changing total pending age", () => {
    outbox.restore("held", message("held"), { ownerSessionId: "owner", deliveryId: "held-run" });
    vi.advanceTimersByTime(60_000);
    expect(outbox.getWatchdogState()).toEqual({ count: 0, oldestAgeMs: 0 });
    outbox.add("fresh", message("fresh"));
    expect(outbox.getPendingState()).toEqual({ count: 2, oldestAgeMs: 60_000 });
    expect(outbox.getWatchdogState()).toEqual({ count: 1, oldestAgeMs: 0 });
    vi.advanceTimersByTime(1_000);
    expect(outbox.retry("held-run")).toBe(true);
    // The retried first entry is newer than the fresh sibling for watchdog
    // purposes; eligibility order need not match unresolved insertion order.
    expect(outbox.getWatchdogState()).toEqual({ count: 2, oldestAgeMs: 1_000 });
    outbox.cancel("fresh");
    expect(outbox.getWatchdogState()).toEqual({ count: 1, oldestAgeMs: 0 });
    expect(outbox.getPendingState()).toEqual({ count: 1, oldestAgeMs: 61_000 });
    vi.advanceTimersByTime(500);
    expect(outbox.getWatchdogState()).toEqual({ count: 1, oldestAgeMs: 500 });
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains uncertain delivery age across deliberate retry", () => {
    send.mockImplementation(() => { throw new Error("unconfirmed send"); });
    const deliveryId = outbox.add("uncertain", message("uncertain"))!;
    outbox.onTurnEnd("toolUse");
    vi.advanceTimersByTime(60_000);
    expect(outbox.getState()).toMatchObject({ uncertain: 1 });
    expect(outbox.getWatchdogState()).toEqual({ count: 1, oldestAgeMs: 60_000 });
    expect(outbox.retry(deliveryId)).toBe(true);
    expect(outbox.getWatchdogState()).toEqual({ count: 1, oldestAgeMs: 60_000 });
    expect(send).toHaveBeenCalledOnce();
  });

  it("reports waiting results immediately, coalesces unchanged counts, and uses no timers", () => {
    expect(pendingChanged).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    outbox.add("a", message("a"));
    expect(pendingChanged).toHaveBeenCalledExactlyOnceWith(1);
    outbox.add("b", message("b"));
    expect(pendingChanged).toHaveBeenLastCalledWith(2);
    outbox.cancel("absent");
    outbox.onTurnEnd("error");
    vi.advanceTimersByTime(26 * 60_000);
    expect(pendingChanged.mock.calls).toEqual([[1], [2]]);
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["flush", "cancel", "dispose"])("clears waiting status on %s, without redundant updates", action => {
    outbox.add("a", message("a"));
    if (action === "flush") outbox.onSettled();
    else if (action === "cancel") outbox.cancel("a");
    else outbox.dispose();
    expect(pendingChanged.mock.calls).toEqual([[1], [0]]);
    outbox.onSettled();
    outbox.cancel("a");
    outbox.dispose();
    expect(pendingChanged.mock.calls).toEqual([[1], [0]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports capture before the idle probe and clears status only on receipt acknowledgement", () => {
    running = false;
    outbox.add("a", message("a"));
    expect(send).toHaveBeenCalledOnce();
    expect(pendingChanged.mock.calls).toEqual([[1], [0]]);
  });

  it("updates the status when one of several results is consumed", () => {
    outbox.add("a", message("a"));
    outbox.add("b", message("b"));
    outbox.cancel("a");
    expect(pendingChanged.mock.calls).toEqual([[1], [2], [1]]);
    outbox.onTurnEnd("toolUse");
    expect(pendingChanged).toHaveBeenLastCalledWith(0);
    expect(send).toHaveBeenCalledExactlyOnceWith(message("b"));
  });

  it("does not let status failures change delivery or cancellation", () => {
    pendingChanged.mockImplementation(() => { throw new Error("stale UI"); });
    outbox.add("a", message("a"));
    outbox.add("b", message("b"));
    outbox.cancel("a");
    outbox.onSettled();
    expect(send).toHaveBeenCalledExactlyOnceWith(message("b"));
  });

  it("delivers at a post-summary idle check exactly once, without a timer", () => {
    outbox.add("a", message("a"));
    outbox.onIdle();
    expect(send).not.toHaveBeenCalled();
    running = false;
    outbox.onIdle();
    outbox.onIdle();
    expect(send).toHaveBeenCalledExactlyOnceWith(message("a"));
    expect(pendingChanged).toHaveBeenLastCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores post-summary idle checks after disposal", () => {
    outbox.add("a", message("a"));
    outbox.dispose();
    running = false;
    outbox.onIdle();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps successful void sends in flight until actual receipt acknowledgement", () => {
    send.mockImplementation(() => {});
    const id = outbox.add("a", message("a"))!;
    outbox.onTurnEnd("toolUse");
    expect(outbox.getState()).toMatchObject({ count: 1, queued: 0, inFlight: 1, uncertain: 0 });
    expect(pendingChanged.mock.calls).toEqual([[1]]);
    outbox.onTurnEnd("stop");
    expect(send).toHaveBeenCalledOnce();
    outbox.onSettled();
    expect(outbox.getState()).toMatchObject({ count: 1, inFlight: 0, uncertain: 1 });
    expect(send).toHaveBeenCalledOnce();
    outbox.acknowledge([id]);
    expect(outbox.getPendingState().count).toBe(0);
    expect(pendingChanged.mock.calls).toEqual([[1], [0]]);
  });

  it("treats a throwing idle predicate as busy after publishing pending state", () => {
    const failure = vi.fn();
    outbox = new CompletionOutbox(send, () => {
      expect(pendingChanged).toHaveBeenCalledWith(1);
      throw new Error("stale public idle");
    }, pendingChanged, { onFailure: failure });
    expect(() => outbox.add("a", message("a"))).not.toThrow();
    expect(() => outbox.onIdle()).not.toThrow();
    expect(outbox.getState()).toMatchObject({ count: 1, queued: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ kind: "idle-observation" }));
    outbox.onTurnEnd("toolUse");
    expect(send).toHaveBeenCalledOnce();
  });

  it("captures immutable snapshots and retains reentrant arrivals for the next boundary", () => {
    const original = message("a");
    outbox.add("a", original);
    original.content = "mutated";
    original.details.description = "mutated";
    send.mockImplementationOnce(() => {
      outbox.add("b", message("b"));
      outbox.onSettled();
      outbox.cancel("a");
    });
    outbox.onTurnEnd("toolUse");
    expect(send).toHaveBeenCalledExactlyOnceWith(message("a"));
    expect(outbox.entries()).toMatchObject([{ id: "b", state: "queued", message: message("b") }]);
    outbox.onTurnEnd("toolUse");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(message("b"));
  });

  it("does not resurrect consumption or receipt acknowledgement when transport later throws", () => {
    outbox.add("a", message("a"));
    outbox.add("b", message("b"));
    send.mockImplementation(() => {
      outbox.cancel("a");
      outbox.acknowledge(outbox.entries().filter(entry => entry.id === "b").map(entry => entry.deliveryId));
      throw new Error("side effect then throw");
    });
    outbox.onSettled();
    expect(outbox.getPendingState().count).toBe(0);
    outbox.onSettled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("restores known-unsent and uncertain results without probing or replaying", () => {
    const probe = vi.fn(() => false);
    outbox = new CompletionOutbox(send, probe, pendingChanged, { getOwnerSessionId: () => "owner" });
    outbox.restore("a", message("a"), { ownerSessionId: "owner", deliveryId: "run-a" });
    outbox.restore("b", message("b"), { ownerSessionId: "owner", deliveryId: "run-b" }, true);
    outbox.onIdle();
    outbox.onTurnEnd("toolUse");
    outbox.onSettled();
    expect(outbox.getState()).toMatchObject({ count: 2, held: 1, uncertain: 1, queued: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledOnce(); // Explicit onIdle only, never restore.
    expect(outbox.retry("run-a")).toBe(true);
    expect(send).not.toHaveBeenCalled();
    outbox.onIdle();
    expect(send).toHaveBeenCalledExactlyOnceWith(message("a"));
    expect(outbox.entries()).toMatchObject([{ id: "b", state: "uncertain" }]);
  });

  it("fences tracked results to their current owner, even if ownership changes before send", () => {
    let owner = "other";
    outbox = new CompletionOutbox(send, () => false, pendingChanged, {
      getOwnerSessionId: () => owner,
      onAttempt: () => { owner = "replacement"; },
    });
    outbox.add("a", message("a"), { ownerSessionId: "owner", deliveryId: "run-a" });
    expect(send).not.toHaveBeenCalled();
    owner = "owner";
    outbox.onIdle();
    expect(send).not.toHaveBeenCalled();
    expect(outbox.getState()).toMatchObject({ held: 1, count: 1 });
  });

  it("fails closed when a tracked result has no current owner or its getter throws", () => {
    outbox = new CompletionOutbox(send, () => false);
    outbox.add("a", message("a"), { ownerSessionId: "owner", deliveryId: "run-a" });
    outbox.onSettled();
    expect(send).not.toHaveBeenCalled();
    expect(outbox.getState()).toMatchObject({ queued: 1 });
    outbox.dispose();
    outbox = new CompletionOutbox(send, () => false, pendingChanged, {
      getOwnerSessionId: () => { throw new Error("stale owner"); },
    });
    outbox.add("a", message("a"), { ownerSessionId: "owner", deliveryId: "run-a" });
    expect(send).not.toHaveBeenCalled();
  });

  it("isolates persistence/observation failures and preserves phase-only state updates", () => {
    const states: string[] = [];
    const failure = vi.fn(() => { throw new Error("stale error UI"); });
    send.mockImplementation(() => {});
    outbox = new CompletionOutbox(send, () => true, pendingChanged, {
      onAttempt: () => { throw new Error("journal disk failure"); },
      onFailure: failure,
      onStateChange: state => { states.push(`${state.queued}/${state.inFlight}/${state.uncertain}`); },
    });
    outbox.add("a", message("a"));
    outbox.onTurnEnd("toolUse");
    outbox.onSettled();
    expect(send).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ kind: "attempt-observer" }));
    expect(states).toEqual(expect.arrayContaining(["1/0/0", "0/1/0", "0/0/1"]));
    expect(pendingChanged.mock.calls).toEqual([[1]]);
  });

  it("suppresses queued delivery at aborted settlement without losing it", () => {
    outbox.add("a", message("a"));
    outbox.onTurnEnd("aborted");
    outbox.onSettled(true);
    expect(send).not.toHaveBeenCalled();
    expect(outbox.getState()).toMatchObject({ queued: 1, count: 1 });
    outbox.onTurnEnd("toolUse");
    expect(send).toHaveBeenCalledOnce();
  });

  it("recovers only the selected queued result after abort and leaves its sibling for a normal boundary", () => {
    const attempt = vi.fn();
    outbox = new CompletionOutbox(send, () => running, pendingChanged, { onAttempt: attempt });
    const first = outbox.add("a", message("a"))!;
    const second = outbox.add("b", message("b"))!;
    outbox.onTurnEnd("aborted");
    outbox.onSettled(true);
    running = false;
    outbox.onIdle(first);
    expect(send).toHaveBeenCalledExactlyOnceWith(message("a"));
    expect(attempt).toHaveBeenCalledExactlyOnceWith([first]);
    expect(outbox.entries()).toMatchObject([{ deliveryId: second, id: "b", state: "queued" }]);
    outbox.onTurnEnd("toolUse");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(message("b"));
    expect(attempt).toHaveBeenLastCalledWith([second]);
    expect(outbox.getPendingState().count).toBe(0);
  });

  it("does not substitute a queued sibling when the selected result has the wrong owner or ID", () => {
    const attempt = vi.fn();
    outbox = new CompletionOutbox(send, () => running, pendingChanged, {
      getOwnerSessionId: () => "owner", onAttempt: attempt,
    });
    outbox.add("a", message("a"), { ownerSessionId: "other", deliveryId: "foreign-run" });
    outbox.add("b", message("b"), { ownerSessionId: "owner", deliveryId: "owned-run" });
    running = false;
    outbox.onIdle("foreign-run");
    outbox.onIdle("missing-run");
    expect(send).not.toHaveBeenCalled();
    expect(attempt).not.toHaveBeenCalled();
    expect(outbox.getState()).toMatchObject({ queued: 2, count: 2 });
    outbox.onIdle(); // Existing unscoped owner-filtered behavior is unchanged.
    expect(send).toHaveBeenCalledExactlyOnceWith(message("b"));
    expect(outbox.entries()).toMatchObject([{ deliveryId: "foreign-run", state: "queued" }]);
  });

  it("retains selected and sibling results when the scoped public-idle observation throws", () => {
    let fail = false;
    const attempt = vi.fn();
    const failure = vi.fn();
    outbox = new CompletionOutbox(send, () => {
      if (fail) throw new Error("stale idle observation");
      return running;
    }, pendingChanged, { onAttempt: attempt, onFailure: failure });
    const selected = outbox.add("a", message("a"))!;
    outbox.add("b", message("b"));
    running = false;
    fail = true;
    expect(() => outbox.onIdle(selected)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(attempt).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ kind: "idle-observation" }));
    expect(outbox.getState()).toMatchObject({ queued: 2, count: 2 });
    fail = false;
    outbox.onIdle();
    expect(send).toHaveBeenCalledExactlyOnceWith({
      content: "2 background tasks finished.\n\n<done a>\n\n<done b>",
      details: { ...details("a"), others: [details("b")] },
    });
  });

  it("does not automatically retry a selected uncertain result or release queued siblings", () => {
    send.mockImplementationOnce(() => { throw new Error("send acceptance unknown"); });
    const selected = outbox.add("a", message("a"))!;
    outbox.onTurnEnd("toolUse");
    const sibling = outbox.add("b", message("b"))!;
    running = false;
    outbox.onIdle(selected);
    expect(send).toHaveBeenCalledOnce();
    expect(outbox.getState()).toMatchObject({ uncertain: 1, queued: 1, count: 2 });
    expect(outbox.retry(selected)).toBe(true);
    outbox.onIdle(selected);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(message("a"));
    expect(outbox.entries()).toMatchObject([{ deliveryId: sibling, state: "queued" }]);
  });

  it("keeps reentrant arrivals queued during selected recovery and preserves later batch order", () => {
    const attempt = vi.fn();
    outbox = new CompletionOutbox(send, () => running, pendingChanged, { onAttempt: attempt });
    const selected = outbox.add("a", message("a"))!;
    const sibling = outbox.add("b", message("b"))!;
    send.mockImplementationOnce(() => {
      outbox.add("c", message("c"));
      outbox.onIdle(sibling);
      outbox.acknowledge([selected]);
    });
    running = false;
    outbox.onIdle(selected);
    expect(send).toHaveBeenCalledExactlyOnceWith(message("a"));
    expect(attempt).toHaveBeenCalledExactlyOnceWith([selected]);
    expect(outbox.entries()).toMatchObject([{ id: "b", state: "queued" }, { id: "c", state: "queued" }]);
    outbox.onTurnEnd("toolUse");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({
      content: "2 background tasks finished.\n\n<done b>\n\n<done c>",
      details: { ...details("b"), others: [details("c")] },
    });
    expect(outbox.getPendingState().count).toBe(0);
  });

  it("defers a result consumed synchronously by the pre-send observer", () => {
    outbox = new CompletionOutbox(send, () => true, pendingChanged, { onAttempt: () => outbox.cancel("a") });
    outbox.add("a", message("a"));
    outbox.add("b", message("b"));
    outbox.onTurnEnd("toolUse");
    expect(send).toHaveBeenCalledExactlyOnceWith(message("b"));
  });

  it("returns defensive entry copies and deduplicates delivery identities, not worker IDs", () => {
    const identity = { ownerSessionId: "owner", deliveryId: "run-a" };
    outbox.restore("a", message("a"), identity);
    outbox.restore("a", message("a"), identity);
    outbox.restore("a", message("a"), { ...identity, deliveryId: "run-b" });
    const copy = outbox.entries();
    copy[0].message.content = "mutation";
    expect(outbox.entries()).toHaveLength(2);
    expect(outbox.entries()[0].message).toEqual(message("a"));
    expect(outbox.entries()[0]).not.toHaveProperty("queuedAt");
    expect(outbox.entries()[0]).not.toHaveProperty("watchdogAt");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shutdown drops activation state and later completions, not journal-owned recovery", () => {
    outbox.add("a", message("a"));
    outbox.dispose();
    running = false;
    outbox.add("b", message("b"));
    outbox.onSettled();
    expect(send).not.toHaveBeenCalled();
  });
});
