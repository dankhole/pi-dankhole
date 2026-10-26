import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../../src/workers/agent-runner.js";
import subagentsExtension from "../../src/workers/index.js";
import { isolationParam } from "../../src/workers/invocation-config.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";

/**
 * The `isolation` parameter's *shape* is the fix for #231, so it is worth
 * asserting directly rather than only through behaviour.
 *
 * As a single-value optional literal it gave models that fill every optional
 * parameter nothing harmless to fill it with: the session log on #231 shows one
 * emitting `isolation: "worktree"` on three consecutive calls — alongside
 * an empty resume value — while its own reasoning, its message to the
 * user, and two explicit user instructions all said to omit the field. A second
 * legal value is what lets it comply.
 */
describe("isolationParam", () => {
  function schema(enabled: boolean) {
    const built = isolationParam(enabled);
    return built.isolation as { anyOf?: { const?: string }[] } | undefined;
  }

  it("offers a value meaning 'no isolation', not just 'worktree'", () => {
    const values = schema(true)?.anyOf?.map(v => v.const);
    expect(values).toContain("off");
    expect(values).toContain("worktree");
  });

  // A model that fills optional fields tends to reach for what it reads first,
  // so the inert value leads. This is the whole mitigation — if the order flips,
  // the schema stops steering and the bug is back in practice.
  it("lists the inert value first", () => {
    expect(schema(true)?.anyOf?.[0]?.const).toBe("off");
  });

  it("warns that a worktree cannot see uncommitted work", () => {
    // The specific trap in #231: the subagent reviewed an empty `git diff
    // --cached` in a fresh copy and returned nothing, three times.
    const described = JSON.stringify(schema(true));
    expect(described).toMatch(/uncommitted or staged/);
  });

  it("omits the parameter entirely when the project disabled worktrees", () => {
    // Nothing to pass beats accepting it and quietly downgrading — and it costs
    // the model no context in disabled mode.
    expect(isolationParam(false)).toEqual({});
  });
});

describe("cached isolation arguments with worktrees disabled", () => {
  let environment: ReturnType<typeof hermeticDir>;
  let booted: ReturnType<typeof makePi>;
  const managerKey = Symbol.for("pi-subagents:manager");
  let previousManager: unknown;

  beforeEach(() => {
    environment = hermeticDir({ settings: { worktreeIsolation: false, outputTranscript: false } });
    previousManager = Reflect.get(globalThis, managerKey);
    Reflect.deleteProperty(globalThis, managerKey);
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    booted = makePi();
    subagentsExtension(booted.pi);
  });

  afterEach(async () => {
    await booted.lifecycle.get("session_shutdown")?.();
    if (previousManager !== undefined) Reflect.set(globalThis, managerKey, previousManager);
    environment.restore();
  });

  async function dispatch(input: Record<string, unknown>) {
    const tool = booted.tools.get("Agent");
    // Mirror the host ordering: prepare raw arguments, validate, then execute.
    const prepared = tool.prepareArguments?.(input) ?? input;
    const validated = validateToolArguments(tool, {
      id: "cached-isolation", type: "toolCall", name: "Agent", arguments: prepared,
    });
    return tool.execute("cached-isolation", validated, undefined, undefined, ctx());
  }

  it.each(["worktree", "off"])("downgrades cached %s without advertising the field", async isolation => {
    const tool = booted.tools.get("Agent");
    expect(tool.parameters.properties).not.toHaveProperty("isolation");
    const input = { prompt: "Inspect routes", description: "Inspect routes", run_in_background: true, isolation };
    await dispatch(input);
    expect(input.isolation).toBe(isolation);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent).mock.calls[0][2].config?.isolation).toBeUndefined();
  });

  it.each([
    { isolation: "worktree", unexpected: true },
    { isolation: "worktree", subagent_type: "old-profile" },
    { isolation: "invalid" },
    { isolation: "worktree", max_turns: -1 },
    { isolation: "worktree", resume: "existing-id" },
  ])("rejects invalid arguments before spawning: %j", async overrides => {
    await expect(dispatch({
      prompt: "Inspect routes", description: "Inspect routes", run_in_background: true, ...overrides,
    })).rejects.toThrow(/Validation failed/);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
