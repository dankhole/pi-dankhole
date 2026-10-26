import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sourceStatus } from "../../scripts/migration-status.mjs";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const source = await mkdtemp(join(tmpdir(), "dankhole-import-"));
  roots.push(source);
  await mkdir(join(source, "tests"));
  await writeFile(join(source, "index.ts"), "original");
  await writeFile(join(source, "README.md"), "guide");
  return {
    source, directories: ["tests"], rootFiles: ["README.md"], rootExtensions: [".ts"],
    files: {
      "index.ts": createHash("sha256").update("original").digest("hex"),
      "README.md": createHash("sha256").update("guide").digest("hex"),
    },
  };
}

describe("read-only import reconciliation", () => {
  it("accepts the captured source without including unrelated files", async () => {
    const snapshot = await fixture();
    await writeFile(join(snapshot.source, "unrelated.log"), "not an import");
    expect(await sourceStatus(snapshot)).toEqual({ added: [], modified: [], removed: [] });
  });

  it("reports later edits, additions and removals without changing the baseline", async () => {
    const snapshot = await fixture();
    const originalHash = snapshot.files["index.ts"];
    await writeFile(join(snapshot.source, "index.ts"), "user's later work");
    await writeFile(join(snapshot.source, "feature.ts"), "new feature");
    await writeFile(join(snapshot.source, "tests/feature.test.mjs"), "test");
    await rm(join(snapshot.source, "README.md"));
    expect(await sourceStatus(snapshot)).toEqual({
      added: ["feature.ts", "tests/feature.test.mjs"], modified: ["index.ts"], removed: ["README.md"],
    });
    expect(snapshot.files["index.ts"]).toBe(originalHash);
  });

  it("reports an unavailable original instead of claiming a match", async () => {
    const snapshot = await fixture();
    await rm(snapshot.source, { recursive: true });
    await expect(sourceStatus(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
