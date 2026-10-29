# Idle redraw performance follow-up

## Evidence and limits

The motivating investigation reported an idle Pi task redrawing every 80 ms,
roughly 15% process CPU, repeated completion-card painting and pinned-prompt
conversation measurement. These are historical observations supplied with the
request, not a reproduction in this checkout. The reported 280% aggregate
`nodeHost` peak was not profiled. The specific timer and reason the parent stayed
busy remain unproven; Pi's own working indicator also uses an 80 ms loader.

This work changes the extension only. It does not patch Quarterdeck or Pi,
terminate processes, enable an inspector, change installed configuration, reload
sessions or change worker authorization, usage, persistence or registry contracts.
The checkout already contains the optimizations recorded in
[extension performance](performance.md).

## Implementation plan

1. Cache completed card output locally and with bounded retention. Reuse final
   painted rows on unchanged redraws, not just Markdown layout. Respect width,
   theme invalidation, expansion, cost display and immutable notification content.
2. Reduce pinned-prompt measurement without guessing transcript freshness.
   Width, leaf ID, child count and array identity alone do not detect streaming,
   expansion or same-length replacement. Preserve canonical no-pin viewport,
   selected-entry provenance, conservative unsupported-layout behavior, fresh
   jump offsets and shared question-reminder geometry.
3. Audit extension animation ownership. Stop and clean up timers when their
   actual presentation work finishes; preserve active animation and handoff,
   resume, error and cancellation behavior. Do not stop the host spinner by
   pretending that a busy session is idle.
4. Make delayed completions observable through bounded, privacy-safe diagnostics.
   Preserve delivery at successful turn boundaries, final settlement or observed
   idle. A diagnostic timeout must never force delivery, inject a model turn,
   discard results or cancel real work. Distinguish observed lifecycle state from
   an internal host busy reason that the public API cannot expose.
5. Audit keep-awake ownership and cleanup. Multiple helpers can belong to
   distinct child runtimes in one OS process; process-wide deduplication or
   timeout-based release would require a separate ownership design. Fix only
   demonstrated bugs and retain holds through genuine cancellation cleanup.

Implementation owners work on disjoint card, viewport and lifecycle files while
an independent plan reviewer checks assumptions. After integration, independent
rendering and lifecycle reviewers run in parallel. Concrete findings receive
regression coverage before final lint, typecheck and focused consumer validation.

## Acceptance and validation

- Unchanged completion cards avoid wrapping and decoration; invalidation and
  resize still produce correct narrow, Unicode/ANSI-safe, themed output.
- Pin optimizations have deterministic operation-count coverage, with scroll,
  streaming, expansion, resize, branch/compaction and question-reminder consumers
  checked. Do not trade correctness for an unqualified cross-frame history cache.
- Pending diagnostics are bounded and content-free, and clean up on consumption,
  delivery, disposal and session replacement. Failed/aborted turns retain safe
  delivery semantics.
- Idle/settled extension UI does not animate needlessly; genuine worker activity
  and keep-awake cancellation holds remain intact.
- Tests use synthetic sessions and fake timers/processes, never live providers.
  See [testing guidance](testing.md) for focused file selection.

`scripts/bench-interface.mjs` includes a warm-render fixture with 1 and 17 settled
completion-card instances, in addition to the existing transcript/pin workloads.
The 1/17-card rows measure cards directly. A separate 500-message + 17-card row
uses real Pi `CustomMessageComponent` wrappers and fullscreen layout with panels,
grouping and pinning enabled; ordinary transcript rows have no tool groups.
It reports synchronous synthetic render time, **not** incident CPU, end-to-end
input latency or a guarantee about total process CPU. `DANKHOLE_BENCH_ROOT` selects
an unchanged source snapshot for matched comparisons; `PI_PACKAGE_DIR` selects
the host. Timing varies with machine load; operation-count tests are the
regression gate.

## Implemented behavior and measurements

Completion cards retain one width's final rows, own their display snapshot and
refresh both Markdown and outer rows on explicit invalidation or effective
palette changes. Pi's real wrapper rebuilds cards for expansion/invalidation;
historical cost display remains construction-time behavior.

Pin visibility can freshly measure a viewport-filling suffix, including owned
panel and grouping adapters. Those adapters still reconcile live content first;
foreign renderers retain conservative full measurement. There is no cross-frame
rendered-history cache or visibility throttling. Provenance, panel reconciliation
and grouping membership still scan history. Native painting, manual scrolling,
jumps and pending-question visibility can still need full-history work.

