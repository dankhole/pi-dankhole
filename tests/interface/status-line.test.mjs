import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const requirePi = createRequire(join(root, "package.json"));
const { loadExtensions } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")).href);
const { getThemeByName } = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")).href);
const { SettingsManager } = await import(pathToFileURL(join(root, "dist/core/settings-manager.js")).href);
const { visibleWidth } = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
const scratch = mkdtempSync(join(tmpdir(), "pi-status-line-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styling/status-line.ts");
let serial = 0;
async function load(enabled = true, compactionNoticePercent) {
  const key = `__compactFooter${serial++}`;
  const state = { tools: [], thinking: "medium", settings: {}, settingsError: false };
  globalThis[key] = state;
  const path = join(scratch, `${key}.ts`);
  writeFileSync(path, `import { registerStatusLine } from ${JSON.stringify(sourcePath)};\nexport default pi => registerStatusLine({ ...pi, getAllTools: () => globalThis[${JSON.stringify(key)}].tools, getThinkingLevel: () => globalThis[${JSON.stringify(key)}].thinking }, ${enabled}, false, ${JSON.stringify(compactionNoticePercent)});\n`);
  const loaded = await loadExtensions([path], scratch);
  // The real public API delegates to this session-bound runtime action.
  loaded.runtime.getSettings = () => {
    if (state.settingsError) throw new Error("settings unavailable");
    return state.settings;
  };
  after(() => delete globalThis[key]);
  assert.deepEqual(loaded.errors, []);
  return { extension: loaded.extensions[0], state };
}
async function emit(extension, name, ctx, fields = {}) {
  for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name, ...fields }, ctx);
}
function intervals(t) {
  const active = new Set();
  const all = [];
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    const timer = { callback, delay, unrefs: 0, unref() { this.unrefs++; } };
    active.add(timer); all.push(timer); return timer;
  });
  t.mock.method(globalThis, "clearInterval", timer => active.delete(timer));
  return { active, all, tick() { for (const timer of active) timer.callback(); } };
}
function fixture(overrides = {}, theme = getThemeByName("dark")) {
  let component;
  let renders = 0;
  let reads = 0;
  let contextReads = 0;
  const writes = [];
  const listeners = new Set();
  const statuses = new Map([["compact-tools:chat-timer", "12m"], ["questions:pending", "Q4 pending"], ["zzz", "last status"]]);
  const data = { session: "test-session", branch: "main", entries: [], branchEntries: undefined, leaf: "one", name: "session", usage: { tokens: 10000, contextWindow: 200000, percent: 5 } };
  const footerData = {
    getGitBranch: () => data.branch,
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 2,
    onBranchChange(callback) { listeners.add(callback); return () => listeners.delete(callback); },
  };
  const tui = { requestRender() { renders++; } };
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/work/project", thinkingLevel: "medium",
    model: { provider: "test", id: "model", api: "test", reasoning: true, contextWindow: 200000 },
    modelRegistry: { isUsingOAuth: () => false, getProvider: () => undefined },
    getContextUsage() { contextReads++; return data.usage; },
    sessionManager: {
      getEntries() { reads++; return data.entries; },
      getSessionId: () => data.session,
      getLeafId: () => data.leaf,
      getBranch: () => data.branchEntries ?? data.entries,
      getCwd: () => "/work/project",
      getSessionName: () => data.name,
    },
    ui: { setFooter(next) {
      writes.push(next); component?.dispose();
      component = next?.(tui, theme, footerData);
    } },
    ...overrides,
  };
  return {
    ctx, data, statuses, writes, listeners,
    get component() { return component; },
    get renders() { return renders; }, get reads() { return reads; }, get contextReads() { return contextReads; },
    branchChange() { for (const callback of listeners) callback(); },
    render(width = 240) { return component.render(width); },
  };
}
const text = (f, width = 240) => f.render(width).map(stripVTControlCharacters).join("\n");
function usage(input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0) {
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { total: cost } };
}
function assistant(u, extra = {}) {
  return { type: "message", message: { role: "assistant", provider: "test", model: "model", usage: u, stopReason: "stop", ...extra } };
}

test("real loader registers compact input/footer lifecycle hooks; factory has no resources", async t => {
  const timers = intervals(t);
  const { extension } = await load();
  assert.equal(extension.tools.size, 0);
  assert.equal(extension.commands.size, 0);
  assert.equal(extension.toolRenderers?.length ?? 0, 0);
  assert.equal(timers.all.length, 0);
  const f = fixture();
  await emit(extension, "session_start", f.ctx);
  assert.equal(f.writes.length, 1);
  assert.equal(timers.all.length, 0, "MCP display removal also removes its polling timer");
  assert.equal(f.listeners.size, 1);
  const rendered = text(f);
  for (const expected of ["main", "10k/200k", "12m", "Q4 pending", "last status"]) assert.ok(rendered.includes(expected), expected);
  assert.equal(f.render().length, 1);
  assert.ok(!/test\/model|\/work\/project|session/.test(rendered), "model/cwd belong in the editor border, not duplicated below");
  await emit(extension, "session_shutdown", f.ctx);
  assert.equal(timers.active.size, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.writes.at(-1), undefined);
});

