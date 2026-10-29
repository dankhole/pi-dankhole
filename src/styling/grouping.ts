import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, MouseRegion, Spacer, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Settings } from "../settings/interface.ts";
import { toolBackground, toolStatus, toolStatusText } from "./palette.ts";
import { registerTranscriptProjection, TranscriptMeasurement } from "./transcript-measurement.ts";

// Pi 1.4's transcript container is not an extension API. Keep this adapter
// instance-local, fail open, and leave the native tree authoritative for updates,
// global expansion, thinking visibility, history rebuilds, and invalidation.
type NativeContainer = Container & { children: Component[] };
type NativeTool = Component & {
  toolName: string;
  toolCallId: string;
  expanded: boolean;
  isPartial: boolean;
  outputPad: number;
  result?: { isError?: boolean; content: Array<{ type: string }> };
  setExpanded(expanded: boolean): void;
  updateArgs(args: unknown): void;
  updateResult(result: unknown, partial?: boolean): void;
  markExecutionStarted(): void;
};
type Assistant = Component & {
  lastMessage?: { content: Array<{ type: string; text?: string; thinking?: string }>; stopReason?: string };
  setHideThinkingBlock(hidden: boolean): void;
  updateContent(message: unknown): void;
};

function container(value: unknown): value is NativeContainer {
  const item = value as NativeContainer | undefined;
  return !!item && Array.isArray(item.children) && typeof item.render === "function"
    && typeof item.handleMouse === "function" && typeof item.invalidate === "function"
    && typeof item.addChild === "function" && typeof item.clear === "function";
}

function tool(value: Component): value is NativeTool {
  const item = value as NativeTool;
  return typeof item.toolName === "string" && typeof item.toolCallId === "string"
    && typeof item.expanded === "boolean" && typeof item.isPartial === "boolean"
    && typeof item.outputPad === "number" && typeof item.setExpanded === "function"
    && typeof item.updateArgs === "function" && typeof item.updateResult === "function"
    && typeof item.markExecutionStarted === "function";
}

function transparent(value: Component): boolean {
  const item = value as Assistant;
  if (typeof item.setHideThinkingBlock !== "function" || typeof item.updateContent !== "function") return false;
  const message = item.lastMessage;
  if (!message || !Array.isArray(message.content) || ["error", "aborted", "length"].includes(message.stopReason ?? "")) return false;
  // Inspect semantic content, not rendered height: even hidden thinking breaks a run.
  return message.content.some(block => block.type === "toolCall") && message.content.every(block =>
    block.type === "toolCall" || block.type === "text" && !block.text?.trim()
    || block.type === "thinking" && !block.thinking?.trim());
}

function eligible(item: Component, settings: Settings): item is NativeTool {
  if (!tool(item) || item.toolName === "ask_user") return false;
  const mode = Object.hasOwn(settings.tools, item.toolName) ? settings.tools[item.toolName] : settings.defaultMode;
  // Images are owned outside renderCall/renderResult. Keep their entire native row
  // visible rather than risk concealing an attachment behind an incompatible shell.
  return mode === "compact" && !item.result?.content.some(block => block.type === "image");
}

/** Line offset of a direct native chat child in the current displayed transcript.
 * Grouped tool members are not projected top-level children and return undefined.
 * Calling this refreshes layout at width, including streaming changes.
 */
export function getChildLineOffset(chat: unknown, target: Component, width: number): number | undefined {
  if (!container(chat)) return undefined;
  return new TranscriptMeasurement().offsets(chat, width)?.get(target);
}

/** Measure all displayed direct children in one projection-aware pass. Refreshes the
 * projection once; callers can reuse their own per-pass component measurements.
 */
export function getChildLineOffsets(chat: unknown, width: number,
  measure?: (component: Component) => number): Map<Component, number> | undefined {
  if (!container(chat)) return undefined;
  const offsets = new TranscriptMeasurement().offsets(chat, width);
  if (!offsets || !measure) return offsets;
  let offset = 0;
  for (const child of offsets.keys()) {
    offsets.set(child, offset);
    offset += measure(child);
  }
  return offsets;
}

export interface GroupingOptions {
  theme: () => Theme;
  requestRender: () => void;
  warn: (message: string) => void;
  preserveFooter?: (heightChange: number, width: number) => void;
}

