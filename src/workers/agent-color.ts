/** Theme styling for a worker's goal, independent of profiles or named badges. */
export interface AgentNameTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface AgentNameStyle {
  fallbackColor?: string;
  bold?: boolean;
}

/** The goal is the worker's visible name; its stable ID is used for control. */
export function renderAgentName(
  goal: string | undefined,
  theme: AgentNameTheme,
  style: AgentNameStyle = {},
): string {
  const label = goal || "Worker";
  const text = style.bold ? theme.bold(label) : label;
  return style.fallbackColor ? theme.fg(style.fallbackColor, text) : text;
}
