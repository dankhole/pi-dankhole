import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, foregroundAnsi, parseColor, type TextAttributes } from "@earendil-works/pi-tui";

// Deliberately independent of decorative theme fills. Amber question cards stand
// apart from gray chat chrome; opaque neutral popup controls remain separate.
// WCAG targets: text >= 4.5:1; meaningful focus/border cues >= 3:1.
const colors = {
  dark: { surface: "#1c1c1c", choice: "#262626", focused: "#3a3a3a", selected: "#303030", question: "#594515", questionSeparator: "#524013",
    questionText: "#ffff80", questionMuted: "#d7d7d7", questionAccent: "#afffff",
    text: "#eeeeee", muted: "#c6c6c6", accent: "#87d7ff", success: "#afffaf", warning: "#ffd787", border: "#a8a8a8" },
  light: { surface: "#eeeeee", choice: "#e4e4e4", focused: "#d0d0d0", selected: "#dadada", question: "#fff0bf", questionSeparator: "#e6d58c",
    questionText: "#5f0000", questionMuted: "#444444", questionAccent: "#005f87",
    text: "#1c1c1c", muted: "#444444", accent: "#005f87", success: "#005f00", warning: "#5f0000", border: "#626262" },
};
type Tone = "text" | "questionText" | "questionMuted" | "questionAccent" | "muted" | "accent" | "success" | "warning" | "border";
type Surface = "surface" | "choice" | "focused" | "selected" | "question" | "questionSeparator";
const palettes = Object.fromEntries(Object.entries(colors).map(([appearance, values]) => [appearance,
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, parseColor(value)])),
])) as Record<Theme["appearance"], Record<Tone | Surface, ReturnType<typeof parseColor>>>;

export function questionPalette(theme: Theme) { return palettes[theme.appearance === "light" ? "light" : "dark"]; }
export function questionPlain(): boolean { return process.env.TERM === "dumb" || process.env.NO_COLOR !== undefined; }

export function questionStyle(theme: Theme, text: string, fg: Tone = "text", bg: Surface = "surface", attributes: TextAttributes = {}): string {
  if (questionPlain()) return text;
  const palette = questionPalette(theme);
  const tone = bg !== "question" ? fg : fg === "text" ? "questionText"
    : fg === "muted" ? "questionMuted" : fg === "accent" ? "questionAccent" : fg;
  return theme.style(text, { fg: palette[tone], bg: palette[bg], ...attributes });
}

/** Restore both foreground and background after nested Input/clipping resets. */
export function questionPaint(theme: Theme, text: string, bg: Surface = "surface"): string {
  if (questionPlain()) return text;
  const palette = questionPalette(theme);
  const reset = foregroundAnsi(bg === "question" ? palette.questionText : palette.text, theme.getColorMode()) + backgroundAnsi(palette[bg], theme.getColorMode());
  return reset + text.replace(/\x1b\[(?:0|39|49)?m/g, code => code + reset) + "\x1b[0m";
}
