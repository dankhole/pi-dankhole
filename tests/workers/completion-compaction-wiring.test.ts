/** Real Pi 1.4 summary, async-handler, queued-input, and cancellation regressions. */
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionFactory, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../../src/workers/agent-runner.js";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../../src/workers/agent-runner.js";
import subagentsExtension from "../../src/workers/index.js";
import { ctx, type Hermetic, hermeticDir } from "./helpers/boot-extension.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const priorManager = Reflect.get(globalThis, MANAGER_KEY);
let environment: Hermetic | undefined;
let cleanup: (() => Promise<void>) | undefined;

const nextImmediate = () => new Promise<void>(resolve => setImmediate(resolve));

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  if (priorManager === undefined) Reflect.deleteProperty(globalThis, MANAGER_KEY);
  else Reflect.set(globalThis, MANAGER_KEY, priorManager);
  environment?.restore();
  environment = undefined;
  vi.mocked(runAgent).mockReset();
});

async function boot(laterExtensions: ExtensionFactory[] = []) {
  environment = hermeticDir({ settings: { outputTranscript: false } });
  Reflect.deleteProperty(globalThis, MANAGER_KEY);
  const finishers = new Map<string, () => void>();
  vi.mocked(runAgent).mockImplementation((_config, prompt) => new Promise(resolve => {
    finishers.set(prompt, () => resolve({
      responseText: `${prompt} done`,
      session: { dispose: vi.fn(), messages: [] } as unknown as AgentSession,
      aborted: false, steered: false,
    }));
  }));
  const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  faux.setResponses(Array.from({ length: 16 }, () => fauxAssistantMessage(`Reply ${"filler ".repeat(300)}`)));
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 200 }, retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: environment.dir, agentDir: getAgentDir(), settingsManager,
    extensionFactories: [pi => {
      // Preserve the real host lifecycle without executing shutdown's Git prune.
      vi.spyOn(pi, "exec").mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false });
      subagentsExtension(pi);
    }, ...laterExtensions],
    noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    ...fauxModelBackend(faux.getModel()), cwd: environment.dir, model: faux.getModel(),
    resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(environment.dir),
  });
  let operation: Promise<unknown> | undefined;
  let finishSummary: ((reason: "stop" | "error" | "aborted") => void) | undefined;
  cleanup = async () => {
    finishSummary?.("aborted");
    await operation;
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    faux.unregister();
  };
  await session.bindExtensions({});
  await session.prompt("first question");
  const treeTarget = session.sessionManager.getLeafId()!;
  await session.prompt("second question");
  await session.prompt("third question");
  for (const prompt of ["alpha", "beta"]) {
    await session.getToolDefinition("Agent")!.execute(
      `call-${prompt}`, { prompt, description: prompt, run_in_background: true },
      undefined, undefined, session.extensionRunner.createToolContext(`call-${prompt}`, undefined),
    );
  }
  let entered!: () => void;
  const streamEntered = new Promise<void>(resolve => { entered = resolve; });
  const originalStream = session.agent.streamFunction;
  let summaryStarted = false;
  session.agent.streamFunction = (model, context, options) => {
    const request = JSON.stringify(context.messages.at(-1)?.content);
    if (summaryStarted || !request?.includes("<conversation>")) return originalStream(model, context, options);
    summaryStarted = true;
    const stream = createAssistantMessageEventStream();
    const partial = { ...fauxAssistantMessage("Summary in progress", { stopReason: "pending" }),
      api: model.api, provider: model.provider, model: model.id };
    stream.push({ type: "start", partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Summary in progress", partial });
    let finished = false;
    finishSummary = reason => {
      if (finished) return;
      finished = true;
      const message = { ...partial, stopReason: reason, ...(reason === "error" ? { errorMessage: "Synthetic summary failure" } : {}) };
      if (reason === "stop") stream.push({ type: "done", reason, message });
      else stream.push({ type: "error", reason, error: message });
      stream.end(message);
    };
    options?.signal?.addEventListener("abort", () => finishSummary?.("aborted"), { once: true });
    entered();
    return stream;
  };
  const send = vi.spyOn(session, "sendCustomMessage");
  const notifications = () => session.messages.filter(message => message.role === "custom" && message.customType === "subagent-notification");
  return {
    session, send, streamEntered, notifications,
    startSummary(tree = false) {
      operation = (tree ? session.navigateTree(treeTarget, { summarize: true }) : session.compact())
        .then(result => ({ result }), error => ({ error }));
      return operation;
    },
    finishSummary: (reason: "stop" | "error" | "aborted") => finishSummary!(reason),
    async finishWorkers() {
      finishers.get("alpha")!();
      await nextImmediate();
      finishers.get("beta")!();
      await nextImmediate();
    },
    async expectDelivered() {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { interval: 5, timeout: 1500 });
      await session.waitForIdle();
      expect(notifications()).toHaveLength(1);
      expect(notifications()[0]).toMatchObject({
        details: expect.objectContaining({ description: "alpha", others: [expect.objectContaining({ description: "beta" })] }),
      });
      await nextImmediate();
      expect(send).toHaveBeenCalledOnce();
      expect(session.isIdle).toBe(true);
    },
  };
}