test("all native usage sources count exactly once, including billed errors and subagent rollup", async t => {
  intervals(t);
  const { extension } = await load();
  const f = fixture();
  f.data.entries = [
    assistant(usage(1000, 100, 9000, 0, 1)),
    { type: "usage", usage: usage(10, 20, 30, 40, .1) },
    { type: "message", message: { role: "toolResult", usage: usage(100, 200, 300, 400, 2), nestedCalls: [{ usage: usage(99999, 99999, 99999, 99999, 999) }] } },
    { type: "compaction", usage: usage(1, 2, 3, 4, .01) },
    { type: "branch_summary", usage: usage(2, 3, 4, 5, .02) },
    assistant(usage(20, 30, 40, 50, .2), { stopReason: "error" }),
    assistant(usage(30, 40, 50, 60, .3), { stopReason: "aborted" }),
    { type: "custom", data: { usage: usage(99999) } },
  ];
  await emit(extension, "session_start", f.ctx);
  const rendered = text(f);
  for (const expected of ["↑1.2k", "↓395", "$4"]) assert.ok(rendered.includes(expected), `${expected}: ${rendered}`);
  assert.ok(!rendered.includes("999"));
  assert.ok(!/\b(?:R9|W559|CH)/.test(rendered), "cache display is hidden, not subtracted from native usage/cost");
  await emit(extension, "message_update", f.ctx, { message: assistant(usage(99999)).message });
  assert.equal(text(f), rendered, "live usage must not be double-added to persisted native totals");
  assert.equal(f.reads, 1, "unchanged frame reuses cumulative scan");
  f.data.entries.push({ type: "usage", usage: usage(1000) });
  f.data.leaf = "appended";
  assert.ok(text(f).includes("↑2.2k"));
  assert.equal(f.reads, 2);
  await emit(extension, "session_shutdown", f.ctx);
});

test("unchanged frames cache context projection and totals without freezing live statuses", async t => {
  intervals(t);
  const { extension } = await load();
  const f = fixture();
  f.data.entries = Array.from({ length: 20000 }, () => assistant(usage()));
  await emit(extension, "session_start", f.ctx);
  text(f); // Warm the native data caches once.
  for (let i = 0; i < 100; i++) f.render(i % 2 ? 80 : 240);
  assert.equal(f.contextReads, 1, "100 unchanged frames must not rebuild the context projection");
  assert.equal(f.reads, 1, "100 unchanged frames must not rescan usage entries");
  f.statuses.set("compact-tools:chat-timer", "13m");
  f.statuses.set("questions:pending", "Q5 pending");
  f.statuses.set("mcp", "MCP auth required");
  const rendered = text(f);
  for (const expected of ["13m", "Q5 pending"]) assert.ok(rendered.includes(expected), expected);
  assert.ok(!rendered.includes("MCP auth required"));
  assert.equal(f.contextReads, 1, "extension status changes do not invalidate context");
  assert.equal(f.reads, 1);
  await emit(extension, "session_shutdown", f.ctx);
});

test("context cache invalidates on public session, leaf, model, limit and component changes", async t => {
  intervals(t);
  const { extension } = await load();
  const f = fixture();
  await emit(extension, "session_start", f.ctx);
  assert.ok(text(f).includes("10k/200k"));
  assert.equal(f.contextReads, 1);
  f.data.usage = { tokens: 20000, contextWindow: 200000, percent: 10 };
  f.data.leaf = "next-response";
  assert.ok(text(f).includes("20k/200k"));
  assert.equal(f.contextReads, 2);
  f.data.session = "other-session";
  f.data.usage = { tokens: 30000, contextWindow: 200000, percent: 15 };
  assert.ok(text(f).includes("30k/200k"));
  assert.equal(f.contextReads, 3);
  const totalsReads = f.reads;
  f.ctx.model = { ...f.ctx.model, id: "replacement", contextWindow: 100000 };
  f.data.usage = { tokens: 30000, contextWindow: 100000, percent: 30 };
  await emit(extension, "model_select", f.ctx);
  assert.ok(text(f).includes("30k/100k"));
  assert.equal(f.contextReads, 4);
  assert.equal(f.reads, totalsReads, "model selection should not rescan cumulative totals");
  f.ctx.model.contextWindow = 50000; // Limits may update without replacing the model object.
  f.data.usage = { tokens: 30000, contextWindow: 50000, percent: 60 };
  assert.ok(text(f).includes("30k/50k"));
  assert.equal(f.contextReads, 5);
  assert.equal(f.reads, totalsReads);
  f.component.invalidate();
  text(f);
  assert.equal(f.contextReads, 6);
  await emit(extension, "session_shutdown", f.ctx);
  await emit(extension, "session_start", f.ctx);
  text(f);
  assert.equal(f.contextReads, 7, "restarted footer must not retain a previous session cache");
  await emit(extension, "session_shutdown", f.ctx);
});

