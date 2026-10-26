/** Plain-worker launches must never rediscover or parse profile directories. */
import type * as fs from "node:fs";
import { readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

vi.mock("../../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../../../src/workers/agent-runner.js";
import subagentsExtension from "../../../src/workers/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "../helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
let hermetic: Hermetic;
let booted: ReturnType<typeof makePi>;

beforeEach(() => {
  hermetic = hermeticDir({
    agentFiles: { obsolete: "---\nmodel: unavailable-model\n---\nObsolete profile.\n" },
  });
  Reflect.deleteProperty(globalThis, MANAGER_KEY);
  vi.mocked(runAgent).mockReset();
  vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
  vi.mocked(readdirSync).mockClear();
  booted = makePi();
  subagentsExtension(booted.pi);
});

afterEach(async () => {
  await booted.lifecycle.get("session_shutdown")?.();
  Reflect.deleteProperty(globalThis, MANAGER_KEY);
  hermetic.restore();
});

describe("profile-free spawn work", () => {
  for (const count of [1, 5]) {
    it(`does not scan profile directories for ${count} worker launches`, async () => {
      for (let i = 0; i < count; i++) {
        await booted.tools.get("Agent").execute(
          `tc-${i}`,
          { description: `Goal ${i}`, prompt: "Work on the goal", run_in_background: true },
          undefined,
          undefined,
          ctx(),
        );
      }
      await flush();
      expect(runAgent).toHaveBeenCalledTimes(count);
      const profileScans = vi.mocked(readdirSync).mock.calls.filter(([path]) => /[/\\]agents(?:[/\\]|$)/.test(String(path)));
      expect(profileScans).toEqual([]);
    });
  }
});
