# Interface: styling and questions

Pi Dankhole interface module with compact tool calls, a Powerline-style status line, and interactive questions. Collapsed **text tool calls** occupy one line, with a full-width colored background and no extra vertical padding. Consecutive calls are grouped into one expandable summary by default:

```text
▸ ✓ bash · npm test · 1.3s
▸ ✓ edit · src/example.ts · 12ms
▸ ✓ write · README.md · 8ms
▸ ✓ codemode · read, bash · 0.4s
▸ ● Agent · Review implementation
▸ ✗ bash · failing-command · 0.2s
▸ ✓ 5 tools · bash ×3, read, edit
```

Backgrounds are consistent by tool type: **read amber, bash purple, edit rust, write graphite, codemode mauve, and Agent rose**. Other tool names receive a stable palette color (colors may repeat). Dark/light palettes follow Pi's active theme. Expanded details keep the same panel color; failures remain marked with a red cross.

A fixed top bar shows the latest user input only while it is off-screen, and the input border shows elapsed time. Existing tool execution, arguments, and results are unchanged. The optional question feature adds `ask_user` and `resolve_question` tools, question guidance, and session records so user decisions remain visible and recoverable. No progress widget is installed.

## Activate and use

Source lives in `src/styling/`, `src/questions/`, `src/session/keep-awake.ts`, and `src/settings/interface.ts` within `~/Desktop/Projects/pi-dankhole/`. The package exposes only `src/index.ts`, which registers workers first, then the interface registrar in `src/styling/index.ts`. Questions retain their independent state/UI/palette module; worker and interface settings remain separate (`subagents.json` and `compact-tools.json`).

The combined package is now configured globally in place of both original registrations; their source directories remain intact. Do not load this package alongside the original compact-tools or pi-subagents extensions: their commands, tools, widgets, adapters, and runtime ownership overlap. Edits apply through **`/reload`** in each existing Pi session or a new session. Wait for active workers to finish before reloading.

- **Click a group summary** to reveal its compact tool rows **above** it. The summary stays at the bottom and uses **▴** while expanded; each tool must be clicked separately to show its details. Clicking the summary again hides the group and resets individually opened details. In fullscreen scrollback, the clicked summary keeps its screen position as the group opens upward. Chat/thinking, other transcript entries, normal-mode tools, and image-bearing results break groups. Failures and pending calls remain indicated in the summary.
- **Click a completed row** to expand or collapse its original tool details, including edit diffs and written file contents. Mouse interaction requires Pi's fullscreen TUI and terminal mouse support.
- **Click the pinned input** at the very top to scroll back to that user message, or run **`/latest-input`**. The bar updates as new input enters the transcript and disappears, including its row, whenever any text from that selected message is visible. Blank padding alone does not count. Visibility uses the viewport without the pin to avoid height-feedback flicker; unsupported layouts retain the pin rather than guessing. If compaction removed that message from the displayed transcript, the bar keeps its text from session history and explains that it can no longer jump there.
- **Elapsed time** appears as `12m` or `1h 12m` in the input's top-border status area, without seconds or a prefix. It measures wall time since the session was created, including idle time and time between resumes; it is not active-generation time. Existing token/cost/model stats remain intact.
- **Powerline input and status line** puts the model, distinctly colored thinking level, and folder breadcrumb on the left of the input's top border, with status metrics right-aligned in the same border. There is no separate footer row while this editor is active. One column of input padding keeps typed text off the left edge. One blank row above and below the input gives the frame breathing room, including when native completions are visible; mouse coordinates and the cursor remain aligned. Context, input tokens, output tokens, cost, and elapsed time use distinct colors, alongside Git and other extension statuses where space permits. High context usage retains warning/error colors. MCP labels, cache counters, and the redundant subagent running-count status are hidden; subscription-backed cost estimates use `~$` rather than `(sub)`. Narrow terminals prioritize and truncate content instead of overlapping the breadcrumb. Set `PI_NERD_FONTS=0` to disable font-specific icons; `TERM=dumb` or `NO_COLOR` enables plain output.
- **Context and cost** show used tokens/model limit, plus a countdown only when close to auto-compaction—for example `203k/272k · 19% to compact`. By default the countdown is hidden until **80% of the compaction budget is used (20% or less remains)**; set **Compaction countdown cutoff** in `/dankhole` to change that. Remaining percentage uses Pi's effective threshold (`context window − reserveTokens`), including model overrides; it updates on the next render when effective settings change and reaches `0%` at the threshold. External settings-file edits take effect through Pi's `/reload`. Disabled compaction shows `auto off`; unknown usage/thresholds are not guessed. Costs round to the nearest whole dollar, such as `$98` or `~$98`, without rounding the underlying accounting.
- **Ctrl+O** toggles tool details globally (or your configured `app.tools.expand` shortcut). A group you manually opened stays visible as a compact list when global details are collapsed.
- **`/dankhole`** opens extension settings while the agent is idle, with **Keep awake** first. **Per-tool options** opens a searchable submenu for individual overrides. Enter/Space cycles values; Escape in the submenu returns to the main settings without saving. Escape from the main settings saves and closes; changed settings trigger a reload in that session.
- Other already-running sessions pick up saved settings on their next `/reload`.

