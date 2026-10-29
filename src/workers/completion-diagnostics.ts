import type { PendingCompletions } from "./completion-outbox.js";

export const COMPLETION_WAIT_WARNING_MS = 30_000;
const WARNING_INTERVAL_MS = 60_000;

/** Only public observations, never an inferred host-internal busy cause. */
export interface ParentObservation {
  idle: boolean | undefined;
  queuedMessages: boolean | undefined;
  signal: "absent" | "active" | "aborted";
}

type Lifecycle = "session_start" | "input" | "before_agent_start" | "agent_start" | "turn_start"
  | "tool_execution_start" | "tool_execution_end" | "turn_end" | "agent_end"
  | "agent_before_settle" | "agent_settled" | "session_before_compact" | "session_compact" | "session_compact_failed" | "session_tree";
type TurnOutcome = "error" | "aborted" | "success" | "unknown";

export interface AnimationTimerCounts {
  widget: number;
  fleet: number;
  foreground: number;
}

export interface CompletionDiagnostic extends PendingCompletions, ParentObservation {
  animationTimers: AnimationTimerCounts;
  lastLifecycle: Lifecycle;
  lifecycleAgeMs: number;
  lastTurnOutcome: TurnOutcome;
}

export function describeCompletionDiagnostic(snapshot: CompletionDiagnostic): string {
  const value = (flag: boolean | undefined) => flag === undefined ? "unknown" : String(flag);
  return `Completions pending: ${snapshot.count}; oldest ${Math.floor(snapshot.oldestAgeMs / 1000)}s. `
    + `Public parent idle=${value(snapshot.idle)}, queued messages=${value(snapshot.queuedMessages)}, signal=${snapshot.signal}. `
    + `Last observed lifecycle: ${snapshot.lastLifecycle} (${Math.floor(snapshot.lifecycleAgeMs / 1000)}s ago); `
    + `last turn=${snapshot.lastTurnOutcome}. `
    + `Extension timers: widget80ms=${snapshot.animationTimers.widget}, fleet200ms=${snapshot.animationTimers.fleet}, foreground80ms=${snapshot.animationTimers.foreground}. `
    + `Host spinner not measured. Host-internal busy cause unknown; delivery uses safe boundaries.`;
}

/** One unref'ed watchdog per pending episode; no delivery, polling or model calls. */
export class CompletionDiagnostics {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private published = false;
  private warnedEpisode = false;
  private lastWarningAt = -Infinity;
  private lastLifecycle: Lifecycle = "session_start";
  private lifecycleAt = performance.now();
  private lastTurnOutcome: TurnOutcome = "unknown";

  constructor(
    private pending: () => PendingCompletions,
    private parent: () => ParentObservation,
    private publish: (snapshot: CompletionDiagnostic | undefined, notify: boolean) => void,
    private animations: () => AnimationTimerCounts = () => ({ widget: 0, fleet: 0, foreground: 0 }),
  ) {}

  observe(event: Lifecycle, stopReason?: string): void {
    if (this.disposed) return;
    this.lastLifecycle = event;
    this.lifecycleAt = performance.now();
    if (event === "turn_end") {
      this.lastTurnOutcome = stopReason === "error" || stopReason === "aborted" ? stopReason
        : stopReason === undefined ? "unknown" : "success";
    }
  }

  snapshot(): CompletionDiagnostic {
    return {
      ...this.pending(), ...this.parent(), animationTimers: this.animations(), lastLifecycle: this.lastLifecycle,
      lifecycleAgeMs: Math.max(0, performance.now() - this.lifecycleAt), lastTurnOutcome: this.lastTurnOutcome,
    };
  }

  pendingChanged(): void {
    if (this.disposed) return;
    this.clearTimer();
    const pending = this.pending();
    if (pending.count === 0) {
      this.warnedEpisode = false;
      if (this.published) this.publishSafely(undefined, false);
      this.published = false;
      return;
    }
    // Once shown, keep the count accurate even when consumption removes the
    // oldest run. Do not start another watchdog within this pending episode.
    if (this.published || pending.oldestAgeMs >= COMPLETION_WAIT_WARNING_MS) {
      this.report();
    } else {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (!this.disposed && this.pending().count > 0) this.report();
      }, COMPLETION_WAIT_WARNING_MS - pending.oldestAgeMs);
      this.timer.unref();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    if (this.published) this.publishSafely(undefined, false);
    this.published = false;
  }

  private report(): void {
    const now = performance.now();
    const notify = !this.warnedEpisode && now - this.lastWarningAt >= WARNING_INTERVAL_MS;
    this.warnedEpisode = true;
    if (notify) this.lastWarningAt = now;
    this.published = true;
    this.publishSafely(this.snapshot(), notify);
  }

  private publishSafely(snapshot: CompletionDiagnostic | undefined, notify: boolean): void {
    try { this.publish(snapshot, notify); } catch { /* Stale UI must not affect delivery or cleanup. */ }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
