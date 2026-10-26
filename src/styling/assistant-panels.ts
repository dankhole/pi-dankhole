import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type DefaultTextStyle, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { assistantBackground, type ConversationTone, conversationProse, userBackground } from "./palette.ts";

interface Tree extends Component { children: Component[] }
interface Assistant extends Tree {
  contentContainer: Container;
  lastMessage?: { role: string; content: Array<{ type: string; text?: string }> };
  updateContent: (...args: never[]) => void;
  setHideThinkingBlock: (...args: never[]) => void;
}
const isTree = (value: unknown): value is Tree => value instanceof Container && Array.isArray(value.children);

// Keep OSC links/zones and DCS/APC payloads opaque: an SGR-looking substring in
// a URL or image is data, not a style reset. Only decorate ordinary text lines.
const sequences = /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|[P_^][\s\S]*?\x1b\\|\[[0-?]*[ -/]*[@-~])/g;
function fillLine(line: string, width: number, background: string, foreground = ""): string {
  if (width <= 0 || /\x1b(?:_G|\]1337;File=|P[0-?]*[ -/]*q)/.test(line)) return line;
  const columns = visibleWidth(line);
  // Native layout is authoritative, including its minimum width on tiny terminals.
  if (columns > width) return line;
  const styled = line.replace(sequences, sequence => {
    if (!/^\x1b\[[\d;:]*m$/.test(sequence)) return sequence;
    const parameters = sequence.slice(2, -1).split(";");
    let reset = false;
    let resetForeground = false;
    for (let index = 0; index < parameters.length; index++) {
      const parameter = parameters[index];
      const code = Number(parameter.split(":")[0]);
      if (code === 0 || code === 49) reset = true;
      else if ((code >= 40 && code <= 48) || (code >= 100 && code <= 107)) reset = false;
      if (code === 0 || code === 39) resetForeground = true;
      else if ((code >= 30 && code <= 38) || (code >= 90 && code <= 97)) resetForeground = false;
      // Extended foreground/background/underline colors contain numbers such as
      // 0 and 49, which must not be mistaken for reset commands.
      if ([38, 48, 58].includes(code) && !parameter.includes(":")) {
        const mode = Number(parameters[index + 1]);
        if (mode === 5) index += 2;
        else if (mode === 2) index += 4;
      }
    }
    return sequence + (reset ? background : "") + (resetForeground ? foreground : "");
  });
  return background + foreground + styled + " ".repeat(width - columns) + (foreground ? "\x1b[39m" : "") + "\x1b[49m";
}

/** Pi 1.4 adapter boundary. Only direct Markdown children are assistant prose;
 * thinking is wrapped in MouseRegion, while spacers/errors are separate children.
 * No public renderer currently replaces native assistant messages. Unknown shapes
 * are left native rather than inferred from rendered text or recursively styled.
 */
function prose(value: Component): Array<Markdown | Spacer> | undefined {
  if (value.constructor.name !== "AssistantMessageComponent") return [];
  const assistant = value as Assistant;
  if (!isTree(assistant) || !isTree(assistant.contentContainer)
    || assistant.children.length !== 1 || assistant.children[0] !== assistant.contentContainer
    || typeof assistant.updateContent !== "function" || typeof assistant.setHideThinkingBlock !== "function"
    || assistant.lastMessage?.role !== "assistant" || !Array.isArray(assistant.lastMessage.content)) return undefined;
  const children = assistant.contentContainer.children;
  if (!children.every(child => child instanceof Markdown || child instanceof MouseRegion || child instanceof Spacer || child instanceof Text)) return undefined;
  const markdown = children.filter((child): child is Markdown => child instanceof Markdown);
  const expected = assistant.lastMessage.content.filter(block => block.type === "text" && typeof block.text === "string" && block.text.trim()).length;
  if (markdown.length !== expected) return undefined;
  if (!markdown.length) return [];
  // Native Pi already provides exactly one blank spacer immediately before the
  // first prose block (also after leading thinking). Color that existing row as
  // the top buffer: no prepending, mouse translation, or changed OSC geometry.
  const buffer = children[children.indexOf(markdown[0]) - 1];
  return buffer instanceof Spacer ? [buffer, ...markdown] : undefined;
}

function userMarkdown(value: Component): Markdown | undefined {
  if (value.constructor.name !== "UserMessageComponent" || !isTree(value)) return undefined;
  const user = value as Tree & { text?: unknown; setOutputPad?: unknown; rebuild?: unknown };
  return typeof user.text === "string" && typeof user.setOutputPad === "function" && typeof user.rebuild === "function"
    && user.children.length === 1 && user.children[0] instanceof Markdown ? user.children[0] : undefined;
}

/** Explicit Pi 1.4 instance-field adapter, not a global theme/prototype mutation.
 * Semantic callbacks preserve links/formatting, while code/highlightCode remain
 * native. Background styling happens at Markdown's own padding stage so images,
 * user padding, cached layout, and nested explicit backgrounds remain native. */
