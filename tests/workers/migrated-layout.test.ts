import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extensionCanonicalNames, parseExtensionsSpec } from "../../src/workers/agent-runner.js";

const workerEntry = fileURLToPath(new URL("../../src/workers/index.ts", import.meta.url));
const packageEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const fixtureEntry = fileURLToPath(new URL("./fixtures/e2e-probe-ext.mjs", import.meta.url));

describe("migrated worker layout", () => {
  it("keeps the worker-only registrar distinct from the declared package entry", () => {
    expect(extensionCanonicalNames(workerEntry)).toEqual(["workers"]);
    expect(extensionCanonicalNames(packageEntry)).toEqual(["src", "pi-dankhole"]);
  });

  it("does not give co-located fixture extensions the combined package identity", () => {
    expect(extensionCanonicalNames(fixtureEntry)).toEqual(["e2e-probe-ext.mjs"]);
  });

  it("matches an explicit moved registrar path as workers", () => {
    const parsed = parseExtensionsSpec([workerEntry], "/unrelated-cwd");
    expect(parsed.paths).toEqual([workerEntry]);
    expect([...parsed.names]).toEqual(["workers"]);
    expect(parsed.wildcard).toBe(false);
  });
});
