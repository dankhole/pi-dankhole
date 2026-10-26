import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { type ExtensionAPI, type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import type * as PiTui from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAgentName } from "../../src/workers/agent-color.js";
import { AgentManager } from "../../src/workers/agent-manager.js";

import subagentsExtension from "../../src/workers/index.js";
import { loadSettings, saveSettings } from "../../src/workers/settings.js";
import type { AgentRecord } from "../../src/workers/types.js";
import { type AgentActivity, type AgentDetails, AgentWidget, type Theme, type UICtx } from "../../src/workers/ui/agent-widget.js";

const settingsList = vi.hoisted(() => ({
  items: [] as PiTui.SettingItem[],
  change: (_id: string, _value: string) => {},
}));

vi.mock("@earendil-works/pi-tui", async importOriginal => {
  const actual = await importOriginal<typeof PiTui>();
  return {
    ...actual,
    SettingsList: class {
      constructor(items: PiTui.SettingItem[], _height: number, _theme: unknown, change: (id: string, value: string) => void) {
        settingsList.items = items;
        settingsList.change = change;
      }
      render() { return []; }
      invalidate() {}
    },
  };
});

const codes: Record<string, number> = {
  accent: 36, text: 37, muted: 90, dim: 2, syntaxVariable: 34, thinkingMedium: 35,
  success: 32, warning: 33, error: 31, toolTitle: 96,
};
const theme = {
  fg: (color: string, text: string) => `\u001b[${codes[color]}m${text}\u001b[39m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  getBgAnsi: () => "",
};
const fg = theme.fg;

function record(status: AgentRecord["status"] = "running"): AgentRecord {
  return {
    id: "r1", description: "Inspect auth", status, toolUses: 2,
    startedAt: 1000, ...(status === "running" ? {} : { completedAt: 5000 }),
    lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0 }, compactionCount: 0,
    invocation: { modelName: "sonnet 4.6", thinking: "high", requestedThinking: "max" },
    error: status === "error" ? "timeout" : undefined,
  };
}

function widgetLines(agent: AgentRecord, enabled?: boolean, width = 240, showModel = true, percent?: number): string[] {
  const activity: AgentActivity = {
    activeTools: new Map([["t1", "read"]]), responseText: "", toolUses: 2, turnCount: 3,
    session: percent === undefined ? undefined : {
      getContextUsage: () => ({ tokens: percent * 2000, contextWindow: 200_000, percent }),
    },
  };
  const widget = new AgentWidget(
    { listAgents: () => [agent] } as unknown as ConstructorParameters<typeof AgentWidget>[0],
    new Map([[agent.id, activity]]), () => "all", () => false, () => showModel,
    enabled === undefined ? undefined : () => enabled,
  );
  let factory: Parameters<UICtx["setWidget"]>[1];
  widget.setUICtx({ setStatus: () => {}, setWidget: (_key, content) => { factory = content; } });
  try {
    widget.update();
    if (typeof factory !== "function") throw new Error("Widget was not registered");
    return factory({ terminal: { columns: width }, requestRender: () => {} }, theme).render();
  } finally {
    widget.dispose();
  }
}

type Component = { render(width: number): string[] };
interface Tool {
  name: string;
  renderCall(args: Record<string, unknown>, theme: Theme, context: { isPartial: boolean; isError: boolean }): Component;
  renderResult(result: { content: { type: "text"; text: string }[]; details: AgentDetails }, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: { isError: boolean }): Component;
}

function activate() {
  initTheme("dark", false);
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  subagentsExtension({
    registerMessageRenderer: () => {}, registerEntryRenderer: () => {}, registerFlag: () => {},
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
    on: (name: string, handler: (event?: unknown, ctx?: unknown) => unknown) => handlers.set(name, handler),
    events: { emit: () => {}, on: () => () => {} }, appendEntry: () => {},
  } as unknown as ExtensionAPI);
  const tool = tools.get("Agent");
  if (!tool || !command) throw new Error("Extension did not register Agent and /agents");
  return {
    tool, command, shutdown: () => handlers.get("session_shutdown")?.(),
    startWidget: (ui: UICtx) => handlers.get("tool_execution_start")?.({}, { ui }),
  };
}

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
beforeEach(() => {
  originalCwd = process.cwd();
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  cwd = mkdtempSync(join(tmpdir(), "section-colors-"));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(cwd, "global");
  vi.spyOn(Date, "now").mockReturnValue(5000);
});
afterEach(() => {
  process.chdir(originalCwd);
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("section colors", () => {
  it("keeps default and explicit-off widget output byte-for-byte unchanged", () => {
    const expected = [
      `${fg("accent", "●")} ${fg("accent", "Agents")}`,
      `${fg("dim", "└─")} ${fg("accent", "⠙")} ${fg("muted", theme.bold("Inspect auth"))} ${fg("dim", "·")} ${fg("dim", "sonnet 4.6 · thinking: high (asked max) · ↻3 · 1.2k token · 0m")}`,
      `${fg("dim", "  ")}${fg("dim", " ⎿ reading…")}`,
    ];
    expect(widgetLines(record())).toEqual(expected);
    expect(widgetLines(record(), false)).toEqual(expected);
    expect(widgetLines(record("completed"), false)).toEqual([
      `${fg("dim", "○")} ${fg("dim", "Agents")}`,
      `${fg("dim", "└─")} ${fg("success", "✓")} ${fg("dim", "Inspect auth")} ${fg("dim", "·")} ${fg("dim", "↻3 · 0m")}`,
    ]);
  });

  it("colors independent live sections, leaving activity and metrics secondary", () => {
    const lines = widgetLines(record(), true);
    expect(lines[1]).toContain(fg("text", theme.bold("Inspect auth")));
    expect(lines[1].match(/Inspect auth/g)).toHaveLength(1);
    expect(lines.join("\n")).not.toMatch(/tool uses?|Reviewer|general-purpose|\(twin\)/);
    expect(lines[1]).toContain(fg("syntaxVariable", "sonnet 4.6"));
    expect(lines[1]).toContain(fg("thinkingMedium", "thinking: high (asked max)"));
    expect(lines[1]).toContain(`\u001b[39m\u001b[2m · ↻3 · 1.2k token · 0m`);
    expect(lines[2]).toBe(`${fg("dim", "  ")}${fg("dim", " ⎿ reading…")}`);
    expect(widgetLines(record(), true, 240, false).join("\n")).not.toContain("sonnet");
  });

  it.each(["running", "completed", "steered", "stopped", "error", "aborted"] as const)("preserves %s status while coloring the sole goal label", status => {
    const off = widgetLines(record(status), false);
    const on = widgetLines(record(status), true);
    const bold = status === "running";
    const goal = renderAgentName("Inspect auth", theme, { bold, fallbackColor: "text" });
    const uncolored = renderAgentName("Inspect auth", theme, { bold, fallbackColor: bold ? "muted" : "dim" });
    expect(on[1]).toContain(goal);
    expect(on[1].match(/Inspect auth/g)).toHaveLength(1);
    expect(on[1]).not.toMatch(/\u001b\[(?:48|49)/);
    if (status !== "running") expect(on[1].replace(goal, uncolored)).toBe(off[1]);
  });

  it("colors a finished goal without changing its error status", () => {
    const line = widgetLines(record("error"), true)[1];
    expect(line).toContain(fg("text", "Inspect auth"));
    expect(line).toContain(fg("error", "✗"));
    expect(line).toContain(fg("error", " error: timeout"));
  });

  it.each([[70, "warning"], [90, "error"]] as const)("preserves %i%% context urgency and restores secondary metrics", (percent, color) => {
    const lines = widgetLines({ ...record(), compactionCount: 2 }, true, 240, true, percent);
    expect(lines[1]).toContain(fg(color, `${percent}%`));
    expect(lines[1]).toContain(fg("dim", "⇊2"));
    expect(lines[1]).toContain("\u001b[39m\u001b[2m) · 0m");
  });

  it.each([1, 12, 40, 80, 240])("preserves visible text and bounds at %i columns", width => {
    const agent = { ...record(), description: "Inspect 認証 e\u0301 and permissions" };
    const on = widgetLines(agent, true, width);
    const off = widgetLines(agent, false, width);
    expect(on.map(stripAnsi)).toEqual(off.map(stripAnsi));
    expect(on.every(line => visibleWidth(line) <= width)).toBe(true);
  });

  it("loads boolean-only settings, with project overrides and absence intact", () => {
    expect(loadSettings(cwd)).toEqual({});
    const globalDir = process.env.PI_CODING_AGENT_DIR!;
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "subagents.json"), JSON.stringify({ sectionColors: true }));
    expect(loadSettings(cwd)).toEqual({ sectionColors: true });
    saveSettings({ sectionColors: false }, cwd);
    expect(loadSettings(cwd)).toEqual({ sectionColors: false });
    saveSettings({ sectionColors: true }, cwd);
    expect(loadSettings(cwd)).toEqual({ sectionColors: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ sectionColors: "on" }));
    expect(loadSettings(cwd)).toEqual({ sectionColors: true });
    rmSync(join(globalDir, "subagents.json"));
    expect(loadSettings(cwd)).toEqual({});
  });

  it("defaults off, toggles live in Settings, persists, and reloads Agent field colors", async () => {
    const extension = activate();
    const details: AgentDetails = {
      description: "Inspect auth", status: "completed",
      toolUses: 2, tokens: "1.2k token", durationMs: 4000, modelName: "sonnet 4.6", tags: ["thinking: high", "isolated"],
    };
    const render = () => extension.tool.renderResult(
      { content: [{ type: "text", text: "done" }], details }, { expanded: false, isPartial: false }, theme, { isError: false },
    ).render(240).map(line => line.trimEnd()).join("\n");
    vi.spyOn(AgentManager.prototype, "listAgents").mockReturnValue([record()]);
    let widgetFactory: Parameters<UICtx["setWidget"]>[1];
    const widgetUI = {
      setStatus: () => {},
      setWidget: (_key: string, content: Parameters<UICtx["setWidget"]>[1]) => { widgetFactory = content; },
      onTerminalInput: () => () => {},
    };
    await extension.startWidget(widgetUI);
    const renderWidget = () => {
      if (typeof widgetFactory !== "function") throw new Error("Widget was not registered");
      return widgetFactory({ terminal: { columns: 240 }, requestRender: () => {} }, theme).render().join("\n");
    };
    const offWidget = renderWidget();
    expect(offWidget).toContain(fg("muted", theme.bold("Inspect auth")));
    const off = render();
    expect(off).toBe(`${fg("success", "✓")} ${fg("dim", "sonnet 4.6")} ${fg("dim", "·")} ${fg("dim", "thinking: high")} ${fg("dim", "·")} ${fg("dim", "isolated")} ${fg("dim", "·")} ${fg("dim", "2 tool uses")} ${fg("dim", "·")} ${fg("dim", "1.2k token")} ${fg("dim", "·")} ${fg("dim", "0m")}\n\u001b[2m${fg("dim", "  ⎿  Done")}`);
    let toggle = "on";
    const ctx = {
      ui: {
        select: vi.fn().mockResolvedValueOnce("Settings").mockResolvedValue(undefined),
        custom: async (factory: (tui: unknown, theme: Theme, kb: unknown, done: () => void) => unknown) => {
          factory({}, theme, {}, () => {});
          expect(settingsList.items.find(item => item.id === "sectionColors")?.currentValue).toBe(toggle === "on" ? "off" : "on");
          const ids = settingsList.items.map(item => item.id);
          for (const removed of ["schedulingEnabled", "workflowsEnabled", "strictAgentFiles", "disableDefaultAgents", "fallbackSubagent", "packageAgents", "packageWorkflows", "agentMentions"]) {
            expect(ids).not.toContain(removed);
          }
          settingsList.change("sectionColors", toggle);
        },
        notify: () => {},
      },
    } as unknown as ExtensionCommandContext;
    try {
      await extension.command("", ctx);
      expect(JSON.parse(readFileSync(join(cwd, ".pi", "subagents.json"), "utf-8")).sectionColors).toBe(true);
      expect(render()).toContain(fg("syntaxVariable", "sonnet 4.6"));
      expect(render()).toContain(fg("thinkingMedium", "thinking: high"));
      expect(render()).toContain(fg("dim", "isolated"));
      expect(renderWidget()).toContain(fg("text", theme.bold("Inspect auth")));
      expect(stripAnsi(render())).toBe(stripAnsi(off));
      expect(extension.tool.renderCall({ description: "Inspect auth" }, theme, { isPartial: false, isError: false }).render(240).join("\n")).toContain(fg("accent", "Inspect auth"));
      await extension.shutdown();
      const reloaded = activate();
      try {
        expect(reloaded.tool.renderResult({ content: [], details }, { expanded: false, isPartial: false }, theme, { isError: false }).render(240).join("\n")).toContain(fg("syntaxVariable", "sonnet 4.6"));
      } finally { await reloaded.shutdown(); }
      toggle = "off";
      vi.mocked(ctx.ui.select).mockResolvedValueOnce("Settings");
      await extension.command("", ctx);
      expect(render()).toBe(off);
      expect(renderWidget()).toContain(fg("muted", theme.bold("Inspect auth")));
      expect(loadSettings(cwd).sectionColors).toBe(false);
    } finally { await extension.shutdown(); }
  });
});