test("unknown post-compaction context is never estimated from stale assistant usage", async t => {
  intervals(t);
  const { extension } = await load();
  const f = fixture();
  f.data.entries = [assistant(usage(99999))];
  await emit(extension, "session_start", f.ctx);
  assert.ok(text(f).includes("10k/200k"));
  f.data.usage = { tokens: null, percent: null, contextWindow: 200000 };
  f.data.leaf = "compacted";
  await emit(extension, "session_compact", f.ctx);
  for (let i = 0; i < 100; i++) assert.ok(text(f).includes("?/200k"));
  assert.equal(f.contextReads, 2, "cache unknown context without falling back to pre-compaction usage");
  assert.ok(!text(f).includes("50.0%"));
  f.data.usage = undefined;
  f.data.leaf = "unavailable";
  for (let i = 0; i < 100; i++) assert.ok(text(f).includes("?/200k"));
  assert.equal(f.contextReads, 3, "undefined context is a cacheable result too");
  f.data.usage = { tokens: 2000, percent: 1, contextWindow: 200000 };
  f.data.leaf = "post-compaction-response";
  assert.ok(text(f).includes("2.0k/200k"));
  assert.equal(f.contextReads, 4);
  await emit(extension, "session_shutdown", f.ctx);
});

test("used/limit and independent compaction countdown follow live effective Pi settings without rescanning usage", async t => {
  const { extension, state } = await load();
  const f = fixture();
  f.data.usage = { tokens: 203000, contextWindow: 272000, percent: 1 }; // Percent is deliberately unrelated.
  state.settings = { compaction: { enabled: true, reserveTokens: 22000, keepRecentTokens: 20000 } };
  await emit(extension, "session_start", f.ctx);
  assert.match(text(f), /203k\/272k.*19% to compact/);
  assert.doesNotMatch(text(f), /1\.0%\/|26% to compact/);
  state.settings.compaction.reserveTokens = 72000;
  assert.ok(text(f).includes("0% to compact"), "exhausted budget is clamped to zero, independent of context-window percent");
  state.settings.compaction.keepRecentTokens = 100000;
  assert.ok(text(f).includes("0% to compact"), "retained tail does not define the trigger");
  state.settings.compaction.modelOverrides = { "test/model": { reserveTokens: 22000 } };
  assert.ok(text(f).includes("19% to compact"), "exact model override beats ordinary fallback");
  f.ctx.model.id = "other";
  assert.ok(text(f).includes("0% to compact"), "in-place model IDs re-resolve per-model settings");
  state.settings.compaction.enabled = false;
  assert.ok(text(f).includes("auto off"));
  assert.doesNotMatch(text(f), /% to compact/);
  state.settings.compaction.enabled = true;
  assert.ok(text(f).includes("0% to compact"), "enabled changes are live, not startup snapshots");
  assert.equal(f.contextReads, 1);
  assert.equal(f.reads, 1, "threshold, enabled, and retained-tail changes never rescan session entries");
  await emit(extension, "session_shutdown", f.ctx);
});

test("default countdown appears at raw 20% remaining and never rounds a positive budget to zero", async t => {
  const { extension, state } = await load();
  const f = fixture();
  state.settings = { compaction: { reserveTokens: 100000 } }; // 100k trigger budget.
  await emit(extension, "session_start", f.ctx);
  for (const [tokens, countdown] of [
    [0, undefined], [79999, undefined], [80000, 20], [80500, 20],
    [82000, 18], [99999, 1], [100000, 0], [100001, 0],
  ]) {
    f.data.usage = { tokens, contextWindow: 200000, percent: 99 };
    f.data.leaf = String(tokens);
    const row = text(f);
    assert.match(row, /\d+(?:\.\d+)?k?\/200k/, "actual used/limit remains visible regardless of notice cutoff");
    if (countdown === undefined) assert.doesNotMatch(row, /% to compact/, String(tokens));
    else assert.match(row, new RegExp(`(?:^| )${countdown}% to compact(?: |$)`), String(tokens));
  }
  await emit(extension, "session_shutdown", f.ctx);
});

test("zero, full-range and custom notice cutoffs gate raw remaining percentage", async t => {
  for (const [cutoff, cases] of [
    [0, [[99999, undefined], [100000, 0], [100001, 0]]],
    [100, [[0, 100], [10000, 90], [50000, 50], [100001, 0]]],
    [7, [[92999, undefined], [93000, 7], [93001, 7]]],
    [40, [[59999, undefined], [60000, 40], [60001, 40]]],
  ]) {
    const { extension, state } = await load(true, cutoff);
    const f = fixture();
    state.settings = { compaction: { reserveTokens: 100000 } };
    await emit(extension, "session_start", f.ctx);
    for (const [tokens, countdown] of cases) {
      f.data.usage = { tokens, contextWindow: 200000 };
      f.data.leaf = String(tokens);
      const row = text(f);
      assert.match(row, /\/200k/);
      if (countdown === undefined) assert.doesNotMatch(row, /% to compact/, `${cutoff}: ${tokens}`);
      else assert.match(row, new RegExp(`(?:^| )${countdown}% to compact(?: |$)`), `${cutoff}: ${tokens}`);
    }
    await emit(extension, "session_shutdown", f.ctx);
  }
});

