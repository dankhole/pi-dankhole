import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Exercise registration through Pi's actual TypeScript extension loader.
const root = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const { loadExtensions } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")).href);
const scratch = mkdtempSync(join(tmpdir(), "pi-chat-timer-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const timerPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styling/timer.ts");
let serial = 0;
async function load(enabled = true) {
  const path = join(scratch, `timer-${serial++}.ts`);
  writeFileSync(path, `import { registerTimer } from ${JSON.stringify(timerPath)};\nexport default pi => registerTimer(pi, ${enabled});\n`);
  const loaded = await loadExtensions([path], scratch);
  assert.deepEqual(loaded.errors, []);
  return loaded.extensions[0];
}
async function emit(extension, name, ctx) {
  for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name }, ctx);
}
function clock(t) {
  let now = Date.parse("2026-01-02T12:00:00.000Z");
  const intervals = new Set();
  const created = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    const timer = { callback, delay, unrefs: 0, unref() { this.unrefs++; } };
    created.push(timer);
    intervals.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearInterval", timer => intervals.delete(timer));
  return {
    intervals, created,
    now: () => now,
    advance(ms) {
      now += ms;
      for (const timer of intervals) timer.callback();
    },
  };
}
function context(timestamp, overrides = {}) {
  const statuses = new Map([["another-extension", "other status"]]);
  const writes = [];
  return {
    mode: "tui", hasUI: true,
    sessionManager: { getHeader: () => timestamp === null ? null : { timestamp } },
    ui: {
      setStatus(key, value) {
        writes.push([key, value]);
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setFooter() { assert.fail("must retain native footer"); },
    },
    statuses, writes,
    ...overrides,
  };
}
const text = ctx => ctx.statuses.get("compact-tools:chat-timer");

test("loading registers lifecycle hooks without starting a timer or replacing the footer", async t => {
  const fake = clock(t);
  const extension = await load();
  assert.deepEqual([...extension.handlers.keys()], ["session_start", "session_shutdown"]);
  assert.equal(extension.tools.size, 0);
  assert.equal(extension.commands.size, 0);
  assert.equal(extension.toolRenderers?.length ?? 0, 0);
  assert.equal(fake.created.length, 0);
});

test("formats minute-only elapsed time without a prefix and skips unchanged redraws", async t => {
  const fake = clock(t);
  const extension = await load();
  const ctx = context(new Date(fake.now()).toISOString());
  await emit(extension, "session_start", ctx);
  t.after(() => emit(extension, "session_shutdown", ctx));
  assert.equal(text(ctx), "0m");
  const initialWrites = ctx.writes.length;
  assert.equal(fake.created[0].delay, 1000);
  assert.equal(fake.created[0].unrefs, 1);
  fake.advance(999);
  assert.equal(text(ctx), "0m");
  fake.advance(1000);
  assert.equal(text(ctx), "0m");
  assert.equal(ctx.writes.length, initialWrites);
  fake.advance(58001);
  assert.equal(text(ctx), "1m");
  assert.equal(ctx.writes.length, initialWrites + 1);
  fake.advance(694000);
  assert.equal(text(ctx), "12m");
  fake.advance(2974000);
  assert.equal(text(ctx), "1h 2m");
  fake.advance(-4000000); // A system clock adjustment cannot produce a negative display.
  assert.equal(text(ctx), "0m");
  assert.equal(ctx.statuses.get("another-extension"), "other status");
});

test("resuming and reloading retain elapsed time from the session header", async t => {
  const fake = clock(t);
  const timestamp = new Date(fake.now() - 754000).toISOString();
  let extension = await load();
  const first = context(timestamp);
  await emit(extension, "session_start", first);
  assert.equal(text(first), "12m");
  await emit(extension, "session_shutdown", first); // Pi's /reload lifecycle.
  assert.equal(fake.intervals.size, 0);
  assert.equal(text(first), undefined);
  const writeCount = first.writes.length;
  fake.advance(60000);
  assert.equal(first.writes.length, writeCount);
  extension = await load();
  const resumed = context(timestamp);
  await emit(extension, "session_start", resumed);
  assert.equal(text(resumed), "13m");
  assert.equal(fake.intervals.size, 1);
  await emit(extension, "session_shutdown", resumed);
  await emit(extension, "session_shutdown", resumed); // Cleanup is idempotent.
  assert.equal(fake.intervals.size, 0);
  assert.equal(text(resumed), undefined);
  assert.equal(resumed.statuses.get("another-extension"), "other status");
});

test("repeated session_start replaces the interval and session timestamp", async t => {
  const fake = clock(t);
  const extension = await load();
  const first = context(new Date(fake.now() - 60000).toISOString());
  await emit(extension, "session_start", first);
  const second = context(new Date(fake.now() - 5000).toISOString());
  await emit(extension, "session_start", second);
  assert.equal(text(first), undefined);
  assert.equal(text(second), "0m");
  assert.equal(fake.intervals.size, 1);
  await emit(extension, "session_shutdown", second);
  assert.equal(fake.intervals.size, 0);
});

test("missing or invalid header timestamps start at session_start, not on each tick", async t => {
  const fake = clock(t);
  const extension = await load();
  for (const timestamp of [null, undefined, "", "invalid", 123]) {
    const ctx = context(timestamp);
    await emit(extension, "session_start", ctx);
    assert.equal(text(ctx), "0m");
    fake.advance(65000);
    assert.equal(text(ctx), "1m");
    await emit(extension, "session_shutdown", ctx);
  }
  assert.equal(fake.intervals.size, 0);
});

test("disabled timer never schedules or writes a status", async t => {
  const fake = clock(t);
  const extension = await load(false);
  const ctx = context("2026-01-01T00:00:00.000Z");
  await emit(extension, "session_start", ctx);
  fake.advance(5000);
  await emit(extension, "session_shutdown", ctx);
  assert.equal(fake.created.length, 0);
  assert.deepEqual(ctx.writes, []);
});

test("non-TUI, unavailable UI, and missing status support never schedule or inspect the session", async t => {
  const fake = clock(t);
  const extension = await load();
  for (const overrides of [
    { mode: "rpc" }, { mode: "json", hasUI: false }, { mode: "print", hasUI: false },
    { hasUI: false }, { ui: undefined }, { ui: {} },
  ]) {
    const ctx = context(undefined, {
      sessionManager: { getHeader() { assert.fail("must guard before reading session"); } },
      ...overrides,
    });
    await emit(extension, "session_start", ctx);
    await emit(extension, "session_shutdown", ctx);
    assert.deepEqual(ctx.writes, []);
  }
  assert.equal(fake.created.length, 0);
});
