import { Editor, type OverlayOptions, type TuiMode, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../../src/workers/agent-manager.js";
import type { AgentRecord, ViewerMarkdownMode } from "../../src/workers/types.js";
import { type AgentActivity } from "../../src/workers/ui/agent-widget.js";
import type { ViewerBackgroundAction } from "../../src/workers/ui/conversation-viewer.js";
import {
  FleetList,
  type FleetUICtx,

  formatFleetElapsed,
  formatFleetTokens,
} from "../../src/workers/ui/fleet-list.js";

// ---- Key sequences (see node_modules/@earendil-works/pi-tui/dist/keys.js) ----
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ESC = "\x1b";
const ENTER = "\r";
// Kitty-protocol key-RELEASE for ↓ (event type 3) — listeners receive these too.
const DOWN_RELEASE = "\x1b[1;1:3B";

const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => `*${s}*` };

/**
 * Visible text of a rendered row: ANSI stripped, along with this theme's fake
 * `<color>` / `*bold*` markers — all three stand in for zero-width escapes.
 */
function plain(row: string): string {
  return row.replace(/\u001b\[[0-9;]*m/g, "").replace(/<\/?[a-zA-Z]+>|\*/g, "");
}

/** A no-op session so a record is "openable" by default (the list hides session-less agents). */
const FAKE_SESSION = { subscribe: () => () => {}, messages: [] };

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",

    description: "Sleep then report 1",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: FAKE_SESSION as any,
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

/** Fake manager exposing only what FleetList touches. */
function fakeManager(agents: AgentRecord[]): AgentManager {
  return {
    listAgents: () => agents,
    abort: () => true,
    steer: vi.fn(() => true),
  } as unknown as AgentManager;
}

interface Harness {
  fleet: FleetList;
  ui: FleetUICtx;
  manager: AgentManager;

  /** Notices the fleet pushed through `ui.notify`, as `level: message`. */
  notices: () => string[];
  /** The overlay component (a real ConversationViewer) once one is opened. */
  overlayComponent: () => { handleInput(data: string): void } | undefined;
  /** Overlay options resolved after the custom factory runs. */
  overlayOptions: () => OverlayOptions | undefined;
  /** Feed a key to the registered input handler; returns the consume result. */
  press: (data: string) => { consume?: boolean } | undefined;
  /** Render the currently-registered below-editor widget at the given width. */
  render: (width?: number) => string[];
  setEditorText: (t: string) => void;
  /** Whether an overlay has been opened. */
  overlayOpened: () => boolean;
  /** Whether the most recently opened overlay's `done` was invoked (closed). */
  overlayClosed: () => boolean;
  /** Simulate the viewer closing itself (Esc → done); flushes the close microtask. */
  closeOverlay: () => Promise<void>;
  /** The fake `tui` handed to the widget factory; tests set `focusedComponent` on it. */
  widgetTui: { requestRender(): void; focusedComponent?: unknown };
}

function harness(
  agents: AgentRecord[],
  opts: {
    tuiMode?: TuiMode;
    viewerMarkdown?: () => ViewerMarkdownMode;
    onViewerMarkdown?: (mode: ViewerMarkdownMode) => void;
    backgroundAction?: (record: AgentRecord, notify: (message: string) => void) => ViewerBackgroundAction;
  } = {},
): Harness {
  const notices: string[] = [];
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let widgetFactory: ((tui: any, theme: any) => { render(w: number): string[] }) | undefined;
  let editorText = "";
  let opened = false;
  let closed = false;
  let overlayDone: ((r: undefined) => void) | undefined;
  let overlayComponent: { handleInput(data: string): void } | undefined;
  let overlayOptions: OverlayOptions | undefined;
  const fakeTui = { mode: opts.tuiMode ?? "regular", handleMouse: () => undefined, requestRender: () => {}, terminal: { columns: 120, rows: 40 } };

  const ui: FleetUICtx = {
    setWidget: (_key, content) => { widgetFactory = content as any; },
    onTerminalInput: (h) => { inputHandler = h; return () => { inputHandler = undefined; }; },
    getEditorText: () => editorText,
    notify: (message, level) => { notices.push(`${level}: ${message}`); },
    custom: ((factory: any, options?: { overlayOptions?: OverlayOptions | (() => OverlayOptions) }) => {
      opened = true;
      return new Promise<undefined>((resolve) => {
        const done = (r: undefined) => { closed = true; overlayDone = undefined; resolve(r); };
        overlayDone = done;
        // Construct the overlay component so the controller wires viewerClose,
        // and keep it so tests can drive the real ConversationViewer's input.
        overlayComponent = factory(fakeTui, theme, undefined, done);
        overlayOptions = typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
      });
    }) as FleetUICtx["custom"],
  };

  const manager = fakeManager(agents);
  const fleet = new FleetList(manager, new Map(), undefined, opts.viewerMarkdown, opts.onViewerMarkdown, undefined, opts.backgroundAction);
  fleet.setUICtx(ui);

  fleet.update();

  return {
    fleet,

    ui,
    manager,
    notices: () => notices,
    overlayComponent: () => overlayComponent,
    overlayOptions: () => overlayOptions,
    press: (data) => inputHandler?.(data),
    render: (width = 120) => (widgetFactory ? widgetFactory(fakeTui, theme).render(width) : []),
    setEditorText: (t) => { editorText = t; },
    overlayOpened: () => opened,
    overlayClosed: () => closed,
    closeOverlay: async () => { overlayDone?.(undefined); await Promise.resolve(); },
    widgetTui: fakeTui,
  };
}

describe("formatFleetElapsed", () => {
  it("renders integer seconds (no decimal, no suffix)", () => {
    expect(formatFleetElapsed(0)).toBe("0s");
    expect(formatFleetElapsed(11_000)).toBe("11s");
    expect(formatFleetElapsed(11_400)).toBe("11s");
    expect(formatFleetElapsed(11_600)).toBe("12s");
  });
  it("floors negatives to 0s", () => {
    expect(formatFleetElapsed(-500)).toBe("0s");
  });
});

describe("formatFleetTokens", () => {
  it("prefixes a down-arrow and uses plural 'tokens'", () => {
    expect(formatFleetTokens(13_100)).toBe("↓ 13.1k tokens");
    expect(formatFleetTokens(950)).toBe("↓ 950 tokens");
    expect(formatFleetTokens(1_200_000)).toBe("↓ 1.2M tokens");
  });
});

describe("FleetList navigation", () => {
  it("does not register a widget when there are no agents", () => {
    const h = harness([]);
    expect(h.render()).toEqual([]);
  });

  it("activates on ↓ at an empty prompt, consuming the key", () => {
    const h = harness([makeRecord()]);
    const res = h.press(DOWN);
    expect(res).toEqual({ consume: true });
    // main selected, list active → nav hint shown
    expect(h.render().some(l => l.includes("enter view"))).toBe(true);
  });

  it("also activates on ← (matches the '← for agents' hint)", () => {
    const h = harness([makeRecord()]);
    expect(h.press(LEFT)).toEqual({ consume: true });
  });

  it("does NOT activate when the prompt is non-empty (typing is preserved)", () => {
    const h = harness([makeRecord()]);
    h.setEditorText("hello");
    expect(h.press(DOWN)).toBeUndefined();
  });

  it("ignores key-release events so one tap moves exactly one row", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.press(DOWN);          // activate → selection on main (idx 0)
    h.press(DOWN_RELEASE);  // release half of the SAME tap — must be a no-op
    expect(h.render().find(l => l.includes("main"))).toContain("●");
    h.press(DOWN);          // a real second tap → first agent
    h.press(DOWN_RELEASE);
    expect(h.render().find(l => l.includes("one"))).toContain("●");
    expect(h.render().find(l => l.includes("two"))).toContain("○");
  });

  it("renders the whole selected row in the theme's primary text color (#230)", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.press(DOWN); // activate → main
    h.press(DOWN); // → a1
    const selected = h.render().find(l => l.includes("one"))!;
    // Selection marker keeps accent color; row content uses primary text color.
    expect(selected).toContain("<accent>●</accent>");
    expect(selected).toContain("<text>one</text>");
    expect(selected).toMatch(/<text>\d+s · ↓ [\d.]+k? tokens<\/text>/);
    expect(plain(selected).match(/one/g)).toHaveLength(1);
    expect(selected).not.toMatch(/general-purpose|\(twin\)/);
    // Inactive rows keep the muted/dim treatment.
    const unselected = h.render().find(l => l.includes("two"))!;
    expect(unselected).toContain("<dim>○</dim>");
    expect(unselected).toMatch(/<dim>\d+s · ↓ [\d.]+k? tokens<\/dim>/);
    expect(unselected).not.toContain("<text>");
  });

  it("keeps the goal in the same column when selection changes", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "Review auth" }),
      makeRecord({ id: "a2", description: "Review tests" }),
    ]);
    h.press(DOWN);
    const before = h.render().find(line => line.includes("Review auth"))!;
    h.press(DOWN);
    const selected = h.render().find(line => line.includes("Review auth"))!;
    expect(plain(selected).indexOf("Review auth")).toBe(plain(before).indexOf("Review auth"));
    expect(plain(selected).match(/Review auth/g)).toHaveLength(1);
    expect(selected).toContain("<text>Review auth</text>");
    expect(selected).not.toMatch(/\u001b\[(?:48|49)/);
  });

  it("moves selection down/up and clamps at the ends", () => {
    const agents = [
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ];
    const h = harness(agents);
    h.press(DOWN); // activate → index 0 (main)
    h.press(DOWN); // → 1 (a1)
    expect(h.render().find(l => l.includes("one"))).toContain("●");
    h.press(DOWN); // → 2 (a2)
    h.press(DOWN); // clamp at 2
    expect(h.render().find(l => l.includes("two"))).toContain("●");
    expect(h.render().find(l => l.includes("one"))).toContain("○");
  });

  it("↑ above 'main' deactivates (returns to the prompt)", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN); // activate, index 0
    expect(h.press(UP)).toEqual({ consume: true });
    // back to inactive hint
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("Esc deactivates", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press(ESC)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("passes non-nav keys through and cancels navigation", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press(RIGHT)).toBeUndefined();
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("ignores all input while disabled and hides the widget", () => {
    const h = harness([makeRecord()]);
    h.fleet.setEnabled(false);
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.render()).toEqual([]);
  });

  it("re-arms the refresh timer when the list is re-shown (toggle off→on)", () => {
    vi.useFakeTimers();
    try {
      const agents = [makeRecord({ id: "a1" })];
      const listAgents = vi.fn(() => agents);
      const manager = { listAgents, abort: () => true } as unknown as AgentManager;
      const fleet = new FleetList(manager, new Map());
      fleet.setUICtx({
        setWidget: () => {}, onTerminalInput: () => () => {}, getEditorText: () => "",
        notify: () => {}, custom: (() => new Promise<undefined>(() => {})) as FleetUICtx["custom"],
      });
      fleet.update();          // shows list, arms the timer
      fleet.setEnabled(false); // hides, clears the timer
      fleet.setEnabled(true);  // re-shows — must re-arm the timer
      const before = listAgents.mock.calls.length;
      vi.advanceTimersByTime(250); // a tick should fire and re-read the roster
      expect(listAgents.mock.calls.length).toBeGreaterThan(before);
      fleet.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FleetList vs other focused components (#123)", () => {
  // pi dispatches terminal input to extension listeners BEFORE the focused
  // component (pi-tui TUI.handleInput), and ctx.ui.select/confirm/input swap
  // the prompt editor out of the editor container while getEditorText() still
  // reads the detached (empty) editor. So while another component owns the
  // keyboard — another extension's selector (rpiv-ask-user-question), pi's own
  // menus, our /agents settings — the list must not consume its keys.

  /** A minimal real Editor — what pi focuses at the prompt (CustomEditor extends it). */
  function realEditor(): Editor {
    const fakeTui = { requestRender: () => {} };
    const theme = { borderColor: (s: string) => s, selectList: {} };
    return new Editor(fakeTui as any, theme as any);
  }

  /** Hand the fleet list its `tui` (happens on first widget render in pi) with the given focus. */
  function focusInHarness(h: Harness, focused: unknown): void {
    h.widgetTui.focusedComponent = focused;
    h.render();
  }

  it("does not steal ↓ from a focused selector (activation)", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, { kind: "selector" }); // e.g. ExtensionSelectorComponent
    expect(h.press(DOWN)).toBeUndefined(); // must flow through to the selector
  });

  it("does not steal navigation keys from a selector opened while the list was active", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true }); // activate at the prompt
    focusInHarness(h, { kind: "selector" });          // a dialog takes focus
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.press(ENTER)).toBeUndefined();
    expect(h.press(ESC)).toBeUndefined();
    // and the list dropped back to its inactive hint
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("still activates when the prompt editor has focus", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true });
  });

  it("activates under another extension's editor that is not an Editor subclass (#374)", () => {
    // ui.setEditorComponent accepts any EditorComponent; pi-voice-stt's
    // VoiceEditorWrapper implements the interface without extending Editor.
    const h = harness([makeRecord()]);
    focusInHarness(h, {
      render: () => [], invalidate: () => {}, handleInput: () => {},
      getText: () => "", setText: () => {},
    });
    expect(h.press(DOWN)).toEqual({ consume: true });
  });

  it("does not steal ↓ from a selector that handles input but holds no text (#374)", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, { render: () => [], invalidate: () => {}, handleInput: () => {} });
    expect(h.press(DOWN)).toBeUndefined();
  });

  it("assumes the editor when focus is unknowable (no tui yet / nothing focused)", () => {
    const h = harness([makeRecord()]);
    // No render yet → the list has never seen a tui: activation must still work.
    expect(h.press(DOWN)).toEqual({ consume: true });
  });
});

