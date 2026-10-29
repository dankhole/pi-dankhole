import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext, McpExtensionOptions } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunOptions, resumeAgent, runAgent } from "../../src/workers/agent-runner.js";
import { resolveAgentInvocationConfig } from "../../src/workers/invocation-config.js";
import type { AgentConfig } from "../../src/workers/types.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

const mcp = vi.hoisted(() => ({ factory: vi.fn(), loadConfig: vi.fn() }));

// Keep the real resource loader, session, MCP factory and tool pipeline. Replace
// only MCP configuration input: never read real server settings or start clients.
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const host = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...host,
    createMcpExtension: () => {
      const factory = host.createMcpExtension({
        loadConfig: ctx => {
          mcp.loadConfig(ctx.isProjectTrusted(), ctx.cwd);
          return { servers: [], errors: [] };
        },
      } satisfies McpExtensionOptions);
      return ((pi: ExtensionAPI) => {
        mcp.factory();
        return factory(pi);
      });
    },
  };
});

describe("opt-in worker MCP startup policy (real loader and session)", () => {
  let cwd: string;
  let previousAgentDir: string | undefined;
  let faux: ReturnType<typeof registerFauxProvider>;
  let ctx: ExtensionContext;
  const sessions: AgentSession[] = [];
  const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "worker-mcp-policy-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "empty-agent-home");
    mcp.factory.mockClear();
    mcp.loadConfig.mockClear();
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    faux.setResponses(Array.from({ length: 8 }, () => () => fauxAssistantMessage([fauxText("done")])));
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    backend.modelRegistry.runtime = backend.modelRuntime;
    ctx = {
      cwd, model, modelRegistry: backend.modelRegistry,
      getSystemPrompt: () => "Inherited parent rules", isProjectTrusted: () => true,
    } as unknown as ExtensionContext;
    const extensionDir = join(cwd, ".pi", "extensions");
    mkdirSync(extensionDir, { recursive: true });
    // A third-party extension called mcp must not be mistaken for builtin:mcp.
    writeFileSync(join(extensionDir, "mcp.js"), `import { writeFileSync } from "node:fs";
      const tool = (name, execute, exposure) => ({
        name, label: name, description: name,
        parameters: { type: "object", properties: {} }, exposure,
        execute,
      });
      export default pi => {
        pi.registerTool(tool("policy_bridge", async (_id, _args, _signal, _update, ctx) => {
          const allowed = await ctx.executeTool("policy_allowed", {});
          const denied = await ctx.executeTool("mcp__fixture__denied", {});
          return { content: [{ type: "text", text: JSON.stringify({ allowed, denied }) }], details: undefined };
        }));
        pi.registerTool(tool("policy_allowed", async () => ({
          content: [{ type: "text", text: "allowed-body" }], details: undefined,
        }), "codemode"));
        pi.on("before_agent_start", () => {
          pi.registerTool(tool("mcp__fixture__denied", async () => {
            writeFileSync(${JSON.stringify(join(cwd, "denied-executed"))}, "unsafe");
            return { content: [{ type: "text", text: "denied-body" }], details: undefined };
          }, "codemode"));
        });
      };
    `);
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    faux.unregister();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  });

  async function createChild(config: Partial<AgentConfig> = {}, options: Pick<RunOptions, "cwd" | "configCwd" | "resumeSessionFile" | "onToolActivity"> = {}) {
    const cancelled = new AbortController();
    cancelled.abort();
    return runAgent(ctx, "Not prompted during startup", {
      pi, signal: cancelled.signal,
      config: { extensions: true, skills: false, builtinToolNames: [], persistSession: false, ...config },
      ...options,
      onSessionCreated: session => { sessions.push(session); },
    });
  }

  it.each([undefined, "inherit"] as const)("keeps default startup for policy %s despite an excluding tool scope", async mcpStartup => {
    await createChild({ mcpStartup, extSelectors: ["ext:mcp/policy_bridge"] });
    expect(mcp.factory).toHaveBeenCalledTimes(1);
    expect(mcp.loadConfig).toHaveBeenCalledWith(true, cwd);
  });

  it("skips the exact built-in factory before discovery while another mcp extension survives", async () => {
    const result = await createChild({ mcpStartup: "skip-unreachable", extSelectors: ["ext:mcp/policy_bridge"] });
    expect(mcp.factory).not.toHaveBeenCalled();
    expect(mcp.loadConfig).not.toHaveBeenCalled();
    expect(result.session.getActiveToolNames()).toEqual(["policy_bridge"]);
    const paths = result.session.resourceLoader.getExtensions().extensions.map(extension => extension.path);
    expect(paths).not.toContain("builtin:mcp");
    expect(paths).toContain("builtin:codemode");
    expect(paths).toContain("builtin:tool-search");
  });

  it("does not misreport an intentional skip as an explicit-loading typo", async () => {
    for (const loading of [
      { excludeExtensions: ["builtin:mcp"] },
      { extensions: ["builtin:mcp", join(cwd, ".pi", "extensions", "mcp.js")] },
    ]) {
      const activity: string[] = [];
      const result = await createChild({
        ...loading, mcpStartup: "skip-unreachable", extSelectors: ["ext:mcp/policy_bridge"],
      }, { onToolActivity: event => { activity.push(event.toolName); } });
      expect(activity.filter(name => name.startsWith("extension-error:"))).toEqual([]);
      expect(result.session.getActiveToolNames()).toContain("policy_bridge");
    }
    expect(mcp.factory).not.toHaveBeenCalled();
  });

  it("does not infer an extension allowlist from tools: [read]", async () => {
    const { config } = resolveAgentInvocationConfig({ tools: ["read"], mcp_startup: "skip-unreachable" });
    const result = await createChild(config);
    expect(mcp.factory).toHaveBeenCalledTimes(1);
    expect(result.session.getActiveToolNames()).toContain("policy_bridge");
    expect(result.session.getActiveToolNames()).toContain("read");
  });

  it.each(["ext:builtin:mcp", "ext:BUILTIN:MCP/mcp__fixture__lookup"])("retains startup when its owner is admitted by %s", async selector => {
    await createChild({ mcpStartup: "skip-unreachable", extSelectors: [selector] });
    expect(mcp.factory).toHaveBeenCalledTimes(1);
    expect(mcp.loadConfig).toHaveBeenCalledTimes(1);
  });

  it.each([
    { isolated: true },
    { extensions: false },
    { excludeExtensions: ["builtin:mcp"] },
  ] satisfies Partial<AgentConfig>[])("preserves explicit loading exclusions: %j", async excluded => {
    await createChild({ ...excluded, mcpStartup: "skip-unreachable", extSelectors: ["ext:builtin:mcp"] });
    expect(mcp.loadConfig).not.toHaveBeenCalled();
  });

  it("does not change cross-directory trust or the inherited extension source", async () => {
    const target = join(cwd, "target");
    mkdirSync(target);
    const first = await createChild({ mcpStartup: "skip-unreachable" }, { cwd: target, configCwd: cwd });
    expect(mcp.loadConfig).toHaveBeenCalledWith(false, target);
    expect(first.session.getActiveToolNames()).toContain("policy_bridge");
    mcp.factory.mockClear();
    const skipped = await createChild({ mcpStartup: "skip-unreachable", extSelectors: ["ext:mcp/policy_bridge"] }, { cwd: target, configCwd: cwd });
    expect(mcp.factory).not.toHaveBeenCalled();
    expect(skipped.session.getActiveToolNames()).toContain("policy_bridge");
  });

  it("still gates late tools reached through the real nested-call pipeline", async () => {
    const { session } = await createChild({
      mcpStartup: "skip-unreachable", extSelectors: ["ext:mcp/policy_bridge", "ext:mcp/policy_allowed"],
    });
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("policy_bridge", {})], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("done")]),
    ]);
    const result = await resumeAgent(session, "Call the bridge", {});
    expect(result.failure).toBeUndefined();
    const message = session.messages.find(message => message.role === "toolResult" && message.toolName === "policy_bridge");
    expect(message).toBeDefined();
    expect(JSON.stringify(message)).toContain("allowed-body");
    expect(JSON.stringify(message)).toContain('not available to this subagent');
    expect(existsSync(join(cwd, "denied-executed"))).toBe(false);
    expect(session.getActiveToolNames()).not.toContain("mcp__fixture__denied");
    expect(mcp.factory).not.toHaveBeenCalled();
  });

  it("keeps the same saved policy on live resume and session-file reopen", async () => {
    const { config } = resolveAgentInvocationConfig({
      mcp_startup: "skip-unreachable", tools: ["ext:mcp/policy_bridge"],
      persist_session: true, session_dir: join(cwd, "sessions"),
    });
    const first = await createChild(config);
    await resumeAgent(first.session, "Initial saved message", {});
    const snapshot = join(cwd, "saved.jsonl");
    copyFileSync(first.session.sessionManager.getSessionFile()!, snapshot);
    await resumeAgent(first.session, "Live continuation", {});
    const reopened = await createChild(config, { resumeSessionFile: snapshot });
    await resumeAgent(reopened.session, "Reopened continuation", {});
    expect(reopened.session.getActiveToolNames()).toContain("policy_bridge");
    expect(mcp.factory).not.toHaveBeenCalled();
    expect(mcp.loadConfig).not.toHaveBeenCalled();
    expect(config.mcpStartup).toBe("skip-unreachable");
  });
});
