import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const requirePi = createRequire(join(root, "package.json"));
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url);
const { registerKeepAwake } = await jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/session/keep-awake.ts"));
const { inChildSessionContext, runInChildSessionContext } = await jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/workers/child-context.ts"));

function harness({ enabled = true, platform = "darwin", managed = false, exitBus = new EventEmitter() } = {}) {
  const handlers = new Map();
  const bus = new EventEmitter();
  const exits = exitBus;
  const intervals = new Set();
  const children = [];
  const calls = [];
  const activeAtSpawn = [];
  const notices = [];
  let idle = true;
  const records = new Map();
  let aggregateReads = 0;
  const registry = () => ({
    hasRunning() { aggregateReads++; return managed; },
    getRecord: id => records.get(id),
  });
  let service = managed ? registry() : undefined;
  let spawnError;
  const ctx = { mode: "print", hasUI: false, isIdle: () => idle, ui: { notify: (...args) => notices.push(args) } };
  const backend = {
    platform, pid: 1234,
    manager: () => service,
    spawn(...args) {
      calls.push(args);
      activeAtSpawn.push(children.filter(child => child.kills.length === 0).length);
      if (spawnError) throw spawnError;
      const child = new EventEmitter();
      child.kills = [];
      child.unrefs = 0;
      child.kill = signal => { child.kills.push(signal); child.emit("exit", null, signal); return true; };
      child.unref = () => { child.unrefs++; };
      children.push(child);
      return child;
    },
    every(callback) { intervals.add(callback); return () => intervals.delete(callback); },
    onExit(callback) { exits.on("exit", callback); return () => exits.off("exit", callback); },
  };
  const pi = {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return () => handlers.get(name).splice(handlers.get(name).indexOf(handler), 1);
    },
    events: {
      on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); },
      emit(name, data) { bus.emit(name, data); },
    },
  };
  registerKeepAwake(pi, enabled, backend);
  const emit = async (name, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
  };
  return {
    handlers, backend, pi, bus, exits, intervals, children, calls, activeAtSpawn, notices, emit, ctx,
    start: () => emit("session_start"),
    shutdown: () => emit("session_shutdown"),
    idle(value) { idle = value; },
    managed(value) {
      managed = value;
      service ??= registry();
    },
    record(id, status) { records.set(id, { status }); service ??= registry(); },
    aggregateReads: () => aggregateReads,
    service(value) { service = value; },
    failSpawn(error) { spawnError = error; },
    tick() { for (const callback of [...intervals]) callback(); },
    active() { return children.filter(child => child.kills.length === 0); },
    listeners() { return bus.eventNames().reduce((total, name) => total + bus.listenerCount(name), 0); },
  };
}

test("default-off, invalid truthy values, and unsupported platforms are complete no-ops", async () => {
  for (const options of [{ enabled: false }, { enabled: "true" }, { platform: "linux" }, { platform: "win32" }]) {
    const h = harness(options);
    assert.equal(h.handlers.size, 0);
    await h.start();
    h.idle(false);
    h.tick();
    h.bus.emit("subagents:started", { id: "a" });
    await h.shutdown();
    assert.equal(h.calls.length, 0);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.listeners(), 0);
    assert.equal(h.exits.listenerCount("exit"), 0);
  }
});

test("child scope and a root manager alone do not prove an enabled parent keep-awake owner", async () => {
  // A worker-only root registrar can load an independently enabled interface in
  // its child. No root keep-awake activation exists in this fixture.
  const h = await runInChildSessionContext(async () => harness({ managed: true }));
  assert.equal(inChildSessionContext(), false);
  assert.ok(h.handlers.size > 0, "child scope is not evidence that another activation covers this child");
  h.idle(false);
  await h.start(); // bindExtensions dispatch occurs after the loading scope ends.
  h.record("unrelated-root-worker", "running");
  await h.emit("before_agent_start");
  await h.emit("agent_start");
  assert.equal(h.active().length, 1);
  await h.emit("agent_end");
  h.tick();
  assert.equal(h.active().length, 1, "child retries remain covered without a parent holder");
  h.idle(true);
  await h.emit("agent_settled");
  h.tick();
  assert.equal(h.active().length, 0, "unrelated root work cannot retain the child's helper");
  assert.equal(h.intervals.size, 1, "the retained child still observes future work until shutdown");
  assert.equal(h.listeners(), 6);
  assert.equal(h.exits.listenerCount("exit"), 1);
  await h.start();
  h.idle(false);
  await h.emit("agent_start");
  assert.equal(h.active().length, 1);
  assert.equal(h.calls.length, 2);
  await h.shutdown();
  assert.equal(h.active().length, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.listeners(), 0);
  assert.equal(h.exits.listenerCount("exit"), 0);
  assert.equal(h.aggregateReads(), 0);
  assert.deepEqual(h.notices, []);
});

