import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_NAMES, SUBAGENT_TOOL_NAMES } from "../../src/workers/tool-names.js";

describe("worker tool names", () => {
  it("includes pi's known built-in tools", () => {
    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
      expect(BUILTIN_TOOL_NAMES).toContain(name);
    }
  });

  it("has no duplicate built-in names", () => {
    expect(new Set(BUILTIN_TOOL_NAMES).size).toBe(BUILTIN_TOOL_NAMES.length);
  });

  it("retains the three worker-control tool names", () => {
    expect(SUBAGENT_TOOL_NAMES).toEqual({
      AGENT: "Agent",
      GET_RESULT: "get_subagent_result",
      STEER: "steer_subagent",
    });
  });
});
