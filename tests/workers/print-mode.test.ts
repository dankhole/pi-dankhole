import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/workers/agent-runner.js")>("../../src/workers/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
  };
});

import { runAgent } from "../../src/workers/agent-runner.js";
import subagentsExtension from "../../src/workers/index.js";
import { type Hermetic, hermeticDir } from "./helpers/boot-extension.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

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
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as any,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    isIdle: () => true,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

describe("print mode background notifications", () => {
  let environment: Hermetic | undefined;
  const managerKey = Symbol.for("pi-subagents:manager");
  const priorManager = Reflect.get(globalThis, managerKey);
  afterEach(() => {
    if (priorManager === undefined) Reflect.deleteProperty(globalThis, managerKey);
    else Reflect.set(globalThis, managerKey, priorManager);
    environment?.restore();
    environment = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retains a stale-context send as uncertain without automatically retrying", async () => {
    environment = hermeticDir({ settings: { outputTranscript: false, rememberAgents: false } });
    Reflect.deleteProperty(globalThis, managerKey);
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();
    const context = makeHeadlessCtx();
    await handlers.get("session_start")({}, context);

    const agentTool = tools.get("Agent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        run_in_background: true,
      },
      undefined,
      undefined,
      context,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(pi.sendMessage).toHaveBeenCalledOnce();
    await handlers.get("agent_settled")({ aborted: false }, context);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pi.sendMessage).toHaveBeenCalledOnce();

    await handlers.get("session_shutdown")?.({}, context);
  });
});