describe("FleetList rendering", () => {
  it("renders main + agent rows with one goal label and right-aligned stats", () => {
    const h = harness([makeRecord({ description: "Sleep then report 1" })]);
    const lines = h.render(120);
    // hint + blank + main + one agent + blank
    expect(lines[0]).toContain("← for agents");
    expect(lines.find(l => l.includes("main"))).toContain("●"); // main selected by default
    const agentLine = lines.find(l => l.includes("Sleep then report 1"))!;
    expect(agentLine).toContain("○");
    expect(plain(agentLine).match(/Sleep then report 1/g)).toHaveLength(1);
    expect(agentLine).not.toMatch(/general-purpose|\(twin\)/);
    expect(agentLine).toContain("↓ 13.1k tokens");
    expect(agentLine).toMatch(/\d+s · ↓/); // "<seconds>s · ↓ ..." (timing-agnostic)
  });

  it("orders agents earliest-launched first (top)", () => {
    const agents = [
      makeRecord({ id: "new", description: "newest", startedAt: 2000 }),
      makeRecord({ id: "old", description: "oldest", startedAt: 1000 }),
    ];
    const lines = harness(agents).render();
    const oldIdx = lines.findIndex(l => l.includes("oldest"));
    const newIdx = lines.findIndex(l => l.includes("newest"));
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeLessThan(newIdx); // earliest sits above the later one
  });

  it("hides agents that have no session yet (pending)", () => {
    const agents = [
      makeRecord({ id: "live", description: "running one" }),
      makeRecord({ id: "pending", description: "queued one", status: "queued", session: undefined }),
    ];
    const lines = harness(agents).render();
    expect(lines.some(l => l.includes("running one"))).toBe(true);
    expect(lines.some(l => l.includes("queued one"))).toBe(false);
  });

  it("collapses overflow into a '↓ N more' indicator", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    const lines = h.render(120);
    // 8 agents, cap 5 visible → "↓ 3 more"
    expect(lines.some(l => l.includes("↓ 3 more"))).toBe(true);
  });

  it("ends with a blank spacer so the last row clears pi's footer (#351)", () => {
    const one = harness([makeRecord({ description: "only agent" })]).render(120);
    expect(one.at(-1)).toBe("");
    expect(one.at(-2)).toContain("only agent");

    const many = harness(Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }))).render(120);
    expect(many.at(-1)).toBe("");
    expect(many.at(-2)).toContain("↓ 3 more");
  });

  it("never emits a line wider than the terminal (guards wrap-induced flicker)", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `a very long agent description number ${i} that keeps going` }));
    const h = harness(agents);
    for (const w of [4, 8, 12, 20, 40, 80, 200]) {
      for (const line of h.render(w)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      }
    }
  });

  it("windows the visible agents so the selection stays on screen", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    h.press(DOWN); // activate (main)
    // step down to the last agent (8 agents → roster index 8)
    for (let i = 0; i < 8; i++) h.press(DOWN);
    const lines = h.render(120);
    expect(lines.find(l => l.includes("report 7"))).toContain("●");
    expect(lines.some(l => l.includes("↑"))).toBe(true); // hidden-above indicator
  });
});

