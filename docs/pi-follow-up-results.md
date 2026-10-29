# Pi follow-up implementation results

Scope and decisions: [implementation plan](pi-follow-up-plan.md).
Detailed benchmark evidence and live handoff: [measurements](pi-live-measurement.md).
Host-only limits: [Pi boundaries](pi-host-boundaries.md).

## Implemented

- Shared, synchronous visibility measurements across pinned-prompt and pending-
  question predicates on supported Pi 1.4 fullscreen instances. Native painting
  remains fresh. Frame ownership is guarded and reversible; search/reentry,
  exception cleanup, foreign renderers, streaming and mouse geometry are tested.
  Supported reminder frames take two history passes instead of three or four.
  Pin-only frames retain bounded suffix measurement.
- Per-run completion snapshots and captured/attempted/resolved session entries.
  Canonical transcript entries establish delivery evidence; void send acceptance
  does not. Idle/send failures retain results and expose state. Restart restoration
  never automatically sends, even for known-unsent results. Full terminal-result
  retrieval and deliberate recovery are available without restoring execution.
- Safer lifecycle wiring: capture before completion observers; isolate history,
  event and presentation failures; preserve parent-session ownership; retain real
  results during shutdown while excluding shutdown-induced stopped noise. Inline
  foreground consumption acknowledges only that run, not older pending runs.
- Bounded public-idle observation after observed summary cancellation, plus explicit
  `/agents recover check`. Stale public getters produce unknown diagnostics rather
  than an uncaught watchdog exception. Aborted settlement does not automatically
  start a new parent turn. Named retry initially attempts only its selected run.
- Existing completion cards use the registrar's live cost-display preference,
  without mutating captured model-context text or rebuilding Markdown on cost-only
  changes.
- Opt-in `mcp_startup: "skip-unreachable"` avoids built-in MCP factory/connection
  startup when an explicit extension-tool allowlist excludes its owner. Defaults,
  child trust, unrelated extensions, and direct/nested tool gates are preserved.

## Review and integration findings

An Opus/high plan review ran while implementation began. Sol/xhigh owners handled
layout and durability; Sol/high owners handled lifecycle integration, MCP policy
and card/measurement work. Final independent layout/card, delivery/lifecycle and
MCP reviews ran concurrently. Provider connection failures interrupted two reviews;
the same reviewers resumed and completed, rather than treating partial output as
approval. No model fallback was substituted.

Addressed findings include interrupted-render cache repopulation, per-run versus
worker-wide acknowledgement, routine unverified-durability popup noise, duplicate
held-result watchdog warnings, scoped retries, bounded inspection previews and
watchdog age attributable to eligible rather than held records. Capture failures
retain an explicit warning/readable live result instead of an unsafe untracked
transport fallback. Receipt evidence is not described as a disk/fsync transaction.

Consumer tests initially exposed incomplete mock startup/receipt behavior. Fixtures
now bind a parent session and persist canonical in-memory notification entries;
notification, usage, cancellation, handoff and timer assertions were preserved.
No runtime delivery checks were relaxed to accommodate an invalid mock context.

The reported existing `pinned-prompt.test.mjs` full-registration failure did not
reproduce on either default or pinned Pi 1.4.0. Coverage now also exercises real
`TuiAltScreen` wiring and teardown; no unsupported bug-fix claim is made.

## Measurement

The identical synthetic harness completed 29 workloads before and after. All eight
native-frame output hashes, viewport/follow-end geometry and write-size comparisons
match. For 500 messages with pin and reminder, median/p95 synchronous render time
was **18.890/19.921 → 8.343/8.974 ms** after the reentry fix; assistant/card/question
render counts fell **2000/68/80 → 1000/34/40**. Other workloads did not uniformly
improve under concurrent load. These are synthetic timings, not real process CPU.

## Final validation

The shared registrar/outbox/child-loader changes justified a combined consumer run,
not the whole package suite. This selected 36 files / 692 tests: 691 initially
passed; one timer fixture had no canonical receipt and correctly retained a
completion watchdog. The fixture now writes actual in-memory session entries,
without changing its timer assertions; its nine tests then passed. Unaffected
passing checks were reused. Subsequent watchdog-age regressions were added and
all 15 affected files were rerun: **256/256 passed**.

Combined consumer command:

```sh
PI_OFFLINE=1 PI_E2E_LIVE=0 npm run test:workers -- \
  tests/workers/completion-journal.test.ts \
  tests/workers/completion-outbox.test.ts \
  tests/workers/completion-diagnostics.test.ts \
  tests/workers/parent-lifecycle.test.ts \
  tests/workers/completion-lifecycle-wiring.test.ts \
  tests/workers/completion-delivery-wiring.test.ts \
  tests/workers/completion-compaction-wiring.test.ts \
  tests/workers/completion-summary-window.test.ts \
  tests/workers/completion-notification-wiring.test.ts \
  tests/workers/completion-card-cache.test.ts \
  tests/workers/completion-rendering.test.ts \
  tests/workers/completion-card-layout-integration.test.ts \
  tests/workers/foreground-detach-wiring.test.ts \
  tests/workers/foreground-detach.test.ts \
  tests/workers/foreground-concurrency-wiring.test.ts \
  tests/workers/foreground-result-retrieval.test.ts \
  tests/workers/rpc-result-consumption.test.ts \
  tests/workers/rpc-lifecycle-gating.test.ts \
  tests/workers/cross-extension-rpc.test.ts \
  tests/workers/wait-queued.test.ts \
  tests/workers/shutdown-disposal.test.ts \
  tests/workers/child-session-shutdown.test.ts \
  tests/workers/cost-display.test.ts \
  tests/workers/agent-widget.test.ts \
  tests/workers/agent-runner.test.ts \
  tests/workers/agent-runner-resume.test.ts \
  tests/workers/agent-runner-e2e.test.ts \
  tests/workers/invocation-config.test.ts \
  tests/workers/agent-runner-mcp-policy.test.ts \
  tests/workers/plain-worker-surface.test.ts \
  tests/workers/fleet-list.test.ts \
  tests/workers/fleet-wiring.test.ts \
  tests/workers/fleet-idle-timers.test.ts \
  tests/workers/idle-render-timers.test.ts \
  tests/workers/presentation-lifecycle.test.ts \
  tests/package/entrypoint.test.ts --maxWorkers=2
```

