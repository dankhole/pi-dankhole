import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import subagentsExtension from "../../src/workers/index.js";
import type { NotificationDetails } from "../../src/workers/types.js";
import { type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const details = (overrides: Partial<NotificationDetails> = {}): NotificationDetails => ({
  id: "worker-1", description: "Audit authentication", status: "completed", toolUses: 347,
  turnCount: 23, maxTurns: 30, totalTokens: 12345, totalCost: 0.0123, durationMs: 65000,
  outputFile: "/tmp/private/worker-transcript.output", resultPreview: "Fixed token refresh; all targeted tests pass.",
  ...overrides,
});

const plain = (lines: string[]) => lines.map(stripTerminalSequences);

describe("registered completion cards", () => {
  let hermetic: Hermetic | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  function boot(showCost = false): MessageRenderer<NotificationDetails> {
    hermetic = hermeticDir({ settings: { showCost } });
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    shutdown = lifecycle.get("session_shutdown");
    return pi.registerMessageRenderer.mock.calls.find(([name]: [string]) => name === "subagent-notification")[1];
  }

  function render(renderer: MessageRenderer<NotificationDetails>, d: NotificationDetails, expanded = false, theme = getThemeByName("dark") as Theme) {
    const component = renderer({ role: "custom", customType: "subagent-notification", content: "model-readable content", display: true, details: d, timestamp: 0 }, { expanded, outputPad: 1 }, theme);
    if (!component) throw new Error("Completion renderer did not return a component");
    return component;
  }

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    hermetic?.restore();
    hermetic = undefined;
  });

  it("uses a shaded padded card, readable Markdown and quiet right-aligned header stats", () => {
    const renderer = boot(true);
    const d = details({ resultPreview: "### **Refreshed tokens**\n\nFixed `refresh()`; no credentials were logged.\nMore detail follows." });
    const original = structuredClone(d);
    const theme = getThemeByName("dark") as Theme;
    const lines = render(renderer, d, false, theme).render(160);
    const output = plain(lines);
    expect(output[0]).toBe(" ".repeat(160));
    expect(output[1]).toContain("  Subagent completed — Audit authentication");
    const stats = "~$0 · 1m · Model not recorded · thinking: not recorded";
    expect(output[1].trimEnd()).toMatch(/~\$0 · 1m · Model not recorded · thinking: not recorded$/);
    expect(output[1].indexOf("~$")).toBe(160 - 2 - stats.length);
    expect(output[2].trim()).toBe("");
    expect(output[3]).toContain("  Refreshed tokens");
    expect(output[4]).toContain("Fixed refresh(); no credentials were logged.");
    expect(output[4]).toContain("…");
    expect(output.join("\n")).toContain("~$0 · 1m");
    expect(output.join("\n")).not.toMatch(/\*\*|###|```|transcript|347|tool use|12345|12.3k|↻|23≤30/);
    expect(lines[0]).toContain(theme.getBgAnsi("customMessageBg"));
    expect(lines[1]).toContain(theme.getFgAnsi("success"));
    expect(lines.find(line => stripTerminalSequences(line).includes("1m"))).toContain(theme.getFgAnsi("muted"));
    expect(lines.every(line => visibleWidth(line) === 160 && line.endsWith("\x1b[0m"))).toBe(true);
    expect(d).toEqual(original);
  });

  it("right-aligns each run’s effective model and thinking after duration", () => {
    const renderer = boot();
    const d = details({
      invocation: { modelName: "GPT-6.1 Sol", thinking: "high", requestedThinking: "xhigh" },
      others: [details({ description: "Check rollback", invocation: { modelId: "provider/second-model", thinking: "off" } })],
    });
    const component = render(renderer, d);
    const output = plain(component.render(100));
    expect(output[1]).toContain("Subagent completed — Audit authentication");
    const stats = "1m · GPT-6.1 Sol · thinking: high";
    expect(output[1].trimEnd().endsWith(stats)).toBe(true);
    expect(output[1].indexOf("1m")).toBe(100 - 2 - stats.length);
    expect(output[2].trim()).toBe("");
    expect(output.join("\n")).toContain("provider/second-model · thinking: off");
    expect(output.join("\n")).not.toContain("thinking: xhigh");
    const narrow = component.render(32);
    expect(narrow.every(line => visibleWidth(line) <= 32)).toBe(true);
    expect(plain(narrow).join("\n")).toMatch(/thinking:\s+high/);
    expect(plain(narrow).join("\n")).toContain("thinking: off");
  });

  it("reserves the right edge for stats when truncating a long goal", () => {
    const renderer = boot(true);
    const lines = render(renderer, details({ description: "Review ".repeat(50) })).render(160);
    const header = plain(lines)[1];
    expect(header).toContain("Subagent completed — Review");
    expect(header).toContain("…");
    const stats = "~$0 · 1m · Model not recorded · thinking: not recorded";
    expect(header.trimEnd().endsWith(stats)).toBe(true);
    expect(header.indexOf("~$")).toBe(160 - 2 - stats.length);
    expect(lines.every(line => visibleWidth(line) === 160)).toBe(true);
  });

  it("wraps the captured response to two physical lines, rather than clipping its first source line", () => {
    const renderer = boot();
    const result = "Validated the worker lifecycle and preserved cancellation semantics while improving notification readability. Follow-up verification remains available in the result viewer.";
    const component = render(renderer, details({ resultPreview: result }));
    const output = plain(component.render(64));
    const preview = output.slice(4, 6);
    expect(preview[0]).toContain("Validated the worker lifecycle and preserved cancellation");
    expect(preview[1]).toContain("semantics while improving notification readability.");
    expect(preview[1]).toContain("…");
    expect(output.join("\n")).not.toContain("Follow-up");
    component.invalidate();
    expect(plain(component.render(64))).toEqual(output);
  });

  it("separates batched cards with an unshaded gap and keeps cost optional per card", () => {
    const renderer = boot();
    const output = render(renderer, details({ others: [details({ id: "worker-2", description: "Check rollback", status: "stopped" })] })).render(64);
    const text = plain(output).join("\n");
    const gap = output.indexOf("");
    expect(gap).toBeGreaterThan(0);
    expect(stripTerminalSequences(output[gap - 1])).toBe(" ".repeat(64));
    expect(stripTerminalSequences(output[gap + 1])).toBe(" ".repeat(64));
    expect(text).toContain("Subagent stopped");
    expect(text).toContain("Check rollback");
    expect(text).not.toMatch(/agents ·|12\.3k token|\$|transcript|tool use/);
  });

  it("expands only the captured preview and renders code without fence syntax", () => {
    const renderer = boot(true);
    const d = details({ resultPreview: "```text\nNo secrets were exposed.\n```\n\n" + Array.from({ length: 20 }, (_, i) => `Detail ${i + 1}`).join("\n") });
    const collapsed = plain(render(renderer, d).render(64)).join("\n");
    const expanded = plain(render(renderer, d, true).render(64)).join("\n");
    expect(collapsed).toContain("No secrets were exposed.");
    expect(collapsed).not.toContain("Detail 2");
    expect(expanded).toContain("Detail 11");
    expect(expanded).not.toContain("Detail 12");
    expect(expanded).toContain("…");
    expect(expanded).not.toMatch(/```|transcript|tool use/);
  });

  it.each([
    ["completed", "Subagent completed"], ["error", "Subagent failed"], ["stopped", "Subagent stopped"],
    ["aborted", "Subagent aborted (turn limit)"], ["steered", "Subagent wrapped up (turn limit)"], ["queued", "Subagent queued"],
  ])("labels %s honestly when no final response was captured", (status, label) => {
    const renderer = boot();
    const text = plain(render(renderer, details({ status, resultPreview: "No output." })).render(80)).join("\n");
    expect(text).toContain(label);
    expect(text).toContain("No final response captured.");
    if (status !== "completed") expect(text).not.toContain("Subagent completed");
  });

  it("prioritizes a failure reason without stripping negation, and keeps partial output on expansion", () => {
    const renderer = boot();
    const d = details({ status: "error", error: "Could not validate the migration.", resultPreview: "Partial findings are available." });
    const collapsed = plain(render(renderer, d).render(64)).join("\n");
    expect(collapsed).toContain("Subagent failed");
    expect(collapsed).toContain("Error: Could not validate the migration.");
    expect(collapsed).not.toContain("Partial findings");
    const expanded = plain(render(renderer, d, true).render(64)).join("\n");
    expect(expanded).toContain("Could not validate");
    expect(expanded).toContain("Partial findings are available.");
  });

  it.each(["dark", "light"])("fits narrow Unicode and ANSI-hostile input in the %s theme", name => {
    const renderer = boot(true);
    const theme = getThemeByName(name) as Theme;
    const d = details({ description: "Inspect 認証 👩‍💻 e\u0301\x1b[2J", resultPreview: "**認証 👩‍💻 e\u0301** was not changed.\x1b]52;c;SECRET\x07\r\n\x1b[31mNo failures.\x1b[0m\x08" });
    const component = render(renderer, d, false, theme);
    for (const width of [0, 1, 2, 4, 8, 12, 20, 32, 64]) {
      const lines = component.render(width);
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).not.toMatch(/\x1b\[2J|\x1b\]52|SECRET|\x08|\r|\ufffd/);
      if (width > 0) expect(lines.every(line => line.includes(theme.getBgAnsi("customMessageBg")) && line.endsWith("\x1b[0m"))).toBe(true);
      if (width < 24) expect(plain(lines).filter(line => !line.trim())).toHaveLength(0);
    }
    const text = plain(component.render(64)).join("\n");
    expect(text).toContain("認証 👩‍💻 e\u0301 was not changed.");
    expect(text).toContain("No failures.");
  });
});