## Settings

Settings are global, in `~/.pi/agent/compact-tools.json` (or the configured Pi agent directory). Defaults apply without creating that file:

```json
{
  "defaultMode": "compact",
  "errorPreview": false,
  "groupConsecutive": true,
  "pinLatestPrompt": true,
  "showChatTimer": true,
  "powerlineStatus": true,
  "compactionNoticePercent": 20,
  "questionUI": true,
  "textBlockPanels": true,
  "assistantPanels": true,
  "collapseThinking": true,
  "keepAwake": false,
  "backgrounds": "tool",
  "tools": {}
}
```

- `defaultMode`: `compact` for single-line rows, or `normal` for Pi's original tool rendering.
- `errorPreview`: show one additional truncated error line for individual collapsed rows. Failure status always remains visible even when this is `false`.
- `groupConsecutive`: combine two or more adjacent compact calls into one summary (default `true`). Disable with **Group consecutive tool calls** in `/dankhole`.
- `pinLatestPrompt`: show a fixed, clickable latest-input bar in fullscreen mode only when that message is off-screen (default `true`).
- `showChatTimer`: show elapsed session wall time in whole minutes in the input-border status area (default `true`).
- `powerlineStatus`: use the Powerline-style input breadcrumb and right-aligned top-border metrics (default `true`).
- `compactionNoticePercent`: show the remaining-percentage countdown only at or below this cutoff (integer `0`–`100`, default `20`). `0` shows only when the compaction budget is exhausted; `100` always shows it when usage and the threshold are known. The settings menu offers presets; JSON accepts any integer in range. This changes the display, not Pi's compaction trigger.
- `questionUI`: enable interactive questions and the pending-question reminder (default `true`).
- `textBlockPanels`: enable **Code block panels** for top-level assistant fenced blocks and the existing explicit plain-text user blocks (default `true`). The JSON key and default are unchanged.
- `assistantPanels`: enable **Conversation panels**: green user messages and blue assistant prose, with filled blank rows above and below assistant replies (default `true`). The existing JSON key is retained for compatibility.
- `collapseThinking`: collapse finished thinking to a clickable single line while leaving streaming thinking visible (default `true`).
- `keepAwake`: prevent idle system sleep while working on macOS, allowing display sleep (default **`false`**). Also configurable under **Keep awake while working (macOS)** in `/dankhole`; changes apply after reload.
- `backgrounds`: `tool` for per-tool colors (default), `status` for warm/neutral pending/success/error colors, or `none` for no panel background. Also configurable under **Background colors** in `/dankhole`.
- `tools`: exact tool-name overrides. The settings UI's `default` value removes an override.