test("countdown disappears and returns after token, threshold, model-limit and unknown-context changes", async t => {
  const { extension, state } = await load();
  const f = fixture();
  state.settings = { compaction: { reserveTokens: 100000 } };
  f.data.usage = { tokens: 85000, contextWindow: 200000 };
  await emit(extension, "session_start", f.ctx);
  assert.match(text(f), /15% to compact/);
  f.data.usage = { tokens: 50000, contextWindow: 200000 }; f.data.leaf = "compacted";
  assert.doesNotMatch(text(f), /% to compact/);
  f.data.usage = { tokens: 90000, contextWindow: 200000 }; f.data.leaf = "response";
  assert.match(text(f), /10% to compact/);
  state.settings.compaction.reserveTokens = 20000;
  assert.doesNotMatch(text(f), /% to compact/);
  state.settings.compaction.reserveTokens = 100000;
  assert.match(text(f), /10% to compact/);
  f.ctx.model.contextWindow = 300000;
  f.data.usage = { tokens: 90000, contextWindow: 300000 };
  assert.match(text(f), /90k\/300k/);
  assert.doesNotMatch(text(f), /% to compact/);
  f.ctx.model.contextWindow = 200000;
  f.data.usage = { tokens: 90000, contextWindow: 200000 };
  assert.match(text(f), /10% to compact/);
  f.data.usage = { tokens: null, contextWindow: 200000 }; f.data.leaf = "unknown";
  assert.match(text(f), /\?\/200k/);
  assert.doesNotMatch(text(f), /% to compact/);
  await emit(extension, "session_shutdown", f.ctx);
});

test("countdown warnings grow more urgent as remaining budget shrinks, not the reverse", async t => {
  const saved = { TERM: process.env.TERM, NO_COLOR: process.env.NO_COLOR };
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  process.env.TERM = "xterm-256color"; delete process.env.NO_COLOR;
  const { extension, state } = await load(true, 100);
  state.settings = { compaction: { reserveTokens: 100000 } };
  for (const name of ["dark", "light"]) {
    const theme = getThemeByName(name);
    const f = fixture({}, theme);
    await emit(extension, "session_start", f.ctx);
    for (const [remaining, color] of [[30, undefined], [20, "warning"], [10, "warning"], [9, "error"], [0, "error"]]) {
      f.data.usage = { tokens: (100 - remaining) * 1000, contextWindow: 200000 };
      f.data.leaf = String(remaining);
      const row = f.render()[0];
      const field = `${remaining}% to compact`;
      if (color) assert.ok(row.includes(theme.fg(color, field)), `${name}: ${field}: ${color}`);
      else {
        assert.ok(row.includes(field));
        assert.ok(!row.includes(theme.fg("warning", field)) && !row.includes(theme.fg("error", field)));
      }
    }
    await emit(extension, "session_shutdown", f.ctx);
  }
});

test("public effective settings honor merged project/model overrides and installed defaults", async t => {
  const { extension, state } = await load(true, 100);
  const f = fixture();
  f.data.usage = { tokens: 203000, contextWindow: 272000, percent: 74.6 };
  await emit(extension, "session_start", f.ctx);
  const defaults = SettingsManager.inMemory().getCompactionSettings(f.ctx.model);
  assert.equal(defaults.reserveTokens, 16384, "verified installed Pi 1.4 default");
  const threshold = 272000 - defaults.reserveTokens;
  assert.ok(text(f).includes(`${Math.ceil((threshold - 203000) / threshold * 100)}% to compact`));
  const settings = SettingsManager.fromStorage({
    withLock(scope, action) {
      return action(JSON.stringify(scope === "global"
        ? { compaction: { reserveTokens: 72000, modelOverrides: { "test/model": { reserveTokens: 22000 } } } }
        : { compaction: { reserveTokens: 12000, modelOverrides: { "test/model": { keepRecentTokens: 40000 } } } }));
    },
  });
  state.settings = settings.getSettings();
  assert.equal(settings.getCompactionSettings(f.ctx.model).reserveTokens, 22000);
  assert.ok(text(f).includes("19% to compact"), "global exact-model value survives project ordinary fallback");
  assert.equal(f.contextReads, 1);
  await emit(extension, "session_shutdown", f.ctx);
});

