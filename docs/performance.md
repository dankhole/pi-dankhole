# Extension performance work

The later [idle-redraw follow-up](idle-redraw-performance.md) covers completion-card caching,
pinned-prompt measurement and completion/lifecycle diagnostics for the reported `nodeHost` incident.
The subsequent [Pi follow-up plan](pi-follow-up-plan.md) and [matched measurements](pi-live-measurement.md)
cover shared visibility frames, completion recovery, live card settings and opt-in child MCP startup.
The sections below retain historical behavior and results, not claims about the final follow-up.

## Scope and baseline

This work targets `pi-dankhole` only. Quarterdeck, original source projects, installed extension registration and running sessions are unchanged. Synthetic CPU measurements identify avoidable extension work; they do not establish the cause of the reported interactive incident or promise that all host/terminal latency is removed.

Read-only audits covered styling, questions, workers, input/status controls and keep-awake. Concrete findings:

- Assistant panels repaint unchanged native Markdown lines; 500 synthetic messages cost about 52 ms per render versus 0.64 ms natively.
- Plain-text panel transformation repeatedly measures ASCII graphemes; 100 KB took roughly 99–146 ms.
- Pending-question visibility and pinning repeatedly render the same history. A 300-card synthetic fullscreen fixture took about 283 ms/frame with the reminder, versus 41 ms without it.
- Question restoration repeatedly rebuilds evidence from the whole branch; 400 resolved questions required 401 branch reads.
- Worker viewers rebuild historical layout during rendering and scroll input; 2,000-message synthetic fixtures took roughly 57 ms raw / 107 ms Markdown.
- Worker context labels call aggregate session statistics, including for invisible overflow rows; settled-only widgets continue requesting animation frames.
- Scope predicates resolve unrelated extension manifests for builtin calls, foreground progress emits for each delta, and transcript flushes append once per message.

Measurements are local synthetic workloads with different fixtures, not directly comparable production percentiles. Input padding already avoids redundant requests; the chat timer publishes only changed minutes. Keep-awake polling is necessary to its existing lifecycle contract and is not a demonstrated hotspot.

## Implementation design

### Stable transcript rendering

Use bounded component-local caches for painted assistant/user/question rows. Preserve native rendering and invalidate for content, width, explicit invalidation, theme/color mode and plain output. Do not mutate native cached arrays or introduce global prototype patches. Preserve escape sequences, code backgrounds, image payloads, mouse geometry and teardown ownership.

Use a printable-ASCII fast path for plain-text fence wrapping, retaining the grapheme-aware path for other input. Preserve every character and existing fence/HTML/streaming semantics. Cache thinking run analysis once per native update, including same-object mutations, while keeping native explicit toggles authoritative.

Cache compact tool summaries by their relevant primitive inputs, not mutable argument-object identity. Continue invoking downstream tool renderers on every update.

### Projection-aware viewport measurements

One owner coordinates `grouping.ts`, `pinned-prompt.ts` and `question-viewport.ts`. Introduce a fresh projection-aware measurement snapshot: rendered height, displayed-child offsets and child rows. Hidden grouped children have no fabricated offsets. Support grouping-disabled and unsupported-layout paths conservatively.

Reuse measurements within a calculation; do not persist rendered history across frames using only width, session leaf, child-array identity or child count. Those signals miss streaming, expansion and same-length replacements. Preserve canonical viewport calculations without the pin/reminder, follow-end behavior, live dock sizes and prompt entry provenance. Pin painting needs text only, not repeated native identity resolution.

Retain grouping objects and avoid redundant projection/UI allocation where membership and live state permit; do not sacrifice late-image, boundary or manual/global expansion correctness.

### Questions and evidence

Keep one owner for `questions.ts`. Cache card rendering and scope comparisons, index tool-call lookup, invalidate changed cards only and reuse unchanged reminder widgets. Retire stale callbacks during branch reconstruction without taking ownership of foreign handlers.

Read a branch snapshot once for restoration and index evidence/delivery matches. Preserve exact observed-input text, receipt/chat IDs, source restrictions, pending-at-observation state, chronology, current-branch membership, session-wide ID allocation and manual-dismissal rules. Malformed evidence must fail closed. Receipt persistence and answer delivery remain immediate and unchanged; this UI is not an authorization gate.

### Worker presentation

Cache stable per-message blocks and viewer layout; scrolling reuses history layout. Invalidate on streaming, append/replacement, compaction, mode, width and theme, including native Markdown caches. Keep dynamic activity separate and retain all transcript content.

Use public context-usage APIs rather than aggregate statistics. Cache by actual session/history/model state, preserve unknown post-compaction usage and select visible rows before formatting. Avoid whole-response splitting for first-line previews. Stop animation when no active row needs it and prune evicted age metadata during normal updates. Reuse roster snapshots within Fleet operations.

