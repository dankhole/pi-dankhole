import type { AgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readManifest } = vi.hoisted(() => ({ readManifest: vi.fn() }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      typeof args[0] === "string" && args[0].startsWith("/scope-fixture/")
        ? readManifest(args[0])
        : actual.readFileSync(...args),
  };
});

import { installExtensionToolScope } from "../../src/workers/agent-runner.js";

function scopeHarness() {
  const manifests = new Map([
    ["/scope-fixture/owner/package.json", JSON.stringify({ name: "@test/owner", pi: { extensions: ["./index.ts"] } })],
    ["/scope-fixture/unrelated/package.json", JSON.stringify({ name: "unrelated", pi: { extensions: ["./index.ts"] } })],
  ]);
  readManifest.mockImplementation((path: string) => {
    const manifest = manifests.get(path);
    if (manifest === undefined) throw new Error(`ENOENT: ${path}`);
    return manifest;
  });
  let extensions = [
    { path: "/scope-fixture/owner/index.ts", tools: new Map([["probe", {}]]) },
    { path: "/scope-fixture/unrelated/index.ts", tools: new Map([["other", {}]]) },
  ];
  const toolNames = ["read"];
  const disallowedSet = new Set<string>();
  const extNames = new Set(["owner"]);
  const narrowing = new Map([["owner", new Set(["probe"])]]);
  const gate = { allows: (_name: string) => false };
  const prior = vi.fn<NonNullable<AgentSession["agent"]["beforeToolCall"]>>(async () => undefined);
  const agent = { beforeToolCall: prior as NonNullable<AgentSession["agent"]["beforeToolCall"]> };
  const session = {
    agent,
    getActiveToolNames: () => ["read", "probe"],
    getAllTools: () => [{ name: "read" }, { name: "probe" }],
    getToolDefinition: () => undefined,
    setActiveToolsByName: vi.fn(),
    subscribe: () => () => {},
  };
  installExtensionToolScope(session as unknown as AgentSession, {
    loader: { getExtensions: () => ({ extensions }) } as unknown as DefaultResourceLoader,
    toolNames, disallowedSet, extNames, narrowing, callGate: gate,
  });
  readManifest.mockClear();
  const direct = (name: string) => agent.beforeToolCall({ toolCall: { name } } as never, undefined as never);
  return {
    gate, direct, prior, manifests, extensions, toolNames, disallowedSet, extNames, narrowing,
    replaceExtensions: (next: typeof extensions) => { extensions = next; },
  };
}

beforeEach(() => { readManifest.mockReset(); });

describe("requested-name scope checks", () => {
  it("does zero manifest I/O for repeated allowed built-ins through either gate", async () => {
    const h = scopeHarness();
    for (let i = 0; i < 1000; i++) {
      expect(h.gate.allows("read")).toBe(true);
      expect(await h.direct("read")).toBeUndefined();
    }
    expect(readManifest).not.toHaveBeenCalled();
    expect(h.prior).toHaveBeenCalledTimes(1000);
  });

  it("applies live deny/delegation rules before built-ins or owning extensions", async () => {
    const h = scopeHarness();
    h.toolNames.push("Agent");
    h.disallowedSet.add("read");
    for (const name of ["read", "Agent", "get_subagent_result", "steer_subagent", "stop_subagent"]) {
      expect(h.gate.allows(name)).toBe(false);
      expect(await h.direct(name)).toMatchObject({ block: true });
    }
    expect(readManifest).not.toHaveBeenCalled();
    expect(h.prior).not.toHaveBeenCalled();
    h.disallowedSet.delete("read");
    expect(h.gate.allows("read")).toBe(true);
  });

  it("reads only current owners and rechecks their manifests without caching", async () => {
    const h = scopeHarness();
    expect(h.gate.allows("probe")).toBe(true);
    expect(readManifest.mock.calls.map(([path]) => path)).toEqual(["/scope-fixture/owner/package.json"]);
    // Change just the package alias; the path-derived name stays 'owner'.
    h.extNames.clear();
    h.extNames.add("renamed");
    h.manifests.set("/scope-fixture/owner/package.json", JSON.stringify({ name: "renamed", pi: { extensions: ["./index.ts"] } }));
    expect(h.gate.allows("probe")).toBe(true);
    h.manifests.set("/scope-fixture/owner/package.json", JSON.stringify({ name: "different", pi: { extensions: ["./index.ts"] } }));
    expect(h.gate.allows("probe")).toBe(false);
    expect(await h.direct("probe")).toMatchObject({ block: true });
    expect(readManifest.mock.calls.every(([path]) => path === "/scope-fixture/owner/package.json")).toBe(true);
  });

  it("observes late maps, replacement owners, and changed narrowing on every call", async () => {
    const h = scopeHarness();
    expect(h.gate.allows("late")).toBe(false);
    expect(readManifest).not.toHaveBeenCalled();
    h.extensions[0].tools.set("late", {});
    expect(h.gate.allows("late")).toBe(false);
    h.narrowing.get("owner")!.add("late");
    expect(h.gate.allows("late")).toBe(true);
    h.narrowing.get("owner")!.delete("late");
    expect(await h.direct("late")).toMatchObject({ block: true });
    h.replaceExtensions([{ path: "/scope-fixture/unrelated/index.ts", tools: new Map([["probe", {}]]) }]);
    expect(h.gate.allows("probe")).toBe(false);
    h.extNames.add("unrelated");
    expect(h.gate.allows("probe")).toBe(true);
    expect(await h.direct("probe")).toBeUndefined();
  });
});