function patchStyles(component: Markdown, user: boolean, options: AssistantPanelOptions): () => void {
  type Styles = { theme: MarkdownTheme; defaultTextStyle?: DefaultTextStyle };
  const target = component as unknown as Styles;
  const themeDescriptor = Object.getOwnPropertyDescriptor(component, "theme");
  const styleDescriptor = Object.getOwnPropertyDescriptor(component, "defaultTextStyle");
  const originalTheme = target.theme;
  const originalStyle = target.defaultTextStyle;
  const tones: ConversationTone[] = ["heading", "link", "linkUrl", "quote", "quoteBorder", "hr", "listBullet"];
  if (!themeDescriptor || !originalTheme || !tones.every(tone => typeof originalTheme[tone] === "function")
    || !themeDescriptor.writable && !themeDescriptor.configurable
    || !styleDescriptor || !styleDescriptor.writable && !styleDescriptor.configurable
    || user && typeof originalStyle?.bgColor !== "function") throw new Error("unsupported Markdown style fields");
  const theme = { ...originalTheme };
  for (const tone of tones) theme[tone] = value => conversationProse(options.theme(), tone, value) ?? originalTheme[tone](value);
  const style: DefaultTextStyle | undefined = user ? { ...originalStyle, bgColor: (value: string) => {
    const background = userBackground(options.theme());
    return background ? fillLine(value, visibleWidth(value), background) : originalStyle!.bgColor!(value);
  } } : originalStyle;
  Object.defineProperty(component, "theme", { ...themeDescriptor, value: theme });
  Object.defineProperty(component, "defaultTextStyle", { ...styleDescriptor, value: style });
  component.invalidate();
  return () => {
    if (target.theme === theme) Object.defineProperty(component, "theme", themeDescriptor);
    if (target.defaultTextStyle === style) Object.defineProperty(component, "defaultTextStyle", styleDescriptor);
    component.invalidate();
  };
}

export interface AssistantPanelOptions {
  theme: () => Theme;
  requestRender: () => void;
  warn: (message: string) => void;
}

/** Reversible, instance-local display adapter. Does not change message text or
 * global Markdown/prototype behavior. Owned native Spacers supply a neutral gap
 * above the panel and bottom padding where absent; native layout owns hit offsets.
 * Hook the document, not chat.render: grouping owns a projection of chat children.
 */
