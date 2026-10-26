// Global defaults: <agentDir>/subagents.json. Project overrides: <cwd>/.pi/subagents.json.
// Only project settings are written by the extension.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ViewerMarkdownMode, WidgetMode } from "./types.js";

export type ToolDescriptionMode = "full" | "compact" | "custom";

export interface SubagentsSettings {
  maxConcurrent?: number;
  /** Independent blocking-spawn pool; 0 means unlimited. */
  maxConcurrentForeground?: number;
  /** 0 means unlimited. */
  defaultMaxTurns?: number;
  graceTurns?: number;
  backgroundByDefault?: boolean;
  scopeModels?: boolean;
  toolDescriptionMode?: ToolDescriptionMode;
  fleetView?: boolean;
  /** Persist child sessions, independently of temporary output transcripts. */
  rememberAgents?: boolean;
  widgetMode?: WidgetMode;
  outputTranscript?: boolean;
  worktreeIsolation?: boolean;
  reportUsage?: boolean;
  showCost?: boolean;
  showModel?: boolean;
  /** Theme-colored goal, model and thinking sections. Applied live. */
  sectionColors?: boolean;
  viewerMarkdown?: ViewerMarkdownMode;
}

export interface SettingsAppliers {
  setMaxConcurrent: (n: number) => void;
  setMaxConcurrentForeground: (n: number) => void;
  setDefaultMaxTurns: (n: number) => void;
  setGraceTurns: (n: number) => void;
  setBackgroundByDefault: (b: boolean) => void;
  setScopeModels: (b: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setFleetView: (b: boolean) => void;
  setRememberAgents: (b: boolean) => void;
  setWidgetMode: (mode: WidgetMode) => void;
  setOutputTranscript: (b: boolean) => void;
  setWorktreeIsolation: (b: boolean) => void;
  setReportUsage: (b: boolean) => void;
  setShowCost: (b: boolean) => void;
  setShowModel: (b: boolean) => void;
  setSectionColors: (b: boolean) => void;
  setViewerMarkdown: (mode: ViewerMarkdownMode) => void;
}

export type SettingsEmit = (event: string, payload: unknown) => void;

const VALID_TOOL_DESCRIPTION_MODES: ReadonlySet<string> = new Set<ToolDescriptionMode>(["full", "compact", "custom"]);
const VALID_WIDGET_MODES: ReadonlySet<string> = new Set<WidgetMode>(["all", "background", "off"]);
const VALID_VIEWER_MARKDOWN_MODES: ReadonlySet<string> = new Set<ViewerMarkdownMode>(["off", "assistant", "all"]);

/** Unknown and invalid fields are ignored; removed systems cannot be re-enabled. */
function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  for (const [key, min, max] of [
    ["maxConcurrent", 1, 1024],
    ["maxConcurrentForeground", 0, 1024],
    ["defaultMaxTurns", 0, 10_000],
    ["graceTurns", 1, 1_000],
  ] as const) {
    const value = input[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) out[key] = value;
  }
  for (const key of [
    "backgroundByDefault", "scopeModels", "fleetView", "rememberAgents", "outputTranscript",
    "worktreeIsolation", "reportUsage", "showCost", "showModel", "sectionColors",
  ] as const) {
    const value = input[key];
    if (typeof value === "boolean") out[key] = value;
  }
  if (typeof input.toolDescriptionMode === "string" && VALID_TOOL_DESCRIPTION_MODES.has(input.toolDescriptionMode)) out.toolDescriptionMode = input.toolDescriptionMode as ToolDescriptionMode;
  if (typeof input.widgetMode === "string" && VALID_WIDGET_MODES.has(input.widgetMode)) out.widgetMode = input.widgetMode as WidgetMode;
  if (typeof input.viewerMarkdown === "string" && VALID_VIEWER_MARKDOWN_MODES.has(input.viewerMarkdown)) out.viewerMarkdown = input.viewerMarkdown as ViewerMarkdownMode;
  return out;
}

function readSettingsFile(path: string): SubagentsSettings {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch (error) {
    console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  return {
    ...readSettingsFile(join(getAgentDir(), "subagents.json")),
    ...readSettingsFile(join(cwd, ".pi", "subagents.json")),
  };
}

/** Save project-local settings only; report failures rather than claiming persistence. */
export function saveSettings(settings: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = join(cwd, ".pi", "subagents.json");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(sanitize(settings), null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

export function applySettings(s: SubagentsSettings, a: SettingsAppliers): void {
  if (typeof s.maxConcurrent === "number") a.setMaxConcurrent(s.maxConcurrent);
  if (typeof s.maxConcurrentForeground === "number") a.setMaxConcurrentForeground(s.maxConcurrentForeground);
  if (typeof s.defaultMaxTurns === "number") a.setDefaultMaxTurns(s.defaultMaxTurns);
  if (typeof s.graceTurns === "number") a.setGraceTurns(s.graceTurns);
  if (typeof s.backgroundByDefault === "boolean") a.setBackgroundByDefault(s.backgroundByDefault);
  if (typeof s.scopeModels === "boolean") a.setScopeModels(s.scopeModels);
  if (s.toolDescriptionMode) a.setToolDescriptionMode(s.toolDescriptionMode);
  if (typeof s.fleetView === "boolean") a.setFleetView(s.fleetView);
  if (typeof s.rememberAgents === "boolean") a.setRememberAgents(s.rememberAgents);
  if (s.widgetMode) a.setWidgetMode(s.widgetMode);
  if (typeof s.outputTranscript === "boolean") a.setOutputTranscript(s.outputTranscript);
  if (typeof s.worktreeIsolation === "boolean") a.setWorktreeIsolation(s.worktreeIsolation);
  if (typeof s.reportUsage === "boolean") a.setReportUsage(s.reportUsage);
  if (typeof s.showCost === "boolean") a.setShowCost(s.showCost);
  if (typeof s.showModel === "boolean") a.setShowModel(s.showModel);
  if (typeof s.sectionColors === "boolean") a.setSectionColors(s.sectionColors);
  if (s.viewerMarkdown) a.setViewerMarkdown(s.viewerMarkdown);
}

export function persistToastFor(successMsg: string, persisted: boolean): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}

export function applyAndEmitLoaded(appliers: SettingsAppliers, emit: SettingsEmit, cwd: string = process.cwd()): SubagentsSettings {
  const settings = loadSettings(cwd);
  applySettings(settings, appliers);
  emit("subagents:settings_loaded", { settings });
  return settings;
}

export function saveAndEmitChanged(snapshot: SubagentsSettings, successMsg: string, emit: SettingsEmit, cwd: string = process.cwd()): { message: string; level: "info" | "warning" } {
  const persisted = saveSettings(snapshot, cwd);
  emit("subagents:settings_changed", { settings: snapshot, persisted });
  return persistToastFor(successMsg, persisted);
}
