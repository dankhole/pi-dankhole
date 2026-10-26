/** Real headless sessions verify launch-time tool, extension and instruction scope. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/workers/agent-runner.js";
import { type AgentInvocationParams, resolveAgentInvocationConfig } from "../../src/workers/invocation-config.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

const FIXTURES_DIR = resolve(fileURLToPath(new URL("./fixtures", import.meta.url)));
const PARENT_PROMPT = "PARENT_PROMPT_MARKER";
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const EXTENSIONS = ["./ext-alpha.mjs", "./ext-beta.mjs"];

interface Scenario {
  name: string;
  params: AgentInvocationParams;
  present: string[];
  absent?: string[];
  promptContains?: string[];
  promptAbsent?: string[];
}

const SCENARIOS: Scenario[] = [
  { name: "all loaded extensions surface without selectors", params: { extensions: EXTENSIONS }, present: ["read", "alpha_read", "alpha_write", "beta_tool"] },
  { name: "alpha selector mutes beta", params: { extensions: EXTENSIONS, tools: ["*", "ext:ext-alpha.mjs"] }, present: ["read", "bash", "alpha_read", "alpha_write"], absent: ["beta_tool"] },
  { name: "beta selector mutes alpha", params: { extensions: EXTENSIONS, tools: ["*", "ext:ext-beta.mjs"] }, present: ["read", "beta_tool"], absent: ["alpha_read", "alpha_write"] },
  { name: "single extension tool selection", params: { extensions: EXTENSIONS, tools: ["*", "ext:ext-alpha.mjs/alpha_read"] }, present: ["read", "alpha_read"], absent: ["alpha_write", "beta_tool"] },
  { name: "denylist beats extension selector", params: { extensions: EXTENSIONS, tools: ["*", "ext:ext-alpha.mjs"], disallowed_tools: ["alpha_write"] }, present: ["read", "alpha_read"], absent: ["alpha_write", "beta_tool"] },
  { name: "extension exclusion", params: { extensions: EXTENSIONS, exclude_extensions: ["ext-beta.mjs"] }, present: ["read", "alpha_read", "alpha_write"], absent: ["beta_tool"] },
  { name: "selector cannot resurrect excluded extension", params: { extensions: EXTENSIONS, exclude_extensions: ["ext-beta.mjs"], tools: ["*", "ext:ext-beta.mjs"] }, present: ["read"], absent: ["beta_tool", "alpha_read", "alpha_write"] },
  { name: "extensions disabled", params: { extensions: false }, present: BUILTINS, absent: ["alpha_read", "alpha_write", "beta_tool"] },
  { name: "isolated overrides extension loading and selectors", params: { isolated: true, extensions: EXTENSIONS, tools: ["*", "ext:ext-alpha.mjs"] }, present: BUILTINS, absent: ["alpha_read", "alpha_write", "beta_tool"], promptContains: [PARENT_PROMPT] },
  { name: "lazy extension tool surfaces", params: { extensions: ["./ext-lazy.mjs"] }, present: ["read", "bash", "lazy_tool"] },
  { name: "selected lazy extension surfaces", params: { extensions: ["./ext-lazy.mjs", "./ext-alpha.mjs"], tools: ["*", "ext:ext-lazy.mjs"] }, present: ["read", "bash", "lazy_tool"], absent: ["alpha_read", "alpha_write"] },
  { name: "unselected lazy extension stays muted", params: { extensions: ["./ext-lazy.mjs", "./ext-alpha.mjs"], tools: ["*", "ext:ext-alpha.mjs"] }, present: ["read", "bash", "alpha_read", "alpha_write"], absent: ["lazy_tool"] },
  { name: "default built-in tools", params: {}, present: BUILTINS, absent: ["alpha_read", "alpha_write", "beta_tool"] },
  { name: "narrow built-in tools", params: { tools: ["read", "grep"] }, present: ["read", "grep"], absent: ["bash", "edit", "write", "find", "ls", "alpha_read", "alpha_write", "beta_tool"] },
  { name: "empty built-in set still permits explicit extensions", params: { extensions: EXTENSIONS, tools: [] }, present: ["alpha_read", "alpha_write", "beta_tool"], absent: BUILTINS },
  { name: "no tools or extensions", params: { tools: [], extensions: false }, present: [], absent: [...BUILTINS, "alpha_read", "alpha_write", "beta_tool"] },
  { name: "supplemental instructions preserve inherited rules", params: { instructions: "SUPPLEMENTAL_BODY_MARKER" }, present: ["read"], promptContains: [PARENT_PROMPT, "SUPPLEMENTAL_BODY_MARKER"] },
  { name: "skill preload", params: { skills: ["probe-skill"] }, present: ["read"], promptContains: ["Preloaded Skill: probe-skill", "SKILL_BODY_MARKER"] },
  { name: "memory without write tools stays read-only", params: { tools: ["read", "grep"], memory: { scope: "project", key: "readonly-probe" } }, present: ["read", "grep"], absent: ["write", "edit"], promptContains: ["Agent Memory (read-only)", "Memory scope: project"], promptAbsent: ["persistent memory directory"] },
  { name: "denied write does not grant writable memory", params: { tools: ["read", "write"], disallowed_tools: ["write"], memory: { scope: "project", key: "denied-probe" } }, present: ["read"], absent: ["write", "edit", "bash", "grep"], promptContains: ["Agent Memory (read-only)", "Memory scope: project"], promptAbsent: ["persistent memory directory"] },
  { name: "writable memory uses explicit namespace", params: { tools: ["read", "write"], memory: { scope: "user", key: "writable-probe" } }, present: ["read", "write", "edit"], promptContains: ["persistent memory directory", "Memory scope: user"], promptAbsent: ["(read-only)"] },
];

describe("launch-time scope — real pi runtime without profiles", () => {
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let hermeticDir: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeAll(() => {
    hermeticDir = mkdtempSync(join(tmpdir(), "subagents-scope-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticDir;
    process.env.HOME = hermeticDir;
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });

  afterAll(() => {
    faux.unregister();
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(hermeticDir, { recursive: true, force: true });
  });

  it.each(SCENARIOS)("$name", async ({ params, present, absent = [], promptContains = [], promptAbsent = [] }) => {
    const model = faux.getModel();
    const modelRegistry = {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
    const context = { cwd: FIXTURES_DIR, getSystemPrompt: () => PARENT_PROMPT, isProjectTrusted: () => true, model, modelRegistry } as unknown as ExtensionContext;
    const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
    const resolved = resolveAgentInvocationConfig(params);
    let active: string[] = [];
    let prompt = "";
    let created = false;
    try {
      await runAgent(context, "go", {
        pi,
        model,
        cwd: FIXTURES_DIR,
        config: resolved.config,
        onSessionCreated: session => {
          created = true;
          active = session.getActiveToolNames();
          prompt = session.systemPrompt;
        },
      });
    } catch {
      // No live model is needed: construction and tool gating precede the prompt.
    }
    expect(created, "the real scoped session must be constructed").toBe(true);
    for (const tool of present) expect(active).toContain(tool);
    for (const tool of absent) expect(active).not.toContain(tool);
    for (const text of [PARENT_PROMPT, ...promptContains]) expect(prompt).toContain(text);
    for (const text of promptAbsent) expect(prompt).not.toContain(text);
    if (present.length === 0 && params.tools?.length === 0 && params.extensions === false) expect(active).toEqual([]);
  });
});
