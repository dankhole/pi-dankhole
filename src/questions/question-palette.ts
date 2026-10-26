import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, foregroundAnsi, parseColor, type TextAttributes } from "@earendil-works/pi-tui";

// Deliberately independent of decorative theme fills. Neutral, opaque surfaces
// keep every text/control pair legible, including theme changes and 256-color TTYs.
// WCAG targets: text >= 4.5:1; meaningful focus/border cues >= 3:1.
const colors = {
  dark: { surface: "#1c1c1c", choice: "#262626", focused: "#3a3a3a", selected: "#303030",
    text: "#eeeeee", muted: "#c6c6c6", accent: "#87d7ff", success: "#afffaf", warning: "#ffd787", border: "#a8a8a8" },
  light: { surface: "#eeeeee", choice: "#e4e4e4", focused: "#d0d0d0", selected: "#dadada",
    text: "#1c1c1c", muted: "#444444", accent: "#005f87", success: "#005f00", warning: "#5f0000", border: "#626262" },
};
type Tone = "text" | "questionText" | "muted" | "accent" | "success" | "warning" | "border";
type Surface = "surface" | "choice" | "focused" | "selected" | "question";
const palettes = Object.fromEntries(Object.entries(colors).map(([appearance, values]) => [appearance,
  Object.fromEntries(Object.entries({ ...values, question: values.choice, questionText: values.warning }).map(([key, value]) => [key, parseColor(value)])),
])) as Record<Theme["appearance"], Record<Tone | Surface, ReturnType<typeof parseColor>>>;

export function questionPalette(theme: Theme) { return palettes[theme.appearance === "light" ? "light" : "dark"]; }
export function questionPlain(): boolean { return process.env.TERM === "dumb" || process.env.NO_COLOR !== undefined; }

export function questionStyle(theme: Theme, text: string, fg: Tone = "text", bg: Surface = "surface", attributes: TextAttributes = {}): string {
  if (questionPlain()) return text;
  const palette = questionPalette(theme);
  return theme.style(text, { fg: palette[fg === "text" && bg === "question" ? "questionText" : fg], bg: palette[bg], ...attributes });
}

/** Restore both foreground and background after nested Input/clipping resets. */
export function questionPaint(theme: Theme, text: string, bg: Surface = "surface"): string {
  if (questionPlain()) return text;
  const palette = questionPalette(theme);
  const reset = foregroundAnsi(bg === "question" ? palette.questionText : palette.text, theme.getColorMode()) + backgroundAnsi(palette[bg], theme.getColorMode());
  return reset + text.replace(/\x1b\[(?:0|39|49)?m/g, code => code + reset) + "\x1b[0m";
}
