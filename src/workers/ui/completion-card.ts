import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, type MarkdownTheme, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { NotificationDetails } from "../types.js";
import { formatCost, formatMs } from "./agent-widget.js";

/** Worker text is data, not terminal instructions. Keep wording (including negation) intact. */
function safeText(text: string): string {
  return stripTerminalSequences(text).replace(/\r\n?/g, "\n").replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function statusLabel(status: string): { label: string; color: "success" | "error" | "warning" | "muted" } {
  switch (status) {
    case "completed": return { label: "Subagent completed", color: "success" };
    case "error": return { label: "Subagent failed", color: "error" };
    case "stopped": return { label: "Subagent stopped", color: "warning" };
    case "aborted": return { label: "Subagent aborted (turn limit)", color: "warning" };
    case "steered": return { label: "Subagent wrapped up (turn limit)", color: "warning" };
    default: return { label: `Subagent ${safeText(status).replace(/\s+/g, " ") || "status unknown"}`, color: "muted" };
  }
}

// Include every foreground used by the header and Markdown callbacks. Read effective ANSI,
// not theme identity: Pi can supply a stable proxy whose underlying palette changes.
const foregrounds = [
  "success", "error", "warning", "muted", "text", "syntaxVariable", "thinkingMedium", "dim",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdQuote", "mdQuoteBorder", "mdListBullet",
] as const;

type CardDetails = Pick<NotificationDetails, "status" | "description" | "totalCost" | "durationMs"> & {
  model?: string;
  thinking?: string;
};

/** Display-only: no transcript reads, model calls, or changes to captured notification data. */
export class CompletionCards implements Component {
  private readonly cards: { details: CardDetails; markdown: Markdown; createMarkdown: () => Markdown }[];
  // One final layout per instance, never a history of widths or notification identities.
  private cached?: { width: number; theme: string; showCost: boolean; lines: string[] };

  // Notification data stays captured; only presentation reads the owning registrar's
  // live setting. A boolean also supports callers with a fixed display preference.
  constructor(details: NotificationDetails, private readonly expanded: boolean, private readonly theme: Theme, private readonly showCost: boolean | (() => boolean)) {
    // Use the renderer's supplied theme, not the process-global Markdown theme.
    const markdownTheme: MarkdownTheme = {
      heading: text => theme.fg("mdHeading", /^#{3,6} $/.test(stripTerminalSequences(text)) ? "" : text),
      link: text => theme.fg("mdLink", text),
      linkUrl: text => theme.fg("mdLinkUrl", text),
      code: text => theme.fg("mdCode", text),
      codeBlock: text => theme.fg("mdCodeBlock", text),
      // Fences are structure, not part of a worker's result preview.
      codeBlockBorder: () => "",
      codeBlockIndent: "",
      quote: text => theme.fg("mdQuote", text),
      quoteBorder: text => theme.fg("mdQuoteBorder", text),
      hr: () => "",
      listBullet: text => theme.fg("mdListBullet", text),
      bold: text => theme.bold(text),
      italic: text => theme.italic(text),
      strikethrough: text => theme.strikethrough(text),
      underline: text => theme.underline(text),
    };
    this.cards = [details, ...(details.others ?? [])].map(d => {
      const result = safeText(d.resultPreview).trim();
      const error = d.status === "error" && d.error ? safeText(d.error).trim() : "";
      const preview = result && result !== "No output." ? result : "No final response captured.";
      const text = error ? `Error: ${error}${expanded ? `\n\n${preview}` : ""}` : preview;
      const createMarkdown = () => new Markdown(text, 0, 0, markdownTheme, { color: text => theme.fg("text", text) });
      // Own the displayed snapshot, including nested invocation values. External mutations must
      // not mix fresh headers with the Markdown preview captured by this constructor.
      return {
        details: {
          status: d.status, description: d.description, totalCost: d.totalCost, durationMs: d.durationMs,
          model: d.invocation?.modelName ?? d.invocation?.modelId, thinking: d.invocation?.thinking,
        },
        markdown: createMarkdown(), createMarkdown,
      };
    });
  }

  invalidate(): void {
    this.cached = undefined;
    // Pi's Markdown.invalidate() retains its defaultStylePrefix, which can embed old ANSI.
    // Recreate it so inline styles restored after code/bold also use the current theme.
    for (const card of this.cards) card.markdown = card.createMarkdown();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    // Observe once, including cache hits, so grouped cards share one setting per render.
    const showCost = typeof this.showCost === "function" ? this.showCost() : this.showCost;
    const backgroundAnsi = this.theme.getBgAnsi("customMessageBg");
    const theme = JSON.stringify([backgroundAnsi, ...foregrounds.map(color => this.theme.getFgAnsi(color))]);
    if (this.cached?.theme === theme && this.cached.width === width && this.cached.showCost === showCost) return this.cached.lines.slice();
    // Markdown caches themed rows too; changing only the outer cache would retain stale colors.
    if (this.cached && this.cached.theme !== theme) this.invalidate();
    const padding = width >= 40 ? 2 : width >= 12 ? 1 : 0;
    const contentWidth = width - padding * 2;
    const margin = " ".repeat(padding);
    const background = (line: string) => {
      // A truncation/style reset must not punch holes in the panel background.
      const restored = line.replace(/\x1b\[(?:0|49)m/g, `$&${backgroundAnsi}`);
      const padded = restored + " ".repeat(Math.max(0, width - visibleWidth(line)));
      return this.theme.bg("customMessageBg", padded) + "\x1b[0m";
    };
    const lines: string[] = [];
    for (const { details: d, markdown } of this.cards) {
      if (lines.length) lines.push("");
      const { label, color } = statusLabel(d.status);
      const status = this.theme.bold(this.theme.fg(color, label));
      const goal = this.theme.bold(this.theme.fg("text", safeText(d.description).replace(/\s+/g, " ").trim()));
      const content: string[] = [];
      const metrics = [showCost ? formatCost(d.totalCost ?? 0) : "", d.durationMs > 0 ? formatMs(d.durationMs) : ""].filter(Boolean).join(" · ");
      const model = d.model;
      const thinking = d.thinking;
      const stats = [
        ...(metrics ? [this.theme.fg("muted", metrics)] : []),
        this.theme.fg(model ? "syntaxVariable" : "muted", model ? safeText(model).replace(/\s+/g, " ") : "Model not recorded"),
        this.theme.fg(thinking ? "thinkingMedium" : "muted", `thinking: ${thinking ? safeText(thinking).replace(/\s+/g, " ") : "not recorded"}`),
      ].join(this.theme.fg("dim", " · "));
      const statsWidth = visibleWidth(stats);
      const title = `${status}${this.theme.fg("dim", " — ")}${goal}`;
      const titleWidth = contentWidth - statsWidth - 2;
      const minTitleWidth = visibleWidth(label) + 3 + 8;
      if (titleWidth >= minTitleWidth) {
        const left = truncateToWidth(title, titleWidth, "…");
        content.push(left + " ".repeat(contentWidth - visibleWidth(left) - statsWidth) + stats);
      } else {
        // On narrow terminals, keep the outcome readable and move stats below it.
        if (contentWidth >= minTitleWidth) content.push(truncateToWidth(title, contentWidth, "…"));
        else content.push(...wrapTextWithAnsi(status, contentWidth).filter(line => stripTerminalSequences(line).trim()), truncateToWidth(goal, contentWidth, "…"));
        for (const line of wrapTextWithAnsi(stats, contentWidth).filter(line => stripTerminalSequences(line).trim())) {
          content.push(" ".repeat(Math.max(0, contentWidth - visibleWidth(line))) + line);
        }
      }

      if (width >= 24) content.push("");
      const preview = markdown.render(contentWidth).filter(line => stripTerminalSequences(line).trim());
      const limit = this.expanded ? 12 : 2;
      const shown = preview.slice(0, limit).map(line => line.trimEnd());
      if (preview.length > limit) {
        shown[shown.length - 1] = truncateToWidth(`${shown[shown.length - 1]} …`, contentWidth, "…");
      }
      content.push(...shown);
      if (width >= 24) lines.push(background(""));
      for (const line of content) lines.push(background(margin + truncateToWidth(line, contentWidth, "…") + margin));
      if (width >= 24) lines.push(background(""));
    }
    this.cached = { width, theme, showCost, lines };
    // The host receives an owned array: a consumer decorating rows cannot poison our cache.
    return lines.slice();
  }
}