test("a child foreground resume remains covered when the idle root receives no worker lifecycle events", async () => {
  // AgentManager.resume's retained foreground path does not emit the manager's
  // onStart/onComplete callbacks. Registry presence is not coverage of this run.
  const parent = harness({ managed: true });
  const child = await runInChildSessionContext(async () => harness({ managed: true }));
  await parent.start();
  await child.start();
  child.idle(false);
  await child.emit("agent_start");
  parent.tick();
  assert.equal(parent.active().length, 0);
  assert.equal(child.active().length, 1);
  child.idle(true);
  await child.emit("agent_settled");
  assert.equal(child.active().length, 0);
  // A later retained-session resume needs to reacquire, without a session_start.
  child.idle(false);
  await child.emit("agent_start");
  await child.emit("agent_end");
  child.tick();
  assert.equal(child.active().length, 1);
  child.idle(true);
  await child.emit("agent_settled");
  assert.equal(child.active().length, 0);
  await child.shutdown();
  await parent.shutdown();
});

test("concurrent child activation and shutdown leave the headless parent's worker hold unchanged", async () => {
  const pendingChild = runInChildSessionContext(async () => {
    await Promise.resolve();
    return harness();
  });
  const parent = harness();
  const child = await pendingChild;
  assert.ok(child.handlers.size > 0);
  try {
    await parent.start();
    await child.start();
    // Registration, not whichever async scope dispatches this event, owns state.
    await runInChildSessionContext(async () => {
      parent.idle(false);
      await parent.emit("agent_start");
    });
    child.idle(false);
    await child.emit("agent_start");
    parent.bus.emit("subagents:started", { id: "worker" });
    parent.idle(true);
    await parent.emit("agent_settled");
    parent.tick();
    assert.equal(parent.active().length, 1);
    assert.equal(child.active().length, 1, "independent child coverage is not globally deduplicated");
    await child.shutdown();
    assert.equal(child.active().length, 0);
    assert.equal(child.intervals.size, 0);
    assert.equal(child.listeners(), 0);
    assert.equal(child.exits.listenerCount("exit"), 0);
    assert.equal(parent.active().length, 1, "child shutdown must not release the parent's worker hold");
    assert.equal(parent.calls.length, 1);
    parent.bus.emit("subagents:completed", { id: "worker" });
    assert.equal(parent.active().length, 0);
  } finally {
    await child.shutdown();
    await parent.shutdown();
  }
});

