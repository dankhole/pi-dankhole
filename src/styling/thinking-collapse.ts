import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";

interface Message {
  role: string;
  content: Array<{ type: string; thinking?: string }>;
}
interface Assistant extends Container {
  contentContainer: Container;
  lastMessage?: Message;
  isStreaming: boolean;
  hideThinkingBlock: boolean;
  thinkingVisibilityOverrides: Map<number, boolean>;
  updateContent(message: Message, isStreaming?: boolean): void;
  setHideThinkingBlock(hide: boolean): void;
}
const tree = (value: unknown): value is Container => value instanceof Container && Array.isArray(value.children);

// Match native run numbering: adjacent thinking blocks (including empty ones)
// form one clickable run, but an entirely empty run consumes no index.
function runs(message: Message | undefined): Array<{ end: number }> {
  const result: Array<{ end: number }> = [];
  const content = message?.content ?? [];
  for (let index = 0; index < content.length; index++) {
    if (content[index].type !== "thinking") continue;
    let visible = false;
    while (index < content.length && content[index].type === "thinking") {
      visible ||= !!content[index].thinking?.trim();
      index++;
    }
    if (visible) result.push({ end: index - 1 });
    index--;
  }
  return result;
}

function assistant(value: Component): Assistant | undefined {
  if (value.constructor.name !== "AssistantMessageComponent") return undefined;
  const item = value as Assistant;
  return tree(item) && tree(item.contentContainer) && item.children.length === 1
    && item.children[0] === item.contentContainer && typeof item.isStreaming === "boolean"
    && typeof item.hideThinkingBlock === "boolean" && item.thinkingVisibilityOverrides instanceof Map
    && typeof item.updateContent === "function" && typeof item.setHideThinkingBlock === "function"
    && (!item.lastMessage || item.lastMessage.role === "assistant" && Array.isArray(item.lastMessage.content))
    ? item : undefined;
}

/** Restore only our own instance method; foreign replacements remain authoritative. */
function replace<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  return () => {
    if (target[key] !== value) return;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  };
}

export interface ThinkingCollapseOptions {
  requestRender: () => void;
  warn: (message: string) => void;
}

/** Pi 1.4 instance adapter: no public assistant renderer/visibility-default API
 * exists. Native updateContent(message, true/false) is the streaming authority.
 * Its native Map.get(run) ?? hideThinkingBlock selects a native Text/MouseRegion
 * row, and its native mouse callback writes the explicit per-run override.
 * Supply only the missing default; never rewrite reasoning, global preferences,
 * explicit overrides, render output, or mouse handlers.
 *
 * Hook native chat membership rather than document/chat render: assistant panels
 * and tool grouping own those render paths. Pi adds even its empty live assistant
 * through addChild before updating it, and rebuilds history through clear/addChild.
 */
export function installThinkingCollapse(tui: unknown, options: ThinkingCollapseOptions): () => void {
  const document = (tui as { children?: unknown[] } | undefined)?.children?.[0];
  if (!tree(document) || document.children.length !== 3 || !document.children.every(tree)) {
    options.warn("Compact tools: thinking collapse unavailable for this Pi transcript layout; keeping native thinking.");
    return () => {};
  }
  const chat = document.children[2] as Container;
  const patches = new Map<Assistant, () => void>();
  const restores: Array<() => void> = [];
  let disposed = false;
  let warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    options.warn("Compact tools: incompatible assistant layout; keeping unsupported thinking native.");
  };
  const attach = (value: Component) => {
    if (disposed || value.constructor.name !== "AssistantMessageComponent") return;
    const item = assistant(value);
    if (!item) { warn(); return; }
    if (patches.has(item)) return;
    const overrides = item.thinkingVisibilityOverrides;
    const get = overrides.get;
    const clear = overrides.clear;
    // A native global visibility action clears this map. Respect that action for
    // all existing runs, including the current stream, rather than recollapsing.
    const nativePreference = new Set<number>();
    let active = true;
    let restoreGet: (() => void) | undefined;
    let restoreClear: (() => void) | undefined;
    const refresh = () => {
      if (item.lastMessage && runs(item.lastMessage).length) item.updateContent(item.lastMessage, item.isStreaming);
    };
    const dispose = () => {
      if (!active) return;
      active = false;
      restoreGet?.();
      restoreClear?.();
      // Native explicit click overrides were never changed and survive teardown.
      try { refresh(); } catch { warn(); }
    };
    try {
      restoreGet = replace(overrides, "get", (index: number) => {
        const explicit = get.call(overrides, index);
        if (!active || explicit !== undefined || nativePreference.has(index)) return explicit;
        const run = runs(item.lastMessage)[index];
        // A later content block closes an earlier thinking run even while a
        // subsequent run streams. A trailing run waits for native message_end.
        return run && (!item.isStreaming || run.end < item.lastMessage!.content.length - 1) ? true : undefined;
      });
      restoreClear = replace(overrides, "clear", () => {
        runs(item.lastMessage).forEach((_run, index) => { nativePreference.add(index); });
        clear.call(overrides);
      });
      patches.set(item, dispose);
      refresh();
    } catch {
      patches.delete(item);
      dispose();
      warn();
    }
  };
  const detach = (value: Component) => {
    const item = value as Assistant;
    const dispose = patches.get(item);
    patches.delete(item);
    dispose?.();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const restore of restores.reverse()) restore();
    for (const cleanup of patches.values()) cleanup();
    patches.clear();
    options.requestRender();
  };
  const addChild = chat.addChild;
  const removeChild = chat.removeChild;
  const clear = chat.clear;
  try {
    restores.push(replace(chat, "addChild", (child: Component) => {
      addChild.call(chat, child);
      attach(child);
    }));
    restores.push(replace(chat, "removeChild", (child: Component) => {
      removeChild.call(chat, child);
      if (!chat.children.includes(child)) detach(child);
    }));
    restores.push(replace(chat, "clear", () => {
      clear.call(chat);
      for (const item of [...patches.keys()]) detach(item);
    }));
    for (const child of chat.children) attach(child);
    options.requestRender();
  } catch { warn(); dispose(); }
  return dispose;
}

export function registerThinkingCollapse(pi: ExtensionAPI, enabled: boolean): void {
  if (!enabled) return;
  let cleanup: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    cleanup?.();
    cleanup = undefined;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    ctx.ui.setWidget("compact-tools-thinking-collapse", tui => {
      cleanup?.();
      const dispose = installThinkingCollapse(tui, {
        requestRender: () => tui.requestRender(),
        warn: message => ctx.ui.notify(message, "warning"),
      });
      cleanup = dispose;
      return { render: () => [], invalidate() {}, dispose };
    });
  });
  pi.on("session_shutdown", () => { cleanup?.(); cleanup = undefined; });
}