test("native effective setting changes are live while external storage edits wait for Pi reload without render-time I/O", async t => {
  const { extension, state } = await load();
  const f = fixture();
  f.data.usage = { tokens: 203000, contextWindow: 272000, percent: 74.6 };
  const stored = { global: JSON.stringify({ compaction: { reserveTokens: 22000 } }), project: "{}" };
  let storageReads = 0;
  const manager = SettingsManager.fromStorage({
    withLock(scope, action) {
      storageReads++;
      const changed = action(stored[scope]);
      if (changed !== undefined) stored[scope] = changed;
    },
  });
  Object.defineProperty(state, "settings", { get: () => manager.getSettings() });
  await emit(extension, "session_start", f.ctx);
  assert.ok(text(f).includes("19% to compact"));
  const reads = storageReads;
  manager.applyOverrides({ compaction: { reserveTokens: 72000 } });
  assert.ok(text(f).includes("0% to compact"));
  manager.applyOverrides({ compaction: { enabled: false } });
  assert.ok(text(f).includes("auto off"));
  manager.applyOverrides({ compaction: { enabled: true, reserveTokens: 22000 } });
  assert.ok(text(f).includes("19% to compact"));
  stored.global = JSON.stringify({ compaction: { reserveTokens: 72000 } });
  for (let frame = 0; frame < 100; frame++) assert.ok(text(f).includes("19% to compact"));
  assert.equal(storageReads, reads, "renders read effective memory, never config/storage");
  await manager.reload();
  assert.ok(text(f).includes("0% to compact"), "external changes become effective only when the host reloads settings");
  assert.equal(f.contextReads, 1); assert.equal(f.reads, 1);
  await emit(extension, "session_shutdown", f.ctx);
});

test("disabled, unknown, invalid and nonpositive thresholds never fabricate compaction countdown", async t => {
  const { extension, state } = await load(true, 100);
  const f = fixture();
  await emit(extension, "session_start", f.ctx);
  for (const compaction of [
    { reserveTokens: -1 }, { reserveTokens: 1.5 }, { reserveTokens: null },
    { reserveTokens: 200000 }, { reserveTokens: 200001 },
    { reserveTokens: -1, modelOverrides: { "test/model": { reserveTokens: 1000 } } },
    { modelOverrides: { "test/model": { reserveTokens: -1 } } },
    { modelOverrides: { "test/model": null } }, { keepRecentTokens: -1 },
  ]) {
    state.settings = { compaction };
    assert.ok(text(f).includes("10k/200k"));
    assert.doesNotMatch(text(f), /% to compact|auto off/);
  }
  state.settings = { compaction: { reserveTokens: 0 } };
  assert.ok(text(f).includes("95% to compact"), "zero reserve is valid, not missing");
  state.settings.compaction.enabled = false;
  state.settings.compaction.reserveTokens = -1;
  assert.ok(text(f).includes("auto off"), "disabled state remains known even with invalid token settings");
  for (const unavailable of [undefined, null]) {
    state.settings = unavailable;
    assert.doesNotMatch(text(f), /% to compact|auto off/);
  }
  state.settingsError = true;
  assert.doesNotMatch(text(f), /% to compact|auto off/);
  state.settingsError = false;
  state.settings = {};
  f.data.usage = { tokens: null, contextWindow: 200000, percent: 99 };
  f.data.leaf = "unknown-after-compaction";
  assert.ok(text(f).includes("?/200k"));
  assert.doesNotMatch(text(f), /% to compact/);
  f.data.usage = undefined; f.ctx.model = undefined; f.data.leaf = "no-model";
  assert.ok(text(f).includes("?/?"));
  assert.doesNotMatch(text(f), /% to compact/);
  await emit(extension, "session_shutdown", f.ctx);
});

test("cost display rounds only the precise aggregate to nearest whole dollars and preserves subscription marker", async t => {
  const { extension } = await load();
  const f = fixture();
  await emit(extension, "session_start", f.ctx);
  for (const [cost, expected] of [[.49, "$0"], [.5, "$1"], [97.5, "$98"], [98.49, "$98"], [98.5, "$99"]]) {
    f.data.entries = [assistant(usage(1, 1, 0, 0, cost))]; f.data.leaf = String(cost);
    assert.match(text(f), new RegExp(`\\${expected}(?![\\d.])`));
    assert.doesNotMatch(text(f), /\$\d+\./);
    assert.equal(f.data.entries[0].message.usage.cost.total, cost);
  }
  f.data.entries = [assistant(usage(1, 1, 0, 0, .26)), assistant(usage(1, 1, 0, 0, .26))];
  f.data.leaf = "sum-before-round";
  assert.match(text(f), /\$1(?![\d.])/);
  f.data.entries = [assistant(usage(1, 1, 0, 0, 97.9))]; f.data.leaf = "subscription";
  f.ctx.modelRegistry = { isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }) };
  assert.match(text(f), /~\$98(?![\d.])/);
  for (let width = 1; width <= 160; width++) assert.ok(visibleWidth(f.render(width)[0]) <= width);
  await emit(extension, "session_shutdown", f.ctx);
});

