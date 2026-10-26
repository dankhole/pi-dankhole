import { type Component, getOsc8LinkAtColumn, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { getChildLineOffsets } from "../styling/grouping.ts";

/** Only question renderers owned by this registration can supply these identities. */
export const QUESTION_CONTENT = Symbol("question-content");
export interface QuestionContent extends Component {
  [QUESTION_CONTENT]?: (width: number) => { identity: object; rows: number[] } | undefined;
}
interface Tree extends Component { children: Component[] }
interface Entry {
  component: Component;
  basis?: number | "auto";
  grow?: number;
  shrink?: number;
  minSize?: number;
  maxSize?: number;
  visible?: (viewport: { width: number; height: number }) => boolean;
}
interface Stack extends Tree { entries: Entry[]; gap: number }
interface Transcript extends Tree {
  primary: boolean;
  scrollTop: number;
  isFollowingEnd: boolean;
  getContentWidth(width: number): number;
}
interface PendingIdentity { toolCallId?: string }
type ProseQuestion = { identity: object; id: number; question: string };
export interface ProseQuestionSource { message: object; questions: ProseQuestion[] }
interface ProseBinding {
  descriptor?: PropertyDescriptor;
  handler: NonNullable<Component["handleMouse"]>;
  message: object;
  lines: string[];
  width: number;
  targets: Map<number, ProseQuestion>;
}

// Native Markdown exposes no source-map API. Recognize only a unique complete rendered
// standalone label/text sequence within an entry-identified assistant message. Ambiguous
// markdown (quotes, repeated examples, transforms) keeps the reminder, never guesses.
function proseRows(lines: string[], id: number, question: string): number[] | undefined {
  const prefix = `Q${id}:`;
  const expected = prefix + question.replace(/\s/g, "");
  const matches: number[][] = [];
  for (let start = 0; start < lines.length; start++) {
    let text = "";
    const rows: number[] = [];
    for (let index = start; index < lines.length; index++) {
      const part = stripTerminalSequences(lines[index]).replace(/\s/g, "");
      if (!part) break;
      const before = text.length;
      text += part;
      if (!expected.startsWith(text) && !text.startsWith(expected)) break;
      if (text.length > prefix.length && before < expected.length) rows.push(index);
      if (text.length >= expected.length) { matches.push(rows); break; }
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

const tree = (value: unknown): value is Tree => !!value && Array.isArray((value as Tree).children)
  && typeof (value as Tree).render === "function";

/** Instance-local adapter for Pi 1.4's fullscreen chat layout and prose mouse routing. */
export function questionListVisibility(tui: TUI, pending: readonly PendingIdentity[],
  proseSources?: () => ProseQuestionSource[] | undefined,
  openProse?: (identity: object, message: object) => boolean) {
  let measuring = false;
  let disposed = false;
  const bindings = new Map<Component, ProseBinding>();
  const contested = new WeakSet<Component>();
  const removeBinding = (component: Component) => {
    const binding = bindings.get(component);
    if (!binding) return;
    // Never overwrite a handler another extension installed after ours.
    if (component.handleMouse === binding.handler) {
      if (binding.descriptor) Object.defineProperty(component, "handleMouse", binding.descriptor);
      else delete component.handleMouse;
    }
    bindings.delete(component);
  };
  const clearBindings = () => { for (const component of bindings.keys()) removeBinding(component); };
  const fallback = () => { clearBindings(); return true; };
  const bindProse = (component: Component, source: ProseQuestionSource, lines: string[], width: number, targets: Map<number, ProseQuestion>) => {
    if (!openProse || !targets.size || contested.has(component)) return false;
    let binding = bindings.get(component);
    if (binding && component.handleMouse !== binding.handler) { contested.add(component); removeBinding(component); return false; }
    if (!binding) {
      const original = component.handleMouse;
      const descriptor = Object.getOwnPropertyDescriptor(component, "handleMouse");
      const handler: NonNullable<Component["handleMouse"]> = event => {
        const native = original?.call(component, event);
        if (native) return native;
        const current = bindings.get(component);
        if (disposed || !current || component.handleMouse !== handler || event.type !== "click" || event.button !== "left"
          || event.shift || event.alt || event.ctrl || event.x < 0 || event.x >= current.width || event.width !== current.width
          || (component as Component & { lastMessage?: object }).lastMessage !== current.message
          || getOsc8LinkAtColumn(current.lines[event.y] ?? "", event.x)) return;
        const question = current.targets.get(event.y);
        if (question && openProse(question.identity, current.message)) return { handled: true, render: true };
      };
      binding = { descriptor, handler, message: source.message, lines, width, targets };
      Object.defineProperty(component, "handleMouse", { configurable: true, writable: true, value: handler });
      bindings.set(component, binding);
    }
    Object.assign(binding, { message: source.message, lines, width, targets });
    return component.handleMouse === binding.handler;
  };
  const show = (columns: number): boolean => {
    // Measuring the dock with this widget absent is the canonical layout. In particular,
    // never use the previous ScrollView.viewportHeight: our own height would feed back.
    if (measuring || disposed) return false;
    if (tui.mode !== "fullscreen") return fallback();
    const root = (tui as unknown as { layoutRoot?: Stack }).layoutRoot;
    const document = (tui as unknown as Tree).children?.[0];
    const height = tui.terminal.rows;
    if (!root || root.constructor.name !== "VStack" || !tree(root) || root.gap !== 0
      || !Array.isArray(root.entries) || root.entries.length !== root.children.length
      || root.entries.some((entry, index) => entry.component !== root.children[index])
      || !tree(document) || document.children.length !== 3 || !document.children.every(tree)
      || !Number.isFinite(height) || height <= 0 || columns <= 0) return fallback();
    const [scroll, dock] = root.entries.slice(-2);
    const transcript = scroll?.component as Transcript | undefined;
    if (!transcript || transcript.constructor.name !== "ScrollView" || !transcript.primary
      || transcript.children?.[0] !== document || typeof transcript.getContentWidth !== "function"
      || !Number.isFinite(transcript.scrollTop) || typeof transcript.isFollowingEnd !== "boolean"
      || scroll.basis !== 0 || scroll.grow !== 1 || scroll.shrink !== 1 || scroll.minSize !== 1
      || scroll.maxSize !== undefined || scroll.visible !== undefined
      || dock?.basis !== "auto" || dock.grow !== 0 || dock.shrink !== 1 || dock.minSize !== 1
      || dock.maxSize !== undefined || dock.visible !== undefined) return fallback();
    // The only supported extra root row is the pinned prompt. Evaluate its public
    // visibility predicate with this widget suppressed, not with last frame's pin state.
    const extras = root.entries.slice(0, -2);
    if (extras.length > 1 || extras.some(entry => entry.basis !== "auto" || entry.grow !== 0
      || entry.shrink !== 0 || entry.minSize !== 0 || entry.maxSize !== 1 || typeof entry.visible !== "function")) return fallback();
    measuring = true;
    try {
      let reserved = Math.max(1, dock.component.render(columns).length);
      for (const entry of extras) if (entry.visible!({ width: columns, height })) reserved += entry.component.render(columns).length;
      const viewport = Math.min(height, Math.max(1, height - reserved));
      const contentWidth = transcript.getContentWidth(columns);
      const measured = new Map<Component, string[]>();
      const render = (component: Component) => {
        let lines = measured.get(component);
        if (!lines) { lines = component.render(contentWidth); measured.set(component, lines); }
        return lines;
      };
      const lines = render(document);
      const maxTop = Math.max(0, lines.length - viewport);
      const top = transcript.isFollowingEnd ? maxTop : Math.max(0, Math.min(transcript.scrollTop, maxTop));
      const visible = new Set<object>();
      const pendingIdentities = new Set<object>(pending);
      const visit = (component: QuestionContent, start: number) => {
        const content = component[QUESTION_CONTENT]?.(contentWidth);
        if (content && pendingIdentities.has(content.identity)
          && content.rows.some(row => start + row >= top && start + row < top + viewport)) visible.add(content.identity);
        const child = (component as Component & { child?: Component }).child;
        const children = tree(component) ? component.children : component.constructor.name === "MouseRegion" && child ? [child] : [];
        if (!children.length || children.reduce((sum, item) => sum + render(item).length, 0) !== render(component).length) return;
        let offset = start;
        for (const item of children) { visit(item, offset); offset += render(item).length; }
      };
      const chat = document.children[2] as Tree;
      const preceding = document.children.slice(0, 2).reduce((sum, child) => sum + render(child).length, 0);
      // Refresh the grouped projection once, then share offsets and measurements across
      // every pending question. Historical resolved cards need no metadata traversal.
      const offsets = getChildLineOffsets(chat, contentWidth, component => render(component).length);
      if (!offsets) return fallback();
      const pendingCalls = new Set(pending.flatMap(identity => identity.toolCallId ? [identity.toolCallId] : []));
      for (const [child, offset] of offsets) {
        const tool = child as Component & { toolName?: string; toolCallId?: string };
        if (tool.toolName === "ask_user" && tool.toolCallId && pendingCalls.has(tool.toolCallId)) visit(child, preceding + offset);
      }
      const sources = new Map((proseSources?.() ?? []).map(source => [source.message, source]));
      const candidates = new Map<object, Component[]>();
      for (const child of chat.children) {
        const message = (child as Component & { lastMessage?: object }).lastMessage;
        if (child.constructor.name !== "AssistantMessageComponent" || !message || !sources.has(message)) continue;
        const matches = candidates.get(message) ?? [];
        matches.push(child); candidates.set(message, matches);
      }
      const retained = new Set<Component>();
      for (const [message, source] of sources) {
        const matches = candidates.get(message);
        if (matches?.length !== 1) continue;
        const child = matches[0];
        const offset = offsets.get(child);
        if (offset === undefined) continue;
        const rows = render(child);
        const targets = new Map<number, ProseQuestion>();
        const ambiguous = new Set<number>();
        for (const question of source.questions) for (const row of proseRows(rows, question.id, question.question) ?? []) {
          if (targets.has(row)) ambiguous.add(row);
          else targets.set(row, question);
        }
        for (const row of ambiguous) targets.delete(row);
        if (!bindProse(child, source, rows, contentWidth, targets)) continue;
        retained.add(child);
        // Visibility can suppress the only reminder only after native click routing exists.
        for (const [row, question] of targets) if (preceding + offset + row >= top && preceding + offset + row < top + viewport) visible.add(question.identity);
      }
      for (const child of bindings.keys()) if (!retained.has(child)) removeBinding(child);
      return pending.some(identity => !visible.has(identity));
    } catch {
      return fallback(); // Unknown renderer/layout contracts must not hide pending questions.
    } finally {
      measuring = false;
    }
  };
  return Object.assign(show, { dispose() { disposed = true; clearBindings(); } });
}
