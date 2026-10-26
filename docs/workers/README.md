# Pi Dankhole — plain workers

The worker module migrated from the local plain-worker fork of `@tintinweb/pi-subagents`. Start a worker with a task and optional launch configuration. Its short goal is its visible label; its ID identifies the conversation.

**Removed:** scripted workflows, scheduling, agent profiles, agent mentions, nested delegation, synthetic structured output and grouped joins. See [migration guidance](migration.md) for existing installations. This fork deliberately does not preserve their APIs.

## Running locally

Tested against Pi **1.4.0**; requires Node.js 22.19 or newer. The combined package is configured globally. The worker-only command below is for an isolated Pi configuration without the combined package or old standalone extensions—never load both registrations together.

```sh
pi -e ./src/workers/index.ts
```

Run from the package root. This loads only the worker registrar; `pi -e ./src/index.ts` loads the combined package.

Pi loads the source entrypoint. Editing this checkout does not change a separately installed npm copy or already-running sessions.

## Workers

```js
Agent({
  description: "Audit authentication",
  prompt: "Inspect authentication without changing files. Return concrete findings with supporting evidence.",
  thinking: "high",
  instructions: "Keep the report concise.",
})
```

Top-level launches run in the background by default and return an ID. Completion is delivered to the parent at a safe turn boundary. Use `run_in_background: false` when the next step needs the result immediately. A running foreground call can be handed to the background with `Ctrl+B` or the viewer's `b` action.

Workers inherit parent system rules. `instructions` supplements those rules; it does not replace them. Conversation history is separate and is included only with `inherit_context: true`.

Descriptions need not be unique. There are no types, profile names, aliases, `(twin)` labels or `@agent` commands. Normal Pi file attachments and autocomplete are unchanged.

### `Agent`

| Parameter | Purpose |
|---|---|
| `prompt` | Task or continuation message; required |
| `description` | Short visible goal; required for a new worker, optional for resume |
| `model` | Configured model ID or resolvable model name; omitted inherits the parent |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; Pi clamps unsupported levels |
| `instructions` | Additional system instructions |
| `tools` | Built-in names and `ext:extension[/tool]` selectors; omitted means all built-ins, `[]` means no built-ins |
| `disallowed_tools` | Tool-name denylist |
| `extensions` | `true` to inherit, `false` for none, or a list of extension names/paths |
| `exclude_extensions` | Extension-name denylist; exclusion wins |
| `skills` | `true` to inherit, `false` for none, or named skills to preload |
| `isolated` | Disable extensions and skills; not a filesystem sandbox |
| `inherit_context` | Include the parent conversation; default false |
| `max_turns` | Turn ceiling; `0` means unlimited |
| `run_in_background` | Background or blocking execution |
| `persist_session` | Override child-session persistence |
| `session_dir` | Optional directory for persisted sessions |
| `output_transcript` | Override temporary `.output` transcript writing |
| `memory` | Explicit `{scope: "project" | "local" | "user", key: "namespace"}` |
| `isolation` | `"off"` or `"worktree"`; omitted from the schema when worktrees are disabled |
| `resume` | Existing worker ID to continue |

Resume reuses the worker's configuration and conversation. Only `prompt`, optional `description`, `run_in_background` and `max_turns` may accompany `resume`; other launch overrides are refused. Start a new worker to change its model, tools or instructions. A resumed run gets a fresh turn budget.

### Results and steering

```js
get_subagent_result({ agent_id: id, wait: true })
steer_subagent({ agent_id: id, message: "Also inspect password resets." })
Agent({ resume: id, prompt: "Investigate the first finding further." })
```

`get_subagent_result` accepts `verbose: true` for the conversation log. Consuming a completed result suppresses a duplicate completion notification. Cancelling a wait does not cancel its background worker. Steering received during startup is queued until the session is ready.

Stopped, failed and turn-limited work is distinguished from normal completion; available partial output remains accessible. At a configured turn limit the worker is asked to wrap up, then aborted if it exceeds its grace budget.

## UI