Extension cleanup fixes cover an initial foreground UI-update failure, late
widget callbacks after disposal and fleet timer creation without enabled UI.
`/agents diagnostics` reports pending count/monotonic age, public parent state,
last observed lifecycle and widget/fleet/foreground timer counts. The host spinner
is not measured. An event-driven status immediately shows results waiting for
the parent, including a compaction-specific Escape hint in the TUI. A one-shot,
unref'ed 30-second watchdog warns without adding another status banner, changing
delivery or starting a model turn. A timeout does not mean the parent is stuck.

Pending results also get a public-idle check after compaction or successful tree
navigation. Because Pi awaits
later async compaction hooks before clearing busy state, one next-macrotask check
is insufficient. Recovery uses one unref'ed timer, checking immediately and then
every 500 ms for at most 30 seconds. Every attempt rechecks public idle; queue
drain and consumption cancel timers; shutdown and replacement also invalidate the
observation window, as do observed input, preparation and run starts. Active
run/signal checks protect retry gaps. An empty queue retains the original deadline so late arrivals
can rearm checks within it, never extend it. At expiry, results and diagnostics
remain intact. Arbitrary-duration hooks beyond 30 seconds
can still defer delivery until another safe boundary; guaranteeing their recovery
would need a true post-finalizer host signal or unbounded observation.

Keep-awake behavior is intentionally unchanged: independent activation-owned
helpers release on settlement/shutdown, including real worker event wiring.
Child activations retain their 500 ms pollers and exit listeners until disposal
(normally manager eviction after about ten minutes plus its cleanup tick).
Bursts can still produce `MaxListeners` warnings; there is no hard listener-count
cap. Suppressing child integration without proof of an enabled parent owner can
remove legitimate coverage, so this is a documented pre-existing limitation,
not a claimed leak fix or a process-wide deduplication.

### Matched synthetic render timings

Using the same Pi 1.4.0 development host, Node 22.22.2 (`nodeHost` shim), width 120,
height 40, five warmups and 15 samples; baseline source is unchanged
`33f9640ed2579f4a6c3266bbde17f6985bba79b4`. Other review agents were running, so
these medians are indicative synchronous timings, not controlled CPU attribution.

| Workload | Before | After |
| --- | ---: | ---: |
| 17 completion cards, direct warm paint | 1.625 ms | 0.049 ms |
| 500 Unicode messages + 17 real card wrappers, panels/grouping/pin frame | 10.394 ms | 3.549 ms |
| 500 ASCII messages, panels/grouping/pin frame | 6.573 ms | 3.578 ms |
| 500 Unicode messages, panels/grouping/pin frame | 6.654 ms | 3.742 ms |

Commands: `DANKHOLE_BENCH_ROOT=<unchanged-source-snapshot> npm run bench:interface`,
then `npm run bench:interface`. Both reported this checkout's
`node_modules/@earendil-works/pi-coding-agent` host. The 17-card direct-paint
median fell about 97%; the mixed full-frame fixture fell about 66%. These numbers
do **not** show that the reported 280% peak or parent busy-state cause is fixed.

## Reviews and validation

An Opus/high plan review ran alongside three Sol/high implementation owners.
The review identified the default grouping/panel path and real message-wrapper
coverage gaps; both were addressed. Post-implementation Sol rendering/high and
lifecycle/xhigh reviews ran in parallel. Rendering had no substantive findings
and independently matched 400 suffix decisions to fresh full-document geometry.
Lifecycle review reproduced the delayed compaction-hook race against real Pi
methods; the bounded observation fix and real-host regression address it,
including arrivals during later async hooks. The original reviewer confirmed the
finding fully resolved, with no new substantive attributable findings.

Focused passing commands (overlapping runs are not additive test counts):

```sh
# Rendering and affected shared-viewport consumers: 262 tests.
node --test --test-concurrency=2 tests/interface/pinned-prompt.test.mjs tests/interface/viewport-performance.test.mjs tests/interface/questions.test.mjs tests/interface/questions-ui.test.mjs tests/interface/grouping.test.mjs tests/interface/assistant-panels.test.mjs tests/interface/thinking-collapse.test.mjs tests/interface/rendering.test.mjs
# Activation-owned helpers and observer-retention evidence: 21 tests.
node --test tests/interface/keep-awake.test.mjs
# Real card wrapper, cache and retained output: 28 tests.
PI_E2E_LIVE=0 npm run test:workers -- tests/workers/completion-card-layout-integration.test.ts tests/workers/completion-card-cache.test.ts tests/workers/completion-rendering.test.ts
# Lifecycle/presentation owner validation before the final compaction-race repair: 181 tests.
PI_E2E_LIVE=0 npm run test:workers -- tests/workers/completion-outbox.test.ts tests/workers/completion-diagnostics.test.ts tests/workers/completion-delivery-wiring.test.ts tests/workers/foreground-detach-wiring.test.ts tests/workers/presentation-lifecycle.test.ts tests/workers/agent-widget.test.ts tests/workers/fleet-list.test.ts tests/workers/fleet-wiring.test.ts tests/workers/shutdown-disposal.test.ts
# Affected tests rerun after that repair, including late arrivals: 63 tests.
PI_E2E_LIVE=0 npm run test:workers -- tests/workers/completion-delivery-wiring.test.ts tests/workers/completion-outbox.test.ts tests/workers/completion-diagnostics.test.ts
# Additional integrated consumers: 41 tests.
PI_E2E_LIVE=0 npm run test:workers -- tests/workers/cost-display.test.ts tests/workers/completion-notification-wiring.test.ts tests/workers/foreground-detach.test.ts tests/workers/foreground-concurrency-wiring.test.ts tests/workers/rpc-result-consumption.test.ts tests/workers/wait-queued.test.ts tests/package/entrypoint.test.ts --maxWorkers=2
npm run lint
npm run typecheck
git diff --check
```

