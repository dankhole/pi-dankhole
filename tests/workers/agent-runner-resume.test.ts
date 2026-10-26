import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resumeAgent, runAgent } from "../../src/workers/agent-runner.js";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "../../src/workers/model-scope.js";
import type { AgentConfig } from "../../src/workers/types.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

/** Real persisted sessions: reopen must continue history, not re-fork its parent. */
describe("worker reopen and model provenance (real sessions)", () => {
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;
  let previousScope: boolean;
  let faux: ReturnType<typeof registerFauxProvider>;
  const sessions: AgentSession[] = [];
  const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "worker-reopen-"));
    agentDir = join(cwd, "agent-home");
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    previousScope = isScopeModelsEnabled();
    setScopeModelsEnabled(false);
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    faux.setResponses(Array.from({ length: 8 }, () => () => fauxAssistantMessage([fauxText("done")])));
  });
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    faux.unregister();
    setScopeModelsEnabled(previousScope);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  });

  function context(parent: SessionManager): ExtensionContext {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const allowed = { ...model, provider: "allowed", id: "allowed-model" };
    backend.modelRegistry.getAll = () => [model, allowed];
    backend.modelRegistry.getAvailable = () => [model, allowed];
    backend.modelRegistry.find = (provider: string, id: string) => [model, allowed].find(candidate => candidate.provider === provider && candidate.id === id);
    backend.modelRegistry.runtime = backend.modelRuntime;
    return {
      cwd,
      model,
      modelRegistry: backend.modelRegistry,
      getSystemPrompt: () => "Inherited parent rules",
      isProjectTrusted: () => true,
      sessionManager: parent,
    } as unknown as ExtensionContext;
  }

  function userMessages(session: AgentSession): string[] {
    return session.messages.filter(message => message.role === "user").map(message =>
      typeof message.content === "string" ? message.content : message.content.map(block => block.type === "text" ? block.text : "").join(""),
    );
  }

  it("reopening injects neither repeated original nor newly added parent history", async () => {
    const parent = SessionManager.inMemory(cwd);
    parent.appendMessage({ role: "user", content: "ORIGINAL-PARENT-HISTORY", timestamp: Date.now() });
    const ctx = context(parent);
    const config: AgentConfig = {
      extensions: false, skills: false, builtinToolNames: [], inheritContext: true,
      persistSession: true, sessionDir: join(cwd, "sessions"),
    };
    const first = await runAgent(ctx, "Original task", { pi, config, onSessionCreated: session => { sessions.push(session); } });
    expect(first.failure).toBeUndefined();
    const initialUsers = userMessages(first.session);
    expect(initialUsers).toHaveLength(1);
    expect(initialUsers[0]).toContain("ORIGINAL-PARENT-HISTORY");
    const snapshot = join(cwd, "original-copy.jsonl");
    copyFileSync(first.session.sessionManager.getSessionFile()!, snapshot);
    parent.appendMessage({ role: "user", content: "NEW-PARENT-HISTORY", timestamp: Date.now() });

    await resumeAgent(first.session, "Continue the task", {});
    const reopened = await runAgent(ctx, "Continue the task", {
      pi, config, resumeSessionFile: snapshot,
      onSessionCreated: session => { sessions.push(session); },
    });

    expect(reopened.failure).toBeUndefined();
    const reopenedUsers = userMessages(reopened.session);
    expect(reopenedUsers).toEqual(userMessages(first.session));
    expect(reopenedUsers).toEqual([initialUsers[0], "Continue the task"]);
    expect(reopenedUsers.join("\n").match(/ORIGINAL-PARENT-HISTORY/g)).toHaveLength(1);
    expect(reopenedUsers.join("\n")).not.toContain("NEW-PARENT-HISTORY");
  });

  it("allows an inherited object model but rejects explicit object and config selections", async () => {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["allowed/allowed-model"] }));
    setScopeModelsEnabled(true);
    const ctx = context(SessionManager.inMemory(cwd));
    const config: AgentConfig = { extensions: false, skills: false, builtinToolNames: [], persistSession: false };
    const inherited = await runAgent(ctx, "Inherited model", {
      pi, config, model: ctx.model, modelFromParams: false,
      onSessionCreated: session => { sessions.push(session); },
    });
    expect(inherited.failure).toBeUndefined();
    expect(inherited.session.model?.id).toBe("faux-1");
    await expect(runAgent(ctx, "Explicit object", { pi, config, model: ctx.model })).rejects.toThrow("Model not in scope");
    const forgedResult = await runAgent(ctx, "Explicit selector with forged provenance", {
      pi, config: { ...config, model: "faux/faux-1" }, modelFromParams: false,
      onSessionCreated: session => { sessions.push(session); },
    }).then(() => "accepted", error => error instanceof Error ? error.message : String(error));
    expect(forgedResult).toContain("Model not in scope");
  });
});
