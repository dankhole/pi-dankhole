/** Ported from /tmp/review-w3b: results can arrive after our summary hook. */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../../src/workers/agent-runner.js";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../../src/workers/agent-runner.js";
import subagentsExtension from "../../src/workers/index.js";
import { type Hermetic, hermeticDir } from "./helpers/boot-extension.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const priorManager = Reflect.get(globalThis, MANAGER_KEY);
let environment: Hermetic | undefined;
const nextImmediate = () => new Promise<void>(resolve => setImmediate(resolve));

afterEach(() => {
  if (priorManager === undefined) Reflect.deleteProperty(globalThis, MANAGER_KEY);
  else Reflect.set(globalThis, MANAGER_KEY, priorManager);
  environment?.restore();
  environment = undefined;
  vi.mocked(runAgent).mockReset();
});

describe("post-summary completion window", () => {
  it.each([false, true])("delivers workers finishing inside a later terminal handler (tree: %s)", async tree => {
    environment = hermeticDir({ settings: { outputTranscript: false } });
    Reflect.deleteProperty(globalThis, MANAGER_KEY);
    const finishers = new Map<string, () => void>();
    vi.mocked(runAgent).mockImplementation((_config, prompt) => new Promise(resolve => {
      finishers.set(prompt, () => resolve({
        responseText: `${prompt} done`, session: { dispose: vi.fn(), messages: [] } as unknown as AgentSession,
        aborted: false, steered: false,
      }));
    }));
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    faux.setResponses(Array.from({ length: 16 }, () => fauxAssistantMessage(`Reply ${"filler ".repeat(300)}`)));
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 200 }, retry: { enabled: false },
    });
    let terminalIdle = false;
    const loader = new DefaultResourceLoader({
      cwd: environment.dir, agentDir: getAgentDir(), settingsManager,
      extensionFactories: [pi => {
        // Keep the real host lifecycle without executing shutdown's Git prune.
        vi.spyOn(pi, "exec").mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false });
        subagentsExtension(pi);
      }, pi => {
        const finishDuringCleanup = async (_event: unknown, context: { isIdle(): boolean }) => {
          // Pi 1.5.2 permits work from session_tree after installing the new
          // context; 1.4 retains busy state until all tree handlers return.
          terminalIdle = context.isIdle();
          if (!tree) expect(terminalIdle).toBe(false);
          finishers.get("alpha")!();
          await nextImmediate();
          finishers.get("beta")!();
          await nextImmediate();
          if (!tree) expect(context.isIdle()).toBe(false);
          await new Promise<void>(resolve => setTimeout(resolve, 25));
        };
        pi.on("session_compact", finishDuringCleanup);
        pi.on("session_tree", finishDuringCleanup);
      }],
      noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      ...fauxModelBackend(faux.getModel()), cwd: environment.dir, model: faux.getModel(),
      resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(environment.dir),
    });
    try {
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
      const originalSend = session.sendCustomMessage.bind(session);
      const send = vi.spyOn(session, "sendCustomMessage").mockImplementation((...args) => {
        expect(session.isIdle).toBe(true);
        return originalSend(...args);
      });
      // No worker has finished when our terminal hook opens the window. The
      // later handler finishes them; public-idle tree hooks may deliver each
      // immediately, while busy summary cleanup coalesces the two results.
      if (tree) await session.navigateTree(treeTarget, { summarize: true });
      else await session.compact();
      const expectedSends = terminalIdle ? 2 : 1;
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(expectedSends), { interval: 5, timeout: 1500 });
      await session.waitForIdle();
      const notifications = session.messages.filter(message => message.role === "custom" && message.customType === "subagent-notification");
      expect(notifications).toHaveLength(expectedSends);
      if (terminalIdle) {
        expect(notifications).toMatchObject([
          { details: { description: "alpha" } }, { details: { description: "beta" } },
        ]);
      } else {
        expect(notifications[0]).toMatchObject({
          details: expect.objectContaining({ description: "alpha", others: [expect.objectContaining({ description: "beta" })] }),
        });
      }
      await nextImmediate();
      expect(send).toHaveBeenCalledTimes(expectedSends);
      expect(session.isIdle).toBe(true);
    } finally {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      faux.unregister();
    }
  });
});
