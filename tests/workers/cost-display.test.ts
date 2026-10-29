/**
 * cost-display.test.ts — what `showCost` puts on each surface, and what it must
 * never put there.
 *
 * Two rules run through all of it. A cost is shown only when there is one to
 * show: a model pi has no rates for reports 0, which stays hidden rather than
 * sharing the `~$0` display of small positive estimates. Each surface punctuates
 * its own — the stats line joins with `·`, the foreground result with `,`, the
 * `get_subagent_result` header with `|` — which is why the cost travels as a
 * number and is formatted at the end, not baked into the token string.
 */
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

vi.mock("../../src/workers/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/workers/agent-runner.js")>("../../src/workers/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../../src/workers/agent-runner.js";

import subagentsExtension from "../../src/workers/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const COST = 0.0123;
let parentContext: ExtensionContext | undefined;

/** One foreground run that spends `cost` on a single assistant message. */
function runSpending(cost: number) {
  vi.mocked(runAgent).mockImplementation(async (_c, _prompt, opts) => {
    opts.onAssistantUsage?.({ input: 1000, output: 200, cacheWrite: 0, cost });
    return { responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false };
  });
}

const spawn = (tools: Map<string, any>) =>
  tools.get("Agent").execute(
    "tc-1",
    { prompt: "go", description: "spend", run_in_background: false },
    undefined, undefined, parentContext,
  );

describe("cost display", () => {
  let hermetic: Hermetic;
  let activeLifecycle: Map<string, any> | undefined;

  async function boot(settings: Record<string, unknown>) {
    hermetic = hermeticDir({ settings });
    const { pi, tools, lifecycle } = makePi();
    activeLifecycle = lifecycle;
    const sessionManager = SessionManager.inMemory(hermetic.dir);
    pi.appendEntry.mockImplementation((type: string, data: unknown) => { sessionManager.appendCustomEntry(type, data); });
    pi.sendMessage.mockImplementation((message: Parameters<ExtensionAPI["sendMessage"]>[0]) => {
      sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      queueMicrotask(() => { lifecycle.get("turn_start")?.(); });
    });
    subagentsExtension(pi);
    parentContext = ctx({ sessionManager, hasPendingMessages: () => false });
    await lifecycle.get("session_start")({}, parentContext);
    return { pi, tools, lifecycle };
  }

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
  });

  afterEach(async () => {
    await activeLifecycle?.get("session_shutdown")?.();
    activeLifecycle = undefined;
    parentContext = undefined;
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    hermetic?.restore();
  });

  describe("the foreground result the orchestrator reads", () => {
    it("names the cost in the stats it already reports", async () => {
      const { tools } = await boot({ showCost: true });
      runSpending(COST);

      const result = await spawn(tools);
      const text = textOf(result);

      expect(result.details.cost).toBe(COST);
      expect(text).toContain("~$0");
      // Comma-joined with the rest, not glued to the token count with the "·"
      // that the widget uses — the separator belongs to the surface.
      expect(text).toMatch(/1\.2k token, ~\$0/);
    });

    it("says nothing when the setting is off", async () => {
      const { tools } = await boot({ showCost: false });
      runSpending(COST);

      expect(textOf(await spawn(tools))).not.toContain("$");
    });

    it("says nothing for a model with no pricing data", async () => {
      const { tools } = await boot({ showCost: true });
      runSpending(0);

      const text = textOf(await spawn(tools));
      expect(text).toContain("1.2k token");   // tokens are still exact
      expect(text).not.toContain("$");
    });
  });

  describe("get_subagent_result", () => {
    it("reports the cost as its own labelled field", async () => {
      const { tools } = await boot({ showCost: true });
      runSpending(COST);
      const spawned = await spawn(tools);
      await flush();

      // Controls address the stable ID returned by the foreground launch.
      const text = textOf(await tools.get("get_subagent_result").execute(
        "tc-2", { agent_id: spawned.details.agentId }, undefined, undefined, ctx(),
      ));

      // Pipe-separated `Label: value` fields, matching its neighbours.
      expect(text).toContain("Cost: ~$0");
    });

    it("omits the field entirely when unpriced", async () => {
      const { tools } = await boot({ showCost: true });
      runSpending(0);
      const spawned = await spawn(tools);
      await flush();

      const text = textOf(await tools.get("get_subagent_result").execute(
        "tc-2", { agent_id: spawned.details.agentId }, undefined, undefined, ctx(),
      ));

      expect(text).not.toContain("Cost:");
    });
  });

  describe("the background completion notification the model reads", () => {
    /**
     * The <task-notification> text sent into the idle parent conversation.
     * Allow the worker completion's promise chain to finish before inspecting it.
     */
    async function notificationText(pi: any): Promise<string> {
      await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledOnce());
      return pi.sendMessage.mock.calls[0][0].content;
    }

    const spawnBackground = (tools: Map<string, any>) =>
      tools.get("Agent").execute(
        "tc-1",
        { prompt: "go", description: "spend", run_in_background: true },
        undefined, undefined, parentContext,
      );

    it("includes the cost in the usage block when enabled", async () => {
      const { pi, tools } = await boot({ showCost: true });
      runSpending(COST);

      await spawnBackground(tools);

      expect(await notificationText(pi)).toContain("<estimated_cost_usd>0.0123</estimated_cost_usd>");
    });

    it("omits it when disabled — this is LLM context, not a display", async () => {
      // A figure the orchestrator was not asked to track is one it may start
      // reporting unprompted, so the setting gates the context too, not just
      // what a human sees.
      const { pi, tools } = await boot({ showCost: false });
      runSpending(COST);

      await spawnBackground(tools);

      const text = await notificationText(pi);
      expect(text).toContain("<total_tokens>");
      expect(text).not.toContain("estimated_cost_usd");
    });

    it("omits it for a model with no pricing data", async () => {
      const { pi, tools } = await boot({ showCost: true });
      runSpending(0);

      await spawnBackground(tools);

      expect(await notificationText(pi)).not.toContain("estimated_cost_usd");
    });
  });

  describe("the Agent tool renderer", () => {
    it.each([false, true])("rounds display without changing raw details (partial: %s)", async (isPartial) => {
      const { tools } = await boot({ showCost: true });
      const details = {
        description: "spend", status: isPartial ? "running" : "completed",
        tokens: "1.2k token", toolUses: 1, cost: 0.8534, durationMs: 811_100,
      };
      const original = structuredClone(details);
      const output = tools.get("Agent").renderResult(
        { content: [{ type: "text", text: "done" }], details },
        { expanded: false, isPartial }, getThemeByName("dark"), { isError: false },
      ).render(200).map(stripTerminalSequences).join("\n");
      expect(output).toContain("~$1");
      if (!isPartial) expect(output).toContain("14m");
      expect(output).not.toMatch(/\$\d+\.|\d+(?:\.\d+)?s\b/);
      expect(details).toEqual(original);
    });
  });

  describe("the completion notification", () => {
    /** Render a notification through the extension's registered renderer. */
    function render(pi: any, details: any): string {
      const [, renderer] = pi.registerMessageRenderer.mock.calls[0];
      const theme = getThemeByName("dark");
      return renderer({ details }, { expanded: false }, theme).render(100).map(stripTerminalSequences).join("\n");
    }

    const agent = (description: string, totalTokens: number, totalCost: number) => ({
      id: description, description, status: "completed", toolUses: 1, turnCount: 1,
      totalTokens, totalCost, durationMs: 1000, resultPreview: "done",
    });

    it("keeps each card's cost in its own header without a dense batch total", async () => {
      const { pi } = await boot({ showCost: true });
      const out = render(pi, { ...agent("first", 1000, 0.8534), others: [agent("second", 3000, 1.5)] });

      expect(out).toContain("~$1");
      expect(out).toContain("~$2");
      expect(out).not.toContain("agents ·");
    });

    it("does not total a single agent — the line above already says it", async () => {
      const { pi } = await boot({ showCost: true });
      const out = render(pi, agent("only", 1000, 0.8534));

      expect(out).toContain("~$1");
      expect(out).not.toContain("1 agents");
    });

    it("shows no total, and no per-agent cost, when unpriced", async () => {
      const { pi } = await boot({ showCost: true });
      const out = render(pi, { ...agent("first", 1000, 0), others: [agent("second", 3000, 0)] });

      expect(out).not.toContain("$");
    });

    it("shows nothing when the setting is off", async () => {
      const { pi } = await boot({ showCost: false });
      const out = render(pi, { ...agent("first", 1000, 0.01), others: [agent("second", 3000, 0.02)] });

      expect(out).not.toContain("$");
    });
  });
});
