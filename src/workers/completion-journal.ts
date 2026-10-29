/**
 * Session-wide execution ledger, not branch-relative conversational state.
 *
 * capture() precedes lifecycle emission; attempt() precedes the external send.
 * A public void send is never an acknowledgement. Only reconcile() finding an
 * actual custom_message entry establishes delivery. Restore NEVER sends.
 *
 * Pi 1.4 appendEntry mutates its tree before writing. Failed appends therefore
 * keep our in-memory snapshot/state and report degraded durability; they do not
 * block delivery or masquerade as disk commits. Session persistence has no
 * fsync/transaction guarantee, and custom entries before the first conversation
 * message may remain in memory. No session file is rewritten by this helper.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CompletionDeliveryIdentity, OutboxMessage } from "./completion-outbox.js";
import type { AgentInvocation, AgentRecord } from "./types.js";
import type { LifetimeUsage } from "./usage.js";

export const COMPLETION_JOURNAL_TYPE = "subagents:completion";
export const COMPLETION_JOURNAL_VERSION = 1;

/** Plain terminal data only. Restoring a result does not restore execution authority. */
export interface CompletionResult {
  id: string;
  description: string;
  status: Exclude<AgentRecord["status"], "running" | "queued">;
  result?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  toolUses: number;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  outputFile?: string;
  sessionFile?: string;
  invocation?: AgentInvocation;
}

export interface CompletionSnapshot extends CompletionDeliveryIdentity {
  workerId: string;
  originLeafId: string | null;
  capturedAt: number;
  message: OutboxMessage;
  record: CompletionResult;
}

export type CompletionResolution = "consumed" | "dismissed";
export type CompletionState = "pending" | "uncertain" | "delivered" | CompletionResolution;
export type CompletionJournalEvent =
  | { version: 1; type: "captured"; snapshot: CompletionSnapshot }
  | { version: 1; type: "attempted"; ownerSessionId: string; deliveryId: string; at: number }
  | { version: 1; type: "resolved"; ownerSessionId: string; deliveryId: string; at: number; resolution: CompletionResolution };

export interface JournalCompletion {
  snapshot: CompletionSnapshot;
  state: CompletionState;
  attempted: boolean;
  resolution?: CompletionResolution;
  receiptEntryId?: string;
}

export interface CompletionRecoverySummary {
  pending: number;
  uncertain: number;
  delivered: number;
  consumed: number;
  dismissed: number;
  invalidEntries: number;
  foreignEntries: number;
  legacyRecords: number;
  durabilityDegraded: boolean;
}

export interface CompletionJournalWarning {
  kind: "write-failed" | "memory-only" | "invalid-entry";
  message: string;
}

