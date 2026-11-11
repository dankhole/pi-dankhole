import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, type Component, foregroundAnsi, getOsc8LinkAtColumn, stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { invalidateTranscriptRows, isTranscriptRendererSupported, registerTranscriptRenderer, retainTranscriptFrames, withTranscriptMeasurement } from "../styling/transcript-measurement.ts";
import { questionPalette, questionPlain } from "./question-palette.ts";

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
type ProseQuestion = { identity: object; id: number; question: string; choices?: string[] };
export interface ProseQuestionSource { message: object; questions: ProseQuestion[] }
interface ProseBinding {
  descriptor?: PropertyDescriptor;
  handler: NonNullable<Component["handleMouse"]>;
  renderDescriptor?: PropertyDescriptor;
  render: Component["render"];
  unregister: () => void;
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

// Only extend a proven question target over an exact, adjacent choice block. Native
// Markdown removes list markers and emphasis; no wording or choices are inferred here.
function proseChoiceRows(lines: string[], after: number, choices: string[]): number[] {
  const rows: number[] = [];
  let cursor = after + 1;
  for (const choice of choices) {
    const expected = choice.replace(/^\s*[-*+]\s+/, "").replace(/\*\*|__/g, "").replace(/\s/g, "");
    if (!expected) return [];
    while (cursor < lines.length && !stripTerminalSequences(lines[cursor]).trim()) rows.push(cursor++);
    let text = "";
    let first = true;
    while (cursor < lines.length && text.length < expected.length) {
      let part = stripTerminalSequences(lines[cursor]).trim();
      if (first) part = part.replace(/^[-*+•]\s+/, "");
      first = false;
      text += part.replace(/\s/g, "");
      if (!expected.startsWith(text) || !part) return [];
      rows.push(cursor++);
    }
    if (text !== expected) return [];
  }
  return rows;
}

function proseTargets(lines: string[], questions: ProseQuestion[]): Map<number, ProseQuestion> {
  const targets = new Map<number, ProseQuestion>();
  const ambiguous = new Set<number>();
  for (const question of questions) {
    const heading = proseRows(lines, question.id, question.question) ?? [];
    const choices = heading.length && question.choices?.length
      ? proseChoiceRows(lines, heading.at(-1)!, question.choices) : [];
    const rows = [...heading, ...choices];
    // Fill existing native spacing without inserting rows or changing mouse geometry.
    if (choices.length) {
      if (heading[0] > 0 && !stripTerminalSequences(lines[heading[0] - 1]).trim()) rows.push(heading[0] - 1);
      const end = choices.at(-1)! + 1;
      if (end < lines.length && !stripTerminalSequences(lines[end]).trim()) rows.push(end);
    }
    for (const row of rows) {
      if (targets.has(row)) ambiguous.add(row);
      else targets.set(row, question);
    }
  }
  for (const row of ambiguous) targets.delete(row);
  return targets;
}

// Replace only SGR colors, never text attributes, OSC links/zones or opaque payloads. A
// question owns its row colors, not the native text, wrapping, or link geometry.
const sequences = /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|[P_^][\s\S]*?\x1b\\|\[[0-?]*[ -/]*[@-~])/g;
function paintProse(theme: Theme, line: string, width: number): string {
  if (questionPlain()) return line;
  const palette = questionPalette(theme);
  const paint = foregroundAnsi(palette.questionText, theme.getColorMode()) + backgroundAnsi(palette.question, theme.getColorMode());
  const text = line.replace(sequences, sequence => {
    if (!/^\x1b\[[\d;:]*m$/.test(sequence)) return sequence;
    const parameters = sequence.slice(2, -1).split(";");
    const attributes: string[] = [];
    for (let index = 0; index < parameters.length; index++) {
      const parameter = parameters[index];
      const code = Number(parameter.split(":")[0]);
      let end = index;
      if ([38, 48, 58].includes(code) && !parameter.includes(":")) {
        if (parameters[index + 1] === "5") end += 2;
        else if (parameters[index + 1] === "2") end += 4;
      }
      if (!(code >= 30 && code <= 49 || code >= 90 && code <= 107)) {
        attributes.push(`\x1b[${parameters.slice(index, end + 1).join(";")}m` + (code === 0 ? paint : ""));
      }
      index = end;
    }
    return attributes.join("");
  });
  return paint + text + " ".repeat(Math.max(0, width - visibleWidth(text))) + "\x1b[0m";
}

const tree = (value: unknown): value is Tree => !!value && Array.isArray((value as Tree).children)
  && typeof (value as Tree).render === "function";

/** Instance-local adapter for Pi 1.4's fullscreen chat layout and prose mouse routing. */
export function questionListVisibility(tui: TUI, pending: readonly PendingIdentity[],
  proseSources?: () => ProseQuestionSource[] | undefined,
  openProse?: (identity: object, message: object) => boolean,
  theme?: () => Theme) {
  let measuring = false;
  let disposed = false;
  const releaseFrames = retainTranscriptFrames(tui);
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
    if (component.render === binding.render) {
      if (binding.renderDescriptor) Object.defineProperty(component, "render", binding.renderDescriptor);
      else delete (component as Partial<Component>).render;
    }
    binding.unregister();
    bindings.delete(component);
    invalidateTranscriptRows(tui);
  };
  const clearBindings = () => { for (const component of bindings.keys()) removeBinding(component); };
  const fallback = () => { clearBindings(); return true; };
  const bindProse = (component: Component, source: ProseQuestionSource, lines: string[], width: number, targets: Map<number, ProseQuestion>) => {
    if (!openProse || !targets.size || contested.has(component)) return false;
    let binding = bindings.get(component);
    if (binding && (component.handleMouse !== binding.handler || component.render !== binding.render)) {
      contested.add(component); removeBinding(component); return false;
    }
    if (!binding) {
      if (!isTranscriptRendererSupported(component)) return false;
      const originalRender = component.render;
      const renderDescriptor = Object.getOwnPropertyDescriptor(component, "render");
      const render: Component["render"] = width => {
        const rows = originalRender.call(component, width);
        const current = bindings.get(component);
        if (disposed || !current || current.render !== render || component.render !== render
          || component.handleMouse !== current.handler || tui.mode !== "fullscreen"
          || (component as Component & { lastMessage?: object }).lastMessage !== current.message) return rows;
        const document = (tui as unknown as Tree).children?.[0];
        const chat = tree(document) && document.children[2];
        const matches = tree(chat) ? chat.children.filter(child => child.constructor.name === "AssistantMessageComponent"
          && (child as Component & { lastMessage?: object }).lastMessage === current.message) : [];
        const source = matches.length === 1 && matches[0] === component
          ? proseSources?.()?.find(source => source.message === current.message) : undefined;
        // Always remeasure native rows: resize, streaming and native rebuilds may
        // invalidate the previous hit map even before the reminder is measured.
        const targets = proseTargets(rows, source?.questions ?? []);
        Object.assign(current, { lines: rows, width, targets });
        return theme ? rows.map((line, row) => targets.has(row) ? paintProse(theme(), line, width) : line) : rows;
      };
      const original = component.handleMouse;
      const descriptor = Object.getOwnPropertyDescriptor(component, "handleMouse");
      const handler: NonNullable<Component["handleMouse"]> = event => {
        const native = original?.call(component, event);
        if (native) return native;
        const current = bindings.get(component);
        if (disposed || !current || component.handleMouse !== handler || component.render !== current.render
          || event.type !== "click" || event.button !== "left"
          || event.shift || event.alt || event.ctrl || event.x < 0 || event.x >= current.width || event.width !== current.width
          || (component as Component & { lastMessage?: object }).lastMessage !== current.message
          || getOsc8LinkAtColumn(current.lines[event.y] ?? "", event.x)) return;
        const question = current.targets.get(event.y);
        if (question && openProse(question.identity, current.message)) return { handled: true, render: true };
      };
      binding = { descriptor, handler, renderDescriptor, render, unregister: () => {}, message: source.message, lines, width, targets };
      bindings.set(component, binding);
      try {
        Object.defineProperty(component, "handleMouse", { configurable: true, writable: true, value: handler });
        Object.defineProperty(component, "render", { configurable: true, writable: true, value: render });
        binding.unregister = registerTranscriptRenderer(component, render);
        // This preserving decorator was installed after measuring native rows.
        // The next predicate must see first-frame amber, not captured old paint.
        invalidateTranscriptRows(tui);
      } catch { removeBinding(component); return false; }
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
      return withTranscriptMeasurement(tui, measurement => {
        let reserved = Math.max(1, dock.component.render(columns).length);
        for (const entry of extras) if (entry.visible!({ width: columns, height })) reserved += entry.component.render(columns).length;
        const viewport = Math.min(height, Math.max(1, height - reserved));
        const contentWidth = transcript.getContentWidth(columns);
        const render = (component: Component) => measurement.render(component, contentWidth);
        const lines = render(document);
        const maxTop = Math.max(0, lines.length - viewport);
        const top = transcript.isFollowingEnd ? maxTop : Math.max(0, Math.min(transcript.scrollTop, maxTop));
        const visible = new Set<object>();
        const pendingIdentities = new Set<object>(pending);
        const visit = (component: QuestionContent, start: number) => {
          const content = component[QUESTION_CONTENT]?.(contentWidth);
          if (content && pendingIdentities.has(content.identity)
            && content.rows.some(row => start + row >= top && start + row < top + viewport)) visible.add(content.identity);
          const offsets = measurement.offsets(component, contentWidth);
          // Unknown renderers may reorder/replace same-height rows. Native-looking
          // children and matching heights cannot prove their displayed coordinates.
          if (offsets) for (const [child, offset] of offsets) visit(child, start + offset);
        };
        const chat = document.children[2] as Tree;
        const preceding = measurement.offsets(document, contentWidth)?.get(chat);
        if (preceding === undefined) return fallback();
        // Refresh the grouped projection once, then share offsets and measurements across
        // every pending question. Historical resolved cards need no metadata traversal.
        const offsets = measurement.offsets(chat, contentWidth);
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
          const targets = proseTargets(rows, source.questions);
          if (!bindProse(child, source, rows, contentWidth, targets)) continue;
          retained.add(child);
          // Visibility can suppress the only reminder only after native click routing exists.
          // Choices and card padding are clickable, but only visible question text
          // can suppress the off-screen reminder.
          for (const question of source.questions) for (const row of proseRows(rows, question.id, question.question) ?? []) {
            if (targets.get(row) === question && preceding + offset + row >= top && preceding + offset + row < top + viewport) visible.add(question.identity);
          }
        }
        for (const child of bindings.keys()) if (!retained.has(child)) removeBinding(child);
        return pending.some(identity => !visible.has(identity));
      });
    } catch {
      return fallback(); // Unknown renderer/layout contracts must not hide pending questions.
    } finally {
      measuring = false;
    }
  };
  return Object.assign(show, { dispose() {
    if (disposed) return;
    disposed = true;
    clearBindings();
    releaseFrames();
  } });
}