For example, compact only edits and writes:

```json
{
  "defaultMode": "normal",
  "errorPreview": false,
  "tools": {
    "edit": "compact",
    "write": "compact"
  }
}
```

By default, the renderer applies to **all tool names**, including built-ins, `codemode`, subagent calls, and late-registered MCP tools. Codemode's short list is inferred from literal `tools.name(...)` calls in its script; it is a hint, not an execution trace.

Malformed settings produce a warning and leave native tool rendering in place. Concurrent settings changes are rejected rather than overwritten. Settings saves use a short-lived `compact-tools.json.lock`; if Pi crashes during a save and leaves that file, verify no save is running before removing it.

## Optional macOS keep-awake

Toggle **Keep awake while working (macOS)** in `/dankhole`; Escape saves and reloads while idle. Alternatively, set `"keepAwake": true` in `~/.pi/agent/compact-tools.json` (or the configured Pi agent directory), then `/reload`. This is **off by default**, does nothing on other platforms, and also works without the TUI. Invalid configuration never enables it. When enabled on macOS, the owned input border starts with `─ ☕─` (`- [awake] -` in plain mode), using the text-style cup's blank second column for tight, balanced spacing; the icon indicates the configured mode, not a continuously held sleep assertion. It yields to native indicators on very narrow terminals.

While the main agent works, this holds `/usr/bin/caffeinate -i -w <Pi PID>`. It prevents **idle system sleep only**, not display sleep, lid-close sleep, or explicit sleep. It remains active across low-level agent ends, retries, queued follow-ups, and settlement continuations, releasing at `agent_settled`, including cancellation once processing stops. Polling the public idle state also covers startup failures before settlement. Reload, session replacement, and shutdown release the owned helper and remove listeners/timers; parent-PID monitoring releases the assertion even if Pi is forcibly killed. Helper launch/failure disables keep-awake until reload with a warning rather than retrying continuously.

For the bundled workers module (preserving the local `pi-subagents` protocol), public `subagents:started`, `subagents:completed`, and `subagents:failed` events retain a hold while observed workers run or finish cancelling—even after the parent becomes idle. A `created` event discovers an ID; the documented read-only `Symbol.for("pi-subagents:manager")` registry's `getRecord(id)` distinguishes queued from running work. A 500 ms poll checks those known records and the current agent's idle state. **Queued-only jobs do not acquire or retain a hold.** The queue-inclusive global `hasRunning()` is deliberately unused, so idle child sessions also cannot inherit unrelated root activity. Pending questions, an idle question dialog, and an idle TUI do not keep the machine awake. No fork/runtime modification or global patch is used.

**Integration boundaries:** other worker protocols are not tracked. The registry cannot enumerate workers already active when this extension starts. Unknown RPC workers are discovered at `started`, not during preceding worktree setup; this is a phase gap, not a guaranteed 500 ms delay. Known workers can be detected during setup by polling, but cancellation retention through cleanup requires observing `started`. The bundled workers module aborts workers on reload/session shutdown; this extension releases rather than transferring its old runtime's assertion. A vetoed session switch does not release it. An active tool awaiting a blocking third-party UI prompt still counts as an active run: public prompt events cannot identify which parallel operation is waiting, so blanket suppression would risk sleeping during unrelated work. Nonblocking `ask_user` questions do not have this limitation after settlement. Unit tests use fake processes/events. The original project also reports a separate native assertion acquisition/release smoke check; this migration has not repeated it or tested actual machine sleep.

## Questions

With **Interactive questions** enabled, the agent gets an `ask_user` tool for questions it would otherwise ask—not a requirement to ask extra questions. The extension assigns persistent `Q1`, `Q2`, … IDs. The agent supplies the question, real options, and an optional recommendation plus rationale. Recommendations never select or submit an answer automatically.