### Worker runtime

Authorize requested names directly: delegation/deny rules first, then explicit builtin permissions, then fresh owning-extension maps and aliases. Keep full-set narrowing at its existing boundary. Do not cache authorization decisions or bypass either gate; late registrations and replacements remain observable.

Coalesce only presentation updates to the existing animation cadence; update state, usage, steering, lifecycle and turn limits immediately. Flush terminal/important transitions and cancel pending presentation on handoff, abort and cleanup.

Batch synchronous JSONL appends into bounded chunks. Preserve record bytes/order, resume boundaries, pre-compaction flush/re-anchor and final synchronous visibility. No asynchronous persistence redesign. Output remains best-effort: a failed append can lose a chunk of up to 256 KiB rather than one record (a single oversized record is written alone). Partial writes are not retried because doing so could duplicate records; later chunks still proceed. Clear child-shutdown race timers after either outcome.

### Status and validation

Cache the unthemed virtual-router destination by manager/session/leaf, including absent destinations; retain live settings, theme and extension statuses.

Acceptance uses deterministic operation counts rather than timing thresholds: unchanged history avoids repeated decoration/wrapping; visibility avoids duplicate measurement passes; scroll-only viewer work reuses layout; builtin scope checks do not read unrelated manifests; invisible worker rows do not calculate context; settled widgets do not animate; restoration avoids one branch copy per answer; batched output preserves records.

Exercise streaming, resize, Unicode/ANSI, light/dark/256-color/plain themes, same-object mutation, compaction/branch replacement, grouping/thinking toggles, unsupported layouts, cancellation/resume, disposal and competing UI ownership. Use synthetic sessions only, no live providers.

Run focused tests per owner, independent parallel rendering and worker/safety reviews after integration, address findings, then package lint/typecheck/tests/build. A baseline cold-loader test exceeded its default five-second timeout; rerun separately and report it rather than attribute it to new code.

## Results

Implemented the scoped optimizations above, with bounded caches and fresh measurement/evidence lifetimes. Input editing, timer cadence and keep-awake semantics are unchanged.

### Matched interface benchmark

`npm run bench:interface` was run against an unchanged pre-edit source snapshot and the integrated source using the same Pi 1.4.0 host, Node 22.22.2, width 120, height 40, five warmups and 15 samples. Selected median synchronous CPU results:

| Workload | Before | After |
| --- | ---: | ---: |
| 100 KB printable-ASCII text fence | 35.12 ms | 1.91 ms |
| 500 ASCII assistant messages, panels + pin | 11.35 ms | 8.24 ms |
| 500 Unicode assistant messages, panels + pin | 10.10 ms | 6.70 ms |

These paragraphs are not the same workload as the audit's multiline panel fixture. Fullscreen host layout and extension reconciliation still walk history; small cached paragraphs show a smaller benefit than expensive multiline decoration. Timings vary with host load. Unicode fence transformation retains the original grapheme-aware path.

The viewer owner's matched 2,000-message A/B fixture measured warm raw renders at 49.82 → 0.60 ms and Markdown at 47.52 → 0.89 ms. Independent review verified behavior and operation counts, not these timing estimates. Cold renders and width/theme changes still lay out history; warm viewer input-signature scanning remains linear.

### Deterministic regression guards

- 400 restored resolved questions: 401 → 1 branch reads; live resolutions still read fresh evidence.
- 1,000 builtin scope checks: 9,000 → 0 manifest reads; extension owner maps and aliases remain live.
- 200 transcript records: 200 → 13 appends with identical serialized bytes in the test fixture.
- 1,000 foreground text deltas: no per-delta presentation callback; next 80 ms tick samples the latest state. Tool/turn/usage transitions remain immediate.
- A 100-worker widget calculates context for five visible rows; 101 unchanged context reads invoke the public context API once.
- Settled/queued-only widgets do not animate. Foreground resume explicitly refreshes after its synchronous running transition.
- Visibility calculations use one history measurement; native fullscreen frames still perform three passes without pinning/four with pinning. Pin repainting alone does not resolve provenance again.
- Unchanged question cards reuse painted rows; unrelated events neither invalidate cards nor replace the reminder.

### Reviews and validation

An independent Opus/high plan review ran alongside Sol/high implementations. Parallel independent Sol reviews covered transcript caches, shared viewport geometry, question evidence, worker runtime safety (xhigh), widget/context state and viewer layout. Findings were addressed: foreign-renderer coordinates and replaced question-body metadata now fail conservatively, foreground resume re-arms the widget, old context fixtures/benchmark were modernized, and a per-delta no-op callback was removed. Question evidence review also matched 120,000 deterministic differential queries against the original implementation.

