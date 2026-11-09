/** Real parent tool dispatch and input preparation; only the child runner is mocked. */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../../src/workers/agent-runner.js";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../../src/workers/agent-runner.js";
import subagentsExtension from "../../src/workers/index.js";
import type { AgentRecord } from "../../src/workers/types.js";
import { hermeticDir } from "./helpers/boot-extension.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const TOOL_CALL_ID = "foreground-call";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  try {
    await cleanup?.();
  } finally {
    cleanup = undefined;
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    vi.mocked(runAgent).mockReset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

async function boot(laterInput: (pi: ExtensionAPI) => void = () => {}) {
  // Drive multiple real spinner ticks without wall-clock sleeps. Provider stream
  // immediates and host promises remain real, not replaced with loop mocks.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const hermetic = hermeticDir({ settings: { outputTranscript: false, worktreeIsolation: false } });
  const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  const childStarted = deferred();
  let childId = "";
  let childSignal: AbortSignal | undefined;
  let finishChild: (() => void) | undefined;
  let childSettled = false;
  vi.mocked(runAgent).mockImplementation((_context, _prompt, options) => {
    childId = options.agentId!;
    childSignal = options.signal;
    const child = { dispose: vi.fn(), messages: [] } as unknown as AgentSession;
    return new Promise(resolve => {
      finishChild = () => {
        if (childSettled) return;
        childSettled = true;
        options.signal?.removeEventListener("abort", finishChild!);
        resolve({ responseText: "child finished", session: child, aborted: options.signal?.aborted === true, steered: false });
      };
      options.signal?.addEventListener("abort", finishChild, { once: true });
      options.onSessionCreated?.(child);
      childStarted.resolve();
    });
  });

  const requests: string[][] = [];
  faux.setResponses([
    fauxAssistantMessage({
      type: "toolCall", id: TOOL_CALL_ID, name: "Agent",
      arguments: { prompt: "Keep working independently", description: "held child", run_in_background: false },
    }, { stopReason: "toolUse" }),
    context => {
      requests.push(context.messages.filter(message => message.role === "user").map(message =>
        typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n"),
      ));
      return fauxAssistantMessage("Parent received the queued input");
    },
  ]);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: hermetic.dir, agentDir: getAgentDir(), settingsManager,
    extensionFactories: [pi => {
      // Keep shutdown's unrelated worktree-prune OS boundary hermetic.
      vi.spyOn(pi, "exec").mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false });
      subagentsExtension(pi);
    }, laterInput],
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
  });
  let session: AgentSession | undefined;
  let parentPrompt: Promise<void> | undefined;
  cleanup = async () => {
    try {
      await session?.abort();
      await parentPrompt;
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      finishChild?.();
      session?.dispose();
      faux.unregister();
      hermetic.restore();
    }
  };
  await loader.reload();
  ({ session } = await createAgentSession({
    ...fauxModelBackend(faux.getModel()), cwd: hermetic.dir, model: faux.getModel(),
    resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(hermetic.dir),
  }));
  await session.bindExtensions({});
  parentPrompt = session.prompt("Start a foreground worker");
  await childStarted.promise;
  await new Promise<void>(resolve => setImmediate(resolve));

  const record = () => (Reflect.get(globalThis, MANAGER_KEY) as { getRecord(id: string): AgentRecord }).getRecord(childId);
  const toolResults = () => session!.messages.filter(message => message.role === "toolResult" && message.toolCallId === TOOL_CALL_ID);
  const expectForegroundWait = () => {
    expect(record()).toMatchObject({ status: "running", isBackground: false });
    expect(childSettled).toBe(false);
    expect(childSignal?.aborted).toBe(false);
    expect(toolResults()).toHaveLength(0);
    expect(faux.state.callCount).toBe(1);
    expect(session!.isIdle).toBe(false);
  };
  expectForegroundWait();
  return { session, parentPrompt, faux, requests, record, toolResults, expectForegroundWait, finishChild: () => finishChild!(), childSignal };
}

describe("foreground steering through the real host agent loop", () => {
  it("waits for later input transforms to queue, then releases main while the child keeps running", async () => {
    const entered = deferred();
    const release = deferred();
    const h = await boot(pi => {
      pi.on("input", async event => {
        if (event.text !== "raw redirect") return;
        entered.resolve();
        await release.promise;
        return { action: "transform", text: "latest transformed redirect" };
      });
    });
    let steering: Promise<void> | undefined;
    try {
      steering = h.session.prompt("raw redirect", { streamingBehavior: "steer" });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(240);
      expect(h.session.pendingMessageCount).toBe(0);
      h.expectForegroundWait();

      release.resolve();
      await steering;
      expect(h.session.getSteeringMessages()).toEqual(["latest transformed redirect"]);
      h.expectForegroundWait();
      await vi.advanceTimersByTimeAsync(80);
      await h.parentPrompt;
      await h.session.waitForIdle();
      expect(h.faux.state.callCount).toBe(2);
      expect(h.requests).toEqual([["Start a foreground worker", "latest transformed redirect"]]);
      expect(h.session.getLastAssistantText()).toBe("Parent received the queued input");
      expect(h.toolResults()).toHaveLength(1);
      expect(h.record()).toMatchObject({ status: "running", isBackground: true });
      expect(h.childSignal?.aborted).toBe(false);
    } finally {
      release.resolve();
      await steering;
    }
  });

  it("does not release a foreground wait when a later handler consumes steering without queueing", async () => {
    const h = await boot(pi => {
      pi.on("input", event => event.text === "local-only input" ? { action: "handled" } : undefined);
    });
    await h.session.prompt("local-only input", { streamingBehavior: "steer" });
    await vi.advanceTimersByTimeAsync(240);
    expect(h.session.pendingMessageCount).toBe(0);
    h.expectForegroundWait();
    h.finishChild();
    await h.parentPrompt;
    expect(h.toolResults()).toHaveLength(1);
    expect(h.record().isBackground).toBe(false);
    expect(h.requests).toEqual([["Start a foreground worker"]]);
  });

  it("keeps follow-up input queued behind the foreground worker instead of handing it off", async () => {
    const h = await boot();
    await h.session.prompt("wait until the worker finishes", { streamingBehavior: "followUp" });
    expect(h.session.getFollowUpMessages()).toEqual(["wait until the worker finishes"]);
    await vi.advanceTimersByTimeAsync(240);
    h.expectForegroundWait();
    // Avoid a separate, unrelated follow-up model turn during cleanup.
    h.session.clearQueue();
    h.finishChild();
    await h.parentPrompt;
    expect(h.toolResults()).toHaveLength(1);
    expect(h.record().isBackground).toBe(false);
  });
});
