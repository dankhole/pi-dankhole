/**
 * Completed results wait for the parent's next safe boundary, never for siblings.
 * turn_end is after tools and before the next model call. Failed or aborted
 * turns defer delivery until agent_settled, after Pi has cleared its queues.
 * An already idle parent can receive a completion immediately. No hold timer
 * or polling is needed; result consumption cancels anything still pending.
 */
import type { NotificationDetails } from "./types.js";

export interface OutboxMessage {
  content: string;
  details: NotificationDetails;
}

export class CompletionOutbox {
  private messages: { id: string; message: OutboxMessage }[] = [];
  private disposed = false;

  constructor(
    private send: (message: OutboxMessage) => void,
    private parentRunning: () => boolean,
  ) {}

  /** Capture each finished run now; a later resume cannot rewrite its result. */
  add(id: string, message: OutboxMessage): void {
    if (this.disposed) return;
    this.messages.push({ id, message });
    if (!this.parentRunning()) this.flush();
  }

  onTurnEnd(stopReason: string | undefined): void {
    if (stopReason !== "aborted" && stopReason !== "error") this.flush();
  }

  /** Consumption by worker ID cancels all its still-pending run snapshots. */
  cancel(id: string): void {
    this.messages = this.messages.filter(pending => pending.id !== id);
  }

  /** agent_end is not final: retries and recovery can still clear Pi's queues. */
  onSettled(): void {
    this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.messages = [];
  }

  private flush(): void {
    const messages = this.messages.map(pending => pending.message);
    this.messages = [];
    if (messages.length === 0) return;
    const [first, ...rest] = messages;
    const message = rest.length === 0 ? first : {
      content: `${messages.length} background tasks finished.\n\n${messages.map(m => m.content).join("\n\n")}`,
      details: { ...first.details, others: rest.map(m => m.details) },
    };
    try { this.send(message); } catch { /* stale extension context */ }
  }
}
