import type { ExtensionAPI, MarkdownTransformContext, Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, visibleWidth } from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Inline code protects literal content from Markdown and Pi's math tokenizer.
// Choose a delimiter longer than any run in the content. The extra space at each
// end is removed by CommonMark, preserving the original indentation/padding.
// Styling belongs inside this protection too: ANSI's '[' can otherwise open a
// Markdown link completed by literal content such as ']](path)'.
function literal(text: string): string {
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length)) + 1);
  return `${fence} ${text} ${fence}`;
}

function panel(body: string[], width: number, theme: Theme): string {
  const padding = width >= 4 ? 1 : 0;
  const available = Math.max(1, width - padding * 2);
  const background = mixColors(theme.colors.userMessageBg, theme.colors.text, 0.08);
  const rows: string[] = [];
  const add = (text: string) => {
    const padded = " ".repeat(padding) + text + " ".repeat(Math.max(0, width - padding - visibleWidth(text)));
    rows.push(literal(theme.style(padded, { fg: "text", bg: background })));
  };
  for (const line of body) {
    // Pi's Markdown renderer also displays tabs as three spaces. Hard wrapping
    // here, unlike word wrapping, retains every space and tree-drawing glyph.
    let chunk = "";
    let columns = 0;
    for (const { segment } of graphemes.segment(line.replace(/\t/g, "   "))) {
      const size = visibleWidth(segment);
      if (chunk && columns + size > available) {
        add(chunk);
        chunk = "";
        columns = 0;
      }
      chunk += segment;
      columns += size;
    }
    add(chunk);
  }
  if (rows.length === 0) add("");
  return rows.join("\n");
}

// CommonMark HTML-block starts, not inline angle-bracket text/autolinks. Known
// block tags may have trailing content; other tags must occupy the whole line.
const blockTag = /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i;
const completeTag = /^ {0,3}(?:<\/[a-z][\w-]*\s*>|<[a-z][\w-]*(?:\s+[a-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>)\s*$/i;
function htmlBlockEnd(line: string): RegExp | "blank" | undefined {
  const tag = /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i.exec(line)?.[1];
  if (tag) return new RegExp(`</${tag}\\s*>`, "i");
  if (/^ {0,3}<!--/.test(line)) return /-->/;
  if (/^ {0,3}<\?/.test(line)) return /\?>/;
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return /\]\]>/;
  if (/^ {0,3}<![A-Z]/.test(line)) return />/;
  if (blockTag.test(line) || completeTag.test(line)) return "blank";
  return undefined;
}

function transform(markdown: string, context: MarkdownTransformContext, theme: Theme): string {
  // Thinking keeps Pi's native styling. Only interactive assistant/user Markdown
  // reaches this callback; no messages or provider/model context are modified.
  if (context.messageType === "assistant-thinking") return markdown;
  const lines = markdown.split("\n");
  const output: string[] = [];
  let htmlEnd: RegExp | "blank" | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (htmlEnd) {
      output.push(lines[i]);
      if (htmlEnd === "blank" ? !line.trim() : htmlEnd.test(line)) htmlEnd = undefined;
      continue;
    }
    // Fences inside raw HTML are literal, but URL/email autolinks are not HTML.
    const htmlEnding = htmlBlockEnd(line);
    if (htmlEnding) {
      if (htmlEnding === "blank" || !htmlEnding.test(line)) htmlEnd = htmlEnding;
      output.push(lines[i]);
      continue;
    }
    const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (!opening || (opening[2][0] === "`" && opening[3].includes("`"))) {
      output.push(lines[i]);
      continue;
    }
    const marker = opening[2];
    const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
    let end = i + 1;
    while (end < lines.length && !closing.test(lines[end].replace(/\r$/, ""))) end++;
    // Only unindented, explicitly plain-text fences. Other languages, unlabeled
    // snippets, indented/list fences and Mermaid remain byte-for-byte unchanged.
    const eligible = !opening[1] && /^(?:text|plaintext|txt)$/i.test(opening[3].trim()) && i + 1 < lines.length;
    if (!eligible) {
      output.push(...lines.slice(i, Math.min(end + 1, lines.length)));
    } else {
      const body = lines.slice(i + 1, end).map(text => text.replace(/\r$/, ""));
      if (end === lines.length && body.at(-1) === "") body.pop();
      // As with Pi's native renderer, do not flash partial closing fence glyphs
      // while they stream. Completed messages retain genuine one/two-glyph lines.
      const last = body.at(-1);
      if (context.isStreaming && end === lines.length && last && last.length < marker.length && last === marker[0].repeat(last.length)) body.pop();
      output.push("", panel(body, context.availableWidth, theme), "");
    }
    i = end;
  }
  return output.join("\n");
}

/** Display-only panels via Pi's supported Markdown transformer, scoped to its runtime. */
export function registerTextPanels(pi: ExtensionAPI, enabled: boolean): void {
  if (!enabled) return;
  let getTheme: (() => Theme) | undefined;
  pi.on("session_start", (_event, ctx) => {
    // Read the current theme on each render, rather than capturing stale colors.
    getTheme = ctx.mode === "tui" ? () => ctx.ui.theme : undefined;
  });
  pi.on("session_shutdown", () => { getTheme = undefined; });
  pi.registerMarkdownTransformer((markdown, context) => {
    const theme = getTheme?.();
    return theme ? transform(markdown, context, theme) : markdown;
  });
}
