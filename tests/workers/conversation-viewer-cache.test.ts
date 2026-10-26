import type { AgentSession, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord, ViewerMarkdownMode } from "../../src/workers/types.js";
import type { AgentActivity, Theme } from "../../src/workers/ui/agent-widget.js";
import { ConversationViewer } from "../../src/workers/ui/conversation-viewer.js";

// The installed implementation supplies the actual stable Proxy and public
// Theme methods. Watchers are disabled; no installed configuration is changed.
const themeUrl = new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
const themes = await import(themeUrl.href);
const themeSymbols = [Symbol.for("@earendil-works/pi-coding-agent:theme"), Symbol.for("@mariozechner/pi-coding-agent:theme")];
let savedThemes: unknown[];
beforeEach(() => { savedThemes = themeSymbols.map(key => Reflect.get(globalThis, key)); });
afterEach(() => {
  themeSymbols.forEach((key, index) => {
    if (savedThemes[index] === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, savedThemes[index]);
  });
});

type Message = { role: "user"; content: string } |
  { role: "assistant" | "toolResult"; content: ({ type: "text"; text: string } | { type: "toolCall"; name: string })[] } |
  { role: "bashExecution"; command: string; output: string };
const plainTheme: Theme = { fg: (_color, text) => text, bold: text => text };
const assistant = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });

function setup(messages: Message[], theme: Theme = plainTheme, activity?: AgentActivity) {
  let listener: AgentSessionEventListener = () => {};
  const unsubscribe = vi.fn();
  const state = {
    messages,
    subscribe: (callback: AgentSessionEventListener) => { listener = callback; return unsubscribe; },
  };
  const session = state as unknown as AgentSession;
  const tui = { mode: "fullscreen", terminal: { rows: 25, columns: 80 }, requestRender: vi.fn() } as unknown as TUI;
  const record = { description: "cached viewer", status: "running", toolUses: 0, startedAt: 0 } as AgentRecord;
  let mode: ViewerMarkdownMode = "assistant";
  const viewer = new ConversationViewer(tui, session, record, activity, theme, () => {}, undefined, undefined,
    undefined, false, () => mode, undefined, "hidden");
  return { viewer, state, record, tui, unsubscribe, emit: (event: Parameters<AgentSessionEventListener>[0]) => listener(event),
    setMode: (next: ViewerMarkdownMode) => { mode = next; } };
}

function content(viewer: ConversationViewer, width = 76): string[] {
  return (viewer as unknown as { buildContentLines(width: number): string[] }).buildContentLines(width);
}
function text(viewer: ConversationViewer): string { return content(viewer).map(line => stripTerminalSequences(line).trimEnd()).join("\n"); }

