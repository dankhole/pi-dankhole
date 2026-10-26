/**
 * Footer-only helpers adapted from jwu/pi-powerline (MIT).
 * Source: 51fc7d3d3893d380267e66b4d48e8b682c14ab83, extensions/footer.ts and utils.ts.
 * See LICENSE and README.md in this directory.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

const thinkLabels: Record<string, string> = {
  off: "thinking off", minimal: "min", low: "low", medium: "med", high: "high", xhigh: "xhi", max: "max",
};
const thinkColors = {
  off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow",
  medium: "thinkingMedium", high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax",
} as const;

export function getThinkingLevelDisplay(level: string) {
  return {
    label: thinkLabels[level] ?? level,
    color: thinkColors[level as keyof typeof thinkColors] ?? "thinkingOff",
  };
}

/** Explicit override wins. Terminal identification cannot prove font installation. */
export function hasNerdFonts(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TERM === "dumb" || env.NO_COLOR !== undefined) return false;
  if (env.PI_NERD_FONTS === "1") return true;
  if (env.PI_NERD_FONTS === "0") return false;
  if (env.GHOSTTY_RESOURCES_DIR) return true;
  const terminal = `${env.TERM_PROGRAM ?? ""} ${env.TERM ?? ""}`.toLowerCase();
  return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some(t => terminal.includes(t));
}
