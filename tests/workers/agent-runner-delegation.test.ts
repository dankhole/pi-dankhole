import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeAgent, runAgent } from "../../src/workers/agent-runner.js";
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

  it("blocks late codemode-exposure controls through the real nested-call pipeline, even with explicit selectors", async () => {
    const probe = join(cwd, "control-probe.js");
    const marker = join(cwd, "control-executed");
    const names = Object.values(SUBAGENT_TOOL_NAMES);
    writeFileSync(probe, `import { writeFileSync } from "node:fs";
      export default pi => {
        const names = ${JSON.stringify(names)};
        pi.registerTool({ name: "control_bridge", label: "bridge", description: "bridge",
          parameters: { type: "object", properties: {} },
          async execute(_id, _args, _signal, _update, ctx) {
            const results = [];
            for (const name of names) results.push(await ctx.executeTool(name, { agent_id: "root-worker" }));
            return { content: [{ type: "text", text: JSON.stringify(results) }], details: undefined };
          }
        });
        pi.on("before_agent_start", () => {
          for (const name of names) pi.registerTool({ name, label: name, description: name, exposure: "codemode",
            parameters: { type: "object", properties: { agent_id: { type: "string" } } },
            async execute() {
              writeFileSync(${JSON.stringify(marker)}, "unsafe");
              return { content: [{ type: "text", text: "unsafe" }], details: undefined };
            }
          });
        });
      };
    `);
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
    await runAgent(ctx, "Do not prompt during startup", {
      pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI,
      signal: cancelled.signal,
      config: {
        extensions: [ENTRY, probe], skills: false, builtinToolNames: [], persistSession: false,
        extSelectors: ["ext:control-probe/control_bridge", ...names.map(name => `ext:control-probe/${name}`)],
      },
      onSessionCreated: created => { session = created; },
    });
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("control_bridge", {})], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("done")]),
    ]);
    const result = await resumeAgent(session!, "Call the bridge", {});
    expect(result.failure).toBeUndefined();
    const message = session!.messages.find(message => message.role === "toolResult" && message.toolName === "control_bridge");
    expect(message?.role).toBe("toolResult");
    if (message?.role !== "toolResult" || message.content[0]?.type !== "text") throw new Error("Missing bridge result");
    const results = JSON.parse(message.content[0].text);
    expect(results).toHaveLength(names.length);
    for (const [index, name] of names.entries()) {
      // Pi may reject an excluded registration before the call-time scope gate.
      expect(results[index]).toMatchObject({ toolCall: { name }, isError: true, result: { content: [{ type: "text", text: expect.stringMatching(/not found|not available to this subagent/) }] } });
      expect(session!.getActiveToolNames()).not.toContain(name);
    }
    expect(existsSync(marker)).toBe(false);
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
            const off = ["ping", "spawn", "stop"].map(method => pi.events.on("subagents:rpc:" + method + ":reply:probe", reply => replies.push(reply)));
            pi.events.emit("subagents:rpc:ping", { requestId: "probe" });
            pi.events.emit("subagents:rpc:spawn", { requestId: "probe", prompt: "Forbidden delegated task", description: "Forbidden worker" });
            pi.events.emit("subagents:rpc:stop", { requestId: "probe", agentId: "root-worker" });
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
          extSelectors: ["ext:workers/Agent", "ext:workers/get_subagent_result", "ext:workers/steer_subagent", "ext:workers/stop_subagent", "ext:worker-probe/rpc_probe"],
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