describe("ConversationViewer cached history correctness", () => {
  it("keeps unchanged layout identity, detects same-object mutations, and matches a fresh layout", () => {
    const user = { role: "user" as const, content: "original user" };
    const responseText = { type: "text" as const, text: "# Original" };
    const response: Message = { role: "assistant", content: [responseText] };
    const resultText = { type: "text" as const, text: "original result" };
    const bash = { role: "bashExecution" as const, command: "echo old", output: "old output" };
    const messages: Message[] = [user, response, { role: "toolResult", content: [resultText] }, bash];
    const { viewer } = setup(messages);
    try {
      const first = content(viewer);
      expect(content(viewer)).toBe(first);
      user.content = "replaced user";
      responseText.text = "# Replaced";
      const toolCall = { type: "toolCall" as const, name: "read" };
      response.content.push(toolCall);
      resultText.text = "changed result";
      bash.command = "echo new";
      bash.output = "new output";
      const fresh = setup(messages);
      try {
        expect(content(viewer)).toEqual(content(fresh.viewer));
        expect(text(viewer)).toContain("[Tool: read]");
        toolCall.name = "grep";
        expect(text(viewer)).toContain("[Tool: grep]");
        expect(text(viewer)).not.toContain("original");
      } finally { fresh.viewer.dispose(); }
    } finally { viewer.dispose(); }
  });

  it("preserves the entire history and clears stale separators on same-length replacement/compaction", () => {
    const h = setup(Array.from({ length: 2000 }, (_, i) => ({ role: "user", content: `message-${i}` })));
    try {
      h.viewer.render(80);
      h.viewer.handleInput("\x1b[H");
      expect(h.viewer.render(80).join("\n")).toContain("message-0 ");
      h.viewer.handleInput("\x1b[F");
      expect(h.viewer.render(80).join("\n")).toContain("message-1999");
      h.state.messages = h.state.messages.map((_, i) => ({ role: "user", content: `branch-${i}` }));
      expect(text(h.viewer)).not.toContain("message-");
      expect(text(h.viewer)).toContain("branch-1999");
      h.state.messages = [assistant("# Summary")];
      h.emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false });
      expect(text(h.viewer)).toBe("[Assistant]\nSummary");
      h.state.messages = [];
      expect(text(h.viewer)).toBe("(waiting for first message...)");
      h.state.messages.push({ role: "user", content: "new branch" });
      expect(text(h.viewer)).toBe("[User]\nnew branch");
    } finally { h.viewer.dispose(); }
  });

  it("keeps activity fresh independently of transcript events and removes it when settled", () => {
    const activity: AgentActivity = { activeTools: new Map(), responseText: "first activity", toolUses: 0, turnCount: 1 };
    const h = setup([assistant("Stable response")], plainTheme, activity);
    try {
      expect(text(h.viewer)).toContain("first activity");
      activity.responseText = "later activity";
      expect(text(h.viewer)).toContain("later activity");
      activity.activeTools.set("read-1", "read file.ts");
      expect(text(h.viewer)).toContain("read file.ts");
      h.record.status = "completed";
      expect(text(h.viewer)).toBe("[Assistant]\nStable response");
    } finally { h.viewer.dispose(); }
  });

  it("reflows Unicode/ANSI and all live Markdown modes without accumulating width variants", () => {
    const messages: Message[] = [assistant("# Heading\n\n**Bold** 日本語 👨‍👩‍👧‍👦 é\n\n```ts\nconst x = 1;\n```"),
      { role: "toolResult", content: [{ type: "text", text: "# result\n\x1b[32mgreen 日本語\x1b[0m" }] }];
    const h = setup(messages);
    try {
      for (const mode of ["off", "assistant", "all", "off"] as const) {
        h.setMode(mode);
        for (const width of [76, 17, 30, 76]) {
          const fresh = setup(messages);
          fresh.setMode(mode);
          try {
            expect(content(h.viewer, width)).toEqual(content(fresh.viewer, width));
            expect(content(h.viewer, width).every(line => visibleWidth(line) <= width)).toBe(true);
          } finally { fresh.viewer.dispose(); }
        }
      }
    } finally { h.viewer.dispose(); }
  });

  it("refreshes native Markdown caches on explicit invalidation and behind the same Pi theme Proxy", () => {
    themes.initTheme("dark", false);
    const proxy = themes.theme;
    const h = setup([assistant("# Heading\n\n```ts\nconst x = 1;\n```"),
      { role: "toolResult", content: [{ type: "text", text: "result" }] }], proxy);
    try {
      const dark = [...content(h.viewer)];
      h.viewer.invalidate();
      expect(content(h.viewer)).toEqual(dark);
      for (const appearance of ["light", "dark"]) {
        for (const colorMode of ["256", "truecolor"]) {
          themes.setThemeInstance(themes.loadThemeFromPath(new URL(`./${appearance}.json`, themeUrl).pathname, colorMode));
          expect(themes.theme).toBe(proxy);
          // Deliberately no invalidate() between native theme swaps.
          const fresh = setup(h.state.messages, proxy);
          try { expect(content(h.viewer)).toEqual(content(fresh.viewer)); }
          finally { fresh.viewer.dispose(); }
        }
      }
      themes.initTheme("light", false);
      expect(content(h.viewer)).not.toEqual(dark);

      // Changing only a syntax token leaves every ordinary Markdown probe
      // identical. Resolved color state must still invalidate fenced code.
      themes.initTheme("dark", false);
      const original = Reflect.get(globalThis, themeSymbols[0]);
      const colors = { ...original.colors, syntaxKeyword: { kind: "indexed", index: 201 } };
      const keywordTheme = new Proxy(original, {
        get(target, property) {
          if (property === "colors") return colors;
          if (property === "fg") return (color: string, value: string) => color === "syntaxKeyword"
            ? `\x1b[38;5;201m${value}\x1b[39m` : target.fg(color, value);
          return Reflect.get(target, property);
        },
      });
      content(h.viewer); // warm the original dark fenced code
      themes.setThemeInstance(keywordTheme);
      const fresh = setup(h.state.messages, proxy);
      try {
        expect(content(h.viewer)).toEqual(content(fresh.viewer));
        expect(content(h.viewer).join("\n")).toContain("\x1b[38;5;201m");
      } finally { fresh.viewer.dispose(); }
    } finally { h.viewer.dispose(); }
  });

  it("releases cached layout and subscriptions on idempotent teardown, ignoring late events", () => {
    const h = setup([assistant("cached")]);
    h.viewer.render(80);
    h.viewer.dispose();
    h.viewer.dispose();
    const internals = h.viewer as unknown as { layoutBlocks: unknown[]; layoutEnds: unknown[]; contentLines: string[] };
    expect(internals.layoutBlocks).toHaveLength(0);
    expect(internals.layoutEnds).toHaveLength(0);
    expect(internals.contentLines).toHaveLength(0);
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    vi.mocked(h.tui.requestRender).mockClear();
    h.emit({ type: "message_end", message: h.state.messages[0] as AgentSession["messages"][number] });
    expect(h.tui.requestRender).not.toHaveBeenCalled();
  });
});