- New questions **never open the answer UI automatically**. **Click a pending question in chat** to open its answer window. Question cards use a distinct amber/yellow background rather than generic gray, with vivid lemon-yellow text in dark mode and dark text in light mode; popup controls retain their separate neutral palette. Uniquely tracked, standalone pending prose questions (including wrapped rows) use the same question colors in fullscreen chat; answered or dismissed prose returns to ordinary assistant styling without rewriting saved messages.
- The **Questions list** above the input is an automatic off-screen reminder, not a collapsible section. It disappears completely, including its spacing, while every pending question has some actual question text visible in the transcript. Tool/status headers and blank padding do not count. If any pending question is off-screen, the list shows **all pending questions**. Scrolling and resizing update visibility; measurement excludes the reminder's own height to avoid flicker. Unsupported layouts and regular terminal mode retain the expanded list rather than guessing. Questions word-wrap in a bounded scrollable area, with a darker amber blank line between questions; clicking any wrapped question row opens its answer window. The reminder has no heading or pending count—clickable question rows between one normal-yellow blank row above and one below, with darker amber reserved for the inter-question separators and keeping the reminder one line farther from the input. Saved-answer delivery/recovery notices remain separate.
- Clickable list rows and answer controls have colored backgrounds. Answers open in an opaque, framed overlay with a prominent question and distinct choices; your ordinary input and draft remain underneath. **Up/Down** moves through choices and the custom-answer field. **Enter submits the highlighted choice immediately**, or the typed text when custom input is focused. Navigation alone never sends. Moving to custom input clears any previously selected option while preserving your draft; its entire row, including the **Custom answer** label, is clickable. A single mouse click or Space selects a choice for the **Submit** button; two clicks on the same choice within **300 ms** submit it immediately, allowing slight pointer drift (up to two columns and one row). Option presses do not start fullscreen text selection. Slower or distant clicks only select. Keyboard input, scrolling, focus loss, or resizing resets the double-click gesture. Neither mouse interaction nor Space is required for keyboard submission. A single compact footer hint replaces the redundant Ready summary. Roomy overlays have two columns of inner horizontal padding and blank rows around the question, custom field, and controls—including below the action buttons. Decoration yields to content and controls on small terminals.
- **Escape**, Ctrl+C, or **Close** closes the overlay without answering. The question remains pending. **Dismiss** explicitly removes a question from the pending list and persists that state without recording an answer or approval.
- Clicking is the primary interaction; command hints are omitted from everyday question labels. **`/q`** remains a keyboard fallback that opens the oldest pending question; **`/q Q7`** opens a particular ID. **`/questions`** remains a compatibility alias. Question tool rows remain outside grouped/compact overrides. The **Ask user** tool label has a full-width amber buffer row above it; the question ID appears only in the question body on pending cards. The question and all choices appear once directly in an amber transcript panel with one background-filled blank row above and below the question body. An additional light-amber blank row sits directly below the question text, before the darker separator and answer choices. Pending cards omit the redundant **Qn · Pending · click to answer** status row; the question itself remains clickable. Darker amber blank rows also separate the question, each answer choice, recommendation rationale, and recorded answer so long cards remain scannable without gray stripes. A dark-amber row below the final choice balances the option list. Limited 256-color palettes may render the two amber shades identically; plain mode keeps uncolored blank rows. Resolved cards retain live **Answered** or **Dismissed** status; error cards remain explicit. Answers show a simple **Answered** status and **Answer** line. Actual sends still show delivery uncertainty when needed; resolution audit details stay out of the chat.
- An explicit **`Q7: my answer`** message can answer a tracked question. This only auto-tracks messages consisting entirely of labeled answers, without images; the original input is still passed through unchanged. Unlabeled or mixed replies still reach the agent normally; the agent can reconcile them with `resolve_question` as described below.
- **`resolve_question`** lets the agent close one pending question: `dismissed` requires a reason why it is obsolete; `answered` requires a reason and the exact full observed input text in `user_message`. Answer evidence needs a stored interactive/RPC input receipt captured while that question was pending, plus matching user-role text later on the current branch. Generated text alone is insufficient. Older/unobserved inputs cannot be used; the agent must not invent evidence or ask redundant questions to obtain it.
- Agent resolutions update the pending list and live transcript without opening a dialog, resending input, or triggering a turn. Chat keeps the question, status, and answer (or an agent dismissal reason). Input/chat references and answer-resolution rationale stay in saved state, not the transcript; tool confirmations are one line rather than a duplicated audit record. Identical retries change nothing; resolved history cannot be overwritten. Agent dismissals are branch-local; manual user dismissals remain honored across branches. **Agent dismissal is not user dismissal or approval.**
- Input receipts record what this extension observed, potentially after earlier input transformations—not raw keystrokes. They can survive failed preflight or withdrawn queued input; matching chat text may be an extension echo. The tool does **not** prove that chat entry's origin, original input delivery, semantic relevance, or current intent. The agent must consider later cancellations/revocations and only record a genuine applicable answer. Existing authorization requirements remain unchanged.
- Question state follows the current session branch. Number allocation also considers already-issued IDs on abandoned branches, so navigating backward does not reuse a label.
- Standalone labeled questions in assistant prose are captured conservatively as a fallback, excluding fenced code, quotes, and recognized examples. This cannot reliably interpret every historical question/answer. Such fallback questions have a custom-text answer, not invented options or recommendations.
- Saved answers reconcile against actual user messages and tool results. If a send was issued but delivery is unconfirmed, normal `/q` does not resend it. After resolving the failure, **`/q Q7 retry`** explicitly resends that saved answer, only while Pi is idle with no queued messages and after a fresh duplicate-risk confirmation. An unconfirmed send could still arrive, so retry can duplicate it. Startup never silently replays approvals; Pi's public APIs do not provide a crash-atomic exactly-once delivery transaction.
- Answer overlays use 90% of the terminal width and size their content area to the available height; long content scrolls on smaller screens. Custom text input is single-line.
- Opaque popup surfaces use near-white text on charcoal in dark mode and dark text on pale gray in light mode. Cyan/blue focus cues and readable secondary text replace purple-on-blue/gray-on-purple combinations. Actual rendered text pairs are tested at **4.5:1** minimum contrast, and meaningful border/state cues at **3:1**, in truecolor and 256-color modes; focus/selection also have text markers. `NO_COLOR` and `TERM=dumb` retain uncolored navigation markers. The palette follows [Primer's semantic color guidance](https://primer.style/product/getting-started/foundations/color-usage/) and [W3C text-contrast thresholds](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
- Submitting removes the question from the pending list immediately and sends the answer as **steering**, for the next safe agent turn rather than waiting for the entire run to finish. Pi may briefly show it in its native steering queue while tools run. A queued answer is not a failed delivery; no duplicate retry is automatic.
- Background/non-interactive agents cannot open terminal dialogs; they receive an explicitly unanswered result and should route their question to the lead agent.

Dark-mode question cards and reminders pair lemon text (`#ffff80`) with deep amber (`#594515`), measuring about **8.69:1** contrast in truecolor, versus **8.08:1** for the earlier cream text. This custom pair follows [Radix's separation of text and background shades](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale) and is measured using [W3C's luminance-contrast formula](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html); it is not a Radix palette guarantee. Terminal 256-color quantization can change the pair; tests keep its text contrast above 4.5:1. Light-mode text and popup controls are unchanged.

This is a **user-input UI, not an authorization gate**. The agent is instructed to call `ask_user` alone and wait for a submitted answer before dependent actions. A mixed tool batch cannot be mechanically stopped by this dialog; such a question is deferred without approval. Existing safety/approval requirements still apply.

## Conversation panels

**Conversation panels** distinguishes green user messages from blue assistant prose. Assistant replies have one background-filled blank row above and below their text, plus one neutral terminal-background separator above the blue panel. User messages retain their native padding. Thinking and tool calls stay separate. Existing code-block/panel backgrounds and syntax/diff colors are retained. This is display-only: saved messages and model context are not rewritten.

Color choices follow [Catppuccin's surface/text hierarchy](https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md), [Primer's guidance for foregrounds on muted surfaces](https://primer.style/product/getting-started/foundations/color-usage/), and [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Tests check emitted truecolor and 256-color pairs, not just source hex values. Retained code/diff/syntax colors can still have lower contrast, particularly in 256-color mode; they are audited but not recolored. Custom-theme foregrounds and inherited terminal backgrounds also fall outside these reference checks. This is not a whole-terminal accessibility-conformance claim.

## Finished thinking

**Collapse finished thinking** uses Pi's native clickable `Thinking...` row for completed thinking runs. Active thinking remains expanded unless a native user preference hides it. A following content block or native message completion closes a run; adjacent thinking blocks share one native run. Clicking expands the original reasoning and keeps that explicit choice across subsequent renders. Global thinking-visibility controls remain authoritative. This changes display defaults only, not saved reasoning or model context.

## Code block panels

Visual inspiration: [pi-pretty-codeblocks](https://github.com/vvv850/pi-pretty-codeblocks) and [pi-code-render](https://pi.dev/packages/pi-code-render?name=pi-code-render). This implementation builds on our existing public transformer integration rather than adopting their internal renderer patches or interactive controls.

With **Code block panels** enabled, top-level, unindented assistant fenced blocks render as shaded monospaced panels without visible fence markers. Pi supplies syntax highlighting for supported languages; unknown languages and unlabeled blocks retain literal text without guessed highlighting. The first word of the info string selects the language. Named blocks have a small language label, except `text`, `plaintext`, and `txt` (case-insensitive), which preserve the existing header-free appearance.

Backtick and tilde fences, longer delimiters, CRLF input, and streaming content after a complete opening info line are supported. Partial closing fences, including allowed indentation/trailing whitespace, are hidden while streaming; genuine short fence-glyph lines return when the message is final. Within the text supplied to the transformer, indentation, repeated spaces, tree/Unicode glyphs, blank lines, and literal Markdown/math punctuation are preserved. Tabs use Pi's three-space display convention. Panels follow the current theme while preserving syntax foreground colors over a solid background, with conversation panels either enabled or disabled.

**Host limitations:** Pi trims assistant text before calling Markdown transformers, so trailing whitespace/newlines at the end of an assistant text block may already be absent from the display input; saved content is untouched. Panels wrap to the available width without adding overflow beyond native constraints. At tiny widths, native output padding/minimum content widths and two-column graphemes may still exceed the terminal width. This extension does not patch those host behaviors.

Scope is deliberately conservative, not a full nested-Markdown parser: indented, list, and quote blocks, raw HTML, Mermaid, and thinking keep native rendering. User messages receive **only the existing explicit plain-text panels**, not new code-language or unlabeled panels; user info strings with additional words (such as `text title=example`) remain native. This is display-only through Pi's supported `registerMarkdownTransformer`: saved messages, prompts/model context, and tool output are unchanged. There are no extra controls, global renderer patches, or dependencies. Disabling the setting, non-TUI modes, and session shutdown leave native rendering in place.

## Status-line provenance

The footer adapts the layout and small helpers from [jwu/pi-powerline](https://github.com/jwu/pi-powerline), pinned to commit `51fc7d3d3893d380267e66b4d48e8b682c14ab83`. Attribution, MIT license, and adaptation details are in [`vendor/powerline/README.md`](../vendor/powerline/README.md). It uses Pi's public footer/editor APIs, not the upstream package entry point, and preserves native editor interactions through `CustomEditor`. It does not replace the application header or write a second settings file. Other editor/footer extensions may compete for the same UI slots. If this editor is unavailable or another extension replaces it, the status component falls back to one footer row instead of losing the metrics.

Usage includes Pi's persisted assistant, tool-result (including reported subagent usage), standalone, and compaction/branch-summary usage. Unknown post-compaction context stays unknown rather than reusing stale token counts. Published extension statuses share the input's top border, except intentionally suppressed MCP labels and the `subagents` running count; content is prioritized and truncated when the terminal is too narrow to display everything. Cache reads/writes still participate in underlying usage accounting despite being hidden from the compact row.

## Boundaries

- Pi retains one blank separator line between individual tool entries and group summaries.
- Inline image attachments are rendered separately by Pi and are not hidden by this extension.
- Ordinary chat, user `!` shell commands, and the persistent subagent status widget are not collapsed by tool grouping. Finished thinking has its own optional collapse behavior.
- Expanded details delegate to the original tool renderer; tools without one show their arguments and text results. Existing native truncation/full-output-file behavior remains in effect.
- This is a TUI renderer, not a generic RPC/web-client renderer. A client drawing its own transcript would need equivalent client-side support. Grouping and pinning do not alter HTML exports.
- Grouping, pinning, question visibility, conversation panels, and finished-thinking collapse use isolated adapters for Pi 1.4's internal transcript/layout structure, because Pi has no public transcript-layout/assistant-style extension API. Unsupported layouts retain the native UI. The timer uses Pi's public status API.
- The pinned bar and click-to-jump require fullscreen mode. Regular mode retains compact grouping and keyboard expansion but cannot pin terminal-owned scrollback.
- Groups follow Pi's displayed transcript order. Pi already places each assistant message's text/thinking before its separately rendered tool calls.

To restore the native view, set the default view to `normal`, remove per-tool overrides, and turn off pinning, elapsed time, the Powerline status line, interactive questions, code block panels, conversation panels, and finished-thinking collapse. Package activation and removal are shared with the bundled workers; see the root README before changing registration. Do not alter installed extension configuration as part of this migration. Disabling interface presentation through settings does not disable workers. Keep-awake is a separate opt-in runtime setting and should also be turned off if restoring entirely native behavior.

## Validation

Tests use the installed Pi extension loader and actual `ToolExecutionComponent`, without executing agent tools or making model/network calls:

```sh
# From the checkout root; select files for the behavior you changed.
node --test tests/interface/questions-ui.test.mjs
# Narrow an iteration further (put Node options before file paths):
node --test --test-name-pattern='contrast' tests/interface/questions-ui.test.mjs
```

See [testing guidance](testing.md) for the selection map and affected-consumer coverage. `npm run test:interface` runs **every** interface suite; it is not the default for a local UI change. Do not follow focused tests with `npm run check` automatically.

The test runner finds a standard npm Pi installation via `pi` on PATH. For another installation layout, set `PI_PACKAGE_DIR` to the **Pi coding-agent package root**, not the Pi Dankhole root (for example, the installed development host at `node_modules/@earendil-works/pi-coding-agent`). Tests exercise `src/styling/index.ts` independently of the aggregate package registration and depend on Pi 1.4's actual loader/component layout. Tests cover click/keyboard-driven expansion, edit/write details, per-tool and conversation backgrounds in dark/light truecolor and 256-color themes, optional status/no-background modes, streaming/timer cleanup, Unicode/narrow terminals, custom renderer fallback/state, settings UI/persistence/conflicts, invalid configuration, consecutive grouping/boundaries/rebuilds, off-screen pinned-input visibility, selected-entry provenance and jump offsets, session-age timing across resume/reload, native-compatible footer accounting/status retention, live compaction countdown cutoffs and rounded cost display, interactive question persistence/delivery/abort/selection and agent resolution evidence/branch isolation, optional keep-awake lifecycle/cleanup/platform/subagent tracking with fake processes and events, finished-thinking streaming/manual-toggle behavior, input padding and native mouse/autocomplete alignment, and literal/plain-text and syntax-highlighted code block panels (including scope exclusions, info strings, streaming fences, ANSI resets, live themes, narrow widths, and unchanged message content).
