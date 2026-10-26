/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel as ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "./usage.js";

export type ThinkingLevel = ModelThinkingLevel | "off";

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/**
 * Isolation mode for agent execution.
 *
 * `"off"` exists for the caller's benefit, not the runtime's: models that fill
 * every optional parameter had no legal way to decline a single-value
 * `isolation` field and kept spawning worktrees they had just reasoned their
 * way out of (#231, #184). It is an input spelling only —
 * `resolveAgentInvocationConfig` collapses it to `undefined`, so nothing
 * downstream sees a value other than `"worktree"`.
 */
export type IsolationMode = "worktree" | "off";

/** Launch-time worker configuration, retained on its record for resume. */
export interface AgentConfig {
  builtinToolNames?: string[];
  /** Raw `ext:` selector entries from the `tools:` CSV, e.g. ["ext:foo", "ext:bar/x"].
   * Presence of any entry flips extension tools to an explicit allowlist. */
  extSelectors?: string[];
  /** Tool denylist — these tools are removed even if `builtinToolNames` or extensions include them. */
  disallowedTools?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  extensions: true | string[] | false;
  /** Extension-name denylist applied after the `extensions:` include set. Exclude wins.
   * Plain canonical names only (case-insensitive); no paths, no wildcard. */
  excludeExtensions?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  skills: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  /** Persist this subagent as a normal pi session instead of keeping it in memory only. */
  persistSession?: boolean;
  /** Write the subagent's .output transcript. Defaults to true; false suppresses only that transcript. */
  outputTranscript?: boolean;
  /** Optional session directory used when persistSession is true. Omitted = pi's normal session location. */
  sessionDir?: string;
  /** Additional instructions, appended after inherited parent system rules. */
  instructions?: string;
  /** Default for spawn: fork parent conversation. undefined = caller decides. */
  inheritContext?: boolean;
  /** Default for spawn: run in background. undefined = caller decides. */
  runInBackground?: boolean;
  /** Default for spawn: no extension tools. undefined = caller decides. */
  isolated?: boolean;
  /** Persistent memory scope — agents with memory get a persistent directory and MEMORY.md */
  memory?: { scope: MemoryScope; key: string };
  /**
   * Isolation mode — "worktree" runs the worker in a temporary git worktree.
   */
  isolation?: IsolationMode;
}

/**
 * Display mode for the persistent above-editor agent widget.
 * - `all`: show every agent (foreground + background).
 * - `background`: hide foreground agents (they already render inline as the
 *   Agent tool result, #118); show background/queued/RPC.
 * - `off`: hide the widget entirely.
 */
export type WidgetMode = 'all' | 'background' | 'off';

/**
 * How much of the conversation viewer's transcript is rendered as Markdown.
 * - `off`: every line wraps as literal text, as it did before the mode existed.
 * - `assistant`: assistant text renders as Markdown; tool results stay verbatim
 *   and dim. The default, because assistant text *is* Markdown by contract
 *   while a tool result is arbitrary bytes — a Markdown pass over a log or a
 *   diff eats `#` from shell comments, swallows a `---` line into a setext
 *   heading, re-fences indented output and redraws `| a | b |` as a table.
 *   (Ordered-list renumbering is the one such rewrite actively suppressed —
 *   see `MARKDOWN_OPTIONS` — because it silently changes data, not layout.)
 * - `all`: tool results render as Markdown too, for tools that genuinely emit
 *   it (#210's `ctx_execute`), accepting the rewrites above on ones that don't.
 */
export type ViewerMarkdownMode = 'off' | 'assistant' | 'all';

/** Which concurrency pool a run is charged to. */
export type Pool = "background" | "foreground";

