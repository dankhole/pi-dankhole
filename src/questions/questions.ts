import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { questionPaint, questionPlain, questionStyle } from "./question-palette.ts";
import { createQuestionComponent, type QuestionAnswer, type QuestionUIResult, type QuestionView, sanitizeQuestionText } from "./question-ui.ts";

export const QUESTION_TOOL_NAME = "ask_user";
export const QUESTION_RESOLUTION_TOOL_NAME = "resolve_question";
// Receipts record text/source observed at our input hook, not raw keystrokes or delivery.
// Pi's UserMessage has no causal input identity; matching chat is corroboration, possibly echo.
const QUESTION_INPUT_ENTRY_TYPE = "compact-tools:question-input";
interface QuestionInputReceipt {
  version: 1;
  source: "interactive" | "rpc";
  text: string;
  pendingIds: number[];
}
interface QuestionResolution {
  actor: "agent";
  reason: string;
  toolCallId: string;
  evidence?: { inputEntryId: string; inputSource: "interactive" | "rpc"; chatEntryId: string; text: string };
}
export const QUESTION_ENTRY_TYPE = "compact-tools:question";
export const QUESTION_STATUS_KEY = "compact-tools:questions";
export const QUESTION_DELIVERY_STATUS_KEY = "compact-tools:question-delivery";

interface QuestionRecord extends QuestionView {
  version: 1;
  source: "tool" | "prose";
  status: "pending" | "answered" | "dismissed";
  toolCallId?: string;
  answer?: QuestionAnswer;
  delivery?: "tool" | "user";
  delivered?: boolean;
  continuation?: string;
  resolution?: QuestionResolution;
}
interface QuestionDetails {
  question?: QuestionRecord;
  status: "pending" | "answered" | "dismissed" | "unavailable" | "error";
  reason?: string;
}
interface ProseQuestion { id: number; question: string }
interface LabeledAnswer { id: number; text: string }

const idIsValid = (id: unknown): id is number => Number.isSafeInteger(id) && Number(id) > 0 && Number(id) < Number.MAX_SAFE_INTEGER;
const safe = (value: unknown) => sanitizeQuestionText(typeof value === "string" ? value : "");
const textContent = (message: { content?: unknown }): string => typeof message.content === "string" ? message.content
  : Array.isArray(message.content) ? message.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";

/** Match only the complete explicit-answer input form; restoration uses the same ID spellings. */
function parseAnswerLabels(text: string): LabeledAnswer[] | undefined {
  const lines = text.trim().split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return;
  const answers: LabeledAnswer[] = [];
  for (const line of lines) {
    const match = /^Q([1-9]\d{0,14}):\s*(\S.*)$/.exec(line);
    if (!match || !idIsValid(Number(match[1]))) return;
    answers.push({ id: Number(match[1]), text: match[2] });
  }
  return answers;
}