describe("FleetList overlay lifecycle", () => {
  it.each<{ mode: TuiMode; expected: OverlayOptions }>([
    { mode: "regular", expected: { anchor: "center", width: "90%", maxHeight: "70%" } },
    { mode: "fullscreen", expected: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } },
  ])("opens the agent viewer with options for the active $mode TUI", async ({ mode, expected }) => {
    const h = harness([makeRecord()], { tuiMode: mode });
    try {
      h.press(DOWN); // activate (main)
      h.press(DOWN); // select the agent
      h.press(ENTER);

      expect(h.overlayOptions()).toEqual(expected);
    } finally {
      await h.closeOverlay();
      h.fleet.dispose();
    }
  });

  it("Enter on 'main' just deactivates (no overlay)", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN); // active, index 0 (main)
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(false); // never opened an overlay
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("keeps the cursor on the viewed agent after closing, even if the list reordered", async () => {
    const fakeSession = { subscribe: () => () => {}, messages: [] };
    const agents = [
      makeRecord({ id: "a1", description: "one", session: fakeSession as any }),
      makeRecord({ id: "a2", description: "two", session: fakeSession as any }),
      makeRecord({ id: "a3", description: "three", session: fakeSession as any }),
    ];
    const h = harness(agents);
    h.press(DOWN); // activate (main, idx 0)
    h.press(DOWN); // a1 (idx 1)
    h.press(DOWN); // a2 (idx 2)
    h.press(ENTER); // open a2
    // a1 finishes and drops out while viewing → a2 shifts from idx 2 to idx 1.
    agents.splice(0, 1);
    await h.closeOverlay();
    // Selection follows a2 ("two") to its new position, not whatever is at idx 2 now.
    expect(h.render().find(l => l.includes("two"))).toContain("●");
    expect(h.render().find(l => l.includes("three"))).toContain("○");
  });

  it("wires the viewer's b to the extension's action for that row, notifying through the session UI", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const backgroundAction = vi.fn((record: AgentRecord, notify: (message: string) => void) => ({
      available: () => true,
      send: () => notify(`sent ${record.id}`),
    }));
    const h = harness(agents, { backgroundAction });
    h.press(DOWN);  // activate (main)
    h.press(DOWN);  // → the agent
    h.press(ENTER); // open the conversation viewer

    expect(backgroundAction).toHaveBeenCalledWith(agents[0], expect.any(Function));
    h.overlayComponent()!.handleInput("b");
    expect(h.notices()).toEqual(["info: sent live"]);
  });

  it("offers no b when the extension supplies no action", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(DOWN);
    h.press(DOWN);
    h.press(ENTER);

    expect(() => h.overlayComponent()!.handleInput("b")).not.toThrow();
    expect(h.notices()).toEqual([]);
  });

  it("wires the viewer's steer composer to manager.steer with the agent id", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(DOWN);  // activate (main)
    h.press(DOWN);  // → the agent
    h.press(ENTER); // open the conversation viewer

    const viewer = h.overlayComponent();
    expect(viewer).toBeDefined();
    viewer!.handleInput("\r");                       // Enter → open composer
    for (const ch of "go left") viewer!.handleInput(ch);
    viewer!.handleInput("\r");                       // Enter → send

    expect(h.manager.steer).toHaveBeenCalledWith("live", "go left");
  });

  it("hands the viewer the user's markdown setting, and persists a mode chosen with m", () => {
    const persisted: ViewerMarkdownMode[] = [];
    const h = harness([makeRecord({ id: "live", description: "the one" })], {
      viewerMarkdown: () => "all",
      onViewerMarkdown: (mode) => persisted.push(mode),
    });
    h.press(DOWN);  // activate (main)
    h.press(DOWN);  // → the agent
    h.press(ENTER); // open the conversation viewer

    h.overlayComponent()!.handleInput("m");

    // "all" → "off" proves the cycle started from the *setting*; the viewer's own
    // fallback would have started at "assistant" and landed on "all". A recorded
    // value at all proves the persist hook is wired, as it is from /agents.
    expect(persisted).toEqual(["off"]);
  });

  it("does NOT auto-close when the viewed agent finishes (final output stays readable)", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(DOWN); // active (main)
    h.press(DOWN); // → the agent
    h.press(ENTER); // opens overlay
    expect(h.overlayOpened()).toBe(true);
    // The agent finishes, well past the linger window...
    agents[0] = makeRecord({ id: "live", description: "the one", status: "completed", completedAt: Date.now() - 60_000 });
    h.fleet.onAgentFinished("live");
    expect(h.overlayClosed()).toBe(false);                          // viewer stays open
    expect(h.render().some(l => l.includes("the one"))).toBe(true); // and stays listed while viewed
  });

  it("lingers a finished agent in the list, then drops it after the window", () => {
    const recent = makeRecord({ id: "r", description: "recent done", status: "completed", completedAt: Date.now() });
    expect(harness([recent]).render().some(l => l.includes("recent done"))).toBe(true);
    const old = makeRecord({ id: "o", description: "old done", status: "completed", completedAt: Date.now() - 60_000 });
    expect(harness([old]).render().some(l => l.includes("old done"))).toBe(false);
  });
});

