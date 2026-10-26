// End-to-end test for `toolDescriptionMode` (#91): settings file → sanitize →
// applier → registration-time description pick. Instantiates the real extension
// with a mock pi (same pattern as print-mode.test.ts) inside a temp cwd, then
// inspects the registered Agent tool's description.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../../src/workers/index.js";
import { setWorktreeIsolationEnabled } from "../../src/workers/worktree.js";

const EXAMPLE_TEMPLATE = fileURLToPath(new URL("../../examples/workers/agent-tool-description.md", import.meta.url));

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
    handlers,
  };
}

describe("toolDescriptionMode", () => {
  let tmpDir: string;
  let hermeticAgentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  function setup(settings?: Record<string, unknown>, beforeInstantiate?: () => void) {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-"));
    // Isolate global settings (getAgentDir / ~/.pi) so the dev's real
    // subagents.json can't leak into the "default is full" assertion.
    hermeticAgentDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;
    process.env.HOME = hermeticAgentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    if (settings) {
      writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify(settings));
    }
    beforeInstantiate?.();
    process.chdir(tmpDir);

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    shutdown = async () => {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    };
    return tools;
  }

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    // applySettings only applies keys that are PRESENT, so a subagents.json
    // without `worktreeIsolation` leaves the module singleton wherever the
    // previous test left it. Reset it so each setup()'s settings decide, and
    // so the "default" assertions below really test the default.
    setWorktreeIsolationEnabled(true);
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(hermeticAgentDir, { recursive: true, force: true });
  });

  it("defaults to the full description", () => {
    const desc: string = setup().get("Agent").description;
    expect(desc).toContain("## Usage notes");
    for (const briefing of ["self-contained", "objective", "authorization boundaries", "acceptance criteria"]) {
      expect(desc).toContain(briefing);
    }
    expect(desc).not.toContain("Agent types:");
  });

  it("compact mode is short without advertising a profile list", () => {
    const desc: string = setup({ toolDescriptionMode: "compact" }).get("Agent").description;
    expect(desc).toMatch(/Launch .*worker/);
    expect(desc).not.toContain("## Usage notes");
    expect(desc).not.toContain("## Writing the prompt");
    expect(desc).not.toContain("general-purpose:");
    expect(desc).not.toContain("Explore:");
    expect(desc.length).toBeLessThan(1600);
  });

  it("invalid mode is dropped in favor of full", () => {
    expect(setup({ toolDescriptionMode: "tiny" }).get("Agent").description).toContain("## Usage notes");
  });

  it("compact keeps the operational contracts visible", () => {
    const desc: string = setup({ toolDescriptionMode: "compact" }).get("Agent").description;
    for (const contract of ["run_in_background", "resume", "steer_subagent", "worktree", "self-contained", "model", "thinking"]) {
      expect(desc).toContain(contract);
    }
  });

  it("full states launch and control contracts in description or schema", () => {
    const tool = setup().get("Agent");
    const visible = `${tool.description}\n${JSON.stringify(tool.parameters)}`;
    for (const contract of [
      "run_in_background", "resume", "steer_subagent", "worktree", "self-contained",
      "model", "thinking", "inherit_context", "instructions", "tools", "extensions", "skills",
    ]) expect(visible).toContain(contract);
  });

  it("strategy parameters carry actionable descriptions", () => {
    const props = setup().get("Agent").parameters?.properties ?? {};
    for (const name of ["run_in_background", "model", "thinking", "inherit_context"]) {
      expect(props[name]?.description?.length ?? 0).toBeGreaterThan(40);
    }
  });

  it("exposes plain launch configuration, not profiles, handles, or schedules", () => {
    const tool = setup().get("Agent");
    const names = Object.keys(tool.parameters?.properties ?? {});
    expect(names).toEqual(expect.arrayContaining([
      "prompt", "description", "model", "thinking", "instructions", "tools", "extensions", "skills",
      "memory", "persist_session", "output_transcript", "session_dir",
      "disallowed_tools", "exclude_extensions",
    ]));
    for (const removed of ["subagent_type", "name", "schedule"]) expect(names).not.toContain(removed);
    expect(tool.parameters.required).toContain("prompt");
    expect(tool.parameters.required).not.toContain("description");
  });

  it("custom project templates substitute retained placeholders literally", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(
        join(tmpDir, ".pi", "agent-tool-description.md"),
        "Workers\nGlobal dir: {{agentDir}}\nUnknown: {{nope}}\nCost: $& stays literal\n{{isolationGuideline}}",
      );
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("Workers");
    expect(desc).toContain(`Global dir: ${hermeticAgentDir}`);
    expect(desc).toContain("Unknown: {{nope}}");
    expect(desc).toContain("Cost: $& stays literal");
    expect(desc).toContain("worktree");
    expect(desc).not.toContain("## Usage notes");
  });

  it("custom mode falls back to the global file", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(hermeticAgentDir, "agent-tool-description.md"), "GLOBAL CUSTOM\n{{isolationGuideline}}");
    });
    expect(tools.get("Agent").description).toContain("GLOBAL CUSTOM");
    expect(tools.get("Agent").description).toContain("worktree");
  });

  it("project custom files take precedence over global files", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), "PROJECT CUSTOM");
      writeFileSync(join(hermeticAgentDir, "agent-tool-description.md"), "GLOBAL CUSTOM");
    });
    expect(tools.get("Agent").description).toBe("PROJECT CUSTOM");
  });

  it("expands the generic isolation guideline when enabled", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), "RULES:{{isolationGuideline}}\nEND");
    });
    expect(tools.get("Agent").description).toContain('RULES:\n- Use isolation: "worktree"');
  });

  it("omits the isolation guideline when worktrees are disabled", () => {
    const tools = setup({ toolDescriptionMode: "custom", worktreeIsolation: false }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), "RULES:{{isolationGuideline}}\nEND");
    });
    expect(tools.get("Agent").description).toBe("RULES:\nEND");
  });

  it("every retained documented placeholder is replaced", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), "A {{agentDir}} B {{isolationGuideline}} C");
    });
    expect(tools.get("Agent").description).not.toContain("{{");
    expect(tools.get("Agent").description).not.toContain("}}");
  });

  it("the shipped example renders identically to the full description", async () => {
    const example = readFileSync(EXAMPLE_TEMPLATE, "utf-8");
    const custom = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), example);
    }).get("Agent").description;
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" }));
    const second = makePi();
    subagentsExtension(second.pi);
    try {
      expect(custom).toBe(second.tools.get("Agent").description);
    } finally {
      await second.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as never);
    }
  });

  it.each(["missing", "unreadable"])("custom mode safely falls back when its file is %s", (mode) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = setup({ toolDescriptionMode: "custom" }, () => {
        if (mode === "unreadable") mkdirSync(join(tmpDir, ".pi", "agent-tool-description.md"));
      });
      expect(tools.get("Agent").description).toContain("## Usage notes");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  describe("worktreeIsolation gates schema and prose together", () => {
    it("advertises worktree isolation by default", () => {
      const tool = setup().get("Agent");
      expect(Object.keys(tool.parameters.properties)).toContain("isolation");
      expect(tool.description).toContain('isolation: "worktree"');
    });

    it.each(["full", "compact"])("drops isolation from %s mode when disabled", (mode) => {
      const tool = setup({ toolDescriptionMode: mode, worktreeIsolation: false }).get("Agent");
      expect(Object.keys(tool.parameters.properties)).not.toContain("isolation");
      expect(tool.description).not.toContain('isolation: "worktree"');
      expect(tool.description).not.toContain("git worktree");
      expect(Object.keys(tool.parameters.properties)).toEqual(expect.arrayContaining(["prompt", "description", "model"]));
      expect(tool.description).toContain("resume");
    });
  });
});