export interface CompletionJournalOptions {
  /** False for an ephemeral host session. Undefined means persistence is unverified. */
  persisted?: boolean;
  onWarning?: (warning: CompletionJournalWarning) => void;
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const optionalText = (value: unknown): boolean => value === undefined || typeof value === "string";
const terminal = new Set(["completed", "steered", "aborted", "stopped", "error"]);

function validInvocation(value: unknown): boolean {
  if (!object(value)) return false;
  return [value.modelName, value.modelId, value.thinking, value.requestedThinking, value.requestedModel].every(optionalText)
    && [value.isolated, value.inheritContext, value.runInBackground].every(item => item === undefined || typeof item === "boolean")
    && (value.maxTurns === undefined || nonnegative(value.maxTurns))
    && (value.isolation === undefined || value.isolation === "off" || value.isolation === "worktree");
}

function validDetails(value: unknown): boolean {
  return object(value) && text(value.id) && typeof value.description === "string" && typeof value.status === "string" && terminal.has(value.status)
    && nonnegative(value.toolUses) && nonnegative(value.turnCount) && nonnegative(value.totalTokens)
    && finite(value.durationMs) && typeof value.resultPreview === "string"
    && [value.outputFile, value.error].every(optionalText)
    && (value.totalCost === undefined || nonnegative(value.totalCost))
    && (value.maxTurns === undefined || nonnegative(value.maxTurns))
    && (value.invocation === undefined || validInvocation(value.invocation))
    && (value.others === undefined || (Array.isArray(value.others) && value.others.every(item => object(item) && item.others === undefined && validDetails(item))));
}

function validResult(value: unknown): value is CompletionResult {
  if (!object(value) || !text(value.id) || typeof value.description !== "string" || typeof value.status !== "string" || !terminal.has(value.status)
    || !finite(value.startedAt) || (value.completedAt !== undefined && !finite(value.completedAt))
    || !nonnegative(value.toolUses) || !nonnegative(value.compactionCount)
    || ![value.result, value.error, value.outputFile, value.sessionFile].every(optionalText) || !object(value.lifetimeUsage)) return false;
  const usage = value.lifetimeUsage;
  return [usage.input, usage.output, usage.cacheWrite].every(nonnegative)
    && (usage.cost === undefined || nonnegative(usage.cost))
    && (usage.cacheRead === undefined || nonnegative(usage.cacheRead))
    && (value.invocation === undefined || validInvocation(value.invocation));
}

function validSnapshot(value: unknown, owner: string): value is CompletionSnapshot {
  if (!object(value) || value.ownerSessionId !== owner || !text(value.deliveryId) || !text(value.workerId)
    || !(value.originLeafId === null || text(value.originLeafId)) || !finite(value.capturedAt)
    || !validResult(value.record) || value.record.id !== value.workerId || !object(value.message)
    || typeof value.message.content !== "string" || !validDetails(value.message.details)) return false;
  const details = value.message.details as ObjectValue;
  return details.id === value.workerId && details.ownerSessionId === owner && details.deliveryId === value.deliveryId
    && details.status === value.record.status && details.description === value.record.description && details.others === undefined;
}

/** Project explicitly: structural typing must not serialize a live AgentRecord's session/config. */
function copyResult(record: CompletionResult): CompletionResult {
  const { id, description, status, result, error, startedAt, completedAt, toolUses, lifetimeUsage,
    compactionCount, outputFile, sessionFile, invocation } = record;
  return { id, description, status, result, error, startedAt, completedAt, toolUses, lifetimeUsage,
    compactionCount, outputFile, sessionFile, invocation };
}

/** JSON persistence drops undefined properties; compare stored values, not object identity. */
function sameStoredValue(actual: unknown, expected: unknown): boolean {
  try { return isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected))); }
  catch { return false; }
}

function sameDetails(actual: ObjectValue, expected: OutboxMessage["details"]): boolean {
  const { others: _others, ...single } = actual;
  return sameStoredValue(single, expected);
}

export class CompletionJournal {
  private completions = new Map<string, JournalCompletion>();
  private degraded = false;
  private warned = new Set<CompletionJournalWarning["kind"]>();
  private invalidEntries = 0;
  private foreignEntries = 0;
  private legacyRecords = 0;

  constructor(
    readonly ownerSessionId: string,
    private append: (customType: string, data: CompletionJournalEvent) => void,
    private options: CompletionJournalOptions = {},
  ) {
    if (!ownerSessionId) throw new Error("Completion journal requires a parent session ID");
  }

  /** Caller may pass a launch-pinned run UUID. Otherwise each capture gets a fresh UUID. */
  capture(record: CompletionResult, message: OutboxMessage, originLeafId: string | null, deliveryId: string = randomUUID()): CompletionSnapshot {
    const snapshot = structuredClone({
      deliveryId, ownerSessionId: this.ownerSessionId, workerId: record.id, originLeafId,
      capturedAt: Date.now(), record: copyResult(record), message,
    });
    snapshot.message.details = { ...snapshot.message.details, deliveryId, ownerSessionId: this.ownerSessionId };
    if (!validSnapshot(snapshot, this.ownerSessionId)) throw new Error("Invalid terminal completion snapshot");
    const existing = this.completions.get(deliveryId);
    if (existing) {
      if (!sameStoredValue(existing.snapshot.record, snapshot.record) || !sameStoredValue(existing.snapshot.message, snapshot.message)) {
        throw new Error("Completion delivery ID already belongs to another snapshot");
      }
      return structuredClone(existing.snapshot);
    }
    this.completions.set(deliveryId, { snapshot, state: "pending", attempted: false });
    this.persist({ version: 1, type: "captured", snapshot });
    return structuredClone(snapshot);
  }

