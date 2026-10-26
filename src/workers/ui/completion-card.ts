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

/** Display-only: no transcript reads, model calls, or changes to captured notification data. */
export class CompletionCards implements Component {
  private readonly cards: { details: NotificationDetails; markdown: Markdown }[];

  constructor(details: NotificationDetails, private expanded: boolean, private theme: Theme, private showCost: boolean) {
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
      return { details: d, markdown: new Markdown(text, 0, 0, markdownTheme, { color: text => theme.fg("text", text) }) };
    });
  }

  invalidate(): void {
    for (const card of this.cards) card.markdown.invalidate();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const padding = width >= 40 ? 2 : width >= 12 ? 1 : 0;
    const contentWidth = width - padding * 2;
    const margin = " ".repeat(padding);
    const background = (line: string) => {
      // A truncation/style reset must not punch holes in the panel background.
      const restored = line.replace(/\x1b\[(?:0|49)m/g, `$&${this.theme.getBgAnsi("customMessageBg")}`);
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
      const metrics = [this.showCost ? formatCost(d.totalCost ?? 0) : "", d.durationMs > 0 ? formatMs(d.durationMs) : ""].filter(Boolean).join(" · ");
      const model = d.invocation?.modelName ?? d.invocation?.modelId;
      const thinking = d.invocation?.thinking;
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
    return lines;
  }
}
