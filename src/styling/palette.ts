import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, parseColor } from "@earendil-works/pi-tui";

// Restrained field colors, darkened on light backgrounds. Native mode/warning
// colors remain owned by Pi rather than this decorative palette.
const colors = {
  light: { model: "#a33b73", folder: "#086d70", rule: "#286b99", thinking: "#7955a6", context: "#7955a6", input: "#286b99", output: "#2b6d2c", cost: "#926719", elapsed: "#086d70" },
  dark: { model: "#d78bb9", folder: "#20b9b2", rule: "#619fd0", thinking: "#b29bd4", context: "#b29bd4", input: "#619fd0", output: "#93b67f", cost: "#c3ab71", elapsed: "#20b9b2" },
};
type Field = keyof typeof colors.dark;
const palette = Object.fromEntries(Object.entries(colors).map(([appearance, fields]) => [
  appearance, Object.fromEntries(Object.entries(fields).map(([field, color]) => [field, parseColor(color)])),
])) as Record<Theme["appearance"], Record<Field, ReturnType<typeof parseColor>>>;

// Conversation identity is separate from the powerline/metrics fields above.
// Tool chrome deliberately excludes blue/green; native code/diff payloads retain
// their own semantic colors. Concrete colors also keep custom theme success
// tokens from turning tool groups back into green conversation-looking panels.
const assistantFills = { dark: parseColor("#181e30"), light: parseColor("#f6f9ff") };
const userFills = { dark: parseColor("#203b2b"), light: parseColor("#f5fff6") };
// Explicit limited-color navy / pale periwinkle keep the assistant blue rather
// than quantizing the very pale light RGB surface to unidentifiable white.
const assistantFills256 = { dark: parseColor(17), light: parseColor(189) };
const userFills256 = { dark: parseColor(22), light: parseColor(194) };
const proseColors256 = {
  dark: { heading: 222, link: 117, linkUrl: 252, quote: 252, quoteBorder: 252, hr: 252, listBullet: 189 },
  light: { heading: 58, link: 24, linkUrl: 237, quote: 237, quoteBorder: 237, hr: 237, listBullet: 53 },
};
export type ConversationTone = keyof typeof proseColors256.dark;
const prose256 = Object.fromEntries(Object.entries(proseColors256).map(([appearance, tones]) => [appearance,
  Object.fromEntries(Object.entries(tones).map(([tone, color]) => [tone, parseColor(color)])),
])) as Record<Theme["appearance"], Record<ConversationTone, ReturnType<typeof parseColor>>>;
const toolFills = {
  dark: ["#43361e", "#39264c", "#4b2820", "#343434", "#3e353c", "#62272f", "#3c362f", "#3b3140"].map(parseColor),
  light: ["#fff9e8", "#fcf7ff", "#fff7f0", "#f8f8f8", "#fbf7fb", "#fff5f7", "#faf7f2", "#f9f7fb"].map(parseColor),
};
// Automatic RGB quantization can brighten dark amber/mauve fills enough to make
// native toolOutput unreadable. Prefer safe neutral substitutes when the limited
// palette has no sufficiently dark/light member of the requested hue family.
const toolFills256 = {
  dark: [235, 53, 52, 236, 237, 234, 235, 236].map(parseColor),
  light: [230, 225, 231, 255, 254, 224, 230, 255].map(parseColor),
};
const toolColors: Record<string, number> = { read: 0, bash: 1, powershell: 1, edit: 2, write: 3, codemode: 4, Agent: 5, grep: 6, find: 7, ls: 0 };
const statusColors = {
  dark: { success: ["#303030", "#c7bba9"], pending: ["#43361e", "#ebc47a"], error: ["#472936", "#f0a6b7"] },
  light: { success: ["#f7f5f2", "#5c5145"], pending: ["#fff9e8", "#704900"], error: ["#fff4f6", "#8a2d4c"] },
};
const statusFills256 = {
  dark: { success: parseColor(236), pending: parseColor(235), error: parseColor(53) },
  light: { success: parseColor(255), pending: parseColor(230), error: parseColor(224) },
};
const chromeColors = {
  dark: { text: parseColor("#e4ded7"), muted: parseColor("#d2c7bb"), dim: parseColor("#bfb2a3") },
  light: { text: parseColor("#352f2a"), muted: parseColor("#62574d"), dim: parseColor("#62574d") },
};
type ToolStatus = keyof typeof statusColors.dark;
const statuses = Object.fromEntries(Object.entries(statusColors).map(([appearance, values]) => [appearance,
  Object.fromEntries(Object.entries(values).map(([status, [bg, fg]]) => [status, { bg: parseColor(bg), fg: parseColor(fg) }])),
])) as Record<Theme["appearance"], Record<ToolStatus, { bg: ReturnType<typeof parseColor>; fg: ReturnType<typeof parseColor> }>>;

export function panelPlain(): boolean { return process.env.TERM === "dumb" || process.env.NO_COLOR !== undefined; }
export function assistantBackground(theme: Theme): string {
  const mode = theme.getColorMode();
  const fill = (mode === "256color" ? assistantFills256 : assistantFills)[theme.appearance];
  return panelPlain() ? "" : backgroundAnsi(fill, mode);
}
export function userBackground(theme: Theme): string {
  const mode = theme.getColorMode();
  const fill = (mode === "256color" ? userFills256 : userFills)[theme.appearance];
  return panelPlain() ? "" : backgroundAnsi(fill, mode);
}
/** Only semantic prose callbacks use these limited-color repairs. Inline/fenced
 * code and highlightCode (including diff colors) stay entirely native. */
export function conversationProse(theme: Theme, tone: ConversationTone, text: string): string | undefined {
  if (panelPlain() || theme.getColorMode() !== "256color") return undefined;
  return theme.style(text, { fg: prose256[theme.appearance][tone] });
}
export function toolStatus(isError: boolean, isPartial: boolean): ToolStatus {
  return isError ? "error" : isPartial ? "pending" : "success";
}
export function toolBackground(theme: Theme, tool: string, mode: "tool" | "status" | "none", status: ToolStatus): string {
  if (mode === "none" || panelPlain()) return "";
  let index = toolColors[tool];
  if (!Object.hasOwn(toolColors, tool)) {
    let hash = 0;
    for (const char of tool) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    index = hash % toolFills.dark.length;
  }
  const limited = theme.getColorMode() === "256color";
  const fills = limited ? toolFills256 : toolFills;
  const statusFill = limited ? statusFills256[theme.appearance][status] : statuses[theme.appearance][status].bg;
  return backgroundAnsi(mode === "tool" ? fills[theme.appearance][index] : statusFill, theme.getColorMode());
}
export function toolChromeText(theme: Theme, text: string, tone: keyof typeof chromeColors.dark = "text"): string {
  return panelPlain() ? text : theme.style(text, { fg: chromeColors[theme.appearance][tone] });
}
export function toolStatusText(theme: Theme, status: ToolStatus, text: string): string {
  return panelPlain() ? text : theme.style(text, { fg: statuses[theme.appearance][status].fg });
}

export function paint(theme: Theme, field: Field, value: string): string {
  if (process.env.TERM === "dumb" || process.env.NO_COLOR !== undefined) return value;
  return theme.style(value, { fg: palette[theme.appearance][field] });
}
