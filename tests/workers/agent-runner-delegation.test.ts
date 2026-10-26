import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/workers/agent-runner.js";
import { SUBAGENT_TOOL_NAMES } from "../../src/workers/tool-names.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

const ENTRY = fileURLToPath(new URL("../../src/workers/index.ts", import.meta.url));
const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;

/** Real extension loading must never reactivate worker delegation or RPC. */
describe("worker delegation boundary (real runtime)", () => {
  let cwd: string;
  let agentDirBefore: string | undefined;
  let registryBefore: unknown;
  let faux: ReturnType<typeof registerFauxProvider>;
  let session: AgentSession | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "worker-delegation-"));
    agentDirBefore = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-home");
    registryBefore = globals[MANAGER_KEY];
    delete globals[MANAGER_KEY];
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(async () => {
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    session = undefined;
    faux.unregister();
    if (registryBefore === undefined) delete globals[MANAGER_KEY];
    else globals[MANAGER_KEY] = registryBefore;
    if (agentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = agentDirBefore;
    rmSync(cwd, { recursive: true, force: true });
  });

  for (const discovery of ["explicit", "default"] as const) {
    it.each([false, true])(`${discovery} loading cannot expose delegation or RPC (root registry present: %s)`, async rootPresent => {
      const rootSpawn = vi.fn();
      const root = rootPresent ? { spawn: rootSpawn, getRecord: vi.fn() } : undefined;
      if (root) globals[MANAGER_KEY] = root;
      const extensionDir = join(cwd, ".pi", "extensions");
      mkdirSync(extensionDir, { recursive: true });
      const probe = join(extensionDir, "worker-probe.js");
      writeFileSync(probe, `export default pi => {
        pi.registerTool({
          name: "rpc_probe", label: "RPC probe", description: "Inspect this worker's bus",
          parameters: { type: "object", properties: {} },
          async execute() {
            const replies = [];
            const off = ["ping", "spawn"].map(method => pi.events.on("subagents:rpc:" + method + ":reply:probe", reply => replies.push(reply)));
            pi.events.emit("subagents:rpc:ping", { requestId: "probe" });
            pi.events.emit("subagents:rpc:spawn", { requestId: "probe", prompt: "Forbidden delegated task", description: "Forbidden worker" });
            await new Promise(resolve => setTimeout(resolve, 30));
            off.forEach(unsubscribe => unsubscribe());
            return { content: [{ type: "text", text: JSON.stringify(replies) }], details: {} };
          }
        });
      };`);
      if (discovery === "default") {
        writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: [ENTRY] }));
      }
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      backend.modelRegistry.runtime = backend.modelRuntime;
      const ctx = {
        cwd, model, modelRegistry: backend.modelRegistry,
        getSystemPrompt: () => "Inherited rules", isProjectTrusted: () => true,
        sessionManager: SessionManager.inMemory(cwd),
      } as unknown as ExtensionContext;
      const cancelled = new AbortController();
      cancelled.abort();
      await runAgent(ctx, "Do not delegate", {
        pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI,
        signal: cancelled.signal,
        config: {
          extensions: discovery === "explicit" ? [ENTRY, probe] : true,
          extSelectors: ["ext:workers/Agent", "ext:workers/get_subagent_result", "ext:workers/steer_subagent", "ext:worker-probe/rpc_probe"],
          skills: false, builtinToolNames: [], persistSession: false,
        },
        onSessionCreated: created => { session = created; },
      });

      expect(session!.getActiveToolNames()).toEqual(["rpc_probe"]);
      for (const name of Object.values(SUBAGENT_TOOL_NAMES)) {
        expect(session!.getAllTools().map(tool => tool.name)).not.toContain(name);
        expect(session!.getCallableToolNames()).not.toContain(name);
      }
      const result = await session!.getToolDefinition("rpc_probe")!.execute("probe", {}, undefined, undefined, ctx);
      expect(result.content).toEqual([{ type: "text", text: "[]" }]);
      expect(globals[MANAGER_KEY]).toBe(root);
      await session!.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      expect(globals[MANAGER_KEY]).toBe(root);
      expect(rootSpawn).not.toHaveBeenCalled();
    });
  }
});