test("parent lifecycle during suspended child loading preserves both activations' independent ownership", async () => {
  const loading = Promise.withResolvers();
  const resumeLoading = Promise.withResolvers();
  const workerLoad = runInChildSessionContext(async () => {
    assert.equal(inChildSessionContext(), true);
    const child = harness();
    loading.resolve(child);
    await resumeLoading.promise;
    return child;
  });
  const child = await loading.promise;
  const parent = harness();
  try {
    assert.equal(inChildSessionContext(), false);
    await parent.start();
    parent.idle(false);
    await parent.emit("before_agent_start");
    await parent.emit("agent_start");
    parent.bus.emit("subagents:started", { id: "worker" });
    resumeLoading.resolve();
    await workerLoad;
    // Initially idle children do not inherit unrelated root activity.
    await child.start();
    child.tick();
    assert.equal(parent.active().length + child.active().length, 1);
    child.idle(false);
    await child.emit("agent_start");
    assert.equal(parent.active().length + child.active().length, 2);
    assert.equal(parent.calls.length + child.calls.length, 2);
    // Dispatch context must not disable a root activation registered outside it.
    await runInChildSessionContext(async () => {
      parent.idle(true);
      await parent.emit("agent_settled");
    });
    parent.tick();
    assert.equal(parent.active().length, 1);
    assert.equal(child.active().length, 1);
    child.idle(true);
    await child.emit("agent_settled");
    assert.equal(child.active().length, 0);
    assert.equal(parent.active().length, 1, "child settlement must not release the parent's worker hold");
    assert.equal(child.intervals.size, 1);
    assert.equal(child.listeners(), 6);
    assert.equal(child.exits.listenerCount("exit"), 1);
    parent.bus.emit("subagents:completed", { id: "worker" });
    parent.tick();
    assert.equal(parent.active().length + child.active().length, 0);
    assert.equal(parent.calls.length + child.calls.length, 2);
    assert.deepEqual(parent.children[0].kills, ["SIGKILL"]);
    assert.deepEqual(child.children[0].kills, ["SIGKILL"]);
    assert.deepEqual(parent.notices, []);
    assert.deepEqual(child.notices, []);
  } finally {
    resumeLoading.resolve();
    await workerLoad;
    await child.shutdown();
    await parent.shutdown();
  }
});

test("factory is resource-free; idle startup subscribes without acquiring an assertion", async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.listeners(), 0);
  await h.start();
  h.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.intervals.size, 1);
  assert.equal(h.listeners(), 6);
  await h.shutdown();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.listeners(), 0);
});

test("main work uses only idle-sleep assertion with parent PID, no shell, and no ref", async () => {
  const h = harness();
  await h.start();
  h.idle(false);
  await h.emit("before_agent_start");
  await h.emit("agent_start");
  h.tick();
  assert.deepEqual(h.calls, [["/usr/bin/caffeinate", ["-i", "-w", "1234"], { stdio: "ignore" }]]);
  assert.equal(h.children[0].unrefs, 1);
  await h.emit("agent_end"); // queued follow-up/retry/compaction can still continue
  await h.emit("agent_before_settle"); // a continuation can be requested here
  await h.emit("agent_start");
  assert.equal(h.active().length, 1);
  h.idle(true);
  await h.emit("agent_settled");
  assert.deepEqual(h.children[0].kills, ["SIGKILL"]);
  assert.deepEqual(h.notices, []);
  await h.shutdown();
});

test("main cancellation retains assertion until settled, then is immediately releasable", async () => {
  const h = harness();
  await h.start();
  h.idle(false);
  const abort = new AbortController();
  h.ctx.signal = abort.signal;
  await h.emit("agent_start");
  abort.abort();
  await h.emit("agent_end");
  h.tick();
  assert.equal(h.active().length, 1);
  h.idle(true);
  await h.emit("agent_settled", { aborted: true });
  assert.equal(h.active().length, 0);
  await h.shutdown();
});

test("idle snapshots recover early startup failure and work before agent_start", async () => {
  const h = harness();
  await h.start();
  h.idle(false); // compaction/preparation before before_agent_start
  h.tick();
  assert.equal(h.active().length, 1);
  await h.emit("before_agent_start");
  h.idle(true); // preparation throws; installed host does not emit agent_settled
  h.tick();
  assert.equal(h.active().length, 0);
  await h.shutdown();
});

test("background workers retain assertion after parent settles and until last terminal event", async () => {
  const h = harness();
  await h.start();
  h.idle(false);
  await h.emit("agent_start");
  h.managed(true);
  h.bus.emit("subagents:started", { id: "a" });
  h.bus.emit("subagents:started", { id: "a" }); // duplicate must not increment a counter
  h.bus.emit("subagents:started", { id: "b" });
  h.bus.emit("subagents:created", { id: "a", isBackground: true }); // handoff is not a new run
  h.idle(true);
  await h.emit("agent_settled");
  assert.equal(h.calls.length, 1);
  h.bus.emit("subagents:completed", { id: "a" });
  assert.equal(h.active().length, 1);
  h.managed(false);
  h.bus.emit("subagents:failed", { id: "b", status: "error" });
  assert.equal(h.active().length, 0);
  await h.shutdown();
});

