# Pi Dankhole performance and delivery follow-up

Implementation and review are complete for the extension-side scope. See
[results and validation](pi-follow-up-results.md), including the subsequent master
integration. Live-session reload and real-process CPU measurement remain a
separate approved handoff.

## Scope and starting state

Requested items: shared pin/question layout (1), repeatable and eventual live
measurement (6), busy diagnosis/recovery boundaries (7), durable completion
recovery (8), silent delivery failures (9), cancelled tree-summary workaround
(10), live completion-card cost setting (11), pinned-prompt wiring regression
(13), and child MCP startup ownership/duplication (3).

Baseline: `e40cf31`, identical tree to master `4378157`. The earlier full-history
claim is not universally current: default follow-end pin measurement already
uses a fresh suffix. Native painting, manual scrolling and question visibility
can still repeat full-history work. Verify current behavior before changing it.

Excluded: Quarterdeck connection/process naming, agent search policy, Agent Lab,
installed Pi patches, automatic session reloads, global MCP/configuration edits,
live provider calls and Git mutations. Host spinner and compaction limitations
are evidence/reporting work, not permission to change installed Pi.

## Implementation workstreams

### A. Shared fresh frame layout and wiring regression

- Establish a single synchronous frame/measurement lifetime across the owned
  transcript adapters. Share rows, displayed-child offsets and geometry among
  pin and question visibility where the host layout permits it. Native painting
  remains fresh: cached predicate rows must not bypass native mouse-layout updates.
- Never reuse history across frames on width/leaf/count/array identity alone.
  Streaming, same-object mutation, replacement, expansion and theme changes must
  remain visible on the next frame. Reentrant renders and exceptional exits must
  not leak a snapshot into another frame.
- Reconcile owned panel/group projections before measuring. Preserve canonical
  viewport calculations excluding the pin/reminder themselves, scroll/follow-end
  behavior, prompt provenance, question text visibility, jump offsets, mouse
  geometry and unsupported-layout fallback. Do not change question evidence or
  answer semantics.
- Reproduce the pinned-prompt full-registration failure on the declared default
  and pinned hosts. Fix the cause rather than weaken geometry assertions or
  hide a host mismatch.
- Gate with deterministic render counts and equivalent output/geometry across
  pin/question combinations, native wrappers, streaming, scroll, resize, themes,
  grouping, expansion, foreign adapters, teardown and replacement.

### B. Completion durability and failure-safe outbox

- Introduce explicit per-run delivery identity and durable states distinguishing
  pending, send-attempt/uncertain, confirmed transcript delivery and consumption.
  Use versioned session custom entries for captured/attempted/resolved state;
  derive delivery from actual persisted notification entries, not a second
  delivered journal record or a `message_end` payload observed before persistence.
  Use existing session persistence APIs where adequate; choose scoped storage
  only after checking persistence and branch contracts. No temporary-output-file
  assumption or inference from old saved worker records.
- Capture an immutable completion before attempting delivery. A failed public
  idle check retains it. A synchronous send failure must not silently discard
  it. Avoid reentrant flush duplication and preserve order/coalescing, resumed
  runs, cancellation by worker ID and monotonic pending diagnostics.
- Persist transitions before the external action where needed. A send return is
  not proof the host persisted a deferred message. Reconcile against actual
  transcript evidence; treat crash/exception gaps as uncertain rather than
  claim exactly-once delivery.
- On restart restore session-scoped known pending snapshots and distinguish
  consumed/delivered/uncertain records. Do not automatically replay any restored
  result or start a turn, including known-unsent results. Provide a visible
  recovery notice and deliberate retry/consumption
  route for records no longer held by the live manager. Legacy records remain
  explicitly unknown, not falsely recoverable.
- Cover write/read failures, malformed records, replay, branch/session changes,
  same-ID resumes, absent persistence, shutdown and send acceptance races with
  hermetic fake-host tests. Durable failure must be surfaced; no silent downgrade
  described as guaranteed recovery.

### C. Registrar/lifecycle integration and diagnosis

- Integrate B through one owner of `src/workers/index.ts`; preserve RPC/tool
  consumption, safe successful-turn/settled boundaries, startup, replacement,
  shutdown, usage and registry contracts.
- Improve content-free observed phase diagnostics without asserting an inferred
  host-internal cause. Observe preparation, work, compaction/tree hooks and the
  pending recovery state. Time elapsed is evidence, not proof of a hang.
- Address cancelled tree summaries only through verified lifecycle/public-idle
  observations. Maintain one bounded, unref'ed recovery owner; never manufacture
  idle, bypass input/run guards, auto-abort legitimate work, or force a model turn
  because a timeout elapsed. Where Pi exposes no adequate finalizer, document the
  exact remaining boundary and provide a safe explicit check/recovery command.
- Prepare a local upstream issue/reproducer for missing host signals and spinner
  redraw behavior if not fixable through supported extension ownership. Do not
  publish or patch installed host code.

### D. Live completion-card settings

- Supply the owning registrar's live show-cost preference to each card and
  include its current value in the bounded render cache key. Existing cards
  update on the next render without rebuilding the full transcript.
