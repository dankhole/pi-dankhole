import { describe, expect, it } from "vitest";
import { assertSupportedResumeParams, resolveAgentInvocationConfig, validateAgentConfig } from "../../src/workers/invocation-config.js";
import { BUILTIN_TOOL_NAMES } from "../../src/workers/tool-names.js";

describe("resolveAgentInvocationConfig", () => {
  it("uses explicit launch values without named configuration", () => {
    const result = resolveAgentInvocationConfig({
      model: "provider/model", thinking: "high", max_turns: 3,
      run_in_background: true, inherit_context: true, isolation: "worktree",
      instructions: "Review only", tools: ["read", "ext:mcp/search"],
      extensions: ["mcp"], skills: ["audit"],
      persist_session: false, output_transcript: false, session_dir: "sessions",
      memory: { scope: "project", key: "shared-audit" },
    });
    expect(result.modelInput).toBe("provider/model");
    expect(result.modelFromParams).toBe(true);
    expect(result.thinking).toBe("high");
    expect(result.maxTurns).toBe(3);
    expect(result.runInBackground).toBe(true);
    expect(result.inheritContext).toBe(true);
    expect(result.isolation).toBe("worktree");
    expect(result.config).toMatchObject({
      builtinToolNames: ["read"], extSelectors: ["ext:mcp/search"],
      instructions: "Review only", extensions: ["mcp"], skills: ["audit"],
      persistSession: false, outputTranscript: false, sessionDir: "sessions",
      memory: { scope: "project", key: "shared-audit" },
    });
  });

  it("defaults to inherited resources, all built-ins and no context fork", () => {
    const result = resolveAgentInvocationConfig({});
    expect(result.config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(result.config.extensions).toBe(true);
    expect(result.config.skills).toBe(true);
    expect(result.config.mcpStartup).toBe("inherit");
    expect(result.inheritContext).toBe(false);
    expect(result.isolated).toBe(false);
    expect(result.runInBackground).toBe(false);
    expect(resolveAgentInvocationConfig({}, { defaultRunInBackground: true }).runInBackground).toBe(true);
    expect(resolveAgentInvocationConfig({ run_in_background: false }, { defaultRunInBackground: true }).runInBackground).toBe(false);
  });

  it("retains the explicit MCP startup policy and validates direct and launch values", () => {
    for (const policy of ["inherit", "skip-unreachable"] as const) {
      expect(resolveAgentInvocationConfig({ mcp_startup: policy }).config.mcpStartup).toBe(policy);
      expect(() => validateAgentConfig({ extensions: true, skills: false, mcpStartup: policy })).not.toThrow();
    }
    for (const invalid of [true, [], null, "off"]) {
      expect(() => resolveAgentInvocationConfig({ mcp_startup: invalid as never })).toThrow("mcp_startup");
      expect(() => validateAgentConfig({ extensions: true, skills: false, mcpStartup: invalid as never })).toThrow("mcp_startup");
    }
  });

  it("keeps an explicit empty built-in scope", () => {
    expect(resolveAgentInvocationConfig({ tools: [] }).config.builtinToolNames).toEqual([]);
    expect(resolveAgentInvocationConfig({ tools: ["ext:mcp/search"] }).config.builtinToolNames).toEqual([]);
    expect(resolveAgentInvocationConfig({ tools: ["*", "read"] }).config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
  });

  it("isolates extensions and skills without dropping inherited instructions", () => {
    const result = resolveAgentInvocationConfig({
      isolated: true, extensions: ["mcp"], skills: ["audit"], tools: ["read", "ext:mcp/search"],
      instructions: "Keep parent rules",
    });
    expect(result.config).toMatchObject({
      extensions: false, skills: false, extSelectors: [],
      builtinToolNames: ["read"], instructions: "Keep parent rules",
    });
  });

  it("collapses off and honors the project worktree gate", () => {
    expect(resolveAgentInvocationConfig({ isolation: "off" }).isolation).toBeUndefined();
    expect(resolveAgentInvocationConfig({ isolation: "worktree" }, { worktreeAllowed: false }).isolation).toBeUndefined();
    expect(resolveAgentInvocationConfig({ isolation: "worktree" }, { worktreeAllowed: true }).isolation).toBe("worktree");
  });

  it("rejects malformed limits, thinking, tools and memory namespaces", () => {
    expect(() => resolveAgentInvocationConfig({ max_turns: -1 })).toThrow("max_turns");
    expect(() => resolveAgentInvocationConfig({ max_turns: 1.5 })).toThrow("max_turns");
    expect(resolveAgentInvocationConfig({ max_turns: 0 }).maxTurns).toBe(0);
    expect(() => resolveAgentInvocationConfig({ thinking: "turbo" })).toThrow("thinking");
    expect(() => resolveAgentInvocationConfig({ tools: ["reed"] })).toThrow("Unknown built-in tool");
    expect(() => resolveAgentInvocationConfig({ memory: { scope: "user", key: "../escape" } })).toThrow("memory");
    expect(() => resolveAgentInvocationConfig({ memory: false as never })).toThrow("memory");
    expect(() => resolveAgentInvocationConfig({ memory: { scope: "user", key: 42 } as never })).toThrow("memory");
  });

  it("copies selection arrays so retained config is not changed by the caller", () => {
    const extensions = ["mcp"];
    const skills = ["audit"];
    const result = resolveAgentInvocationConfig({ extensions, skills });
    extensions.push("other");
    skills.push("other");
    expect(result.config.extensions).toEqual(["mcp"]);
    expect(result.config.skills).toEqual(["audit"]);
  });
});

describe("direct configuration validation", () => {
  it("accepts normalized extension selectors and rejects malformed direct fields", () => {
    expect(() => validateAgentConfig({
      extensions: true, skills: true, builtinToolNames: [],
      extSelectors: ["ext:some-extension/exposure_direct", "ext:FOO"],
    })).not.toThrow();
    expect(() => validateAgentConfig({ extensions: false, skills: false, extSelectors: ["not-an-extension"] })).toThrow("extSelectors");
    expect(() => validateAgentConfig({ extensions: false, skills: false, builtinToolNames: ["*"] })).toThrow("builtinToolNames");
  });
});

describe("resume configuration", () => {
  it("accepts run controls but rejects unsupported launch overrides", () => {
    expect(() => assertSupportedResumeParams({ resume: "id", prompt: "continue", description: "Updated goal", max_turns: 2, run_in_background: false })).not.toThrow();
    for (const field of ["tools", "model", "instructions", "skills", "extensions", "memory", "isolation", "mcp_startup"]) {
      expect(() => assertSupportedResumeParams({ resume: "id", [field]: true })).toThrow(`Resume cannot override launch configuration: ${field}`);
    }
  });
});
