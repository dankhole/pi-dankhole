import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.js";

/** Read pi's built-in names from its factories without invoking any tools. */
export const BUILTIN_TOOL_NAMES: string[] = [
  ...new Set([...createCodingTools("."), ...createReadOnlyTools(".")].map(tool => tool.name)),
];

/** Root-only delegation tools; workers must never regain them through extensions. */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  GET_RESULT: "get_subagent_result",
  STEER: "steer_subagent",
  STOP: "stop_subagent",
} as const;

/** Includes memory's implicit tools, with the launch denylist applied. */
export function getEffectiveBuiltinToolNames(config: AgentConfig): string[] {
  const denied = new Set(config.disallowedTools ?? []);
  const names = new Set(config.builtinToolNames ?? BUILTIN_TOOL_NAMES);
  if (config.memory) {
    const writable = ["write", "edit"].some(name => names.has(name) && !denied.has(name));
    for (const name of writable ? ["read", "write", "edit"] : ["read"]) names.add(name);
  }
  return [...names].filter(name => !denied.has(name));
}

/** Runtime semantics: case-insensitive extension names; narrowing always wins. */
export function parseExtSelectors(entries: string[]): {
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
} {
  const extNames = new Set<string>();
  const narrowing = new Map<string, Set<string>>();
  for (const raw of entries) {
    if (!raw) continue;
    const body = raw.slice("ext:".length);
    const slash = body.indexOf("/");
    const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
    if (!name) continue;
    extNames.add(name);
    if (slash === -1) continue;
    const tool = body.slice(slash + 1).trim();
    if (!tool) continue;
    let set = narrowing.get(name);
    if (!set) {
      set = new Set();
      narrowing.set(name, set);
    }
    set.add(tool);
  }
  return { extNames, narrowing };
}