describe("worker delivery after real Pi summarization", () => {
  it.each(["success", "failure", "abort", "tree-success"] as const)("holds a never-ending stream, then delivers once after %s without queued input", async outcome => {
    const b = await boot();
    const operation = b.startSummary(outcome === "tree-success");
    await b.streamEntered;
    expect(b.session.isCompacting).toBe(true);
    expect(b.session.isStreaming).toBe(false);
    expect(b.session.isIdle).toBe(false);
    await b.finishWorkers();
    expect(b.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "subagents:record"))
      .toHaveLength(2);
    expect(b.send).not.toHaveBeenCalled();
    expect(b.notifications()).toHaveLength(0);
    // No natural end or wall-clock release: only the explicit terminal event or abort.
    if (outcome === "abort") b.session.abortCompaction();
    else b.finishSummary(outcome === "failure" ? "error" : "stop");
    const result = await operation;
    expect(result).toHaveProperty(outcome === "failure" || outcome === "abort" ? "error" : "result");
    expect(b.send).not.toHaveBeenCalled();
    await b.expectDelivered();
  });

  // Ported from /tmp/review-w3/async-handler.test.ts: Pi awaits later extension
  // handlers before clearing isCompacting, after our first immediate has run.
  it.each([false, true])("delivers after a later asynchronous terminal handler (tree: %s)", async tree => {
    const b = await boot([pi => {
      const delay = async () => { await new Promise<void>(resolve => setTimeout(resolve, 25)); };
      pi.on("session_compact", delay);
      pi.on("session_tree", delay);
    }]);
    const operation = b.startSummary(tree);
    await b.streamEntered;
    await b.finishWorkers();
    b.finishSummary("stop");
    await nextImmediate();
    expect(b.session.isCompacting).toBe(true);
    expect(b.session.isStreaming).toBe(false);
    expect(b.send).not.toHaveBeenCalled();
    await operation;
    await b.expectDelivered();
  });

  // Ported from /tmp/review-w3/queued-input.test.ts, with assertions on order
  // instead of console output: async input processing must own the next turn.
  it("does not start a notification turn ahead of a submitted prompt awaiting input handlers", async () => {
    let delayInput = false;
    const starts: string[] = [];
    const b = await boot([pi => {
      pi.on("input", async () => {
        if (delayInput) await new Promise<void>(resolve => setTimeout(resolve, 25));
      });
      pi.on("before_agent_start", event => { if (delayInput) starts.push(event.messageType); });
    }]);
    const operation = b.startSummary();
    await b.streamEntered;
    await b.finishWorkers();
    b.finishSummary("stop");
    await operation;
    delayInput = true;
    await b.session.prompt("queued user prompt");
    await b.expectDelivered();
    expect(starts[0]).toBe("user");
    const userIndex = b.session.messages.findIndex(message => message.role === "user" && JSON.stringify(message.content).includes("queued user prompt"));
    const notificationIndex = b.session.messages.findIndex(message => message.role === "custom" && message.customType === "subagent-notification");
    expect(userIndex).toBeGreaterThan(-1);
    expect(notificationIndex).toBeGreaterThan(userIndex);
  });

  it("resets pending status through session_compact_failed when a later extension cancels compaction", async () => {
    const ui = ctx().ui;
    const statuses = () => ui.setStatus.mock.calls
      .filter(([key]: [string, unknown]) => key === "subagents:pending-completions")
      .map(([, value]: [string, unknown]) => value);
    const failed = vi.fn();
    let b!: Awaited<ReturnType<typeof boot>>;
    b = await boot([pi => {
      pi.on("session_before_compact", async () => {
        await b.finishWorkers();
        expect(statuses().at(-1)).toBe("2 worker results waiting for compaction — Esc to cancel");
        return { cancel: true };
      });
      pi.on("session_compact_failed", event => {
        failed(event);
        expect(statuses().at(-1)).toBe("2 worker results waiting for the main agent");
      });
    }]);
    // Bind presentation after detached startup; these synthetic workers do not
    // provide the interactive launch handshake used by a real worker session.
    await b.session.bindExtensions({ uiContext: ui, mode: "tui" });
    expect(await b.startSummary()).toHaveProperty("error");
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ aborted: true, reason: "manual" }));
    await b.expectDelivered();
    expect(statuses().at(-1)).toBeUndefined();
  });
});