/** Intentionally conservative: only standalone labels in assistant text, never thinking or tool output. */
export function parseProseQuestions(text: string): ProseQuestion[] {
  const questions: ProseQuestion[] = [];
  let fence: { character: string; length: number } | undefined;
  let example = false;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (fence.character === marker[0] && marker.length >= fence.length && /^\s*(?:`+|~+)\s*$/.test(line)) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (!line.trim()) { example = false; continue; }
    if (/^\s*(?:#{1,6}\s*)?(?:for example|example|sample|quoted example)\b.*[:：]\s*$/i.test(line)) { example = true; continue; }
    if (example || /^(?:\s{4}|\t|\s*>)/.test(line)) continue;
    const match = /^\s{0,3}(?:\*\*)?Q([1-9]\d{0,14})(?:\*\*)?\s*:(?:\*\*)?\s+(.+?)\s*$/.exec(line);
    if (!match || !idIsValid(Number(match[1]))) continue;
    const question = safe(match[2]).trim();
    if (question) questions.push({ id: Number(match[1]), question });
  }
  return questions;
}

function readRecord(value: unknown): QuestionRecord | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as QuestionRecord;
  if (record.version !== 1 || !idIsValid(record.id) || typeof record.question !== "string"
    || !Array.isArray(record.options) || record.options.length > 12
    || record.options.some(option => !option || typeof option.label !== "string" || (option.description !== undefined && typeof option.description !== "string"))
    || (record.rationale !== undefined && typeof record.rationale !== "string")
    || (record.delivered !== undefined && typeof record.delivered !== "boolean")
    || (record.continuation !== undefined && typeof record.continuation !== "string")
    || !["tool", "prose"].includes(record.source) || !["pending", "answered", "dismissed"].includes(record.status)) return;
  if (record.resolution !== undefined) {
    const resolution = record.resolution;
    if (!resolution || resolution.actor !== "agent" || typeof resolution.reason !== "string" || !resolution.reason.trim()
      || typeof resolution.toolCallId !== "string" || record.status === "pending") return;
    const evidence = resolution.evidence;
    if (record.status === "dismissed" ? evidence !== undefined : (!evidence || typeof evidence.chatEntryId !== "string"
      || typeof evidence.inputEntryId !== "string" || !["interactive", "rpc"].includes(evidence.inputSource)
      || typeof evidence.text !== "string" || !evidence.text.trim() || record.answer?.text !== evidence.text
      || record.delivery !== "user" || record.continuation !== undefined)) return;
  }
  if (record.status === "dismissed" && (record.answer !== undefined || record.delivery !== undefined || record.delivered !== undefined || record.continuation !== undefined)) return;
  if (record.recommended !== undefined && (!Number.isInteger(record.recommended) || record.recommended < 0 || record.recommended >= record.options.length)) return;
  if (record.status === "answered" && (!record.answer || typeof record.answer.text !== "string" || !record.answer.text.trim()
    || !["tool", "user"].includes(record.delivery ?? "")
    || (record.answer.optionIndex !== undefined && (!Number.isInteger(record.answer.optionIndex) || !record.options[record.answer.optionIndex])))) return;
  return structuredClone(record);
}

function questionLines(question: QuestionView): string[] {
  return [
    `Q${question.id}: ${safe(question.question)}`,
    ...question.options.map((option, index) => `  ${index + 1}. ${safe(option.label)}${index === question.recommended ? " (Recommended)" : ""}${option.description ? ` — ${safe(option.description)}` : ""}`),
    ...(question.recommended !== undefined && question.rationale ? [`  Recommendation rationale: ${safe(question.rationale)}`] : []),
  ];
}

class QuestionTranscript extends Text {
  constructor(private readonly currentText: () => string, private readonly paint: (line: string) => string, private readonly buffered = false) { super("", 0, 0); }
  render(width: number): string[] {
    this.setText(this.currentText());
    if (width <= 0) return [];
    // Text may emit a two-column grapheme into a one-column wrap. The self-rendered shell avoids
    // native Box padding overflow and this final clamp preserves the component width contract.
    const lines = super.render(width).map(line => {
      const content = truncateToWidth(line, width, "", true);
      if (!stripTerminalSequences(content).trim()) return "";
      return questionPlain() ? stripTerminalSequences(content) : this.paint(content);
    });
    // Only these intentional transcript buffers receive fill. Internal blank
    // separators and native tool/editor outer spacing remain unpainted.
    if (!this.buffered) return lines;
    const buffer = this.paint(" ".repeat(width));
    return [buffer, ...lines, buffer];
  }
}

function answerMessage(record: QuestionRecord): string {
  // A user-message continuation, not a command/template. Include the exact scope of the question.
  return `Answer to Q${record.id}\nQuestion: ${record.question}\n${record.answer?.optionIndex !== undefined ? `Selected option: ${record.answer.optionIndex + 1}\n` : ""}User answer: ${record.answer!.text}`;
}

const resolutionParameters = Type.Object({
  question_id: Type.Integer({ minimum: 1, description: "One existing pending Q-number; never reassign a resolved ID." }),
  resolution: Type.Union([Type.Literal("answered"), Type.Literal("dismissed")]),
  reason: Type.String({ minLength: 1, maxLength: 2000, description: "Why the reply answers this question, or why the question is obsolete." }),
  user_message: Type.Optional(Type.String({ minLength: 1, description: "Exact full user reply, observed while the question was pending and present in this branch's chat. Omit for dismissal." })),
});

const parameters = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 6000, description: "One question, without an ID. The extension allocates its sequential Q-number." }),
  options: Type.Optional(Type.Array(Type.Object({
    label: Type.String({ minLength: 1, maxLength: 160 }),
    description: Type.Optional(Type.String({ maxLength: 1200 })),
  }), { maxItems: 12, description: "Real choices only. Omit for text-only questions; custom text is always available." })),
  recommended_option: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: "1-based index of the recommended option. Never a default answer or automatic approval." })),
  rationale: Type.Optional(Type.String({ maxLength: 2000, description: "Why that option is recommended; requires recommended_option." })),
  question_id: Type.Optional(Type.Integer({ minimum: 1, description: "Reuse an existing pending ID only for the same question. Never reuse an answered or dismissed ID." })),
});

/** Explicit question input; unlike the compact renderer this intentionally adds model/user interaction. */
export function registerQuestions(pi: ExtensionAPI, enabled: boolean): void {
  if (!enabled) return;
  let records = new Map<number, QuestionRecord>();
  let nextId = 1;
  let generation = 0;
  let currentContext: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let active: { id: number; close: (result: QuestionUIResult) => void } | undefined;
  let retryConfirmation: { id: number } | undefined;
  let listExpanded = true;
  let listOffset = 0;
  // Native tool components cache their layout. Invalidate their public renderer
  // contexts when status changes; never mutate old results or append UI messages.
  const transcriptInvalidators = new Map<string, () => void>();

  const persist = (record: QuestionRecord) => {
    pi.appendEntry(QUESTION_ENTRY_TYPE, structuredClone(record));
    records.set(record.id, record);
  };
  const attention = () => [...records.values()].filter(record => record.status === "pending" || (record.status === "answered" && !record.delivered));
  const refresh = () => {
    const ctx = currentContext;
    if (ctx?.mode !== "tui" || !ctx.hasUI) return;
    for (const invalidate of transcriptInvalidators.values()) invalidate();
    const waiting = attention();
    const pending = waiting.filter(record => record.status === "pending");
    const saved = waiting.filter(record => record.status === "answered");
    // The widget already owns the pending count; never repeat it in the footer/input border.
    ctx.ui.setStatus(QUESTION_STATUS_KEY, undefined);
    // Pi already displays its native steering queue. Busy/queued is not a failed send;
    // expose recovery only once idle, without claiming absence from the queue proves failure.
    const waitingForDelivery = saved.length > 0 && (!ctx.isIdle() || ctx.hasPendingMessages());
    ctx.ui.setStatus(QUESTION_DELIVERY_STATUS_KEY, saved.length && !waitingForDelivery ? `${saved.length} saved answer${saved.length === 1 ? "" : "s"} · delivery unconfirmed · /q Q${saved[0].id} retry` : undefined);
    const stamp = generation;
    ctx.ui.setWidget(QUESTION_STATUS_KEY, pending.length ? (tui, theme) => {
      let lastWidth = 0;
      let lastHeight = 0;
      let targets: (QuestionRecord | undefined)[] = [];
      let maxOffset = 0;
      let wrappedWidth = 0;
      let body: { text: string; record?: QuestionRecord }[] = [];
      return {
        invalidate() {},
        render(width) {
          lastWidth = width;
          targets = [];
          lastHeight = 0;
          if (width <= 0) return [];
          const lines = [
            "", // Keep breathing room above; the native editor owns the gap below.
            questionStyle(theme, truncateToWidth(`${listExpanded ? "▾" : "▸"} Questions · ${pending.length} pending · /q`, width, "", true), "warning", "choice", { bold: true }),
          ];
          if (listExpanded) {
            if (wrappedWidth !== width) {
              wrappedWidth = width;
              body = [];
              const indent = width >= 12 ? "  " : "";
              for (const record of pending) {
                if (body.length) body.push({ text: "" }); // Separation is not a click target.
                for (const line of wrapTextWithAnsi(`Q${record.id}: ${safe(record.question).replace(/\n/g, " ")}`, width - indent.length)) {
                  body.push({ text: indent + line, record });
                }
              }
            }
            // Leave room for ordinary input/footer even in a small terminal. On tiny screens
            // omit decorative padding and the hint before sacrificing the one content row.
            const budget = Math.max(4, Math.min(16, (tui.terminal?.rows ?? 24) - 5));
            const padding = budget >= 7 ? 1 : 0;
            const available = budget - 2 - padding;
            const overflow = body.length > available;
            const hint = overflow && available > 1;
            const capacity = available - (hint ? 1 : 0);
            maxOffset = Math.max(0, body.length - capacity);
            listOffset = Math.max(0, Math.min(listOffset, maxOffset));
            if (padding) lines.push("");
            for (const row of body.slice(listOffset, listOffset + capacity)) {
              targets[lines.length] = row.record;
              lines.push(row.record ? questionStyle(theme, truncateToWidth(row.text, width, "", true), "text", "question") : "");
            }
            if (hint) lines.push(questionStyle(theme, truncateToWidth(`  Rows ${listOffset + 1}–${Math.min(body.length, listOffset + capacity)}/${body.length} · wheel to scroll`, width), "muted"));
          }
          lastHeight = lines.length;
          // Width helpers can add reset sequences even to otherwise plain text.
          return questionPlain() ? lines.map(stripTerminalSequences) : lines;
        },
        handleMouse(event) {
          if (!sameGeneration(stamp) || event.x < 0 || event.x >= lastWidth || event.y < 0 || event.y >= lastHeight) return;
          if (listExpanded && event.type === "wheel" && event.wheelDelta) {
            listOffset = Math.max(0, Math.min(maxOffset, listOffset + Math.sign(event.wheelDelta)));
            tui.requestRender();
            return { handled: true, render: true };
          }
          if (event.type !== "click" || event.button !== "left") return;
          if (event.y === 1) {
            listExpanded = !listExpanded;
            tui.requestRender();
            return { handled: true, render: true };
          }
          const record = targets[event.y];
          if (!record) return;
          // No editor replacement or draft mutation: only an explicit click opens an overlay.
          void answerQuestion(`Q${record.id}`, ctx).catch(() => ctx.ui.notify(`Q${record.id}: unable to open. Use /q.`, "warning"));
          return { handled: true, render: true };
        },
      };
    } : undefined, { placement: "aboveEditor" });
  };
  const clearUI = () => {
    generation++;
    listOffset = 0;
    active?.close({ kind: "defer" });
    active = undefined;
    retryConfirmation = undefined;
    if (currentContext?.mode === "tui" && currentContext.hasUI) {
      currentContext.ui.setStatus(QUESTION_STATUS_KEY, undefined);
      currentContext.ui.setStatus(QUESTION_DELIVERY_STATUS_KEY, undefined);
      currentContext.ui.setWidget(QUESTION_STATUS_KEY, undefined);
    }
    currentContext = undefined;
  };
  const reserve = (id: number) => { nextId = Math.max(nextId, id + 1); };
  const captureProse = (text: string, write: boolean) => {
    for (const question of parseProseQuestions(text)) {
      reserve(question.id);
      // A repeated prose label cannot replace an answered question or silently change its scope.
      if (records.has(question.id)) continue;
      const record: QuestionRecord = { ...question, options: [], version: 1, source: "prose", status: "pending" };
      if (write) { listOffset = 0; persist(record); } else records.set(record.id, record);
    }
  };
  // message_end precedes the host's appendMessage. Confirmation is intentionally memory-only;
  // restoration derives it again from actual durable messages, never a delivered=true snapshot.
  const confirmMessage = (message: any) => {
    const details = message.role === "toolResult" && message.toolName === QUESTION_TOOL_NAME ? message.details as QuestionDetails | undefined : undefined;
    const resultRecord = details?.status === "answered" ? readRecord(details.question) : undefined;
    if (resultRecord?.status === "answered") {
      reserve(resultRecord.id);
      const existing = records.get(resultRecord.id);
      if (existing?.status !== "dismissed" && (!existing || existing.question === resultRecord.question)) {
        // An already-confirmed answer is final. In particular, rescanning an older tool result
        // must neither append another full snapshot nor replace a later confirmed continuation.
        if (existing?.status !== "answered" || !existing.delivered) {
          const confirmed = { ...resultRecord, delivered: true };
          records.set(confirmed.id, confirmed);
        }
      }
    }
    if (message.role !== "user") return;
    const text = textContent(message);
    for (const record of records.values()) {
      if (record.status !== "answered" || record.delivered || record.delivery !== "user" || record.continuation !== text) continue;
      const confirmed = { ...record, delivered: true };
      records.set(record.id, confirmed);
    }
  };
  // The durable native-input receipt is the authoritative observed-text anchor. A later
  // matching user-role chat entry corroborates visibility ONLY: it can be an extension echo.
  // No public causal ID proves raw authorship, original delivery, semantic relevance or intent.
  const evidenceFor = (ctx: ExtensionContext, id: number, text: string, expected?: QuestionResolution["evidence"], beforeEntryId?: string) => {
    const receipts: { id: string; receipt: QuestionInputReceipt }[] = [];
    let scopeSeen = false;
    let pending = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.id === beforeEntryId) break; // Both anchors must precede the resolution snapshot.
      if (entry.type === "custom" && entry.customType === QUESTION_ENTRY_TYPE) {
        const record = readRecord(entry.data);
        if (record?.id === id) { scopeSeen = true; pending = record.status === "pending"; }
      } else if (entry.type === "message" && entry.message.role === "assistant") {
        if (!scopeSeen && parseProseQuestions(textContent(entry.message)).some(question => question.id === id)) { scopeSeen = true; pending = true; }
      } else if (entry.type === "custom" && entry.customType === QUESTION_INPUT_ENTRY_TYPE) {
        const receipt = entry.data as QuestionInputReceipt | undefined;
        if (pending && receipt?.version === 1 && ["interactive", "rpc"].includes(receipt.source)
          && receipt.text === text && Array.isArray(receipt.pendingIds) && receipt.pendingIds.includes(id)
          && (!expected || (entry.id === expected.inputEntryId && receipt.source === expected.inputSource))) receipts.push({ id: entry.id, receipt });
      } else if (entry.type === "message" && entry.message.role === "user" && textContent(entry.message) === text
        && receipts.length && (!expected || entry.id === expected.chatEntryId)) {
        const { id: inputEntryId, receipt } = receipts[0];
        return { inputEntryId, inputSource: receipt.source, chatEntryId: entry.id, text };
      }
    }
  };
  const verifiedEvidence = (ctx: ExtensionContext, record: QuestionRecord, snapshotEntryId: string) => {
    const evidence = record.resolution?.evidence;
    return Boolean(evidence && evidenceFor(ctx, record.id, evidence.text, evidence, snapshotEntryId));
  };
  const restore = (ctx: ExtensionContext) => {
    clearUI();
    currentContext = ctx;
    if (sessionId !== ctx.sessionManager.getSessionId()) transcriptInvalidators.clear();
    sessionId = ctx.sessionManager.getSessionId();
    records = new Map();
    nextId = 1;
    const branch = ctx.sessionManager.getBranch();
    const manualDismissed = new Map<number, QuestionRecord>();
    // Allocation and explicit USER dismissal consult the full session. Agent decisions that
    // a question is obsolete are branch-local: another branch may still need that answer.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === QUESTION_ENTRY_TYPE) {
        const record = readRecord(entry.data);
        if (record) {
          reserve(record.id);
          if (record.status === "dismissed" && !record.resolution) manualDismissed.set(record.id, record);
        }
      } else if (entry.type === "message") {
        if (entry.message.role === "assistant" || entry.message.role === "user") {
          const text = textContent(entry.message);
          for (const question of parseProseQuestions(text)) reserve(question.id);
          if (entry.message.role === "user") for (const answer of parseAnswerLabels(text) ?? []) reserve(answer.id);
        } else if (entry.message.role === "toolResult" && entry.message.toolName === QUESTION_TOOL_NAME) {
          const record = readRecord((entry.message.details as QuestionDetails | undefined)?.question);
          if (record) reserve(record.id);
        }
      }
    }
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === QUESTION_ENTRY_TYPE) {
        const record = readRecord(entry.data);
        // Agent-recorded answers can never enter resend/retry recovery. delivered=true means
        // handled/no-resend here, NOT confirmation that the original input caused a chat turn.
        // Validate the exact receipt/chat IDs and their chronology, never the latest text match.
        if (record?.resolution?.evidence && !verifiedEvidence(ctx, record, entry.id)) continue;
        if (record) records.set(record.id, record.status === "answered" ? { ...record, delivered: Boolean(record.resolution?.evidence) } : record);
      } else if (entry.type === "message") {
        if (entry.message.role === "assistant") captureProse(textContent(entry.message), false);
        confirmMessage(entry.message);
      }
    }
    // A confirmation can precede the final custom snapshot (e.g. input hooks). Reconcile a second
    // time after snapshots so a stale delivery=false snapshot cannot resurrect a delivered answer.
    for (const entry of branch) if (entry.type === "message") confirmMessage(entry.message);
    for (const [id, dismissal] of manualDismissed) {
      const record = records.get(id);
      // A manual user dismissal on another branch suppresses pending UI, not an explicit
      // saved answer already given here. Agent dismissals are restored only from this branch.
      if (record?.status === "pending" && record.question === dismissal.question) records.set(id, dismissal);
    }
    refresh();
  };
  const ensureContext = (ctx: ExtensionContext) => {
    if (!currentContext || sessionId !== ctx.sessionManager.getSessionId()) restore(ctx);
  };
  const sameGeneration = (stamp: number) => stamp === generation && currentContext !== undefined;

  const show = async (record: QuestionRecord, ctx: ExtensionContext, signal?: AbortSignal): Promise<QuestionUIResult> => {
    if (active || signal?.aborted) return { kind: "defer" };
    let doneUI: ((result: QuestionUIResult) => void) | undefined;
    let outcome: QuestionUIResult | undefined;
    let resolveOutcome!: (result: QuestionUIResult) => void;
    const result = new Promise<QuestionUIResult>(resolve => { resolveOutcome = resolve; });
    const close = (value: QuestionUIResult) => {
      if (outcome) return;
      outcome = value;
      doneUI?.(value);
      resolveOutcome(value);
    };
    active = { id: record.id, close };
    const onAbort = () => close({ kind: "defer" });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const dialog = ctx.ui.custom<QuestionUIResult>((tui, theme, keybindings, done) => {
        doneUI = done;
        const component = createQuestionComponent(record, theme, keybindings, close, () => tui.requestRender(), () => tui.terminal.rows);
        if (outcome) done(outcome);
        return component;
      }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", margin: 1 } });
      // Observe both fulfillment/rejection even if lifecycle cancellation wins first.
      Promise.resolve(dialog).then(value => close(value?.kind === "answer" || value?.kind === "dismiss" ? value : { kind: "defer" }), () => close({ kind: "defer" }));
      return await result;
    } catch {
      close({ kind: "defer" });
      return await result;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (active?.close === close) active = undefined;
    }
  };

  const resultFor = (record: QuestionRecord | undefined, status: QuestionDetails["status"], reason?: string) => ({
    content: [{ type: "text" as const, text: status === "answered" && record
      ? `Q${record.id} answered by the user: ${record.answer!.text}${record.answer?.optionIndex !== undefined ? `\nSelected option ${record.answer.optionIndex + 1}.` : ""}`
      : `${record ? `Q${record.id}: ` : ""}${reason ?? "Pending. No answer or approval was given. Click Questions or use /q to answer."}` }],
    details: { status, question: record ? structuredClone(record) : undefined, reason } as QuestionDetails,
    ...(status !== "answered" ? { terminate: true } : {}),
    ...(status === "error" ? { isError: true } : {}),
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => { clearUI(); records.clear(); transcriptInvalidators.clear(); sessionId = undefined; });
  pi.on("message_end", (event, ctx) => {
    ensureContext(ctx);
    if (event.message.role === "assistant") captureProse(textContent(event.message), true);
    confirmMessage(event.message);
    refresh();
  });
  pi.on("input", (event, ctx) => {
    ensureContext(ctx);
    // Observe source/text at OUR position in the input chain, not raw keystrokes. Earlier
    // hooks may already have transformed it; later hooks/preflight/queue removal may change
    // or drop delivery. This receipt proves none of those outcomes and never implies approval.
    const pendingIds = [...records.values()].filter(record => record.status === "pending").map(record => record.id);
    if ((event.source === "interactive" || event.source === "rpc") && pendingIds.length && event.text.trim()) {
      pi.appendEntry(QUESTION_INPUT_ENTRY_TYPE, { version: 1, source: event.source, text: event.text, pendingIds } satisfies QuestionInputReceipt);
    }
    // Never infer approval from unlabelled prose, images, generated extension input, or mixed
    // instructions. Do not consume/transform user input: the complete message still reaches Pi.
    if (event.source === "extension" || event.images?.length || active) return;
    const parsed = parseAnswerLabels(event.text);
    if (!parsed) return;
    for (const { id, text } of parsed) {
      reserve(id); // An explicit answered label must never later be allocated to another question.
      const record = records.get(id);
      if (record?.status !== "pending") continue;
      persist({ ...record, status: "answered", answer: { text }, delivery: "user", delivered: false, continuation: event.text });
    }
    refresh();
  });
  pi.on("agent_settled", (_event, ctx) => {
    ensureContext(ctx);
    // Settlement is notification-only: messages are already durable, so reconciliation need not
    // append more snapshots. Restoration performs the same reconciliation from those messages.
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "message") confirmMessage(entry.message);
    // Missing queue entries do not prove failure (preflight is asynchronous). Every saved answer
    // requires durable confirmation or explicit /q Qn retry; never replay here.
    refresh();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    ensureContext(ctx);
    const pending = attention().filter(record => record.status === "pending");
    const dismissed = [...records.values()].filter(record => record.status === "dismissed");
    if (!pending.length && !dismissed.length) return;
    return { message: {
      customType: "compact-tools:question-reminder", display: false,
      content: [
        ...(pending.length ? [`Unanswered user questions (not approvals):\n${pending.map(record => `Q${record.id}: ${record.question}`).join("\n")}`] : []),
        ...(dismissed.length ? [`Dismissed, still unanswered (NOT answers or approvals):\n${dismissed.map(record => `Q${record.id}: ${record.question} — ${record.resolution ? `agent dismissal: ${record.resolution.reason}` : "dismissed by the user"}`).join("\n")}\nDo not re-ask or reuse dismissed IDs. Dismissal authorizes no action.`] : []),
        "Do not infer answers from silence or unrelated input. Reuse an ID only for its unchanged pending question.",
      ].join("\n\n"),
    } };
  });

  pi.registerTool({
    name: QUESTION_TOOL_NAME,
    label: "Ask user",
    exposure: "model-only",
    renderShell: "self",
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    promptSnippet: "Ask the user one clarification, approval, or decision question with a persistent sequential ID.",
    promptGuidelines: [
      "Use ask_user only for questions you would otherwise ask; do not ask extra questions. Ask one per call, with optional choices and recommendation; custom text is always available.",
      "Call ask_user ALONE in its assistant turn, never alongside other tool calls. Sequential execution is NOT an authorization gate for siblings. Do not execute actions dependent on an answer until a later turn after an explicit user answer.",
      "Only the extension allocates Q-number IDs. Reuse question_id only for the unchanged pending question, never answered or dismissed IDs. Never invent user answers, treat selection/recommendation as approval, or treat dismissal/defer/unavailable/abort as an answer.",
      "Background workers must report their questions to the lead agent for interactive routing; headless calls remain unanswered. If ask_user is unavailable, ask labeled Qn prose; /q can capture it.",
    ],
    description: "Save ONE question for the user without opening an answer dialog. Call ALONE, not with sibling tools: this is not a mechanical authorization fence. Returns an extension-assigned Q-number and an explicitly pending result, never an inferred answer. The user opens Questions or /q and explicitly submits an answer later; submission steers the next safe model turn without aborting tools. Options may be omitted; recommendations are not approval. Workers report questions to their lead.",
    parameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      ensureContext(ctx);
      const question = safe(params.question).trim();
      const options = (params.options ?? []).map(option => ({ label: safe(option.label).trim(), ...(option.description ? { description: safe(option.description) } : {}) }));
      const recommended = params.recommended_option === undefined ? undefined : params.recommended_option - 1;
      if (!question || options.some(option => !option.label) || (recommended !== undefined && (recommended < 0 || recommended >= options.length)) || (params.rationale && recommended === undefined)) {
        return resultFor(undefined, "error", "Provide a nonempty question/options and a valid 1-based recommended_option; rationale requires a recommendation. No answer or approval was given.");
      }
      const previous = params.question_id === undefined ? undefined : records.get(params.question_id);
      if (params.question_id !== undefined && (!previous || previous.status !== "pending" || previous.question !== question
        || (previous.source !== "prose" && JSON.stringify(previous.options) !== JSON.stringify(options)))) {
        return resultFor(previous, "error", `Q${params.question_id} cannot be reassigned: it must be an existing unanswered question with unchanged wording/options. No new ID was allocated and no approval was given.`);
      }
      if (previous && active?.id === previous.id) {
        // Preserve the object/scope the open dialog owns; replacing even an unchanged record
        // would invalidate its Submit/Dismiss identity guard and silently lose the user action.
        return resultFor(previous, "unavailable", `Q${previous.id} is already open. Its pending dialog was preserved; no answer or approval was given.`);
      }
      if (!idIsValid(nextId)) return resultFor(undefined, "error", "Question ID range exhausted. No answer or approval was given.");
      const record: QuestionRecord = { version: 1, id: previous?.id ?? nextId++, source: "tool", status: "pending", question, options, toolCallId,
        ...(recommended !== undefined ? { recommended } : {}), ...(params.rationale ? { rationale: safe(params.rationale) } : {}) };
      persist(record);
      listOffset = 0;
      refresh();
      const lastAssistant = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
      const calls = lastAssistant?.type === "message" && lastAssistant.message.role === "assistant" ? lastAssistant.message.content.filter(block => block.type === "toolCall") : [];
      const mixed = calls.some(call => call.id === toolCallId) && calls.length > 1;
      if (ctx.mode !== "tui" || !ctx.hasUI || signal?.aborted || active || mixed) {
        return resultFor(record, "unavailable", mixed
          ? "Question deferred: ask_user must be called ALONE. It does not block sibling tools. No answer or approval was given; stop dependent actions and reopen /q."
          : "Interactive question UI unavailable or busy. This question remains pending; no answer or approval was given. The lead/user can reopen /q in TUI or send an explicit Qn: answer.");
      }
      // Never open UI from a tool call, even for an unchanged re-ask. The tool cannot hold
      // ordinary input hostage, nor turn an unknown/mixed batch into an authorization gate.
      return resultFor(record, "pending");
    },
    renderCall(_args, theme, context) {
      const record = [...records.values()].find(question => question.toolCallId === context.toolCallId);
      return new QuestionTranscript(() => questionStyle(theme, `Ask user${record ? ` · Q${record.id}` : ""}`, "muted", "choice"),
        line => questionPaint(theme, line, "choice"));
    },
    renderResult(result, _options, theme, context) {
      const details = result.details as QuestionDetails | undefined;
      const snapshot = readRecord(details?.question);
      const renderedSession = sessionId;
      if (context?.invalidate) transcriptInvalidators.set(context.toolCallId, context.invalidate);
      return new QuestionTranscript(() => {
        const live = snapshot && renderedSession === sessionId ? records.get(snapshot.id) : undefined;
        // IDs are session-scoped. Do not lend a different question's status to an
        // error result or a historical card whose scope no longer matches.
        const record = live && live.question === snapshot?.question && JSON.stringify(live.options) === JSON.stringify(snapshot.options) ? live : snapshot;
        const status = details?.status === "error" ? "error" : record?.status ?? details?.status;
        const label = `${record ? `Q${record.id} · ` : ""}${status === "answered"
          ? `Answered${record?.resolution || record?.delivered ? "" : " · saved, delivery unconfirmed"}`
          : status === "dismissed" ? record?.resolution ? "Dismissed by agent" : "Dismissed"
          : status === "error" ? "Not answered (error)" : "Pending · click Questions or /q"}`;
        return [
          questionStyle(theme, label, status === "answered" ? "success" : status === "error" ? "warning" : "muted", "question"),
          ...(record ? [""] : []),
          // The actual question and all choices are always in the ordinary
          // transcript, once, independently of expansion and the optional popup.
          ...(record ? questionLines(record) : []),
          ...(record?.answer ? [`Answer: ${safe(record.answer.text)}`] : []),
          ...(status === "dismissed" && record?.resolution ? [`Reason: ${safe(record.resolution.reason)}`] : []),
          ...(details?.reason && status === "error" ? [safe(details.reason)] : []),
        ].join("\n");
      }, line => questionPaint(theme, line, "question"), true);
    },
  });

  pi.registerTool({
    name: QUESTION_RESOLUTION_TOOL_NAME,
    label: "Resolve question",
    exposure: "model-only",
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    promptSnippet: "Mark an existing question answered from chat, or dismiss it as obsolete.",
    promptGuidelines: [
      "Resolve existing questions only; do not ask extra questions or reuse resolved IDs. Quote the full relevant user reply and consider later cancellations/revocations; never invent answers or infer them from silence/unrelated input.",
      "Validation checks recorded text, not intent or authorization. Resolution never resends input or grants permission; dismissal is not an answer or approval. Existing authorization requirements still apply.",
    ],
    description: "Resolve one pending question. answered requires the exact full user reply, backed by observed input and matching chat on this branch. dismissed requires a reason the question is obsolete. No dialog, resend, or new authorization; identical retries change nothing.",
    parameters: resolutionParameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      ensureContext(ctx);
      const record = records.get(params.question_id);
      const reply = (error: boolean, text: string, question = record) => ({
        content: [{ type: "text" as const, text }],
        details: { status: error ? "error" : question?.status, question_id: question?.id },
        ...(error ? { isError: true } : {}),
      });
      const reason = safe(params.reason).trim();
      if (signal?.aborted) return reply(true, "Resolution cancelled; nothing changed.");
      if (!idIsValid(params.question_id) || !record) return reply(true, `Q${params.question_id}: no question on this branch; nothing changed.`);
      if (!reason || !["answered", "dismissed"].includes(params.resolution)
        || (params.resolution === "dismissed" && params.user_message !== undefined)
        || (params.resolution === "answered" && (typeof params.user_message !== "string" || !params.user_message.trim()))) {
        return reply(true, "Provide a resolution and reason. Include the full user_message for answered; omit it for dismissed. Nothing changed.");
      }
      if (record.status !== "pending") {
        if (record.status === params.resolution && record.resolution?.reason === reason
          && (params.resolution === "dismissed" || record.resolution.evidence?.text === params.user_message)) {
          return reply(false, `Q${record.id}: already ${record.status}; nothing changed.`);
        }
        return reply(true, `Q${record.id}: already resolved; history cannot be changed.`);
      }
      const evidence = params.resolution === "answered" ? evidenceFor(ctx, record.id, params.user_message!) : undefined;
      if (params.resolution === "answered" && !evidence) {
        return reply(true, `Q${record.id}: no matching observed user reply and chat entry. Leave pending; do not invent an answer.`);
      }
      const resolution: QuestionResolution = { actor: "agent", reason, toolCallId, ...(evidence ? { evidence } : {}) };
      // delivered=true is existing handled/no-resend bookkeeping, NOT causal input-delivery
      // confirmation. Evidence stays in the saved record, not the chat display.
      const resolved: QuestionRecord = evidence
        ? { ...record, status: "answered", answer: { text: evidence.text }, delivery: "user", delivered: true, resolution }
        : { ...record, status: "dismissed", resolution };
      // Append before invalidating UI; a failed write leaves the original pending dialog/state.
      persist(resolved);
      if (active?.id === record.id) active.close({ kind: "defer" });
      refresh();
      return reply(false, evidence
        ? `Q${record.id}: marked answered.`
        : `Q${record.id}: dismissed as obsolete.`, resolved);
    },
  });

  const answerQuestion = async (args: string, ctx: ExtensionContext) => {
    ensureContext(ctx);
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      ctx.ui.notify("Questions require TUI. Nothing was answered; resume in interactive mode or send an explicit Qn: answer.", "warning");
      return;
    }
    if (active) { ctx.ui.notify(`Q${active.id} is already open. Escape defers it.`, "info"); return; }
    if (retryConfirmation) { ctx.ui.notify(`Q${retryConfirmation.id}: retry confirmation is already open. Nothing was resent.`, "info"); return; }
    const match = /^(?:Q)?([1-9]\d*)(?:\s+(retry))?$/i.exec(args.trim());
    if (args.trim() && !match) { ctx.ui.notify("Use /q, /q Q<number>, or /q Q<number> retry to explicitly resend a saved answer.", "warning"); return; }
    // The void sendUserMessage API can fail asynchronously before message_end/agent_settled.
    // Recheck durable history here; never silently assume an issued answer was delivered or failed.
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "message") confirmMessage(entry.message);
    const pending = attention();
    const record = match ? records.get(Number(match[1])) : pending.find(record => record.status === "pending") ?? pending[0];
    const retry = Boolean(match?.[2]);
    if (!record || record.status === "dismissed" || (record.status === "answered" && record.delivered)) { refresh(); ctx.ui.notify("No pending question with that ID.", "info"); return; }
    if (retry && record.status !== "answered") { ctx.ui.notify(`Q${record.id} has no saved answer to resend. Use /q Q${record.id} to answer it.`, "warning"); return; }
    if (retry && (!ctx.isIdle() || ctx.hasPendingMessages())) { ctx.ui.notify(`Q${record.id}: cannot retry while Pi is busy or has queued messages. No duplicate answer was sent.`, "warning"); return; }
    if (record.status === "answered" && !retry) {
      refresh();
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(`Q${record.id}: answer submitted; waiting for delivery. Nothing was resent.`, "info");
        return;
      }
      ctx.ui.notify(`Q${record.id}: answer saved, but delivery is unconfirmed. After fixing any failure, /q Q${record.id} retry explicitly resends the saved answer. An unconfirmed send may still arrive; retry can duplicate it.`, "warning");
      return;
    }
    const stamp = generation;
    if (retry) {
      const confirmation = { id: record.id };
      retryConfirmation = confirmation;
      let accepted = false;
      try {
        accepted = await ctx.ui.confirm(`Resend saved answer to Q${record.id}?`,
          "Delivery is unconfirmed. The earlier asynchronous send may still arrive even while Pi appears idle. Resending can duplicate the answer and start another model run. Resend this saved answer anyway?");
      } catch {
        // A closing/unavailable UI never authorizes a resend.
      } finally {
        if (retryConfirmation === confirmation) retryConfirmation = undefined;
      }
      if (!accepted || !sameGeneration(stamp) || ctx.signal?.aborted || ctx.sessionManager.getSessionId() !== sessionId) return;
      // Delivery/session/queue state may change while confirmation owns the screen.
      for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "message") confirmMessage(entry.message);
      if (records.get(record.id) !== record || record.delivered) { refresh(); return; }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        refresh();
        ctx.ui.notify(`Q${record.id}: Pi became busy or has queued messages. Nothing was resent.`, "info");
        return;
      }
    }
    let answered = record;
    if (record.status === "pending") {
      const outcome = await show(record, ctx, ctx.signal);
      if (!sameGeneration(stamp) || ctx.signal?.aborted || records.get(record.id) !== record) return;
      if (outcome.kind === "dismiss") {
        // Explicit removal only: no answer, delivery, continuation, or automatic model turn.
        persist({ ...record, status: "dismissed" });
        refresh();
        return;
      }
      if (outcome.kind !== "answer") return;
      if (!outcome.answer.text.trim() || (outcome.answer.optionIndex !== undefined
        && (!Number.isInteger(outcome.answer.optionIndex) || !record.options[outcome.answer.optionIndex]))) return;
      // Another explicit user answer may have arrived while this dialog was open.
      if (records.get(record.id) !== record) return;
      answered = { ...record, status: "answered", answer: structuredClone(outcome.answer), delivery: "user", delivered: false };
    }
    // An undelivered tool answer is recovered only by this explicit user command, not replayed
    // on startup. Pi's public void sendUserMessage cannot atomically commit with session state.
    answered = { ...answered, delivery: "user", continuation: answerMessage(answered), delivered: false };
    persist(answered);
    refresh();
    try {
      // Steering reaches the next safe model boundary; it does not abort active tools.
      pi.sendUserMessage(answered.continuation!, { deliverAs: "steer", expandPromptTemplates: false });
      refresh(); // A synchronous queue transition is visible without duplicating Pi's indicator.
    } catch (error) {
      ctx.ui.notify(`Q${answered.id}: answer saved, but delivery failed. Use /q Q${answered.id} retry to resend. ${safe(String(error))}`, "error");
    }
  };
  pi.registerCommand("q", {
    description: "Open pending questions: /q [Qn]. /q Qn retry requires duplicate-risk confirmation before resending an unconfirmed saved answer.",
    handler: answerQuestion,
  });
  pi.registerCommand("questions", {
    description: "Compatibility alias for /q [Qn] or /q Qn retry.",
    handler: answerQuestion,
  });
}