class ToolGroup implements Component {
  members: NativeTool[] = [];
  slots: Component[] = [];
  private view = new Container();
  private open = false;
  private expanded = false;
  private label = "";
  private status = toolStatus(false, false);
  private names: string[] = [];
  private summary = "";
  private readonly spacer = new Spacer(1);
  private readonly footer = new MouseRegion({
    invalidate() {},
    render: (available: number) => {
      if (available <= 0) return [];
      const theme = this.options.theme();
      const pad = " ".repeat(Math.min(this.members[0].outputPad, Math.max(0, available - 1)));
      let line = pad + truncateToWidth(this.label, available - pad.length);
      line = toolStatusText(theme, this.status, line + " ".repeat(Math.max(0, available - visibleWidth(line))));
      const background = toolBackground(theme, "", this.settings.backgrounds === "none" ? "none" : "status", this.status);
      if (background) line = background + line + "\x1b[49m";
      return [line];
    },
  }, event => {
    if (event.type !== "click" || event.button !== "left") return undefined;
    try {
      const before = this.view.render(event.width).length;
      this.open = !this.expanded;
      // Closing resets individually opened details; opening only reveals compact rows.
      if (this.expanded) for (const member of this.members) member.setExpanded(false);
      const after = this.render(event.width).length;
      this.options.preserveFooter?.(after - before, event.width);
      this.options.requestRender();
    } catch (error) { this.fail(error); }
    return { handled: true };
  });
  constructor(private options: GroupingOptions, private fail: (error: unknown) => void, private settings: Settings) {}

  update(members: NativeTool[], slots: Component[]) {
    // Group visibility is independent of native per-tool detail expansion.
    // Newly appended calls retain their own compact/native expansion state.
    if (members.length !== this.members.length || members.some((member, index) => member !== this.members[index])) this.members = members;
    if (slots.length !== this.slots.length || slots.some((slot, index) => slot !== this.slots[index])) this.slots = slots;
  }

  invalidate() { this.view.invalidate(); }

  render(width: number): string[] {
    let failed = 0;
    let pending = 0;
    let expanded = this.open;
    let namesChanged = this.names.length !== this.members.length;
    for (let index = 0; index < this.members.length; index++) {
      const member = this.members[index];
      if (member.result?.isError) failed++;
      if (member.isPartial) pending++;
      if (member.expanded) expanded = true;
      if (this.names[index] !== member.toolName) namesChanged = true;
    }
    if (namesChanged) {
      this.names = this.members.map(member => member.toolName);
      const counts = new Map<string, number>();
      for (const name of this.names) counts.set(name, (counts.get(name) ?? 0) + 1);
      this.summary = [...counts].map(([name, count]) => {
        const clean = stripVTControlCharacters(name).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
        return count > 1 ? `${clean} ×${count}` : clean;
      }).join(", ");
    }
    this.expanded = expanded;
    this.status = toolStatus(failed > 0, pending > 0);
    this.label = `${expanded ? "▴" : "▸"} ${failed ? "✗" : pending ? "●" : "✓"} ${this.members.length} tools · ${this.summary}`
      + (failed ? ` · ${failed} failed` : "") + (pending ? ` · ${pending} pending` : "");
    const count = (expanded ? this.slots.length : 0) + 2;
    if (this.view.children.length !== count || this.view.children[0] !== (expanded ? this.slots[0] : this.spacer)
      || expanded && this.slots.some((slot, index) => slot !== this.view.children[index])) {
      this.view.children = [...(expanded ? this.slots : []), this.spacer, this.footer];
    }
    return this.view.render(width);
  }

  handleMouse(event: TuiMouseEvent) { return this.view.handleMouse(event); }
}

