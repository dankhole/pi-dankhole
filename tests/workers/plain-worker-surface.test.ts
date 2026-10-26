import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../../src/workers/agent-runner.js";
import subagentsExtension from "../../src/workers/index.js";
import { ctx, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

describe("plain worker surface", () => {
  let environment: ReturnType<typeof hermeticDir>;
  let booted: ReturnType<typeof makePi>;
  const priorManager = Reflect.get(globalThis, MANAGER_KEY);

  beforeEach(() => {
    environment = hermeticDir();
    Reflect.deleteProperty(globalThis, MANAGER_KEY);
    vi.mocked(runAgent).mockReset();
    booted = makePi();
    subagentsExtension(booted.pi);
  });

  afterEach(async () => {
    await booted.lifecycle.get("session_shutdown")?.();
    if (priorManager === undefined) Reflect.deleteProperty(globalThis, MANAGER_KEY);
    else Reflect.set(globalThis, MANAGER_KEY, priorManager);
    environment.restore();
  });

  it("exposes worker controls without workflow tools or scheduled launches", () => {
    expect([...booted.tools.keys()].sort()).toEqual([
      "Agent", "get_subagent_result", "steer_subagent",
    ].sort());
    expect(booted.registeredFlags.size).toBe(0);
    const schema = booted.tools.get("Agent").parameters;
    for (const removed of ["subagent_type", "name", "schedule", "allow_nested", "output_schema"]) {
      expect(schema.properties).not.toHaveProperty(removed);
      expect(schema.required ?? []).not.toContain(removed);
    }
  });

  it("configures individual workers at launch rather than selecting profiles", () => {
    const schema = booted.tools.get("Agent").parameters;
    for (const field of [
      "prompt", "description", "model", "thinking", "instructions", "tools",
      "extensions", "skills", "resume", "run_in_background",
    ]) {
      expect(schema.properties).toHaveProperty(field);
    }
  });

  it("uses the goal as its visible identity and retains Quarterdeck lookup", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const result = await booted.tools.get("Agent").execute(
      "plain-worker",
      { prompt: "Inspect authentication without making changes", description: "Audit authentication", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    const text = textOf(result);
    expect(text).toContain("Audit authentication");
    expect(text).not.toMatch(/general-purpose|\(twin\)/);
    const id = /Agent ID: (\S+)/.exec(text)?.[1];
    expect(id).toBeTruthy();
    const manager = Reflect.get(globalThis, MANAGER_KEY);
    expect(manager.getRecord(id)).toMatchObject({ id, description: "Audit authentication" });
    expect(booted.pi.events.emit).toHaveBeenCalledWith(
      "subagents:created",
      expect.objectContaining({ id, description: "Audit authentication", isBackground: true }),
    );
  });

  it("leaves normal input and file autocomplete alone", async () => {
    const context = ctx();
    await booted.lifecycle.get("session_start")?.({}, context);
    expect(booted.lifecycle.has("input")).toBe(false);
    expect(context.ui.addAutocompleteProvider).not.toHaveBeenCalled();
  });
});