describe("FleetList cost display", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function row(showCost: boolean, cost: number, activity?: Map<string, AgentActivity>): string {
    const record = makeRecord({ lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0, cost } });
    const fleet = new FleetList(fakeManager([record]), activity ?? new Map(), () => showCost);
    let factory: any;
    fleet.setUICtx({
      setWidget: (_k: string, c: any) => { factory = c; },
      onTerminalInput: () => () => {},
      getEditorText: () => "",
      notify: () => {},
      custom: (() => new Promise(() => {})) as any,
    } as any);
    fleet.update();
    return factory({ requestRender: () => {}, terminal: { columns: 120, rows: 40 } }, theme).render(120).join("\n");
  }

  it("appends the cost after the token count when enabled", () => {
    const out = row(true, 0.0042);
    expect(out).toContain("13.1k tokens");
    expect(out).toContain("~$0.0042");
  });

  it("shows no cost when disabled, and none for an unpriced model", () => {
    expect(row(false, 0.0042)).not.toContain("$");
    expect(row(true, 0)).not.toContain("$");
  });

  it("reads the record, so the figures do not change when the agent finishes", () => {
    // Spend used to come from the live activity tracker while an agent ran and
    // from its record once the tracker was deleted. The lifetime record must
    // remain the source of truth on both sides of completion.
    // The stale shape on purpose: an activity entry carrying figures of its own
    // is what the old fallback preferred, so a row that still renders the
    // record's numbers proves the tracker is no longer consulted for spend.
    const tracked = new Map<string, AgentActivity>([["a1", {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1,
      lifetimeUsage: { input: 1, output: 1, cacheWrite: 0, cost: 0.9 },
    } as unknown as AgentActivity]]);

    expect(row(true, 0.0042, tracked)).toBe(row(true, 0.0042));
  });
});

describe("FleetList empty roster and overlay isolation", () => {
  it("does not consume activation keys with no workers", () => {
    expect(harness([]).press(DOWN)?.consume).toBeFalsy();
  });

  it("clears the widget when the last worker leaves", () => {
    const agents = [makeRecord()];
    const h = harness(agents);
    expect(h.render().length).toBeGreaterThan(0);
    agents.length = 0;
    h.fleet.update();
    expect(h.render()).toEqual([]);
  });

  it("does not steal navigation while a worker viewer is open", async () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    h.press(DOWN);
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(true);
    expect(h.press(DOWN)?.consume).toBeFalsy();

    expect(h.press(ENTER)?.consume).toBeFalsy();
    await h.closeOverlay();
    expect(h.render().find(line => line.includes("Sleep then report 1"))).toContain("●");
    h.fleet.dispose();
  });

});