test("RPC workers starting while parent is idle acquire without a created event", async () => {
  const h = harness();
  await h.start();
  h.managed(true);
  h.bus.emit("subagents:started", { id: "rpc" });
  assert.equal(h.active().length, 1);
  h.managed(false);
  h.bus.emit("subagents:completed", { id: "rpc" });
  assert.equal(h.active().length, 0);
  await h.shutdown();
});

test("queued-only jobs never hold, including RPC queues and queued aborts without events", async () => {
  const h = harness({ managed: true }); // legacy hasRunning includes queues
  h.record("queued", "queued");
  await h.start();
  h.tick(); // unknown RPC queue: no event
  assert.equal(h.active().length, 0);
  h.bus.emit("subagents:created", { id: "queued" });
  h.tick(); // known queue: creation is not execution
  assert.equal(h.active().length, 0);
  h.record("queued", "stopped"); // queued abort emits no terminal event
  h.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.aggregateReads(), 0, "never consult the queue-inclusive predicate");
  await h.shutdown();
});

test("known queued workers acquire only after execution starts, and release on completion", async () => {
  const h = harness({ managed: true });
  h.record("queued", "queued");
  await h.start();
  h.bus.emit("subagents:created", { id: "queued" });
  h.tick();
  assert.equal(h.calls.length, 0);
  h.record("queued", "running"); // setup may precede started
  h.tick();
  assert.equal(h.active().length, 1);
  h.bus.emit("subagents:started", { id: "queued" });
  h.record("queued", "stopped"); // cancellation has not settled yet
  h.tick();
  assert.equal(h.active().length, 1);
  h.bus.emit("subagents:failed", { id: "queued" });
  assert.equal(h.active().length, 0);
  h.record("done", "completed");
  h.bus.emit("subagents:created", { id: "done" }); // stale discovery is not work
  h.tick();
  assert.equal(h.calls.length, 1);
  await h.shutdown();
});

test("idle child activations do not reflect unrelated work in the shared root registry", async () => {
  const h = harness({ managed: true });
  await h.start();
  h.tick();
  assert.equal(h.calls.length, 0);
  h.idle(false);
  await h.emit("agent_start");
  assert.equal(h.active().length, 1);
  h.idle(true);
  await h.emit("agent_settled");
  h.tick();
  assert.equal(h.active().length, 0, "root hasRunning still true cannot retain a settled child's helper");
  assert.equal(h.aggregateReads(), 0);
  await h.shutdown();
});

test("idle question dialogs and unanswered questions after settlement do not acquire or retain", async () => {
  const h = harness();
  await h.start();
  await h.emit("ui_prompt_start", { kind: "custom", reason: "ui_prompt" });
  h.tick();
  assert.equal(h.calls.length, 0);
  await h.emit("ui_prompt_end", { kind: "custom", reason: "ui_prompt" });
  h.idle(false);
  await h.emit("agent_start");
  await h.emit("tool_execution_end", { toolName: "ask_user", toolCallId: "question", result: { pending: true } });
  h.idle(true);
  await h.emit("agent_settled");
  h.tick(); // no answer/dismissal event is required to release
  assert.equal(h.active().length, 0);
  await h.shutdown();
});

test("queued-to-running transition and cancellation stay held until processing actually stops", async () => {
  const h = harness({ managed: true });
  await h.start();
  h.bus.emit("subagents:started", { id: "queue" });
  h.managed(false); // manager.abort changes status to stopped before promise settles
  h.tick();
  assert.equal(h.active().length, 1);
  h.bus.emit("subagents:failed", { id: "queue", status: "stopped" });
  assert.equal(h.active().length, 0);
  await h.shutdown();
});

