import { Type } from "typebox";
import { isUnsafeName } from "./memory.js";
import { BUILTIN_TOOL_NAMES } from "./tool-names.js";
import type { AgentConfig, IsolationMode, McpStartupPolicy, ThinkingLevel } from "./types.js";

const isolationParamShape = {
  isolation: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("worktree")], {
    description: 'Isolation mode. Default "off". "worktree" creates an isolated git copy that cannot see uncommitted or staged changes in the current checkout.',
  })),
};

export function isolationParam(enabled: boolean): Partial<typeof isolationParamShape> {
  return enabled ? isolationParamShape : {};
}

const selection = () => Type.Union([Type.Boolean(), Type.Array(Type.String())]);

/** Advanced flat launch fields for the Agent schema. */
export function launchConfigParams() {
  return {
    tools: Type.Optional(Type.Array(Type.String(), { description: 'Built-in tools and ext:extension/tool selectors. Omit for all built-ins; [] for no built-ins. Extensions load independently.' })),
    disallowed_tools: Type.Optional(Type.Array(Type.String())),
    extensions: Type.Optional(selection()),
    exclude_extensions: Type.Optional(Type.Array(Type.String())),
    mcp_startup: Type.Optional(Type.Union([Type.Literal("inherit"), Type.Literal("skip-unreachable")], {
      description: 'Default "inherit". "skip-unreachable" skips builtin:mcp connections, resources and commands only when an explicit ext: tool allowlist excludes that owner; other extensions are unchanged.',
    })),
    skills: Type.Optional(selection()),
    instructions: Type.Optional(Type.String({ description: "Additional instructions appended after inherited parent system rules." })),
    persist_session: Type.Optional(Type.Boolean()),
    output_transcript: Type.Optional(Type.Boolean()),
    session_dir: Type.Optional(Type.String()),
    memory: Type.Optional(Type.Object({
      scope: Type.Union([Type.Literal("project"), Type.Literal("local"), Type.Literal("user")]),
      key: Type.String({ description: "Explicit shared memory namespace; not derived from the task description." }),
    })),
  };
}

export interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
  isolated?: boolean;
  isolation?: unknown;
  tools?: string[];
  disallowed_tools?: string[];
  extensions?: boolean | string[];
  exclude_extensions?: string[];
  mcp_startup?: McpStartupPolicy;
  skills?: boolean | string[];
  instructions?: string;
  persist_session?: boolean;
  output_transcript?: boolean;
  session_dir?: string;
  memory?: { scope: "project" | "local" | "user"; key: string };
}

interface ResolveOptions {
  worktreeAllowed?: boolean;
  defaultRunInBackground?: boolean;
}

