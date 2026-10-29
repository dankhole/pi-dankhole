/**
 * Timer-free safe-boundary batching. A void send means in-flight, NOT delivered.
 * Only acknowledge() after journal reconciliation with actual transcript entries.
 * Restore holds every result; explicit retry requeues without sending by itself.
 */
import { randomUUID } from "node:crypto";
import type { NotificationDetails } from "./types.js";

export interface CompletionDeliveryIdentity {
  ownerSessionId: string;
  deliveryId: string;
}

export interface OutboxMessage {
  content: string;
  details: NotificationDetails & Partial<CompletionDeliveryIdentity>;
}

export interface PendingCompletions {
  count: number;
  oldestAgeMs: number;
}

export type OutboxDeliveryState = "queued" | "inFlight" | "uncertain" | "held";
export interface OutboxEntry {
  id: string;
  deliveryId: string;
  ownerSessionId?: string;
  message: OutboxMessage;
  state: OutboxDeliveryState;
}
export interface OutboxState extends PendingCompletions {
  queued: number;
  inFlight: number;
  uncertain: number;
  held: number;
}
export interface OutboxFailure {
  kind: "idle-observation" | "attempt-observer" | "send";
  deliveryIds: readonly string[];
  error: unknown;
}
export interface CompletionOutboxOptions {
  /** Required for tracked entries to send; absent/throwing/mismatched owners fail closed. */
  getOwnerSessionId?: () => string | undefined;
  /** Journal attempt before transport. Failure is reported, never a reason to discard/block results. */
  onAttempt?: (deliveryIds: readonly string[]) => void;
  onFailure?: (failure: OutboxFailure) => void;
  /** Observes phase changes even when the unresolved count is unchanged. */
  onStateChange?: (state: OutboxState) => void;
}

type PendingEntry = OutboxEntry & { queuedAt: number; watchdogAt: number };

export class CompletionOutbox {
  private messages: PendingEntry[] = [];
  private disposed = false;
  private flushing = false;
  private reportedPending = 0;

  constructor(
    private send: (message: OutboxMessage) => void,
    private parentRunning: () => boolean,
    private onPendingChange?: (count: number) => void,
    private options: CompletionOutboxOptions = {},
  ) {}

  /** All unresolved snapshots count, including issued-but-unconfirmed transport. */
  getPendingState(): PendingCompletions {
    return {
      count: this.messages.length,
      oldestAgeMs: this.messages.length ? Math.max(0, performance.now() - this.messages[0].queuedAt) : 0,
    };
  }

  /** Only delivery-eligible snapshots age the stall watchdog; manual holds do not. */
  getWatchdogState(): PendingCompletions {
    let count = 0;
    let oldest = Infinity;
    for (const entry of this.messages) {
      if (entry.state === "held") continue;
      count++;
      oldest = Math.min(oldest, entry.watchdogAt);
    }
    return { count, oldestAgeMs: count ? Math.max(0, performance.now() - oldest) : 0 };
  }

  getState(): OutboxState {
    const count = (state: OutboxDeliveryState) => this.messages.filter(item => item.state === state).length;
    return { ...this.getPendingState(), queued: count("queued"), inFlight: count("inFlight"), uncertain: count("uncertain"), held: count("held") };
  }

  entries(): OutboxEntry[] {
    return this.messages.map(({ queuedAt: _queuedAt, watchdogAt: _watchdogAt, ...entry }) => structuredClone(entry));
  }

  /** Capture a fresh immutable run. Optional identity enables durable journal/owner fencing. */
  add(id: string, message: OutboxMessage, identity?: CompletionDeliveryIdentity): string | undefined {
    const deliveryId = this.insert(id, message, "queued", identity);
    if (deliveryId !== undefined && !this.running()) this.flush();
    return deliveryId;
  }

  /** Restore never probes idle or sends, including a known-unsent snapshot. */
  restore(id: string, message: OutboxMessage, identity: CompletionDeliveryIdentity, attempted = false): void {
    this.insert(id, message, attempted ? "uncertain" : "held", identity);
  }

  /** Explicit user recovery only. Caller still needs a normal safe idle/boundary check. */
  retry(deliveryId: string): boolean {
    if (this.disposed) return false;
    const entry = this.messages.find(item => item.deliveryId === deliveryId);
    if (!entry || entry.state === "queued") return false;
    if (entry.state === "held") entry.watchdogAt = performance.now();
    entry.state = "queued";
    this.pendingChanged();
    return true;
  }

  onTurnEnd(stopReason: string | undefined): void {
    if (stopReason !== "aborted" && stopReason !== "error") this.flush();
  }

  /** Public idle only. Scoped recovery must not release queued sibling results. */
  onIdle(deliveryId?: string): void {
    if (!this.disposed && !this.running()) this.flush(deliveryId);
  }