export interface AgentRecord {
  id: string;
  /** Effective launch configuration; never re-resolved from named definitions. */
  config?: AgentConfig;
  /** Whether the saved model was explicitly selected rather than inherited. */
  modelFromParams?: boolean;
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  /**
   * A caller is awaiting this agent inline (`spawnAndWait`) — what
   * `maxConcurrentForeground` bounds. Distinct from `isBackground === false`,
   * which says only that the agent has an inline result surface: a detached
   * cross-extension RPC spawn is foreground by that measure and yet blocks
   * nobody, so it takes no slot.
   *
   * Cleared when the inline caller stops waiting: by `sendToBackground`, or
   * when the run settles.
   */
  blocking?: boolean;
  /**
   * The concurrency pool this run's slot is charged to, set once when it
   * starts. `settleRun` releases exactly this; `sendToBackground` is the only
   * thing that moves it, together with the counters.
   */
  chargedPool?: Pool;
  /**
   * Removes the listener that stops this run when its caller's signal aborts.
   * At most one is armed at a time — queueing arms one, starting replaces it.
   */
  detachParentAbort?: () => void;
  /**
   * Present only while the record is "queued": resolves when it leaves the
   * queue, started or aborted. `spawnAndWait` waits on this because a queued
   * record has no `promise` yet. Always resolves, never rejects — a rejection
   * would escape into the caller's tool `execute` and take down pi's whole
   * Promise.all tool batch.
   */
  startGate?: Promise<void>;
  /** Set when result was already consumed via get_subagent_result — suppresses completion notification. */
  resultConsumed?: boolean;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** Worktree info if the agent is running in an isolated worktree. */
  worktree?: { path: string; branch: string; baseSha: string; workPath: string };
  /** Worktree cleanup result after agent completion. */
  worktreeResult?: { hasChanges: boolean; branch?: string };
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /**
   * The agent's pi session file, when it was persisted (`persist_session`, or
   * the `rememberAgents` default). Captured so ID-based resume can reopen the
   * conversation after the record itself has been evicted; undefined for an
   * in-memory session, which leaves nothing to reopen.
   */
  sessionFile?: string;
  /** Cleanup function for the output file stream subscription. */
  outputCleanup?: () => void;
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /**
   * Whether this agent runs in the background. Tri-state, initialized at spawn
   * from `SpawnOptions.isBackground` and flipped `false` → `true` (once, never
   * back) by `sendToBackground`: `true` = background, `false` =
   * foreground (has an inline Agent tool-result surface), `undefined` = the
   * caller never declared it (e.g. a cross-extension RPC spawn, which is detached
   * and has no inline surface). The widget's background-only filter keys off this
   * — and excludes only explicit `false`, so `undefined` agents stay visible.
   * Reliable across ALL spawn paths, unlike the UI-only `invocation` snapshot,
   * which only the Agent-tool path populates.
   */
  isBackground?: boolean;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;

}

/**
 * What a session reports as its level: pi's `ThinkingLevel` plus the `"off"` a
 * model with thinking disabled reports. Display-only — spawning still takes a
 * `ThinkingLevel`, so this widening cannot leak into an invocation.
 */
export type EffectiveThinkingLevel = ThinkingLevel | "off";

export interface AgentInvocation {
  /** Short display name for tight rows, e.g. "haiku 4.5". Always set once known. */
  modelName?: string;
  /** Canonical `provider/id`, for surfaces with room to disambiguate providers. */
  modelId?: string;
  /** The level actually in effect, once a session exists to report one. */
  thinking?: EffectiveThinkingLevel;
  /**
   * What the caller asked for, kept only when they did not get it — pi clamped
   * the level to the model's capabilities. The snapshot answers "did the spawn
   * honor my instructions?" (#62), which it cannot do if the request is lost, so
   * neither `requested*` field is overwritten once set.
   */
  requestedThinking?: EffectiveThinkingLevel;
  /** The caller's model selector when the resolved display differs. */
  requestedModel?: string;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolation?: IsolationMode;
}

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  /** Effective model/thinking snapshot for this finished run, not a later resume. */
  invocation?: AgentInvocation;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  /**
   * Estimated cost in USD, from pi's per-message `usage.cost.total`. Always
   * populated (0 when the model has no pricing); the renderer decides whether
   * to show it, per the `showCost` setting.
   */
  totalCost?: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
  /** Other completions delivered at the same safe boundary. */
  others?: NotificationDetails[];
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}
