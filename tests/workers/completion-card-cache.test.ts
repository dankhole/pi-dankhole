import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomMessageComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-message.js";
import { getThemeByName, setThemeInstance } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { NotificationDetails } from "../../src/workers/types.js";
import { CompletionCards } from "../../src/workers/ui/completion-card.js";

const operations = vi.hoisted(() => ({ markdownNew: 0, markdown: 0, truncate: 0, wrap: 0 }));

vi.mock("@earendil-works/pi-tui", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  class CountingMarkdown extends actual.Markdown {
    constructor(...args: ConstructorParameters<typeof actual.Markdown>) {
      super(...args);
      operations.markdownNew++;
    }
    render(width: number): string[] {
      operations.markdown++;
      return super.render(width);
    }
  }
  return {
    ...actual,
    Markdown: CountingMarkdown,
    truncateToWidth: (...args: Parameters<typeof actual.truncateToWidth>) => {
      operations.truncate++;
      return actual.truncateToWidth(...args);
    },
    wrapTextWithAnsi: (...args: Parameters<typeof actual.wrapTextWithAnsi>) => {
      operations.wrap++;
      return actual.wrapTextWithAnsi(...args);
    },
  };
});

const details = (overrides: Partial<NotificationDetails> = {}): NotificationDetails => ({
  id: "worker-1", description: "Inspect 認証 👩‍💻 e\u0301\x1b[2J", status: "completed", toolUses: 3,
  turnCount: 2, totalTokens: 100, totalCost: 0.0123, durationMs: 65000,
  invocation: { modelName: "Sol", thinking: "high" },
  resultPreview: "### **No failures**\n\nValidated `refresh()`; credentials were not logged.\x1b]52;c;SECRET\x07\n"
    + Array.from({ length: 20 }, (_, i) => `Detail ${i + 1}`).join("\n"),
  ...overrides,
});
const darkTheme = () => getThemeByName("dark") as Theme;
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