  /** Keep attempted=true even if persistence fails: the send may still happen. */
  attempt(deliveryIds: readonly string[]): void {
    for (const id of new Set(deliveryIds)) {
      const completion = this.completions.get(id);
      if (!completion || completion.resolution || completion.receiptEntryId) continue;
      completion.attempted = true;
      completion.state = "uncertain";
      this.persist({ version: 1, type: "attempted", ownerSessionId: this.ownerSessionId, deliveryId: id, at: Date.now() });
    }
  }

  resolve(deliveryIds: readonly string[], resolution: CompletionResolution): number {
    let count = 0;
    for (const id of new Set(deliveryIds)) {
      const completion = this.completions.get(id);
      if (!completion || completion.resolution === resolution) continue;
      completion.resolution = resolution;
      completion.state = resolution;
      this.persist({ version: 1, type: "resolved", ownerSessionId: this.ownerSessionId, deliveryId: id, at: Date.now(), resolution });
      count++;
    }
    return count;
  }

  consumeWorker(workerId: string): number {
    return this.resolve([...this.completions.values()].filter(item => item.snapshot.workerId === workerId).map(item => item.snapshot.deliveryId), "consumed");
  }

  get(deliveryId: string): JournalCompletion | undefined {
    const completion = this.completions.get(deliveryId);
    return completion ? structuredClone(completion) : undefined;
  }

  getLatestResult(workerId: string): CompletionResult | undefined {
    const completion = [...this.completions.values()].reverse().find(item => item.snapshot.workerId === workerId);
    return completion ? structuredClone(completion.snapshot.record) : undefined;
  }

  list(): JournalCompletion[] { return structuredClone([...this.completions.values()]); }

  summary(): CompletionRecoverySummary {
    const states = [...this.completions.values()].map(item => item.state);
    return {
      pending: states.filter(state => state === "pending").length,
      uncertain: states.filter(state => state === "uncertain").length,
      delivered: states.filter(state => state === "delivered").length,
      consumed: states.filter(state => state === "consumed").length,
      dismissed: states.filter(state => state === "dismissed").length,
      invalidEntries: this.invalidEntries, foreignEntries: this.foreignEntries, legacyRecords: this.legacyRecords,
      durabilityDegraded: this.degraded || this.options.persisted !== true,
    };
  }