test("service load order, replacement, disposal and a vetoed switch do not leak worker holds", async () => {
  const h = harness();
  await h.start();
  h.managed(true);
  h.bus.emit("subagents:ready", {});
  assert.equal(h.active().length, 0, "ready/aggregate busy is not proof of execution");
  h.bus.emit("subagents:started", { id: "old" });
  assert.equal(h.active().length, 1);
  await h.emit("session_before_switch"); // veto: no shutdown follows
  assert.equal(h.active().length, 1);
  h.service({ getRecord: () => undefined }); // replacing manager invalidates old worker IDs
  h.tick();
  assert.equal(h.active().length, 0);
  h.bus.emit("subagents:started", { id: "new" });
  assert.equal(h.active().length, 1);
  h.service(undefined);
  h.bus.emit("subagents:disposed", {});
  assert.equal(h.active().length, 0);
  await h.shutdown();
});

test("events alone work without registry; malformed/irrelevant events never acquire", async () => {
  const h = harness();
  await h.start();
  for (const data of [undefined, null, {}, { id: 1 }]) h.bus.emit("subagents:started", data);
  h.bus.emit("subagents:completed", { id: "unknown" });
  assert.equal(h.calls.length, 0);
  h.bus.emit("subagents:started", { id: "a" });
  h.tick();
  assert.equal(h.active().length, 1);
  h.bus.emit("subagents:failed", { id: "a" });
  assert.equal(h.active().length, 0);
  await h.shutdown();
});

test("unknown pre-existing workers cannot be enumerated: documented public API boundary", async () => {
  const h = harness({ managed: true });
  h.record("unobserved", "running"); // no event on this activation's event bus
  await h.start();
  h.tick();
  assert.equal(h.active().length, 0);
  h.bus.emit("subagents:started", { id: "unobserved" });
  assert.equal(h.active().length, 1);
  h.record("unobserved", "stopped");
  h.tick();
  assert.equal(h.active().length, 1);
  h.bus.emit("subagents:failed", { id: "unobserved" });
  assert.equal(h.active().length, 0);
  await h.shutdown();
});

test("reload/session switch/shutdown removes all resources and ignores stale helper callbacks", async () => {
  const h = harness();
  await h.start();
  h.bus.emit("subagents:started", { id: "a" });
  const old = h.children[0];
  const staleTimer = [...h.intervals][0];
  await h.shutdown();
  await h.shutdown();
  staleTimer();
  h.bus.emit("subagents:started", { id: "late" });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(old.kills, ["SIGKILL"]);
  assert.equal(h.listeners(), 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.exits.listenerCount("exit"), 0);
  await h.start();
  h.idle(false);
  await h.emit("agent_start");
  old.emit("error", new Error("late"));
  old.emit("exit", 1);
  assert.equal(h.active().length, 1);
  assert.deepEqual(h.notices, []);
  await h.shutdown();
});

test("repeated session_start cleans previous runtime state and process-exit cleanup is synchronous", async () => {
  const h = harness();
  await h.start();
  h.bus.emit("subagents:started", { id: "a" });
  await h.start();
  assert.equal(h.active().length, 0);
  assert.equal(h.intervals.size, 1);
  assert.equal(h.listeners(), 6);
  assert.equal(h.exits.listenerCount("exit"), 1);
  h.bus.emit("subagents:started", { id: "b" });
  h.exits.emit("exit");
  assert.equal(h.active().length, 0);
  assert.equal(h.listeners(), 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.exits.listenerCount("exit"), 0);
  await h.shutdown();
});

test("busy session_start re-entry releases the old helper before replacing it", async () => {
  const h = harness();
  h.idle(false);
  await h.start();
  const old = h.children[0];
  // Native exit notification can arrive after session replacement.
  old.kill = signal => { old.kills.push(signal); return true; };
  await h.start();
  assert.deepEqual(old.kills, ["SIGKILL"]);
  assert.deepEqual(h.activeAtSpawn, [0, 0]);
  assert.equal(h.active().length, 1);
  old.emit("error", new Error("late old helper error"));
  old.emit("exit", null, "SIGKILL");
  await h.emit("agent_start");
  h.tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.active().length, 1);
  assert.equal(h.intervals.size, 1);
  assert.equal(h.listeners(), 6);
  assert.equal(h.exits.listenerCount("exit"), 1);
  assert.deepEqual(h.notices, []);
  await h.shutdown();
  assert.equal(h.active().length, 0);
});

