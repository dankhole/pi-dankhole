import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, parseSkillBlock, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { userBackground } from "./palette.ts";
import { isTranscriptRendererSupported, withTranscriptMeasurement } from "./transcript-measurement.ts";

interface Tree extends Component { children: Component[] }
interface Stack extends Tree {
  gap: number;
  entries: { component: Component; basis?: number | "auto"; grow?: number; shrink?: number; minSize?: number; maxSize?: number; visible?: unknown }[];
  addChild(component: Component, options: Record<string, unknown>): void;
  removeChild(component: Component): void;
}
interface Transcript extends Tree {
  primary: boolean;
  viewportHeight: number;
  scrollTop: number;
  isFollowingEnd: boolean;
  getContentWidth(width: number): number;
  scrollTo(offset: number, options: { disableFollow: boolean }): void;
  updateLayout(height: number, viewport: number, requestRender: () => void): void;
}

const isTree = (value: unknown): value is Tree => !!value && Array.isArray((value as Tree).children)
  && typeof (value as Tree).render === "function";
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();

type UserRow = { id: string; kind: "UserMessageComponent" | "SkillInvocationMessageComponent" };
interface Prompt { text: string; displayed: boolean; id?: string; rows?: UserRow[] }

function userRows(id: string, text: string): UserRow[] {
  if (!text) return [];
  const skill = parseSkillBlock(text);
  return skill ? [{ id, kind: "SkillInvocationMessageComponent" },
    ...(skill.userMessage ? [{ id, kind: "UserMessageComponent" as const }] : [])]
    : [{ id, kind: "UserMessageComponent" }];
}

const messageText = (content: string | { type: string; text?: string }[]) => typeof content === "string" ? content
  : content.filter(block => block.type === "text").map(block => block.text ?? "").join("");

function latestInput(chat: Tree, expected?: string): { component: Component; text: string } | undefined {
  for (let index = chat.children.length - 1; index >= 0; index--) {
    const component = chat.children[index];
    const text = (component as Component & { text?: string }).text;
    if (component.constructor.name === "UserMessageComponent" && typeof text === "string" && (expected === undefined || text === expected)) {
      return { component, text };
    }
    const name = (component as Component & { skillBlock?: { name?: string } }).skillBlock?.name;
    if (component.constructor.name === "SkillInvocationMessageComponent" && typeof name === "string"
      && (expected === undefined || expected === `[skill] ${name}`)) {
      return { component, text: `[skill] ${name}` };
    }
  }
}

