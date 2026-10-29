/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * There are two independent concurrency pools, never one:
 *
 * - Background (`maxConcurrent`, default 10) bounds detached agents.
 * - Foreground (`maxConcurrentForeground`, default 0 = unlimited) bounds
 *   agents a caller is blocking on inline — `spawnAndWait`.
 *
 * Independent by design: a foreground agent blocks the parent anyway, so
 * charging it to the background pool would let a saturated pool starve the main
 * session of work it could have done itself. Excess agents in either pool are
 * queued and auto-started as slots free up.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getDefaultMaxTurns, getRememberAgents, resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { validateAgentConfig } from "./invocation-config.js";
import { describeModel } from "./model-resolver.js";
import { getOutputTranscriptDefault } from "./output-file.js";
import type { AgentConfig, AgentInvocation, AgentRecord, IsolationMode, Pool, ThinkingLevel } from "./types.js";
import { addUsage, type LifetimeUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
/**
 * Fired by `steer()` once a message is delivered or queued. Every steer path
 * goes through it except `steer_subagent` in index.ts, which awaits delivery.
 */
export type OnAgentSteered = (record: AgentRecord, message: string) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
/**
 * Fired once per assistant `message_end`, for spawns and resumes. Each usage
 * delta is reported exactly once, independently of cumulative record totals.
 */
export type OnAgentUsage = (record: AgentRecord, usage: LifetimeUsage) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/**
 * Default max concurrent background agents.
 *
 * Raised from 4 when top-level spawns started defaulting to background
 * (`backgroundByDefault`): foreground agents bypass this pool entirely, so
 * while foreground was the default a fan-out of six ran six. With background
 * as the default every top-level agent takes a slot, and a limit of 4 would
 * have silently queued the tail of exactly the parallel fan-outs the `Agent`
 * tool description tells the model to send.
 */
const DEFAULT_MAX_CONCURRENT = 10;

/**
 * Default max concurrent foreground (blocking) agents — `0` = unlimited, the
 * extension's existing convention for "no ceiling" (`defaultMaxTurns`).
 *
 * Off by default because nothing here ever bounded foreground work, and pi
 * dispatches a message's tool calls through `Promise.all`, so an unqualified
 * fan-out of blocking `Agent` calls has always run all at once. Users who want
 * it bounded — chiefly local models, where parallel agents thrash the prompt
 * cache (#253) — opt in; everyone else keeps today's behaviour exactly.
 */
const DEFAULT_MAX_CONCURRENT_FOREGROUND = 0;

/**
 * How many evicted workers retain in-session ID-based resume metadata.
 * Bounded so a long-running session cannot retain every completed launch.
 */
const MAX_RESUMABLE = 100;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions {
  description: string;
  config?: AgentConfig;
  /** Internal: reopen a session path retained by this manager after eviction. */
  resumeSessionFile?: string;
  model?: Model<any>;
  /** Internal provenance for model objects. Public adapters must derive this flag. */
  modelFromParams?: boolean;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip whichever pool's queue check applies to this spawn — start immediately
   * even if the configured concurrency limit would otherwise queue it. The slot
   * is still COUNTED once the run starts, so a bypassing spawn transiently
   * exceeds the limit rather than being invisible to it.
   *
   * Explicit programmatic escape hatch; ordinary Agent calls never bypass queues.
   */
  bypassQueue?: boolean;
  /**
   * A caller is awaiting this record inline (`spawnAndWait`) — what
   * `maxConcurrentForeground` bounds. Set only by `spawnAndWait`; stripped from
   * caller-supplied options by `spawnTopLevel`, since a forged `blocking` would
   * defer a detached start behind a queue its caller cannot see or release.
   */
  blocking?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /**
   * Last chance to look at an isolated agent's worktree, awaited immediately
   * before it is committed to a branch and removed.
   *
   * Exists because that removal happens inside the settle path, before
   * `spawnAndWait` resolves: by the time a caller has the finished record, the
   * directory the child actually wrote in is gone. Anything that must inspect
   * or verify that tree has to run
   * here or it silently inspects the main tree instead.
   *
   * Fires only on the normal settle path, and only when a worktree was created.
   * Not on the error path and not on the stop-during-copy guard: those are
   * already failing, and delaying cleanup there would leak a copy for no gain.
   * A rejection is swallowed — the hook can never keep the worktree alive.
   */
  onBeforeWorktreeCleanup?: (worktreePath: string) => Promise<void>;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /**
   * Called synchronously once the record is in the map and its promise is set,
   * before `onSessionCreated` fires — where callers attach the output file.
   *
   * Carried on the options rather than parked on the manager for the duration
   * of a spawn: with a foreground queue, `startAgent` can run at drain time,
   * long after any such field would have been restored, and the callback would
   * silently never fire (or fire into an unrelated caller's closure).
   */
  onSpawned?: (id: string) => void;
  /**
   * Called synchronously when the spawn is queued instead of started, with how
   * many entries in its own pool are ahead of it. The foreground UI uses it to
   * say so while it waits; nothing else needs it.
   */
  onQueued?: (id: string, ahead: number) => void;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
}

export interface ResumeOptions {
  /**
   * Run the resumed turn detached in the background: return immediately with
   * the record still "running" (or "queued" at the concurrency limit) and
   * notify on completion via onComplete, exactly like a background spawn.
   * Default (false/undefined) runs the resume inline and returns the settled
   * record — the historical behavior.
   */
  isBackground?: boolean;
  /**
   * Explicit turn limit for the resumed run: this, else the limit the agent
   * was spawned with, else the project default —
   * counted afresh from the resume prompt (#368).
   */
  maxTurns?: number;
  /** Called at the end of each resumed turn with the count since the resume. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /**
   * Background resume only: called synchronously when the run actually starts —
   * immediately, or later from drainQueue. Callers wire per-run side effects
   * (output-file streaming) here rather than at the call site, so a resume that
   * is stopped while still queued never leaves a subscription behind: `abort()`
   * drops a queued record without reaching `settle()`, which is what would have
   * torn that subscription down.
   */
  onStarted?: () => void;
}

/** Best-effort ceiling on one child's shutdown handlers, so teardown can't strand a quit. */
const CHILD_SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * Close the extension lifecycle `runAgent` opened with `bindExtensions`, then dispose.
 *
 * `AgentSession.dispose()` only calls `ExtensionRunner.invalidate()` — pi emits the event
 * itself in `AgentSessionRuntime.dispose()` beforehand, and this is the one place that binds
 * extensions onto a session without going through that path. Without the emit, everything an
 * extension armed in `session_start` leaks once per spawn, and its next tick throws
 * `assertActive()` from a bare timer callback — an uncaughtException that kills pi (#242).
 */
async function shutdownChildSession(session: AgentSession | undefined): Promise<void> {
  try {
    const runner = session?.extensionRunner;
    // Optional all the way down: on a pi without the getter, or a stubbed session from a
    // partial `onSessionCreated`, skip the emit — the same degrade as before this fix.
    if (runner?.hasHandlers?.("session_shutdown")) {
      // Raced, not awaited outright. `emit` runs every handler serially with no timeout of
      // its own, and dispose() is reached from pi's own `session_shutdown` with the TUI
      // already torn down — one hung handler would leave a dead terminal.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          runner.emit({ type: "session_shutdown", reason: "quit" }),
          new Promise<void>(resolve => {
            timeout = setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS);
            timeout.unref();
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }
  } catch { /* a partial session must degrade, not take the teardown down with it */ }
  // Always, even on timeout: disposal is what this function ultimately exists to do.
  try { session?.dispose?.(); } catch { /* ignore */ }
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  private onSteered?: OnAgentSteered;
  private maxConcurrent: number;
  private maxConcurrentForeground = DEFAULT_MAX_CONCURRENT_FOREGROUND;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /**
   * Startup phases, keyed by agent id. `spawn()` still returns synchronously,
   * but an agent using worktree isolation is not running yet when it does —
   * copying the repo is an awaited git call. This is what `awaitStartup` hands
   * callers that must fail their tool call on a startup failure, and what
   * `waitForAll` waits on while a record is "running" with no `promise` yet.
   * Entries are dropped once the run is underway, and kept (rejected) after a
   * startup failure so a late `awaitStartup` still sees it.
   */
  private startups = new Map<string, Promise<void>>();

  /**
   * Evicted workers that can be resumed by ID within this session. Outlives
   * the 10-minute record cleanup — that timer exists to bound memory, not to
   * expire a conversation the user might still want — and is cleared alongside
   * completed records on session start/switch.
   */
  private resumable = new Map<string, { record: AgentRecord; args: SpawnArgs }>();
  private launches = new Map<string, SpawnArgs>();

  /**
   * Agents waiting to start, tagged with the pool they wait on. One queue for
   * both pools: `drainQueue` picks the earliest entry whose own pool has room,
   * so neither can head-of-line-block the other, and every removal path
   * (`abort`, `abortAll`, `dispose`) stays a single filter.
   *
   * `release` wakes a caller blocked in `spawnAndWait`, and is fired once the
   * entry's `start` has SETTLED rather than at drain time: startup is async
   * now, so releasing earlier would wake the caller before `record.promise`
   * exists and it would read a still-starting agent as one that never ran.
   * Removing an entry from this array MUST release it — a queued record has no
   * promise to await, and pi has no tool-execution timeout to bail the caller
   * out.
   */
  private queue: { id: string; pool: Pool; start: () => Promise<void>; release: () => void }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /** Number of currently running foreground (blocking) agents. */
  private runningForeground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    onUsage?: OnAgentUsage,
    onSteered?: OnAgentSteered,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.onUsage = onUsage;
    this.onSteered = onSteered;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Update the max concurrent foreground (blocking) agents limit. 0 = unlimited. */
  setMaxConcurrentForeground(n: number) {
    // Floor 0, not 1: unlimited is a meaningful value here and the default.
    this.maxConcurrentForeground = Math.max(0, n);
    // Start queued agents if the new limit allows — including everything, when
    // the limit is cleared back to unlimited mid-run.
    this.drainQueue();
  }

  getMaxConcurrentForeground(): number {
    return this.maxConcurrentForeground;
  }

  /**
   * Which pool a spawn is charged to, or undefined for one that is charged to
   * neither (detached non-background spawns).
   *
   * Nothing here queues when the limit is unset — `poolHasRoom` reports an
   * unlimited pool as always having room, so that alone is what keeps the
   * default path identical. The `> 0` guard is belt and braces on top: it also
   * keeps the counter from churning and the settle path from calling a drain
   * that would find nothing to do. Both are unobservable, which is why no test
   * pins them; the observable half — that the default start stays synchronous —
   * is pinned in `test/foreground-concurrency.test.ts`.
   */
  private poolFor(record: AgentRecord): Pool | undefined {
    if (record.isBackground) return "background";
    if (this.maxConcurrentForeground > 0 && record.blocking) return "foreground";
    return undefined;
  }

  private poolHasRoom(pool: Pool): boolean {
    return pool === "background"
      ? this.runningBackground < this.maxConcurrent
      : this.maxConcurrentForeground === 0 || this.runningForeground < this.maxConcurrentForeground;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   *
   * The id comes back synchronously, but with `isolation: "worktree"` the agent
   * is not running yet when it does — the repo copy is an awaited git call.
   * Callers that must fail a tool call on a startup failure await
   * `awaitStartup(id)`; everyone else sees it on the record (status "error").
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    prompt: string,
    options: SpawnOptions,
  ): string {
    return this.spawnWithId(pi, ctx, prompt, options);
  }

  private spawnWithId(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    prompt: string,
    options: SpawnOptions,
    id = randomUUID().slice(0, 17),
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    if (options.config !== undefined && (!options.config || typeof options.config !== "object" || Array.isArray(options.config))) {
      throw new Error("config must be a worker configuration object");
    }
    const supplied = structuredClone({ extensions: true as const, skills: true as const, ...options.config });
    const config: AgentConfig = {
      ...supplied,
      maxTurns: options.maxTurns ?? supplied.maxTurns ?? getDefaultMaxTurns(),
      isolated: options.isolated ?? supplied.isolated ?? false,
      inheritContext: options.inheritContext ?? supplied.inheritContext ?? false,
      thinking: options.thinkingLevel ?? supplied.thinking,
      isolation: options.isolation ?? supplied.isolation,
      persistSession: supplied.persistSession ?? getRememberAgents(),
      outputTranscript: supplied.outputTranscript ?? getOutputTranscriptDefault(),
    };
    validateAgentConfig(config);
    // A named model selector is always explicit; an internal inherited Model object is not.
    const modelFromParams = config.model !== undefined || (options.modelFromParams ?? options.model !== undefined);
    options = { ...options, config, modelFromParams };
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      config,
      modelFromParams,
      description: options.description,
      // Overwritten below when the spawn is actually queued; a foreground spawn
      // that queues flips to "queued" there rather than being guessed at here,
      // since the pool decision needs the finished record.
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      // Whether anyone is awaiting this agent is a property of the agent, not
      // of the call that made it — and both settle paths need it long after
      // `options` has stopped being the interesting object.
      blocking: options.blocking,
      invocation: options.invocation,
    };
    const savedRecord = this.resumable.get(id)?.record;
    const activeRecord = savedRecord ? Object.assign(savedRecord, record, {
      lifetimeUsage: { ...savedRecord.lifetimeUsage },
      compactionCount: savedRecord.compactionCount,
      outputFile: savedRecord.outputFile,
      // Consumption belongs to the prior run, not the retained conversation.
      resultConsumed: false,
      result: undefined,
      error: undefined,
      completedAt: undefined,
      session: undefined,
      promise: undefined,
      worktree: undefined,
      worktreeResult: undefined,
    }) : record;
    this.agents.set(id, activeRecord);
    const args: SpawnArgs = { pi, ctx, prompt, options };
    this.launches.set(id, args);

    const pool = this.poolFor(activeRecord);
    if (pool !== undefined && !options.bypassQueue && !this.poolHasRoom(pool)) {
      // Queue it — started when a running agent in the same pool completes.
      // Idempotent for background (already "queued"); the flip that matters is
      // a blocking foreground spawn, optimistically marked "running" above.
      activeRecord.status = "queued";
      // A queued record never reaches startAgent's signal wiring, so arm the
      // parent abort here or Esc could not release the position.
      if (!this.armQueuedAbort(id, options.signal)) return id;
      let release!: () => void;
      activeRecord.startGate = new Promise<void>(resolve => { release = resolve; });
      this.queue.push({
        id,
        pool,
        start: () => this.launch(id, activeRecord, args, pool),
        release: () => release(),
      });
      options.onQueued?.(id, this.queue.filter(e => e.pool === pool).length - 1);
      return id;
    }

    this.launch(id, activeRecord, args, undefined);
    return id;
  }

  /**
   * Wire a parent abort signal for a record that is about to be QUEUED.
   * `startAgent` does this for running agents, and a queued record never gets
   * there, so without this Esc could not release a queue position.
   *
   * Returns false when the signal is ALREADY aborted, in which case the record
   * is stopped here and must not be enqueued: `addEventListener` never fires on
   * an aborted signal, so a `spawnAndWait` on it would wait forever — pi has no
   * tool-execution timeout to bail it out.
   *
   * The listener is removable (`record.detachParentAbort`): `startAgent`
   * replaces it with its own, and `sendToBackground` must be able to take it
   * off, or the caller that armed it could stop a run it no longer owns.
   */
  private armQueuedAbort(id: string, signal?: AbortSignal): boolean {
    if (signal === undefined) return true;
    if (signal.aborted) {
      const record = this.agents.get(id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
      }
      return false;
    }
    const record = this.agents.get(id);
    if (record) this.armParentAbort(record, signal);
    return true;
  }

  /**
   * Stop `record` when its caller's `signal` aborts, replacing any listener an
   * earlier stage armed — at most one is live per record, so one call to
   * `detachParentAbort` cuts the run loose from its caller.
   */
  private armParentAbort(record: AgentRecord, signal: AbortSignal | undefined): void {
    this.detachParentAbort(record);
    if (signal === undefined) return;
    const onParentAbort = () => this.abort(record.id);
    signal.addEventListener("abort", onParentAbort, { once: true });
    record.detachParentAbort = () => signal.removeEventListener("abort", onParentAbort);
  }

  private detachParentAbort(record: AgentRecord): void {
    record.detachParentAbort?.();
    record.detachParentAbort = undefined;
  }

  /** Add `delta` to the running count of `pool`; no pool, no count. */
  private chargePool(pool: Pool | undefined, delta: 1 | -1): void {
    if (pool === "background") this.runningBackground += delta;
    else if (pool === "foreground") this.runningForeground += delta;
  }

  /**
   * Kick off an agent's startup and register it under `startups`. The returned
   * promise never rejects — the failure is delivered through `awaitStartup`,
   * and to the record.
   *
   * @param queuedPool - The pool this start was QUEUED on, or undefined for an
   *   immediate start. A queue drain can be minutes after `spawn()` returned,
   *   and nobody is awaiting `awaitStartup` by then, so a failure has to live
   *   on the record as status "error" — what drainQueue did when the throw was
   *   still synchronous. An immediate start instead drops the record, exactly
   *   as the throw out of `spawn()` did: no orphan in `listAgents()`.
   */
  private launch(id: string, record: AgentRecord, args: SpawnArgs, queuedPool: Pool | undefined): Promise<void> {
    const startup = this.startAgent(id, record, args).then(
      () => { this.startups.delete(id); },
      (err) => {
        this.startups.delete(id);
        if (queuedPool !== undefined) {
          // Mirrors settleRun: an inline caller gets this failure as a throw
          // out of spawnAndWait, so an unconsumed record would ALSO nudge the
          // session about it — the same failure reported twice.
          if (queuedPool === "foreground") record.resultConsumed = true;
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
          record.completedAt = Date.now();
          this.onComplete?.(record);
        } else {
          this.agents.delete(id);
          this.launches.delete(id);
        }
        // The agent never kept its slot (startAgent gives it back on failure),
        // so anything queued behind it can go now.
        this.drainQueue();
        throw err;
      },
    );
    this.startups.set(id, startup);
    // Nothing is obliged to await `startups` — swallow the rejection once here
    // so an unawaited startup can't take the process down, and hand callers
    // (drainQueue) that swallowed promise.
    return startup.catch(() => {});
  }

  /**
   * Resolves once the agent is actually running, and rejects with the startup
   * failure (strict worktree isolation) that `spawn()` used to throw before the
   * repo copy became async. Resolves immediately for an agent that is already
   * running, still queued, or unknown — so callers can await it unconditionally.
   *
   * Call it in the same tick as the `spawn()` it belongs to: a failed startup
   * takes its record (and this entry) with it, exactly as the throw did.
   */
  awaitStartup(id: string): Promise<void> {
    return this.startups.get(id) ?? Promise.resolve();
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private async startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, prompt, options }: SpawnArgs,
  ) {
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Take the running state — and with it the concurrency slot — BEFORE the
    // first await. Creating a worktree is an awaited git call, and drainQueue
    // reads the pool counters synchronously in a loop: incrementing after the
    // await would let it start every queued agent at once while the first is
    // still copying its repo. Claiming "running" here also keeps abort() and
    // abortAll() able to reach an agent whose worktree is still being created.
    //
    // The pool is resolved ONCE, here, and recorded for `settleRun`:
    // `poolFor` reads `maxConcurrentForeground`, which the user can change from
    // `/agents → Settings` mid-run, so recomputing it at settle time would
    // decrement a pool this run never charged (counter underflow, limit
    // silently lifted) or skip the decrement for one it did (leaked slot —
    // every later blocking spawn queues forever). Only `sendToBackground`
    // changes it afterwards, moving the counters with it. The two startup exits
    // below never reach `settleRun`, so they hand the slot back themselves.
    record.chargedPool = this.poolFor(record);
    record.status = "running";
    record.startedAt = Date.now();
    record.startGate = undefined;
    this.chargePool(record.chargedPool, 1);

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done BEFORE
    // the run is kicked off so a failure doesn't leave a half-running agent.
    // The project switch is enforced here as well as at the tool boundary
    // because cross-extension RPC forwards its options unvalidated — a schema
    // that omits the field can't stop a caller that never saw the schema.
    const isolation = record.config?.isolation;
    let worktreeCwd: string | undefined;
    if (isolation === "worktree" && isWorktreeIsolationEnabled()) {
      const wt = await createWorktree(pi, baseCwd, id);
      if (!wt) {
        this.chargePool(record.chargedPool, -1);
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);
      // The widget's worktree tag reads the effective snapshot.
      record.invocation ??= {};
      record.invocation.isolation = "worktree";

      // No longer "running" means a stop landed while the copy was being made
      // (abort(), abortAll()) — a window that did not exist when creation was
      // synchronous. The record is already terminal, so launching the run would
      // burn tokens on work nobody is waiting for: discard the fresh (and by
      // definition unchanged) worktree instead.
      if (record.status !== "running") {
        this.chargePool(record.chargedPool, -1);
        record.worktreeResult = await cleanupWorktree(pi, baseCwd, wt, options.description);
        this.drainQueue();
        return;
      }
    }

    this.onStart?.(record);

    // Wire parent abort signal to stop the subagent when the parent is interrupted.
    // A queued spawn can start minutes after the caller handed us its signal,
    // by which time it may already be aborted — and `addEventListener` would
    // never fire, leaving a child the parent can no longer reach.
    if (options.signal?.aborted) this.abort(id);
    else this.armParentAbort(record, options.signal);
    const detach = () => this.detachParentAbort(record);

    const promise = runAgent(ctx, prompt, {
      config: record.config,
      description: record.description,
      pi,
      agentId: id,
      model: options.model,
      modelFromParams: record.modelFromParams,
      maxTurns: record.config?.maxTurns,
      isolated: record.config?.isolated,
      inheritContext: record.config?.inheritContext,
      thinkingLevel: record.config?.thinking,
      resumeSessionFile: options.resumeSessionFile,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      // Set iff a worktree was created (see above) — names the directory the
      // copy came from, so the prompt can tell the agent not to work there.
      worktreeBase: worktreeCwd ? baseCwd : undefined,
      configCwd: customCwd !== undefined ? ctx.cwd : undefined,
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      onSessionCreated: (session) => {
        record.session = session;
        // Capture now, while the session object exists: after eviction this
        // path is the only thing that can reopen the conversation, and an
        // in-memory session reports undefined, which correctly means
        // "nothing to come back to".
        // Optional chaining, not defensiveness for its own sake: this is the
        // only field read off the session at creation, so an older pi or a
        // stubbed session must degrade to "not resumable" rather than throw
        // and take the whole spawn down with it.
        record.sessionFile = session.sessionManager?.getSessionFile?.();
        // Same reason, different field: the model and thinking level are only
        // knowable once pi has resolved its defaults and clamped the level to
        // what the model supports. Writing them back here makes the record
        // authoritative, so every surface reads one place instead of each
        // re-deriving "session, else the request" for itself.
        if (session.model) {
          if (record.config?.model !== undefined) record.config.model = `${session.model.provider}/${session.model.id}`;
          record.invocation ??= {};
          // Read the kept request first: a caller's level survives being clamped
          // AND, one line later, being replaced by the effective one.
          const requested = record.invocation.requestedThinking ?? record.invocation.thinking;
          Object.assign(record.invocation, describeModel(session.model));
          // Guarded for the reason above: a session that reports no level keeps
          // the request rather than losing it. Overwriting unconditionally would
          // turn an older or stubbed session into a blank `thinking:` tag, which
          // is worse than the stale-but-true value it replaced.
          if (session.thinkingLevel) {
            record.invocation.thinking = session.thinkingLevel;
            if (requested && requested !== session.thinkingLevel) {
              record.invocation.requestedThinking = requested;
            }
          }
        }
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(async ({ responseText, session, aborted, steered, failure }) => {
        this.settleOutcome(record, { text: responseText, failure, aborted, steered });
        record.session = session;

        detach();

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Clean up worktree if used
        if (record.worktree) {
          // The one moment the child's tree still exists and the child is done
          // writing to it. try/catch, not decoration: a hook that throws must
          // not leave the worktree behind.
          if (options.onBeforeWorktreeCleanup) {
            try {
              await options.onBeforeWorktreeCleanup(record.worktree.path);
            } catch { /* ignore — never block cleanup */ }
          }
          const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
          if (wtResult.hasChanges && wtResult.branch) {
            // With a caller-supplied cwd the branch lives in THAT repo, not the
            // parent session's — say so, or the orchestrator merges in the wrong repo.
            const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
            record.result = (record.result ?? "") +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
          }
        }

        this.settleRun(record, true);
        return responseText;
      })
      .catch(async (err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch { /* ignore cleanup errors */ }
        }

        this.settleRun(record, false);
        return "";
      });

    record.promise = promise;

    // Notify caller that spawn is complete (record is in the map, promise is set).
    // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
    // Used by spawnAndWait to let the caller set up output files before streaming
    // starts. Read off the options, so a spawn that started from a queue drain
    // still reaches the caller that queued it.
    options.onSpawned?.(id);
  }

  /**
   * The shared tail of both settle paths: release whatever pool slot the run
   * held, notify, and let the queue drain into the freed slot.
   *
   * The decrement lives HERE and nowhere else. `abort()` on a running record
   * only fires its controller and leaves the run to settle normally, so
   * decrementing there too would double-free — permanently lifting the limit.
   *
   * Foreground agents fire `onComplete` for lifecycle symmetry, with
   * `resultConsumed` set so the callback skips notifications the inline result
   * already delivered.
   *
   * @param guardCallback swallow a throwing `onComplete` (the success path does;
   *   the error path historically did not, and keeps not doing so).
   *
   * Releases `record.chargedPool` — the pool the run was charged to at start
   * (or moved to by `sendToBackground`), never a recomputed one, so a mid-run
   * change to `maxConcurrentForeground` can't make the release disagree with
   * the acquire.
   */
  private settleRun(record: AgentRecord, guardCallback: boolean): void {
    if (!record.isBackground) record.resultConsumed = true;
    // Nobody waits on a settled run; a later foreground resume must not look
    // like a spawn `sendToBackground` could hand off.
    record.blocking = false;
    const pool = record.chargedPool;
    this.chargePool(pool, -1);

    if (guardCallback) {
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
    } else {
      this.onComplete?.(record);
    }

    // A freed slot may unblock queued work.
    if (record.isBackground || pool !== undefined) this.drainQueue();
  }

  /**
   * Start queued agents up to each pool's concurrency limit.
   *
   * `findIndex` on the entry's OWN pool rather than `shift`: with one queue
   * serving two independent limits, a saturated foreground pool at the head
   * would otherwise stall every background agent behind it. Taking the earliest
   * eligible entry keeps FIFO within each pool, which is what callers see.
   */
  private drainQueue() {
    for (;;) {
      const i = this.queue.findIndex(e => this.poolHasRoom(e.pool));
      if (i === -1) return;
      const [next] = this.queue.splice(i, 1);
      const record = this.agents.get(next.id);
      // Stale entries (aborted while queued) are not started — but are still
      // released, since nothing else will.
      if (!record || record.status !== "queued") { next.release(); continue; }
      // Detached, and never rejects: a late failure (e.g. strict worktree
      // isolation) lands on the record inside `launch`, exactly as the
      // synchronous throw did here before, and draining continues either way.
      //
      // The release waits for that startup to SETTLE rather than firing here.
      // Startup is async now, so a release at drain time would wake a blocked
      // `spawnAndWait` while `record.promise` was still undefined, and it would
      // read a perfectly healthy agent as one that never ran.
      void next.start().then(() => next.release(), () => next.release());
    }
  }

  /**
   * Remove queued entries and wake anyone blocked on them. The single point
   * that enforces "leaving the queue releases the waiter" — a missed release is
   * an unbounded hang, not a failed call.
   */
  private dequeue(pred: (entry: { id: string; pool: Pool }) => boolean): void {
    const kept: typeof this.queue = [];
    for (const entry of this.queue) {
      if (pred(entry)) entry.release();
      else kept.push(entry);
    }
    this.queue = kept;
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Charged to the foreground pool (`maxConcurrentForeground`), which is
   * unlimited by default; never to the background one.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously once the run is kicked off, before
   *   onSessionCreated fires. Use this to set record.outputFile so
   *   streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    // `blocking` is what maxConcurrentForeground bounds, and this is its only
    // source. onSpawned rides on the options rather than on a field of this
    // manager: a queued spawn starts at drain time, long after any install/
    // restore pair around this call would have put the field back — and it now
    // fires after an await (worktree creation) even on the immediate path.
    const id = this.spawn(pi, ctx, prompt, {
      ...options,
      isBackground: false,
      blocking: true,
      onSpawned,
    });
    const record = this.agents.get(id)!;

    // Queued: nothing to await yet — the promise appears when the drain starts
    // it. The gate resolves (never rejects) on every path out of the queue,
    // start and abort alike, so a rejection can never escape into the caller's
    // tool `execute` and take down pi's whole Promise.all tool batch.
    if (record.status === "queued") await record.startGate;

    // The run promise only exists once startup is past its awaited repo copy —
    // without this the call would return before the agent had started at all.
    // A startup failure (strict worktree isolation) rejects here, which is what
    // the immediate path owes its caller: the Agent tool reports failure by
    // letting this throw out of `execute`. A queued spawn's failure landed on
    // the record instead (nobody was awaiting `startups` at drain time) and is
    // rethrown below, so the contract is the same either way.
    await this.awaitStartup(id);

    // undefined when it was aborted while queued, or stopped mid-copy, and so
    // never ran — the record is already terminal with a completedAt, which is
    // what the caller renders.
    if (record.promise) await record.promise;

    // A record that ended "error" without ever getting a promise never ran: the
    // same startup failure spawn() rethrows on the immediate path (#179). Keep
    // one contract rather than letting queue pressure decide whether a strict
    // worktree failure throws or returns as a result.
    if (record.promise === undefined && record.status === "error") {
      throw new Error(record.error ?? "Agent failed to start");
    }
    return { id, record };
  }

  /**
   * Hand a live run to the background without restarting it. The session,
   * promise, in-flight turn, transcript and worktree all continue under the
   * same id; what changes is who answers for it. The caller's parent-abort
   * listener comes off (its Esc no longer reaches the run — `abort()` and
   * `/agents` still do), the slot moves to the background pool, and the run
   * then settles through the ordinary background path, since `settleRun`
   * reads the live `isBackground` and `chargedPool`.
   *
   * Releasing the caller is the caller's job — the `Agent` tool races its own
   * wake-up against `spawnAndWait`. This only refuses what it can see: a run
   * nobody is blocking on (a background or detached spawn, one already handed
   * off, or a foreground RESUME — `blocking` is cleared when the spawned run
   * settles, and a resume never charged the slot this would move).
   *
   * The background slot is taken even when the pool is full: suspending a
   * live run is not an option, so it runs over the limit and queued
   * background work waits for the count to drop, as with `bypassQueue`.
   */
  sendToBackground(id: string): boolean {
    const record = this.agents.get(id);
    if (!record?.blocking || record.status !== "running" || !record.promise) return false;

    this.detachParentAbort(record);
    this.chargePool(record.chargedPool, -1);
    record.chargedPool = "background";
    this.chargePool(record.chargedPool, 1);
    record.blocking = false;
    record.isBackground = true;
    record.resultConsumed = false;
    // A freed foreground slot may have unblocked a queued blocking spawn.
    this.drainQueue();
    return true;
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    let record = this.agents.get(id);
    if (!record) {
      const saved = this.resumable.get(id);
      if (!saved) return undefined;
      try {
        if (!statSync(saved.record.sessionFile!).isFile()) return undefined;
      } catch { return undefined; }
      const reopenedId = this.spawnWithId(saved.args.pi, saved.args.ctx, prompt, {
        ...saved.args.options,
        // The visible goal may have been relabeled through the retained metadata.
        description: saved.record.description,
        maxTurns: options?.maxTurns,
        isBackground: options?.isBackground ?? false,
        signal: options?.isBackground ? undefined : signal,
        onToolActivity: options?.onToolActivity,
        onTurnEnd: options?.onTurnEnd,
        onAssistantUsage: options?.onAssistantUsage,
        onCompaction: options?.onCompaction,
        onSessionCreated: () => options?.onStarted?.(),
      }, id);
      record = this.agents.get(reopenedId)!;
      record.lifetimeUsage = { ...saved.record.lifetimeUsage };
      record.compactionCount = saved.record.compactionCount;
      record.outputFile = saved.record.outputFile;
      record.invocation = saved.record.invocation;
      this.resumable.delete(id);
      if (!options?.isBackground) {
        if (record.status === "queued") await record.startGate;
        await this.awaitStartup(id);
        if (record.promise) await record.promise;
      }
      return record;
    }
    if (!record.session || record.status === "running" || record.status === "queued") return undefined;

    // Background resume: settle asynchronously and notify on completion exactly
    // like a background spawn, returning immediately with the record still
    // "running" — or "queued" when at the concurrency limit. Previously
    // run_in_background was ignored on resume (the Agent tool's resume branch
    // returned before its background branch, and resume() only ever awaited
    // inline), so a resumed agent always blocked the caller until it finished.
    if (options?.isBackground) {
      record.isBackground = true;
      record.resultConsumed = false;
      record.result = undefined;
      record.error = undefined;
      record.completedAt = undefined;
      record.status = "queued";

      const start = () => this.startResume(id, record, prompt, signal, options);
      if (record.isBackground && !this.poolHasRoom("background")) {
        // At the concurrency limit — queue it, drains when a slot frees. A
        // detached resume has no inline caller, hence nothing to release. The
        // queue is shared with spawns, whose startup is async, so entries are
        // promise-shaped even though a resume starts synchronously; failures
        // land on the record here, since drainQueue no longer catches.
        this.queue.push({
          id,
          pool: "background",
          start: async () => {
            try {
              start();
            } catch (err) {
              record.status = "error";
              record.error = err instanceof Error ? err.message : String(err);
              record.completedAt = Date.now();
              this.onComplete?.(record);
            }
          },
          release: () => {},
        });
      } else {
        start();
      }
      return record;
    }

    // Foreground resume: run inline and return the settled record.
    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    // Fresh controller, as on the detached path: `abort()` fires whatever
    // `record.abortController` holds, and the spawn's has long settled — so a
    // stop from `/agents` or the caller's Esc would mark the record stopped
    // while the resumed prompt ran on to completion.
    const abortController = new AbortController();
    record.abortController = abortController;
    this.armParentAbort(record, signal);
    // `addEventListener` never fires on a signal that is already aborted, and
    // the runner skips the prompt only when ITS signal is — stop now, so that
    // holds for a resume issued on a call that was cancelled first.
    if (signal?.aborted) this.abort(id);

    try {
      this.settleOutcome(record, await resumeAgent(record.session, prompt, {
        maxTurns: options?.maxTurns ?? record.config?.maxTurns ?? record.invocation?.maxTurns,
        onTurnEnd: options?.onTurnEnd,
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
          options?.onToolActivity?.(activity);
        },
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
          this.onUsage?.(record, usage);
          options?.onAssistantUsage?.(usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          this.onCompact?.(record, info);
          options?.onCompaction?.(info);
        },
        signal: abortController.signal,
      }));
    } catch (err) {
      this.failResume(record, err);
    }
    this.detachParentAbort(record);

    return record;
  }

  /**
   * Write a run's outcome onto its record — a spawn's or a resume's, with one
   * precedence: an external stop keeps "stopped"; a hard abort (turn limit +
   * grace) is "aborted"; a failed final turn (a provider error pi resolved
   * instead of rejecting, #144) is an "error", not a completion with an empty
   * or stale result; otherwise "steered" or "completed". The run's text stays
   * available in every case.
   */
  private settleOutcome(
    record: AgentRecord,
    { text, failure, aborted, steered }: Awaited<ReturnType<typeof resumeAgent>>,
  ): void {
    if (record.status !== "stopped") {
      if (aborted) {
        record.status = "aborted";
      } else if (failure) {
        record.status = "error";
        record.error = failure;
      } else {
        record.status = steered ? "steered" : "completed";
      }
    }
    record.result = text;
    record.completedAt ??= Date.now();
  }

  /** A resume whose runner rejected: an error, unless an external stop got there first. */
  private failResume(record: AgentRecord, err: unknown): void {
    if (record.status !== "stopped") {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
    }
    record.completedAt ??= Date.now();
  }

  /**
   * Start a background resume run: detached, settling and notifying like
   * startAgent's background path. Invoked immediately, or from drainQueue when
   * a concurrency slot frees. The session already exists (resume reuses it), so
   * there is no onSessionCreated to hang per-run wiring off — callers use
   * `options.onStarted`, which fires on both the immediate and the drained path.
   */
  private startResume(
    id: string,
    record: AgentRecord,
    prompt: string,
    parentSignal: AbortSignal | undefined,
    options: ResumeOptions,
  ) {
    if (!record.session) return;

    record.status = "running";
    record.startedAt = Date.now();
    if (record.isBackground) this.runningBackground++;
    this.onStart?.(record);

    // Fresh abort controller so /agents stop and steering target THIS run rather
    // than the previous one's settled controller.
    const abortController = new AbortController();
    record.abortController = abortController;
    // Optional, and NOT what the Agent tool passes for a detached resume: a
    // parent signal aborts on the parent's own interrupt (user Esc), which is
    // right for a foreground run whose result the caller is awaiting, and wrong
    // for a detached one — background spawns omit it for exactly this reason.
    let detachParentSignal: (() => void) | undefined;
    if (parentSignal) {
      const onParentAbort = () => this.abort(id);
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
    }

    // Per-run side effects (output streaming) — see ResumeOptions.onStarted.
    // After the record is in its running shape, before the run is kicked off.
    try { options.onStarted?.(); } catch { /* ignore caller wiring errors */ }

    const settle = () => {
      detachParentSignal?.();
      detachParentSignal = undefined;
      // Final flush of streaming output file
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore */ }
        record.outputCleanup = undefined;
      }
      if (record.isBackground) this.runningBackground--;
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      this.drainQueue();
    };

    const promise = resumeAgent(record.session, prompt, {
      maxTurns: options.maxTurns ?? record.config?.maxTurns ?? record.invocation?.maxTurns,
      onTurnEnd: options.onTurnEnd,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      signal: abortController.signal,
    })
      .then((outcome) => {
        this.settleOutcome(record, outcome);
        settle();
        return outcome.text;
      })
      .catch((err) => {
        this.failResume(record, err);
        settle();
        return "";
      });

    record.promise = promise;
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued). Fires `onSteered` on either
   * accepted path, so the UI viewers and the RPC all report
   * the steer the same way without each emitting by hand. The steer tools
   * bypass this method because they await delivery.
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    this.onSteered?.(record, message);
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /** In-session eviction metadata only; this is not a cross-process resume index. */
  getResumableRecord(id: string): AgentRecord | undefined {
    return this.resumable.get(id)?.record;
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued. No decrement — the slot was never taken —
    // and no onComplete, matching what a queued background abort has always
    // done; a blocking caller learns of the stop from its own tool result.
    if (record.status === "queued") {
      this.dequeue(q => q.id === id);
      record.status = "stopped";
      record.completedAt = Date.now();
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    const args = this.launches.get(id);
    if (record.sessionFile && args) {
      const { session: _session, promise: _promise, abortController: _abort, outputCleanup: _cleanup, ...saved } = record;
      const savedOptions: SpawnOptions = {
        description: record.description,
        config: record.config,
        model: record.session?.model ?? args.options.model,
        modelFromParams: record.modelFromParams,
        cwd: args.options.cwd,
        resumeSessionFile: record.sessionFile,
        invocation: record.invocation,
      };
      this.resumable.set(id, { record: saved, args: { pi: args.pi, ctx: args.ctx, prompt: "", options: savedOptions } });
      while (this.resumable.size > MAX_RESUMABLE) {
        this.resumable.delete(this.resumable.keys().next().value!);
      }
    }
    this.launches.delete(id);
    const session = record.session;
    // Detached before the shutdown starts, so the record leaves the map at once and
    // nothing can observe a session that is half torn down.
    record.session = undefined;
    this.agents.delete(id);
    // A failed startup keeps its (rejected) entry so a late awaitStartup still
    // sees it; drop it with the record so the map can't grow unbounded.
    this.startups.delete(id);
    // Fire-and-forget is right here and only here: this runs from the 60s cleanup timer
    // and from `clearCompleted()` on session boundaries, with the process staying alive,
    // so handlers get their full window. The quit path awaits instead — see dispose().
    void shutdownChildSession(session);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
    // Unconditional: both callers are session boundaries (`session_start` and
    // `session_before_switch`), and `skipUnconsumed` only spares records whose
    // results the LLM has yet to read — it does not make the sweep partial in
    // the sense that matters here. Eviction metadata must not cross session boundaries.
    this.resumable.clear();
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    this.dequeue(() => true);
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending: Promise<unknown>[] = [];
      for (const record of this.agents.values()) {
        if (record.status !== "running" && record.status !== "queued") continue;
        // An agent whose worktree is still being created is "running" with no
        // `promise` yet — without its startup the wait would return too early.
        const startup = this.startups.get(record.id);
        if (startup) pending.push(startup);
        if (record.promise) pending.push(record.promise);
      }
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  /**
   * @param pi - Needed to run `git worktree prune`, which is async now and so
   *   cannot be reached through a stored spawn argument at shutdown. Omitting
   *   it (tests, teardown of a manager that never spawned) skips the prune.
   */
  async dispose(pi?: ExtensionAPI): Promise<void> {
    clearInterval(this.cleanupInterval);
    // Clear queue — via dequeue, so anyone blocked in spawnAndWait is woken
    // rather than left awaiting a gate nothing will ever resolve.
    this.dequeue(() => true);
    const sessions = [...this.agents.values()].map(record => record.session);
    this.agents.clear();
    this.startups.clear();
    this.launches.clear();
    this.resumable.clear();
    if (pi) {
      // Prune any orphaned git worktrees (crash recovery). Detached: dispose runs
      // on the shutdown path, which cannot wait for git. Started before the awaited
      // shutdown below rather than after it, so the git calls have that window to
      // finish in instead of racing the process exit that follows.
      const prune = (repo: string) => { pruneWorktrees(pi, repo).catch(() => {}); };
      prune(process.cwd());
      // Also prune repos that caller-supplied cwds created worktrees in — a clean
      // exit with in-flight agents would otherwise leave stale registrations there.
      for (const repo of this.worktreeRepos) prune(repo);
    }
    // Awaited, unlike the eviction path: pi awaits this extension's `session_shutdown`
    // handler and the process exits right after it returns, so anything left unawaited
    // here never runs at all. Bounded — each call carries its own ceiling, concurrently.
    await Promise.all(sessions.map(session => shutdownChildSession(session)));
  }
}
