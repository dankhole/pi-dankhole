import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPLETION_JOURNAL_TYPE, CompletionJournal, type CompletionJournalEvent, type CompletionResult, type CompletionSnapshot } from "../../src/workers/completion-journal.js";
import { CompletionOutbox, type OutboxMessage } from "../../src/workers/completion-outbox.js";

const owner = "owner-session";
function result(id = "worker", text = "Full result"): CompletionResult {
  return {
    id, description: `Task ${id}`, status: "completed", result: text,
    startedAt: 1, completedAt: 20, toolUses: 0, compactionCount: 0,
    lifetimeUsage: { input: 10, output: 5, cacheWrite: 0 },
    outputFile: "/tmp/may-disappear.output",
  };
}
function message(id = "worker"): OutboxMessage {
  return { content: `Result for ${id}`, details: {
    id, description: `Task ${id}`, status: "completed", toolUses: 0, turnCount: 1,
    totalTokens: 15, durationMs: 19, resultPreview: "Preview", invocation: { modelName: undefined, thinking: "high" },
  } };
}
function entry(data: unknown, id = "journal-entry") {
  return { type: "custom", customType: COMPLETION_JOURNAL_TYPE, id, data };
}
function receipt(snapshots: CompletionSnapshot[], overrides: Record<string, unknown> = {}) {
  const [first, ...rest] = snapshots;
  return {
    type: "custom_message", id: "persisted-notification", customType: "subagent-notification", display: true,
    content: rest.length ? `${snapshots.length} background tasks finished.\n\n${snapshots.map(snapshot => snapshot.message.content).join("\n\n")}` : first.message.content,
    details: rest.length ? { ...first.message.details, others: rest.map(snapshot => snapshot.message.details) } : first.message.details,
    ...overrides,
  };
}
function ledger() {
  const entries: unknown[] = [];
  const append = vi.fn((customType: string, data: CompletionJournalEvent) => {
    entries.push({ type: "custom", customType, id: `e-${entries.length}`, data: JSON.parse(JSON.stringify(data)) });
  });
  const warning = vi.fn();
  const journal = new CompletionJournal(owner, append, { persisted: true, onWarning: warning });
  return { entries, append, warning, journal };
}
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("completion session journal", () => {
  it("captures immutable full results with independent UUIDs for every run of one worker", () => {
    const b = ledger();
    const record = result();
    const notification = message();
    const first = b.journal.capture(record, notification, "launch-leaf");
    const second = b.journal.capture(result("worker", "Continuation result"), message(), "resume-leaf");
    expect(first.deliveryId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/);
    expect(second.deliveryId).not.toBe(first.deliveryId);
    expect(first.message.details).toMatchObject({ deliveryId: first.deliveryId, ownerSessionId: owner });
    record.result = "mutated source";
    notification.details.description = "mutated source";
    first.record.result = "mutated return";
    first.message.content = "mutated return";
    b.journal.list()[0].snapshot.record.result = "mutated list";
    expect(b.journal.get(first.deliveryId)?.snapshot).toMatchObject({ record: { result: "Full result" }, message: { content: "Result for worker" } });
    expect(b.journal.getLatestResult("worker")?.result).toBe("Continuation result");
    expect(b.journal.getLatestResult("missing")).toBeUndefined();
    expect(b.append).toHaveBeenCalledTimes(2);
  });

  it("projects only terminal data even when structural inputs include live session/config properties", () => {
    const b = ledger();
    const live = Object.assign(result(), { session: { dispose: () => {} }, config: { instructions: "must not persist" } });
    const snapshot = b.journal.capture(live, message(), null);
    expect(snapshot.record).not.toHaveProperty("session");
    expect(snapshot.record).not.toHaveProperty("config");
    expect(JSON.stringify(b.entries)).not.toContain("must not persist");
  });

  it("restores known pending, attempted, consumed and dismissed runs without any writes or replay", () => {
    const b = ledger();
    const snapshots = ["pending", "uncertain", "consumed", "dismissed"].map(id => b.journal.capture(result(id), message(id), null));
    b.journal.attempt([snapshots[1].deliveryId]);
    b.journal.consumeWorker("consumed");
    b.journal.resolve([snapshots[3].deliveryId], "dismissed");
    const append = vi.fn();
    const restored = new CompletionJournal(owner, append, { persisted: true });
    expect(restored.restore(b.entries)).toMatchObject({ pending: 1, uncertain: 1, consumed: 1, dismissed: 1, delivered: 0 });
    expect(append).not.toHaveBeenCalled();
    expect(restored.getLatestResult("consumed")?.result).toBe("Full result");
    const send = vi.fn();
    const outbox = new CompletionOutbox(send, () => false, undefined, { getOwnerSessionId: () => owner });
    for (const item of restored.list()) {
      if (item.state === "pending" || item.state === "uncertain") {
        outbox.restore(item.snapshot.workerId, item.snapshot.message, item.snapshot, item.state === "uncertain");
      }
    }
    outbox.onIdle();
    outbox.onTurnEnd("toolUse");
    outbox.onSettled();
    expect(send).not.toHaveBeenCalled();
    expect(outbox.getState()).toMatchObject({ held: 1, uncertain: 1, count: 2 });
    outbox.dispose();
  });

  it("derives delivered only from actual matching persisted custom_message evidence", () => {
    const b = ledger();
    const snapshot = b.journal.capture(result(), message(), null);
    b.journal.attempt([snapshot.deliveryId]);
    const writes = b.append.mock.calls.length;
    expect(b.journal.reconcile([{ type: "message_end", message: { role: "custom", ...receipt([snapshot]) } }])).toEqual([]);
    expect(b.journal.get(snapshot.deliveryId)?.state).toBe("uncertain");
    const saved = JSON.parse(JSON.stringify(receipt([snapshot])));
    expect(b.journal.reconcile([saved])).toEqual([snapshot.deliveryId]);
    expect(b.journal.get(snapshot.deliveryId)).toMatchObject({ state: "delivered", receiptEntryId: "persisted-notification" });
    expect(b.append).toHaveBeenCalledTimes(writes); // No separate delivered marker.
    const restored = new CompletionJournal(owner, vi.fn(), { persisted: true });
    expect(restored.restore([...b.entries, saved])).toMatchObject({ delivered: 1, uncertain: 0 });
  });

  it("confirms every coalesced member and preserves explicit consumption if a message arrives afterward", () => {
    const b = ledger();
    const snapshots = ["a", "b"].map(id => b.journal.capture(result(id), message(id), null));
    b.journal.attempt(snapshots.map(snapshot => snapshot.deliveryId));
    expect(b.journal.consumeWorker("b")).toBe(1);
    expect(b.journal.reconcile([receipt(snapshots)])).toEqual(snapshots.map(snapshot => snapshot.deliveryId));
    expect(b.journal.get(snapshots[0].deliveryId)?.state).toBe("delivered");
    expect(b.journal.get(snapshots[1].deliveryId)).toMatchObject({ state: "consumed", receiptEntryId: "persisted-notification" });
    expect(b.journal.getLatestResult("b")?.result).toBe("Full result");
  });

  it.each(["role", "owner", "worker", "run", "details", "content", "duplicate", "nested", "foreign-sibling"])("rejects a fake or malformed %s receipt", kind => {
    const b = ledger();
    const snapshots = ["a", "b"].map(id => b.journal.capture(result(id), message(id), null));
    const saved = structuredClone(receipt(snapshots));
    if (kind === "role") saved.type = "message";
    if (kind === "owner") saved.details.ownerSessionId = "foreign";
    if (kind === "worker") saved.details.id = "wrong-worker";
    if (kind === "run") saved.details.deliveryId = "wrong-run";
    if (kind === "details") saved.details.resultPreview = "different result";
    if (kind === "content") saved.content = "unrelated message";
    if (kind === "duplicate") saved.details.others = [snapshots[0].message.details];
    if (kind === "nested") saved.details.others = [{ ...snapshots[1].message.details, others: [] }];
    if (kind === "foreign-sibling") saved.details.others = [{ ...snapshots[1].message.details, ownerSessionId: "foreign" }];
    expect(b.journal.reconcile([saved])).toEqual([]);
    expect(b.journal.summary().delivered).toBe(0);
  });

  it("uses session-wide history without replaying parent ledger entries in a fork or clone", () => {
    const b = ledger();
    const snapshot = b.journal.capture(result(), message(), "abandoned-branch");
    b.journal.consumeWorker("worker");
    const restored = new CompletionJournal(owner, vi.fn(), { persisted: true });
    // A receipt on an earlier branch is still delivery evidence, not current
    // conversational context. Explicit consumption cannot be rewound by /tree.
    expect(restored.restore([...b.entries, receipt([snapshot])])).toMatchObject({ consumed: 1 });
    const clone = new CompletionJournal("new-session-header", vi.fn(), { persisted: true });
    expect(clone.restore([...b.entries, receipt([snapshot])])).toMatchObject({ pending: 0, delivered: 0, consumed: 0, foreignEntries: 2 });
    expect(clone.getLatestResult("worker")).toBeUndefined();
  });

  it("keeps memory after Pi-style mutate-before-disk-write failure and reports degraded recovery", () => {
    const memory: unknown[] = [];
    const disk: unknown[] = [];
    const warning = vi.fn(() => { throw new Error("stale warning UI"); });
    const journal = new CompletionJournal(owner, (customType, data) => {
      memory.push({ type: "custom", customType, data });
      throw new Error("disk failed after session mutation");
    }, { persisted: true, onWarning: warning });
    const snapshot = journal.capture(result(), message(), null);
    expect(() => journal.attempt([snapshot.deliveryId])).not.toThrow();
    expect(() => journal.consumeWorker("worker")).not.toThrow();
    expect(journal.get(snapshot.deliveryId)).toMatchObject({ state: "consumed", attempted: true });
    expect(journal.getLatestResult("worker")?.result).toBe("Full result");
    expect(journal.summary().durabilityDegraded).toBe(true);
    expect(warning).toHaveBeenCalledOnce();
    expect(memory).toHaveLength(3);
    const restarted = new CompletionJournal(owner, vi.fn(), { persisted: true });
    expect(restarted.restore(disk)).toMatchObject({ pending: 0, consumed: 0 });
    expect(restarted.getLatestResult("worker")).toBeUndefined();
  });

  it("keeps delivery available when both capture and attempt journal writes fail", () => {
    const warning = vi.fn();
    const journal = new CompletionJournal(owner, () => { throw new Error("disk unavailable"); }, { persisted: true, onWarning: warning });
    const snapshot = journal.capture(result(), message(), null);
    const send = vi.fn();
    const outbox = new CompletionOutbox(send, () => false, undefined, { getOwnerSessionId: () => owner, onAttempt: ids => journal.attempt(ids) });
    outbox.add(snapshot.workerId, snapshot.message, snapshot);
    expect(send).toHaveBeenCalledExactlyOnceWith(snapshot.message);
    expect(outbox.getState()).toMatchObject({ inFlight: 1, count: 1 });
    expect(journal.get(snapshot.deliveryId)?.state).toBe("uncertain");
    expect(journal.getLatestResult("worker")?.result).toBe("Full result");
    expect(warning).toHaveBeenCalledOnce();
    outbox.dispose();
  });

  it("does not let append observers mutate the retained snapshot", () => {
    const journal = new CompletionJournal(owner, (_customType, data) => {
      if (data.type === "captured") data.snapshot.record.result = "mutated append argument";
    }, { persisted: true });
    const snapshot = journal.capture(result(), message(), null);
    expect(journal.get(snapshot.deliveryId)?.snapshot.record.result).toBe("Full result");
  });

  it.each([false, undefined])("warns without blocking delivery when persistence is %s", persisted => {
    const warning = vi.fn();
    const journal = new CompletionJournal(owner, vi.fn(), { persisted, onWarning: warning });
    const snapshot = journal.capture(result(), message(), null);
    journal.attempt([snapshot.deliveryId]);
    expect(journal.get(snapshot.deliveryId)?.state).toBe("uncertain");
    expect(journal.summary().durabilityDegraded).toBe(true);
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "memory-only" }));
  });

  it("fails closed on malformed/unknown versions and keeps valid output accessible, not known-unsent", () => {
    const b = ledger();
    const snapshot = b.journal.capture(result(), message(), null);
    const malformed = [
      entry(null), entry({ version: 2, type: "attempted", ownerSessionId: owner, deliveryId: snapshot.deliveryId, at: 2 }),
      entry({ version: 1, type: "attempted", ownerSessionId: owner, deliveryId: "missing", at: 2 }),
      entry({ version: 1, type: "resolved", ownerSessionId: owner, deliveryId: snapshot.deliveryId, at: 2, resolution: "delivered" }),
      entry({ version: 1, type: "captured", snapshot: { ...snapshot, record: { ...snapshot.record, result: 42 } } }),
    ];
    const append = vi.fn();
    const warning = vi.fn();
    const restored = new CompletionJournal(owner, append, { persisted: true, onWarning: warning });
    expect(restored.restore([...b.entries, ...malformed])).toMatchObject({ invalidEntries: 5, pending: 0, uncertain: 1 });
    expect(restored.getLatestResult("worker")?.result).toBe("Full result");
    expect(append).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledOnce();
    expect(restored.reconcile([receipt([snapshot])])).toEqual([snapshot.deliveryId]);
  });

  it("does not invent recovery state from legacy records, transcript paths, or future snapshots", () => {
    const append = vi.fn();
    const journal = new CompletionJournal(owner, append, { persisted: true });
    const b = ledger();
    const snapshot = b.journal.capture(result(), message(), null);
    expect(journal.restore([
      { type: "custom", customType: "subagents:record", data: result() },
      entry({ version: 9, type: "captured", snapshot }),
    ])).toMatchObject({ legacyRecords: 1, invalidEntries: 1, pending: 0, uncertain: 0 });
    expect(journal.list()).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it("is idempotent for the same delivery UUID and refuses conflicting snapshots", () => {
    const b = ledger();
    const snapshot = b.journal.capture(result(), message(), null, "run-fixed");
    expect(b.journal.capture(result(), message(), null, "run-fixed")).toEqual(snapshot);
    expect(b.append).toHaveBeenCalledOnce();
    expect(() => b.journal.capture(result("worker", "different"), message(), null, "run-fixed")).toThrow(/already belongs/);
    const restored = new CompletionJournal(owner, vi.fn(), { persisted: true });
    expect(restored.restore([...b.entries, ...b.entries])).toMatchObject({ pending: 1, invalidEntries: 0 });
    expect(restored.restore([...b.entries, entry({ version: 1, type: "captured", snapshot: { ...snapshot, capturedAt: snapshot.capturedAt + 1 } })]))
      .toMatchObject({ uncertain: 1, invalidEntries: 1 });
  });

  it("makes repeated consumption idempotent and preserves distinct same-worker resumes", () => {
    const b = ledger();
    const first = b.journal.capture(result(), message(), null);
    b.journal.consumeWorker("worker");
    const writes = b.append.mock.calls.length;
    expect(b.journal.consumeWorker("worker")).toBe(0);
    expect(b.append).toHaveBeenCalledTimes(writes);
    const next = b.journal.capture(result("worker", "new output"), message(), null);
    expect(b.journal.get(first.deliveryId)?.state).toBe("consumed");
    expect(b.journal.get(next.deliveryId)?.state).toBe("pending");
    expect(b.journal.getLatestResult("worker")?.result).toBe("new output");
  });

  it("ignores unrelated and malformed outer entries without treating proposed payloads as receipts", () => {
    const b = ledger();
    const snapshot = b.journal.capture(result(), message(), null);
    const restored = new CompletionJournal(owner, vi.fn(), { persisted: true });
    expect(restored.restore([null, {}, { type: "message", message: { role: "custom", ...receipt([snapshot]) } }, ...b.entries]))
      .toMatchObject({ pending: 1, delivered: 0, invalidEntries: 0 });
  });
});