export function installAssistantPanels(tui: unknown, options: AssistantPanelOptions): () => void {
  const document = (tui as { children?: unknown[] } | undefined)?.children?.[0];
  const valid = () => isTree(document) && document.children.length === 3 && document.children.every(isTree);
  if (!valid() || !isTree(document)) {
    options.warn("Compact tools: conversation panels unavailable for this Pi transcript layout; keeping native messages.");
    return () => {};
  }
  const original = document.render;
  const descriptor = Object.getOwnPropertyDescriptor(document, "render");
  const patches = new Map<Component, { descriptor?: PropertyDescriptor; render: Component["render"]; restoreStyles: () => void }>();
  type OwnedSpacer = { container: Container; children: Component[]; anchor: Component; spacer: Spacer };
  const bottoms = new Map<Assistant, OwnedSpacer>();
  const gaps = new Map<Assistant, OwnedSpacer>();
  // Native Container caches rendered child heights. Clear instance caches after
  // tree edits so pre-repaint mouse events use its native height fallback too.
  const resetMouseLayout = (assistant: Assistant, container: Container) => {
    for (const component of [container, assistant, document.children[2], document]) {
      if (isTree(component)) (component as unknown as { mouseLayout?: unknown }).mouseLayout = undefined;
    }
  };
  const removeSpacer = (assistant: Assistant, owners: Map<Assistant, OwnedSpacer>) => {
    const owned = owners.get(assistant)!;
    // Native streaming rebuilds replace children arrays; also release the owned
    // component from the detached original array without touching other rows.
    for (const children of new Set([owned.children, owned.container.children])) {
      const index = children.indexOf(owned.spacer);
      if (index >= 0) children.splice(index, 1);
    }
    owners.delete(assistant);
    resetMouseLayout(assistant, owned.container);
  };
  let disposed = false;
  let warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    options.warn("Compact tools: incompatible conversation layout; keeping unsupported content native.");
  };
  const restore = (component: Component) => {
    const patch = patches.get(component)!;
    if (component.render === patch.render) {
      if (patch.descriptor) Object.defineProperty(component, "render", patch.descriptor);
      else delete (component as Partial<Component>).render;
    }
    patch.restoreStyles();
    patches.delete(component);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (document.render === render) {
      if (descriptor) Object.defineProperty(document, "render", descriptor);
      else delete (document as Partial<Tree>).render;
    }
    for (const owners of [gaps, bottoms]) for (const assistant of owners.keys()) removeSpacer(assistant, owners);
    for (const component of patches.keys()) restore(component);
    options.requestRender();
  };
  const sync = () => {
    if (!valid()) throw new Error("transcript changed");
    const current = new Set<Component>();
    const liveBottoms = new Set<Assistant>();
    const liveGaps = new Set<Assistant>();
    for (const child of (document.children[2] as Tree).children) {
      const user = userMarkdown(child);
      const components = user ? [user] : prose(child);
      if (!components || child.constructor.name === "UserMessageComponent" && !user) { warn(); continue; }
      if (!user && components.length) {
        const assistant = child as Assistant;
        const container = assistant.contentContainer;
        const last = components.filter((component): component is Markdown => component instanceof Markdown).at(-1)!;
        const owned = bottoms.get(assistant);
        const enabled = !!assistantBackground(options.theme());
        if (owned && (!enabled || owned.container !== container || owned.children !== container.children || owned.anchor !== last
          || container.children.indexOf(owned.spacer) !== container.children.indexOf(last) + 1)) removeSpacer(assistant, bottoms);
        const top = components[0];
        const gap = gaps.get(assistant);
        if (gap && (!enabled || gap.container !== container || gap.children !== container.children || gap.anchor !== top
          || container.children.indexOf(gap.spacer) !== container.children.indexOf(top) - 1)) removeSpacer(assistant, gaps);
        if (enabled) {
          // Leave this owned native row unpainted, above the existing blue buffer.
          // Keeping it in the child tree preserves native mouse/selection offsets.
          if (!gaps.has(assistant)) {
            const spacer = new Spacer(1);
            container.children.splice(container.children.indexOf(top), 0, spacer);
            gaps.set(assistant, { container, children: container.children, anchor: top, spacer });
            resetMouseLayout(assistant, container);
          }
          liveGaps.add(assistant);
          const index = container.children.indexOf(last) + 1;
          let bottom = container.children[index];
          // A native error/truncation separator directly after prose can serve
          // as the bottom row. Never borrow a neighboring message's spacing.
          if (!(bottom instanceof Spacer) || bottom.render(0).length !== 1) {
            const spacer = new Spacer(1);
            bottom = spacer;
            container.children.splice(index, 0, spacer);
            bottoms.set(assistant, { container, children: container.children, anchor: last, spacer });
            resetMouseLayout(assistant, container);
          }
          if (bottoms.has(assistant)) liveBottoms.add(assistant);
          components.push(bottom as Spacer);
        }
      }
      for (const component of components) {
        current.add(component);
        if (patches.has(component)) continue;
        const original = component.render;
        const descriptor = Object.getOwnPropertyDescriptor(component, "render");
        let restoreStyles = () => {};
        try { if (component instanceof Markdown) restoreStyles = patchStyles(component, !!user, options); }
        catch { warn(); continue; }
        const render = (width: number) => {
          const lines = original.call(component, width);
          if (disposed || user) return lines;
          try {
            const theme = options.theme();
            const background = assistantBackground(theme);
            if (!background) return lines;
            // Never mutate the Markdown cache (nor assistant OSC zone markers).
            // Own only the default prose foreground; explicit nested colors and
            // opaque OSC/image payloads are never remapped. Applying it after
            // layout avoids changing native Markdown wrapping/style-context rules.
            const foreground = component instanceof Markdown ? theme.getFgAnsi("text") : "";
            return lines.map(line => fillLine(line, width, background, foreground));
          } catch { warn(); return lines; }
        };
        try { Object.defineProperty(component, "render", { configurable: true, writable: true, value: render }); }
        catch { restoreStyles(); warn(); continue; }
        patches.set(component, { descriptor, render, restoreStyles });
      }
    }
    // Streaming/invalidation rebuild Markdown instances. Restore and release old
    // instances, including history removed by a branch switch or compaction.
    for (const assistant of gaps.keys()) if (!liveGaps.has(assistant)) removeSpacer(assistant, gaps);
    for (const assistant of bottoms.keys()) if (!liveBottoms.has(assistant)) removeSpacer(assistant, bottoms);
    for (const component of patches.keys()) if (!current.has(component)) restore(component);
  };
  function render(width: number): string[] {
    if (!disposed) {
      try { sync(); } catch { warn(); dispose(); }
    }
    return original.call(document, width);
  }
  try {
    Object.defineProperty(document, "render", { configurable: true, writable: true, value: render });
    sync();
    options.requestRender();
  } catch { warn(); dispose(); }
  return dispose;
}

export function registerAssistantPanels(pi: ExtensionAPI, enabled: boolean): void {
  if (!enabled) return;
  let cleanup: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    cleanup?.();
    cleanup = undefined;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    ctx.ui.setWidget("compact-tools-assistant-panels", tui => {
      cleanup?.();
      const dispose = installAssistantPanels(tui, {
        theme: () => ctx.ui.theme,
        requestRender: () => tui.requestRender(),
        warn: message => ctx.ui.notify(message, "warning"),
      });
      cleanup = dispose;
      return { render: () => [], invalidate() {}, dispose };
    });
  });
  pi.on("session_shutdown", () => { cleanup?.(); cleanup = undefined; });
}
