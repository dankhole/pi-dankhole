import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, type ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens, hasNerdFonts } from "../../vendor/powerline/footer-helpers.ts";
import { installInputBar } from "./input-bar.ts";
import { paint } from "./palette.ts";

type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
type Entries = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;
type CompactionState = { enabled: false } | { enabled: true; reserveTokens: number };

/** Text from sessions/extensions is data, not terminal instructions. Theme it after sanitizing. */
function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/ +/g, " ").trim();
}

/** Same cumulative sources as Pi's native footer, including billed errors/aborts. */
function sessionTotals(entries: Entries) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    const usage = entry.type === "usage" ? entry.usage
      : entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") ? entry.message.usage
      : entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined;
    if (!usage) continue;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost.total;
  }
  return totals;
}

function subscription(ctx: ExtensionContext): boolean {
  if (!ctx.model) return false;
  if (ctx.model.provider === "kimi-coding") return true;
  return ctx.modelRegistry.isUsingOAuth(ctx.model)
    && ctx.modelRegistry.getProvider(ctx.model.provider)?.auth.oauth?.isSubscription === true;
}

/** Compact input/footer composition inspired by jwu/pi-powerline; provenance in vendor/powerline. */
export function registerStatusLine(pi: ExtensionAPI, enabled: boolean, keepAwake = false, compactionNoticePercent = 20): void {
  if (!enabled) return;

  let context: ExtensionContext | undefined;
  let refresh: (() => void) | undefined;
  let clearFooter: (() => void) | undefined;
  let clearEditor: (() => void) | undefined;
  let thinking: string = "off";
  const stop = () => {
    clearEditor?.();
    clearEditor = undefined;
    clearFooter?.();
    clearFooter = undefined;
    refresh = undefined;
    context = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui?.setFooter !== "function") return;
    context = ctx;
    thinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
    let renderStats = (_width: number): string => "";
    const inputBar = installInputBar(ctx, () => context ?? ctx, () => thinking, width => renderStats(width), keepAwake);
    clearEditor = inputBar?.dispose;
    // Tracks ownership so shutdown cannot clear a footer installed later by another extension.
    let disposed = false;
    let disposeComponent: (() => void) | undefined;
    const factory: FooterFactory = (tui, theme, footerData) => {
      const repaint = () => { if (!disposed) tui.requestRender(); };
      refresh = repaint;
      const unsubscribe = footerData.onBranchChange(repaint);
      let cached: { manager: ExtensionContext["sessionManager"]; session: string; leaf: string | null; totals: ReturnType<typeof sessionTotals> } | undefined;
      let cachedDestination: {
        manager: ExtensionContext["sessionManager"]; session: string; leaf: string | null; destination?: string;
      } | undefined;
      let cachedCompaction: {
        key: string; provider: string | undefined; modelId: string | undefined;
        settings: CompactionState | undefined;
      } | undefined;
      // Pi 1.4 exposes merged, live settings publicly. Let its in-memory resolver
      // apply defaults, exact per-model overrides and validation; never read files.
      const compactionSettings = (model: ExtensionContext["model"]) => {
        try {
          const snapshot = pi.getSettings();
          if (!snapshot || typeof snapshot !== "object") return undefined;
          const compaction = snapshot.compaction;
          const key = JSON.stringify(compaction) ?? "";
          if (!cachedCompaction || cachedCompaction.key !== key
            || cachedCompaction.provider !== model?.provider || cachedCompaction.modelId !== model?.id) {
            let settings: CompactionState | undefined;
            try {
              const manager = SettingsManager.inMemory({ compaction });
              // Disabled auto-compaction is still known even if a token setting is invalid.
              if (manager.getCompactionEnabled() === false) {
                settings = { enabled: false };
              } else {
                const resolved = manager.getCompactionSettings(model);
                if (resolved.enabled === true) settings = { enabled: true, reserveTokens: resolved.reserveTokens };
              }
            } catch { /* Invalid settings cannot support a trustworthy threshold. */ }
            cachedCompaction = { key, provider: model?.provider, modelId: model?.id, settings };
          }
          return cachedCompaction.settings;
        } catch { return undefined; } // Older/missing runtime API: omit progress, not a guess.
      };
      let cachedContext: {
        manager: ExtensionContext["sessionManager"]; session: string; leaf: string | null;
        model: ExtensionContext["model"]; contextWindow: number | undefined;
        usage: ReturnType<ExtensionContext["getContextUsage"]>;
      } | undefined;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        if (refresh === repaint) refresh = undefined;
      };
      disposeComponent = dispose;
      renderStats = (width: number): string => {
        if (disposed || !context || width < 1) return "";
        width = Math.floor(width);
        const current = context;
        const manager = current.sessionManager;
        // Public session entries are append-only; every append moves the leaf.
        const session = manager.getSessionId();
        const leaf = manager.getLeafId();
        if (!cached || cached.manager !== manager || cached.session !== session || cached.leaf !== leaf) {
          cached = { manager, session, leaf, totals: sessionTotals(manager.getEntries()) };
        }
        // getContextUsage rebuilds Pi's session projection. Cache even unknown/absent
        // results, but recheck after history/model changes or an in-place limit update.
        const model = current.model;
        const contextWindow = model?.contextWindow;
        if (!cachedContext || cachedContext.manager !== manager || cachedContext.session !== session
          || cachedContext.leaf !== leaf || cachedContext.model !== model || cachedContext.contextWindow !== contextWindow) {
          cachedContext = { manager, session, leaf, model, contextWindow, usage: current.getContextUsage() };
        }
        const totals = cached.totals;
        const plain = process.env.TERM === "dumb" || process.env.NO_COLOR !== undefined;
        const nerd = !plain && hasNerdFonts();
        const fg = (color: Parameters<typeof theme.fg>[0], text: string) => plain ? text : theme.fg(color, text);
        const branch = footerData.getGitBranch();
        const usage = cachedContext.usage;
        const window = usage?.contextWindow ?? current.model?.contextWindow;
        const limit = window != null && Number.isFinite(window) && window > 0 ? window : undefined;
        const tokens = usage?.tokens != null && Number.isFinite(usage.tokens) && usage.tokens >= 0 ? usage.tokens : undefined;
        const percent = tokens != null && limit != null ? tokens / limit * 100 : undefined;
        const contextText = `${tokens == null ? "?" : formatTokens(tokens)}/${limit == null ? "?" : formatTokens(limit)}`;
        const compaction = compactionSettings(model);
        // Same strict trigger as Pi: tokens > contextWindow - reserveTokens.
        // keepRecentTokens is the retained recent tail, NOT the trigger budget.
        const threshold = limit != null && compaction?.enabled ? limit - compaction.reserveTokens : undefined;
        // Multiply before dividing so exact integer percentages (e.g. 7%) stay exact.
        const compactRemaining = compaction?.enabled && tokens != null && threshold != null && Number.isFinite(threshold) && threshold > 0
          ? Math.max(0, (threshold - tokens) * 100 / threshold) : undefined;
        const segments: { text: string; priority: number; clip?: boolean }[] = [];
        const add = (text: string, priority: number, clip = false) => segments.push({ text, priority, clip });
        if (branch) add(fg("success", `${nerd ? "" : plain ? "git" : "⎇"} ${clean(branch)}`), 80, true);
        add((percent ?? 0) > 90 ? fg("error", contextText) : (percent ?? 0) > 70 ? fg("warning", contextText) : paint(theme, "context", contextText), 85);
        if (compaction?.enabled === false) add(fg("dim", "auto off"), 84);
        else if (compactRemaining != null && compactRemaining <= compactionNoticePercent) {
          // Gate on the raw countdown; ceil keeps 0% exclusive to exhausted budgets.
          const text = `${Math.ceil(compactRemaining)}% to compact`;
          add(compactRemaining < 10 ? fg("error", text) : compactRemaining < 30 ? fg("warning", text) : paint(theme, "context", text), 84);
        }
        if (totals.input) add(paint(theme, "input", `${plain ? "in:" : "↑"}${formatTokens(totals.input)}`), 50);
        if (totals.output) add(paint(theme, "output", `${plain ? "out:" : "↓"}${formatTokens(totals.output)}`), 50);
        const sub = subscription(current);
        if (totals.cost || sub) add(paint(theme, "cost", `${sub ? "~" : ""}$${totals.cost.toFixed(0)}`), 60);
        // Virtual selections name the router; successful branch responses name the destination.
        if (current.model?.api === "pi-virtual") {
          if (!cachedDestination || cachedDestination.manager !== manager || cachedDestination.session !== session || cachedDestination.leaf !== leaf) {
            cachedDestination = { manager, session, leaf };
            const branchEntries = manager.getBranch();
            for (let i = branchEntries.length - 1; i >= 0; i--) {
              const entry = branchEntries[i];
              if (entry.type === "message" && entry.message.role === "assistant"
                && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted") {
                cachedDestination.destination = `${entry.message.provider}/${entry.message.model}`;
                break;
              }
            }
          }
          if (cachedDestination.destination !== undefined) {
            add(fg("dim", `${plain ? "->" : "→"} ${clean(cachedDestination.destination)}`), 10, true);
          }
        }
        const statuses = footerData.getExtensionStatuses();
        for (const [key, value] of [...statuses].sort(([a], [b]) => a.localeCompare(b))) {
          if (key === "subagents" || key === "mcp") continue;
          const status = clean(value);
          const timer = key === "compact-tools:chat-timer";
          if (status) add(timer ? paint(theme, "elapsed", status) : fg("dim", status), timer ? 100 : 95, true);
        }
        // One row at every width. Prefer published statuses over secondary counters;
        // retain full text whenever everything fits, otherwise bound long individual fields.
        const budget = width;
        const fullWidth = segments.reduce((n, segment) => n + visibleWidth(segment.text), 0) + Math.max(0, segments.length - 1);
        const selected = new Map<number, string>();
        let remaining = budget;
        const ranked = segments.map((segment, index) => ({ ...segment, index }))
          .sort((a, b) => b.priority - a.priority || a.index - b.index);
        for (const segment of ranked) {
          const space = selected.size ? 1 : 0;
          const available = remaining - space;
          const cap = fullWidth <= budget || !segment.clip ? available : Math.min(available, Math.max(12, Math.floor(width / 3)));
          const size = visibleWidth(segment.text);
          if (size > cap && (!segment.clip || cap < 4)) continue;
          const value = size <= cap ? segment.text : truncateToWidth(segment.text, cap, plain ? "..." : "…");
          if (!value || visibleWidth(value) > available) continue;
          selected.set(segment.index, value);
          remaining -= visibleWidth(value) + space;
        }
        return [...selected].sort(([a], [b]) => a - b).map(([, value]) => value).join(" ");
      };
      return {
        dispose,
        invalidate() { cached = undefined; cachedContext = undefined; cachedCompaction = undefined; cachedDestination = undefined; },
        render(width) {
          // The public footer still supplies branch/status data. Only paint a
          // separate row if our editor cannot own the input's top border.
          if (inputBar?.isActive() || disposed || width < 1) return [];
          const stats = renderStats(width);
          return [stats + " ".repeat(Math.max(0, Math.floor(width) - visibleWidth(stats)))];
        },
      };
    };
    clearFooter = () => {
      if (disposed) return;
      disposeComponent?.();
      ctx.ui.setFooter(undefined);
      disposed = true;
    };
    ctx.ui.setFooter(factory);
  });

  pi.on("model_select", (_event, ctx) => {
    if (!context) return;
    context = ctx;
    thinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
    refresh?.();
  });
  pi.on("thinking_level_select", event => { thinking = event.level; refresh?.(); });
  // Data remains native/persisted: streaming usage is not added a second time or used to guess context.
  pi.on("message_end", () => { refresh?.(); });
  pi.on("session_tree", () => { refresh?.(); });
  pi.on("session_compact", () => { refresh?.(); });
  pi.on("session_shutdown", stop);
}