/** Explicit launch values win; there are no named definitions or locked pins. */
export function resolveAgentInvocationConfig(params: AgentInvocationParams, opts?: ResolveOptions) {
  for (const key of ["tools", "disallowed_tools", "exclude_extensions"] as const) {
    const value = params[key];
    if (value !== undefined && (!Array.isArray(value) || value.some(entry => typeof entry !== "string"))) {
      throw new Error(`${key} must be an array of strings`);
    }
  }
  for (const key of ["extensions", "skills"] as const) {
    const value = params[key];
    if (value !== undefined && typeof value !== "boolean" && (!Array.isArray(value) || value.some(entry => typeof entry !== "string"))) {
      throw new Error(`${key} must be a boolean or array of strings`);
    }
  }
  for (const key of ["run_in_background", "inherit_context", "isolated", "persist_session", "output_transcript"] as const) {
    if (params[key] !== undefined && typeof params[key] !== "boolean") throw new Error(`${key} must be a boolean`);
  }
  for (const key of ["model", "instructions", "session_dir"] as const) {
    if (params[key] !== undefined && typeof params[key] !== "string") throw new Error(`${key} must be a string`);
  }
  if (params.mcp_startup !== undefined && params.mcp_startup !== "inherit" && params.mcp_startup !== "skip-unreachable") {
    throw new Error('mcp_startup must be "inherit" or "skip-unreachable"');
  }
  if (params.isolation !== undefined && params.isolation !== "off" && params.isolation !== "worktree") throw new Error('isolation must be "off" or "worktree"');
  if (params.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(params.thinking)) {
    throw new Error(`Invalid thinking level: "${params.thinking}"`);
  }
  if (params.max_turns !== undefined && (!Number.isInteger(params.max_turns) || params.max_turns < 0)) {
    throw new Error("max_turns must be a non-negative integer (0 means unlimited)");
  }
  if (params.memory !== undefined && (!params.memory || typeof params.memory !== "object"
    || !["project", "local", "user"].includes(params.memory.scope)
    || typeof params.memory.key !== "string" || isUnsafeName(params.memory.key))) {
    throw new Error("memory requires a valid scope and a safe, explicit key");
  }
  const builtinToolNames: string[] = [];
  const extSelectors: string[] = [];
  for (const name of params.tools ?? ["*"]) {
    if (name === "*" || name === "all") builtinToolNames.push(...BUILTIN_TOOL_NAMES);
    else if (name.startsWith("ext:") && name.length > 4) extSelectors.push(name);
    else if (BUILTIN_TOOL_NAMES.includes(name)) builtinToolNames.push(name);
    else throw new Error(`Unknown built-in tool: "${name}"`);
  }
  const isolated = params.isolated ?? false;
  const isolation: IsolationMode | undefined = params.isolation === "worktree" && opts?.worktreeAllowed !== false
    ? "worktree" : undefined;
  const thinking = params.thinking as ThinkingLevel | undefined;
  const runInBackground = params.run_in_background ?? opts?.defaultRunInBackground ?? false;
  const inheritContext = params.inherit_context ?? false;
  const config: AgentConfig = {
    builtinToolNames: [...new Set(builtinToolNames)],
    extSelectors: isolated ? [] : extSelectors,
    disallowedTools: params.disallowed_tools?.slice(),
    extensions: isolated ? false : Array.isArray(params.extensions) ? params.extensions.slice() : params.extensions ?? true,
    excludeExtensions: isolated ? undefined : params.exclude_extensions?.slice(),
    mcpStartup: params.mcp_startup ?? "inherit",
    skills: isolated ? false : Array.isArray(params.skills) ? params.skills.slice() : params.skills ?? true,
    instructions: params.instructions,
    persistSession: params.persist_session,
    outputTranscript: params.output_transcript,
    sessionDir: params.session_dir,
    memory: params.memory ? { ...params.memory } : undefined,
    model: params.model,
    thinking,
    maxTurns: params.max_turns,
    runInBackground,
    inheritContext,
    isolated,
    isolation,
  };
  return {
    config,
    modelInput: params.model,
    modelFromParams: params.model !== undefined,
    thinking,
    maxTurns: params.max_turns,
    inheritContext,
    runInBackground,
    isolated,
    isolation,
  };
}

/** Validate direct runtime configuration before a manager creates any record. */
export function validateAgentConfig(config: AgentConfig): void {
  if (config.builtinToolNames !== undefined && (!Array.isArray(config.builtinToolNames)
    || config.builtinToolNames.some(name => !BUILTIN_TOOL_NAMES.includes(name)))) {
    throw new Error("builtinToolNames must contain only known built-in tool names");
  }
  if (config.extSelectors !== undefined && (!Array.isArray(config.extSelectors)
    || config.extSelectors.some(selector => typeof selector !== "string" || !/^ext:[^/\s]+(?:\/[^/\s]+)?$/.test(selector)))) {
    throw new Error("extSelectors must contain valid ext:extension[/tool] selectors");
  }
  resolveAgentInvocationConfig({
    model: config.model,
    thinking: config.thinking,
    max_turns: config.maxTurns,
    run_in_background: config.runInBackground,
    inherit_context: config.inheritContext,
    isolated: config.isolated,
    isolation: config.isolation,
    extensions: config.extensions,
    exclude_extensions: config.excludeExtensions,
    mcp_startup: config.mcpStartup,
    skills: config.skills,
    disallowed_tools: config.disallowedTools,
    instructions: config.instructions,
    persist_session: config.persistSession,
    output_transcript: config.outputTranscript,
    session_dir: config.sessionDir,
    memory: config.memory,
  });
}

/** A continuation keeps the original session's tools, rules and model. */
export function assertSupportedResumeParams(params: Record<string, unknown>): void {
  const allowed = new Set(["resume", "prompt", "description", "run_in_background", "max_turns"]);
  const unsupported = Object.keys(params).filter(key => params[key] !== undefined && !allowed.has(key));
  if (unsupported.length) throw new Error(`Resume cannot override launch configuration: ${unsupported.join(", ")}. Start a new worker instead.`);
}
