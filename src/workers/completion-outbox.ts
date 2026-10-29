/**
 * Completed results wait for the parent's next safe boundary, never for siblings.
 * turn_end is after tools and before the next model call. Failed or aborted
 * turns defer delivery until agent_settled, after Pi has cleared its queues.
 * An already idle parent can receive a completion immediately. This outbox
 * owns no timers; index.ts bounds post-summary idle checks. Result consumption
 * cancels anything still pending.
 * Optional diagnostics observe queue changes without changing delivery.
 */
import type { NotificationDetails } from "./types.js";

export interface OutboxMessage {
  content: string;
  details: NotificationDetails;
}

export interface PendingCompletions {
  count: number;
  oldestAgeMs: number;
}

export class CompletionOutbox {
  private messages: { id: string; message: OutboxMessage; queuedAt: number }[] = [];
  private disposed = false;
  private reportedPending = 0;

  constructor(
    private send: (message: OutboxMessage) => void,
    private parentRunning: () => boolean,
    private onPendingChange?: (count: number) => void,
  ) {}

  /** Monotonic age; wall-clock adjustments cannot hide a stalled completion. */
  getPendingState(): PendingCompletions {
    return {
      count: this.messages.length,
      oldestAgeMs: this.messages.length ? Math.max(0, performance.now() - this.messages[0].queuedAt) : 0,
    };
  }

  /** Capture each finished run now; a later resume cannot rewrite its result. */
  add(id: string, message: OutboxMessage): void {
    if (this.disposed) return;
    this.messages.push({ id, message, queuedAt: performance.now() });
    if (!this.parentRunning()) this.flush();
    else this.pendingChanged();
  }

  onTurnEnd(stopReason: string | undefined): void {
    if (stopReason !== "aborted" && stopReason !== "error") this.flush();
  }

  /** A deferred public-idle check after compaction, never a forced boundary. */
  onIdle(): void {
    if (!this.disposed && !this.parentRunning()) this.flush();
  }

  /** Consumption by worker ID cancels all its still-pending run snapshots. */
  cancel(id: string): void {
    this.messages = this.messages.filter(pending => pending.id !== id);
    this.pendingChanged();
  }

  /** agent_end is not final: retries and recovery can still clear Pi's queues. */
  onSettled(): void {
    this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.messages = [];
    this.pendingChanged();
  }

  /** Coalesced count observation; callers own presentation and idle checks. */
  private pendingChanged(): void {
    const count = this.messages.length;
    if (count === this.reportedPending) return;
    this.reportedPending = count;
    try { this.onPendingChange?.(count); } catch { /* isolate observation failures */ }
  }

  private flush(): void {
    const messages = this.messages.map(pending => pending.message);
    this.messages = [];
    this.pendingChanged();
    if (messages.length === 0) return;
    const [first, ...rest] = messages;
    const message = rest.length === 0 ? first : {
      content: `${messages.length} background tasks finished.\n\n${messages.map(m => m.content).join("\n\n")}`,
      details: { ...first.details, others: rest.map(m => m.details) },
    };
    try { this.send(message); } catch { /* stale extension context */ }
  }
}