test("reload and session replacement release before the fresh activation can spawn", async () => {
  for (const reason of ["reload", "new", "resume", "fork"]) {
    const h = harness();
    h.idle(false);
    await h.start();
    await h.emit("session_shutdown", { reason });
    h.handlers.clear(); // Native Pi discards the old runtime before loading a fresh factory.
    registerKeepAwake(h.pi, true, h.backend);
    await h.start();
    assert.deepEqual(h.activeAtSpawn, [0, 0]);
    assert.equal(h.active().length, 1);
    await h.emit("agent_start");
    h.tick();
    assert.equal(h.calls.length, 2);
    await h.shutdown();
    assert.equal(h.active().length, 0);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.listeners(), 0);
    assert.equal(h.exits.listenerCount("exit"), 0);
  }
});

test("synchronous launch failure, async spawn error, and unexpected exit warn once without retry storms", async () => {
  for (const failure of ["throw", "error", "exit"]) {
    const h = harness();
    await h.start();
    if (failure === "throw") h.failSpawn(new Error("ENOENT"));
    h.idle(false);
    await h.emit("agent_start");
    if (failure === "error") h.children[0].emit("error", new Error("ENOENT"));
    if (failure === "exit") h.children[0].emit("exit", 1);
    h.tick();
    await h.emit("agent_start");
    assert.equal(h.calls.length, 1);
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0][0], /disabled until reload/);
    assert.equal(h.active().length, 0);
    await h.shutdown();
    h.failSpawn(undefined);
    await h.start();
    assert.equal(h.calls.length, 2);
    assert.equal(h.active().length, 1);
    await h.shutdown();
  }
});

test("settled retained activations retain their pollers and exit listeners until shutdown, without retaining helpers", async () => {
  // Fake shared process bus, with its warning threshold disabled only in this
  // fixture. Production still has its ordinary process-listener threshold.
  const exits = new EventEmitter().setMaxListeners(0);
  const retained = await runInChildSessionContext(async () =>
    Array.from({ length: 12 }, () => harness({ exitBus: exits })));
  for (const activation of retained) {
    await activation.start();
    activation.idle(false);
    await activation.emit("agent_start");
    activation.idle(true);
    await activation.emit("agent_settled");
    assert.equal(activation.active().length, 0);
  }
  assert.equal(exits.listenerCount("exit"), 12, "current lifecycle is activation-owned, not globally deduplicated");
  assert.equal(retained.reduce((count, activation) => count + activation.intervals.size, 0), 12);
  for (const activation of retained) await activation.shutdown();
  assert.equal(exits.listenerCount("exit"), 0);
  assert.ok(retained.every(activation => activation.intervals.size === 0));
});

test("same-process parent and child activations release only their own helpers", async () => {
  const parent = harness();
  const child = await runInChildSessionContext(async () => harness()); // Same host PID does not prove parent coverage.
  await parent.start();
  await child.start();
  parent.idle(false);
  child.idle(false);
  await parent.emit("agent_start");
  await child.emit("agent_start");
  assert.equal(parent.active().length, 1);
  assert.equal(child.active().length, 1);
  await child.shutdown();
  assert.equal(child.active().length, 0);
  assert.equal(parent.active().length, 1, "child cleanup cannot release the parent's ownership");
  parent.idle(true);
  await parent.emit("agent_settled");
  assert.equal(parent.active().length, 0);
  await parent.shutdown();
});

test("broken optional manager never prevents main-agent operation", async () => {
  const h = harness();
  h.service({ getRecord() { throw new Error("unavailable"); } });
  await h.start();
  h.bus.emit("subagents:created", { id: "optional" });
  h.idle(false);
  await h.emit("agent_start");
  assert.equal(h.active().length, 1);
  h.idle(true);
  await h.emit("agent_settled");
  assert.equal(h.active().length, 0);
  await h.shutdown();
});
