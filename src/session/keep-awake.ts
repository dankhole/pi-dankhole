import { type ChildProcess, spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface WorkerManager {
  getRecord(id: string): { status: string } | undefined;
}

// Injectable OS boundary: tests never acquire a real power assertion.
export interface KeepAwakeBackend {
  platform: string;
  pid: number;
  spawn: typeof spawn;
  manager(): WorkerManager | undefined;
  every(callback: () => void): () => void;
  onExit(callback: () => void): () => void;
}

const nativeBackend: KeepAwakeBackend = {
  platform: process.platform,
  pid: process.pid,
  spawn,
  manager() {
    // Documented read-only pi-subagents registry; never replace or mutate it.
    const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
    return manager && typeof manager === "object" && "getRecord" in manager
      && typeof manager.getRecord === "function" ? manager as WorkerManager : undefined;
  },
  every(callback) {
    const timer = setInterval(callback, 500);
    timer.unref();
    return () => clearInterval(timer);
  },
  onExit(callback) {
    process.on("exit", callback);
    return () => { process.off("exit", callback); };
  },
};

export function registerKeepAwake(pi: ExtensionAPI, enabled: boolean, backend = nativeBackend): void {
  if (enabled !== true || backend.platform !== "darwin") return;

  let ctx: ExtensionContext | undefined;
  let mainActive = false;
  let failed = false;
  let child: ChildProcess | undefined;
  let manager: WorkerManager | undefined;
  const running = new Set<string>();
  const discovered = new Set<string>();
  let disposers: (() => void)[] = [];

  function release() {
    const previous = child;
    child = undefined;
    // Kill only our own helper. SIGKILL releases its kernel assertion immediately,
    // without a grace timer that could survive reload or process exit.
    try { previous?.kill("SIGKILL"); } catch { /* Already gone. -w also bounds it to this host. */ }
  }

  function warn() {
    if (failed) return;
    failed = true;
    release();
    ctx?.ui.notify("Compact tools: keep-awake unavailable; disabled until reload.", "warning");
  }

  function reconcile() {
    if (!ctx || failed) return;
    let managed = false;
    try {
      const current = backend.manager();
      // Replacement/disposal invalidates records from the previous service.
      if (current !== manager) {
        running.clear();
        discovered.clear();
        manager = current;
      }
      // hasRunning() includes unstarted queues and is shared with child sessions.
      // Only inspect workers discovered on this activation's own event bus.
      for (const id of discovered) {
        const record = manager?.getRecord(id);
        if (record?.status === "running") managed = true;
        else if (record && record.status !== "queued") discovered.delete(id);
      }
    } catch { /* An unavailable optional integration must not break the agent. */ }
    if (!mainActive && !managed && running.size === 0) {
      release();
      return;
    }
    if (child) return;
    try {
      // -i only: allow display sleep. -w releases even if Pi is killed without
      // session_shutdown/exit. No shell, detached daemon, or user command.
      const started = backend.spawn("/usr/bin/caffeinate", ["-i", "-w", String(backend.pid)], { stdio: "ignore" });
      child = started;
      started.once("error", () => { if (child === started) warn(); });
      started.once("exit", () => { if (child === started) warn(); });
      started.unref();
    } catch { warn(); }
  }

  function cleanup() {
    ctx = undefined;
    mainActive = false;
    running.clear();
    discovered.clear();
    manager = undefined;
    for (const dispose of disposers.splice(0)) dispose();
    release();
  }

  pi.on("session_start", (_event, context) => {
    cleanup();
    ctx = context;
    failed = false;
    mainActive = !context.isIdle();
    // Poll the current run and known workers, never the queue-inclusive global
    // hasRunning predicate. Unknown workers are discovered by started events;
    // the public registry cannot enumerate workers already active at activation.
    reconcile();
    const refresh = () => {
      if (!ctx) return;
      mainActive = !ctx.isIdle();
      reconcile();
    };
    const started = (data: unknown) => {
      // Sample the registry before adding the ID, so first discovery cannot
      // erase this start. Keep IDs until terminal notification: worker status
      // becomes stopped on abort, before running cancellation has actually settled.
      reconcile();
      if (data && typeof data === "object" && "id" in data && typeof data.id === "string") running.add(data.id);
      reconcile();
    };
    const finished = (data: unknown) => {
      if (data && typeof data === "object" && "id" in data && typeof data.id === "string") {
        running.delete(data.id);
        discovered.delete(data.id);
      }
      reconcile();
    };
    const created = (data: unknown) => {
      reconcile();
      if (data && typeof data === "object" && "id" in data && typeof data.id === "string") discovered.add(data.id);
      reconcile();
    };
    disposers = [
      pi.events.on("subagents:started", started),
      pi.events.on("subagents:completed", finished),
      pi.events.on("subagents:failed", finished),
      pi.events.on("subagents:created", created),
      pi.events.on("subagents:ready", () => reconcile()),
      pi.events.on("subagents:disposed", () => { running.clear(); discovered.clear(); reconcile(); }),
      backend.every(refresh),
      backend.onExit(cleanup),
    ];
  });
  pi.on("before_agent_start", () => { if (ctx) { mainActive = true; reconcile(); } });
  pi.on("agent_start", () => { if (ctx) { mainActive = true; reconcile(); } });
  // agent_end is NOT idle: retries, queued follow-ups and settlement continuations
  // may still run. Cancellation releases here too, once the run has stopped.
  pi.on("agent_settled", () => { mainActive = false; reconcile(); });
  pi.on("session_shutdown", cleanup);
}
