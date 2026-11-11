import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentManager } from "./agent-manager.js";
import { SUBAGENT_TOOL_NAMES } from "./tool-names.js";

/** Parent-only adapter over the same cancellation path used by RPC and viewers. */
export function createStopSubagentTool(manager: Pick<AgentManager, "getRecord" | "abort">) {
  return defineTool({
    name: SUBAGENT_TOOL_NAMES.STOP,
    label: "Stop Agent",
    description:
      "Request cancellation of a managed running or queued worker using its Agent ID. Queued work is removed without starting. " +
      "Running work receives an abort request; this returns promptly, not when execution settles. " +
      "A provider or tool that ignores cancellation may keep running. Partial results remain available through get_subagent_result. " +
      "Only the main agent controls workers.",
    promptSnippet: "Request cancellation of a running or queued managed worker",
    parameters: Type.Object({
      agent_id: Type.String({ minLength: 1, description: "The worker ID returned by Agent (must be running or queued)." }),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, { agent_id }) => {
      const record = manager.getRecord(agent_id);
      if (!record) throw new Error(`Agent not found: "${agent_id}". Only live workers managed by this parent can be stopped.`);
      const wasQueued = record.status === "queued";
      if (!manager.abort(agent_id)) {
        throw new Error(`Agent "${agent_id}" is not running or queued (status: ${record.status}). No stop requested.`);
      }
      const text = wasQueued
        ? `Agent "${agent_id}" removed from the queue; this run will not start.`
        : `Stop requested for agent "${agent_id}". Its abort signal was sent; execution may still be settling. ` +
          "A provider or tool that ignores cancellation can keep running. The stopped status records the request, not proof of settlement.";
      return {
        content: [{ type: "text", text: text + "\nAvailable output may be partial; use get_subagent_result to retrieve it. Do not resume until the current execution has settled." }],
        details: { agentId: agent_id, status: record.status, wasQueued },
      };
    },
  });
}