  /** Only IDs confirmed by journal.reconcile(actualSessionEntries) belong here. */
  acknowledge(deliveryIds: readonly string[]): void {
    const confirmed = new Set(deliveryIds);
    this.messages = this.messages.filter(item => !confirmed.has(item.deliveryId));
    this.pendingChanged();
  }

  /** Consumption by worker ID cancels every held/queued/in-flight run, not future runs. */
  cancel(id: string): void {
    this.messages = this.messages.filter(item => item.id !== id);
    this.pendingChanged();
  }

  /** Explicit observation of an unconfirmed transport failure; never auto-retries. */
  markUncertain(deliveryIds: readonly string[]): void {
    const ids = new Set(deliveryIds);
    for (const entry of this.messages) if (ids.has(entry.deliveryId) && entry.state === "inFlight") entry.state = "uncertain";
    this.pendingChanged();
  }

  /** agent_end is not final. Aborted settlement must not start a notification run. */
  onSettled(aborted = false): void {
    this.markUncertain(this.messages.filter(item => item.state === "inFlight").map(item => item.deliveryId));
    if (!aborted) this.flush();
  }

  /** Journal owns restart recovery. Disposal clears activation-bound UI/state only. */
  dispose(): void {
    this.disposed = true;
    this.messages = [];
    this.pendingChanged();
  }

  private insert(id: string, message: OutboxMessage, state: OutboxDeliveryState, identity?: CompletionDeliveryIdentity): string | undefined {
    if (this.disposed) return undefined;
    const deliveryId = identity?.deliveryId ?? randomUUID();
    if (this.messages.some(item => item.deliveryId === deliveryId)) return deliveryId;
    const now = performance.now();
    this.messages.push({ id, deliveryId, ownerSessionId: identity?.ownerSessionId, message: structuredClone(message), state, queuedAt: now, watchdogAt: now });
    // Notify BEFORE the idle probe: stale public getters must not hide pending work.
    this.pendingChanged();
    return deliveryId;
  }

  private running(): boolean {
    try { return this.parentRunning(); }
    catch (error) { this.failure({ kind: "idle-observation", deliveryIds: [], error }); return true; }
  }

  private owned(entry: PendingEntry): boolean {
    if (entry.ownerSessionId === undefined) return true;
    try { return entry.ownerSessionId === this.options.getOwnerSessionId?.(); }
    catch { return false; }
  }

  private pendingChanged(): void {
    const count = this.messages.length;
    if (count !== this.reportedPending) {
      this.reportedPending = count;
      try { this.onPendingChange?.(count); } catch { /* isolate observation failures */ }
    }
    try { this.options.onStateChange?.(this.getState()); } catch { /* isolate observation failures */ }
  }

  private failure(failure: OutboxFailure): void {
    try { this.options.onFailure?.(failure); } catch { /* a stale observer cannot discard results */ }
  }

  private flush(deliveryId?: string): void {
    if (this.disposed || this.flushing) return;
    const batch = this.messages.filter(entry => entry.state === "queued"
      && (deliveryId === undefined || entry.deliveryId === deliveryId) && this.owned(entry));
    if (batch.length === 0) return;
    this.flushing = true;
    try {
      for (const entry of batch) entry.state = "inFlight";
      this.pendingChanged();
      const ids = batch.map(entry => entry.deliveryId);
      try { this.options.onAttempt?.(ids); }
      catch (error) { this.failure({ kind: "attempt-observer", deliveryIds: ids, error }); }
      // Attempt observers may synchronously consume a result or replace a session.
      const retained = batch.filter(entry => this.messages.includes(entry) && entry.state === "inFlight");
      const ready = retained.filter(entry => this.owned(entry));
      for (const entry of retained) if (!ready.includes(entry)) entry.state = "held";
      if (ready.length === 0 || this.disposed) return;
      const messages = ready.map(entry => structuredClone(entry.message));
      const [first, ...rest] = messages;
      const message = rest.length === 0 ? first : {
        content: `${messages.length} background tasks finished.\n\n${messages.map(item => item.content).join("\n\n")}`,
        details: { ...first.details, others: rest.map(item => item.details) },
      };
      try { this.send(message); }
      catch (error) {
        // The transport may have performed a side effect before throwing. Keep
        // the exact snapshot as uncertain; another boundary must NOT resend it.
        for (const entry of ready) if (this.messages.includes(entry) && entry.state === "inFlight") entry.state = "uncertain";
        this.failure({ kind: "send", deliveryIds: ready.map(entry => entry.deliveryId), error });
      }
    } finally {
      this.flushing = false;
      this.pendingChanged();
    }
  }
}
