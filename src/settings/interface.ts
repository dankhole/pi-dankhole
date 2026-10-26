import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

export type Mode = "compact" | "normal";
export interface Settings {
  defaultMode: Mode;
  errorPreview: boolean;
  groupConsecutive: boolean;
  pinLatestPrompt: boolean;
  showChatTimer: boolean;
  powerlineStatus: boolean;
  compactionNoticePercent: number;
  questionUI: boolean;
  textBlockPanels: boolean;
  assistantPanels: boolean;
  collapseThinking: boolean;
  keepAwake: boolean;
  backgrounds: "tool" | "status" | "none";
  tools: Record<string, Mode>;
}
export const defaults = (): Settings => ({ defaultMode: "compact", errorPreview: false, groupConsecutive: true, pinLatestPrompt: true, showChatTimer: true, powerlineStatus: true, compactionNoticePercent: 20, questionUI: true, textBlockPanels: true, assistantPanels: true, collapseThinking: true, keepAwake: false, backgrounds: "tool", tools: {} });
const isMode = (value: unknown): value is Mode => value === "compact" || value === "normal";

export function loadSettings(path: string): { settings: Settings; raw: string | undefined } {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (raw === undefined) return { settings: defaults(), raw };
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value.defaultMode !== undefined && !isMode(value.defaultMode))
    || (value.errorPreview !== undefined && typeof value.errorPreview !== "boolean")
    || (value.groupConsecutive !== undefined && typeof value.groupConsecutive !== "boolean")
    || (value.pinLatestPrompt !== undefined && typeof value.pinLatestPrompt !== "boolean")
    || (value.showChatTimer !== undefined && typeof value.showChatTimer !== "boolean")
    || (value.powerlineStatus !== undefined && typeof value.powerlineStatus !== "boolean")
    || (value.compactionNoticePercent !== undefined && (!Number.isInteger(value.compactionNoticePercent)
      || value.compactionNoticePercent < 0 || value.compactionNoticePercent > 100))
    || (value.questionUI !== undefined && typeof value.questionUI !== "boolean")
    || (value.textBlockPanels !== undefined && typeof value.textBlockPanels !== "boolean")
    || (value.assistantPanels !== undefined && typeof value.assistantPanels !== "boolean")
    || (value.collapseThinking !== undefined && typeof value.collapseThinking !== "boolean")
    || (value.keepAwake !== undefined && typeof value.keepAwake !== "boolean")
    || (value.backgrounds !== undefined && !["tool", "status", "none"].includes(value.backgrounds))
    || (value.tools !== undefined && (!value.tools || typeof value.tools !== "object"
      || Array.isArray(value.tools) || Object.values(value.tools).some(mode => !isMode(mode))))) {
    throw new Error(`Invalid compact-tools settings: ${path}`);
  }
  return { settings: { ...defaults(), ...value, tools: { ...value.tools } }, raw };
}

export function saveSettings(path: string, settings: Settings, expected: string | undefined): void {
  mkdirSync(dirname(path), { recursive: true });
  // Serialize writers across Pi sessions and refuse to overwrite a concurrent edit.
  const lock = `${path}.lock`;
  writeFileSync(lock, "", { flag: "wx", mode: 0o600 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (current !== expected) throw new Error("Settings changed in another session; reopen /compact-tools and retry.");
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { force: true });
  }
}