test("subscriptions mark estimates and virtual models show native branch responses without footer thinking", async t => {
  intervals(t);
  const { extension } = await load();
  const f = fixture();
  f.ctx.modelRegistry = { isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }) };
  await emit(extension, "session_start", f.ctx);
  assert.ok(text(f).includes("~$0"));
  const before = f.renders;
  await emit(extension, "thinking_level_select", f.ctx, { level: "xhigh" });
  assert.equal(f.renders, before + 1, "selection repaints the full TUI, including the editor border");
  assert.ok(!/xhi|\bmed\b|\(sub\)/.test(text(f)));
  const next = { ...f.ctx, thinkingLevel: "off", model: { ...f.ctx.model, provider: "route", id: "router", api: "pi-virtual" } };
  await emit(extension, "model_select", next);
  f.data.branchEntries = [assistant(usage(), { provider: "physical", model: "target", thinkingLevel: "high" }), assistant(usage(), { model: "failed", stopReason: "error" })];
  assert.ok(!text(f).includes("route/router"), "selected model is only in the editor border");
  assert.ok(!/thinking off|\bhigh\b/.test(text(f)));
  assert.ok(text(f).includes("physical/target"));
  assert.ok(!text(f).includes("failed"));
  f.data.branchEntries = [assistant(usage(), { provider: "other", model: "branch" })];
  f.data.leaf = "two";
  await emit(extension, "session_tree", next);
  assert.ok(text(f).includes("other/branch"));
  assert.ok(!text(f).includes("physical/target"));
  await emit(extension, "session_shutdown", next);
});

test("without a custom editor the fallback is ONE row and narrow widths prioritize statuses", async t => {
  intervals(t);
  const { extension } = await load();
  const f = fixture();
  f.data.entries = [assistant(usage(19000, 7600, 28000, 2000, .016))];
  f.statuses.set("mcp", "MCP needs attention");
  f.statuses.set("aaa", "first status");
  f.statuses.set("zzz", "last status");
  await emit(extension, "session_start", f.ctx);
  for (const width of [1, 2, 3, 10, 20, 35, 60, 80, 100, 120, 150, 240]) {
    const lines = f.render(width);
    assert.equal(lines.length, 1, String(width));
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    const rendered = stripVTControlCharacters(lines[0]);
    if (width >= 80) {
      for (const expected of ["12m", "Q4 pending", "first status", "last status"]) assert.ok(rendered.includes(expected), `${width}: ${expected}: ${rendered}`);
      assert.ok(!rendered.includes("MCP needs attention"));
    }
    if (width >= 20) assert.ok(rendered.includes("12m"));
    assert.ok(!rendered.includes("test/model"));
  }
  const narrow = text(f, 80);
  assert.ok(!narrow.includes("CH"), "cache ratio is not displayed");
  const normal = text(f, 150);
  for (const expected of ["main", "10k/200k", "↑19k", "↓7.6k", "$0"]) assert.ok(normal.includes(expected), normal);
  assert.ok(!/R28k|W2.0k|CH|\bmed\b/.test(normal), "hidden cache fields and relocated reasoning stay out of the footer");
  await emit(extension, "session_shutdown", f.ctx);
});

