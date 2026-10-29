import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParentLifecycle, SUMMARY_IDLE_OBSERVATION_MS } from "../../src/workers/parent-lifecycle.js";

describe("bounded public parent lifecycle observation", () => {
  let idle: boolean;
  let pending: number;
  let context: { isIdle: () => boolean; signal: AbortSignal | undefined };
  let observer: ParentLifecycle;
  let onIdle: ReturnType<typeof vi.fn>;
  let onAbort: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    idle = false;
    pending = 1;
    context = { isIdle: () => idle, signal: undefined };
    onIdle = vi.fn();
    onAbort = vi.fn();
    observer = new ParentLifecycle(() => pending, onIdle, onAbort);
    observer.bind(context);
  });
  afterEach(() => { observer.bind(undefined); vi.useRealTimers(); });

  it("observes signal cancellation, not settlement, then checks public idle", () => {
    const controller = new AbortController();
    observer.beforeSummary(controller.signal);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(onAbort).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(0);
    expect(onIdle).not.toHaveBeenCalled();
    idle = true;
    onIdle.mockImplementation(() => { pending = 0; observer.pendingChanged(); });
    vi.advanceTimersByTime(500);
    expect(onIdle).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("owns one unref'ed timer and expires without forcing idle or delivery", () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    observer.afterSummary();
    expect(timer.mock.results.at(-1)!.value.hasRef()).toBe(false);
    observer.pendingChanged();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(SUMMARY_IDLE_OBSERVATION_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(observer.getObservationState()).toBe("expired");
    idle = true;
    vi.advanceTimersByTime(60_000);
    observer.pendingChanged();
    expect(onIdle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    timer.mockRestore();
  });

  it("retains the first deadline through empty queues and late arrivals", () => {
    pending = 0;
    observer.afterSummary();
    vi.advanceTimersByTime(29_000);
    pending = 1;
    observer.pendingChanged();
    vi.advanceTimersByTime(1_000);
    expect(observer.getObservationState()).toBe("expired");
    expect(vi.getTimerCount()).toBe(0);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it.each(["input", "run", "replacement", "shutdown"])("invalidates signal listeners and already-dequeued callbacks after %s", action => {
    const signal = new AbortController();
    const listen = vi.spyOn(signal.signal, "addEventListener");
    observer.beforeSummary(signal.signal);
    const staleAbort = listen.mock.calls[0][1] as () => void;
    observer.afterSummary();
    if (action === "input") observer.invalidate();
    if (action === "run") observer.startRun();
    if (action === "replacement") observer.bind(context); // Deliberately reuse the context object.
    if (action === "shutdown") observer.bind(undefined);
    idle = true;
    staleAbort();
    signal.abort();
    vi.runAllTimers();
    expect(onAbort).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it.each(["active", "aborted"])("refuses delivery with an %s low-level signal", state => {
    const controller = new AbortController();
    if (state === "aborted") controller.abort();
    context.signal = controller.signal;
    idle = true;
    observer.afterSummary();
    vi.advanceTimersByTime(0);
    expect(onIdle).not.toHaveBeenCalled();
    expect(observer.checkNow()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not treat agent_end or an absent signal as a stable run boundary", () => {
    observer.startRun();
    idle = true;
    observer.afterSummary();
    expect(observer.checkNow()).toBe(false);
    expect(onIdle).not.toHaveBeenCalled();
    observer.settle();
    expect(observer.checkNow()).toBe(true);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it.each(["signal", "isIdle"])("treats a throwing %s getter as unknown in observation and explicit checks", field => {
    Object.defineProperty(context, field, { get: () => { throw new Error("stale private content"); } });
    observer.afterSummary();
    expect(() => vi.advanceTimersByTime(0)).not.toThrow();
    expect(observer.getObservationState()).toBe("unknown");
    expect(observer.checkNow()).toBe(false);
    expect(onIdle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a deliberate public-idle check after expiry without restarting a timer", () => {
    observer.afterSummary();
    vi.advanceTimersByTime(SUMMARY_IDLE_OBSERVATION_MS);
    idle = true;
    expect(observer.checkNow()).toBe(true);
    expect(onIdle).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
