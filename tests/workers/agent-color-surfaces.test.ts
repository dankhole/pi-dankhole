import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../../src/workers/index.js";
import * as settings from "../../src/workers/settings.js";
import type { AgentRecord } from "../../src/workers/types.js";
import { type AgentActivity, AgentWidget } from "../../src/workers/ui/agent-widget.js";
import { ConversationViewer } from "../../src/workers/ui/conversation-viewer.js";
import { FleetList, type FleetUICtx } from "../../src/workers/ui/fleet-list.js";

const GOAL = "Review this change";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
  getBgAnsi: (color: string) => `<${color}>`,
  getColorMode: () => "truecolor" as const,
};

type RenderedComponent = { render(width?: number): string[] };
type WidgetFactory = (
  tui: { terminal: { columns: number; rows?: number }; requestRender: ReturnType<typeof vi.fn> },
  activeTheme: typeof theme,
) => RenderedComponent;
type SessionHandler = (...args: unknown[]) => unknown;

interface RegisteredTool {
  name: string;
  renderCall(
    args: Record<string, unknown>,
    activeTheme: typeof theme,
    context: { isPartial: boolean; isError: boolean },
  ): RenderedComponent;
}

function makeRecord(): AgentRecord {
  return {
    id: "review-1",
    description: GOAL,
    status: "running",
    toolUses: 7,
    startedAt: Date.now(),
    session: {
      messages: [],
      subscribe: vi.fn(() => vi.fn()),
    } as unknown as AgentRecord["session"],
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
}

function makeActivity(): AgentActivity {
  return {
    activeTools: new Map(),
    toolUses: 0,
    responseText: "",
    turnCount: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
  };
}

function makePi() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, SessionHandler>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: unknown) => {
      const registered = tool as RegisteredTool;
      tools.set(registered.name, registered);
    }),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: unknown) => handlers.set(event, handler as SessionHandler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as Parameters<typeof subagentsExtension>[0];
  return { pi, tools, handlers };
}

describe("goal identity across runtime surfaces", () => {
  it("renders the Agent call header with one goal and no profile decoration", async () => {
    const { pi, tools, handlers } = makePi();
    // This assertion covers default colors, independently of user settings.
    const loadSettings = vi.spyOn(settings, "applyAndEmitLoaded").mockReturnValue({});
    subagentsExtension(pi);

    try {
      const tool = tools.get("Agent");
      if (!tool) throw new Error("Agent tool was not registered");
      const render = (context: { isPartial: boolean; isError: boolean }) => tool.renderCall(
        { description: GOAL },
        theme,
        context,
      ).render(120).join("\n");
      const output = render({ isPartial: false, isError: false });

      expect(output).toContain(GOAL);
      expect(output.match(/Review this change/g)).toHaveLength(1);
      expect(output).toContain(`<toolTitle>${GOAL}</toolTitle>`);
      expect(output).not.toMatch(/general-purpose|\(twin\)|\u001b\[(?:48|49)/);
      // Rendering a partial or failed call does not change its goal identity.
      expect(render({ isPartial: true, isError: false })).toContain(GOAL);
      expect(render({ isPartial: false, isError: true })).toContain(GOAL);

      const continuation = tool.renderCall(
        {}, theme, { isPartial: false, isError: false },
      ).render(120).join("\n");
      expect(continuation).toContain("Continue worker");
    } finally {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} });
      loadSettings.mockRestore();
    }
  });

  it("renders one goal in the above-editor widget without profile backgrounds", () => {
    const record = makeRecord();
    const widget = new AgentWidget(
      { listAgents: () => [record] } as unknown as ConstructorParameters<typeof AgentWidget>[0],
      new Map([[record.id, makeActivity()]]),
      () => "all",
    );
    let factory: WidgetFactory | undefined;
    let placement: string | undefined;
    widget.setUICtx({
      setStatus: vi.fn(),
      setWidget: (_key, content, options) => {
        if (typeof content === "function") factory = content as WidgetFactory;
        placement = options?.placement;
      },
    });

    try {
      widget.update();
      const output = factory?.(
        { terminal: { columns: 120 }, requestRender: vi.fn() },
        theme,
      ).render().join("\n");

      expect(placement).toBe("aboveEditor");
      expect(output).toContain(GOAL);
      expect(output?.match(/Review this change/g)).toHaveLength(1);
      expect(output).not.toMatch(/general-purpose|\(twin\)|\u001b\[(?:48|49)/);
    } finally {
      widget.dispose();
    }
  });

  it("renders one goal in the FleetView row without profile backgrounds", () => {
    const record = makeRecord();
    const manager = {
      listAgents: () => [record],
      abort: vi.fn(() => true),
      steer: vi.fn(() => true),
    } as unknown as ConstructorParameters<typeof FleetList>[0];
    const fleet = new FleetList(manager, new Map());
    let factory: WidgetFactory | undefined;
    fleet.setUICtx({
      setWidget: (_key, content) => {
        if (typeof content === "function") factory = content as WidgetFactory;
      },
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      notify: vi.fn(),
      custom: (() => new Promise<undefined>(() => {})) as FleetUICtx["custom"],
    });

    try {
      fleet.update();
      const output = factory?.(
        { requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } },
        theme,
      ).render(120).join("\n");

      expect(output).toContain(GOAL);
      expect(output?.match(/Review this change/g)).toHaveLength(1);
      expect(output).not.toMatch(/general-purpose|\(twin\)|\u001b\[(?:48|49)/);

    } finally {
      fleet.dispose();
    }
  });

  it("renders one goal in the viewer header and retains detailed tool metrics", () => {
    const record = makeRecord();
    const viewer = new ConversationViewer(
      { terminal: { rows: 30, columns: 120 }, requestRender: vi.fn() } as unknown as ConstructorParameters<typeof ConversationViewer>[0],
      record.session!,
      record,
      undefined,
      theme,
      vi.fn(),
    );

    try {
      const output = viewer.render(120).join("\n");
      expect(output).toContain("7 tools");
      expect(output).toContain(GOAL);
      expect(output?.match(/Review this change/g)).toHaveLength(1);
      expect(output).not.toMatch(/general-purpose|\(twin\)|\u001b\[(?:48|49)/);
    } finally {
      viewer.dispose();
    }
  });
});
