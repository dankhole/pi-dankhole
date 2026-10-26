/** In-process generic worker RPC. Lifecycle events and manager lookup are independent. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpawnOptions } from "./agent-manager.js";
import { type AgentInvocationParams, resolveAgentInvocationConfig } from "./invocation-config.js";
import { resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import type { AgentRecord } from "./types.js";
import { isWorktreeIsolationEnabled } from "./worktree.js";

export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}
export type RpcReply<T = void> = { success: true; data?: T } | { success: false; error: string };
/** Version 3 removes type dispatch; spawn uses the flat launch fields. */
export const PROTOCOL_VERSION = 3;

export interface SpawnCapable {
  spawn(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string, options: SpawnOptions): string;
  awaitStartup(id: string): Promise<void>;
  abort(id: string): boolean;
  getRecord(id: string): Pick<AgentRecord, "id"> | undefined;
  consumeResult(id: string): boolean;
  steer(id: string, message: string): boolean;
}
export interface RpcDeps {
  events: EventBus;
  pi: ExtensionAPI;
  getCtx: () => ExtensionContext | undefined;
  manager: SpawnCapable;
}
export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
  unsubConsume: () => void;
  unsubSteer: () => void;
}

function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false, error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;
  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => ({ version: PROTOCOL_VERSION }));
  const unsubSpawn = handleRpc<AgentInvocationParams & { requestId: string; prompt: string; description: string; cwd?: string }>(
    events, "subagents:rpc:spawn", async params => {
      const ctx = getCtx();
      if (!ctx) throw new Error("No active session");
      if (typeof params.prompt !== "string" || !params.prompt.trim()) throw new Error("Worker prompt must be a non-empty string");
      if (typeof params.description !== "string" || !params.description.trim()) throw new Error("A new worker requires a short description");
      const invocation = resolveAgentInvocationConfig(params, {
        worktreeAllowed: isWorktreeIsolationEnabled(), defaultRunInBackground: true,
      });
      let model: typeof ctx.model;
      if (invocation.modelInput !== undefined) {
        if (!ctx.modelRegistry) throw new Error(`Model override "${invocation.modelInput}" provided but ctx.modelRegistry is unavailable`);
        const resolved = resolveModel(invocation.modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") throw new Error(resolved);
        model = resolved;
        const scope = checkModelScope({
          model, cwd: ctx.cwd, modelRegistry: ctx.modelRegistry, callerSupplied: true,
          agentLabel: params.description, modelInput: invocation.modelInput,
        });
        if (scope.kind === "error") throw new Error(scope.message);
      }
      const id = manager.spawn(pi, ctx, params.prompt, {
        description: params.description,
        config: invocation.config,
        model,
        modelFromParams: invocation.modelFromParams,
        cwd: params.cwd,
        isBackground: invocation.runInBackground,
      });
      await manager.awaitStartup(id);
      return { id };
    },
  );
  const assertExists = (agentId: string) => {
    const record = manager.getRecord(agentId);
    if (!record) throw new Error("Agent not found");
  };
  const unsubStop = handleRpc<{ requestId: string; agentId: string }>(events, "subagents:rpc:stop", ({ agentId }) => {
    assertExists(agentId);
    if (!manager.abort(agentId)) throw new Error("Agent is not running");
  });
  const unsubConsume = handleRpc<{ requestId: string; agentId: string }>(events, "subagents:rpc:consume", ({ agentId }) => {
    assertExists(agentId);
    if (!manager.consumeResult(agentId)) throw new Error("Agent not found or still running");
  });
  const unsubSteer = handleRpc<{ requestId: string; agentId: string; message: unknown }>(events, "subagents:rpc:steer", ({ agentId, message }) => {
    if (typeof message !== "string" || !message.trim()) throw new Error("Steer message must be a non-empty string");
    assertExists(agentId);
    if (!manager.steer(agentId, message)) throw new Error("Agent is not running");
  });
  return { unsubPing, unsubSpawn, unsubStop, unsubConsume, unsubSteer };
}
