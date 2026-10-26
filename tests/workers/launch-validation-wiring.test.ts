import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../../src/workers/agent-runner.js";
import subagentsExtension from "../../src/workers/index.js";
import { ctx, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

describe("invalid launch configuration cannot start work", () => {
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

  const invalid = [
    { params: { tools: ["reed"] }, error: /Unknown built-in tool/ },
    { params: { thinking: "imaginary" }, error: /thinking level/i },
    { params: { max_turns: -1 }, error: /max_turns/ },
    { params: { memory: { scope: "project", key: "../escape" } }, error: /memory/i },
  ];

  for (const background of [false, true]) {
    it.each(invalid)(`rejects $params before spawning (background: ${background})`, async ({ params, error }) => {
      let failure = "";
      try {
        const result = await booted.tools.get("Agent").execute(
          "invalid-launch",
          { prompt: "Do not start invalid work", description: "Validate launch", run_in_background: background, ...params },
          undefined,
          undefined,
          ctx(),
        );
        failure = textOf(result);
      } catch (cause) {
        failure = cause instanceof Error ? cause.message : String(cause);
      }
      expect(failure).toMatch(error);
      expect(runAgent).not.toHaveBeenCalled();
    });
  }
});