Integrated validation passed lint, typecheck, build, whitespace checks, 328 interface tests and 1,312 worker/package tests (four existing skips). Worker/package validation used `npm run test:workers -- --maxWorkers=2`; the unconstrained run hit two five-second cold-loader timeouts and a concurrency timing test under load. Those three tests also passed together in isolation. The baseline already exhibited the package cold-loader timeout. No test assertions were weakened and no global timeout settings were changed.

The implementation and its measurements above predate integration with the newer `master` question-layout and highlighted-code-panel changes. The benchmark table is retained as historical evidence, not a measurement of those later features.

### Integration with newer master

The integration preserves `master`'s headerless reminders, question spacing/palette and highlighted assistant code panels, together with the performance caches and wrapping fast paths. Targeted merge validation passed 260 interface tests and two package-registration tests:

```sh
node --test tests/interface/questions.test.mjs
node --test tests/interface/text-panels.test.mjs
node --test tests/interface/questions-ui.test.mjs
node --test --test-concurrency=2 tests/interface/pinned-prompt.test.mjs tests/interface/rendering.test.mjs tests/interface/assistant-panels.test.mjs tests/interface/viewport-performance.test.mjs tests/interface/grouping.test.mjs tests/interface/palette.test.mjs
PI_E2E_LIVE=0 npm run test:workers -- tests/package/entrypoint.test.ts --maxWorkers=2
npm run lint
npm run typecheck
git diff --check
```

These interface checks use the default Pi installation on `PATH`, not a substituted host. Worker runtime code is unchanged by this integration; its earlier full validation remains applicable. The complete package suite and benchmarks were not rerun for the merge.

No live provider calls, installed configuration changes, session restarts or Quarterdeck changes were made. Git staging/commits were performed only after the user explicitly requested merging the latest `master` and squashing this work onto it. Already-running sessions have not been reloaded, and real interactive incident latency has not been remeasured.

## Idle redraw incident (2026-10-29)

### Observation

The supplied investigation reported Activity Monitor showing about 280% `nodeHost` CPU across Quarterdeck-launched Pi agents, and one apparently idle agent using about 15%. A ten-second V8 profile reportedly showed full frames every 80 ms, taking 10–15 ms each, with repeated completion-card painting and pinned-prompt measurements. These are historical incident observations, not a reproduction of the peak in this checkout.

Concurrent investigation notes proposed an unfinished manual compaction or `/tree` summary, then a hung `before_agent_start`, as possible busy-state causes; the user did not recall starting a summary. Neither explanation is confirmed. A hung `agent_settled` handler does not fit the reported busy state because Pi reports idle while dispatching that event. Worker records can be persisted while their parent notification messages remain undelivered; the two stores must not be conflated.

### Reconciled changes

- `CompletionCards` retains one width's final rows with immutable display snapshots and effective-palette invalidation. Pi rebuilds custom messages on expansion/invalidation; `showCost` remains captured at construction.
- `FleetList` stops the 200 ms refresh for an indefinitely viewed settled result, while preserving theme refresh, active/sessionless-worker discovery and finished-row linger.
- `CompletionOutbox` reports its pending count. An event-driven status immediately identifies results waiting for the main agent or for compaction, with an Escape hint in the TUI. A separate bounded watchdog supplies lifecycle diagnostics without a duplicate status banner.
- After compaction or successful tree navigation, one guarded public-idle observation window lasts at most 30 seconds, checking at 500 ms intervals after the initial check. Input, preparation and run starts invalidate it. Late arrivals can rearm within the original deadline, never extend it; expiry never forces delivery.
- Keep-awake remains activation-owned. The concurrent implementation's unconditional child-scope skip was not retained: child scope alone proves neither enabled parent ownership nor coverage of retained foreground resumes. Compatible parent tracking/cleanup tests and explicit uncovered-child regressions are retained. Safe redundant-child suppression requires a separate positive ownership contract.

### Concurrent measurements and remaining limits

The concurrent, pre-reconciliation implementation notes recorded these synthetic Pi 1.4.0 measurements at 120×40, medians of 41 samples with only a status row changing. They are retained as historical evidence, **not measurements of the final combined implementation**:

| Fixture | Before | After |
| --- | ---: | ---: |
| 17 completion cards + pinned prompt | 5.41 ms | 0.16 ms |
| 500 assistant messages + 20 cards + pinned prompt | 12.37 ms | 5.25 ms |

The separately reproduced comparison for this work is in [idle-redraw follow-up](idle-redraw-performance.md). Default panels/grouping now support fresh bounded-suffix pin measurement, but native painting, manual scrolling and pending-question visibility can still walk history. No rendered-history cache is retained across frames. Pending-result status cannot inspect messages already handed to Pi's deferred queue; results held only in the in-memory outbox do not survive process exit. Production CPU has not been remeasured.