/** Version-sensitive, instance-local adapter. Never replace native header/footer or transcript rows. */
export function installPinnedPrompt(tui: TUI, getTheme: () => Theme, fromHistory: () => Prompt | undefined, notify: (message: string) => void, conversationPanels = true) {
  const root = (tui as unknown as { layoutRoot?: Stack }).layoutRoot;
  const document = (tui as unknown as Tree).children?.[0];
  if (!root || root.constructor.name !== "VStack" || !isTree(root) || !Array.isArray(root.entries)
    || root.entries.length !== root.children.length || root.entries.some((entry, index) => entry.component !== root.children[index])
    || typeof root.addChild !== "function" || typeof root.removeChild !== "function" || !isTree(document)
    || document.children.length !== 3 || !document.children.every(isTree)) return undefined;
  const transcript = root.children.find(child => child.constructor.name === "ScrollView"
    && (child as Transcript).primary && (child as Tree).children?.[0] === document) as Transcript | undefined;
  if (!transcript || typeof transcript.scrollTo !== "function" || typeof transcript.getContentWidth !== "function"
    || typeof transcript.updateLayout !== "function") return undefined;
  const chat = document.children[2] as Tree;
  // Pi does not expose entry IDs on native user components. Associate the complete
  // compaction-aware sequence with native user/skill rows by order, never by text.
  // A previously bound component cannot silently become a different branch entry.
  const identities = new WeakMap<Component, string>();
  const currentPrompt = () => {
    const prompt = fromHistory();
    if (!prompt) return { ...latestInput(chat), identified: false };
    if (!prompt.displayed) return { text: prompt.text, component: undefined, identified: false };
    if (prompt.id && prompt.rows) {
      const native = chat.children.filter(child => ["UserMessageComponent", "SkillInvocationMessageComponent"].includes(child.constructor.name));
      if (native.length !== prompt.rows.length || native.some((child, index) => child.constructor.name !== prompt.rows![index].kind
        || identities.has(child) && identities.get(child) !== prompt.rows![index].id)) {
        return { text: prompt.text, component: undefined, identified: false };
      }
      for (let index = 0; index < native.length; index++) identities.set(native[index], prompt.rows[index].id);
      let index = prompt.rows.length - 1;
      while (index >= 0 && prompt.rows[index].id !== prompt.id) index--;
      return { text: prompt.text, component: index < 0 ? undefined : native[index], identified: index >= 0 };
    }
    // Older hosts without provenance retain the old pin/jump behavior, but never
    // guess that matching text is proof the selected entry is on screen.
    return { text: prompt.text, component: latestInput(chat, prompt.text)?.component, identified: false };
  };
  let width = 0;
  let disposed = false;
  let shown = true;
  // Restrict height prediction to the installed Pi's standard two-entry root.
  // The public StackEntry.visible callback supplies the *current* frame dimensions;
  // ScrollView's public bounds then predict the viewport with our row absent.
  // Using that canonical, larger viewport makes the decision independent of the
  // previous pin height (including follow-end), without changing native scrolling.
  const nativeEntries = [...root.entries];
  const [scrollEntry, dockEntry] = nativeEntries;
  const measurable = () => nativeEntries.length === 2 && root.entries.length === 3
    && root.entries[1] === scrollEntry && root.entries[2] === dockEntry
    && scrollEntry?.component === transcript && root.gap === 0
    && scrollEntry.basis === 0 && scrollEntry.grow === 1 && scrollEntry.shrink === 1 && scrollEntry.minSize === 1
    && scrollEntry.maxSize === undefined && scrollEntry.visible === undefined
    && dockEntry?.basis === "auto" && dockEntry.grow === 0 && dockEntry.shrink === 1 && dockEntry.minSize === 1
    && dockEntry.maxSize === undefined && dockEntry.visible === undefined;
  const show = ({ width: columns, height }: { width: number; height: number }) => withTranscriptMeasurement(tui, measurement => {
    const latest = measurement.memo(identities, currentPrompt);
    shown = !disposed && !!latest.text;
    if (!shown || !measurable() || !latest.identified || !latest.component || !isTranscriptRendererSupported(latest.component) || !Number.isFinite(transcript.scrollTop)
      || typeof transcript.isFollowingEnd !== "boolean" || height >= Number.MAX_SAFE_INTEGER) return shown;
    width = columns;
    const contentWidth = transcript.getContentWidth(columns);
    const lines = measurement.render(document, contentWidth);
    const preceding = measurement.offsets(document, contentWidth)?.get(chat);
    const offset = measurement.offsets(chat, contentWidth)?.get(latest.component);
    if (preceding === undefined || offset === undefined) return shown;
    const start = preceding + offset;
    const rows = measurement.render(latest.component, contentWidth);
    // Blank padding and blank markdown lines are not visible message content.
    const contentRows = rows.flatMap((line, index) => clean(line) ? [start + index] : []);
    if (!contentRows.length) return shown;
    const viewport = Math.min(height, Math.max(1, height - Math.max(1, dockEntry.component.render(columns).length)));
    const maxTop = Math.max(0, lines.length - viewport);
    const top = transcript.isFollowingEnd ? maxTop : Math.min(Math.max(0, transcript.scrollTop), maxTop);
    shown = !contentRows.some(row => row >= top && row < top + viewport);
    return shown;
  });
  const jump = () => withTranscriptMeasurement(tui, measurement => {
    if (disposed) return;
    const latest = measurement.memo(identities, currentPrompt);
    if (!latest?.component) {
      notify("The latest input is not in the displayed transcript (image-only input or removed by compaction).");
      return;
    }
    if (!isTranscriptRendererSupported(latest.component)) {
      notify("The latest input cannot be located in this transcript layout; native scrolling is unchanged.");
      return;
    }
    if (width <= 0) return;
    const contentWidth = transcript.getContentWidth(width);
    const lines = measurement.render(document, contentWidth);
    const preceding = measurement.offsets(document, contentWidth)?.get(chat);
    const offset = measurement.offsets(chat, contentWidth)?.get(latest.component);
    if (preceding === undefined || offset === undefined) {
      notify("The latest input cannot be located in this transcript layout; native scrolling is unchanged.");
      return;
    }
    // Refresh bounds first: streaming, resize or a rebuilt transcript may have changed its height.
    transcript.updateLayout(lines.length, transcript.viewportHeight, () => tui.requestRender());
    transcript.scrollTo(preceding + offset, { disableFollow: true });
    tui.requestRender();
  });
  const bar: Component = {
    invalidate() {},
    render(columns) {
      width = columns;
      // Painting needs history text only, not another provenance/row association pass.
      const text = fromHistory()?.text ?? latestInput(chat)?.text;
      if (disposed || !shown || !text || columns <= 0) return [];
      const body = truncateToWidth(` ↑ You: ${clean(text)}  · click to jump`, columns);
      const theme = getTheme();
      const line = theme.fg("userMessageText", body + " ".repeat(Math.max(0, columns - visibleWidth(body))));
      const background = conversationPanels ? userBackground(theme) : "";
      return [background ? background + line + "\x1b[49m" : theme.bg("userMessageBg", line)];
    },
    handleMouse(event) {
      if (!shown || event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
      jump();
      return { handled: true };
    },
  };
  // VStack keeps both an ordinary child list and its layout entries. Check their one-to-one
  // relationship above, add with the native API, then move only our own entry to the top.
  currentPrompt(); // Bind current native identities before a later branch can replace the selection.
  root.addChild(bar, { basis: "auto", grow: 0, shrink: 0, minSize: 0, maxSize: 1, visible: show });
  root.children.unshift(root.children.pop()!);
  root.entries.unshift(root.entries.pop()!);
  root.invalidate();
  tui.requestRender();
  return {
    jump,
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeChild(bar);
      root.invalidate();
      tui.requestRender();
    },
  };
}