test("footer fields have five distinct restrained colors on dark/light and native context warnings win", async t => {
  intervals(t);
  const saved = { TERM: process.env.TERM, NO_COLOR: process.env.NO_COLOR, PI_NERD_FONTS: process.env.PI_NERD_FONTS };
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  process.env.TERM = "xterm-256color"; delete process.env.NO_COLOR; process.env.PI_NERD_FONTS = "0";
  const { extension } = await load();
  const colors = [];
  for (const name of ["dark", "light"]) {
    const theme = getThemeByName(name);
    const f = fixture({}, theme);
    f.data.entries = [assistant(usage(2200000, 317000, 58000000, 123000, 32.448))];
    f.data.usage = { tokens: 134912, contextWindow: 272000, percent: 49.6 };
    f.statuses.clear(); f.statuses.set("compact-tools:chat-timer", "1h 16m");
    await emit(extension, "session_start", f.ctx);
    const row = f.render()[0];
    const fields = ["135k/272k", "↑2.2M", "↓317k", "$32", "1h 16m"];
    const foreground = fields.map(field => {
      const index = row.indexOf(field);
      assert.ok(index >= 0, field);
      const ansi = [...row.slice(0, index).matchAll(/\x1b\[[0-9;]*m/g)].at(-1)?.[0];
      assert.ok(ansi && !/\[(?:0|39)m/.test(ansi), `${name}: ${field} has a foreground`);
      return ansi;
    });
    assert.equal(new Set(foreground).size, 5, `${name}: per-field colors must be distinct`);
    colors.push(foreground);
    assert.ok(!/R58M|W123k|CH/.test(stripVTControlCharacters(row)));
    for (const [percent, color] of [[75, "warning"], [95, "error"]]) {
      f.data.usage = { tokens: percent * 2720, contextWindow: 272000, percent };
      f.data.leaf = String(percent);
      assert.ok(f.render()[0].includes(theme.fg(color, `${Math.round(percent * 2.72)}k/272k`)), color);
    }
    process.env.NO_COLOR = "1";
    assert.ok(!f.render()[0].includes("\x1b"));
    delete process.env.NO_COLOR; process.env.TERM = "dumb";
    assert.ok(!/[^\x20-\x7e]/.test(f.render()[0]));
    assert.ok(text(f).includes("in:2.2M"));
    process.env.TERM = "xterm-256color";
    await emit(extension, "session_shutdown", f.ctx);
  }
  assert.ok(colors[0].every((color, index) => color !== colors[1][index]), "every field adapts to light backgrounds");
});

test("only the exact subagents status key is hidden, including at narrow widths", async t => {
  intervals(t);
  const { extension } = await load();
  const f = fixture();
  f.statuses.clear();
  f.statuses.set("subagents", "REDUNDANT-RUNNING-COUNT");
  f.statuses.set("subagents:other", "2 agents running");
  f.statuses.set("other", "subagents text remains");
  f.statuses.set("compact-tools:chat-timer", "1h 16m");
  await emit(extension, "session_start", f.ctx);
  assert.ok(text(f).includes("2 agents running"));
  assert.ok(text(f).includes("subagents text remains"));
  for (let width = 1; width <= 240; width++) {
    const rows = f.render(width);
    assert.equal(rows.length, 1);
    assert.ok(visibleWidth(rows[0]) <= width);
    assert.ok(!stripVTControlCharacters(rows[0]).includes("REDUNDANT"));
  }
  await emit(extension, "session_shutdown", f.ctx);
});

test("cached usage/context accounting survives hidden fields and subscription estimates use a prefix", async t => {
  intervals(t);
  const { extension } = await load();
  const f = fixture();
  f.data.entries = [assistant(usage(0, 0, 58000000, 1000000, 32.448))];
  f.data.usage = { tokens: 134912, contextWindow: 272000, percent: 49.6 };
  await emit(extension, "session_start", f.ctx);
  assert.ok(text(f).includes("135k/272k"));
  assert.ok(text(f).includes("$32"));
  assert.ok(!text(f).includes("~$"));
  f.ctx.modelRegistry = { isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }) };
  assert.ok(text(f).includes("~$32"));
  assert.ok(!/\(sub\)|R58M|W1.0M|CH/.test(text(f)));
  assert.equal(f.reads, 1); assert.equal(f.contextReads, 1);
  f.ctx.modelRegistry = { isUsingOAuth: () => false, getProvider: () => undefined };
  f.ctx.model.provider = "kimi-coding";
  assert.ok(text(f).includes("~$32"), "Kimi subscription accounting uses the same estimate marker");
  await emit(extension, "session_shutdown", f.ctx);
});

test("registered and published MCP statuses are omitted entirely without polling", async t => {
  const timers = intervals(t);
  const { extension, state } = await load();
  state.tools = Array.from({ length: 6 }, (_, i) => ({ namespace: { name: `mcp__${i}` } }));
  const f = fixture();
  await emit(extension, "session_start", f.ctx);
  assert.ok(!text(f).includes("MCP"));
  f.statuses.set("mcp", "MCP auth required");
  assert.ok(!text(f).includes("MCP"));
  for (let width = 1; width <= 240; width++) assert.ok(!text(f, width).includes("MCP"));
  assert.equal(timers.all.length, 0);
  await emit(extension, "session_shutdown", f.ctx);
});

test("Unicode, combining text, long words and hostile ANSI remain width-safe", async t => {
  intervals(t);
  const { extension } = await load();
  const f = fixture();
  f.data.branch = "修正/界e\u0301🙂";
  f.data.name = "safe\x1b[2J\x1b]0;evil\x07name\r\n\tend";
  f.statuses.set("malicious", "answer\x1b[31mQ7\x1b[0m\x1b[2J\x1b]52;c;bad\x07\n pending界e\u0301🙂" + "x".repeat(100));
  await emit(extension, "session_start", f.ctx);
  for (const width of [0, 1, 2, 3, 10, 20, 40, 80]) {
    const lines = f.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), String(width));
    assert.ok(lines.every(line => !/[\r\n\t]/.test(line)));
    assert.ok(lines.every(line => !/\x1b\]|\x1b\[2J/.test(line)));
  }
  assert.ok(!text(f).includes("safe"), "session name no longer creates a separate cwd row");
  assert.ok(!text(f).includes("evil"));
  assert.ok(text(f).includes("Q7"));
  await emit(extension, "session_shutdown", f.ctx);
});

