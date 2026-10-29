import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PendingCompletions } from "./completion-outbox.js";
import type { IdleObservationState } from "./parent-lifecycle.js";

export const COMPLETION_WAIT_WARNING_MS = 30_000;
const WARNING_INTERVAL_MS = 60_000;

/** Only public observations, never an inferred host-internal busy cause. */
export interface ParentObservation {
  idle: boolean | undefined;
  queuedMessages: boolean | undefined;
  signal: "absent" | "active" | "aborted" | "unknown";
  idleObservation?: IdleObservationState;
  deliveryState?: string;
}

/** Each public getter is independent; stale contexts must never crash a watchdog. */
export function observePublicParent(context: ExtensionContext | undefined): ParentObservation {
  const observation: ParentObservation = { idle: undefined, queuedMessages: undefined, signal: "unknown" };
  if (!context) return observation;
  try { observation.idle = context.isIdle(); } catch { /* unknown, not idle */ }
  try { observation.queuedMessages = context.hasPendingMessages(); } catch { /* unknown */ }
  try {
    const signal = context.signal;
    observation.signal = signal ? signal.aborted ? "aborted" : "active" : "absent";
  } catch { /* unknown, not absent */ }
  return observation;
}

type Lifecycle = "session_start" | "input" | "before_agent_start" | "agent_start" | "turn_start"
  | "tool_execution_start" | "tool_execution_end" | "turn_end" | "agent_end"
  | "agent_before_settle" | "agent_settled" | "session_before_compact" | "session_compact" | "session_compact_failed" | "session_before_tree" | "session_tree"
  | "summary_abort" | "before_provider_request" | "after_provider_response";
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
  observedPhase: string;
  unavailableObservations: string[];
}

const phases: Partial<Record<Lifecycle, string>> = {
  session_start: "session started", input: "input preparation", before_agent_start: "run preparation",
  agent_start: "run started", turn_start: "turn started", tool_execution_start: "tool execution",
  tool_execution_end: "tool execution ended", before_provider_request: "provider request", after_provider_response: "provider response",
  agent_end: "run ended (not settled)", agent_before_settle: "settlement preparation", agent_settled: "run settled",
  session_before_compact: "compaction hook", session_before_tree: "tree navigation hook",
  session_compact: "summary event (awaiting public idle)", session_tree: "tree event (awaiting public idle)",
  session_compact_failed: "compaction failure event (awaiting public idle)", summary_abort: "summary cancellation observed (not settled)",
};

export function describeCompletionDiagnostic(snapshot: CompletionDiagnostic): string {
  const value = (flag: boolean | undefined) => flag === undefined ? "unknown" : String(flag);
  return `Completions pending: ${snapshot.count}; oldest ${Math.floor(snapshot.oldestAgeMs / 1000)}s. `
    + `Public parent idle=${value(snapshot.idle)}, queued messages=${value(snapshot.queuedMessages)}, signal=${snapshot.signal}. `
    + `Last observed lifecycle: ${snapshot.lastLifecycle} (${Math.floor(snapshot.lifecycleAgeMs / 1000)}s ago); `
    + `Observed phase: ${snapshot.observedPhase}; idle observation=${snapshot.idleObservation ?? "inactive"}; last turn=${snapshot.lastTurnOutcome}. `
    + (snapshot.deliveryState ? `Delivery: ${snapshot.deliveryState}. ` : "")
    + (snapshot.unavailableObservations.length ? `Unavailable observations: ${snapshot.unavailableObservations.join(", ")}. ` : "")
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
    private watchdogPending: () => PendingCompletions = pending,
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
    const unavailableObservations: string[] = [];
    let pending: PendingCompletions = { count: 0, oldestAgeMs: 0 };
    let parent: ParentObservation = { idle: undefined, queuedMessages: undefined, signal: "unknown" };
    let animationTimers: AnimationTimerCounts = { widget: 0, fleet: 0, foreground: 0 };
    try { pending = this.pending(); } catch { unavailableObservations.push("pending"); }
    try { parent = this.parent(); } catch { unavailableObservations.push("parent"); }
    try { animationTimers = this.animations(); } catch { unavailableObservations.push("animations"); }
    return {
      ...pending, ...parent, animationTimers, lastLifecycle: this.lastLifecycle,
      lifecycleAgeMs: Math.max(0, performance.now() - this.lifecycleAt), lastTurnOutcome: this.lastTurnOutcome,
      observedPhase: phases[this.lastLifecycle] ?? "turn ended", unavailableObservations,
    };
  }

  pendingChanged(): void {
    if (this.disposed) return;
    this.clearTimer();
    let pending: PendingCompletions;
    try { pending = this.pending(); } catch { return; }
    if (pending.count === 0) {
      this.warnedEpisode = false;
      if (this.published) this.publishSafely(undefined, false);
      this.published = false;
      return;
    }
    let watchdog: PendingCompletions;
    try { watchdog = this.watchdogPending(); } catch { return; }
    if (watchdog.count === 0) {
      // Manual holds do not age the delivery watchdog. snapshot() still
      // includes their unresolved count and full age.
      if (this.published) this.publishSafely(this.snapshot(), false);
      this.published = false;
      this.warnedEpisode = false;
      return;
    }
    // Once shown, keep the count accurate even when consumption removes the
    // oldest run. Do not start another watchdog within this pending episode.
    if (this.published || watchdog.oldestAgeMs >= COMPLETION_WAIT_WARNING_MS) {
      this.report();
    } else {
      const timer = setTimeout(() => {
        if (this.timer !== timer) return;
        this.timer = undefined;
        this.pendingChanged(); // Recheck eligible count and age before reporting.
      }, COMPLETION_WAIT_WARNING_MS - watchdog.oldestAgeMs);
      this.timer = timer;
      timer.unref();
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