export function registerPinnedPrompt(pi: ExtensionAPI, enabled: boolean, conversationPanels = true) {
  let installed: ReturnType<typeof installPinnedPrompt>;
  let reconcile: (() => void) | undefined;
  const dispose = () => { installed?.dispose(); installed = undefined; reconcile = undefined; };
  pi.registerCommand("latest-input", {
    description: "Scroll to the most recent user input (fullscreen mode)",
    handler: async (_args, ctx) => {
      reconcile?.();
      if (installed) installed.jump();
      else ctx.ui.notify("Pinned input requires fullscreen mode and Pin latest user input enabled in /dankhole.", "info");
    },
  });
  if (!enabled) return;
  pi.on("session_start", (_event, ctx) => {
    dispose();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    ctx.ui.setWidget("compact-tools-pinned-input", tui => {
      dispose();
      let historyKey: string | undefined;
      let historyPrompt: Prompt | undefined;
      const fromHistory = (): Prompt | undefined => {
        const manager = ctx.sessionManager;
        const leaf = manager.getLeafId();
        const provenance = typeof manager.buildContextEntries === "function";
        const key = leaf || provenance ? `${manager.getSessionId()}:${leaf ?? ""}` : undefined;
        // Scroll/resize/group expansion never rescan session history. Branch and
        // compaction provenance is rebuilt only when the selected leaf changes.
        if (key !== undefined && key === historyKey) return historyPrompt;
        historyKey = key;
        historyPrompt = undefined;
        const branch = manager.getBranch();
        for (let index = branch.length - 1; index >= 0; index--) {
          const entry = branch[index];
          if (entry.type !== "message" || entry.message.role !== "user") continue;
          const text = messageText(entry.message.content);
          const skill = parseSkillBlock(text);
          const rows = provenance ? manager.buildContextEntries().flatMap(item =>
            item.type === "message" && item.message.role === "user" ? userRows(item.id, messageText(item.message.content)) : []) : undefined;
          historyPrompt = { id: entry.id, text: !text ? "[Image attachment]" : skill ? skill.userMessage || `[skill] ${skill.name}` : text,
            displayed: !!text, rows };
          return historyPrompt;
        }
        // A supported host's empty selected branch is authoritative even while
        // the previous branch's native transcript is awaiting its rebuild.
        if (provenance) {
          historyPrompt = { text: "", displayed: false };
          return historyPrompt;
        }
      };
      let lastRoot: unknown;
      let lastMode: string | undefined;
      const sync = () => {
        const root = (tui as unknown as { layoutRoot?: unknown }).layoutRoot;
        if (root === lastRoot && tui.mode === lastMode) return;
        installed?.dispose();
        installed = undefined;
        lastRoot = root;
        lastMode = tui.mode;
        // Regular-mode terminals own their scrollback. Reconcile on render so a
        // later regular -> fullscreen settings change works without /reload.
        if (tui.mode !== "fullscreen") return;
        installed = installPinnedPrompt(tui, () => ctx.ui.theme, fromHistory, message => ctx.ui.notify(message, "info"), conversationPanels);
        if (!installed) ctx.ui.notify("Compact tools: pinned input is unavailable for this Pi layout; native UI is unchanged.", "warning");
      };
      reconcile = sync;
      sync();
      return { render() { sync(); return []; }, invalidate() {}, dispose };
    });
  });
  pi.on("session_shutdown", dispose);
}
