import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../../src/workers/prompts.js";
import type { AgentConfig, EnvInfo } from "../../src/workers/types.js";

const env: EnvInfo = { isGitRepo: true, branch: "main", platform: "darwin" };
const config: AgentConfig = { extensions: true, skills: true };

describe("buildAgentPrompt", () => {
  it("includes cwd and git info", () => {
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("darwin");
  });

  it("handles non-git repos", () => {
    const prompt = buildAgentPrompt(config, "/workspace", { isGitRepo: false, branch: "", platform: "linux" });
    expect(prompt).toContain("Not a git repository");
    expect(prompt).not.toContain("Branch:");
  });

  it("preserves the inherited system rules as a verbatim cacheable prefix", () => {
    const parent = "System rules.\nNever disclose credentials.\n";
    const prompt = buildAgentPrompt(config, "/workspace", env, parent);
    expect(prompt.startsWith(parent)).toBe(true);
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("appends read-only instructions rather than selecting a named profile", () => {
    const prompt = buildAgentPrompt({ ...config, instructions: "READ-ONLY: do not modify files." }, "/workspace", env, "Parent rules.");
    expect(prompt.startsWith("Parent rules.")).toBe(true);
    expect(prompt).toContain("READ-ONLY: do not modify files.");
    expect(prompt).toContain("<agent_instructions>");
  });

  it("keeps inherited rules even when instructions request a different role", () => {
    const prompt = buildAgentPrompt({ ...config, instructions: "You are a specialized agent." }, "/workspace", env, "Never expose SECRET.");
    expect(prompt.startsWith("Never expose SECRET.")).toBe(true);
    expect(prompt).toContain("You are a specialized agent.");
    expect(prompt.indexOf("<agent_instructions>")).toBeGreaterThan(prompt.indexOf("<sub_agent_context>"));
  });

  it("uses a generic fallback when there is no parent prompt", () => {
    const prompt = buildAgentPrompt({ ...config, instructions: "Extra instructions." }, "/workspace", env);
    expect(prompt).toContain("coding assistant");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).toContain("Extra instructions.");
  });

  it.each([undefined, "", "  \n\t"])("omits empty instructions (%j)", (instructions) => {
    const prompt = buildAgentPrompt({ ...config, instructions }, "/workspace", env, "Parent rules.");
    expect(prompt.startsWith("Parent rules.")).toBe(true);
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("reminds the worker of inherited authorization boundaries", () => {
    const prompt = buildAgentPrompt(config, "/workspace", env, "Parent rules.");
    expect(prompt).toContain("inherited rules and authorization boundaries");
    expect(prompt).toContain("Do not delegate. Report further work or coordination needs to the main agent.");
    expect(prompt).toContain("absolute file paths");
  });

  it("asks for an outcome-first final summary without overriding task-specific formats", () => {
    const prompt = buildAgentPrompt(config, "/workspace", env, "Parent rules.");
    expect(prompt).toContain("Unless the task requires a specific output format");
    expect(prompt).toContain("open your final response with 1–2 short sentences");
    expect(prompt).toContain("the concrete outcome or findings, then verification and any unresolved limitation");
    expect(prompt).toContain("Put supporting details afterward");
    expect(prompt).toContain("do not claim checks you did not run");
  });

  it("does not invent a profile identity", () => {
    const prompt = buildAgentPrompt(config, "/workspace", env, "Parent rules.");
    expect(prompt).not.toContain("<active_agent");
    expect(prompt).not.toContain("READ-ONLY");
  });

  it("injects memory without replacing the inherited prefix", () => {
    const prompt = buildAgentPrompt({ ...config, instructions: "Use memory." }, "/workspace", env, "Parent rules.", {
      memoryBlock: "# Agent Memory\nPersistent memory at /tmp/mem/.",
    });
    expect(prompt.startsWith("Parent rules.")).toBe(true);
    expect(prompt).toContain("Use memory.");
    expect(prompt).toContain("# Agent Memory");
    expect(prompt).toContain("Persistent memory at /tmp/mem/");
  });

  it("injects preloaded skill blocks", () => {
    const prompt = buildAgentPrompt(config, "/workspace", env, undefined, {
      skillBlocks: [
        { name: "api-conventions", content: "Use REST endpoints." },
        { name: "error-handling", content: "Handle errors gracefully." },
      ],
    });
    expect(prompt).toContain("Preloaded Skill: api-conventions");
    expect(prompt).toContain("Use REST endpoints.");
    expect(prompt).toContain("Preloaded Skill: error-handling");
    expect(prompt).toContain("Handle errors gracefully.");
  });

  it("composes memory and skills", () => {
    const prompt = buildAgentPrompt(config, "/workspace", env, "Parent rules.", {
      memoryBlock: "# Memory\nRemember this.",
      skillBlocks: [{ name: "skill1", content: "Skill content." }],
    });
    expect(prompt.startsWith("Parent rules.")).toBe(true);
    expect(prompt).toContain("# Memory");
    expect(prompt).toContain("Preloaded Skill: skill1");
  });

  it("omits extra sections when none are supplied", () => {
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).not.toContain("Agent Memory");
    expect(prompt).not.toContain("Preloaded Skill");
  });

  describe("worktree isolation block", () => {
    it("is absent without a worktree base", () => {
      expect(buildAgentPrompt(config, "/wt/copy", env, "Parent.", {})).not.toContain("<worktree_isolation>");
    });

    it("names the parent checkout and follows the actual working directory", () => {
      const prompt = buildAgentPrompt(config, "/wt/copy", env, "Parent.", { worktreeBase: "/repo" });
      expect(prompt).toContain("isolated git worktree copy of /repo");
      expect(prompt).toContain("never in /repo, even if other instructions name that path");
      expect(prompt.indexOf("<worktree_isolation>")).toBeGreaterThan(prompt.indexOf("Working directory: /wt/copy"));
    });

    it("stays outside the cacheable inherited prefix", () => {
      const prompt = buildAgentPrompt(config, "/wt/copy", env, "Parent prompt.", { worktreeBase: "/repo" });
      expect(prompt.startsWith("Parent prompt.")).toBe(true);
      expect(prompt.indexOf("<worktree_isolation>")).toBeGreaterThan(prompt.indexOf("<sub_agent_context>"));
    });

    it("composes worktree isolation, instructions, memory, and skills", () => {
      const prompt = buildAgentPrompt({ ...config, instructions: "Review the copy." }, "/wt/copy", env, "Parent.", {
        worktreeBase: "/repo",
        memoryBlock: "# Memory\nRemember this.",
        skillBlocks: [{ name: "review", content: "Check regressions." }],
      });
      expect(prompt).toContain("<worktree_isolation>");
      expect(prompt).toContain("Review the copy.");
      expect(prompt).toContain("# Memory");
      expect(prompt).toContain("Preloaded Skill: review");
    });
  });
});