/** Install against Pi 1.4's real layout, or warn and leave rendering unchanged. */
export function installGrouping(tui: unknown, settings: Settings, options: GroupingOptions): () => void {
  if (!settings.groupConsecutive) return () => {};
  const roots = (tui as { children?: unknown[] } | undefined)?.children;
  const document = roots?.[0];
  if (!container(document) || document.children.length !== 3 || !document.children.every(container)) {
    options.warn("Compact tools: grouping unavailable for this Pi transcript layout; keeping individual rows.");
    return () => {};
  }
  const chat = document.children[2] as NativeContainer;
  const groupOptions: GroupingOptions = {
    ...options,
    preserveFooter: options.preserveFooter ?? ((heightChange, width) => {
      // In fullscreen scrollback, keep the clicked footer at its screen position
      // while rows appear/disappear above it. Follow-end already anchors naturally.
      type Scroll = NativeContainer & {
        primary: boolean; isFollowingEnd: boolean; scrollTop: number; viewportHeight: number;
        updateLayout(height: number, viewport: number, requestRender: () => void): void;
        scrollTo(offset: number, options: { disableFollow: boolean }): void;
      };
      const root = (tui as { layoutRoot?: { children?: Component[] } }).layoutRoot;
      const scroll = root?.children?.find(child => container(child) && child.children[0] === document
        && (child as Scroll).primary && typeof (child as Scroll).updateLayout === "function"
        && typeof (child as Scroll).scrollTo === "function") as Scroll | undefined;
      if (!scroll || scroll.isFollowingEnd || !heightChange) return;
      const previousTop = scroll.scrollTop;
      scroll.updateLayout(document.render(width).length, scroll.viewportHeight, options.requestRender);
      scroll.scrollTo(previousTop + heightChange, { disableFollow: true });
    }),
  };
  const renderDescriptor = Object.getOwnPropertyDescriptor(chat, "render");
  const mouseDescriptor = Object.getOwnPropertyDescriptor(chat, "handleMouse");
  const originalRender = chat.render;
  const originalMouse = chat.handleMouse;
  const projected = new Container();
  const groups = new WeakMap<NativeTool, ToolGroup>();
  let unregisterProjection: (() => void) | undefined;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (chat.render === render) {
      if (renderDescriptor) Object.defineProperty(chat, "render", renderDescriptor);
      else delete (chat as Partial<NativeContainer>).render;
    }
    if (chat.handleMouse === handleMouse) {
      if (mouseDescriptor) Object.defineProperty(chat, "handleMouse", mouseDescriptor);
      else delete (chat as Partial<NativeContainer>).handleMouse;
    }
    unregisterProjection?.();
    projected.clear();
    options.requestRender();
  };
  const fail = (error: unknown) => {
    dispose();
    options.warn(`Compact tools: grouping disabled after an incompatible transcript update (${error instanceof Error ? error.message : String(error)}); keeping individual rows.`);
  };

  // Reconcile membership without rendering history. Pin visibility may consume
  // a fresh bounded suffix of this same projection; native painting still owns
  // complete mouse geometry and renders it through the normal path below.
  function refreshProjection(): void {
    const children: Component[] = [];
    let members: NativeTool[] = [];
    let slots: Component[] = [];
    const flush = () => {
      if (members.length > 1) {
        let group = groups.get(members[0]);
        if (!group) {
          group = new ToolGroup(groupOptions, fail, settings);
          groups.set(members[0], group);
        }
        group.update(members, slots);
        children.push(group);
      } else for (const slot of slots) children.push(slot);
      members = [];
      slots = [];
    };
    for (const child of chat.children) {
      if (eligible(child, settings)) {
        members.push(child);
        slots.push(child);
      } else if (members.length && transparent(child)) {
        slots.push(child);
      } else {
        flush();
        children.push(child);
      }
    }
    flush();
    if (children.length !== projected.children.length || children.some((child, index) => child !== projected.children[index])) {
      projected.children = children;
    }
    // A suffix-only measurement does not repaint the parent. Clear old native
    // hit heights so any pre-paint mouse event uses fresh child rendering.
    (projected as unknown as { mouseLayout?: unknown }).mouseLayout = undefined;
  }
  function render(width: number): string[] {
    if (disposed) return originalRender.call(chat, width);
    try {
      refreshProjection();
      return projected.render(width);
    } catch (error) {
      fail(error);
      return originalRender.call(chat, width);
    }
  }
  function handleMouse(event: TuiMouseEvent) {
    if (disposed) return originalMouse.call(chat, event);
    try { return projected.handleMouse(event); }
    catch (error) {
      fail(error);
      return undefined;
    }
  }
  try {
    Object.defineProperty(chat, "render", { configurable: true, writable: true, value: render });
    Object.defineProperty(chat, "handleMouse", { configurable: true, writable: true, value: handleMouse });
    unregisterProjection = registerTranscriptProjection(chat, { view: projected, render, freshChildren: () => {
      if (disposed || projected.render !== Container.prototype.render) return undefined;
      try { refreshProjection(); return projected.children; }
      catch (error) { fail(error); return undefined; }
    } });
  } catch (error) { fail(error); }
  return dispose;
}

export function registerGrouping(pi: ExtensionAPI, settings: Settings): void {
  if (!settings.groupConsecutive) return;
  let cleanup: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    cleanup?.();
    cleanup = undefined;
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("compact-tools-grouping", tui => {
      const dispose = installGrouping(tui, settings, {
        theme: () => ctx.ui.theme,
        requestRender: () => tui.requestRender(),
        warn: message => ctx.ui.notify(message, "warning"),
      });
      cleanup = dispose;
      return { render: () => [], invalidate() {}, dispose };
    });
  });
  pi.on("session_shutdown", () => {
    cleanup?.();
    cleanup = undefined;
  });
}