- Keep captured notification/model-context data immutable, palette invalidation,
  Markdown handling, widths, expansion and historical invocation metadata intact.
  Do not retain an unbounded registry of card components.

### E. Child MCP startup ownership

- Trace child resource-loader, inherited extension and built-in MCP startup paths
  before choosing a change. No credential reads or live server launches.
- Prefer eliminating provably unused startup through existing child scope and
  supported loader APIs. Do not silently remove inherited tools or share mutable
  server/session/auth state across child permission boundaries.
- If a useful public control exists, implement a backward-compatible explicit
  child policy with tests for default inheritance, opt-out/narrow scope, late
  registration and failure cleanup. If it does not, report the precise host API
  gap and a proposed upstream contract rather than inventing a transport shim.

### F. Measurement and documentation

- Extend synthetic benchmarks with shared pin/question frames and operation
  counts. Compare unchanged source and new source with the same explicitly
  recorded Pi/Node host, terminal geometry and workload. Do not equate synthetic
  render time with real incident CPU.
- Prepare a bounded real-agent measurement protocol recording process identity,
  lifecycle state, active workers, display mode and sample duration. Loading
  changes into live sessions waits until active workers finish and the user
  confirms the target/reload handoff. This worktree is not the installed package.
- Report implemented fixes, host-dependent gaps and empirical unknowns separately.

## Parallel ownership and review sequence

The lead owns integration, this plan/docs, static validation and user interaction.
Layout owns styling layout modules and their tests; durability owns outbox/new
journal modules and unit tests; lifecycle owns worker registrar/diagnostics and
wiring tests; card owner owns card renderer and renderer tests; MCP owner owns
runner/child-loading files and focused scope tests. Shared files are serialized
and integration interfaces agreed before edits.

An independent high-effort reviewer audits this plan while implementation starts,
particularly freshness, crash consistency, branch isolation, replay semantics,
public-idle safety and child MCP trust boundaries. Findings are relayed to owners.
After implementation, independent layout and delivery/lifecycle safety reviews
run concurrently, with a separate MCP review if that runtime path changes.
All actionable findings receive fixes and affected regression checks.

Each owner runs focused test files, not full suites. The lead runs lint,
typecheck, whitespace checks and the smallest combined consumer set justified
by shared layout/lifecycle changes. All real-host fixtures mock `pi.exec` before
worker registration so test shutdown cannot run Git worktree prune. No live
providers, OS helper launches or installed configuration mutations are required.

## Discovery and plan-review decisions

- Default installed and pinned-development hosts are both Pi 1.4.0. Layout and
  session files inspected by owners match. The pinned-prompt suite passes 26/26
  on each host, including the reported full-registration case; no failure fix is
  claimed without reproduction.
- The host lacks a public frame bracket. Use a narrowly guarded, reversible
  per-instance adapter only where the supported host shape is verified. Keep
  nested-predicate lifetime distinct from frame lifetime so suffix measurement
  is not accidentally disabled. Search/reentrant rendering and width-dependent
  mouse geometry are mandatory checks. Do not reuse predicate rows for native
  paint in this implementation.
- `pi.sendMessage()` returns void and catches asynchronous failures internally.
  Session `message_end` runs before the persistence write. Neither alone is a
  durable acknowledgement. Session-ledger restoration is session-wide rather
  than branch-rewinding; foreign owner IDs on forks/clones are excluded.
- Session `appendEntry()` can mutate in-memory state before a disk error and can
  remain memory-only before ordinary transcript persistence begins. Degraded
  durability is visible, never a reason to discard the in-memory result.
- Shutdown-induced stopped results are excluded from recovery to avoid replay
  noise; genuine results settling during shutdown retain their pinned session
  ownership where capture is possible.
- Built-in MCP eagerly connects before child tool scoping. Add explicit launch
  policy `mcp_startup: "inherit" | "skip-unreachable"`, defaulting to inheritance.
  Opt-in may suppress only `builtin:mcp` when explicit extension-tool scope makes
  its tools unreachable. No shared transports, auth state or config reimplementation.
- The user clarified **no Pi-core edits**. Core checkout choice Q3 was dismissed.
  At the user's separate request, the clean obsolete 0.70.6 fork was moved to
  `~/.Trash/pi-mono-20261029-160158`; installed Pi was untouched.
- The public API can customize the main working indicator's animation, but not
  every summary/retry spinner. No automatic cosmetic spinner policy is applied.
  Generic compaction deadlines cannot safely be enforced by this extension;
  cancellation request is not cancellation completion.

## Acceptance

1. Repeated frame work measurably decreases without stale text or wrong geometry.
2. Newly captured completions are never silently discarded on idle/send errors;
   persisted recovery distinguishes consumption and uncertain delivery honestly.
3. No unsafe busy delivery, automatic cancellation, cross-session replay or change
   to worker trust/usage/registry contracts.
4. Old completion cards follow the live show-cost setting on render.
5. The reported wiring failure is resolved or precisely demonstrated as an
   unsupported host boundary, not hidden by a weakened test.
6. MCP behavior changes only where verified APIs and preserved permissions permit;
   exclusions and remaining host requirements are explicit.
7. Validation commands/counts, benchmark host and remaining live-measurement work
   are recorded. No claim of reduced production CPU without measurement.
