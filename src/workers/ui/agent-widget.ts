/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a list of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentInvocation, AgentRecord, WidgetMode } from "../types.js";
import { type ContextSessionLike, getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";

// ---- Constants ----

/** Maximum number of rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;

/** Braille spinner frames for animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: ContextSessionLike;
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
}

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  description: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Show the ctrl+b hint on this running foreground call's row — one row per batch. */
  backgroundHint?: boolean;
  /** Short label for the model the run used, e.g. "haiku 4.5". */
  modelName?: string;
  /** Notable config tags (e.g. ["thinking: high", "isolated"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number;
  /** Estimated cost in USD; 0 when the model has no pricing data. */
  cost?: number;
  agentId?: string;
  error?: string;
}

// ---- Formatting helpers ----

/** Apply foreground styling while restoring it after nested foreground/full ANSI resets. */
export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styledEmpty = theme.fg(color, "");
  const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
  return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, reset => `${reset}${styleStart}`));
}

/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

/**
 * Display estimated cost rounded to whole dollars; raw accounting stays unchanged.
 * Keep the estimate marker even for positive costs rounded to `~$0`.
 * Exact zero (also reported by unpriced models), negative costs and NaN stay hidden.
 */
export function formatCost(cost: number): string {
  if (!(cost > 0)) return "";
  return `~$${Math.round(cost)}`;
}

/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 * Compaction count rendered as `⇊N` in dim.
 *
 *   "12.3k token"               — no annotations
 *   "12.3k token (45%)"         — percent only
 *   "12.3k token (⇊2)"          — compactions only (e.g. right after compact)
 *   "12.3k token (45% · ⇊2)"    — both
 */