const themeKeys = [Symbol.for("@earendil-works/pi-coding-agent:theme"), Symbol.for("@mariozechner/pi-coding-agent:theme")];
let previousThemes: (PropertyDescriptor | undefined)[];
beforeEach(() => {
  operations.markdownNew = operations.markdown = operations.truncate = operations.wrap = 0;
  previousThemes = themeKeys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
});
afterEach(() => {
  vi.restoreAllMocks();
  themeKeys.forEach((key, index) => {
    const descriptor = previousThemes[index];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
});

describe("completion-card final-row cache", () => {
  it.each([false, true])("skips all layout, Markdown and row decoration for 17 warm cards (expanded=%s)", expanded => {
    const theme = darkTheme();
    const decorations = ["fg", "bg", "bold", "italic", "underline", "strikethrough"] as const;
    const spies = decorations.map(method => vi.spyOn(theme, method));
    const components = Array.from({ length: 17 }, (_, i) => new CompletionCards(details({
      id: `worker-${i}`, status: i % 2 ? "error" : "completed", error: "Could not validate the migration.",
      others: i === 0 ? [details({ description: "Grouped completion", status: "stopped" })] : undefined,
    }), expanded, theme, true));

    for (const width of [20, 100]) {
      const rows = components.map(component => component.render(width));
      expect(operations.markdown).toBeGreaterThan(0);
      expect(operations.truncate).toBeGreaterThan(0);
      expect(operations.wrap).toBeGreaterThan(0);
      const cold = { ...operations };
      const decorated = spies.map(spy => spy.mock.calls.length);
      expect(decorated[0]).toBeGreaterThan(0);
      expect(decorated[1]).toBeGreaterThan(0);
      for (let frame = 0; frame < 25; frame++) {
        for (const [index, component] of components.entries()) expect(component.render(width)).toEqual(rows[index]);
      }
      expect(operations).toEqual(cold);
      expect(spies.map(spy => spy.mock.calls.length)).toEqual(decorated);
    }
  });

  it("keeps only the last width and preserves narrow Unicode, sanitization and backgrounds after resizing", () => {
    const theme = darkTheme();
    const d = details();
    const component = new CompletionCards(d, false, theme, false);
    for (const width of [100, 32, 1, 2, 4, 8, 12, 20, 64, 100]) {
      const previous = operations.markdown;
      const rows = component.render(width);
      expect(operations.markdown).toBe(previous + 1); // Revisiting 100 must not retain an older layout.
      const cold = { ...operations };
      expect(component.render(width)).toEqual(rows);
      expect(operations).toEqual(cold);
      expect(rows.every(line => visibleWidth(line) <= width)).toBe(true);
      expect(rows.every(line => line.includes(theme.getBgAnsi("customMessageBg")) && line.endsWith("\x1b[0m"))).toBe(true);
      expect(rows.join("\n")).not.toMatch(/\x1b\[2J|\x1b\]52|SECRET|\ufffd/);
      expect(rows).toEqual(new CompletionCards(d, false, theme, false).render(width));
    }
    const cold = { ...operations };
    expect(component.render(0)).toEqual([]);
    expect(component.render(-1)).toEqual([]);
    component.render(100);
    expect(operations).toEqual(cold);
  });

  it("explicit invalidation rebuilds both final rows and themed Markdown at the same width", () => {
    const theme = darkTheme();
    const component = new CompletionCards(details(), true, theme, true);
    const rows = component.render(100);
    const before = { ...operations };
    component.invalidate();
    expect(component.render(100)).toEqual(rows);
    expect(operations.markdown).toBe(before.markdown + 1);
    expect(operations.truncate).toBeGreaterThan(before.truncate);
    const cold = { ...operations };
    component.render(100);
    expect(operations).toEqual(cold);

    // Theme callbacks can also change behavior beyond their ANSI colors. The Component
    // contract's explicit invalidate must refresh those strings, including Markdown.
    vi.spyOn(theme, "bold").mockImplementation(text => `\x1b[1m${text}\x1b[22m`);
    component.invalidate();
    const changed = component.render(100);
    expect(changed).toEqual(new CompletionCards(details(), true, theme, true).render(100));
    expect(changed.join("\n")).toContain("\x1b[1m");
  });

  it.each(["text", "mdCode", "customMessageBg"] as const)("notices in-place %s palette changes without a new theme identity", token => {
    const base = darkTheme();
    const colors = new Map<string, string>();
    const theme = Object.create(base) as Theme;
    theme.getFgAnsi = color => colors.get(color) ?? base.getFgAnsi(color);
    theme.getBgAnsi = color => colors.get(color) ?? base.getBgAnsi(color);
    theme.fg = (color, text) => `${theme.getFgAnsi(color)}${text}\x1b[39m`;
    theme.bg = (color, text) => `${theme.getBgAnsi(color)}${text}\x1b[49m`;
    const d = details({ resultPreview: "No failures in `refresh()`." });
    const component = new CompletionCards(d, false, theme, false);
    const original = component.render(100);
    const previous = operations.markdown;
    const ansi = token === "customMessageBg" ? "\x1b[48;5;17m" : "\x1b[38;5;196m";
    colors.set(token, ansi); // Same theme, getter functions, palette object and width.
    const changed = component.render(100);
    expect(operations.markdown).toBe(previous + 1);
    expect(changed).not.toEqual(original);
    expect(plain(changed)).toEqual(plain(original));
    expect(changed.join("\n")).toContain(ansi);
    expect(changed).toEqual(new CompletionCards(d, false, theme, false).render(100));
    const cold = { ...operations };
    expect(component.render(100)).toEqual(changed);
    expect(operations).toEqual(cold);
  });

  it("follows the supplied stable theme proxy when its underlying theme changes", () => {
    let active = darkTheme();
    const supplied = new Proxy({} as Theme, { get: (_target, prop) => Reflect.get(active, prop) });
    const d = details({ others: [details({ status: "error", error: "Could not validate." })] });
    const component = new CompletionCards(d, true, supplied, true);
    const original = component.render(100);
    const previous = operations.markdown;
    active = getThemeByName("light") as Theme;
    const changed = component.render(100);
    expect(operations.markdown).toBe(previous + 2);
    expect(changed).not.toEqual(original);
    expect(plain(changed)).toEqual(plain(original));
    expect(changed).toEqual(new CompletionCards(d, true, active, true).render(100));
    const cold = { ...operations };
    component.render(100);
    expect(operations).toEqual(cold);
  });

  it("owns the captured header, invocation and grouped-preview inputs across hits, invalidation and resize", () => {
    const d = details({ others: [details({ id: "second", description: "Check rollback" })] });
    const original = structuredClone(d);
    const theme = darkTheme();
    const component = new CompletionCards(d, true, theme, true);
    const rows = component.render(100);
    Object.assign(d, { description: "Changed goal", status: "error", error: "Changed error", resultPreview: "Changed preview", totalCost: 50, durationMs: 600000 });
    Object.assign(d.invocation!, { modelName: "Changed model", thinking: "off" });
    Object.assign(d.others![0], { description: "Changed child", resultPreview: "Changed child preview" });
    d.others!.push(details({ id: "third" }));
    expect(component.render(100)).toEqual(rows);
    component.invalidate();
    expect(component.render(100)).toEqual(rows);
    expect(component.render(32)).toEqual(new CompletionCards(original, true, theme, true).render(32));
    expect(new CompletionCards(d, true, theme, true).render(100)).not.toEqual(rows);
  });

  it("does not expose its cached row array to callers", () => {
    const component = new CompletionCards(details(), false, darkTheme(), false);
    const cold = component.render(100);
    const expected = [...cold];
    cold[0] = "corrupt cold array";
    cold.fill("corrupt every cold row");
    cold.push("extra row");
    const warm = component.render(100);
    expect(warm).toEqual(expected);
    warm.splice(0, warm.length);
    expect(component.render(100)).toEqual(expected);
  });

  it("does not share cached rows across expanded state, showCost, theme or notification instances", () => {
    const d = details({ status: "error", error: "Could not validate.", resultPreview: "Partial output.\n" + Array.from({ length: 20 }, (_, i) => `Detail ${i + 1}`).join("\n") });
    const theme = darkTheme();
    const collapsed = new CompletionCards(d, false, theme, false);
    const expanded = new CompletionCards(d, true, theme, true);
    const other = new CompletionCards(details({ description: "Independent completion" }), false, getThemeByName("light") as Theme, false);
    const collapsedRows = collapsed.render(100);
    const expandedRows = expanded.render(100);
    const otherRows = other.render(100);
    expect(plain(collapsedRows)).not.toMatch(/Partial output|\$/);
    expect(plain(expandedRows)).toContain("Partial output.");
    expect(plain(expandedRows)).toContain("~$0");
    expect(plain(otherRows)).toContain("Independent completion");
    expect(collapsed.render(100)).toEqual(collapsedRows);
    expect(expanded.render(100)).toEqual(expandedRows);
    expect(other.render(100)).toEqual(otherRows);
  });
});

// Reconciled master coverage: frozen native Markdown arrays, the full theme/width/
// expansion/cost matrix, and native root invalidation with captured settings.
const matrixDetails = (overrides: Partial<NotificationDetails> = {}): NotificationDetails => ({
  id: "worker-1", description: "Inspect 認証 👩‍💻 e\u0301\x1b[2J", status: "completed", toolUses: 3,
  turnCount: 2, maxTurns: 30, totalTokens: 12345, totalCost: 0.75, durationMs: 65000,
  outputFile: "/tmp/private/worker.output",
  invocation: { modelName: "Sol 認証", thinking: "high" },
  resultPreview: "### **認証 👩‍💻 e\u0301**\n\nWas not changed.\x1b]52;c;SECRET\x07\r\n\x1b[31mNo failures.\x1b[0m\x08\n\n```text\nNo secrets were exposed.\n```\n\n" +
    Array.from({ length: 20 }, (_, i) => `Detail ${i + 1}: inspect Unicode 認証 and combining e\u0301.`).join("\n"),
  ...overrides,
});

const widths = [0, 1, 8, 11, 12, 20, 23, 24, 32, 39, 40, 64, 160];

// Native Markdown returns its own cached array. Freeze it to catch accidental
// in-place trimming, clipping or painting by the outer completion-card cache.
function observeMarkdown() {
  const render = Markdown.prototype.render;
  return vi.spyOn(Markdown.prototype, "render").mockImplementation(function (this: Markdown, width: number) {
    const lines = render.call(this, width);
    Object.freeze(lines);
    return lines;
  });
}

describe("completion-card render cache", () => {
  it("skips Markdown and truncation on repeated frames, but not resize or invalidation", () => {
    const markdown = observeMarkdown();
    const cards = new CompletionCards(matrixDetails({ others: [matrixDetails({ id: "worker-2", status: "error", error: "Could not verify." })] }), false, getThemeByName("dark") as Theme, true);
    const first = cards.render(80);
    expect(markdown).toHaveBeenCalledTimes(2);
    const truncations = operations.truncate;
    expect(truncations).toBeGreaterThan(0);
    for (let i = 0; i < 100; i++) expect(cards.render(80)).toEqual(first);
    expect(markdown).toHaveBeenCalledTimes(2);
    expect(operations.truncate).toBe(truncations);

    // Height/hidden-width probes must not evict the visible layout.
    expect(cards.render(0)).toEqual([]);
    expect(cards.render(-1)).toEqual([]);
    expect(cards.render(80)).toEqual(first);
    expect(markdown).toHaveBeenCalledTimes(2);
    expect(operations.truncate).toBe(truncations);

    cards.render(40);
    expect(markdown).toHaveBeenCalledTimes(4);
    expect(operations.truncate).toBeGreaterThan(truncations);
    cards.render(80); // Only one width is retained, not a growing map.
    expect(markdown).toHaveBeenCalledTimes(6);
    const beforeInvalidate = operations.truncate;
    const beforeRebuild = operations.markdownNew;
    cards.invalidate();
    // Reconstruct each child, rather than retaining native Markdown's stale style-prefix cache.
    expect(operations.markdownNew).toBe(beforeRebuild + 2);
    expect(cards.render(80)).toEqual(first);
    expect(markdown).toHaveBeenCalledTimes(8);
    expect(operations.truncate).toBeGreaterThan(beforeInvalidate);
    const afterInvalidate = operations.truncate;
    expect(cards.render(80)).toEqual(first);
    expect(markdown).toHaveBeenCalledTimes(8);
    expect(operations.truncate).toBe(afterInvalidate);
  });

  for (const themeName of ["dark", "light"]) for (const expanded of [false, true]) for (const showCost of [false, true]) {
    it.each([
      { name: "completed", data: matrixDetails() },
      { name: "error", data: matrixDetails({ status: "error", error: "Could not validate 認証.\x1b[31m No rollback was performed.\x1b[0m" }) },
      { name: "batched others", data: matrixDetails({ others: [
        matrixDetails({ id: "worker-2", description: "Check rollback", status: "error", error: "Could not verify 👩‍💻." }),
        matrixDetails({ id: "worker-3", description: "No captured output", status: "stopped", resultPreview: "No output.", invocation: undefined }),
      ] }) },
    ])(`matches fresh rendering for $name (${themeName}, expanded=${expanded}, cost=${showCost})`, ({ data }) => {
      observeMarkdown();
      const original = structuredClone(data);
      const theme = getThemeByName(themeName) as Theme;
      const cards = new CompletionCards(data, expanded, theme, showCost);
      for (const width of widths) {
        const expected = new CompletionCards(data, expanded, theme, showCost).render(width);
        const cold = cards.render(width);
        expect(cold).toEqual(expected);
        expect(cards.render(width)).toEqual(expected);
        cards.invalidate();
        expect(cards.render(width)).toEqual(expected);
        expect(cold.every(line => visibleWidth(line) <= width)).toBe(true);
        expect(cold.join("\n")).not.toMatch(/\x1b\[2J|\x1b\]52|SECRET|\x08|\r|\ufffd/);
      }
      expect(data).toEqual(original);
    });
  }
});

describe("Pi 1.4 custom-message cache lifecycle", () => {
  it("retains components across renders/resizes and recreates them for expansion, theme and captured settings", () => {
    const dark = getThemeByName("dark") as Theme;
    setThemeInstance(dark);
    let showCost = false;
    const created: CompletionCards[] = [];
    const data = matrixDetails();
    const renderer: MessageRenderer = (_message, { expanded }, theme) => {
      const cards = new CompletionCards(data, expanded, theme, showCost);
      created.push(cards);
      return cards;
    };
    const message = new CustomMessageComponent({
      role: "custom", customType: "subagent-notification", content: "Captured result", display: true, details: data, timestamp: 0,
    }, renderer);
    const root = new Container();
    root.addChild(message);
    const collapsed = root.render(80);
    expect(root.render(80)).toEqual(collapsed);
    root.render(40);
    expect(created).toHaveLength(1);

    message.setExpanded(true);
    expect(created).toHaveLength(2);
    const expanded = root.render(80);
    expect(expanded).not.toEqual(collapsed);
    expect(plain(expanded)).toContain("Detail 1");
    message.setExpanded(true);
    expect(created).toHaveLength(2);

    // Theme controllers/file watchers call TUI.invalidate(), which traverses
    // containers and makes CustomMessageComponent rebuild with the live theme.
    setThemeInstance(getThemeByName("light") as Theme);
    try {
      root.invalidate();
      expect(created).toHaveLength(3);
      const light = root.render(80);
      expect(light).not.toEqual(expanded);
      expect(plain(light)).toEqual(plain(expanded));

      // The existing setter updates widgets/fleet, not historical cards. A
      // later native rebuild captures the new setting; cache adds no staleness.
      showCost = true;
      expect(root.render(80)).toEqual(light);
      root.invalidate();
      expect(created).toHaveLength(4);
      expect(plain(root.render(80))).toContain("~$1");
      message.setExpanded(false);
      expect(created).toHaveLength(5);
      expect(plain(root.render(80))).not.toContain("Detail 1");
      expect(plain(root.render(80))).toContain("~$1");
    } finally {
      setThemeInstance(dark);
    }
  });
});
