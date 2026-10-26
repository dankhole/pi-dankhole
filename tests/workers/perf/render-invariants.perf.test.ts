/**
 * render-invariants.perf.test.ts — the shape of the render paths, asserted as
 * operation counts rather than as time.
 *
 * These run in the normal suite, which means they run three times per CI push
 * (build, floor-Pi, latest-Pi) on shared runners. A wall-clock threshold there
 * would be a flake generator: two runs of identical code in this repo differed
 * by 7% on ordering alone. So nothing here is timed. Counting how many times a
 * render reaches a leaf is deterministic, costs milliseconds, and catches the
 * regression that actually hurts — work that stops being linear, or a frame
 * that starts touching the disk.
 *
 * Absolute numbers live in `test/perf/*.bench.ts`, where a human reads them.
 *
 * Every bound here is an upper bound, never an equality: making one of these
 * paths cheaper must not turn a test red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Counters for the pi-tui leaves the viewer wraps its text with. */
const counts = { wrap: 0, markdownNew: 0, markdownRender: 0, truncate: 0 };

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  class CountingMarkdown extends actual.Markdown {
    constructor(...args: ConstructorParameters<typeof actual.Markdown>) {
      super(...args);
      counts.markdownNew++;
    }
    render(width: number) {
      counts.markdownRender++;
      return super.render(width);
    }
  }
  return {
    ...actual,
    Markdown: CountingMarkdown,
    truncateToWidth: (...args: Parameters<typeof actual.truncateToWidth>) => {
      counts.truncate++;
      return actual.truncateToWidth(...args);
    },
    wrapTextWithAnsi: (...args: [string, number]) => {
      counts.wrap++;
      return actual.wrapTextWithAnsi(...args);
    },
  };
});

// After the mock, so the subjects bind the counting versions.
const { AgentWidget } = await import("../../../src/workers/ui/agent-widget.js");
const { ConversationViewer } = await import("../../../src/workers/ui/conversation-viewer.js");
const { makeActivity, makeFleet, makeSession, mountViewer, perfTheme, perfTui } = await import(
  "../helpers/perf-fixtures.js"
);

beforeEach(() => {
  counts.wrap = 0;
  counts.markdownNew = 0;
  counts.markdownRender = 0;
  counts.truncate = 0;
});

describe("ConversationViewer — stable blocks and history layout", () => {
  function resetCounts() {
    counts.wrap = counts.markdownNew = counts.markdownRender = counts.truncate = 0;
  }

  it.each(["off", "assistant", "all"])("does no historical wrapping/parsing/clamping on unchanged frames or scroll (%s)", mode => {
    for (const n of [30, 300, 2000]) {
      const viewer = mountViewer(ConversationViewer, makeSession(n), undefined, () => mode);
      try {
        viewer.render(120);
        resetCounts();
        viewer.render(120);
        viewer.handleInput("\x1b[A");
        viewer.render(120);
        viewer.handleInput("\x1b[5~");
        viewer.render(120);

        expect(counts.wrap + counts.markdownRender + counts.markdownNew).toBe(0);
        // Only visible rows/chrome, independent of transcript size. Three renders.
        expect(counts.truncate).toBeLessThanOrEqual(120);
      } finally {
        viewer.dispose();
      }
    }
  });

  it.each(["off", "assistant"])("lays out only the appended or mutated message (%s)", mode => {
    const session = makeSession(300);
    const viewer = mountViewer(ConversationViewer, session, undefined, () => mode);
    try {
      viewer.render(120);
      const message = { role: "assistant", content: [{ type: "text", text: "# New response" }] };
      session.messages.push(message);
      resetCounts();
      viewer.render(120);
      expect(counts.wrap + counts.markdownRender).toBeLessThanOrEqual(1);
      expect(counts.markdownNew).toBeLessThanOrEqual(1);

      // Same message, content array, block object, and string length; no event.
      message.content[0].text = "# New material";
      resetCounts();
      viewer.render(120);
      expect(counts.wrap + counts.markdownRender).toBeLessThanOrEqual(1);
      expect(counts.markdownNew).toBe(0);

      resetCounts();
      viewer.handleInput("\x1b[A");
      viewer.render(120);
      expect(counts.wrap + counts.markdownRender).toBe(0);
    } finally {
      viewer.dispose();
    }
  });

  it("invalidates the event's affected message, not unrelated history", () => {
    const session = makeSession(300);
    let emit: (event: unknown) => void = () => {};
    session.subscribe = (callback: typeof emit) => { emit = callback; return () => {}; };
    const viewer = mountViewer(ConversationViewer, session);
    try {
      viewer.render(120);
      session.messages[1].content[0].text += "\nstreamed delta";
      resetCounts();
      emit({ type: "message_update", message: session.messages[1] });
      viewer.render(120);
      expect(counts.wrap).toBe(0);
      expect(counts.markdownRender).toBeLessThanOrEqual(1);
      expect(counts.markdownNew).toBe(0);
    } finally {
      viewer.dispose();
    }
  });

  it("explicit invalidation also discards native Markdown's text/width cache", () => {
    const viewer = mountViewer(ConversationViewer, makeSession(30));
    try {
      viewer.render(120);
      resetCounts();
      viewer.invalidate();
      viewer.render(120);
      expect(counts.markdownNew).toBeGreaterThan(0);
      resetCounts();
      viewer.render(120);
      expect(counts.markdownNew + counts.markdownRender + counts.wrap).toBe(0);
    } finally {
      viewer.dispose();
    }
  });

  it("reuses surviving blocks across branch replacement and removes compacted layout", () => {
    const session = makeSession(300);
    const viewer = mountViewer(ConversationViewer, session);
    try {
      viewer.render(120);
      const survivor = session.messages[1];
      session.messages = [survivor];
      resetCounts();
      const output = viewer.render(120).join("\n");
      expect(output).toContain("(message 1)");
      expect(output).not.toContain("(result 299)");
      expect(counts.wrap + counts.markdownRender).toBe(0);

      resetCounts();
      viewer.render(100); // new width invalidates layout, not native component ownership
      expect(counts.markdownRender).toBeLessThanOrEqual(1);
      expect(counts.markdownNew).toBe(0);
      resetCounts();
      viewer.render(100);
      expect(counts.wrap + counts.markdownRender).toBe(0);
    } finally {
      viewer.dispose();
    }
  });
});

describe("AgentWidget — one frame does not rescan per agent", () => {
  /** Renders one frame over `n` agents; returns how often the manager was asked. */
  function listCallsPerRender(n: number): number {
    const records = makeFleet({ running: n });
    let listAgentsCalls = 0;
    const manager = {
      listAgents: () => {
        listAgentsCalls++;
        return records;
      },
    } as any;

    const widget = new AgentWidget(manager, makeActivity(records), () => "all", () => false, () => false);
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k: string, c: any) => { factory = c; } } as any);
    widget.update();
    const tui = perfTui();
    factory?.(tui, perfTheme).render(); // prime
    listAgentsCalls = 0;
    factory?.(tui, perfTheme).render();
    widget.dispose?.();
    return listAgentsCalls;
  }

  // Today a render is exactly one scan (`update()` does the other). The bound is
  // "a constant, and the same constant at 100 agents as at 1" — a per-agent
  // lookup added to the row builder would break it, and collapsing the two
  // remaining scans into one would not.
  it("asks the manager for the agent list a constant number of times", () => {
    expect(listCallsPerRender(1)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBe(listCallsPerRender(1));
  });
});