Final static checks pass. Full suites, build/emission, real interactive CPU and
live provider calls were not run. Existing passing checks were reused for
unchanged behavior. Lint initially caught import ordering in the new integration
test; it was corrected without changing assertions.

**Test-safety disclosure:** early real-host test shutdown reached the existing
`git worktree prune` path. Both host fixtures now mock `pi.exec`, including that
unrelated OS boundary. Four worktrees remained registered when inspected;
whether previously stale registration metadata was removed is unknown. No
commits, branch changes or pushes were made. Installed configuration and running
sessions were not changed or reloaded.

## Reconciliation with concurrent master edits

The user subsequently authorized integrating master's overlapping uncommitted
changes before squash-merging. Both trees shared `33f9640` as their committed
base; no Git remote was configured. The concurrent implementation added a static
viewed-result fleet fix, immediate pending status, summary/tree idle recovery,
input/run guards and additional real-host/card tests. These are reconciled with
this work's stronger cache, fresh suffix measurement, diagnostics and guarded
30-second recovery policy. There is one status owner and one recovery window,
not parallel implementations of the same responsibility.

Master's unconditional child keep-awake skip was rejected because it removed
legitimate standalone-child and retained-foreground-resume coverage without a
positive parent-owner contract. Compatible master parent/cleanup tests and those
specific coverage regressions are retained; keep-awake production behavior is
unchanged. This semantic conflict resolution was explained to the user before
committing. The concurrent incident notes and separate historical measurements
are retained, with corrected combined behavior, in [performance](performance.md).

Initial integration validation passed **346 worker/package tests in 23 selected files**
(344 together, then two subsequently added summary-window regressions) and
**33 interface tests in two files**, plus lint, typecheck and whitespace checks:

```sh
PI_E2E_LIVE=0 npm run test:workers -- tests/workers/completion-outbox.test.ts tests/workers/completion-diagnostics.test.ts tests/workers/completion-delivery-wiring.test.ts tests/workers/completion-compaction-wiring.test.ts tests/workers/completion-notification-wiring.test.ts tests/workers/completion-card-cache.test.ts tests/workers/completion-rendering.test.ts tests/workers/completion-card-layout-integration.test.ts tests/workers/fleet-list.test.ts tests/workers/fleet-wiring.test.ts tests/workers/fleet-idle-timers.test.ts tests/workers/idle-render-timers.test.ts tests/workers/presentation-lifecycle.test.ts tests/workers/foreground-detach-wiring.test.ts tests/workers/foreground-detach.test.ts tests/workers/foreground-concurrency-wiring.test.ts tests/workers/rpc-result-consumption.test.ts tests/workers/wait-queued.test.ts tests/package/entrypoint.test.ts tests/workers/shutdown-disposal.test.ts tests/workers/cost-display.test.ts tests/workers/agent-widget.test.ts --maxWorkers=2
PI_E2E_LIVE=0 npm run test:workers -- tests/workers/completion-summary-window.test.ts
PI_PACKAGE_DIR="$PWD/node_modules/@earendil-works/pi-coding-agent" node --test tests/interface/completion-card-frame.test.mjs tests/interface/keep-awake.test.mjs
npm run lint
npm run typecheck
git diff --check
```

After a stable handoff of the final master edits, an additional overlapping
**90-test** run covered new consume/rearrival, empty-window cancellation,
post-deadline assertions and observation-only input behavior:

```sh
PI_E2E_LIVE=0 npm run test:workers -- tests/workers/completion-delivery-wiring.test.ts tests/workers/completion-outbox.test.ts tests/workers/plain-worker-surface.test.ts
```

This last reconciliation changed production comments only, not the reviewed
runtime behavior. The earlier 262 passing styling-consumer tests and geometry
oracle remain applicable: their source did not change in this reconciliation. Full suites,
build/emission, live CPU measurements and provider calls were not repeated.