export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenStr = formatTokens(tokens);
  const annot: string[] = [];
  if (percent !== null) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annot.push(theme.fg(color, `${Math.round(percent)}%`));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `⇊${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  return `${tokenStr} (${annot.join(" · ")})`;
}

/** Format turn count with optional max limit: "↻5≤30" or "↻5". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

/** Display elapsed milliseconds rounded to whole minutes, starting at `0m`. */
export function formatMs(ms: number): string {
  return `${Math.max(0, Math.round(ms / 60_000))}m`;
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

/**
 * Display resolved invocation fields without repeating the worker's goal.
 *
 * Both model forms come back so each surface can pick by width; the
 * "(asked X)" annotation is applied here rather than by callers, so a value the
 * spawn did not honor cannot be rendered as though it had been (#182).
 */
export function buildInvocationTags(
  invocation: AgentInvocation | undefined,
): { modelName?: string; modelId?: string; tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  const asked = (value: string | undefined, requested: string | undefined): string | undefined =>
    value && requested && requested !== value ? `${value} (asked ${requested})` : value;
  const thinking = asked(invocation.thinking, invocation.requestedThinking);
  if (thinking) tags.push(`thinking: ${thinking}`);
  if (invocation.isolated) tags.push("isolated");
  if (invocation.isolation === "worktree") tags.push("worktree");
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  return {
    modelName: asked(invocation.modelName, invocation.requestedModel),
    modelId: asked(invocation.modelId, invocation.requestedModel),
    tags,
  };
}

/** Color invocation fields independently; callers keep metrics and separators dim. */
export function colorInvocationSections(theme: Theme, modelName: string | undefined, tags: string[]): string[] {
  return [
    ...(modelName ? [theme.fg("syntaxVariable", modelName)] : []),
    ...tags.map(tag => theme.fg(tag.startsWith("thinking: ") ? "thinkingMedium" : "dim", tag)),
  ];
}

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  // Scan only through the first nonblank line, never allocate every response
  // line just to show its opening words on each animation frame.
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(start, end).trim();
    if (line) return line.length <= len ? line : line.slice(0, len) + "…";
    start = end + 1;
  }
  return "";
}

/** Build a human-readable activity string from currently-running tools or response text. */
export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  // No tools active — show truncated response text if available
  if (responseText) {
    const preview = truncateLine(responseText);
    if (preview) return preview;
  }

  return "thinking…";
}

// ---- Widget manager ----

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
  private finishedTurnAge = new Map<string, number>();
  /** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
  private static readonly ERROR_LINGER_TURNS = 2;

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: any | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Selects which agents the widget shows — see
     * `WidgetMode`. Defaults to `"all"` when a caller supplies no policy; the
     * extension supplies one defaulting to `"background"`.
     */
    private mode: () => WidgetMode = () => "all",
    /**
     * Read live at render time, like `mode`. Whether running agents show an
     * estimated cost beside their token count. Defaults to off — the extension
     * supplies the user's `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /**
     * Read live at render time, like `mode`. Whether running agents name the
     * model driving them and the thinking level it is running at. Defaults to
     * off — the extension supplies the user's `showModel` setting — because the
     * same pair is on the tool result and in the
     * conversation viewer unconditionally.
     */
    private showModel: () => boolean = () => false,
    /** Opt-in field colors, read live so a settings change needs no restart. */
    private sectionColors: () => boolean = () => false,
  ) {}

  /**
   * Agents eligible for the widget, per the current `WidgetMode`:
   *   - `off`: none (the widget's existing empty-state path hides it entirely).
   *   - `background`: drop only agents *known* to be foreground
   *     (`isBackground === false`); keep everything else — background, queued,
   *     or RPC-spawned (`undefined`). Keying off the `isBackground`
   *     record flag rather than the UI-only `invocation` snapshot (which only the
   *     Agent-tool path sets), and excluding rather than allow-listing, means
   *     only proven-foreground runs drop out — nothing else silently vanishes.
   *   - `all`: every agent.
   */
  private widgetAgents(all = this.manager.listAgents()) {
    switch (this.mode()) {
      case "off": return [];
      case "background": return all.filter(a => a.isBackground !== false);
      default: return all;
    }
  }

  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      // UICtx changed — the widget registered on the old context is gone.
      // Force re-registration on next update().
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  /**
   * Called on each new turn (tool_execution_start).
   * Ages finished agents and clears those that have lingered long enough.
   */
  onTurnStart() {
    // Age all finished agents
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    // Trigger a widget refresh (will filter out expired agents)
    this.update();
  }

  /** Animate only when a visible running row has a spinner. Queues are static. */
  ensureTimer() {
    this.setAnimating(!!this.uiCtx && this.widgetAgents().some(a => a.status === "running"));
  }

  private setAnimating(animate: boolean) {
    if (animate && !this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 80);
    } else if (!animate && this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
  }

  /** Check if a finished agent should still be shown in the widget. */
  private shouldShowFinished(agentId: string, status: string): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
    return age < maxAge;
  }

  /** Record an agent as finished (call when agent completes). */
  markFinished(agentId: string) {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
  }

  /**
   * Drop an agent's finished-age (call when a settled agent starts running
   * again, i.e. a background resume). markFinished only seeds an age it has not
   * seen before, so a resumed agent would otherwise keep the age from its
   * previous run — already past the linger limit, hiding the new run's
   * completion line entirely.
   */
  markRunning(agentId: string) {
    this.finishedTurnAge.delete(agentId);
  }

  /** Render a finished agent line. */
  private renderFinishedLine(a: AgentRecord, theme: Theme): string {
    const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);

    let icon: string;
    let statusText: string;
    if (a.status === "completed") {
      icon = theme.fg("success", "✓");
      statusText = "";
    } else if (a.status === "steered") {
      icon = theme.fg("warning", "✓");
      statusText = theme.fg("warning", " (turn limit)");
    } else if (a.status === "stopped") {
      icon = theme.fg("dim", "■");
      statusText = theme.fg("dim", " stopped");
    } else if (a.status === "error") {
      icon = theme.fg("error", "✗");
      const errMsg = a.error ? `: ${a.error.slice(0, 60)}` : "";
      statusText = theme.fg("error", ` error${errMsg}`);
    } else {
      // aborted
      icon = theme.fg("error", "✗");
      statusText = theme.fg("warning", " aborted");
    }

    const parts: string[] = [];
    const activity = this.agentActivity.get(a.id);
    if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    // From the record, not the activity tracker: that entry is deleted the
    // moment an agent finishes, and "what did it cost" is a question asked
    // about finished agents.
    const costText = this.showCost() ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";
    if (costText) parts.push(costText);
    parts.push(duration);

    return `${icon} ${renderAgentName(a.description, theme, { fallbackColor: this.sectionColors() ? "text" : "dim" })} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusText}`;
  }

  /**
   * Render the widget content. Called from the registered widget's render() callback,
   * reading live state each time instead of capturing it in a closure.
   */
  private renderWidget(tui: any, theme: Theme): string[] {
    const allAgents = this.widgetAgents();
    const running = allAgents.filter(a => a.status === "running");
    const queued = allAgents.filter(a => a.status === "queued");
    const finished = allAgents.filter(a =>
      a.status !== "running" && a.status !== "queued" && a.completedAt
      && this.shouldShowFinished(a.id, a.status),
    );

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    // Nothing to show — return empty (widget will be unregistered by update())
    if (!hasActive && !hasFinished) return [];

    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    // Build sections separately for overflow-aware assembly.
    // Each running agent = 2 lines (header + activity), finished = 1 line, queued = 1 line.

    // Allocate the line budget before context reads, activity previews, theme
    // painting or width measurement. Hidden rows need only status/count data.
    const maxBody = MAX_WIDGET_LINES - 1;
    const queuedReserve = queued.length > 0 ? 1 : 0;
    const totalBody = finished.length + running.length * 2 + queuedReserve;
    const overflow = totalBody > maxBody;
    let budget = maxBody - (overflow ? 1 : 0) - queuedReserve;
    const visibleRunning = Math.min(running.length, Math.floor(budget / 2));
    budget -= visibleRunning * 2;
    const visibleFinished = Math.min(finished.length, budget);
    const hiddenRunning = running.length - visibleRunning;
    const hiddenFinished = finished.length - visibleFinished;

    const finishedLines: string[] = [];
    for (const a of finished.slice(0, visibleFinished)) {
      finishedLines.push(truncate(theme.fg("dim", "├─") + " " + this.renderFinishedLine(a, theme)));
    }

    const runningLines: string[][] = []; // each entry is [header, activity]
    for (const a of running.slice(0, visibleRunning)) {
      const elapsed = formatMs(Date.now() - a.startedAt);

      const bg = this.agentActivity.get(a.id);
      // Spend comes from the record, never from the activity tracker, so the
      // same lifetime total remains visible while running and after completion.
      const tokens = getLifetimeTotal(a.lifetimeUsage);
      const contextPercent = tokens > 0 ? getSessionContextPercent(bg?.session) : null;
      const tokenText = tokens > 0 ? formatSessionTokens(tokens, contextPercent, theme, a.compactionCount) : "";
      const costText = this.showCost() ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";

      const parts: string[] = [];
      if (this.showModel()) {
        // Leading, and paired: a thinking level means nothing without the model
        // it applies to. The tag is taken from buildInvocationTags rather than
        // rebuilt so the "(asked X)" annotation survives.
        const { modelName, tags } = buildInvocationTags(a.invocation);
        const thinkingTag = tags.find(tag => tag.startsWith("thinking: "));
        if (this.sectionColors()) {
          parts.push(...colorInvocationSections(theme, modelName, thinkingTag ? [thinkingTag] : []));
        } else {
          if (modelName) parts.push(modelName);
          if (thinkingTag) parts.push(thinkingTag);
        }
      }
      if (bg) parts.push(formatTurns(bg.turnCount, bg.maxTurns));
      if (tokenText) parts.push(tokenText);
      if (costText) parts.push(costText);
      parts.push(elapsed);
      const statsText = parts.join(" · ");

      const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";

      runningLines.push([
        truncate(theme.fg("dim", "├─") + ` ${theme.fg("accent", frame)} ${renderAgentName(a.description, theme, { bold: true, fallbackColor: this.sectionColors() ? "text" : "muted" })} ${theme.fg("dim", "·")} ${fgPreservingNestedStyles(theme, "dim", statsText)}`),
        truncate(theme.fg("dim", "│ ") + theme.fg("dim", ` ⎿ ${activity}`)),
      ]);
    }

    const queuedLine = queued.length > 0
      ? truncate(theme.fg("dim", "├─") + ` ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`)
      : undefined;

    const lines: string[] = [truncate(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents"))];

    if (!overflow) {
      // Everything fits — add all lines and fix up connectors for the last item.
      lines.push(...finishedLines);
      for (const pair of runningLines) lines.push(...pair);
      if (queuedLine) lines.push(queuedLine);

      // Fix last connector: swap ├─ → └─ and │ → space for activity lines.
      if (lines.length > 1) {
        const last = lines.length - 1;
        lines[last] = lines[last].replace("├─", "└─");
        // If last item is a running agent activity line, fix indent of that line
        // and fix the header line above it.
        if (runningLines.length > 0 && !queuedLine) {
          // The last two lines are the last running agent's header + activity.
          if (last >= 2) {
            lines[last - 1] = lines[last - 1].replace("├─", "└─");
            lines[last] = lines[last].replace("│ ", "  ");
          }
        }
      }
    } else {
      // Overflow — prioritize running > queued > finished, preserving the
      // queue summary separately from the count of hidden individual agents.
      for (const pair of runningLines) lines.push(...pair);
      if (queuedLine) lines.push(queuedLine);
      lines.push(...finishedLines);

      // Overflow summary
      const overflowParts: string[] = [];
      if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`);
      if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
      const overflowText = overflowParts.join(", ");
      lines.push(truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowText})`)}`)
      );
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    const records = this.manager.listAgents();
    const retainedIds = new Set(records.map(a => a.id));
    for (const id of this.finishedTurnAge.keys()) {
      if (!retainedIds.has(id)) this.finishedTurnAge.delete(id);
    }
    if (!this.uiCtx) return;
    const allAgents = this.widgetAgents(records);

    // Lightweight existence checks — full categorization happens in renderWidget()
    let runningCount = 0;
    let queuedCount = 0;
    let hasFinished = false;
    for (const a of allAgents) {
      if (a.status === "running") { runningCount++; }
      else if (a.status === "queued") { queuedCount++; }
      else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) { hasFinished = true; }
    }
    const hasActive = runningCount > 0 || queuedCount > 0;
    this.setAnimating(runningCount > 0);

    // Nothing to show — clear widget
    if (!hasActive && !hasFinished) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("agents", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.lastStatusText !== undefined) {
        this.uiCtx.setStatus("subagents", undefined);
        this.lastStatusText = undefined;
      }
      if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
      return;
    }

    // Status bar — only call setStatus when the text actually changes
    let newStatusText: string | undefined;
    if (hasActive) {
      const statusParts: string[] = [];
      if (runningCount > 0) statusParts.push(`${runningCount} running`);
      if (queuedCount > 0) statusParts.push(`${queuedCount} queued`);
      const total = runningCount + queuedCount;
      newStatusText = `${statusParts.join(", ")} agent${total === 1 ? "" : "s"}`;
    }
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    this.widgetFrame++;

    // Register widget callback once; subsequent updates use requestRender()
    // which re-invokes render() without replacing the component (avoids layout thrashing).
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("agents", (tui, theme) => {
        this.tui = tui;
        return {
          render: () => this.renderWidget(tui, theme),
          invalidate: () => {
            // Settled widgets have no animation tick to pick up a fresh theme.
            // Re-register on explicit invalidation as well as lifecycle updates.
            this.widgetRegistered = false;
            this.tui = undefined;
            this.update();
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else {
      // Widget already registered — just request a re-render of existing components.
      this.tui?.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("agents", undefined);
      this.uiCtx.setStatus("subagents", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