  /** Session-wide scan at startup only. Never enqueue, send, or append during restore. */
  restore(entries: readonly unknown[]): CompletionRecoverySummary {
    this.completions.clear();
    this.invalidEntries = this.foreignEntries = this.legacyRecords = 0;
    for (const entry of entries) {
      if (!object(entry) || entry.type !== "custom") continue;
      if (entry.customType === "subagents:record") { this.legacyRecords++; continue; }
      if (entry.customType !== COMPLETION_JOURNAL_TYPE) continue;
      const data = entry.data;
      if (!object(data)) { this.invalid(); continue; }
      const owner = data.type === "captured" && object(data.snapshot) ? data.snapshot.ownerSessionId : data.ownerSessionId;
      if (text(owner) && owner !== this.ownerSessionId) { this.foreignEntries++; continue; }
      if (data.version !== COMPLETION_JOURNAL_VERSION || owner !== this.ownerSessionId) { this.invalid(); continue; }
      if (data.type === "captured") {
        if (!validSnapshot(data.snapshot, this.ownerSessionId)) { this.invalid(); continue; }
        const prior = this.completions.get(data.snapshot.deliveryId);
        if (prior) {
          if (!sameStoredValue(prior.snapshot, data.snapshot)) this.invalid();
          continue;
        }
        const snapshot = structuredClone({ ...data.snapshot, record: copyResult(data.snapshot.record) });
        this.completions.set(snapshot.deliveryId, { snapshot, state: "pending", attempted: false });
        continue;
      }
      if (!text(data.deliveryId) || !finite(data.at)) { this.invalid(); continue; }
      const completion = this.completions.get(data.deliveryId);
      if (!completion) { this.invalid(); continue; }
      if (data.type === "attempted") {
        completion.attempted = true;
        if (!completion.resolution) completion.state = "uncertain";
      } else if (data.type === "resolved" && (data.resolution === "consumed" || data.resolution === "dismissed")) {
        completion.resolution = data.resolution;
        completion.state = data.resolution;
      } else this.invalid();
    }
    // An unsupported/malformed transition could have acknowledged any prior
    // run. Do not describe those snapshots as known-unsent. Recovery is always
    // explicit, and the warning must accompany any deliberate resend.
    if (this.invalidEntries > 0) {
      for (const completion of this.completions.values()) if (completion.state === "pending") completion.state = "uncertain";
    }
    this.reconcile(entries);
    return this.summary();
  }

  /**
   * Only actual custom_message entries count, never message_end payloads or a
   * proposed delivery marker. Validate the complete coalesced payload, including
   * ownership, worker/run identity, details and content. Resolved results remain
   * retrievable and retain their explicit resolution even if delivered later.
   */
  reconcile(entries: readonly unknown[]): string[] {
    const confirmed = new Set<string>();
    for (const entry of entries) {
      if (!object(entry) || entry.type !== "custom_message" || entry.customType !== "subagent-notification"
        || !text(entry.id) || !object(entry.details) || !validDetails(entry.details)) continue;
      const details = entry.details;
      const members = [details, ...(Array.isArray(details.others) ? details.others : [])];
      const batch: JournalCompletion[] = [];
      for (const member of members) {
        if (!object(member) || member.ownerSessionId !== this.ownerSessionId || !text(member.deliveryId)) break;
        const completion = this.completions.get(member.deliveryId);
        if (!completion || completion.snapshot.workerId !== member.id || !sameDetails(member, completion.snapshot.message.details)
          || batch.includes(completion)) break;
        batch.push(completion);
      }
      if (batch.length !== members.length) continue;
      const expectedContent = batch.length === 1 ? batch[0].snapshot.message.content
        : `${batch.length} background tasks finished.\n\n${batch.map(item => item.snapshot.message.content).join("\n\n")}`;
      if (entry.content !== expectedContent) continue;
      for (const completion of batch) {
        completion.receiptEntryId = entry.id;
        if (!completion.resolution) completion.state = "delivered";
        confirmed.add(completion.snapshot.deliveryId);
      }
    }
    return [...confirmed];
  }

  private invalid(): void {
    this.invalidEntries++;
    this.warn("invalid-entry", "Some completion recovery entries are malformed or unsupported; they were not replayed.");
  }

  private persist(event: CompletionJournalEvent): void {
    if (this.options.persisted !== true) {
      this.warn("memory-only", "Completion restart recovery is unverified or unavailable for this session; custom entries may remain in memory until the session is flushed.");
    }
    try { this.append(COMPLETION_JOURNAL_TYPE, structuredClone(event)); }
    catch {
      this.degraded = true;
      this.warn("write-failed", "Completion journal write failed; results remain available in memory, but restart recovery is degraded.");
    }
  }

  private warn(kind: CompletionJournalWarning["kind"], message: string): void {
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    try { this.options.onWarning?.({ kind, message }); } catch { /* observation cannot discard a result */ }
  }
}
