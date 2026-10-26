import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component, type Focusable, Input, Key, type KeybindingsManager, matchesKey, stripTerminalSequences,
  type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { questionPaint, questionPlain, questionStyle } from "./question-palette.ts";

export interface QuestionView {
  id: number;
  question: string;
  options: { label: string; description?: string }[];
  recommended?: number;
  rationale?: string;
}
export interface QuestionAnswer { text: string; optionIndex?: number }
export type QuestionUIResult = { kind: "answer"; answer: QuestionAnswer } | { kind: "defer" } | { kind: "dismiss" };

// Reject oversized cards rather than hiding approval-relevant content or choices.
// The caller owns error handling/lifecycle; no completion callback runs in the constructor.
export const QUESTION_UI_LIMITS = Object.freeze({ cardCharacters: 65_536, options: 128, answerCharacters: 8_192 });

/** Plain terminal text, not Markdown: model/user text may never supply terminal controls. */
export function sanitizeQuestionText(text: string): string {
  // In Unicode regex mode, valid surrogate pairs are a single code point and
  // do not match this range. Only unpaired UTF-16 surrogates are replaced (ES2022).
  return stripTerminalSequences(text.replace(/[\ud800-\udfff]/gu, "\ufffd"))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
}
const singleLine = (text: string) => sanitizeQuestionText(text).replace(/\n/g, " ");
type Focus = "options" | "custom" | "submit" | "defer" | "dismiss";
type Action = "submit" | "defer" | "dismiss";
type Row = { text: string; option?: number; tone: "text" | "muted" | "accent"; bold?: boolean };

/** One interaction only. Persistence, cancellation signals, and reopen belong to the caller. */
export class QuestionComponent implements Component, Focusable {
  private readonly question: QuestionView;
  private readonly input: Input;
  private hasFocus = false;
  private focus: Focus;
  private cursor = 0;
  private selected: number | undefined;
  private answerSource: "option" | "custom" | undefined;
  private finished = false;
  private error = "";
  private scroll = 0;
  private revealCursor = false;
  private rows: Row[] = [];
  private rowsWidth = -1;
  private lastWidth = 0;
  private bodyRows = 0;
  private lastHeight = 0;
  private bodyRow = 1;
  private inputRow = -1;
  private bodyColumn = 0;
  private bodyWidth = 0;
  private buttons: { action: Action; row: number; column: number; end: number }[] = [];
  private inputColumn = 0;
  private inputWidth = 0;
  private paste: string | undefined;
  private pasteOverflow = false;
  private optionClick?: { option: number; at: number; x: number; y: number };
  private lastAvailable = 0;

