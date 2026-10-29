import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getThinkingLevelDisplay, hasNerdFonts } from "../../vendor/powerline/footer-helpers.ts";
import { paint } from "./palette.ts";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

function clean(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/ +/g, " ").trim();
}

/** Border styling, native inset and outer spacing; Pi owns editing, history, completion, paste and images. */
class InputBar extends CustomEditor {
  constructor(...args: [...Parameters<EditorFactory>, () => ExtensionContext, () => string, (width: number) => string, boolean]) {
    const [tui, theme, keybindings, getContext, getThinking, getStats, keepAwake] = args;
    super(tui, theme, keybindings, { embedWorkingStatus: true, paddingX: 1 });
    this.getContext = getContext;
    this.getThinking = getThinking;
    this.getStats = getStats;
    this.keepAwake = keepAwake;
  }

  private readonly getContext: () => ExtensionContext;
  private readonly getThinking: () => string;
  private readonly getStats: (width: number) => string;
  private readonly keepAwake: boolean;
  private hasWorkingStatus = false;
  private historyReady = false;

  setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
    this.hasWorkingStatus = indicator !== undefined;
    super.setWorkingStatusIndicator(indicator);
  }

  addToHistory(text: string): void {
    // Initial host rendering populates history after session_start. Do not seed
    // that history twice; on reload the host rebuilds without populateHistory.
    this.historyReady = true;
    super.addToHistory(text);
  }

  handleInput(data: string): void {
    if (!this.historyReady) {
      this.historyReady = true;
      // getBranch is chronological and excludes abandoned branches. Like native
      // history restoration, include actual user-role text (including extension
      // sendUserMessage), not custom/control messages or image-only inputs.
      for (const entry of this.getContext().sessionManager.getBranch()) {
        if (entry.type !== "message" || entry.message.role !== "user") continue;
        const content = entry.message.content;
        const text = typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join("");
        super.addToHistory(text);
      }
    }
    super.handleInput(data);
  }

  render(width: number): string[] {
    // Pi copies its default padding after the factory returns. Reassert our
    // native inset here, yielding below four columns so wide graphemes fit.
    super.setPaddingX(width >= 4 ? 1 : 0);
    return ["", ...super.render(width), ""];
  }

  handleMouse(event: Parameters<CustomEditor["handleMouse"]>[0]): ReturnType<CustomEditor["handleMouse"]> {
    // Outer whitespace is not an editor/completion row. Translate both text
    // clicks and autocomplete hit testing back into native editor coordinates.
    if (event.y < 1 || event.y >= event.height - 1) return undefined;
    return super.handleMouse({ ...event, y: event.y - 1, height: event.height - 2 });
  }

  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    const ctx = this.getContext();
    const theme = ctx.ui.theme;
    const plain = process.env.TERM === "dumb" || process.env.NO_COLOR !== undefined;
    const nerd = !plain && hasNerdFonts();
    // Native bash/thinking state owns borderColor. Blue decorations are local;
    // native rules and working/overflow indicators retain their mode cues.
    const decorate = (value: string) => paint(theme, "rule", value);
    if (width < 16) return super.renderTopBorder(width, hiddenLineCount);
    const model = clean(ctx.model?.name || ctx.model?.id || "no-model").replace(/\s*\(litellm\)$/i, "");
    const folder = clean(basename(ctx.sessionManager.getCwd()) || ctx.sessionManager.getCwd());
    // Keep native working/overflow rendering in the middle. At narrow widths
    // Pi chooses its spinner/overflow fallback; decorative fields yield first.
    const nativeReserve = this.hasWorkingStatus || hiddenLineCount > 0 ? Math.min(24, Math.floor(width / 3)) : 3;
    // Cap long breadcrumbs at 60% of the flexible space; any unused columns
    // go straight to the statistics rather than becoming a fixed left pane.
    const leftBudget = Math.floor((width - nativeReserve - 1) * 0.6);
    // The text-style cup leaves its second column blank: no extra trailing space.
    const awake = this.keepAwake ? decorate(plain ? "- " : "─ ") + paint(theme, "cost", plain ? "[awake] " : "☕") : "";
    const budget = Math.max(0, leftBudget - 3 - visibleWidth(awake));
    const separator = plain ? " > " : " › ";
    const folderBudget = Math.min(visibleWidth(folder) + (nerd ? 2 : 0), Math.floor(budget / 2));
    const folderText = truncateToWidth(`${nerd ? " " : ""}${folder}`, folderBudget, "");
    const modelBudget = Math.max(0, budget - visibleWidth(separator) - visibleWidth(folderText));
    const thinking = ctx.model?.reasoning ? clean(getThinkingLevelDisplay(this.getThinking()).label) : "";
    // Keep the level whole beside the model, or omit it on very narrow borders.
    const thinkingText = thinking && modelBudget >= visibleWidth(thinking) + 5 ? ` ${thinking}` : "";
    const modelText = truncateToWidth(`${nerd ? " " : ""}${model}`, Math.max(0, modelBudget - visibleWidth(thinkingText)), "");
    const crumb = paint(theme, "model", modelText) + paint(theme, "thinking", thinkingText)
      + decorate(separator) + paint(theme, "folder", folderText);
    const prefix = truncateToWidth(awake + decorate(plain ? "- " : "─ ") + crumb + " ", leftBudget, "");
    const stats = this.getStats(Math.max(0, width - visibleWidth(prefix) - nativeReserve - 1));
    const nativeWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(stats) - (stats ? 1 : 0));
    const native = truncateToWidth(super.renderTopBorder(nativeWidth, hiddenLineCount), nativeWidth, "");
    return prefix + native + (stats ? " " + stats : "");
  }
}

/** Installs only in the public editor slot; a later extension retains ownership on cleanup. */
export function installInputBar(
  ctx: ExtensionContext,
  getContext: () => ExtensionContext,
  getThinking: () => string = () => getContext().thinkingLevel ?? "off",
  getStats: (width: number) => string = () => "",
  keepAwake = false,
): { dispose: () => void; isActive: () => boolean } | undefined {
  if (typeof ctx.ui.setEditorComponent !== "function" || typeof ctx.ui.getEditorComponent !== "function") return undefined;
  const previous = ctx.ui.getEditorComponent();
  const factory: EditorFactory = (tui, theme, keybindings) => new InputBar(tui, theme, keybindings, getContext, getThinking, getStats, keepAwake);
  ctx.ui.setEditorComponent(factory);
  const isActive = () => ctx.ui.getEditorComponent() === factory;
  return {
    isActive,
    dispose() { if (isActive()) ctx.ui.setEditorComponent(previous); },
  };
}
