import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderAgentName } from "../../src/workers/agent-color.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
};

describe("renderAgentName", () => {
  it("uses the goal verbatim, not a profile name or badge", () => {
    expect(renderAgentName("Review auth changes", theme)).toBe("Review auth changes");
    expect(renderAgentName("Review auth changes", theme, { fallbackColor: "text", bold: true }))
      .toBe("<text>*Review auth changes*</text>");
  });

  it("uses a neutral fallback only when no goal exists", () => {
    expect(renderAgentName(undefined, theme)).toBe("Worker");
    expect(renderAgentName("", theme, { fallbackColor: "muted" })).toBe("<muted>Worker</muted>");
  });

  it("does not add padding, a background, or profile annotations", () => {
    const ansiTheme = {
      fg: (_color: string, text: string) => `\u001b[37m${text}\u001b[39m`,
      bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    };
    const label = renderAgentName("Inspect 認証", ansiTheme, { fallbackColor: "text", bold: true });
    expect(visibleWidth(label)).toBe(visibleWidth("Inspect 認証"));
    expect(label).not.toMatch(/\u001b\[(?:48|49)/);
    expect(label).toMatch(/\u001b\[22m\u001b\[39m$/);
    expect(label).not.toMatch(/general-purpose|\(twin\)/);
  });
});