export function registerSettings(pi: ExtensionAPI, path: string) {
  pi.registerCommand("compact-tools", {
    description: "Configure compact tools, grouping, pinned input, elapsed time, status line, and questions",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`Edit ${path} to configure compact tool rendering.`, "info");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Open /compact-tools when the agent is idle.", "warning");
        return;
      }
      try {
        const { settings, raw } = loadSettings(path);
        const initial = JSON.stringify(settings);
        const names = [...new Set([
          "read", "bash", "edit", "write", "codemode",
          ...pi.getAllTools().map(tool => tool.name), ...Object.keys(settings.tools),
        ])].sort();
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          const listTheme = getSettingsListTheme();
          const mainHeading = theme.fg("accent", "Compact tools")
            + "\nCompact rows: click to expand · streaming thinking stays visible";
          const heading = new Text(mainHeading, 0, 1);
          const items: SettingItem[] = [
            { id: "keep-awake", label: "Keep awake while working (macOS)", currentValue: settings.keepAwake ? "on" : "off", values: ["on", "off"] },
            { id: "default", label: "Default tool view", currentValue: settings.defaultMode, values: ["compact", "normal"] },
            { id: "grouping", label: "Group consecutive tool calls", currentValue: settings.groupConsecutive ? "on" : "off", values: ["on", "off"] },
            { id: "prompt", label: "Pin latest user input", currentValue: settings.pinLatestPrompt ? "on" : "off", values: ["on", "off"] },
            { id: "timer", label: "Show elapsed time", currentValue: settings.showChatTimer ? "on" : "off", values: ["on", "off"] },
            { id: "status", label: "Powerline input and status", currentValue: settings.powerlineStatus ? "on" : "off", values: ["on", "off"] },
            { id: "compaction-notice", label: "Compaction countdown cutoff", currentValue: `${settings.compactionNoticePercent}%`,
              description: "Show when this percentage or less remains. 0%: at the threshold; 100%: always.",
              values: [...new Set([0, 5, 10, 20, 30, 50, 100, settings.compactionNoticePercent])].sort((a, b) => a - b).map(value => `${value}%`) },
            { id: "questions", label: "Interactive questions", currentValue: settings.questionUI ? "on" : "off", values: ["on", "off"] },
            { id: "text-panels", label: "Plain-text code panels", currentValue: settings.textBlockPanels ? "on" : "off", values: ["on", "off"] },
            { id: "assistant-panels", label: "Conversation panels", currentValue: settings.assistantPanels ? "on" : "off", values: ["on", "off"] },
            { id: "thinking", label: "Collapse finished thinking", currentValue: settings.collapseThinking ? "on" : "off", values: ["on", "off"] },
            { id: "errors", label: "Collapsed error preview", currentValue: settings.errorPreview ? "show" : "hide", values: ["hide", "show"] },
            { id: "backgrounds", label: "Background colors", currentValue: settings.backgrounds, values: ["tool", "status", "none"] },
            {
              id: "per-tool", label: "Per-tool options", currentValue: "open…",
              submenu: (_value, back) => {
                heading.setText(theme.fg("accent", "Per-tool options")
                  + "\nDefault follows Default tool view · edits save when the main menu closes");
                return new SettingsList(names.map(name => ({
                  id: name, label: name,
                  currentValue: Object.hasOwn(settings.tools, name) ? settings.tools[name] : "default",
                  values: ["default", "compact", "normal"],
                })), 15, {
                  ...listTheme,
                  hint: text => listTheme.hint(text.replace("Esc to cancel", "Esc to go back")),
                }, (name, value) => {
                  if (value === "default") delete settings.tools[name];
                  else Object.defineProperty(settings.tools, name, { value, enumerable: true, writable: true, configurable: true });
                }, () => {
                  heading.setText(mainHeading);
                  back();
                }, { enableSearch: true });
              },
            },
          ];
          const list = new SettingsList(items, Math.min(items.length, 15), {
            ...listTheme,
            hint: text => listTheme.hint(text.replace("Enter/Space to change · Esc to cancel",
              "Enter/Space to change or open · Esc to save and close")),
          }, (id, value) => {
            if (id === "default") settings.defaultMode = value as Mode;
            else if (id === "grouping") settings.groupConsecutive = value === "on";
            else if (id === "prompt") settings.pinLatestPrompt = value === "on";
            else if (id === "timer") settings.showChatTimer = value === "on";
            else if (id === "status") settings.powerlineStatus = value === "on";
            else if (id === "compaction-notice") settings.compactionNoticePercent = Number.parseInt(value, 10);
            else if (id === "questions") settings.questionUI = value === "on";
            else if (id === "text-panels") settings.textBlockPanels = value === "on";
            else if (id === "assistant-panels") settings.assistantPanels = value === "on";
            else if (id === "thinking") settings.collapseThinking = value === "on";
            else if (id === "keep-awake") settings.keepAwake = value === "on";
            else if (id === "errors") settings.errorPreview = value === "show";
            else if (id === "backgrounds") settings.backgrounds = value as Settings["backgrounds"];
          }, () => done());
          const container = new Container();
          container.addChild(heading);
          container.addChild(list);
          return {
            render: width => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput(data) { list.handleInput(data); tui.requestRender(); },
          };
        });
        if (JSON.stringify(settings) === initial) return;
        saveSettings(path, settings, raw);
        // Reload rebuilds existing transcript rows and preserves native mouse/keyboard toggles.
        if (ctx.isIdle()) await ctx.reload();
        else ctx.ui.notify("Settings saved. Run /reload when idle to apply them.", "info");
      } catch (error) {
        ctx.ui.notify(`Compact tools: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
