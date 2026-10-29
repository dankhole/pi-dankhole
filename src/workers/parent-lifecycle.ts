import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SUMMARY_IDLE_OBSERVATION_MS = 30_000;
export const SUMMARY_IDLE_RETRY_MS = 500;

type ParentContext = Pick<ExtensionContext, "isIdle" | "signal">;
export type IdleObservationState = "inactive" | "watching" | "expired" | "unknown";

/** One bounded observer, never a cancellation mechanism or a substitute for host idle. */
export class ParentLifecycle {
  private context: ParentContext | undefined;
  private generation = 0;
  private summaryEpoch = 0;
  private runStarted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private observation: { context: ParentContext; generation: number; deadline: number } | undefined;
  private removeSummaryAbort: (() => void) | undefined;
  private state: IdleObservationState = "inactive";

  constructor(
    private pending: () => number,
    private onIdle: () => void,
    private onSummaryAbort: () => void,
  ) {}

  bind(context: ParentContext | undefined): void {
    this.invalidate();
    this.generation++;
    this.context = context;
    this.runStarted = false;
  }

  /** Input/preparation/replacement owns its next boundary, not an earlier summary. */
  invalidate(): void {
    this.summaryEpoch++;
    this.clearTimer();
    this.observation = undefined;
    this.removeSummaryAbort?.();
    this.removeSummaryAbort = undefined;
    this.state = "inactive";
  }

  startRun(): void {
    this.invalidate();
    this.runStarted = true;
  }

  settle(): void {
    this.invalidate();
    this.runStarted = false;
  }

  beforeSummary(signal?: AbortSignal): void {
    this.invalidate();
    if (!signal || !this.context) return;
    const context = this.context;
    const generation = this.generation;
    const summaryEpoch = this.summaryEpoch;
    const aborted = () => {
      if (this.context !== context || this.generation !== generation || this.summaryEpoch !== summaryEpoch) return;
      // This observes cancellation only. The hook/provider/finalizer may still be busy.
      this.onSummaryAbort();
      this.beginObservation();
    };
    signal.addEventListener("abort", aborted, { once: true });
    this.removeSummaryAbort = () => signal.removeEventListener("abort", aborted);
    if (signal.aborted) aborted();
  }

  afterSummary(): void {
    this.summaryEpoch++;
    this.removeSummaryAbort?.();
    this.removeSummaryAbort = undefined;
    this.beginObservation();
  }

  getObservationState(): IdleObservationState {
    return this.state === "watching" && this.observation && performance.now() >= this.observation.deadline ? "expired" : this.state;
  }

  pendingChanged(): void {
    if (this.pendingCount() === 0) this.clearTimer();
    else this.schedule(0);
  }

  isPublicIdle(): boolean {
    try {
      return this.context !== undefined && !this.runStarted && this.context.signal === undefined && this.context.isIdle() === true;
    } catch {
      this.state = "unknown";
      return false;
    }
  }

  /** Explicit user check: no wait, forced boundary, timer extension, or cancellation. */
  checkNow(): boolean {
    if (!this.isPublicIdle()) return false;
    try { this.onIdle(); return true; } catch { this.state = "unknown"; return false; }
  }

  private beginObservation(): void {
    this.clearTimer();
    this.observation = undefined;
    if (!this.context || this.runStarted) return;
    this.observation = {
      context: this.context, generation: this.generation,
      deadline: performance.now() + SUMMARY_IDLE_OBSERVATION_MS,
    };
    this.state = "watching";
    this.schedule(0);
  }

  private pendingCount(): number {
    try { return this.pending(); } catch { return 0; }
  }

  private schedule(delay: number): void {
    const observation = this.observation;
    if (!observation || this.timer !== undefined || this.runStarted
      || this.context !== observation.context || this.generation !== observation.generation
      || this.pendingCount() === 0) return;
    if (performance.now() >= observation.deadline) {
      this.state = "expired";
      return;
    }
    const timer = setTimeout(() => {
      if (this.timer !== timer) return;
      this.timer = undefined;
      if (this.observation !== observation || this.context !== observation.context
        || this.generation !== observation.generation || this.pendingCount() === 0) return;
      if (performance.now() > observation.deadline) { this.state = "expired"; return; }
      try {
        // An absent low-level signal is necessary, never sufficient, for idle.
        if (this.runStarted || observation.context.signal !== undefined) {
          this.invalidate();
          return;
        }
        if (observation.context.isIdle() === true) this.onIdle();
      } catch {
        this.invalidate();
        this.state = "unknown";
        return;
      }
      const remaining = observation.deadline - performance.now();
      if (remaining > 0) this.schedule(Math.min(SUMMARY_IDLE_RETRY_MS, remaining));
      else this.state = "expired";
    }, delay);
    this.timer = timer;
    timer.unref();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
