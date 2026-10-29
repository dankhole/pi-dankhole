import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatViewport } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { CustomMessageComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-message.js";
import { UserMessageComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js";
import { getThemeByName, setThemeInstance, theme as suppliedTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { renderLayoutFrame } from "../../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { defaults } from "../../src/settings/interface.js";
import { installGrouping } from "../../src/styling/grouping.js";
import { installPinnedPrompt } from "../../src/styling/pinned-prompt.js";
import type { NotificationDetails } from "../../src/workers/types.js";
import { CompletionCards } from "../../src/workers/ui/completion-card.js";

// Count only the card's work. Pinning legitimately decorates its own row on each
// frame; native layout also performs unrelated terminal-width operations.
const counts = vi.hoisted(() => ({ depth: 0, construct: 0, render: 0, markdown: 0, truncate: 0, wrap: 0, decorate: 0 }));
vi.mock("@earendil-works/pi-tui", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  class CountingMarkdown extends actual.Markdown {
    render(width: number): string[] {
      if (counts.depth) counts.markdown++;
      return super.render(width);
    }
  }
  return {
    ...actual,
    Markdown: CountingMarkdown,
    truncateToWidth: (...args: Parameters<typeof actual.truncateToWidth>) => {
      if (counts.depth) counts.truncate++;
      return actual.truncateToWidth(...args);
    },
    wrapTextWithAnsi: (...args: Parameters<typeof actual.wrapTextWithAnsi>) => {
      if (counts.depth) counts.wrap++;
      return actual.wrapTextWithAnsi(...args);
    },
  };
});

class CountingCards extends CompletionCards {
  constructor(...args: ConstructorParameters<typeof CompletionCards>) {
    super(...args);
    counts.construct++;
  }
  render(width: number): string[] {
    counts.render++;
    counts.depth++;
    try { return super.render(width); }
    finally { counts.depth--; }
  }
}

const details = (index: number): NotificationDetails => ({
  id: `worker-${index}`, description: `Completion ${index}`, status: index === 0 ? "error" : "completed",
  error: index === 0 ? "Could not validate the migration." : undefined,
  toolUses: 3, turnCount: 2, totalTokens: 100, totalCost: 0.0123, durationMs: 65000,
  invocation: { modelName: "Sol", thinking: "high" },
  resultPreview: "Partial findings: **no secrets** were logged in `refresh()`.\n"
    + Array.from({ length: 20 }, (_, i) => `Detail ${i + 1}`).join("\n"),
});
const expensive = () => ({ markdown: counts.markdown, truncate: counts.truncate, wrap: counts.wrap, decorate: counts.decorate });
const plain = (rows: string[]) => rows.map(stripTerminalSequences).join("\n");
const themeKeys = [Symbol.for("@earendil-works/pi-coding-agent:theme"), Symbol.for("@mariozechner/pi-coding-agent:theme")];
let previousThemes: (PropertyDescriptor | undefined)[];

beforeEach(() => {
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
  previousThemes = themeKeys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const theme = getThemeByName("dark")!;
  setThemeInstance(theme); // In-memory test host only: no reload, watcher or config writes.
  const fg = theme.fg.bind(theme);
  const bg = theme.bg.bind(theme);
  vi.spyOn(theme, "fg").mockImplementation((color, text) => { if (counts.depth) counts.decorate++; return fg(color, text); });
  vi.spyOn(theme, "bg").mockImplementation((color, text) => { if (counts.depth) counts.decorate++; return bg(color, text); });
  for (const method of ["bold", "italic", "underline", "strikethrough"] as const) {
    const decorate = theme[method].bind(theme);
    vi.spyOn(theme, method).mockImplementation(text => { if (counts.depth) counts.decorate++; return decorate(text); });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  themeKeys.forEach((key, index) => {
    const descriptor = previousThemes[index];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
});

function fixture() {
  const settings = defaults();
  const chat = new Container();
  const header = new Container();
  header.addChild(new Text("native header", 0, 0));
  const document = new Container();
  document.addChild(header);
  document.addChild(new Container());
  document.addChild(chat);
  const viewport = createChatViewport({
    document, pendingMessages: new Container(), status: new Container(),
    widgetsAbove: new Container(), editor: new Text("editor", 0, 0),
    widgetsBelow: new Container(), footer: new Text("native footer", 0, 0),
  });
  const tui = { children: [document], layoutRoot: viewport.root, mode: "fullscreen", requestRender: vi.fn() };
  const notify = vi.fn();
  const prompt = "Inspect retained worker completions";
  chat.addChild(new UserMessageComponent(prompt));
  const ungroup = installGrouping(tui, settings, { theme: () => suppliedTheme, requestRender: tui.requestRender, warn: notify });
  const pin = installPinnedPrompt(tui as unknown as TUI, () => suppliedTheme, () => ({
    text: prompt, displayed: true, id: "user-1", rows: [{ id: "user-1", kind: "UserMessageComponent" }],
  }), notify, settings.assistantPanels);
  let showCost = false;
  const renderer: MessageRenderer = (message, { expanded }, theme) => new CountingCards(message.details as NotificationDetails, expanded, theme, showCost);
  const wrappers = Array.from({ length: 17 }, (_, index) => new CustomMessageComponent({
    role: "custom", customType: "subagent-notification", content: "model-readable completion", display: true,
    details: details(index), timestamp: 0,
  }, renderer));
  for (const wrapper of wrappers) chat.addChild(wrapper);
  return {
    ...viewport, wrappers, chat, settings, pin, notify,
    setShowCost(value: boolean) { showCost = value; },
    frame(width = 100) { return renderLayoutFrame(viewport.root, width, 20, tui.requestRender); },
    dispose() { pin?.dispose(); ungroup(); },
  };
}

describe("completion cards in the real Pi fullscreen layout", () => {
  it("retains 17 real custom wrappers across warm pinned/grouped renderLayoutFrame passes", () => {
    const view = fixture();
    try {
      expect(view.settings.pinLatestPrompt && view.settings.groupConsecutive).toBe(true);
      expect(view.pin).toBeDefined();
      expect(counts.construct).toBe(17);
      const cards = view.wrappers.map(wrapper => wrapper.children.at(-1));
      for (const width of [100, 32]) {
        const first = view.frame(width);
        expect(plain(first.lines)).toContain("↑ You: Inspect retained");
        expect(view.notify).not.toHaveBeenCalled();
        expect(expensive().markdown).toBeGreaterThan(0);
        expect(expensive().truncate).toBeGreaterThan(0);
        expect(expensive().decorate).toBeGreaterThan(0);
        const cold = expensive();
        if (width === 32) expect(cold.wrap).toBeGreaterThan(0);
        const rendered = counts.render;
        for (let frame = 0; frame < 25; frame++) expect(view.frame(width).lines).toEqual(first.lines);
        expect(counts.render).toBeGreaterThanOrEqual(rendered + 17 * 25);
        expect(counts.construct).toBe(17);
        expect(expensive()).toEqual(cold);
        expect(view.wrappers.map(wrapper => wrapper.children.at(-1))).toEqual(cards);
        // Grouping is installed, but custom notifications stay individual native children.
        expect(view.chat.children.slice(1)).toEqual(view.wrappers);
        expect(view.wrappers.every(wrapper => wrapper instanceof CustomMessageComponent)).toBe(true);
      }
    } finally { view.dispose(); }
  });

  it("recreates cards for native expansion/invalidation, then returns to warm reuse", () => {
    const view = fixture();
    try {
      view.frame();
      const wrapper = view.wrappers[0];
      const initial = wrapper.children.at(-1)!;
      const width = view.transcript.getContentWidth(100);
      expect(plain(initial.render(width))).not.toMatch(/Partial findings|\$/);
      view.setShowCost(true);
      view.frame();
      expect(wrapper.children.at(-1)).toBe(initial);
      expect(plain(initial.render(width))).not.toContain("~$0"); // Setting alone does not rebuild.

      wrapper.setExpanded(true);
      expect(counts.construct).toBe(18);
      const expanded = wrapper.children.at(-1)!;
      expect(expanded).not.toBe(initial);
      expect(expanded.render(width)).toEqual(new CompletionCards(details(0), true, suppliedTheme, true).render(width));
      expect(plain(expanded.render(width))).toContain("Partial findings");
      expect(plain(expanded.render(width))).toContain("~$0");
      view.frame();
      const warmed = expensive();
      view.frame();
      expect(expensive()).toEqual(warmed);
      wrapper.setExpanded(true);
      expect(counts.construct).toBe(18); // Unchanged native expansion is a no-op.

      wrapper.invalidate();
      expect(counts.construct).toBe(19);
      const invalidated = wrapper.children.at(-1)!;
      expect(invalidated).not.toBe(expanded);
      expect(invalidated.render(width)).toEqual(expanded.render(width));
      view.frame();
      const rebuilt = expensive();
      view.frame();
      expect(expensive()).toEqual(rebuilt);

      wrapper.setExpanded(false);
      expect(counts.construct).toBe(20);
      const collapsed = wrapper.children.at(-1)!;
      expect(collapsed.render(width)).toEqual(new CompletionCards(details(0), false, suppliedTheme, true).render(width));
      expect(plain(collapsed.render(width))).not.toContain("Partial findings");
      view.frame();
      const final = expensive();
      view.frame();
      expect(expensive()).toEqual(final);
      expect(counts.construct).toBe(20);
      expect(view.notify).not.toHaveBeenCalled();
    } finally { view.dispose(); }
  });
});
