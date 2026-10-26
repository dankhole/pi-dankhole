import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionAPI,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { QUESTION_TOOL_NAME, registerQuestions } from "../questions/questions.ts";
import { registerKeepAwake } from "../session/keep-awake.ts";
import { defaults, loadSettings, registerSettings, type Settings } from "../settings/interface.ts";
import { registerAssistantPanels } from "./assistant-panels.ts";
import { registerGrouping } from "./grouping.ts";
import { toolBackground, toolChromeText, toolStatus, toolStatusText } from "./palette.ts";
import { registerPinnedPrompt } from "./pinned-prompt.ts";
import { registerStatusLine } from "./status-line.ts";
import { registerTextPanels } from "./text-panels.ts";
import { registerThinkingCollapse } from "./thinking-collapse.ts";
import { registerTimer } from "./timer.ts";

type BaseContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type ToolRenderContext<T> = Omit<BaseContext, "state"> & { state: T };

// Existing tool execution is unchanged; ask_user owns its separate interactive renderer.
interface RowState {
  nativeState?: Record<string, unknown>;
  nativeCall?: Component;
  nativeResult?: Component;
}

const empty: Component = { render: () => [], invalidate() {} };
type Theme = Parameters<NonNullable<ToolRenderers["renderCall"]>>[1];

function panel(component: Component, tool: string, theme: Theme, context: ToolRenderContext<RowState>, mode: Settings["backgrounds"]): Component {
  if (component === empty) return component;
  const ansi = toolBackground(theme, tool, mode, toolStatus(context.isError, context.isPartial));
  if (!ansi) return component;
  const box = new Box(0, 0, text => {
    // Replace native tool-panel backgrounds, but retain diff/syntax highlights and foregrounds.
    for (const token of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const) {
      const native = theme.getBgAnsi(token);
      if (native) text = text.replaceAll(native, ansi);
    }
    text = text.replaceAll("\x1b[0m", `\x1b[0m${ansi}`).replaceAll("\x1b[49m", ansi);
    return `${ansi}${text}\x1b[49m`;
  });
  box.addChild(component);
  return box;
}

function clean(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function oneLine(value: unknown): string {
  return typeof value === "string" ? clean(value).replace(/\s+/g, " ").trim() : "";
}

function shortPath(value: string, cwd: string): string {
  if (isAbsolute(value)) {
    const local = relative(cwd, value);
    if (local && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local)) return local;
    const home = homedir();
    if (value === home || value.startsWith(home + sep)) return `~${value.slice(home.length)}`;
  }
  return value;
}

