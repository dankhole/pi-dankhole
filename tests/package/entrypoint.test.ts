import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, type Extension, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInChildSessionContext } from "../../src/workers/child-context.js";
import { ctx } from "../workers/helpers/boot-extension.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const managerKey = Symbol.for("pi-subagents:manager");
let scratch: string;
let priorCwd: string;
let priorManager: unknown;
const activations: Extension[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "pi-dankhole-package-"));
  priorCwd = process.cwd();
  priorManager = Reflect.get(globalThis, managerKey);
  Reflect.deleteProperty(globalThis, managerKey);
  process.chdir(scratch);
  vi.stubEnv("PI_CODING_AGENT_DIR", scratch);
  vi.stubEnv("HOME", scratch);
});

afterEach(async () => {
  for (const extension of activations.splice(0).reverse()) {
    for (const handler of extension.handlers.get("session_shutdown") ?? []) {
      await handler({ type: "session_shutdown", reason: "quit" }, ctx());
    }
  }
  if (priorManager === undefined) Reflect.deleteProperty(globalThis, managerKey);
  else Reflect.set(globalThis, managerKey, priorManager);
  process.chdir(priorCwd);
  vi.unstubAllEnvs();
  await rm(scratch, { recursive: true, force: true });
});

async function loadPackage() {
  const loader = new DefaultResourceLoader({
    cwd: scratch, agentDir: scratch, settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [packageRoot],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  activations.push(...loaded.extensions);
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  return loaded.extensions[0];
}

describe("single package composition", () => {
  it("loads the manifest entrypoint with workers, questions and interface rendering", async () => {
    const extension = await loadPackage();
    expect(extension.resolvedPath).toBe(join(packageRoot, "src/index.ts"));
    expect([...extension.tools.keys()].sort()).toEqual(["Agent", "ask_user", "get_subagent_result", "resolve_question", "steer_subagent"]);
    expect([...extension.commands.keys()].sort()).toEqual(["agents", "compact-tools", "latest-input", "q", "questions"]);
    expect(extension.toolRenderers).toHaveLength(1);
    const questionRenderers = extension.tools.get("ask_user")!.definition;
    expect(extension.toolRenderers![0]("ask_user", () => questionRenderers)).toBe(questionRenderers);
    const resolution = extension.tools.get("resolve_question")!.definition;
    expect(resolution.exposure).toBe("model-only");
    expect(resolution.executionMode).toBe("sequential");
    expect(resolution.parameters.properties).toHaveProperty("user_message");
    expect(resolution.promptGuidelines?.join(" ")).toContain("Resolution never resends input or grants permission");
    expect(Reflect.get(globalThis, managerKey)).toMatchObject({ getRecord: expect.any(Function) });
    const schema = extension.tools.get("Agent")!.definition.parameters;
    expect(schema.properties).not.toHaveProperty("subagent_type");
    expect(schema.properties).not.toHaveProperty("allow_nested");
  });

  it("keeps worker controls out of child activations without taking the root registry", async () => {
    await loadPackage();
    const rootManager = Reflect.get(globalThis, managerKey);
    const child = await runInChildSessionContext(loadPackage);
    expect([...child.tools.keys()].sort()).toEqual(["ask_user", "resolve_question"]);
    expect(child.commands.has("agents")).toBe(false);
    expect(child.toolRenderers).toHaveLength(1);
    expect(Reflect.get(globalThis, managerKey)).toBe(rootManager);
  });
});
