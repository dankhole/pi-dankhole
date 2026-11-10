import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, getCurrentTools,
  resolveTranscript, type SystemMessage, Type,
} from "@earendil-works/pi-ai";
import {
  type AgentSession, type BeforeAgentStartEvent, type BeforeAgentStartEventResult,
  type ContextEventResult, type ContextWithSystemEvent, createAgentSession, createSyntheticSourceInfo,
  DefaultResourceLoader, type ExtensionAPI, type ExtensionHandler,
  type NormalizedBuildSystemPromptOptions, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerPromptGuidance from "../../src/session/prompt-guidance.js";
import { ctx } from "../workers/helpers/boot-extension.js";
import { fauxModelBackend } from "../workers/helpers/faux-model-backend.js";
import { registerFauxProvider } from "../workers/helpers/pi-ai.js";

const concise = "- Be concise in your responses";
const wrap = (...lines: string[]) => `<rules>\n${lines.join("\n")}\n</rules>`;
const system = (rules: string | null, rest: Partial<SystemMessage> = {}): SystemMessage => ({
  role: "system", content: "", timestamp: 1, sections: { rules }, ...rest,
});
const options = (overrides: Partial<NormalizedBuildSystemPromptOptions> = {}): NormalizedBuildSystemPromptOptions => ({
  cwd: "/fixture", selectedTools: ["read"], hiddenTools: [], toolSnippets: {}, toolGuidelines: {},
  promptGuidelines: [], appendSystemPrompt: "", sections: {}, contextFiles: [], skills: [], ...overrides,
});

function hook(tools: ReturnType<ExtensionAPI["getAllTools"]> = []) {
  const on = vi.fn();
  registerPromptGuidance({ on, getAllTools: () => tools } as unknown as ExtensionAPI);
  const before = on.mock.calls.find(([name]) => name === "before_agent_start")![1] as
    ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
  const transform = on.mock.calls.find(([name]) => name === "context_with_system")![1] as
    ExtensionHandler<ContextWithSystemEvent, ContextEventResult>;
  const shutdown = on.mock.calls.find(([name]) => name === "session_shutdown")![1] as () => void;
  return {
    async start(systemPromptOptions = options()) {
      await before({ type: "before_agent_start", messageType: "user", prompt: "fixture", systemPrompt: "", systemPromptOptions }, ctx());
    },
    transform: (messages: AgentMessage[]) => transform({ type: "context_with_system", messages }, ctx()),
    shutdown,
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("request-local default prompt guidance", () => {
  it("changes only exact rules lines, without mutating any input or collapsing section deltas", async () => {
    const h = hook();
    const configuration = freeze(options());
    await h.start(configuration);
    const rules = wrap("- Keep dynamic guidance", concise, `${concise}.`, ` ${concise}`, "- Show paths");
    const messages: AgentMessage[] = freeze([
      system(rules, { content: "Opaque text stays", sections: {
        rules, docs: concise, skills: concise, project_context: concise, other_extension: concise,
      }, toolsAdded: [{ name: "read", description: "reader", parameters: Type.Object({}) }] }),
      { role: "user", content: concise, timestamp: 2 },
      system(wrap("- New dynamic tool rule", concise), { timestamp: 3, toolsRemoved: [{ name: "read" }] }),
      system(null, { timestamp: 4 }),
      system("Foreign unwrapped rules\n" + concise, { timestamp: 5 }),
      system(wrap("- No target"), { timestamp: 6 }),
    ]);
    const before = structuredClone(messages);
    const result = await h.transform(messages);
    expect(result?.messages).toHaveLength(messages.length);
    const output = result!.messages!;
    expect(output[0]).not.toBe(messages[0]);
    expect(output[0]).toEqual({ ...messages[0], sections: {
      ...(messages[0] as SystemMessage).sections,
      rules: wrap("- Keep dynamic guidance", `${concise}.`, ` ${concise}`, "- Show paths"),
    } });
    expect(output[2]).toEqual({ ...messages[2], sections: { rules: wrap("- New dynamic tool rule") } });
    for (const index of [1, 3, 4, 5]) expect(output[index]).toBe(messages[index]);
    expect(getCurrentTools(output)).toEqual(getCurrentTools(messages));
    expect(messages).toEqual(before);
    expect(configuration).toEqual(options());
    expect(await h.transform(output)).toBeUndefined();
  });

  it.each([
    { customPrompt: "Custom prompt" },
    { customPrompt: "" },
    { forceSystemPrompt: "Forced prompt" },
    { forceSystemPrompt: "" },
    { sections: { rules: wrap(concise) } },
    { sections: { rules: "" } },
    { promptGuidelines: [" Be concise in your responses "] },
    { promptGuidelines: [`Other instruction\n${concise}`] },
    { toolGuidelines: { read: ["Be concise in your responses"] } },
  ])("respects explicit prompt/rule intent: %j", async override => {
    const h = hook();
    const configuration = options();
    await h.start(configuration);
    // Simulate a later before_agent_start extension editing the same live options.
    Object.assign(configuration, override);
    const messages = freeze([system(wrap(concise, "- Keep this"), {
      toolsAdded: [{ name: "read", description: "reader", parameters: Type.Object({}) }],
    })]);
    expect(await h.transform(messages)).toBeUndefined();
    expect(messages[0].sections?.rules).toContain(concise);
  });

  it("does not change opaque system content, other sections, or unrecognized rule wrapping", async () => {
    const h = hook();
    await h.start();
    const messages: AgentMessage[] = freeze([
      { role: "system", content: wrap(concise), timestamp: 1 },
      system(null, { sections: { docs: concise } }),
      system(concise), system(`<rules>\r\n${concise}\r\n</rules>`),
      system(wrap(concise) + "\nForeign suffix"),
    ]);
    expect(await h.transform(messages)).toBeUndefined();
  });

  it("respects an explicit guideline on a tool registered after run preparation", async () => {
    const tools: ReturnType<ExtensionAPI["getAllTools"]> = [];
    const h = hook(tools);
    await h.start();
    tools.push({ name: "late", description: "late tool", parameters: Type.Object({}), exposure: "direct",
      sourceInfo: createSyntheticSourceInfo("<inline:late>", { source: "inline" }),
      promptGuidelines: ["Be concise in your responses"],
    });
    const messages = [system(wrap(concise, "- Other guideline"), {
      toolsAdded: [{ name: "late", description: "late tool", parameters: Type.Object({}) }],
    })];
    expect(await h.transform(messages)).toBeUndefined();
  });

  it("preserves an observed explicit rules override in later default-prompt history", async () => {
    const h = hook();
    const foreignRules = wrap(concise, "- Foreign rule");
    const authored = system(foreignRules);
    await h.start(options({ sections: { rules: `${concise}\n- Foreign rule` } }));
    expect(await h.transform([authored])).toBeUndefined();
    await h.start();
    const result = await h.transform([authored, system(wrap(concise, "- Fresh default rule"))]);
    expect(result!.messages![0]).toBe(authored);
    expect((result!.messages![1] as SystemMessage).sections?.rules).toBe(wrap("- Fresh default rule"));
  });

  it("requires a current run and clears run options on shutdown", async () => {
    const h = hook();
    const messages = [system(wrap(concise, "- Keep this"))];
    expect(await h.transform(messages)).toBeUndefined();
    await h.start();
    expect(await h.transform(messages)).toBeDefined();
    h.shutdown();
    expect(await h.transform(messages)).toBeUndefined();
    await h.start(options({ customPrompt: "Other session" }));
    expect(await h.transform(messages)).toBeUndefined();
  });
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

describe("real Pi request pipeline", () => {
  it("filters fresh rules after tool/hidden-loadout changes while preserving stored history and other extensions", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "prompt-guidance-"));
    const previousHome = process.env.HOME;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = scratch;
    process.env.PI_CODING_AGENT_DIR = scratch;
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "guidance", contextWindow: 200_000 }] });
    let session: AgentSession | undefined;
    cleanup = async () => {
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      faux.unregister();
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(scratch, { recursive: true, force: true });
    };
    await writeFile(join(scratch, "SKILL.md"), "# Fixture\nSkill stays\n");
    const before: AgentMessage[][] = [];
    const after: AgentMessage[][] = [];
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    let api!: ExtensionAPI;
    const loader = new DefaultResourceLoader({
      cwd: scratch, agentDir: scratch, settingsManager,
      noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      agentsFilesOverride: () => ({ agentsFiles: [{ path: "/fixture/AGENTS.md", content: "Project guidance stays" }] }),
      skillsOverride: () => ({ skills: [{ name: "fixture", description: "Skill stays", filePath: join(scratch, "SKILL.md"),
        baseDir: scratch, source: "test", disableModelInvocation: false }], diagnostics: [] }),
      appendSystemPrompt: ["Appended instructions stay"],
      extensionFactories: [pi => {
        api = pi;
        pi.on("context_with_system", event => { before.push(structuredClone(event.messages)); });
      }, registerPromptGuidance, pi => {
        pi.registerTool({ name: "switch_loadout", label: "switch", description: "switch", parameters: Type.Object({}),
          promptGuidelines: ["Switch guideline stays"], execute: async () => {
            pi.setActiveTools(["read", "second_tool", "hide_bridge", "hidden_tool"]);
            return { content: [{ type: "text", text: "switched" }], details: undefined };
          } });
        pi.registerTool({ name: "second_tool", label: "second", description: "second", parameters: Type.Object({}),
          promptGuidelines: ["Fresh second-tool guideline stays"],
          execute: async () => ({ content: [], details: undefined }) });
        pi.registerTool({ name: "hidden_tool", label: "hidden", description: "hidden", parameters: Type.Object({}),
          promptSnippet: "Hidden snippet", promptGuidelines: ["Hidden guideline must not appear"],
          execute: async () => ({ content: [], details: undefined }) });
        pi.registerTool({ name: "hide_bridge", label: "bridge", description: "bridge", parameters: Type.Object({}),
          prepareLoadout: () => ({ hiddenDeclarations: ["hidden_tool"] }),
          execute: async () => ({ content: [], details: undefined }) });
        pi.on("before_agent_start", event => {
          event.systemPromptOptions.sections.other_extension = "Other extension stays";
          event.systemPromptOptions.promptGuidelines.push("Late extension guideline stays");
        });
        pi.on("context_with_system", event => { after.push(structuredClone(event.messages)); });
      }],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({
      ...fauxModelBackend(faux.getModel()), cwd: scratch, model: faux.getModel(),
      resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(scratch),
    }));
    await session.bindExtensions({});
    api.setActiveTools(["bash", "switch_loadout"]);
    const providerRequests: AgentMessage[][] = [];
    faux.setResponses([
      context => {
        providerRequests.push(structuredClone(context.messages));
        return fauxAssistantMessage([fauxToolCall("switch_loadout", {})], { stopReason: "toolUse" });
      },
      context => { providerRequests.push(structuredClone(context.messages)); return fauxAssistantMessage("done"); },
    ]);
    await session.prompt("Exercise dynamic tools");
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    // Pi projects hidden declarations after extension context hooks, without changing sections.
    const projected = after.map(messages => messages.map(message => {
      if (message.role !== "system" || !message.toolsAdded?.some(tool => tool.name === "hidden_tool")) return message;
      const { toolsAdded, ...rest } = message;
      const visible = toolsAdded.filter(tool => tool.name !== "hidden_tool");
      return visible.length ? { ...rest, toolsAdded: visible } : rest;
    }));
    expect(providerRequests).toEqual(projected);
    expect(getCurrentTools(providerRequests[1]).map(tool => tool.name)).not.toContain("hidden_tool");
    for (let i = 0; i < before.length; i++) {
      const expected = before[i].map(message => message.role === "system" && typeof message.sections?.rules === "string"
        ? { ...message, sections: { ...message.sections, rules: message.sections.rules.split("\n").filter(line => line !== concise).join("\n") } }
        : message);
      expect(after[i]).toEqual(expected);
      expect(getCurrentTools(after[i])).toEqual(getCurrentTools(before[i]));
      for (const supportsMidConvoSystemMessages of [true, false]) {
        const replayed = resolveTranscript({ messages: after[i] }, supportsMidConvoSystemMessages);
        expect(getCurrentSystemMessage(replayed.messages)?.sections?.rules).not.toContain(concise);
      }
      const sections = getCurrentSystemMessage(after[i])!.sections!;
      expect(sections.docs).toContain("Pi documentation");
      expect(sections.project_context).toContain("Project guidance stays");
      expect(sections.skills).toContain("Skill stays");
      expect(sections.addendum).toContain("Appended instructions stay");
      expect(sections.other_extension).toContain("Other extension stays");
      expect(sections.rules).toContain("Late extension guideline stays");
    }
    expect(getCurrentSystemMessage(after[0])!.sections!.rules).toContain("Switch guideline stays");
    const secondRules = getCurrentSystemMessage(after[1])!.sections!.rules!;
    expect(secondRules).toContain("Fresh second-tool guideline stays");
    expect(secondRules).not.toContain("Switch guideline stays");
    expect(secondRules).not.toContain("Hidden guideline must not appear");
    const storedSystemMessages = session.messages.filter(message => message.role === "system");
    expect(storedSystemMessages.filter(message => message.sections?.rules)).toHaveLength(2);
    for (const message of storedSystemMessages) {
      if (message.sections?.rules) expect(message.sections.rules).toContain(concise);
    }
    expect(session.systemPrompt).toContain(concise);
  });
});
