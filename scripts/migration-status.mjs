import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Compare the original source with its captured baseline; never copy or write. */
export async function sourceStatus(snapshot) {
  const paths = new Set();
  const root = await readdir(snapshot.source, { withFileTypes: true });
  for (const entry of root) {
    if (entry.isFile() && (snapshot.rootFiles.includes(entry.name) || snapshot.rootExtensions.includes(extname(entry.name)))) {
      paths.add(entry.name);
    }
  }
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(join(snapshot.source, directory), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) paths.add(relative);
      else throw new Error(`Unsupported source entry: ${join(snapshot.source, relative)}`);
    }
  }
  for (const directory of snapshot.directories) await visit(directory);
  const added = [], modified = [], removed = [];
  for (const path of [...paths].sort()) {
    if (!Object.hasOwn(snapshot.files, path)) added.push(path);
    else {
      const digest = createHash("sha256").update(await readFile(join(snapshot.source, path))).digest("hex");
      if (digest !== snapshot.files[path]) modified.push(path);
    }
  }
  for (const path of Object.keys(snapshot.files).sort()) if (!paths.has(path)) removed.push(path);
  return { added, modified, removed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const snapshots = JSON.parse(await readFile(new URL("../migration/sources.json", import.meta.url), "utf8"));
  let changed = false;
  for (const [name, snapshot] of Object.entries(snapshots)) {
    const status = await sourceStatus(snapshot);
    const count = Object.values(status).reduce((total, paths) => total + paths.length, 0);
    console.log(`${name}: ${count ? `${count} source changes since snapshot` : "matches imported snapshot"}`);
    for (const [kind, paths] of Object.entries(status)) for (const path of paths) console.log(`  ${kind}: ${path}`);
    changed ||= count > 0;
  }
  if (changed && process.argv.includes("--check")) process.exitCode = 1;
}
