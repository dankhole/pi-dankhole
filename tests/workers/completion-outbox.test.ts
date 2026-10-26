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

  beforeEach(() => {
    vi.useFakeTimers();
    running = true;
    send = vi.fn();
    outbox = new CompletionOutbox(send, () => running);
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

  it("shutdown drops pending and later completions", () => {
    outbox.add("a", message("a"));
    outbox.dispose();
    running = false;
    outbox.add("b", message("b"));
    outbox.onSettled();
    expect(send).not.toHaveBeenCalled();
  });
});
