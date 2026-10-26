import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EventBus, PROTOCOL_VERSION, type RpcDeps, registerRpcHandlers, type SpawnCapable } from "../../src/workers/cross-extension-rpc.js";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "../../src/workers/model-scope.js";

function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => { listeners.get(event)?.delete(handler); };
    },
    emit(event, data) { for (const handler of listeners.get(event) ?? []) handler(data); },
  };
}

describe("generic worker RPC", () => {
  let events: EventBus;
  let manager: SpawnCapable;
  let ctx: ExtensionContext | undefined;
  let deps: RpcDeps;
  const MODEL = { id: "gpt-5.5", provider: "openai-codex", name: "GPT 5.5" };
  const BLOCKED = { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" };
  const models = [MODEL, BLOCKED];
  const registry = {
    find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
    getAll: () => models,
    getAvailable: () => models,
  };

  beforeEach(() => {
    events = createEventBus();
    manager = {
      spawn: vi.fn().mockReturnValue("agent-42"),
      awaitStartup: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockReturnValue(true), getRecord: vi.fn().mockReturnValue({ id: "id" }),
      consumeResult: vi.fn().mockReturnValue(true), steer: vi.fn().mockReturnValue(true),
    };
    ctx = { cwd: process.cwd(), modelRegistry: registry } as unknown as ExtensionContext;
    deps = { events, pi: { events } as unknown as ExtensionAPI, getCtx: () => ctx, manager };
  });

  async function request(method: string, params: Record<string, unknown> = {}) {
    const reply = vi.fn();
    const requestId = String(params.requestId ?? "req");
    events.on(`subagents:rpc:${method}:reply:${requestId}`, reply);
    events.emit(`subagents:rpc:${method}`, { requestId, ...params });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    return reply.mock.calls[0][0];
  }
  const spawn = (params: Record<string, unknown> = {}) => request("spawn", { prompt: "do stuff", description: "Inspect code", ...params });

  it("advertises the breaking generic-spawn protocol explicitly", async () => {
    registerRpcHandlers(deps);
    expect(PROTOCOL_VERSION).toBe(3);
    expect(await request("ping")).toEqual({ success: true, data: { version: 3 } });
  });

  it("normalizes flat launch options and returns the stable id", async () => {
    registerRpcHandlers(deps);
    expect(await spawn({ tools: ["read"], extensions: false, run_in_background: true })).toEqual({ success: true, data: { id: "agent-42" } });
    expect(manager.spawn).toHaveBeenCalledWith(deps.pi, ctx, "do stuff", expect.objectContaining({
      description: "Inspect code", isBackground: true,
      config: expect.objectContaining({ builtinToolNames: ["read"], extensions: false }),
    }));
    expect(manager.awaitStartup).toHaveBeenCalledWith("agent-42");
  });

  it("preserves cwd but does not forward internal resume paths", async () => {
    registerRpcHandlers(deps);
    await spawn({ cwd: "/tmp", configCwd: "/evil", resumeSessionFile: "/private/session", blocking: true });
    const options = vi.mocked(manager.spawn).mock.calls[0][3];
    expect(options.cwd).toBe("/tmp");
    for (const key of ["configCwd", "resumeSessionFile", "blocking"]) expect(options).not.toHaveProperty(key);
  });

  it("requires a prompt and sole visible description", async () => {
    registerRpcHandlers(deps);
    expect(await spawn({ prompt: "" })).toMatchObject({ success: false, error: expect.stringContaining("prompt") });
    expect(await spawn({ description: "" })).toMatchObject({ success: false, error: expect.stringContaining("description") });
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("fails before spawning without an active session", async () => {
    ctx = undefined;
    registerRpcHandlers(deps);
    expect(await spawn()).toEqual({ success: false, error: "No active session" });
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it.each(["spawn", "awaitStartup"] as const)("surfaces %s failures in the error envelope", async method => {
    if (method === "spawn") vi.mocked(manager.spawn).mockImplementation(() => { throw new Error("startup failed"); });
    else vi.mocked(manager.awaitStartup).mockRejectedValue(new Error("startup failed"));
    registerRpcHandlers(deps);
    expect(await spawn()).toEqual({ success: false, error: "startup failed" });
  });

  it("isolates concurrent requests and their reply channels", async () => {
    vi.mocked(manager.spawn).mockReturnValueOnce("first").mockReturnValueOnce("second");
    registerRpcHandlers(deps);
    const other = vi.fn();
    events.on("subagents:rpc:spawn:reply:other", other);
    const results = await Promise.all([spawn({ requestId: "a" }), spawn({ requestId: "b" })]);
    expect(results).toEqual([{ success: true, data: { id: "first" } }, { success: true, data: { id: "second" } }]);
    expect(other).not.toHaveBeenCalled();
  });

  for (const [method, unsubscribe] of [["ping", "unsubPing"], ["spawn", "unsubSpawn"], ["stop", "unsubStop"], ["consume", "unsubConsume"], ["steer", "unsubSteer"]] as const) {
    it(`unsubscribes ${method} independently`, async () => {
      const handles = registerRpcHandlers(deps);
      handles[unsubscribe]();
      const reply = vi.fn();
      events.on(`subagents:rpc:${method}:reply:req`, reply);
      events.emit(`subagents:rpc:${method}`, { requestId: "req", agentId: "id", prompt: "task", description: "Goal", message: "change" });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  }

  for (const method of ["stop", "consume", "steer"] as const) {
    it(`${method} requires an existing record`, async () => {
      registerRpcHandlers(deps);
      expect(await request(method, { agentId: "id", message: "change" })).toEqual({ success: true });
      vi.mocked(manager.getRecord).mockReturnValue(undefined);
      expect(await request(method, { agentId: "missing", message: "change" })).toEqual({ success: false, error: "Agent not found" });
    });
  }

  it("distinguishes settled records from missing records", async () => {
    vi.mocked(manager.abort).mockReturnValue(false);
    vi.mocked(manager.steer).mockReturnValue(false);
    vi.mocked(manager.consumeResult).mockReturnValue(false);
    registerRpcHandlers(deps);
    expect(await request("stop", { agentId: "id" })).toEqual({ success: false, error: "Agent is not running" });
    expect(await request("steer", { agentId: "id", message: "change" })).toEqual({ success: false, error: "Agent is not running" });
    expect(await request("consume", { agentId: "id" })).toEqual({ success: false, error: "Agent not found or still running" });
  });

  it.each(["  ", 42, undefined])("rejects an invalid steer message %s", async message => {
    registerRpcHandlers(deps);
    expect(await request("steer", { agentId: "id", message })).toEqual({ success: false, error: "Steer message must be a non-empty string" });
    expect(manager.steer).not.toHaveBeenCalled();
  });

  it("resolves string models before spawning", async () => {
    registerRpcHandlers(deps);
    expect(await spawn({ model: "openai-codex/gpt-5.5" })).toMatchObject({ success: true });
    expect(vi.mocked(manager.spawn).mock.calls[0][3].model).toBe(MODEL);
  });

  it("derives model provenance instead of forwarding caller-supplied flags", async () => {
    registerRpcHandlers(deps);
    await spawn({ model: "openai-codex/gpt-5.5", modelFromParams: false });
    expect(vi.mocked(manager.spawn).mock.calls[0][3].modelFromParams).toBe(true);
    await spawn({ modelFromParams: true });
    expect(vi.mocked(manager.spawn).mock.calls[1][3].modelFromParams).toBe(false);
  });

  it.each([null, MODEL])("rejects non-string models in the flat wire contract", async model => {
    registerRpcHandlers(deps);
    expect(await spawn({ model })).toEqual({ success: false, error: "model must be a string" });
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("reports an unavailable model", async () => {
    registerRpcHandlers(deps);
    expect(await spawn({ model: "nope/not-real" })).toMatchObject({ success: false, error: expect.stringContaining("Model not found") });
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  describe("model scope", () => {
    let cwd: string;
    let agentDir: string;
    let oldDir: string | undefined;
    let enabled: boolean;
    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), "worker-rpc-project-"));
      agentDir = mkdtempSync(join(tmpdir(), "worker-rpc-global-"));
      oldDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      enabled = isScopeModelsEnabled();
      setScopeModelsEnabled(true);
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["openai-codex/gpt-5.5"] }));
      ctx = { cwd, modelRegistry: registry } as unknown as ExtensionContext;
    });
    afterEach(() => {
      setScopeModelsEnabled(enabled);
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    });
    it("rejects a fuzzy-resolved out-of-scope model before spawn", async () => {
      registerRpcHandlers(deps);
      expect(await spawn({ model: "sonnet", modelFromParams: false })).toMatchObject({ success: false, error: expect.stringContaining("Model not in scope") });
      expect(manager.spawn).not.toHaveBeenCalled();
    });
    it("accepts an in-scope model and permits overrides when enforcement is disabled", async () => {
      registerRpcHandlers(deps);
      expect(await spawn({ model: "openai-codex/gpt-5.5" })).toMatchObject({ success: true });
      setScopeModelsEnabled(false);
      expect(await spawn({ model: "sonnet" })).toMatchObject({ success: true });
      expect(vi.mocked(manager.spawn).mock.calls[1][3].model).toBe(BLOCKED);
    });
  });
});
