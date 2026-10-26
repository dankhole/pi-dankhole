/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentSession, defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, isKeyRelease, Key, matchesKey, type ScrollViewScrollbar, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { abortable } from "./abortable.js";
import { AgentManager, type SpawnOptions } from "./agent-manager.js";
import { getAgentConversation, getDefaultMaxTurns, getGraceTurns, getRememberAgents, normalizeMaxTurns, SUBAGENT_TOOL_NAMES, setDefaultMaxTurns, setGraceTurns, setRememberAgents, steerAgent } from "./agent-runner.js";
import { inChildSessionContext } from "./child-context.js";
import { CompletionOutbox } from "./completion-outbox.js";
import { type RpcHandle, registerRpcHandlers } from "./cross-extension-rpc.js";
import { assertSupportedResumeParams, isolationParam, launchConfigParams, resolveAgentInvocationConfig } from "./invocation-config.js";
import { describeModel, resolveModel } from "./model-resolver.js";
import { checkModelScope, isScopeModelsEnabled, setScopeModelsEnabled } from "./model-scope.js";
import { createOutputFilePath, ensureOutputFile, getOutputTranscriptDefault, setOutputTranscriptDefault, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { applyAndEmitLoaded, type SubagentsSettings, saveAndEmitChanged, type ToolDescriptionMode } from "./settings.js";
import { getForegroundOutcomeNote, getStatusNote, partialOutputSuffix } from "./status-note.js";
import { type AgentInvocation, type AgentRecord, type NotificationDetails, type ViewerMarkdownMode, type WidgetMode } from "./types.js";
import {
  type AgentActivity,
  type AgentDetails,
  AgentWidget,
  buildInvocationTags,
  colorInvocationSections,
  describeActivity,
  fgPreservingNestedStyles,
  formatCost,
  formatDuration,
  formatMs,
  formatTokens,
  formatTurns,
  SPINNER,
  type Theme,
  type UICtx,
} from "./ui/agent-widget.js";
import { CompletionCards } from "./ui/completion-card.js";
import { ConversationViewer, getConversationOverlayOptions, type ViewerBackgroundAction } from "./ui/conversation-viewer.js";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.js";
import { selectItem } from "./ui/select-item.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage, PendingUsagePool, toReportedUsage } from "./usage.js";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "./worktree.js";
import { escapeXml } from "./xml.js";

// ---- Shared helpers ----

/** Tool execute return value for a text response. */
function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: Pick<Theme, "fg">,
): Container {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", frame) + (statsText ? " " + statsText : ""), 0, 0));
  container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0));
  return container;
}

/** How long a foreground `Agent` call runs before its row offers ctrl+b. */
const BACKGROUND_HINT_DELAY_MS = 2000;

/** Format an agent's lifetime token total, or "" when zero. */
function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: AgentSession) => {
      state.session = session;
    },
    // Spend is accumulated on the AgentRecord (agent-manager), which is what
    // every surface reads; this callback exists here only to repaint on it.
    onAssistantUsage: (_usage: LifetimeUsage) => {
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}

/**
 * Advertised thinking levels, ordered to mirror pi-ai's EXTENDED_THINKING_LEVELS
 * (`off` + every `ThinkingLevel`) for the Agent tool schema. Availability still depends on the
 * host pi version and the selected model — pi clamps unsupported levels down.
 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "steered": return "Wrapped up (turn limit)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
function formatTaskNotification(record: AgentRecord, resultMaxLen: number, showCost = false): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = getSessionContextPercent(record.session);
  const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : "";
  const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : "";
  // Only under `showCost`: this is LLM context, and a figure the orchestrator
  // did not ask for is a figure it may start reporting unprompted.
  const cost = showCost ? getLifetimeCost(record.lifetimeUsage) : 0;
  const costXml = cost > 0 ? `<estimated_cost_usd>${cost.toFixed(4)}</estimated_cost_usd>` : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}${costXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join('\n');
}

/** Build AgentDetails from a base + record-specific fields. */
function buildDetails(
  base: Pick<AgentDetails, "description" | "modelName" | "tags">,
  record: { toolUses: number; startedAt: number; completedAt?: number; status: string; error?: string; id?: string; session?: any; lifetimeUsage: LifetimeUsage },
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    // Raw, and unconditional: `tokens` is preformatted because it is one stat,
    // but a cost is joined by "·" in one surface, "," in another and "|" in a
    // third — so it travels as a number and each renderer punctuates its own.
    cost: getLifetimeCost(record.lifetimeUsage),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

/** Build notification details for the custom message renderer. */
function buildNotificationDetails(record: AgentRecord, resultMaxLen: number, activity?: AgentActivity): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    invocation: {
      ...record.invocation,
      ...(record.session?.model ? describeModel(record.session.model) : {}),
      ...(record.session?.thinkingLevel ? { thinking: record.session.thinkingLevel } : {}),
    },
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    // Carried unconditionally; the renderer gates on the setting. Details are
    // data, and a notification rendered before a mid-session toggle should not
    // be stuck with the old answer.
    totalCost: getLifetimeCost(record.lifetimeUsage),
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "…"
        : record.result
      : "No output.",
  };
}