- **Completion cards:** each finished run gets a subtly shaded, padded card headed **Subagent completed — task goal** (or its failed/stopped/turn-limit outcome), with **cost · duration · model · thinking** in one right-aligned group (cost remains optional). Narrow terminals wrap that group below the title, still right-aligned. Up to two wrapped lines from the final reply follow. Model/thinking are shown independently of the widget's `showModel` setting; missing metadata is labeled **not recorded**, including on older saved notifications. Transcript paths and tool-use counts are not displayed. Expand for a longer preview or use the conversation viewer/result tool for the full result. New workers are asked to open their final reply with 1–2 short outcome/verification sentences, including unresolved limitations, then supporting details. Task-specific output formats take precedence. The card still displays a bounded excerpt rather than generating a second summary: no extra model call is made, and notification content and transcript recording are unchanged.
- **Above-editor widget:** live worker goals, activity, model/effort when enabled, turns, token/context usage, optional cost and elapsed time. No tool-use counters. Each worker keeps its live activity line with compact indentation.
- **FleetView:** navigable `main` and worker list below the editor. At an empty prompt use `↓` or `←` to enter, arrows to select, and Enter to inspect.
- **Conversation viewer:** live transcript with scrolling, Markdown controls, steering and stopping. Enter opens the steering composer; `x` twice stops the worker. Escape returns to the parent without stopping it. Detailed metrics remain available here.
- **`/agents`:** worker conversations and settings. No profile creation, type management, scheduler or workflow menus.

Worker usage displays round elapsed time to the nearest whole minute (`0m` below 30 seconds, `1m` at 30 seconds, `2m` at 90 seconds), counting up while running. Estimated costs round to the nearest whole dollar with the `~$` marker (`~$0` for positive costs below $0.50, `~$1` at $0.50). Exact zero/unpriced costs remain hidden. These display rules apply across the widget, FleetView, conversation viewer, completion cards and tool summaries; raw usage, costs and timestamps retain their precision.

Fullscreen viewers retain mouse-wheel scrolling, scrollbar interaction and jump-to-latest controls. Regular-mode viewers retain the centered overlay. Finished workers remain briefly visible; a viewer already open on a finishing worker stays open.

**Section colors** remain opt-in through `sectionColors` or `/agents → Settings`. The goal uses primary text, the model uses the syntax-variable color, and thinking uses the medium-thinking color. Separators, metrics and activity stay dim; status and context warning/error colors are preserved. This does not enable model display by itself.

The viewer defaults to rendering assistant text as Markdown and tool results literally. `m` cycles raw, assistant-only and all-content Markdown; literal mode remains available for diffs and logs.

## Scope and environment

Tool selection and extension loading are independent. A built-in allowlist does not automatically disable extension tools. Any `ext:` selector changes extension tools to an explicit allowlist; exclusions and tool denylists still win. Late-registered extension tools are subject to the same call-time scope checks, including codemode-mediated calls.

A worker inherits the parent's project trust. Changing its working directory does not authorize loading that directory's project configuration. These controls are not an operating-system sandbox: a permitted shell can still run programs or write files.

Only the main agent launches and controls workers. Workers do not receive delegation tools; they report further work or coordination needs to the main agent. Background completions are delivered at safe turn boundaries without waiting for sibling workers or a group timeout.

Extensions can be a substantial part of worker startup: inherited extensions may start their own MCP clients. Select only the extensions a task needs when that matters. This fork makes no measured latency or memory-savings claim.

### Persistence and memory

Persisted child sessions appear beneath their spawning session in Pi's `/resume`. Temporary `.output` transcripts are separate JSON-lines files under the OS temp directory and may disappear after reboot. Neither mechanism is a guarantee that an arbitrary worker ID can be reopened across process restarts.

Memory uses an explicit namespace, not the goal label. Existing memory files are not renamed or deleted. Workers without write capability receive read-only memory instructions; memory access respects tool denylists.

### Worktrees

`isolation: "worktree"` retains the existing temporary-worktree behavior. It cannot see uncommitted changes in the original checkout and is unsuitable for reviewing that working-tree diff.

**Changes in an automatic worktree are committed to a `pi-agent-*` branch on completion, and the temporary worktree is removed.** Set `worktreeIsolation: false` to disable this capability. A requested worktree that cannot be created fails rather than silently falling back; the user setting that disables the feature still prevents worktree creation.

## Settings

Global defaults live in `<agentDir>/subagents.json` (normally `~/.pi/agent/subagents.json`). Project overrides live in `<cwd>/.pi/subagents.json`. The UI writes only project settings. Unknown and removed settings are ignored.

