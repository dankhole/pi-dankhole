import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../../src/workers/agent-runner.js";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../../src/workers/agent-runner.js";
import { COMPLETION_JOURNAL_TYPE, CompletionJournal, type CompletionSnapshot } from "../../src/workers/completion-journal.js";
import subagentsExtension from "../../src/workers/index.js";
import { type BootedPi, ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const KEY = Symbol.for("pi-subagents:manager");
const previous = Reflect.get(globalThis, KEY);
let environment: Hermetic | undefined;
let booted: BootedPi | undefined;
let finishers: Map<string, (text?: string) => void>;

afterEach(async () => {
  await booted?.lifecycle.get("session_shutdown")?.();
  booted = undefined;
  if (previous === undefined) Reflect.deleteProperty(globalThis, KEY);
  else Reflect.set(globalThis, KEY, previous);
  environment?.restore();
  environment = undefined;
  vi.mocked(runAgent).mockReset();
  vi.useRealTimers();
});

async function boot(manager?: SessionManager, idle = false) {
  environment ??= hermeticDir({ settings: { outputTranscript: false } });
  Reflect.deleteProperty(globalThis, KEY);
  booted = makePi();
  const sessionManager = manager ?? SessionManager.inMemory(environment.dir);
  booted.pi.appendEntry.mockImplementation((type: string, data: unknown) => { sessionManager.appendCustomEntry(type, data); });
  subagentsExtension(booted.pi);
  const parent = { idle };
  const context = ctx({
    sessionManager, isIdle: () => parent.idle, hasPendingMessages: () => false, signal: undefined,
    hasUI: true, abort: vi.fn(),
  });
  context.ui.onTerminalInput = vi.fn(() => vi.fn());
  context.ui.confirm = vi.fn(async () => false);
  await booted.lifecycle.get("session_start")({}, context);
  finishers = new Map();
  vi.mocked(runAgent).mockImplementation((_config, prompt) => new Promise(resolve => {
    finishers.set(prompt, (text = `${prompt} result`) => resolve({ responseText: text, session: { dispose: vi.fn(), messages: [] } as never, aborted: false, steered: false }));
  }));
  const b = booted;
  return {
    ...b, context, parent, sessionManager,
    async spawn(prompt: string) {
      const result = await b.tools.get("Agent").execute(prompt, { prompt, description: prompt, run_in_background: true }, undefined, undefined, context);
      return /Agent ID: (\S+)/.exec(result.content[0].text)![1];
    },
    async finish(prompt: string, text?: string) { finishers.get(prompt)!(text); await flush(); },
    command(args: string) { return b.commands.get("agents").handler(args, context); },
    snapshots() {
      return sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === COMPLETION_JOURNAL_TYPE)
        .map(entry => (entry as { data: { type: string; snapshot?: CompletionSnapshot } }).data)
        .filter(data => data.type === "captured").map(data => data.snapshot!);
    },
  };
}

const boundary = (b: BootedPi, stopReason = "toolUse") => b.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason } });

describe("completion journal/lifecycle integration", () => {
  it("keeps unproven durability visible without a popup on an otherwise normal completion", async () => {
    const b = await boot();
    await b.spawn("normal completion");
    await b.finish("normal completion");
    expect(b.context.ui.notify).not.toHaveBeenCalled();
    await b.command("diagnostics");
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("durability=unverified/degraded");
    await b.command("recover list");
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("durability=unverified/degraded");
  });

  it("keeps capture-failure warnings content-free and leaves the live result readable without unsafe fallback sending", async () => {
    const b = await boot();
    const capture = vi.spyOn(CompletionJournal.prototype, "capture").mockImplementationOnce(() => { throw new Error("PRIVATE capture failure"); });
    try {
      const id = await b.spawn("uncaptured");
      await b.finish("uncaptured");
      expect(b.pi.sendMessage).not.toHaveBeenCalled();
      expect(b.context.ui.notify).toHaveBeenCalledWith(expect.stringContaining("automatic notification and restart recovery are not guaranteed"), "warning");
      expect(JSON.stringify(b.context.ui.notify.mock.calls)).not.toContain("PRIVATE");
      const result = await b.tools.get("get_subagent_result").execute("read", { agent_id: id }, undefined, undefined, b.context);
      expect(result.content[0].text).toContain("uncaptured result");
    } finally { capture.mockRestore(); }
  });

  it("captures before lifecycle consumers, even if legacy history and event presentation throw", async () => {
    const b = await boot();
    const workerId = await b.spawn("captured");
    const append = b.pi.appendEntry.getMockImplementation()!;
    b.pi.appendEntry.mockImplementation((type: string, data: unknown) => {
      if (type === "subagents:record") throw new Error("private legacy failure");
      append(type, data);
    });
    b.pi.events.emit.mockImplementation((name: string) => {
      if (name === "subagents:completed") {
        expect(b.snapshots()).toHaveLength(1);
        throw new Error("private event failure");
      }
    });
    await b.finish("captured");
    expect(b.snapshots()[0].record.result).toBe("captured result");
    boundary(b);
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    const result = await b.tools.get("get_subagent_result").execute("read", { agent_id: workerId }, undefined, undefined, b.context);
    expect(result.content[0].text).toContain("captured result");
    expect(JSON.stringify(b.context.ui.notify.mock.calls)).not.toContain("private event failure");
  });

  it("retains a result through journal and send exceptions, never automatically retries an uncertain send", async () => {
    const b = await boot();
    await b.spawn("retained");
    b.pi.appendEntry.mockImplementation(() => { throw new Error("private journal failure"); });
    await b.finish("retained");
    expect(b.context.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Completion journal write failed"), "warning");
    b.pi.sendMessage.mockImplementation(() => { throw new Error("private send failure"); });
    boundary(b);
    boundary(b);
    b.lifecycle.get("agent_settled")({ aborted: false });
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    await b.command("recover");
    expect(JSON.stringify(b.context.ui.notify.mock.calls)).toContain("uncertain=1");
    expect(JSON.stringify(b.context.ui.notify.mock.calls)).not.toContain("private send failure");
  });

  it("requires an actual persisted custom-message receipt, not send acceptance or a message_end payload", async () => {
    const b = await boot();
    await b.spawn("receipt");
    await b.finish("receipt");
    boundary(b);
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    const message = b.pi.sendMessage.mock.calls[0][0];
    b.lifecycle.get("message_end")?.({ message: { role: "custom", ...message } });
    await b.command("diagnostics");
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("in-flight=1");
    b.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    b.lifecycle.get("turn_start")();
    await b.command("diagnostics");
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("Completions pending: 0");
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("restores known pending snapshots held, and retrieves terminal results without creating execution records", async () => {
    let b = await boot();
    const id = await b.spawn("restart");
    await b.finish("restart");
    const manager = b.sessionManager;
    await b.lifecycle.get("session_shutdown")();
    booted = undefined;
    b = await boot(manager, true);
    await b.command("recover check");
    boundary(b);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    expect(Reflect.get(globalThis, KEY).getRecord(id)).toBeUndefined();
    const result = await b.tools.get("get_subagent_result").execute("read", { agent_id: id, verbose: true }, undefined, undefined, b.context);
    expect(result.content[0].text).toContain("restart result");
    expect(result.content[0].text).toContain("no live conversation, resumability, or new usage");
    expect(Reflect.get(globalThis, KEY).getRecord(id)).toBeUndefined();
    boundary(b);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not duplicate the held-restoration notice with a later delivery-stall watchdog", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    let b = await boot();
    await b.spawn("held recovery");
    await b.finish("held recovery");
    const manager = b.sessionManager;
    await b.lifecycle.get("session_shutdown")();
    booted = undefined;
    b = await boot(manager, true);
    expect(b.context.ui.notify).toHaveBeenCalledOnce();
    expect(b.context.ui.notify.mock.calls[0][0]).toContain("Recovered 1 pending and 0 uncertain");
    const baselineTimers = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.context.ui.notify).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(baselineTimers);
    await b.command("diagnostics");
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("Completions pending: 1");
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("held=1");
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("gives a fresh busy completion its own 30-second watchdog window beside a 60-second held restoration", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    let b = await boot();
    await b.spawn("older held result");
    await b.finish("older held result");
    const manager = b.sessionManager;
    await b.lifecycle.get("session_shutdown")();
    booted = undefined;
    b = await boot(manager, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.context.ui.notify).toHaveBeenCalledOnce(); // Only the recovery notice.
    b.parent.idle = false;
    await b.spawn("fresh busy result");
    await b.finish("fresh busy result");
    expect(b.context.ui.notify).toHaveBeenCalledOnce();
    await b.command("diagnostics");
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("Completions pending: 2; oldest 60s");
    const notices = b.context.ui.notify.mock.calls.length;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(b.context.ui.notify).toHaveBeenCalledTimes(notices);
    await vi.advanceTimersByTimeAsync(1);
    expect(b.context.ui.notify).toHaveBeenCalledTimes(notices + 1);
    expect(b.context.ui.notify.mock.calls.at(-1)).toEqual([
      expect.stringContaining("Completions pending: 2; oldest 90s"), "warning",
    ]);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("restores malformed trailing transitions as uncertain even without an attempted flag", async () => {
    let b = await boot();
    await b.spawn("malformed transition");
    await b.finish("malformed transition");
    const snapshot = b.snapshots()[0];
    b.sessionManager.appendCustomEntry(COMPLETION_JOURNAL_TYPE, {
      version: 2, type: "attempted", ownerSessionId: snapshot.ownerSessionId, deliveryId: snapshot.deliveryId, at: Date.now(),
    });
    const manager = b.sessionManager;
    await b.lifecycle.get("session_shutdown")();
    booted = undefined;
    b = await boot(manager, true);
    expect(b.context.ui.notify).toHaveBeenCalledWith(expect.stringContaining("malformed or unsupported"), "warning");
    await b.command("diagnostics");
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("uncertain=1, held=0");
    await b.command(`recover retry ${snapshot.deliveryId}`);
    expect(b.context.ui.confirm).toHaveBeenCalledOnce();
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("makes throwing public observations unknown without crashing diagnostics or forcing delivery", async () => {
    const b = await boot();
    b.context.isIdle = () => { throw new Error("private idle getter"); };
    b.context.hasPendingMessages = () => { throw new Error("private queue getter"); };
    Object.defineProperty(b.context, "signal", { get: () => { throw new Error("private signal getter"); } });
    await b.spawn("unknown observations");
    await b.finish("unknown observations");
    await b.command("recover check");
    await b.command("diagnostics");
    const text = b.context.ui.notify.mock.calls.at(-1)[0];
    expect(text).toContain("idle=unknown");
    expect(text).toContain("queued messages=unknown, signal=unknown");
    expect(text).not.toContain("private");
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    for (const event of ["before_provider_request", "after_provider_response"]) {
      expect(b.lifecycle.get(event)({})).toBeUndefined();
    }
  });

  it("excludes synthetic stopped results caused by shutdown", async () => {
    const b = await boot();
    await b.spawn("shutdown stop");
    await b.lifecycle.get("session_shutdown")();
    await b.finish("shutdown stop");
    expect(b.snapshots()).toHaveLength(0);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("captures a genuine completed result arriving during awaited shutdown cleanup", async () => {
    const b = await boot();
    const id = await b.spawn("genuine finish");
    const record = Reflect.get(globalThis, KEY).getRecord(id);
    // Model a terminal outcome whose completion callback is still awaiting cleanup.
    record.status = "completed";
    record.completedAt = Date.now();
    record.session = { messages: [], dispose: async () => { await b.finish("genuine finish"); } };
    await b.lifecycle.get("session_shutdown")();
    expect(b.snapshots()).toHaveLength(1);
    expect(b.snapshots()[0].record.result).toBe("genuine finish result");
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("holds new completions after user abort until a deliberate idle check or a later successful boundary", async () => {
    const b = await boot();
    await b.spawn("first");
    await b.finish("first");
    boundary(b, "aborted");
    b.parent.idle = true;
    b.lifecycle.get("agent_settled")({ aborted: true });
    await b.spawn("late");
    await b.finish("late");
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    await b.command("recover check");
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    expect(b.pi.sendMessage.mock.calls[0][0].details.others).toHaveLength(1);
    expect(b.context.abort).not.toHaveBeenCalled();
  });

  it("does not carry an old session's abort holdback or completions into a fresh session", async () => {
    const b = await boot();
    await b.spawn("old aborted session");
    await b.finish("old aborted session");
    boundary(b, "aborted");
    b.lifecycle.get("agent_settled")({ aborted: true });
    const manager = SessionManager.inMemory(environment!.dir);
    const replacement = ctx({ sessionManager: manager, isIdle: () => true, signal: undefined, hasPendingMessages: () => false });
    b.pi.appendEntry.mockImplementation((type: string, data: unknown) => { manager.appendCustomEntry(type, data); });
    await b.lifecycle.get("session_start")({}, replacement);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    await b.tools.get("Agent").execute("new-call", { prompt: "fresh session", description: "fresh session", run_in_background: true }, undefined, undefined, replacement);
    await b.finish("fresh session");
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    expect(b.pi.sendMessage.mock.calls[0][0].content).toContain("fresh session result");
    expect(b.pi.sendMessage.mock.calls[0][0].content).not.toContain("old aborted session");
  });

  it("observes tree-summary cancellation without a success event but never treats abort itself as settled", async () => {
    const b = await boot();
    await b.spawn("tree");
    await b.finish("tree");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const controller = new AbortController();
    b.lifecycle.get("session_before_tree")({ signal: controller.signal });
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    b.parent.idle = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    expect(b.context.abort).not.toHaveBeenCalled();
  });

  it("leaves tree cancellation without an abort signal outcome unknown until explicit recovery", async () => {
    const b = await boot();
    await b.spawn("unknown tree");
    await b.finish("unknown tree");
    const controller = new AbortController();
    b.lifecycle.get("session_before_tree")({ signal: controller.signal });
    b.parent.idle = true; // A later hook returned cancel:true; Pi emits no terminal event.
    await flush();
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    await b.command("recover check");
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("dismisses only a deliberately named worker's captured runs without claiming a receipt", async () => {
    const b = await boot();
    const dismissed = await b.spawn("dismiss this worker");
    await b.finish("dismiss this worker");
    await b.spawn("keep this worker");
    await b.finish("keep this worker");
    await b.command(`recover dismiss ${b.snapshots()[0].deliveryId}`);
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("Dismiss takes a worker ID");
    await b.command(`recover dismiss ${dismissed}`);
    await b.command("recover list");
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("dismissed=1");
    boundary(b);
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    expect(b.pi.sendMessage.mock.calls[0][0].content).toContain("keep this worker result");
    expect(b.pi.sendMessage.mock.calls[0][0].content).not.toContain("dismiss this worker result");
    expect(b.snapshots()[0].record.result).toBe("dismiss this worker result");
  });

  it("bounds inspection without consuming the result, and links only a valid saved transcript", async () => {
    const b = await boot();
    const id = await b.spawn("large result");
    const transcript = join(environment!.dir, "saved-output.jsonl");
    writeFileSync(transcript, "saved transcript");
    Reflect.get(globalThis, KEY).getRecord(id).outputFile = transcript;
    const full = "Captured output. ".repeat(2_000) + "FULL_RESULT_END";
    await b.finish("large result", full);
    await b.command(`recover inspect ${b.snapshots()[0].deliveryId}`);
    const preview = b.context.ui.notify.mock.calls.at(-1)[0];
    expect(preview.length).toBeLessThan(3_000);
    expect(preview).toContain("[preview truncated]");
    expect(preview).toContain(`get_subagent_result with agent_id="${id}"`);
    expect(preview).toContain(`Saved transcript: ${transcript}`);
    expect(preview).not.toContain("FULL_RESULT_END");

    const missingId = await b.spawn("missing transcript");
    Reflect.get(globalThis, KEY).getRecord(missingId).outputFile = join(environment!.dir, "missing.jsonl");
    await b.finish("missing transcript");
    await b.command(`recover inspect ${b.snapshots()[1].deliveryId}`);
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).not.toContain("Saved transcript:");
    await b.command("recover list");
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("pending=2");
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("consumed=0");
    const result = await b.tools.get("get_subagent_result").execute("full-read", { agent_id: id }, undefined, undefined, b.context);
    expect(result.content[0].text).toContain(full);
  });

  it.each([false, true])("retries only the named run after abort, leaving queued siblings and later arrivals held (attempted=%s)", async attempted => {
    const b = await boot();
    await b.spawn("selected retry");
    await b.finish("selected retry");
    const deliveryId = b.snapshots()[0].deliveryId;
    boundary(b, attempted ? "toolUse" : "aborted");
    b.lifecycle.get("agent_settled")({ aborted: true });
    await b.spawn("queued sibling");
    await b.finish("queued sibling");
    b.parent.idle = true;
    b.context.ui.confirm.mockResolvedValue(true);
    const before = b.pi.sendMessage.mock.calls.length;
    await b.command(`recover retry ${deliveryId}`);
    expect(b.pi.sendMessage).toHaveBeenCalledTimes(before + 1);
    expect(b.pi.sendMessage.mock.calls.at(-1)[0].content).toContain("selected retry result");
    expect(b.pi.sendMessage.mock.calls.at(-1)[0].content).not.toContain("queued sibling");
    expect(b.context.ui.confirm).toHaveBeenCalledTimes(attempted ? 1 : 0);
    await b.spawn("later arrival");
    await b.finish("later arrival");
    expect(b.pi.sendMessage).toHaveBeenCalledTimes(before + 1);
    await b.command("diagnostics");
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("queued=2");
    expect(b.context.ui.notify.mock.calls.at(-1)[0]).toContain("automatic delivery paused=true");
    await b.command("recover check"); // The ordinary deliberate check still covers all queued runs.
    expect(b.pi.sendMessage).toHaveBeenCalledTimes(before + 2);
    expect(b.pi.sendMessage.mock.calls.at(-1)[0].content).toContain("queued sibling result");
    expect(b.pi.sendMessage.mock.calls.at(-1)[0].content).toContain("later arrival result");
  });

  it("requires duplicate-risk confirmation before deliberately retrying an attempted delivery", async () => {
    const b = await boot();
    await b.spawn("uncertain");
    await b.finish("uncertain");
    boundary(b);
    const deliveryId = b.snapshots()[0].deliveryId;
    b.lifecycle.get("agent_settled")({ aborted: false });
    b.parent.idle = true;
    await b.command(`recover retry ${deliveryId}`);
    expect(b.context.ui.confirm).toHaveBeenCalledOnce();
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    b.context.ui.confirm.mockResolvedValue(true);
    await b.command(`recover retry ${deliveryId}`);
    expect(b.pi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("fences a confirmation that completes after session replacement", async () => {
    const b = await boot();
    await b.spawn("old session");
    await b.finish("old session");
    boundary(b);
    const deliveryId = b.snapshots()[0].deliveryId;
    let confirm!: (value: boolean) => void;
    b.context.ui.confirm.mockImplementation(() => new Promise<boolean>(resolve => { confirm = resolve; }));
    const retry = b.command(`recover retry ${deliveryId}`);
    const replacement = ctx({ sessionManager: SessionManager.inMemory(environment!.dir), hasPendingMessages: () => false });
    await b.lifecycle.get("session_start")({}, replacement);
    confirm(true);
    await retry;
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
    boundary(b);
    expect(b.pi.sendMessage).toHaveBeenCalledOnce();
  });
});