Final affected rerun, **256 passed**:

```sh
PI_OFFLINE=1 PI_E2E_LIVE=0 npm run test:workers -- \
  tests/workers/completion-journal.test.ts \
  tests/workers/completion-outbox.test.ts \
  tests/workers/completion-diagnostics.test.ts \
  tests/workers/parent-lifecycle.test.ts \
  tests/workers/completion-lifecycle-wiring.test.ts \
  tests/workers/completion-delivery-wiring.test.ts \
  tests/workers/completion-compaction-wiring.test.ts \
  tests/workers/completion-summary-window.test.ts \
  tests/workers/completion-notification-wiring.test.ts \
  tests/workers/idle-render-timers.test.ts \
  tests/workers/wait-queued.test.ts \
  tests/workers/foreground-detach-wiring.test.ts \
  tests/workers/cost-display.test.ts \
  tests/workers/shutdown-disposal.test.ts \
  tests/workers/rpc-result-consumption.test.ts --maxWorkers=2
```

Final default-host interface run, **200/200 passed**:

```sh
env -u PI_PACKAGE_DIR PI_E2E_LIVE=0 node --test --test-concurrency=2 \
  tests/interface/transcript-frame.test.mjs \
  tests/interface/viewport-performance.test.mjs \
  tests/interface/pinned-prompt.test.mjs \
  tests/interface/questions.test.mjs \
  tests/interface/grouping.test.mjs \
  tests/interface/assistant-panels.test.mjs \
  tests/interface/completion-card-frame.test.mjs
```

Final `npm run lint`, `npm run typecheck` and `git diff --check` pass. The rendering
reviewer independently reran the original real-host reproducer and frame tests;
the stale-cache finding is resolved. The delivery reviewer confirmed the six
initial findings resolved; the subsequent cosmetic watchdog-age finding has a
focused regression and lead verification. MCP review was clean. All eight final
native-frame benchmark comparisons match (see linked measurement receipts).

Omitted: full package/feature suites, live providers, live MCP transports, an
installed-source switch/reload and real-process CPU sampling. Tests and benchmarks
are hermetic/local, not evidence that the historical interactive incident is gone.

## Remaining boundaries

- Real-agent CPU has **not** been remeasured. The user subsequently requested
  integration into the configured master checkout (below). No running session
  was reloaded or configuration switched. A separately approved, idle-session
  reload and measurement handoff is still required.
- Native paint still needs its own pass. Unsupported/foreign layouts fall back
  conservatively; there is no cross-frame rendered-history cache.
- The historical stuck-busy cause remains unconfirmed. Missing tree error/finalizer
  events and hooks that ignore cancellation cannot be solved completely here.
  There is no forced-idle or unattended compaction-timeout mechanism.
- Pi's public working-indicator controls do not cover every summary/retry spinner.
  Pi core was not modified, as requested.
- Recovery cannot guarantee a capture before a crash, ephemeral/unflushed session
  persistence, disk writes or power-loss durability. Legacy records lack delivery
  identity. Uncertain retry can duplicate an earlier accepted send and therefore
  needs explicit confirmation. Recovery does not recreate executable workers.
- MCP connections are not shared and admitted servers remain eager; only provably
  unreachable built-in MCP startup is skipped by the opt-in policy.

The obsolete clean Pi fork was moved to `~/.Trash/pi-mono-20261029-160158` at the
user's explicit request. Installed Pi and original extension projects were not
changed. At the end of the original validation, this follow-up was uncommitted
and the configured main checkout was unchanged.

## Subsequent master integration

At the user's request, merged latest local `master` (`c257fa2`) into the follow-up
as `733b220`, preparing a single squash commit onto `master`. No remote is
configured. The previous implementation/squash snapshots `e40cf31` and `4378157`
have identical trees; conflicts from that duplicated history were resolved by
preserving the follow-up versions. Verified that the merged tree differs from
the follow-up snapshot `d9edc47` only by master's three keep-awake files, each
identical to master. This preserves display plus idle-system sleep prevention.

Post-merge validation:

```sh
# 27 passed
env -u PI_PACKAGE_DIR PI_E2E_LIVE=0 node --test tests/interface/keep-awake.test.mjs
# 24 passed across two files
PI_OFFLINE=1 PI_E2E_LIVE=0 npm run test:workers -- tests/package/entrypoint.test.ts tests/workers/completion-lifecycle-wiring.test.ts --maxWorkers=2
npm run lint
npm run typecheck
git diff --check
```

All passed. Earlier follow-up validation was reused for unchanged files; no full
suite, live provider, CPU sample or session reload was added for this merge.
