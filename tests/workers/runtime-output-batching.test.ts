import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { append } = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(),
  appendFileSync: append,
}));

import { OUTPUT_BATCH_MAX_BYTES, streamToOutputFile } from "../../src/workers/output-file.js";

function sessionHarness(messages: unknown[]) {
  let listener: ((event: unknown) => void) | undefined;
  const unsubscribe = vi.fn(() => { listener = undefined; });
  const session = {
    messages,
    subscribe: (next: (event: unknown) => void) => { listener = next; return unsubscribe; },
  };
  const cleanup = streamToOutputFile(session as never, "/output", "agent-1", "/work", 0);
  return { session, cleanup, unsubscribe, fire: (event: unknown) => listener?.(event) };
}

const timestamp = "2026-01-02T03:04:05.000Z";
const message = (text: string) => ({ role: "toolResult", content: [{ type: "text", text }] });
function expectedBytes(messages: { role: string }[]) {
  return messages.filter(msg => msg.role !== "system").map(msg => JSON.stringify({
    isSidechain: true,
    agentId: "agent-1",
    type: msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : "toolResult",
    message: msg,
    timestamp,
    cwd: "/work",
  }) + "\n").join("");
}
const attemptedBytes = () => append.mock.calls.map(([, data]) => data as string).join("");

beforeEach(() => {
  append.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(timestamp));
});
afterEach(() => vi.useRealTimers());

describe("bounded synchronous transcript batches", () => {
  it("preserves exact record bytes/order while reducing 200 appends to bounded chunks", () => {
    const messages = Array.from({ length: 200 }, (_, i) => message(`${i}: ${"x".repeat(16000)}`));
    const h = sessionHarness(messages);
    h.fire({ type: "turn_end" });
    expect(attemptedBytes()).toBe(expectedBytes(messages));
    expect(append.mock.calls.length).toBeLessThanOrEqual(14);
    for (const [path, data, encoding] of append.mock.calls) {
      expect([path, encoding]).toEqual(["/output", "utf-8"]);
      expect(Buffer.byteLength(data as string)).toBeLessThanOrEqual(OUTPUT_BATCH_MAX_BYTES);
    }
    const count = append.mock.calls.length;
    h.cleanup();
    h.cleanup();
    expect(append).toHaveBeenCalledTimes(count);
    expect(h.unsubscribe).toHaveBeenCalled();
  });

  it("counts UTF-8 bytes, preserves mixed roles, and isolates oversized records", () => {
    const messages = [
      { role: "system", content: "not exported" },
      { role: "user", content: "a\nb\t\"" },
      { role: "assistant", content: [{ type: "text", text: "ANSI \u001b[31m red" }] },
      ...Array.from({ length: 20 }, () => message("界☕🙂".repeat(6000))),
      message("🙂".repeat(OUTPUT_BATCH_MAX_BYTES)),
      message("tail"),
    ];
    const h = sessionHarness(messages);
    h.cleanup();
    expect(attemptedBytes()).toBe(expectedBytes(messages));
    const oversized = append.mock.calls.filter(([, data]) => Buffer.byteLength(data as string) > OUTPUT_BATCH_MAX_BYTES);
    expect(oversized).toHaveLength(1);
    expect((oversized[0][1] as string).split("\n")).toHaveLength(2); // one intact record
    expect((append.mock.lastCall![1] as string)).toContain("tail");
  });

  it("continues after a middle batch fails without rewinding or retrying potentially partial writes", () => {
    const messages = Array.from({ length: 30 }, (_, i) => message(`${i}: ${"x".repeat(32000)}`));
    const successful: string[] = [];
    let chunk = 0;
    append.mockImplementation((_path: string, data: string) => {
      if (++chunk === 2) throw new Error("partial write or ENOSPC");
      successful.push(data);
    });
    const h = sessionHarness(messages);
    expect(() => h.fire({ type: "turn_end" })).not.toThrow();
    expect(attemptedBytes()).toBe(expectedBytes(messages));
    expect(append).toHaveBeenCalledTimes(4);
    expect(successful.join("")).toBe(append.mock.calls.filter((_, i) => i !== 1).map(([, data]) => data).join(""));
    expect(successful.at(-1)).toContain("29: ");
    h.fire({ type: "turn_end" });
    expect(append).toHaveBeenCalledTimes(4);
    const tail = message("next turn");
    h.session.messages.push(tail);
    h.fire({ type: "turn_end" });
    expect(append).toHaveBeenCalledTimes(5);
    expect(append.mock.lastCall![1]).toBe(expectedBytes([tail]));
    h.cleanup();
    expect(append).toHaveBeenCalledTimes(5);
  });

  it("skips an unserializable record without losing adjacent buffered records", () => {
    const circular: { role: string; circular?: unknown } = { role: "toolResult" };
    circular.circular = circular;
    const first = message("before");
    const last = message("after");
    const h = sessionHarness([first, circular, last]);
    h.cleanup();
    expect(attemptedBytes()).toBe(expectedBytes([first, last]));
    expect(append).toHaveBeenCalledOnce();
  });

  it("preflushes before compaction and synchronously flushes the re-anchored tail", async () => {
    const first = message("before compaction");
    const h = sessionHarness([first]);
    h.fire({ type: "compaction_start" });
    expect(attemptedBytes()).toBe(expectedBytes([first]));
    h.session.messages = [{ role: "user", content: "summary" }];
    h.fire({ type: "compaction_end", aborted: false, result: {} });
    await Promise.resolve();
    const last = message("after compaction");
    h.session.messages.push(last);
    h.cleanup();
    expect(attemptedBytes()).toBe(expectedBytes([first, last]));
  });
});
