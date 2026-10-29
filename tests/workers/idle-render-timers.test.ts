import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/workers/agent-runner.js", async importOriginal => {
  const actual = await importOriginal<typeof Runner>();
  return { ...actual, runAgent: vi.fn() };
});

import type * as Runner from "../../src/workers/agent-runner.js";
import { runAgent } from "../../src/workers/agent-runner.js";
import workers from "../../src/workers/index.js";
import type { WidgetMode } from "../../src/workers/types.js";
import type { Theme } from "../../src/workers/ui/agent-widget.js";
import type { FleetUICtx } from "../../src/workers/ui/fleet-list.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let hermetic: Hermetic;
let boot: ReturnType<typeof makePi>;
let sessionManager: SessionManager;
let finish: (() => void) | undefined;
let overlay: Component | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  finish = undefined;
  overlay = undefined;
});
function setup(widgetMode: WidgetMode = "all") {
  hermetic = hermeticDir({ settings: { outputTranscript: false, rememberAgents: false, widgetMode, fleetView: true } });
  boot = makePi();
  sessionManager = SessionManager.inMemory(hermetic.dir);
  boot.pi.appendEntry.mockImplementation((type: string, data: unknown) => { sessionManager.appendCustomEntry(type, data); });
  boot.pi.sendMessage.mockImplementation((message: Parameters<ExtensionAPI["sendMessage"]>[0]) => {
    sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  });
  vi.mocked(runAgent).mockReset();
  workers(boot.pi);
}
afterEach(async () => {
  finish?.();
  overlay?.handleInput?.("\x1b");
  await drain();
  await boot.lifecycle.get("session_shutdown")?.();
  hermetic.restore();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("idle worker presentation timers (real extension, widget and fleet)", () => {
  for (const background of [false, true]) for (const failed of [false, true]) for (const keepViewer of [false, true]) {
    it(`stops redraw intervals after ${background ? "background" : "foreground"} ${failed ? "failure" : "completion"}, viewer=${keepViewer}`, async () => {
      setup();
      const requestRender = vi.fn();
      const onUpdate = vi.fn(() => requestRender()); // Native tool updates request a host frame too.
      const setStatus = vi.fn();
      const components = new Map<string, Component>();
      const inputs = new Set<(data: string) => { consume?: boolean } | undefined>();
      const tui = { mode: "regular", terminal: { columns: 120, rows: 40 }, requestRender };
      const theme: Theme = { fg: (_color, text) => text, bold: text => text };
      const setWidget: FleetUICtx["setWidget"] = vi.fn((key, factory) => {
        if (factory) components.set(key, factory(tui, theme));
        else components.delete(key);
        requestRender();
      });
      const custom: FleetUICtx["custom"] = factory => new Promise(resolve => {
        overlay = factory(tui, theme, undefined, resolve);
      });
      let idle = false;
      const parent = ctx({ sessionManager, hasUI: true, isIdle: () => idle, ui: {
        setWidget, setStatus, custom, notify: vi.fn(), getEditorText: () => "",
        onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
          inputs.add(handler);
          return () => { inputs.delete(handler); };
        },
      } });
      const session = { messages: [], dispose: vi.fn(), subscribe: () => () => {}, getActiveToolNames: () => [] };
      vi.mocked(runAgent).mockImplementation((_context, _prompt, options) => new Promise((resolve, reject) => {
        options?.onSessionCreated?.(session as never);
        finish = () => {
          if (failed) reject(new Error("Synthetic verification failure"));
          else resolve({ responseText: "All targeted checks pass.", session: session as never, aborted: false, steered: false });
        };
      }));
      await boot.lifecycle.get("session_start")({}, parent);
      const baselineTimers = vi.getTimerCount(); // The manager's non-rendering 60s record cleanup is intentional.
      await boot.lifecycle.get("tool_execution_start")({}, parent);
      const execution = boot.tools.get("Agent").execute("worker", {
        description: "Idle timer audit", prompt: "Synthetic task", run_in_background: background,
      }, undefined, onUpdate, parent);
      await drain();
      expect(components.has("agents")).toBe(true);
      expect(components.has("fleet")).toBe(true);
      expect(vi.getTimerCount()).toBe(baselineTimers + (background ? 2 : 3));
      requestRender.mockClear();
      onUpdate.mockClear();
      await vi.advanceTimersByTimeAsync(400);
      expect(requestRender).toHaveBeenCalled();
      if (!background) expect(onUpdate).toHaveBeenCalledTimes(5); // The real 80ms foreground spinner ran.

      if (keepViewer) {
        const press = (key: string) => { for (const handler of inputs) if (handler(key)?.consume) break; };
        press("\x1b[B"); press("\x1b[B"); press("\r");
        expect(overlay).toBeDefined();
      }
      finish!();
      await execution;
      await drain();
      // The above-editor completion linger is turn-aged (one success/two error
      // turns), while FleetList's linger is wall-clock aged (four seconds).
      await boot.lifecycle.get("tool_execution_start")({}, parent);
      await boot.lifecycle.get("tool_execution_start")({}, parent);
      idle = true;
      await boot.lifecycle.get("agent_settled")({}, parent);
      await vi.advanceTimersByTimeAsync(5000);
      expect(components.has("agents")).toBe(false);
      expect(components.has("fleet")).toBe(keepViewer); // Viewing retains the static row, not an animation.
      const retained = components.get("fleet")?.render(120);
      requestRender.mockClear();
      onUpdate.mockClear();
      vi.mocked(setWidget).mockClear();
      setStatus.mockClear();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(requestRender).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
      expect(setWidget).not.toHaveBeenCalled();
      expect(setStatus).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(baselineTimers);
      if (keepViewer) expect(components.get("fleet")?.render(120)).toEqual(retained);
    });
  }
});

it("discovers a delayed background session beside a viewed result with the above-editor widget off", async () => {
  setup("off");
  const requestRender = vi.fn();
  const components = new Map<string, Component>();
  const inputs = new Set<(data: string) => { consume?: boolean } | undefined>();
  const tui = { mode: "regular", terminal: { columns: 120, rows: 40 }, requestRender };
  const theme: Theme = { fg: (_color, text) => text, bold: text => text };
  const setWidget = vi.fn<FleetUICtx["setWidget"]>((key, factory) => {
    if (factory) components.set(key, factory(tui, theme));
    else components.delete(key);
  });
  const custom: FleetUICtx["custom"] = factory => new Promise(resolve => {
    overlay = factory(tui, theme, undefined, resolve);
  });
  const parent = ctx({ sessionManager, hasUI: true, ui: {
    setWidget, custom, setStatus: vi.fn(), notify: vi.fn(), getEditorText: () => "",
    onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
      inputs.add(handler); return () => { inputs.delete(handler); };
    },
  } });
  const session = { messages: [], dispose: vi.fn(), subscribe: () => () => {}, getActiveToolNames: () => [] };
  let createSession: (() => void) | undefined;
  let delaySession = false;
  vi.mocked(runAgent).mockImplementation((_context, _prompt, options) => new Promise(resolve => {
    createSession = () => options?.onSessionCreated?.(session as never);
    if (!delaySession) createSession();
    finish = () => resolve({ responseText: "Done.", session: session as never, aborted: false, steered: false });
  }));
  await boot.lifecycle.get("session_start")({}, parent);
  const baselineTimers = vi.getTimerCount();
  const tool = boot.tools.get("Agent");
  await tool.execute("first", { description: "Viewed result", prompt: "Synthetic task", run_in_background: true }, undefined, undefined, parent);
  await drain();
  const press = (key: string) => { for (const handler of inputs) if (handler(key)?.consume) break; };
  press("\x1b[B"); press("\x1b[B"); press("\r");
  expect(overlay).toBeDefined();
  finish!();
  await drain();
  await boot.lifecycle.get("agent_settled")({}, parent);
  await vi.advanceTimersByTimeAsync(5000);
  expect(components.has("agents")).toBe(false);
  expect(components.get("fleet")?.render(120).join("\n")).toContain("Viewed result");
  expect(vi.getTimerCount()).toBe(baselineTimers);

  delaySession = true;
  await tool.execute("delayed", { description: "Delayed background worker", prompt: "Synthetic task", run_in_background: true }, undefined, undefined, parent);
  await drain();
  expect(components.has("agents")).toBe(false);
  expect(components.get("fleet")?.render(120).join("\n")).not.toContain("Delayed background worker");
  expect(vi.getTimerCount()).toBe(baselineTimers + 1);
  await vi.advanceTimersByTimeAsync(1000);
  createSession!(); // Real background session-created wiring does not rearm FleetList.
  requestRender.mockClear();
  await vi.advanceTimersByTimeAsync(200);
  expect(requestRender).toHaveBeenCalledTimes(1);
  expect(components.get("fleet")?.render(120).join("\n")).toContain("Delayed background worker");
  expect(components.has("agents")).toBe(false);
  finish!();
  await drain();
  await boot.lifecycle.get("agent_settled")({}, parent);
  await vi.advanceTimersByTimeAsync(5000);
  expect(vi.getTimerCount()).toBe(baselineTimers);
  requestRender.mockClear();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(requestRender.mock.calls).toHaveLength(0);
});