export default function (pi: ExtensionAPI) {
  // Child AgentSessions load normal extensions. Re-entering this extension there
  // would create another manager and expose delegation tools inside a worker.
  if (inChildSessionContext()) return;

  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => message.details
      ? new CompletionCards(message.details, expanded, theme, showCost)
      : undefined
  );

  // ---- Agent activity tracking + widget ----
  const agentActivity = new Map<string, AgentActivity>();

  // ---- Usage reporting (both off by default; see SubagentsSettings) ----
  /** Attach subagent spend to tool results, so the parent session counts it. */
  let reportUsage = false;
  function isReportUsageEnabled(): boolean { return reportUsage; }
  function setReportUsage(b: boolean): void {
    reportUsage = b;
    // Whatever accumulated while it was on is stale the moment it goes off:
    // draining it later would bill the parent for a window the user opted out
    // of, in one lump, on some unrelated later tool call.
    if (!b) pendingUsage.drain();
  }
  /** Show `~$X` next to token counts in the subagent surfaces. */
  let showCost = false;
  function isShowCostEnabled(): boolean { return showCost; }
  function setShowCost(b: boolean): void { showCost = b; widget.update(); fleet.update(); }
  /** Name the model and thinking level on the widget's running rows. */
  let showModel = false;
  function isShowModelEnabled(): boolean { return showModel; }
  function setShowModel(b: boolean): void { showModel = b; widget.update(); }
  /** Distinguish row fields without changing their text or layout. */
  let sectionColors = false;
  function isSectionColorsEnabled(): boolean { return sectionColors; }
  function setSectionColors(b: boolean): void { sectionColors = b; widget.update(); }
  /**
   * How much of the conversation viewer renders as Markdown. Read through a
   * getter by the viewer rather than captured like `showCost`, because the
   * viewer's `m` key writes back here while the overlay is on screen.
   */
  let viewerMarkdown: ViewerMarkdownMode = "assistant";
  function getViewerMarkdown(): ViewerMarkdownMode { return viewerMarkdown; }
  function setViewerMarkdown(mode: ViewerMarkdownMode): void { viewerMarkdown = mode; }
  /**
   * The viewer's `m` key, from either entry point: set the mode and persist it,
   * so the key and `/agents → Settings` stay one setting rather than one per
   * entry point. `ctx` carries only the warning a failed write notifies with,
   * and the fleet list may be acting without one.
   */
  function chooseViewerMarkdown(mode: ViewerMarkdownMode, ctx?: ExtensionCommandContext): void {
    setViewerMarkdown(mode);
    persistSettings(ctx, `Viewer markdown set to ${mode}`);
  }
  const pendingUsage = new PendingUsagePool();

  // ---- Completion delivery ----
  // Every completion notification goes through the outbox, which sends what is
  // pending as one message at the parent's next boundary (see
  // completion-outbox.ts). Each is built when the agent finishes, and reading
  // the result (get_subagent_result, rpc consume) cancels it before it is sent.
  const outbox = new CompletionOutbox(
    (message) => pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: message.content,
      display: true,
      details: message.details,
    }, { deliverAs: "steer", triggerTurn: true }),
    // The low-level signal disappears between retry attempts; the host stays
    // busy until automatic recovery and abort cleanup have actually settled.
    () => currentCtx !== undefined && !currentCtx.isIdle(),
  );
  const QUEUE_WAIT_POLL_MS = 50;

  function notifyCompletion(record: AgentRecord) {
    const activity = agentActivity.get(record.id);
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    fleet.onAgentFinished(record.id);
    // Built now, so a resume before the send cannot rewrite it. A record that
    // cannot be formatted is skipped, as a failed send always was.
    try {
      const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';
      const message = {
        content: formatTaskNotification(record, 500, showCost) + footer,
        details: buildNotificationDetails(record, 500, activity),
      };
      outbox.add(record.id, message);
    } catch { /* ignore stale completion side-effect errors */ }
    widget.update();
  }

  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    // All three fields are lifetime-accumulated (Σ over every assistant message_end),
    // so they survive compaction together — input + output ≤ total always.
    // tokens is omitted when nothing was ever produced (e.g. agent errored before
    // any message_end fired), preserving prior payload shape.
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0
      ? { input: u.input, output: u.output, total }
      : undefined;
    // The whole run's spend as a pi `Usage` — pi's convention for handing spend
    // to a consumer, so `usage.cost.total` and `usage.cacheRead` are where a
    // listener already expects them and anything pi adds to `Usage` arrives
    // without a change here. Omitted when nothing was spent, so "spent nothing"
    // and "never ran" stay distinguishable. Ungated by `showCost`: that setting
    // governs what a human is shown, not what the event carries.
    //
    // `tokens` above is the other convention, kept as it shipped: a flat view
    // model like pi's own `SessionStats`, carrying the DISPLAY total, which
    // excludes cacheRead (#38). The two answer different questions and neither
    // derives from the other.
    const usage = toReportedUsage(u);
    return {
      id: record.id,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
      usage,
    };
  }

  // Background completion: capture a notification for the next safe boundary.
  const manager = new AgentManager((record) => {
    // Emit lifecycle event based on terminal status
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    // Persist final record for cross-extension history reconstruction
    pi.appendEntry("subagents:record", {
      id: record.id, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });

    // Skip notification if result was already consumed via get_subagent_result
    if (record.resultConsumed) {
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      fleet.onAgentFinished(record.id);
      widget.update();
      return;
    }

    notifyCompletion(record);
  }, undefined, (record) => {
    // Programmatic spawns need the same live surfaces as Agent-tool spawns.
    if (currentCtx?.hasUI) {
      widget.ensureTimer();
      widget.update();
      fleet.ensureTimer();
      fleet.update();
    }
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", {
      id: record.id,
      description: record.description,
    });
  }, (record, info) => {
    // Emit compacted event when agent's session compacts (preserves count on record).
    pi.events.emit("subagents:compacted", {
      id: record.id,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  }, (record, usage) => {
    // Every assistant message from every worker, exactly once.
    // Parked here until a tool result can carry it back to the parent session;
    // see `PendingUsagePool`. Skipped entirely when the feature is off, so no
    // pool grows in a session that will never drain it.
    if (reportUsage) pendingUsage.add(usage);
    // The live per-message ledger is ungated by reportUsage: that setting
    // decides whether the parent's own accounting includes this spend.
    //
    // `model` and `thinking` are read off the record per message, not captured
    // at spawn: the record is authoritative only once the session exists and pi
    // has clamped the level to the model (see `onSessionCreated`).
    const reported = toReportedUsage(usage);
    if (!reported) return;
    // Unknown model/thinking are omitted.
    const invocation = record.invocation;
    pi.events.emit("subagents:usage", {
      id: record.id,
      description: record.description,
      ...(invocation?.modelId !== undefined ? { model: invocation.modelId } : {}),
      ...(invocation?.thinking !== undefined ? { thinking: invocation.thinking } : {}),
      // Set only when pi clamped the requested level, so a ledger
      // can show `low (asked minimal)` instead of silently relabelling.
      ...(invocation?.requestedThinking !== undefined ? { requestedThinking: invocation.requestedThinking } : {}),
      usage: reported,
    });
  }, (record, message) => {
    pi.events.emit("subagents:steered", { id: record.id, message });
  });

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  // Documented for callers in docs/rpc.md ("The manager registry").
  //
  // Claim the slot only if it's free: subagent sessions re-activate this
  // extension in the same process (session.bindExtensions in agent-runner.ts),
  // and unconditionally overwriting would point the registry at a short-lived
  // child manager — and the child's shutdown would then delete the root
  // session's entry. The first activation (the root session) wins; child
  // activations leave it alone.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  // Public callers may supply arbitrary options. Only the supported launch
  // surface is forwarded; session identity and resume capabilities stay internal.
  /** Public detached launches share activity tracking and transcript wiring. */
  const spawnTopLevel = (piRef: ExtensionAPI, ctxRef: ExtensionContext, prompt: string, options: SpawnOptions) => {
    if (!options?.description?.trim()) throw new Error("description must be a non-empty visible goal.");
    const safeOptions: SpawnOptions = {
      description: options.description,
      config: options.config,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      isBackground: options.isBackground,
      bypassQueue: options.bypassQueue,
      isolation: options.isolation,
      cwd: options.cwd,
      invocation: options.invocation,
      signal: options.signal,
      onSpawned: options.onSpawned,
      onQueued: options.onQueued,
      onCompaction: options.onCompaction,
      onBeforeWorktreeCleanup: options.onBeforeWorktreeCleanup,
    };
    // This adapter is public: provenance is derived, never trusted from its caller.
    safeOptions.modelFromParams = safeOptions.model !== undefined || safeOptions.config?.model !== undefined;
    const { state, callbacks } = createActivityTracker(normalizeMaxTurns(
      safeOptions.maxTurns ?? safeOptions.config?.maxTurns ?? getDefaultMaxTurns(),
    ));
    const onSpawned = safeOptions.onSpawned;
    let id: string;
    id = manager.spawn(piRef, ctxRef, prompt, {
      ...safeOptions,
      ...callbacks,
      onSpawned: spawnedId => {
        const record = manager.getRecord(spawnedId);
        if (record?.config?.outputTranscript) {
          record.outputFile = createOutputFilePath(ctxRef.cwd, spawnedId, ctxRef.sessionManager.getSessionId());
          writeInitialEntry(record.outputFile, spawnedId, prompt, ctxRef.cwd);
        }
        onSpawned?.(spawnedId);
      },
      onSessionCreated: session => {
        callbacks.onSessionCreated(session);
        const record = manager.getRecord(id);
        if (record?.outputFile) {
          record.outputCleanup = streamToOutputFile(session, record.outputFile, id, ctxRef.cwd);
        }
      },
    });
    agentActivity.set(id, state);
    return id;
  };

  const registryEntry = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: spawnTopLevel,
    getRecord: (id: string) => manager.getRecord(id),
  };
  const ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;
  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered pi-subagents out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).
  let rpcHandle: RpcHandle | undefined;
  // Capture the bound context before registering RPC handlers.
  // This also wires the RPC handlers and broadcasts readiness — on the first
  // bound session_start, so a filtered-out activation never advertises (#142).
  pi.on("session_start", async (_event, ctx) => {
    if (!ownsManagerRegistry) return;
    currentCtx = ctx;
    if (ctx.hasUI) {
      widget.setUICtx(ctx.ui);
      fleet.setUICtx(ctx.ui as any);
      watchHandoffKey(ctx.ui);
    }
    manager.clearCompleted(true);
    // A double-bind must not leak RPC listeners.
    if (!rpcHandle) {
      rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => currentCtx,
        manager: {
          spawn: spawnTopLevel,
          awaitStartup: (id) => manager.awaitStartup(id),
          getRecord: (id) => manager.getRecord(id),
          abort: (id) => manager.abort(id),
          consumeResult: (id) => {
            const record = manager.getRecord(id);
            // Same guard as get_subagent_result: a running agent has no result
            // to consume, and its notification is still the caller's only
            // signal that it finished.
            if (!record) return false;
            if (record.status === "running" || record.status === "queued") return false;
            record.resultConsumed = true;
            outbox.cancel(record.id);
            return true;
          },
          steer: (id, message) => manager.steer(id, message),
        },
      });
      // Broadcast readiness so extensions loaded alongside us can discover us.
      // Emitting after all factories have run (rather than at factory time)
      // also avoids the race where a consumer loaded after us misses the event.
      pi.events.emit("subagents:ready", {});
    }
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted(true);
  });

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    rpcHandle?.unsubSpawn();
    rpcHandle?.unsubStop();
    rpcHandle?.unsubPing();
    rpcHandle?.unsubConsume();
    rpcHandle?.unsubSteer();
    rpcHandle = undefined;
    currentCtx = undefined;
    // Only release the global slot if this activation claimed it — a child
    // session's shutdown must not delete the root session's registry entry.
    if (ownsManagerRegistry && (globalThis as any)[MANAGER_KEY] === registryEntry) {
      delete (globalThis as any)[MANAGER_KEY];
    }
    manager.abortAll();
    // Activation-owned resources must not survive reload or session replacement.
    // A vetoed session_before_switch deliberately leaves them alive.
    widget.dispose();
    outbox.dispose();
    fleet.dispose();
    unsubHandoffKey?.();
    unsubHandoffKey = undefined;
    handoffKeyUi = undefined;
    // Awaited: it emits `session_shutdown` into every retained child session so
    // extensions bound there can release what they armed in `session_start` (#242).
    // pi awaits this handler, and the process exits right after — unawaited, those
    // handlers would never run. Internally bounded, so a hung one can't strand quit.
    await manager.dispose(pi);
    // Every agent is stopped and every child session has shut down, so no more
    // `subagents:usage` can arrive. A ledger flushing in its own
    // `session_shutdown` may have run before this handler aborted the agents
    // (handlers run in load order) and missed their last messages; this is the
    // point after which a synchronous final flush is complete. Synchronous:
    // `emit` does not await listeners, and pi exits once this handler returns.
    pi.events.emit("subagents:disposed", {});
  });

  // Live widget: show running agents above editor.
  // widgetMode (default "background") selects what the widget shows: "all" =
  // every agent; "background" = hide foreground (they already render inline as
  // the Agent tool result, so showing them here too is a duplicate, #118), keep
  // everything else; "off" = hide the widget entirely. Read live at render time.
  let widgetMode: WidgetMode = "background";
  function getWidgetMode(): WidgetMode { return widgetMode; }
  const widget = new AgentWidget(manager, agentActivity, getWidgetMode, isShowCostEnabled, isShowModelEnabled, isSectionColorsEnabled);
  function setWidgetMode(m: WidgetMode): void { widgetMode = m; widget.update(); }

  /**
   * Foreground `Agent` calls whose run can be handed to the background, by
   * agent id. Each entry wakes its blocked tool call, which then returns as a
   * background spawn would. Only the Agent tool registers here, so a spawn with
   * no tool call to return — such as a programmatic launch — never
   * offers the handoff.
   */
  const foregroundHandoffs = new Map<string, () => void>();

  /** Hand these runs to the background and wake their tool calls; returns how many took. */
  function sendForegroundToBackground(ids: Iterable<string>): number {
    let sent = 0;
    for (const id of [...ids]) {
      const wake = foregroundHandoffs.get(id);
      if (!wake || !manager.sendToBackground(id)) continue;
      foregroundHandoffs.delete(id);
      wake();
      sent++;
      // It is a background agent from here on, so announce it as one — as a
      // detached resume re-announces an existing id.
      const record = manager.getRecord(id);
      if (record) {
        pi.events.emit("subagents:created", {
          id,
              description: record.description,
          isBackground: true,
        });
      }
    }
    if (sent > 0) {
      widget.ensureTimer();
      widget.update();
      fleet.ensureTimer();
      fleet.update();
    }
    return sent;
  }

  /** The conversation viewer's `b`: hand just this run to the background. */
  function backgroundActionFor(record: AgentRecord, notify: (message: string) => void): ViewerBackgroundAction {
    return {
      // Registered while the run is live, removed the moment its call returns.
      available: () => foregroundHandoffs.has(record.id),
      send: () => {
        if (sendForegroundToBackground([record.id]) > 0) notify(`Sent "${record.description}" to the background.`);
      },
    };
  }

  // Claude Code's ctrl+b (`task:background`): hand every running foreground
  // `Agent` call to the background. Claimed only while one is pending, so the
  // rest of the time — and whenever the prompt editor is not focused — the key
  // is still pi's cursor-left.
  let handoffKeyUi: ExtensionContext["ui"] | undefined;
  let unsubHandoffKey: (() => void) | undefined;
  function watchHandoffKey(ui: ExtensionContext["ui"]): void {
    if (ui === handoffKeyUi) return;
    unsubHandoffKey?.();
    handoffKeyUi = ui;
    unsubHandoffKey = ui.onTerminalInput(data => {
      // Kitty reports a release too, and matchesKey matches it — act on the
      // press only, or a refused handoff would be retried by its own release.
      if (isKeyRelease(data) || foregroundHandoffs.size === 0 || !matchesKey(data, "ctrl+b")) return undefined;
      // Listeners run before the focused component, so a dialog or the
      // viewer's composer would lose its ctrl+b (cursor-left). The viewer has
      // its own `b`.
      if (!fleet.editorHasFocus()) return undefined;
      const sent = sendForegroundToBackground(foregroundHandoffs.keys());
      if (sent > 0) ui.notify(`Sent ${sent === 1 ? "1 agent" : `${sent} agents`} to the background.`, "info");
      return { consume: true };
    });
  }

  /**
   * pi's fullscreen scrollbar preference, read from the main session's live,
   * trust-aware settings and normalized as pi's own `getFullscreenScrollbar()` does.
   */
  function getFullscreenScrollbar(): ScrollViewScrollbar {
    const mode = pi.getSettings().fullscreenScrollbar;
    return mode === "always" || mode === "hidden" ? mode : "auto";
  }

  // Claude Code-style FleetView: navigable list of main + subagents below the editor.
  // The trailing arguments keep a conversation overlay opened here identical to
  // one opened from `/agents`: same settings on the way in, same persist out.
  const fleet = new FleetList(manager, agentActivity, isShowCostEnabled, getViewerMarkdown,
    (mode) => chooseViewerMarkdown(mode, currentCtx as unknown as ExtensionCommandContext | undefined),
    getFullscreenScrollbar, backgroundActionFor);
  let fleetViewEnabled = true;
  function isFleetViewEnabled(): boolean { return fleetViewEnabled; }
  function setFleetViewEnabled(b: boolean): void { fleetViewEnabled = b; fleet.setEnabled(b); }

  // What an unqualified spawn means. Defaults to background.
  let backgroundByDefault = true;
  function getBackgroundByDefault(): boolean { return backgroundByDefault; }
  function setBackgroundByDefault(b: boolean) { backgroundByDefault = b; }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode { return toolDescriptionMode; }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void { toolDescriptionMode = mode; }

  /** Continuations reuse their captured turn budget unless explicitly changed. */
  function resumeTurnLimit(record: AgentRecord, explicit?: number): number | undefined {
    return normalizeMaxTurns(explicit ?? record.config?.maxTurns ?? record.invocation?.maxTurns ?? getDefaultMaxTurns());
  }

  /**
   * Launch a detached resume of an existing agent and wire everything a
   * re-running agent needs: transcript anchoring, activity tracking,
   * widget/fleet refresh, and the `subagents:created` event.
   *
   * Returns the record, or undefined when the manager refused because
   * the agent is still running (see AgentManager.resume).
   *
   * Callers must have already established that the record has a session.
   */
  async function startBackgroundResume(
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string,
    opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
  ): Promise<AgentRecord | undefined> {
    const id = existing.id;
    const description = existing.description;
    // Completion must refer to this continuation's tool call, not an older run.
    existing.toolCallId = opts.toolCallId;
    // Reuse the agent's transcript rather than starting a fresh one: the
    // path is deterministic per agent+session, so writing an initial entry
    // would truncate the previous run's turns (see ensureOutputFile).
    if (opts.outputTranscript) {
      existing.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
      ensureOutputFile(existing.outputFile);
    }
    // Anchor streaming past the turns already on disk, captured BEFORE the
    // run starts. The resumed prompt lands as an ordinary user message at
    // this index, so it is written exactly once.
    const hadSession = existing.session !== undefined;
    const transcriptAnchor = existing.session?.messages.length ?? 0;

    const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(normalizeMaxTurns(opts.maxTurns));
    // resumeAgent has no onSessionCreated — the session predates this run —
    // so seed it directly, or the widget shows no context % for the agent.
    bgState.session = existing.session;

    // No `signal`: a background spawn deliberately omits it, and a detached
    // resume must behave the same. Passing it would abort this agent when
    // the parent turn is interrupted (user Esc), while agents started with
    // run_in_background in that same turn keep going.
    const record = await manager.resume(id, prompt, undefined, {
      isBackground: true,
      maxTurns: opts.maxTurns,
      onTurnEnd: bgCallbacks.onTurnEnd,
      onToolActivity: bgCallbacks.onToolActivity,
      onAssistantUsage: bgCallbacks.onAssistantUsage,
      // Fires when the run actually starts — immediately, or on queue
      // drain. Wiring it here (rather than after resume() returns) means a
      // resume stopped while still queued never started streaming, so
      // there is no subscription left behind for a later run to trip over.
      onStarted: () => {
        const rec = manager.getRecord(id);
        if (!rec) return;
        // A retained ID reopened after eviction has a new session instance.
        bgState.session = rec.session;
        rec.toolCallId = opts.toolCallId;
        if (rec.session && rec.outputFile) {
          const anchor = hadSession ? transcriptAnchor : rec.session.messages.length;
          rec.outputCleanup = streamToOutputFile(rec.session, rec.outputFile, id, ctx.cwd, anchor);
        }
      },
    });
    if (!record) return undefined;
    record.description = description;
    record.toolCallId = opts.toolCallId;

    agentActivity.set(id, bgState);
    // This agent already finished once, so the widget holds a finished-age
    // for it that is past the linger limit — without clearing it, the
    // resumed run's ✓/✗ line never renders and the agent just vanishes.
    widget.markRunning(id);
    widget.ensureTimer();
    widget.update();
    fleet.ensureTimer();
    fleet.update();

    // Reannounce the same worker ID and its current visible goal.
    pi.events.emit("subagents:created", {
      id,
      description: existing.description,
      isBackground: true,
    });

    return record;
  }

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    watchHandoffKey(ctx.ui);
    widget.onTurnStart();
  });

  // The parent's tool batch is done and its next model call not yet made: the
  // boundary where completions are delivered, as in Claude Code.
  pi.on("turn_end", (event) => {
    outbox.onTurnEnd(event.message.role === "assistant" ? event.message.stopReason : undefined);
  });
  pi.on("agent_settled", () => outbox.onSettled());

  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setMaxConcurrentForeground: (n) => manager.setMaxConcurrentForeground(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setBackgroundByDefault,
      setScopeModels: setScopeModelsEnabled,
      setToolDescriptionMode: setToolDescriptionMode,
      setFleetView: setFleetViewEnabled,
      setRememberAgents,
      setWidgetMode: setWidgetMode,
      setOutputTranscript: setOutputTranscriptDefault,
      setWorktreeIsolation: setWorktreeIsolationEnabled,
      setReportUsage,
      setShowCost,
      setShowModel,
      setSectionColors,
      setViewerMarkdown,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  // ---- Agent tool ----

  // Hide declined worktree capability from both schema and prose. The Agent
  // argument preparer handles only known cached isolation values before strict
  // validation, without reopening the schema to arbitrary unknown fields.
  const isolationGuideline = isWorktreeIsolationEnabled()
    ? `\n- Use isolation: "worktree" to give the agent its own git worktree (safe parallel file modifications); leave it unset, or pass "off", for none. The worktree is removed when the agent finishes; if it made changes, they are committed to a branch and the branch is named in the result.`
    : "";

  const isolationCompactGuideline = isWorktreeIsolationEnabled()
    ? `\n- isolation: "worktree" gives the agent its own git worktree (removed on completion); changes land on a branch named in the result.`
    : "";

  const compactAgentToolDescription = `Launch an autonomous worker for an independent multi-step task.
- Supply a short description (its visible goal) and a self-contained prompt.
- Configure tools, extensions, instructions, model and thinking directly at launch.
- Workers inherit the parent's system rules. instructions adds to them; inherit_context separately includes conversation history.
- Independent calls in one message run concurrently. Do not duplicate a worker's work.
- Background is the default; completion notifies you. Use run_in_background: false only when the next action depends on the result.
- Use get_subagent_result to collect results and steer_subagent to redirect running workers, using their returned IDs. resume continues the same conversation and launch configuration; it accepts prompt, optional description, run_in_background and max_turns only.${isolationCompactGuideline}`;

  const fullAgentToolDescription = `Launch an autonomous worker for a complex, multi-step task. Its description is the short visible goal; its returned ID identifies its conversation.

Use direct tools when the target is already known. Delegate independent implementation, exploration or context-heavy research when parallel progress or a separate context outweighs coordination cost.

## Usage notes
- Supply a short (3-5 word) description and a self-contained prompt. State the objective, relevant evidence, decisions, file ownership, authorization boundaries, acceptance criteria and completed checks.
- Workers inherit the parent's system rules. instructions adds to those rules rather than replacing them. inherit_context separately includes the parent's conversation history.
- Configure tools, disallowed_tools, extensions, exclude_extensions, skills, instructions, model, thinking, session persistence, transcript output and memory directly at launch. Omitted model and thinking inherit the parent. These scopes are not an operating-system sandbox.
- For independent parallel tasks, make multiple Agent calls in one message. Do not duplicate work already delegated.
- Workers run in the background by default and notify you when they complete. Do not poll or sleep waiting for them; continue useful independent work. Use run_in_background: false only when the next action depends on the result and nothing else can progress.
- Never fabricate or predict a pending worker's results. Its summary describes intent, not verified outcome: inspect actual changes before reporting success. The result is not shown to the user; summarize it when appropriate.
- Use get_subagent_result and steer_subagent with the returned worker ID. Descriptions are labels, not handles.
- resume continues the original conversation and launch configuration. It accepts prompt, optional description, run_in_background and max_turns only; start a new worker to change tools, rules or model. A running worker must be steered, not resumed.
- Only the main agent launches and controls workers. Workers report further work or coordination needs to the main agent; they cannot delegate further.${isolationGuideline}

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return text.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
          if (name === "isolationGuideline") return isolationGuideline;
          if (name === "agentDir") return getAgentDir();
          console.warn(`[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
          return raw;
        });
        console.warn(`[pi-subagents] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(`[pi-subagents] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  };

  const agentToolDescription = (() => {
    const mode = getToolDescriptionMode();
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
      console.warn('[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"');
    }
    return fullAgentToolDescription;
  })();

  const agentParams = Type.Object({
    prompt: Type.String({
      description: "The task for the agent to perform.",
    }),
    description: Type.Optional(Type.String({ description: "Short visible goal (3-5 words). Required for a new worker; optional on resume." })),
    model: Type.Optional(
      Type.String({
        description:
          'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to inherit the parent model.',
      }),
    ),
    thinking: Type.Optional(
      Type.String({
        description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Omit to inherit the parent level.`,
      }),
    ),
    max_turns: Type.Optional(
      Type.Number({
        description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
        minimum: 0,
      }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description: "Defaults to true — the agent runs detached, returning its ID immediately, and you are notified on completion. Set false only when your very next action depends on the result; the call then blocks and returns the agent's full output inline.",
      }),
    ),
    resume: Type.Optional(
      Type.String({
        description: "Optional agent ID to resume from. Continues from previous context. Resumes detached like any other spawn; pass run_in_background: false to block and get the result inline. The resumed run gets a fresh max_turns budget. An agent can only be resumed once its current run has finished — use steer_subagent to reach one mid-run.",
      }),
    ),
    isolated: Type.Optional(
      Type.Boolean({
        description: "If true, agent gets no extension/MCP tools — only built-in tools.",
      }),
    ),
    inherit_context: Type.Optional(
      Type.Boolean({
        description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
      }),
    ),
    ...isolationParam(isWorktreeIsolationEnabled()),
    ...launchConfigParams(),
  }, { additionalProperties: false });

  const agentTool = defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent for independent multi-step tasks or context isolation. Brief each worker fully and do not duplicate delegated work.",
      "Use direct tools when the target is already known; use workers for open-ended exploration or independent implementation.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: agentParams,
    prepareArguments(args) {
      // Only discard a known cached worktree choice when it is no longer a
      // declared capability. All other keys and malformed values still reach
      // the host's strict schema validation unchanged.
      if (!isWorktreeIsolationEnabled() && !("isolation" in agentParams.properties)
        && args !== null && typeof args === "object" && !Array.isArray(args)) {
        const input = args as Record<string, unknown>;
        if (!input.resume && (input.isolation === "worktree" || input.isolation === "off")) {
          const prepared = { ...input };
          delete prepared.isolation;
          return prepared as Static<typeof agentParams>;
        }
      }
      return args as Static<typeof agentParams>;
    },

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme) {
      const goal = args.description ?? "Continue worker";
      return new Text("▸ " + theme.bold(theme.fg(sectionColors ? "accent" : "toolTitle", goal)), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, renderContext) {
      const details = result.details as AgentDetails | undefined;
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      // Pi reports pre-execution failures (extension block, abort, argument
      // validation) as `{ content: [reason], details: {} }` with isError set —
      // no status to render, so show the reason instead of inventing one (#199).
      if (renderContext.isError || !details?.status) {
        return new Text(text, 0, 0);
      }

      // Helper: build "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens" stats string
      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (sectionColors) {
          parts.push(...colorInvocationSections(theme, d.modelName, d.tags ?? []));
        } else {
          if (d.modelName) parts.push(d.modelName);
          if (d.tags) parts.push(...d.tags);
        }
        if (d.turnCount != null && d.turnCount > 0) {
          parts.push(formatTurns(d.turnCount, d.maxTurns));
        }
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        if (showCost) {
          const costText = formatCost(d.cost ?? 0);
          if (costText) parts.push(costText);
        }
        return parts.map(p => fgPreservingNestedStyles(theme, "dim", p)).join(" " + theme.fg("dim", "·") + " ");
      };

      // ---- While running (streaming) ----
      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const s = stats(details);
        const status = renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme);
        // Claude Code's hint, after the same 2s: a call that finishes quickly
        // never flashes it.
        if (details.backgroundHint && details.durationMs >= BACKGROUND_HINT_DELAY_MS) {
          status.addChild(new Text(theme.fg("dim", "     (ctrl+b to run in background)"), 0, 0));
        }
        return status;
      }

      // ---- Background agent launched ----
      if (details.status === "background") {
        return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
      }

      // ---- Completed / Steered ----
      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const isSteered = details.status === "steered";
        const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        const s = stats(details);
        let line = icon + (s ? " " + s : "");
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            for (const l of lines) {
              line += "\n" + theme.fg("dim", `  ${l}`);
            }
            if (resultText.split("\n").length > 50) {
              line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
            }
          }
        } else {
          const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
          line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
        }
        return new Text(line, 0, 0);
      }

      // ---- Stopped (user-initiated abort) ----
      if (details.status === "stopped") {
        const s = stats(details);
        let line = theme.fg("dim", "■") + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", "  ⎿  Stopped");
        return new Text(line, 0, 0);
      }

      // Anything left ("queued", or a status added later) has no rendering of
      // its own — the turn-limit wording below must not be the catch-all.
      if (details.status !== "error" && details.status !== "aborted") {
        return new Text(text, 0, 0);
      }

      // ---- Error / Aborted (hard max_turns) ----
      const s = stats(details);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");

      if (details.status === "error") {
        line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
      }

      return new Text(line, 0, 0);
    },

    // ---- Execute ----

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Ensure we have UI context for widget rendering
      widget.setUICtx(ctx.ui as UICtx);

      const runInBackground = params.run_in_background ?? getBackgroundByDefault();
      if (params.resume) {
        try {
          assertSupportedResumeParams(params);
          // Validate the two mutable execution controls without rebuilding the
          // saved launch configuration or resolving another model on resume.
          resolveAgentInvocationConfig({ max_turns: params.max_turns, run_in_background: params.run_in_background });
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error));
        }
      } else if (!params.description?.trim()) {
        return textResult("description must be a non-empty visible goal for a new worker.");
      }

      const detailBaseFor = (record: AgentRecord | undefined, fallback?: AgentInvocation) => {
        const { modelName, tags } = buildInvocationTags(record?.invocation ?? fallback);
        return {
          description: record?.description ?? params.description ?? "Continue worker",
          modelName,
          tags: tags.length > 0 ? tags : undefined,
        };
      };

      // Resume existing agent
      if (params.resume) {
        const existing = manager.getRecord(params.resume) ?? manager.getResumableRecord(params.resume);
        if (!existing) {
          return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
        }
        if (!existing.session && !existing.sessionFile) {
          return textResult(`Agent "${params.resume}" has no active session to resume.`);
        }
        if (existing.status === "running" || existing.status === "queued") {
          return textResult(`Agent "${params.resume}" is still ${existing.status}. Use steer_subagent or wait for completion.`);
        }
        if (params.description !== undefined) {
          if (!params.description.trim()) return textResult("description must be a non-empty visible goal.");
          existing.description = params.description;
        }
        const resumeDescription = existing.description;
        const outputTranscript = existing.config?.outputTranscript ?? Boolean(existing.outputFile);
        const resumeMaxTurns = resumeTurnLimit(existing, params.max_turns);

        // Background resume: detached run that notifies on completion, mirroring
        // a background spawn. Previously run_in_background was silently ignored
        // on resume (this branch returned before the background branch below),
        // so a resumed agent always blocked the main loop until it finished.
        if (runInBackground) {
          const id = existing.id;
          const record = await startBackgroundResume(ctx, existing, params.prompt, {
            outputTranscript,
            maxTurns: params.max_turns ?? resumeMaxTurns,
            toolCallId,
          });
          if (!record) {
            return textResult(`Failed to resume agent "${params.resume}".`);
          }

          const isQueued = record.status === "queued";
          return textResult(
            `Agent ${isQueued ? "queued" : "resumed"} in background.\n` +
            `Agent ID: ${id}\n` +
            `Description: ${existing.description}\n` +
            (record.outputFile ? `Output file: ${record.outputFile}\n` : "") +
            (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
            `\nYou will be notified when this agent completes.\n` +
            `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.`,
            { ...detailBaseFor(record), toolUses: record.toolUses, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
          );
        }

        // Tracked like a foreground spawn, so the widget row and the result
        // card show THIS run's `↻N≤M` and tool activity rather than the
        // previous run's. The session predates this run, so it is seeded here.
        const { state: resumeState, callbacks: resumeCallbacks } = createActivityTracker(resumeMaxTurns);
        resumeState.session = existing.session;
        agentActivity.set(existing.id, resumeState);
        widget.markRunning(existing.id);
        widget.ensureTimer();
        fleet.ensureTimer();
        fleet.update();
        let record: AgentRecord | undefined;
        const wireTranscript = () => {
          const rec = manager.getRecord(existing.id);
          if (!rec?.session || !outputTranscript) return;
          if (!rec.outputFile) rec.outputFile = createOutputFilePath(ctx.cwd, rec.id, ctx.sessionManager.getSessionId());
          ensureOutputFile(rec.outputFile);
          resumeState.session = rec.session;
          rec.outputCleanup = streamToOutputFile(rec.session, rec.outputFile, rec.id, ctx.cwd, rec.session.messages.length);
        };
        // Live foreground resumes do not fire onStarted; reopened IDs do.
        if (existing.session) wireTranscript();
        try {
          record = await manager.resume(params.resume, params.prompt, signal, {
            maxTurns: params.max_turns ?? resumeMaxTurns,
            onTurnEnd: resumeCallbacks.onTurnEnd,
            onToolActivity: resumeCallbacks.onToolActivity,
            onAssistantUsage: resumeCallbacks.onAssistantUsage,
            onStarted: wireTranscript,
          });
          if (record) record.description = resumeDescription;
        } finally {
          const rec = manager.getRecord(existing.id);
          try { rec?.outputCleanup?.(); } catch { /* best-effort final transcript flush */ }
          if (rec) rec.outputCleanup = undefined;
          agentActivity.delete(existing.id);
          widget.markFinished(existing.id);
          fleet.onAgentFinished(existing.id);
        }
        if (!record) {
          return textResult(`Failed to resume agent "${params.resume}".`);
        }
        // A failed resume surfaces the error, plus any partial output THIS
        // resume produced (never the previous turn's answer, #144).
        if (record.status === "error") {
          return textResult(`Agent failed: ${record.error}${partialOutputSuffix(record)}`, buildDetails(detailBaseFor(record), record, resumeState));
        }
        return textResult(
          record.result?.trim() || "No output.",
          buildDetails(detailBaseFor(record), record, resumeState),
        );
      }

      const resolvedConfig = resolveAgentInvocationConfig(params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: getBackgroundByDefault(),
      });
      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") return textResult(resolved);
        model = resolved;
      }
      const scopeVerdict = checkModelScope({
        model,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: resolvedConfig.modelFromParams,
        agentLabel: params.description!,
        modelInput: resolvedConfig.modelInput,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message);
      if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");

      const { thinking, inheritContext, isolated, isolation } = resolvedConfig;
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      const config = {
        ...resolvedConfig.config,
        // Capture defaults at launch, so continuation does not change its
        // persistence or transcript policy after an unrelated settings edit.
        outputTranscript: resolvedConfig.config.outputTranscript ?? getOutputTranscriptDefault(),
        persistSession: resolvedConfig.config.persistSession ?? getRememberAgents(),
        maxTurns: resolvedConfig.maxTurns ?? getDefaultMaxTurns(),
      };
      const attachTranscript = (record: AgentRecord | undefined, id: string): void => {
        if (!record || !config.outputTranscript) return;
        record.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
        writeInitialEntry(record.outputFile, id, params.prompt, ctx.cwd);
      };
      const { modelName, modelId } = model ? describeModel(model) : { modelName: undefined, modelId: undefined };
      const agentInvocation: AgentInvocation = {
        modelName,
        modelId,
        thinking,
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated,
        inheritContext,
        runInBackground,
        isolation,
      };

      // What the model sees for a run it no longer waits on — spawned in the
      // background, or handed there mid-run (ctrl+b / viewer `b`). One text for
      // both, as in Claude Code: from here on they are the same kind of agent.
      const backgroundResult = (id: string, record: AgentRecord | undefined) => {
        const isQueued = record?.status === "queued";
        return textResult(
          `Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Description: ${params.description}\n` +
          (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
          `Do not duplicate this agent's work.`,
          { ...detailBaseFor(record), toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
        );
      };

      // Background execution
      if (runInBackground) {
        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

        // Wrap onSessionCreated to wire output file streaming.
        // The callback lazily reads record.outputFile (set right after spawn)
        // rather than closing over a value that doesn't exist yet.
        let id: string;
        const origBgOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: any) => {
          origBgOnSession(session);
          const rec = manager.getRecord(id);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
          }
        };

        // A throw here means the agent never started. Let it out: pi marks the
        // tool call failed, whereas a returned message reads to the model as a
        // subagent that ran and reported this (#179).
        id = manager.spawn(pi, ctx, params.prompt, {
          description: params.description!,
          config,
          model,
          modelFromParams: resolvedConfig.modelFromParams,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isBackground: true,
          isolation,
          invocation: agentInvocation,
          ...bgCallbacks,
        });

        // Wire metadata before startup yields to session creation.
        const record = manager.getRecord(id);
        if (record) {
          record.toolCallId = toolCallId;
          attachTranscript(record, id);
        }

        // With isolation: "worktree" the agent isn't running yet — the repo
        // copy is an awaited git call. Wait for it here, after the synchronous
        // wiring above, so a strict-isolation failure still fails THIS tool
        // call instead of being reported as a subagent that ran (#179).
        await manager.awaitStartup(id);

        agentActivity.set(id, bgState);
        widget.ensureTimer();
        widget.update();
        fleet.ensureTimer();
        fleet.update();

        // Emit created event
        pi.events.emit("subagents:created", {
          id,
          description: params.description,
          isBackground: true,
        });

        return backgroundResult(id, record);
      }

      // Foreground (synchronous) execution — stream progress via onUpdate
      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;
      // Set once the run is live and can be handed to the background — see
      // `foregroundHandoffs`. Unset while queued: there is no run to hand over.
      let handoffId: string | undefined;
      // Set by the handoff. From then on `onUpdate` is a dead handle (pi drops
      // updates once `execute` has returned), so `streamUpdate` stops building
      // them; the tracker keeps `fgState` live for the widget and FleetView.
      let backgrounded = false;
      // Set only while the spawn is parked on a foreground concurrency slot
      // (maxConcurrentForeground); undefined the rest of the time, including
      // always when the limit is unset.
      let queuedAhead: number | undefined;

      const streamUpdate = () => {
        if (backgrounded) return;
        // Spend from the record, everything else from the live tracker. `fgId`
        // is set in onSessionCreated below, which fires before the first
        // assistant message — so nothing is spent while this reads zero.
        const fgRecord = fgId ? manager.getRecord(fgId) : undefined;
        const details: AgentDetails = {
          ...detailBaseFor(fgRecord, agentInvocation),
          toolUses: fgState.toolUses,
          tokens: fgRecord ? formatLifetimeTokens(fgRecord) : "",
          cost: fgRecord ? getLifetimeCost(fgRecord.lifetimeUsage) : 0,
          turnCount: fgState.turnCount,
          maxTurns: fgState.maxTurns,
          durationMs: Date.now() - startedAt,
          // Deliberately still "running" while queued: the renderer routes any
          // status it doesn't know to raw text (see the catch-all below), which
          // would drop the spinner and read as hung. Only the activity line
          // changes — "thinking…" would be a lie for an agent that has not
          // started and may not for minutes.
          status: "running",
          activity: queuedAhead === undefined
            ? describeActivity(fgState.activeTools, fgState.responseText)
            : `queued — waiting for a foreground slot${queuedAhead > 0 ? ` (${queuedAhead} ahead)` : ""}`,
          spinnerFrame: spinnerFrame % SPINNER.length,
          // One hint per batch, as in Claude Code: on the earliest call still
          // pending (a Map iterates in insertion order). ctrl+b takes them all.
          backgroundHint: handoffId !== undefined && foregroundHandoffs.keys().next().value === handoffId,
        };
        onUpdate?.({
          content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
          details: details as any,
        });
      };

      const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns, streamUpdate);

      // Wire session creation: register in widget + stream to output file.
      // The output file path is set synchronously after spawn (below),
      // before onSessionCreated fires — same pattern as background agents.
      const origOnSession = fgCallbacks.onSessionCreated;
      fgCallbacks.onSessionCreated = (session: any) => {
        origOnSession(session);
        // It really started — stop reporting it as queued, and repaint now
        // rather than leaving the stale line up for the next spinner tick.
        // Guarded, so a spawn that never queued emits no extra update.
        if (queuedAhead !== undefined) {
          queuedAhead = undefined;
          streamUpdate();
        }
        for (const a of manager.listAgents()) {
          if (a.session === session) {
            fgId = a.id;
            agentActivity.set(a.id, fgState);
            widget.ensureTimer();
            fleet.ensureTimer();
            fleet.update();
            break;
          }
        }
        // Stream conversation to output file (foreground agent logging)
        if (fgId) {
          const rec = manager.getRecord(fgId);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
          }
        }
      };

      // Animate spinner at ~80ms (smooth rotation through 10 braille frames)
      const spinnerInterval = setInterval(() => {
        spinnerFrame++;
        streamUpdate();
      }, 80);

      streamUpdate();

      // ctrl+b or the viewer's `b` wakes this with the run already handed over
      // (`sendForegroundToBackground`), raced against the run below. The
      // manager only accepts a handoff of a run that has not settled, and the
      // wake-up resolves synchronously with it, so whichever promise wins is
      // the truth: the result is never also delivered as a notification.
      let wakeBackgrounded!: () => void;
      const handedOff = new Promise<undefined>(resolve => { wakeBackgrounded = () => resolve(undefined); });

      let fgResult: { record: AgentRecord } | undefined;
      try {
        fgResult = await Promise.race([manager.spawnAndWait(pi, ctx, params.prompt, {
          description: params.description!,
          config,
          model,
          modelFromParams: resolvedConfig.modelFromParams,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isolation,
          invocation: agentInvocation,
          signal,
          // Deliberately does NOT set fgId: that drives agentActivity, the
          // widget and the `finally` cleanup below, none of which should see an
          // agent that has no session and may never get one.
          onQueued: (_id, ahead) => { queuedAhead = ahead; streamUpdate(); },
          ...fgCallbacks,
        }, (fgAgentId) => {
          // onSpawned: called synchronously after spawn, before onSessionCreated fires.
          // Set up the output file so streamToOutputFile can pick it up.
          const fgRec = manager.getRecord(fgAgentId);
          attachTranscript(fgRec, fgAgentId);
          // Fires once the run promise exists, i.e. the agent is running. From
          // here until this call returns, the run can be handed off.
          handoffId = fgAgentId;
          foregroundHandoffs.set(fgAgentId, () => {
            // Completion names the call that handed this run to the background.
            if (fgRec) fgRec.toolCallId = toolCallId;
            backgrounded = true;
            wakeBackgrounded();
          });
        }), handedOff]);
      } finally {
        // Runs on both paths, so a startup throw — which now propagates, see
        // the background spawn above (#179) — no longer leaves the spinner
        // ticking or a finished agent on the widget.
        clearInterval(spinnerInterval);
        if (handoffId !== undefined) foregroundHandoffs.delete(handoffId);
        // A handed-off run is still working: its row stays, and the
        // background settle in `onComplete` tears it down when it really ends.
        if (fgId && !backgrounded) {
          agentActivity.delete(fgId);
          widget.markFinished(fgId);
          fleet.onAgentFinished(fgId);
        }
      }

      if (fgResult === undefined) return backgroundResult(handoffId!, manager.getRecord(handoffId!));
      const record = fgResult.record;

      // Tokens and cost both come from the worker's lifetime record.
      const tokenText = formatLifetimeTokens(record);

      const details = buildDetails(detailBaseFor(record), record, fgState, { tokens: tokenText });

      if (record.status === "error") {
        // Error headline + any partial output the run produced before failing.
        return textResult(`Agent failed: ${record.error}${partialOutputSuffix(record)}`, details);
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      if (showCost) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(costText);
      }
      return textResult(
        `Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status)}.\n\n` +
        (record.result?.trim() || "No output."),
        details,
      );
    },
  });
  /**
   * Wrap a tool so its results carry back whatever subagent spend the parent
   * session has not been told about yet (see `PendingUsagePool`).
   *
   * Pi copies `AgentToolResult.usage` onto the persisted tool-result message and
   * folds it into `getSessionStats()`, which is what the footer, the statusline
   * and `/cost` read — so this is the whole of "report usage to the parent".
   *
   * Calls without a tool-call ID cannot carry spend into a persisted parent
   * tool result; leave that spend pending for the next real tool result.
   */
  function withUsageReporting<T extends { execute: (...args: any[]) => any }>(tool: T): T {
    return {
      ...tool,
      execute: async (toolCallId: string | undefined, ...rest: any[]) => {
        const result = await tool.execute(toolCallId, ...rest);
        if (!reportUsage || !toolCallId) return result;
        const usage = pendingUsage.drain();
        return usage ? { ...result, usage } : result;
      },
    };
  }
  function registerToolReportingUsage(tool: any): void {
    pi.registerTool(withUsageReporting(tool));
  }

  pi.registerTool(withUsageReporting(agentTool));

  // ---- get_subagent_result tool ----

  registerToolReportingUsage(defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Check status and retrieve a background agent's full result — its completion notification carries only a preview. Use the agent ID returned by Agent.",
    promptSnippet: "Check status and retrieve results from a background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The worker ID returned by Agent.",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait for the agent to complete before returning. Default: false.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      // Wait for completion if requested. Cancellation stops only this tool
      // call; the background agent keeps running and remains unconsumed so its
      // completion notification can still be delivered.
      // Queued agents have no promise yet (it's created when the queue starts
      // them), so poll until they leave the queue, then await like a running one.
      if (params.wait && (record.status === "running" || record.status === "queued")) {
        while (record.status === "queued") {
          await abortable(
            new Promise<void>((resolve) => setTimeout(resolve, QUEUE_WAIT_POLL_MS)),
            signal,
          );
        }
        if (record.promise) await abortable(record.promise, signal);
      }

      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (showCost) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(`Cost: ${costText}`);
      }
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      let output =
        `Agent: ${record.id}\n` +
        `Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running") {
        output += "Agent is still running. Use wait: true or check back later.";
      } else if (record.status === "error") {
        output += `Error: ${record.error}${partialOutputSuffix(record)}`;
      } else {
        output += record.result?.trim() || "No output.";
      }

      // Mark result as consumed — suppresses the completion notification
      if (record.status !== "running" && record.status !== "queued") {
        record.resultConsumed = true;
        outbox.cancel(record.id);
      }

      // Verbose: include full conversation
      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) {
          output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      return textResult(output);
    },
  }));

  // ---- steer_subagent tool ----

  registerToolReportingUsage(defineTool({
    name: SUBAGENT_TOOL_NAMES.STEER,
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    promptSnippet: "Send a steering message to redirect a running background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The worker ID returned by Agent (must be running or queued).",
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status !== "running" && record.status !== "queued") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`);
      }
      if (!record.session) {
        // Session not ready yet — queue the steer for delivery once initialized
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
      }

      try {
        await steerAgent(record.session, params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        if (showCost) {
          const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
          if (costText) stateParts.push(costText);
        }
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount) stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`);
        return textResult(
          `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
          `Current state: ${stateParts.join(" · ")}`,
        );
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  }));

  // ---- /agents interactive menu ----

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    while (true) {
      const agents = manager.listAgents();
      const options = ["Worker conversations", "Settings"];
      const choice = await ctx.ui.select("Agents", options);
      if (!choice) return;
      if (choice === "Settings") await showSettings(ctx);
      else if (agents.length === 0) ctx.ui.notify("No worker conversations in this session.", "info");
      else await showRunningAgents(ctx);
    }
  }

  async function showRunningAgents(ctx: ExtensionCommandContext) {
    const agents = manager.listAgents();
    if (agents.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    // Numbered + item-paired. Two workers spawned together with the
    // same description render identically here, and resolving the choice by
    // string match would open whichever came first.
    const record = await selectItem(ctx.ui, "Running agents", agents, a => {
      const dur = formatDuration(a.startedAt, a.completedAt);
      return `${a.description} · ${a.toolUses} tools · ${a.status} · ${dur}`;
    });
    if (!record) return;

    await viewAgentConversation(ctx, record);
    // Back-navigation: re-show the list
    await showRunningAgents(ctx);
  }

  async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord) {
    if (!record.session) {
      ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
      return;
    }

    const session = record.session;
    const activity = agentActivity.get(record.id);
    let overlayOptions = getConversationOverlayOptions({ mode: "regular" });

    await ctx.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        overlayOptions = getConversationOverlayOptions(tui);
        return new ConversationViewer(tui, session, record, activity, theme, done, () => {
          if (manager.abort(record.id)) {
            ctx.ui.notify(`Stopped "${record.description}".`, "info");
          }
        }, keybindings, (message: string) => manager.steer(record.id, message), showCost, getViewerMarkdown, (mode) => chooseViewerMarkdown(mode, ctx), getFullscreenScrollbar(),
        backgroundActionFor(record, message => ctx.ui.notify(message, "info")));
      },
      {
        overlay: true,
        overlayOptions: () => overlayOptions,
      },
    );
  }

  /**
   * Every settings mutation writes this WHOLE object back to disk, so a field
   * missing here is erased from the user's subagents.json the next time they
   * toggle something unrelated. `SubagentsSettings` has every field optional,
   * so a `: SubagentsSettings` return annotation would let a newly-added setting
   * be forgotten here and still type-check. `satisfies` instead: it still checks
   * each value's type and rejects a mistyped key, but leaves the return type
   * inferred so `_NoMissingSettingsKeys` below can check completeness.
   */
  function snapshotSettings() {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      // 0 = unlimited, and the default — see SubagentsSettings.
      maxConcurrentForeground: manager.getMaxConcurrentForeground(),
      // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
      // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      backgroundByDefault: getBackgroundByDefault(),
      scopeModels: isScopeModelsEnabled(),
      toolDescriptionMode: getToolDescriptionMode(),
      fleetView: isFleetViewEnabled(),
      rememberAgents: getRememberAgents(),
      widgetMode: getWidgetMode(),
      outputTranscript: getOutputTranscriptDefault(),
      worktreeIsolation: isWorktreeIsolationEnabled(),
      reportUsage: isReportUsageEnabled(),
      showCost: isShowCostEnabled(),
      showModel: isShowModelEnabled(),
      sectionColors: isSectionColorsEnabled(),
      viewerMarkdown: getViewerMarkdown(),
    } satisfies SubagentsSettings;
  }

  // Compile-time completeness guard for snapshotSettings(). If a field is added
  // to SubagentsSettings and not mirrored above, this Exclude is non-empty and
  // fails to satisfy `never` — turning a silent settings-erasure bug into a
  // typecheck error. `npm run typecheck` runs in CI.
  type _NoMissingSettingsKeys =
    Exclude<keyof SubagentsSettings, keyof ReturnType<typeof snapshotSettings>> extends never
      ? true
      : ["snapshotSettings() is missing a SubagentsSettings key"];
  const _settingsSnapshotIsComplete: _NoMissingSettingsKeys = true;
  void _settingsSnapshotIsComplete;

  const NUMERIC_IDS = new Set([
    "maxConcurrent", "maxConcurrentForeground", "defaultMaxTurns", "graceTurns",
  ]);

  async function showSettings(ctx: ExtensionCommandContext) {
    function buildItems(): SettingItem[] {
      const mc = manager.getMaxConcurrent();
      const mcf = manager.getMaxConcurrentForeground();
      const dmt = getDefaultMaxTurns() ?? 0;
      const gt = getGraceTurns();
      return [
        {
          id: "maxConcurrent",
          label: "Max concurrency",
          description: "Max concurrent background agents (Enter to type)",
          currentValue: String(mc),
          values: [String(mc)],
        },
        {
          id: "maxConcurrentForeground",
          label: "Max foreground concurrency",
          description: "Max concurrent foreground (blocking) agents (0 = unlimited, Enter to type)",
          currentValue: String(mcf),
          values: [String(mcf)],
        },
        {
          id: "defaultMaxTurns",
          label: "Default max turns",
          description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
          currentValue: String(dmt),
          values: [String(dmt)],
        },
        {
          id: "graceTurns",
          label: "Grace turns",
          description: "Grace turns after wrap-up steer (Enter to type)",
          currentValue: String(gt),
          values: [String(gt)],
        },
        {
          id: "backgroundByDefault",
          label: "Background by default",
          description: "An Agent call that doesn't say runs detached (off = blocks the turn and returns inline)",
          currentValue: getBackgroundByDefault() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "scopeModels",
          label: "Scope models",
          description: "Validate subagent models against scoped models (/scoped-models)",
          currentValue: isScopeModelsEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "outputTranscript",
          label: "Output transcript",
          description: "Write each worker's .output transcript by default. Explicit launch configuration overrides this.",
          currentValue: getOutputTranscriptDefault() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "worktreeIsolation",
          label: "Worktree isolation",
          description:
            "Allow isolation: worktree to copy the repo. Off refuses worktrees on every path immediately — for repos where a copy costs too much time or disk — and drops the `isolation` param from the Agent tool spec on next pi session.",
          currentValue: isWorktreeIsolationEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "reportUsage",
          label: "Report usage to session",
          description:
            "Add subagent tokens and cost to this session's own totals, so pi's footer and /cost stop reading a delegating session as nearly free. Reported on the next tool result (agents that finish in the background are counted on the one after). Context-window % is unaffected.",
          currentValue: isReportUsageEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "showCost",
          label: "Show cost",
          description:
            "Show an estimated `~$0.0042` beside subagent token counts in the widget, fleet view, results and notifications. Priced by pi from the model's rates — omitted entirely for a model it has no rates for.",
          currentValue: isShowCostEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "showModel",
          label: "Show model",
          description:
            "Name the model driving each agent, and the thinking level it is running at, on the widget's running rows. The Agent tool result and the conversation viewer show the pair either way — this adds it to the widget, where the row is already dense.",
          currentValue: isShowModelEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "sectionColors",
          label: "Section colors",
          description: "Distinguish goals, models and thinking in widget and Agent tool rows using theme colors. Metrics and status colors are preserved.",
          currentValue: isSectionColorsEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "viewerMarkdown",
          label: "Viewer markdown",
          description:
            "How much of the conversation viewer renders as Markdown. assistant = assistant text only (default); all = tool results too, for tools that emit Markdown — accepting that a Markdown pass over a diff or a log eats `#` comments, swallows a `---` line and re-fences indented output; off = everything verbatim. `m` in the viewer cycles the same setting (footer: raw / md / md+).",
          currentValue: getViewerMarkdown(),
          values: ["off", "assistant", "all"],
        },
        {
          id: "fleetView",
          label: "Fleet view",
          description: "Claude Code-style main+subagents list below the editor (↓/← to navigate, Enter to view)",
          currentValue: isFleetViewEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "rememberAgents",
          label: "Remember agents",
          description: "Persist worker sessions on disk (also listed in pi /resume). Worker IDs remain session-local.",
          currentValue: getRememberAgents() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "widgetMode",
          label: "Widget",
          description: "Above-editor agent widget: all = every agent; background = hide foreground (they already render inline); off = hide the widget.",
          currentValue: getWidgetMode(),
          values: ["all", "background", "off"],
        },
        {
          id: "toolDescriptionMode",
          label: "Tool description",
          description: "Agent tool description sent to the LLM: full, compact, or custom .pi/agent-tool-description.md (supports {{agentDir}} and {{isolationGuideline}}).",
          currentValue: getToolDescriptionMode(),
          values: ["full", "compact", "custom"],
        },
      ];
    }

    function applyValue(id: string, value: string) {
      if (id === "maxConcurrent") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          manager.setMaxConcurrent(n);
          notifyApplied(ctx, `Max concurrency set to ${n}`);
        }
      } else if (id === "maxConcurrentForeground") {
        // 0 is meaningful here, unlike maxConcurrent above: it means unlimited.
        const n = parseInt(value, 10);
        if (n >= 0) {
          manager.setMaxConcurrentForeground(n);
          notifyApplied(ctx, n === 0
            ? "Max foreground concurrency set to unlimited"
            : `Max foreground concurrency set to ${n}`);
        }
      } else if (id === "defaultMaxTurns") {
        const n = parseInt(value, 10);
        if (n === 0) {
          setDefaultMaxTurns(undefined);
          notifyApplied(ctx, "Default max turns set to unlimited");
        } else if (n >= 1) {
          setDefaultMaxTurns(n);
          notifyApplied(ctx, `Default max turns set to ${n}`);
        }
      } else if (id === "graceTurns") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          setGraceTurns(n);
          notifyApplied(ctx, `Grace turns set to ${n}`);
        }
      } else if (id === "backgroundByDefault") {
        const enabled = value === "on";
        setBackgroundByDefault(enabled);
        notifyApplied(
          ctx,
          enabled
            ? "Agent calls run in the background unless they pass run_in_background: false"
            : "Agent calls block and return inline unless they pass run_in_background: true",
        );
      } else if (id === "scopeModels") {
        const enabled = value === "on";
        setScopeModelsEnabled(enabled);
        notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "outputTranscript") {
        const enabled = value === "on";
        setOutputTranscriptDefault(enabled);
        notifyApplied(ctx, `Output transcript ${enabled ? "enabled" : "disabled"} by default`);
      } else if (id === "worktreeIsolation") {
        const enabled = value === "on";
        setWorktreeIsolationEnabled(enabled);
        // The refusal is live, but the tool schema is built at registration, so
        // the isolation parameter only appears/disappears next session.
        notifyApplied(
          ctx,
          `Worktree isolation ${enabled ? "enabled" : "disabled"}. Tool parameter updates on next pi session.`,
        );
      } else if (id === "toolDescriptionMode") {
        setToolDescriptionMode(value as ToolDescriptionMode);
        notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`);
      } else if (id === "reportUsage") {
        const enabled = value === "on";
        setReportUsage(enabled);
        notifyApplied(
          ctx,
          enabled
            ? "Subagent usage now counted in this session's totals"
            : "Subagent usage no longer counted in this session's totals",
        );
      } else if (id === "showCost") {
        const enabled = value === "on";
        setShowCost(enabled);
        notifyApplied(ctx, `Cost display ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "showModel") {
        const enabled = value === "on";
        setShowModel(enabled);
        notifyApplied(ctx, `Model display ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "sectionColors") {
        const enabled = value === "on";
        setSectionColors(enabled);
        notifyApplied(ctx, `Section colors ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "viewerMarkdown") {
        setViewerMarkdown(value as ViewerMarkdownMode);
        notifyApplied(ctx, `Viewer markdown set to ${value}`);
      } else if (id === "fleetView") {
        const enabled = value === "on";
        setFleetViewEnabled(enabled);
        notifyApplied(ctx, `Fleet view ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "rememberAgents") {
        const enabled = value === "on";
        setRememberAgents(enabled);
        notifyApplied(ctx, `Remember agents ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "widgetMode") {
        setWidgetMode(value as WidgetMode);
        notifyApplied(ctx, `Widget set to ${value}`);
      }
    }

    let list: SettingsList;
    // Track current selection index directly (SettingsList doesn't expose it).
    // Updated on arrow keys so Enter knows which field is selected immediately.
    let currentIndex = 0;

    const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const items = buildItems();

      list = new SettingsList(
        items,
        items.length + 2,
        getSettingsListTheme(),
        (id, newValue) => {
          applyValue(id, newValue);
        },
        () => done(undefined as undefined),
      );

      const container = new Container();
      container.addChild(new Text("⚙  Subagent Settings", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          // Track navigation so Enter knows the current field
          if (matchesKey(data, "up")) {
            currentIndex = Math.max(0, currentIndex - 1);
          } else if (matchesKey(data, "down")) {
            currentIndex = Math.min(items.length - 1, currentIndex + 1);
          }

          // Enter on numeric field → close and prompt for typed input
          if (matchesKey(data, Key.enter) && NUMERIC_IDS.has(items[currentIndex].id)) {
            done(items[currentIndex].id);
            return;
          }
          list.handleInput?.(data);
        },
      };
    });

    // If a numeric field ID was returned, prompt for typed input
    if (result && NUMERIC_IDS.has(result)) {
      const current = result === "maxConcurrent"
        ? String(manager.getMaxConcurrent())
        : result === "maxConcurrentForeground"
          ? String(manager.getMaxConcurrentForeground())
          : result === "defaultMaxTurns"
            ? String(getDefaultMaxTurns() ?? 0)
            : String(getGraceTurns());

      const label = result === "maxConcurrent"
        ? "Max concurrency (1+)"
        : result === "maxConcurrentForeground"
          ? "Max foreground concurrency (0 = unlimited)"
          : result === "defaultMaxTurns"
            ? "Default max turns (0 = unlimited)"
            : "Grace turns (1+)";

      // Loop until user enters a valid integer or cancels (Esc / null).
      // Silently trims whitespace; rejects non-numeric input by re-prompting.
      let input: string | undefined = await ctx.ui.input(label, current);
      while (input != null) {
        const trimmed = input.trim();
        const n = Number(trimmed);
        if (trimmed !== "" && Number.isInteger(n)) {
          applyValue(result, String(n));
          await showSettings(ctx);
          return;
        }
        // Invalid — re-prompt with the user's last entry so they can edit it
        input = await ctx.ui.input(label, trimmed);
      }
    }
  }

  // Persist the current snapshot, emit `subagents:settings_changed`, and surface
  // the right toast. Successful saves show info; persistence failures downgrade
  // to warning so users aren't silently reverted on restart. Event fires regardless
  // of outcome so listeners see the in-memory change.
  /**
   * Persist + broadcast the settings, silent on success — for a change whose
   * feedback is the UI it just changed: the viewer's `m` key, where a
   * notification per press would talk over the overlay it is describing.
   *
   * A *failed* write still speaks. Every other settings path warns when the
   * value is session-only, and swallowing it here would leave a preference
   * looking persisted when the next session will not have it.
   */
  function persistSettings(ctx: ExtensionCommandContext | undefined, changeMsg: string): void {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      changeMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    // `ctx` is absent only on the fleet path between sessions, where
    // `currentCtx` has been cleared and there is no UI to carry the warning to.
    // The write still happens.
    if (level === "warning") ctx?.ui.notify(message, level);
  }

  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });


}
