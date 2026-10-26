import { type ExtensionAPI, highlightCode, type MarkdownTransformContext, type Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, mixColors, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

const isPlaintext = (language: string) => /^(?:text|plaintext|txt)$/i.test(language);

// Pi's public word wrapper drops whitespace, while column slicing rescans and
// replays all preceding ANSI. Walk source graphemes and highlighted SGRs once;
// only the effective foreground/attributes carry to each new row, never history.
function hardWrap(source: string, highlighted: string, width: number): string[] {
  const styles = new Map<number, string>();
  const track = (parameters: string) => {
    const values = parameters.split(";").map(Number);
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value === 0) styles.clear();
      else if (value === 38 || value === 48 || value === 58) {
        const count = values[i + 1] === 2 ? 4 : 2;
        if (value === 38) styles.set(38, `\x1b[${values.slice(i, i + count + 1).join(";")}m`);
        i += count;
      } else if ((value >= 30 && value <= 37) || (value >= 90 && value <= 97)) {
        styles.set(38, `\x1b[${value}m`);
      } else if (value === 39) styles.delete(38);
      else if ([1, 2, 3, 4, 7, 9].includes(value)) styles.set(value, `\x1b[${value}m`);
      else if (value === 22) { styles.delete(1); styles.delete(2); }
      else if ([23, 24, 27, 29].includes(value)) styles.delete(value - 20);
    }
  };
  const rows: string[] = [];
  const codes = highlighted.matchAll(/\x1b\[([\d;]*)m/g);
  let next = codes.next();
  let cursor = 0;
  let columns = 0;
  let row = "";
  for (const { segment } of graphemes.segment(source)) {
    const size = visibleWidth(segment);
    if (columns && columns + size > width) {
      rows.push(row);
      row = [...styles.values()].join("");
      columns = 0;
    }
    // ANSI may occur inside a grapheme, so locate its end by source UTF-16
    // length rather than segmenting styled substrings and splitting that glyph.
    let end = cursor + segment.length;
    const fits = size <= width;
    while (!next.done && next.value.index < end) {
      const code = next.value;
      end += code[0].length;
      track(code[1]);
      if (!fits) row += code[0];
      next = codes.next();
    }
    // A two-cell glyph cannot fit a one-cell terminal. Omit only that glyph;
    // consume its styles so subsequent text still has the correct foreground.
    if (fits) {
      row += highlighted.slice(cursor, end);
      columns += size;
    }
    cursor = end;
  }
  rows.push(row + highlighted.slice(cursor));
  return rows;
}

function panel(body: string[], width: number, theme: Theme, language: string): string {
  const padding = width >= 4 ? 1 : 0;
  const available = Math.max(1, width - padding * 2);
  const background = mixColors(theme.colors.userMessageBg, theme.colors.text, 0.08);
  const bg = backgroundAnsi(background, theme.getColorMode());
  const fg = theme.getFgAnsi("text");
  const rows: string[] = [];
  const add = (text: string) => {
    // A two-cell grapheme cannot fit a one-cell terminal. Omit that glyph rather
    // than emitting an over-wide line; ordinary wrapping never truncates text.
    text = truncateToWidth(text, available, "");
    // Only host-generated ANSI reaches here. Reapply the panel background after
    // every highlighter SGR, including full resets, without replacing syntax
    // foregrounds. Pi's foreground-reset forms restore the panel's base text.
    const colored = text.replace(/\x1b\[[\d;]*m/g, code =>
      code + bg + (/^\x1b\[(?:0?|39|22;39)m$/.test(code) ? fg : ""));
    const padded = " ".repeat(padding) + colored + " ".repeat(Math.max(0, width - padding - visibleWidth(text)));
    rows.push(literal(theme.style(padded, { fg: "text", bg: background })));
  };
  // Sanitize source controls before highlighting, not the highlighter's ANSI.
  // Unknown languages deliberately use Pi's literal fallback, never autodetect.
  const source = body.map(line => stripTerminalSequences(line).replace(/\t/g, "   "));
  const named = !!language && !isPlaintext(language);
  const highlighted = named ? highlightCode(source.join("\n"), language) : source;
  if (named) add(theme.fg("muted", truncateToWidth(language, available)));
  for (let i = 0; i < source.length; i++) {
    for (const row of hardWrap(source[i], highlighted[i] ?? source[i], available)) add(row);
  }
  if (source.length === 0) add("");
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

// Strip only the explicit container prefixes recognized on a nested fence's
// opening line. Missing quote markers or list-content indentation end opacity;
// an unclosed nested fence must not swallow a later top-level block.
function containerContent(line: string, containers: string[]): string | undefined {
  for (const container of containers) {
    if (container.trimStart().startsWith(">")) {
      const quote = /^ {0,3}>[ \t]?/.exec(line);
      if (!quote) return undefined;
      line = line.slice(quote[0].length);
    } else {
      if (!line.trim()) return ""; // Blank lines can continue a list.
      let required = 0;
      for (const character of container) required += character === "\t" ? 4 - required % 4 : 1;
      let columns = 0;
      let index = 0;
      while (index < line.length && columns < required && /[ \t]/.test(line[index])) {
        columns += line[index] === "\t" ? 4 - columns % 4 : 1;
        index++;
      }
      if (columns < required) return undefined;
      line = " ".repeat(columns - required) + line.slice(index);
    }
  }
  return line;
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
    // Consume explicitly prefixed list/quote fences as opaque regions too, so
    // their indented closing marker cannot be mistaken for a new outer fence.
    // This is intentionally conservative, not a nested Markdown parser.
    const nested = /^((?:(?: {0,3}>[ \t]?)|(?: {0,3}(?:[-+*]|\d+[.)])[ \t]+))+)[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (nested && !(nested[2][0] === "`" && nested[3].includes("`"))) {
      const containers = nested[1].match(/ {0,3}>[ \t]?| {0,3}(?:[-+*]|\d+[.)])[ \t]+/g) ?? [];
      const closing = new RegExp(`^ {0,3}${nested[2][0]}{${nested[2].length},}[ \\t]*$`);
      let end = i + 1;
      while (end < lines.length) {
        const content = containerContent(lines[end].replace(/\r$/, ""), containers);
        if (content === undefined) break;
        end++;
        if (closing.test(content)) break;
      }
      output.push(...lines.slice(i, end));
      i = end - 1;
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
    const info = opening[3].trim();
    const language = stripTerminalSequences(info.split(/\s+/)[0]).toLowerCase();
    // Assistant blocks use the first info word; user messages retain exactly
    // their existing explicit-plaintext-only panels. Mermaid stays native.
    const eligible = !opening[1] && i + 1 < lines.length &&
      (context.messageType === "user" ? isPlaintext(info) : language !== "mermaid");
    if (!eligible) {
      output.push(...lines.slice(i, Math.min(end + 1, lines.length)));
    } else {
      const body = lines.slice(i + 1, end).map(text => text.replace(/\r$/, ""));
      if (end === lines.length && body.at(-1) === "") body.pop();
      // Do not flash partial closing fence glyphs while they stream, including
      // legal closing indentation/trailing spaces. Final messages retain them.
      const last = body.at(-1);
      const partialClosing = new RegExp(`^ {0,3}${marker[0]}{1,${marker.length - 1}}[ \\t]*$`);
      if (context.isStreaming && end === lines.length && last && partialClosing.test(last)) body.pop();
      output.push("", panel(body, context.availableWidth, theme, language), "");
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