test("dark and light themes use semantic colors and glyph/plain fallbacks", async t => {
  intervals(t);
  const savedEnv = { TERM: process.env.TERM, PI_NERD_FONTS: process.env.PI_NERD_FONTS, NO_COLOR: process.env.NO_COLOR };
  const env = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  t.after(() => { for (const [key, value] of Object.entries(savedEnv)) env(key, value); });
  const { extension } = await load();
  for (const name of ["dark", "light"]) {
    const f = fixture();
    const theme = getThemeByName(name);
    f.ctx.ui.setFooter = factory => { f.writes.push(factory); f.current = factory?.({ requestRender() {} }, theme, {
      getGitBranch: () => "main", getExtensionStatuses: () => f.statuses,
      onBranchChange: () => () => {}, getAvailableProviderCount: () => 2,
    }); };
    env("TERM", "xterm-256color"); env("PI_NERD_FONTS", "1"); env("NO_COLOR", undefined);
    await emit(extension, "session_start", f.ctx);
    let lines = f.current.render(240).join("\n");
    assert.ok(lines.includes(theme.fg("success", " main")));
    assert.ok(!stripVTControlCharacters(lines).includes("med"));
    env("PI_NERD_FONTS", "0");
    f.current.invalidate();
    lines = f.current.render(240).join("\n");
    assert.ok(lines.includes("⎇ main"));
    assert.ok(!/[\ue000-\uf8ff]/.test(lines));
    env("TERM", "dumb");
    lines = f.current.render(240).join("\n");
    assert.ok(lines.includes("git main"));
    assert.ok(!/[^\x20-\x7e\n]/.test(lines));
    env("TERM", "xterm"); env("NO_COLOR", "1");
    assert.ok(!f.current.render(240).join("\n").includes("\x1b"));
    await emit(extension, "session_shutdown", f.ctx);
  }
});

test("a live theme change recolors the same footer without rebuilding its subscriptions", async t => {
  const timers = intervals(t);
  const { extension } = await load();
  let currentTheme = getThemeByName("dark");
  const f = fixture({}, {
    fg: (...args) => currentTheme.fg(...args), style: (...args) => currentTheme.style(...args),
    get appearance() { return currentTheme.appearance; },
  });
  await emit(extension, "session_start", f.ctx);
  const dark = f.render().join("\n");
  currentTheme = getThemeByName("light");
  f.component.invalidate();
  const light = f.render().join("\n");
  assert.notEqual(light, dark);
  assert.equal(stripVTControlCharacters(light), stripVTControlCharacters(dark));
  assert.equal(f.listeners.size, 1);
  assert.equal(timers.active.size, 0);
  await emit(extension, "session_shutdown", f.ctx);
});

test("repeated starts, reload/shutdown and replacement release listeners once without polling", async t => {
  const timers = intervals(t);
  const { extension } = await load();
  const first = fixture();
  await emit(extension, "session_start", first.ctx);
  first.branchChange();
  assert.equal(first.renders, 1);
  const oldComponent = first.component;
  const second = fixture();
  await emit(extension, "session_start", second.ctx);
  assert.equal(first.listeners.size, 0);
  assert.equal(first.writes.at(-1), undefined);
  assert.deepEqual(oldComponent.render(80), []);
  assert.equal(timers.active.size, 0);
  await emit(extension, "session_shutdown", second.ctx);
  await emit(extension, "session_shutdown", second.ctx);
  assert.equal(timers.active.size, 0);
  assert.equal(second.listeners.size, 0);
  const before = second.renders;
  timers.tick(); first.branchChange(); second.branchChange();
  await emit(extension, "thinking_level_select", second.ctx, { level: "high" });
  assert.equal(second.renders, before);
  // A later extension replacing this footer owns the public slot; do not clear it on shutdown.
  await emit(extension, "session_start", first.ctx);
  first.component.dispose();
  const writes = first.writes.length;
  await emit(extension, "session_shutdown", first.ctx);
  assert.equal(first.writes.length, writes);
  assert.equal(timers.active.size, 0);
  const reloaded = await load();
  await emit(reloaded.extension, "session_start", second.ctx);
  assert.ok(text(second).includes("12m"));
  await emit(reloaded.extension, "session_shutdown", second.ctx);
});

test("disabled, headless, RPC and missing footer APIs do not inspect session or start resources", async t => {
  const timers = intervals(t);
  for (const enabled of [false, true]) {
    const { extension } = await load(enabled);
    for (const overrides of [{ mode: "rpc" }, { mode: "json", hasUI: false }, { mode: "print", hasUI: false }, { hasUI: false }, { ui: undefined }, { ui: {} }]) {
      const f = fixture({ sessionManager: new Proxy({}, { get() { assert.fail("no session reads"); } }), ...overrides });
      await emit(extension, "session_start", f.ctx);
      await emit(extension, "session_shutdown", f.ctx);
      assert.deepEqual(f.writes, []);
    }
  }
  const { extension } = await load(false);
  const f = fixture();
  await emit(extension, "session_start", f.ctx);
  assert.deepEqual(f.writes, []);
  assert.equal(timers.all.length, 0);
});