  constructor(
    question: QuestionView,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: QuestionUIResult) => void,
    private readonly requestRender: () => void,
    private readonly getHeight?: () => number,
  ) {
    if (question.options.length > QUESTION_UI_LIMITS.options) throw new RangeError("Question card exceeds UI limits (128 options); shorten it before asking");
    const size = question.question.length + (question.rationale?.length ?? 0)
      + question.options.reduce((sum, option) => sum + option.label.length + (option.description?.length ?? 0), 0);
    if (!Number.isSafeInteger(question.id) || question.id < 1) throw new RangeError("Question ID must be a positive safe integer");
    if (size > QUESTION_UI_LIMITS.cardCharacters) {
      throw new RangeError("Question card exceeds UI limits (65536 characters / 128 options); shorten it before asking");
    }
    this.question = {
      id: question.id, question: sanitizeQuestionText(question.question),
      options: question.options.map(option => ({ label: sanitizeQuestionText(option.label), description: option.description === undefined ? undefined : sanitizeQuestionText(option.description) })),
      recommended: Number.isInteger(question.recommended) && question.recommended! >= 0 && question.recommended! < question.options.length ? question.recommended : undefined,
      rationale: question.rationale === undefined ? undefined : sanitizeQuestionText(question.rationale),
    };
    this.focus = question.options.length ? "options" : "custom";
    this.input = new Input({ prompt: "  ", placeholder: "Type your own answer", placeholderStyle: text => questionStyle(this.theme, text, "muted") });
    this.input.onSubmit = () => this.submitCustom();
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; if (!value) this.optionClick = undefined; this.syncFocus(); }
  private syncFocus(): void { this.input.focused = this.hasFocus && this.focus === "custom" && !this.finished; }
  invalidate(): void { this.rowsWidth = -1; this.input.invalidate(); }
  private refresh(): void { this.syncFocus(); this.requestRender(); }
  private setFocus(focus: Focus): void {
    this.focus = focus;
    if (focus === "custom") {
      this.optionClick = undefined;
      // Focus changes the answer source even before typing. Keep the editable
      // draft, but never leave an earlier option staged behind an empty input.
      this.selected = undefined;
      this.answerSource = "custom";
      this.error = "";
    } else if (focus === "options") {
      this.selected = undefined;
      this.answerSource = "option";
      this.error = "";
      this.revealCursor = true;
    }
    this.refresh();
  }
  private complete(result: QuestionUIResult): void {
    if (this.finished) return;
    this.finished = true;
    this.syncFocus();
    this.done(result);
  }
  private candidate(): QuestionAnswer | undefined {
    if (this.answerSource === "option") {
      const text = this.question.options[this.cursor].label;
      return text.trim() ? { text, optionIndex: this.cursor } : undefined;
    }
    const text = this.input.getValue().trim();
    return this.answerSource === "custom" && text ? { text } : undefined;
  }
  private submit(): void {
    const answer = this.candidate();
    if (answer) this.complete({ kind: "answer", answer });
    else { this.error = "Choose an option or type an answer first."; this.refresh(); }
  }
  private select(index: number): void {
    this.cursor = this.selected = index;
    this.answerSource = "option";
    this.error = "";
    this.focus = "options";
    this.revealCursor = true;
    this.refresh();
  }
  private submitCustom(): void {
    this.answerSource = "custom";
    if (!this.input.getValue().trim()) { this.error = "Type an answer first."; this.refresh(); return; }
    this.error = "";
    this.submit();
  }
  private cycleFocus(direction: number): void {
    const order: Focus[] = this.question.options.length ? ["options", "custom", "submit", "defer", "dismiss"] : ["custom", "submit", "defer", "dismiss"];
    this.setFocus(order[(order.indexOf(this.focus) + direction + order.length) % order.length]);
  }
  private acceptText(data: string, pasted = false): void {
    const before = this.input.getValue();
    if (data.length > QUESTION_UI_LIMITS.answerCharacters) {
      this.error = "Answer too long (8192 characters maximum); nothing inserted.";
      this.refresh(); return;
    }
    this.input.handleInput(pasted ? `\x1b[200~${singleLine(data)}\x1b[201~` : data);
    const clean = singleLine(this.input.getValue());
    if (clean.length > QUESTION_UI_LIMITS.answerCharacters) {
      this.input.setValue(before);
      this.error = "Answer too long (8192 characters maximum); nothing inserted.";
    } else {
      if (clean !== this.input.getValue()) this.input.setValue(clean);
      if (clean !== before) { this.answerSource = "custom"; this.error = ""; }
    }
    this.refresh();
  }
  private handlePaste(data: string): boolean {
    const start = data.indexOf("\x1b[200~");
    if (this.paste === undefined && start < 0) return false;
    if (this.paste === undefined) { this.paste = ""; this.pasteOverflow = false; data = data.slice(start + 6); }
    const combined = this.paste + data;
    const end = combined.indexOf("\x1b[201~");
    const content = end < 0 ? combined : combined.slice(0, end);
    // An incomplete end delimiter may add up to five bytes beyond the content.
    if (content.length > QUESTION_UI_LIMITS.answerCharacters + (end < 0 ? 5 : 0)) this.pasteOverflow = true;
    if (end < 0) {
      // Retain only a delimiter-sized tail after overflow, not an unbounded paste.
      this.paste = this.pasteOverflow ? combined.slice(-5) : combined;
    } else {
      this.paste = undefined;
      if (this.pasteOverflow) { this.error = "Paste too long (8192 characters maximum); nothing inserted."; this.refresh(); }
      else { this.setFocus("custom"); this.acceptText(content, true); }
      // Trailing bytes cannot turn pasted content into a submit/cancel action.
    }
    return true;
  }

  handleInput(data: string): void {
    if (this.finished) return;
    this.optionClick = undefined;
    const kb = this.keybindings;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || kb.matches(data, "tui.select.cancel")) {
      this.complete({ kind: "defer" }); return;
    }
    if (this.handlePaste(data)) return;
    if (matchesKey(data, Key.shift("tab"))) { this.cycleFocus(-1); return; }
    if (matchesKey(data, Key.tab) || kb.matches(data, "tui.input.tab")) { this.cycleFocus(1); return; }
    if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.select.pageDown")) {
      this.scrollBy(kb.matches(data, "tui.select.pageUp") ? -this.bodyRows : this.bodyRows); return;
    }
    if ((this.focus === "options" || this.focus === "custom") && (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down"))) {
      // Options and custom input form one navigation list. Movement updates the
      // candidate without sending it, and never loses the editable draft.
      const count = this.question.options.length;
      const index = this.focus === "custom" ? count : this.cursor;
      const next = Math.max(0, Math.min(count, index + (kb.matches(data, "tui.select.up") ? -1 : 1)));
      if (next === count) this.setFocus("custom");
      else { this.cursor = next; this.setFocus("options"); }
      return;
    }
    if (kb.matches(data, "tui.select.confirm") || (this.focus === "custom" && kb.matches(data, "tui.input.submit"))) {
      if (this.focus === "options") { this.select(this.cursor); this.submit(); }
      else if (this.focus === "custom") this.submitCustom();
      else if (this.focus === "submit") this.submit();
      else this.complete({ kind: this.focus === "dismiss" ? "dismiss" : "defer" });
      return;
    }
    if (this.focus === "options" && matchesKey(data, Key.space)) { this.select(this.cursor); return; }
    if (this.focus === "custom") this.acceptText(data);
  }

  private scrollBy(delta: number): void {
    this.optionClick = undefined;
    this.scroll = Math.max(0, Math.min(Math.max(0, this.rows.length - this.bodyRows), this.scroll + delta));
    this.revealCursor = false;
    this.refresh();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.finished) return undefined;
    if (event.x < 0 || event.x >= this.lastWidth || event.y < 0 || event.y >= this.lastHeight) {
      if (event.type !== "move") this.optionClick = undefined;
      return undefined;
    }
    if (event.type === "wheel" && event.wheelDelta) {
      this.scrollBy(Math.sign(event.wheelDelta) * Math.min(this.bodyRows, Math.max(1, Math.abs(event.wheelDelta))));
      return { handled: true, render: true };
    }
    if (event.button !== "left" || event.type === "drag") { this.optionClick = undefined; return undefined; }
    if (event.y === this.inputRow && event.x >= this.bodyColumn && event.x < this.bodyColumn + this.bodyWidth
      && (event.type === "press" || event.type === "click")) {
      this.setFocus("custom");
      // Label clicks activate the draft without moving its cursor. Actual text
      // clicks retain Input's grapheme-aware and horizontally scrolled mapping.
      if (event.x >= this.inputColumn) {
        this.input.handleMouse({ ...event, type: "press", x: event.x - this.inputColumn, y: 0, width: this.inputWidth, height: 1 });
      }
      return { handled: true, focus: true, render: true };
    }
    if (event.type !== "press" && event.type !== "click") return undefined;
    if (event.x >= this.bodyColumn && event.x < this.bodyColumn + this.bodyWidth
      && event.y >= this.bodyRow && event.y < this.bodyRow + this.bodyRows) {
      const option = this.rows[this.scroll + event.y - this.bodyRow]?.option;
      if (option !== undefined) {
        const plainClick = !event.shift && !event.alt && !event.ctrl;
        if (event.type === "press") {
          if (!plainClick || this.optionClick?.option !== option) this.optionClick = undefined;
          // Own the press so fullscreen word-selection cannot steal the gesture.
          return { handled: true, focus: !this.hasFocus };
        }
        const now = Date.now();
        const previous = this.optionClick;
        // Native click counts require identical cells. Recognize two completed
        // clicks ourselves, allowing slight pointer drift on the same choice.
        const doubleClick = plainClick && previous?.option === option
          && now >= previous.at && now - previous.at <= 300
          && Math.abs(event.x - previous.x) <= 2 && Math.abs(event.y - previous.y) <= 1;
        this.optionClick = plainClick ? { option, at: now, x: event.x, y: event.y } : undefined;
        this.select(option);
        if (doubleClick) this.submit();
        // Refocusing the current component toggles its focus off/on in Pi,
        // which would clear the first click. Never reclaim focus after completion.
        return { handled: true, focus: !this.finished && !this.hasFocus, render: true };
      }
    }
    this.optionClick = undefined;
    if (event.type !== "click") return undefined;
    const button = this.buttons.find(button => event.y === button.row && event.x >= button.column && event.x < button.end);
    if (button) {
      this.focus = button.action;
      if (button.action === "submit") this.submit();
      else this.complete({ kind: button.action === "dismiss" ? "dismiss" : "defer" });
      // Completion closes the overlay synchronously. Do not let mouse dispatch
      // refocus this finished component after the host restores the editor.
      return { handled: true, focus: !this.finished, render: true };
    }
    return undefined;
  }

  private layout(width: number): void {
    if (width === this.rowsWidth) return;
    this.rowsWidth = width;
    this.rows = [];
    const add = (text: string, tone: Row["tone"], option?: number, bold = false) => {
      for (const line of wrapTextWithAnsi(text, Math.max(1, width - (option === undefined || width < 5 ? 0 : 3)))) this.rows.push({ text: line, tone, option, bold });
    };
    const separate = () => this.rows.push({ text: "", tone: "muted" });
    add(this.question.question, "text", undefined, true);
    this.question.options.forEach((option, index) => {
      separate();
      add(`${index + 1}. ${option.label}${index === this.question.recommended ? " [recommended · advisory]" : ""}`, "accent", index, true);
      if (option.description) add(`   ${option.description}`, "muted", index);
    });
    if (this.question.rationale) {
      separate();
      add(`Rationale: ${this.question.rationale}`, "muted");
    }
  }
  render(width: number): string[] {
    // render() receives overlay width, not height. Match the caller's margin: 1
    // and at most 90% of terminal rows; never reserve transcript/footer rows.
    // Pi clips overlay output rather than laying it out again at maxHeight.
    const height = this.getHeight?.();
    const available = height !== undefined && Number.isFinite(height)
      ? Math.max(1, Math.min(Math.floor(height * .9), Math.floor(height) - 2)) : 16;
    const columns = Number.isFinite(width) ? Math.max(0, Math.min(4096, Math.floor(width))) : 0;
    if (columns !== this.lastWidth || available !== this.lastAvailable) this.optionClick = undefined;
    this.lastAvailable = available;
    this.lastWidth = columns;
    this.lastHeight = 0;
    this.inputRow = -1;
    this.buttons = [];
    if (!columns) return [];

    const actions: Action[] = ["submit", "defer", "dismiss"];
    const label = (action: Action, inner: number) => action === "submit" ? (inner >= 48 ? "[Submit answer]" : "[Submit]")
      : action === "defer" ? "[Close]" : "[Dismiss]";
    const controls = (inner: number) => {
      const groups: Action[][] = [[]];
      let used = 0;
      for (const action of actions) {
        const size = label(action, inner).length + 1;
        if (used && used + 1 + size > inner) { groups.push([]); used = 0; }
        groups.at(-1)!.push(action);
        used += (used ? 1 : 0) + size;
      }
      return groups;
    };
    // Keep a body row, labeled input and every button before spending rows on
    // decoration. Tiny terminals show the focused action; Tab still reaches all.
    const framed = columns >= 12 && available >= controls(columns - 2).length + 4;
    let padding = framed ? (columns >= 24 ? 2 : columns >= 16 ? 1 : 0) : 0;
    // Give up horizontal decoration before hiding the frame or an action.
    while (padding > 0 && available < controls(columns - 2 - padding * 2).length + 4) padding--;
    const inset = framed ? 1 + padding : 0;
    const inner = columns - 2 * inset;
    let groups = controls(inner);
    if (inner < 10 || available < groups.length + 2) {
      groups = [[actions.includes(this.focus as Action) ? this.focus as Action : "submit"]];
    }
    const controlRows = groups.length;
    const frameRows = framed ? 2 : 0;
    const showInput = available >= frameRows + controlRows + 1;
    const showError = Boolean(this.error) && available >= frameRows + controlRows + Number(showInput) + 1;
    const overhead = frameRows + controlRows + Number(showInput) + Number(showError);
    this.layout(inner);
    // Spend spare rows on breathing room, not a duplicate "Ready" summary.
    // Preserve a useful viewport first; on small terminals decoration vanishes.
    const spare = Math.max(0, available - overhead - this.rows.length);
    const topGap = framed && spare >= 1;
    const customGap = showInput && spare >= 2;
    const controlsGap = showInput && spare >= 3;
    const bottomGap = framed && spare >= 4;
    const spacing = Number(topGap) + Number(customGap) + Number(controlsGap) + Number(bottomGap);
    this.bodyRows = Math.max(0, Math.min(this.rows.length, available - overhead - spacing));
    this.bodyRow = (framed ? 1 : 0) + Number(topGap);
    this.bodyColumn = inset;
    this.bodyWidth = inner;
    const inputLabel = inner >= 27 ? `${this.focus === "custom" ? ">" : " "}Custom answer: ` : inner >= 15 ? `${this.focus === "custom" ? ">" : " "}Custom: ` : inner >= 6 ? `${this.focus === "custom" ? ">" : " "}A: ` : "";
    this.inputColumn = inset + inputLabel.length;
    this.inputWidth = inner - inputLabel.length;
    if (this.revealCursor && this.bodyRows) {
      const index = this.rows.findIndex(row => row.option === this.cursor);
      if (index < this.scroll || index >= this.scroll + this.bodyRows) this.scroll = Math.max(0, index);
      this.revealCursor = false;
    }
    this.scroll = Math.min(this.scroll, Math.max(0, this.rows.length - this.bodyRows));
    const border = (text: string) => questionStyle(this.theme, text, "border");
    const edge = (left: string, label: string, right: string) => {
      const borderWidth = columns - 2;
      const title = truncateToWidth(" ".repeat(padding) + label, borderWidth, "");
      return border(left) + questionStyle(this.theme, title, "accent")
        + border("─".repeat(Math.max(0, borderWidth - visibleWidth(title))) + right);
    };
    const paint = (text: string, bg: "surface" | "choice" | "focused" | "selected" = "surface") => questionPaint(this.theme, text, bg);
    const line = (text: string, bg: "surface" | "choice" | "focused" | "selected" = "surface") => {
      const content = paint(truncateToWidth(text, inner, "", true), bg);
      const gutter = paint(" ".repeat(padding));
      return framed ? paint(border("│")) + gutter + content + gutter + paint(border("│")) : content;
    };
    const lines = framed ? [edge("╭", ` Q${this.question.id} · Answer question `, "╮")] : [];
    if (topGap) lines.push(line(""));
    for (const row of this.rows.slice(this.scroll, this.scroll + this.bodyRows)) {
      const isCursor = row.option !== undefined && this.focus === "options" && row.option === this.cursor;
      const isSelected = row.option !== undefined && row.option === this.selected && this.answerSource === "option";
      const prefix = row.option === undefined || inner < 5 ? "" : `${isCursor ? ">" : " "}${isSelected ? "*" : " "} `;
      const bg = isCursor ? "focused" : isSelected ? "selected" : row.option !== undefined ? "choice" : "surface";
      const text = questionStyle(this.theme, prefix + row.text, isCursor ? "accent" : row.tone, bg, { bold: row.bold });
      lines.push(line(text, bg));
    }
    this.syncFocus();
    if (customGap) lines.push(line(""));
    if (showInput) {
      this.inputRow = lines.length;
      const rendered = this.input.render(this.inputWidth)[0];
      lines.push(line(questionStyle(this.theme, inputLabel, this.focus === "custom" ? "accent" : "muted")
        + (questionPlain() ? rendered.replace(/\x1b\[[0-9;]*m/g, "") : rendered)));
    }
    if (showError) lines.push(line(questionStyle(this.theme, this.error, "warning")));
    if (controlsGap) lines.push(line(""));
    for (const group of groups) {
      let text = "";
      let column = inset;
      for (const action of group) {
        if (text) { text += " "; column++; }
        const value = `${this.focus === action ? ">" : " "}${label(action, inner)}`;
        this.buttons.push({ action, row: lines.length, column, end: Math.min(inset + inner, column + value.length) });
        text += questionStyle(this.theme, value, action === "submit" ? "success" : action === "defer" ? "accent" : "warning",
          this.focus === action ? "focused" : "choice", { bold: true, underline: this.focus === action });
        column += value.length;
      }
      lines.push(line(text));
    }
    if (bottomGap) lines.push(line(""));
    if (framed) {
      const range = this.rows.length > this.bodyRows ? `${this.scroll + 1}-${this.scroll + this.bodyRows}/${this.rows.length} ` : "";
      lines.push(edge("╰", this.error && !showError ? ` ${this.error} `
        : range ? ` ${range}PgUp/PgDn · Tab focus · Esc/Close pending `
        : " ↑↓ move · Enter send · Tab focus · Esc/Close pending ", "╯"));
    }
    this.lastHeight = lines.length;
    return lines.map(text => paint(text));
  }
}

export function createQuestionComponent(
  question: QuestionView, theme: Theme, keybindings: KeybindingsManager,
  done: (result: QuestionUIResult) => void, requestRender: () => void,
  getHeight?: () => number,
): Component {
  return new QuestionComponent(question, theme, keybindings, done, requestRender, getHeight);
}
