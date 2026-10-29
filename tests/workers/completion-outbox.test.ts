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
    send = vi.fn();
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

  it("survives a send that throws on a stale context", () => {
    send.mockImplementation(() => { throw new Error("stale extension context"); });
    outbox.add("a", message("a"));
    expect(() => outbox.onSettled()).not.toThrow();
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

  it("does not flash waiting status for immediate idle delivery", () => {
    running = false;
    outbox.add("a", message("a"));
    expect(send).toHaveBeenCalledOnce();
    expect(pendingChanged).not.toHaveBeenCalled();
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

  it("shutdown drops pending and later completions", () => {
    outbox.add("a", message("a"));
    outbox.dispose();
    running = false;
    outbox.add("b", message("b"));
    outbox.onSettled();
    expect(send).not.toHaveBeenCalled();
  });
});