| Setting | Default | Purpose |
|---|---|---|
| `maxConcurrent` | `10` | Background-worker pool |
| `maxConcurrentForeground` | `0` | Independent blocking-spawn pool; `0` is unlimited |
| `defaultMaxTurns` | `0` | Default turn limit; `0` is unlimited |
| `graceTurns` | `5` | Wrap-up allowance after the limit |
| `backgroundByDefault` | `true` | Default for top-level launches |
| `scopeModels` | `false` | Check explicit model choices against Pi's enabled-model list |
| `rememberAgents` | `true` | Persist child sessions |
| `outputTranscript` | `true` | Write temporary transcript files |
| `worktreeIsolation` | `true` | Allow automatic worktrees |
| `toolDescriptionMode` | `"full"` | `full`, `compact`, or `custom` tool instructions |
| `widgetMode` | `"background"` | `all`, `background`, or `off` |
| `fleetView` | `true` | Show the navigable worker list |
| `reportUsage` | `false` | Include worker spend in parent totals |
| `showCost` | `false` | Show estimated cost |
| `showModel` | `false` | Show model and thinking in the widget |
| `sectionColors` | `false` | Theme-color goal/model/thinking fields |
| `viewerMarkdown` | `"assistant"` | `off`, `assistant`, or `all` |

Foreground resume reuses an existing session and is outside the blocking-spawn pool. Handing a foreground worker to the background does not suspend work if the background pool is full.

With `reportUsage`, worker spend reaches the parent through subsequent worker-tool results; the footer can lag background completion. Costs are Pi's estimates, not billing receipts. The parent context percentage is not increased by child usage.

`scopeModels` rejects explicit out-of-scope choices. An inherited parent model may proceed with a warning. Only exact enabled `provider/modelId` entries are currently interpreted by this extension; no configured allowlist means no additional scope check.

Custom tool instructions come from `.pi/agent-tool-description.md`, falling back to `<agentDir>/agent-tool-description.md`. Missing or empty files fall back to the full description. `{{agentDir}}` and `{{isolationGuideline}}` are the retained placeholders; there are no profile-list or scheduling placeholders. Description-mode changes apply on the next Pi session.

## Integrations

[RPC reference](rpc.md) covers the plain-worker spawn contract and reply envelopes. The protocol is **version 3**: profile-based v2 spawn payloads are not supported.

Lifecycle events remain available through `pi.events`:

| Event | Meaning |
|---|---|
| `subagents:created` | Background tool spawn, resume or foreground handoff |
| `subagents:started` | Worker starts running, including queued work |
| `subagents:completed` / `subagents:failed` | Settled result, status and usage |
| `subagents:steered` | Steering accepted |
| `subagents:compacted` | Child session compacted |
| `subagents:usage` | Per-message worker spend |
| `subagents:disposed` | Shutdown complete; no further child usage follows |
| `subagents:ready` | RPC handlers are bound to the active session |
| `subagents:settings_loaded` / `subagents:settings_changed` | Operational settings applied or changed |

Lifecycle events describe workers managed by the main agent; the usage ledger reports each message once. The read-only `Symbol.for("pi-subagents:manager").getRecord(id)` lookup remains available. Quarterdeck uses that lookup and the created/started/completed/failed events for background-work tracking.

## Development

```sh
# Select the worker test files covering your change, not all worker suites.
npm run test:workers -- tests/workers/completion-outbox.test.ts
npm run lint
npm run typecheck
```

See [testing guidance](../testing.md) for file/name filters, affected-consumer coverage, and full-check criteria. `npm run check` is an explicit full-package check, not the default follow-up to focused tests. Tests use synthetic model responses; no provider calls are required. See [AGENTS.md](../../AGENTS.md) for repository rules.

## Architecture

- `src/workers/index.ts`: default worker registrar; tools, lifecycle wiring, UI registration and settings menu.
- `src/workers/invocation-config.ts`, `src/workers/types.ts`: flat launch configuration and worker records.
- `src/workers/agent-manager.ts`, `src/workers/agent-runner.ts`: execution, concurrency, cancellation, resume and cleanup.
- `src/workers/completion-outbox.ts`: safe-boundary completion delivery.
- `src/workers/ui/`: widget, FleetView, conversation viewer and keyboard helpers.
- `src/workers/settings.ts`, `src/workers/usage.ts`: operational settings and accounting.
- `src/workers/cross-extension-rpc.ts`: in-process integration contract.
- `tests/workers/`: retained worker suite, loading the worker registrar rather than the combined entrypoint.
- [Custom tool instructions](../../examples/workers/agent-tool-description.md): retained template.

## License

MIT — original extension by tintinweb; see [license](../../licenses/pi-subagents.txt).