describe("real Pi session persistence boundaries, without a model or registrar", () => {
  it("does not mistake pre-conversation custom entries for an already flushed session file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-completion-journal-"));
    dirs.push(dir);
    const manager = SessionManager.create(dir, dir);
    const journal = new CompletionJournal(manager.getSessionId(), (customType, data) => { manager.appendCustomEntry(customType, data); });
    const snapshot = journal.capture(result(), message(), null);
    expect(manager.isPersisted()).toBe(true);
    expect(existsSync(manager.getSessionFile()!)).toBe(false);
    expect(journal.summary().durabilityDegraded).toBe(true); // Persistence not verified by the injected caller.
    manager.appendMessage({ role: "user", content: "conversation starts", timestamp: Date.now() });
    expect(existsSync(manager.getSessionFile()!)).toBe(true);
    const reopened = SessionManager.open(manager.getSessionFile()!);
    const restored = new CompletionJournal(manager.getSessionId(), vi.fn(), { persisted: true });
    expect(restored.restore(reopened.getEntries())).toMatchObject({ pending: 1 });
    expect(restored.getLatestResult(snapshot.workerId)?.result).toBe("Full result");
  });

  it("acknowledges only after the actual host entry is appended and survives reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-completion-receipt-"));
    dirs.push(dir);
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "persistent parent", timestamp: Date.now() });
    const journal = new CompletionJournal(manager.getSessionId(), (customType, data) => { manager.appendCustomEntry(customType, data); }, { persisted: true });
    const snapshot = journal.capture(result(), message(), manager.getLeafId());
    const outbox = new CompletionOutbox(sent => {
      // This is the extension message_end phase: no transcript entry yet.
      expect(journal.reconcile(manager.getEntries())).toEqual([]);
      expect(journal.reconcile([{ type: "message_end", message: { role: "custom", ...sent } }])).toEqual([]);
    }, () => true, undefined, { getOwnerSessionId: () => manager.getSessionId(), onAttempt: ids => journal.attempt(ids) });
    outbox.add(snapshot.workerId, snapshot.message, snapshot);
    outbox.onTurnEnd("toolUse");
    expect(outbox.getState()).toMatchObject({ count: 1, inFlight: 1 });
    manager.appendCustomMessageEntry("subagent-notification", snapshot.message.content, true, snapshot.message.details);
    outbox.acknowledge(journal.reconcile(manager.getEntries()));
    expect(outbox.getPendingState().count).toBe(0);
    const restored = new CompletionJournal(manager.getSessionId(), vi.fn(), { persisted: true });
    expect(restored.restore(SessionManager.open(manager.getSessionFile()!).getEntries())).toMatchObject({ delivered: 1, uncertain: 0 });
    outbox.dispose();
  });
});
