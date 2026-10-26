import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/workers/agent-runner.js")>("../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

// Only the filesystem side is faked; the transcript default is real module
// state (both spawn paths read it there), so it must be reset between tests.
vi.mock("../../src/workers/output-file.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/workers/output-file.js")>("../../src/workers/output-file.js");
  return {
    ...actual,
    createOutputFilePath: vi.fn(() => "/tmp/fake-subagent.output"),
    writeInitialEntry: vi.fn(),
    streamToOutputFile: vi.fn(() => vi.fn()),
  };
});

import { runAgent } from "../../src/workers/agent-runner.js";
import subagentsExtension from "../../src/workers/index.js";
import { createOutputFilePath, setOutputTranscriptDefault, streamToOutputFile, writeInitialEntry } from "../../src/workers/output-file.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const events = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        events.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function makeCtx(cwd: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "session-1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

describe("output_transcript agent wiring", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-output-transcript-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-output-transcript-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({}));
    process.chdir(cwd);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _prompt, options) => {
      await Promise.resolve();
      const session = { messages: [], subscribe: vi.fn(() => vi.fn()), dispose: vi.fn() } as any;
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    setOutputTranscriptDefault(true);
    vi.clearAllMocks();
  });

  it("creates no transcript when a foreground launch sets output_transcript false", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tool-call",
      { prompt: "process sensitive data", description: "Process sensitive data", output_transcript: false, run_in_background: false },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(createOutputFilePath).not.toHaveBeenCalled();
    expect(writeInitialEntry).not.toHaveBeenCalled();
    expect(streamToOutputFile).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("also suppresses the background transcript", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tool-call",
      { prompt: "process sensitive data", description: "Process sensitive data", output_transcript: false, run_in_background: true },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(createOutputFilePath).not.toHaveBeenCalled();
    expect(writeInitialEntry).not.toHaveBeenCalled();
    expect(streamToOutputFile).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("keeps transcript creation as the default", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tool-call",
      { prompt: "ordinary work", description: "Do ordinary work" },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(createOutputFilePath).toHaveBeenCalledOnce();
    expect(writeInitialEntry).toHaveBeenCalledOnce();
    expect(streamToOutputFile).toHaveBeenCalledOnce();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("suppresses the transcript project-wide when subagents.json sets outputTranscript false", async () => {
    // An unqualified launch inherits the project default.
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ outputTranscript: false }));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tool-call",
      { prompt: "ordinary work", description: "Do ordinary work" },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(createOutputFilePath).not.toHaveBeenCalled();
    expect(writeInitialEntry).not.toHaveBeenCalled();
    expect(streamToOutputFile).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("lets launch-time output_transcript true override a project outputTranscript false", async () => {
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ outputTranscript: false }));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tool-call",
      { prompt: "audited work", description: "Do audited work", output_transcript: true },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(createOutputFilePath).toHaveBeenCalledOnce();
    expect(writeInitialEntry).toHaveBeenCalledOnce();
    expect(streamToOutputFile).toHaveBeenCalledOnce();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });
});