function summary(tool: string, input: unknown, cwd: string): string {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (tool === "codemode") {
    const code = typeof args.code === "string" ? args.code : typeof args.script === "string" ? args.script : "";
    // A lightweight hint, not a parser or a claim about what actually executed.
    const names = [...new Set([...code.matchAll(/\btools\.([\w$]+)\s*\(/g)].map(match => match[1]))];
    return names.length ? names.slice(0, 4).join(", ") + (names.length > 4 ? ", …" : "") : "script";
  }
  for (const key of ["description", "command", "path", "file_path", "pattern", "query", "url", "agent_id"]) {
    const value = oneLine(args[key]);
    if (value) return key === "path" || key === "file_path" ? shortPath(value, cwd) : value;
  }
  // Avoid dumping arbitrary payloads, prompts, file contents, or edit bodies.
  return Object.keys(args).slice(0, 4).map(oneLine).join(", ");
}

function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function line(body: string, tail: string, padding: number): Component {
  return {
    invalidate() {},
    render(width) {
      if (width <= 0) return [];
      const pad = " ".repeat(Math.min(padding, Math.max(0, width - 1)));
      const available = width - pad.length;
      const tailWidth = visibleWidth(tail);
      // Keep the status/name first on very narrow terminals.
      if (!tail || available < tailWidth + 12) return [pad + truncateToWidth(body, available)];
      return [pad + truncateToWidth(body, available - tailWidth) + tail];
    },
  };
}

function nativeContext(context: ToolRenderContext<RowState>, slot: "nativeCall" | "nativeResult") {
  context.state.nativeState ??= {};
  return {
    ...context,
    state: context.state.nativeState,
    lastComponent: context.state[slot],
  };
}

function fallbackCall(tool: string, args: unknown, padding: number): Component {
  return new Text(`${tool}\n${clean(JSON.stringify(args, null, 2) ?? "")}`, padding, 0);
}

export default function registerInterface(pi: ExtensionAPI) {
  const path = join(getAgentDir(), "compact-tools.json");
  let settings = defaults();
  try {
    settings = loadSettings(path).settings;
  } catch (error) {
    settings.defaultMode = "normal";
    settings.groupConsecutive = false;
    settings.pinLatestPrompt = false;
    settings.showChatTimer = false;
    settings.powerlineStatus = false;
    settings.questionUI = false;
    settings.textBlockPanels = false;
    settings.assistantPanels = false;
    settings.collapseThinking = false;
    settings.keepAwake = false;
    const message = error instanceof Error ? error.message : String(error);
    pi.on("session_start", (_event, ctx) => { ctx.ui.notify(`Compact tools: ${message}`, "error"); });
  }
  registerSettings(pi, path);
  registerGrouping(pi, settings);
  registerPinnedPrompt(pi, settings.pinLatestPrompt, settings.assistantPanels);
  registerTimer(pi, settings.showChatTimer);
  registerStatusLine(pi, settings.powerlineStatus, settings.keepAwake && process.platform === "darwin", settings.compactionNoticePercent);
  registerQuestions(pi, settings.questionUI);
  registerTextPanels(pi, settings.textBlockPanels);
  registerAssistantPanels(pi, settings.assistantPanels);
  registerThinkingCollapse(pi, settings.collapseThinking);
  registerKeepAwake(pi, settings.keepAwake);
  pi.registerToolRenderer((tool, next): ToolRenderers | undefined => {
    const original = next();
    // Questions must remain readable and cannot be hidden by a compact override.
    if (tool === QUESTION_TOOL_NAME) return original;
    const mode = Object.hasOwn(settings.tools, tool) ? settings.tools[tool] : settings.defaultMode;
    if (mode === "normal") return original;
    return {
      renderShell: "self",
      renderCall(args, theme, context: ToolRenderContext<RowState>) {
        // Keep downstream renderer state/components separate from our compact ones.
        // Invoke on every update, even collapsed, to preserve timer cleanup and lifecycle.
        let native: Component | undefined;
        try {
          native = original?.renderCall?.(args, theme, nativeContext(context, "nativeCall"));
        } catch {
          // Bad/partial arguments or an incompatible renderer must not expand the row.
        }
        context.state.nativeCall = native;
        if (context.expanded) return panel(native ?? fallbackCall(tool, args, context.outputPad), tool, theme, context, settings.backgrounds);

        const pending = context.isPartial;
        const icon = context.isError ? "✗" : pending ? (context.executionStarted ? "●" : "·") : "✓";
        const status = toolStatus(context.isError, pending);
        const detail = summary(tool, args, context.cwd);
        const body = toolChromeText(theme, "▸", "dim") + " " + toolStatusText(theme, status, icon) + " " + toolChromeText(theme, oneLine(tool))
          + (detail ? " · " + toolChromeText(theme, detail, "muted") : "");
        const elapsed = duration(context.durationMs);
        return panel(line(body, elapsed ? toolChromeText(theme, ` · ${elapsed}`, "dim") : "", context.outputPad), tool, theme, context, settings.backgrounds);
      },
      renderResult(result, options, theme, context: ToolRenderContext<RowState>) {
        let native: Component | undefined;
        try {
          native = original?.renderResult?.(result, options, theme, nativeContext(context, "nativeResult"));
        } catch {
          // Retain access to raw text if a custom renderer cannot render this result.
        }
        context.state.nativeResult = native;
        if (options.expanded) {
          if (native) return panel(native, tool, theme, context, settings.backgrounds);
          const output = result.content.map(block => block.type === "text" ? clean(block.text)
            : `[image: ${block.mimeType}]`).join("\n");
          return output ? panel(new Text(output, context.outputPad, 0), tool, theme, context, settings.backgrounds) : empty;
        }
        if (context.isError && settings.errorPreview) {
          const firstText = result.content.find(block => block.type === "text" && block.text.trim());
          const message = firstText?.type === "text" ? oneLine(firstText.text) : "Tool failed; expand for details";
          return panel(line(toolStatusText(theme, "error", `  ${message}`), "", context.outputPad), tool, theme, context, settings.backgrounds);
        }
        return empty;
      },
    };
  });
}
