/** Measure plain-worker dispatch, excluding child-session construction and model calls. */
import { afterAll, bench, describe, vi } from "vitest";

vi.mock("../../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../../../src/workers/agent-runner.js";
import subagentsExtension from "../../../src/workers/index.js";
import { ctx, hermeticDir, makePi } from "../helpers/boot-extension.js";

const environment = hermeticDir();
const booted = makePi();
vi.mocked(runAgent).mockImplementation(async () => ({
  responseText: "done",
  session: { dispose: vi.fn() },
  aborted: false,
  steered: false,
}) as unknown as Awaited<ReturnType<typeof runAgent>>);
subagentsExtension(booted.pi);

const context = ctx();
const agent = booted.tools.get("Agent");
let call = 0;

afterAll(async () => {
  await booted.lifecycle.get("session_shutdown")?.();
  Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
  environment.restore();
});

describe("Agent tool — background spawn", () => {
  // Bound samples so retained records cannot grow indefinitely during measurement.
  bench("plain worker, run_in_background", async () => {
    await agent.execute(
      `bench-${call++}`,
      { description: "Benchmark dispatch", prompt: "go", run_in_background: true },
      undefined,
      undefined,
      context,
    );
  }, { time: 0, iterations: 100, warmupTime: 0, warmupIterations: 10 });
});
