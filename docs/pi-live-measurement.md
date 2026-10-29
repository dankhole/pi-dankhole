# Reproducible Pi measurement and live handoff

## What has and has not been measured

This worktree is **not the configured extension source**. No running Pi session
has been inspected, restarted or reloaded for this measurement. Real incident
CPU, input latency and the reported aggregate `nodeHost` peak remain unmeasured.
Do not infer a CPU improvement or identify a busy-state cause from synthetic
render timings. See [the follow-up plan](pi-follow-up-plan.md),
[performance history](performance.md) and [idle-redraw evidence](idle-redraw-performance.md).

The synthetic benchmark imports leaf rendering modules and an explicitly selected
Pi package. It does not activate the package entrypoint, start a Pi CLI/session,
execute tools, start providers/MCP/keep-awake helpers, read extension configuration,
change installed files or start a terminal/theme watcher. Jiti's disk cache is
disabled. Its terminal is an in-memory sink; render requests are synchronous
no-ops, with no animation timer. Built-in dark-theme data is selected in memory.

Existing direct-card, text-transform and `renderLayoutFrame` benchmark rows are
preserved. Eight additional `shared-pin-question-frame` rows exercise:

- 100 or 500 Unicode assistant messages, 20 native self-shell question wrappers,
  17 native completion wrappers, and one actual collapsed tool pair per 100 messages.
- One pending question above the follow-end viewport. Pin and reminder each run
  both enabled and disabled, with panels/grouping enabled throughout. Question
  bodies are fixed two-line synthetic components with owned content metadata;
  question evidence and answering state are not activated.
- A real, **unstarted** `TuiAltScreen` instance, 120 columns × 40 rows, painting via
  `doRender()` into a fake terminal. Only one equal-width synthetic status row
  alternates; history and notification snapshots do not change.
- Five warmups, 15 elapsed-time samples, then one separately counted warm frame.
  Timings are synchronous elapsed milliseconds, not OS CPU utilization or user
  input latency. Counts include native paint, which must remain fresh.

The fixture intentionally uses Pi 1.4's internal instance paint entrypoint without
calling `start()`: it enables only its in-memory alternate-screen paint flag.
Production installers must attach their own guarded instance adapter. The harness
never calls `withTranscriptFrame()` or substitutes a manually bracketed
`renderLayoutFrame()` for that wiring. New rows report `frameAdapter`, render and
metadata counts, output SHA-256, native viewport height, follow-end state and
fake-terminal write counts. A frame must perform exactly one terminal write,
retain its configured pin/reminder and contain 40 screen rows. The original
rows retain their original measurement driver; do not compare their timings as
though they included the new native compositor.

## Matched synthetic commands

Run from the intended source checkout with dependencies already present. Set
`PI_PACKAGE_DIR` explicitly; the benchmark no longer discovers a host through
`which pi`. Do not install dependencies or alter installed Pi for a benchmark.
The following creates an immutable-source baseline from committed HEAD, not a
Git worktree. Git operations here are read-only; the archive and dependency
symlink are new temporary files only.

```sh
set -euo pipefail
repo="$PWD"
host="$repo/node_modules/@earendil-works/pi-coding-agent"
before="$(mktemp -d /tmp/pi-dankhole-before.XXXXXX)"
git rev-parse HEAD
git archive --format=tar HEAD | tar -x -C "$before"
ln -s "$repo/node_modules" "$before/node_modules"
PI_E2E_LIVE=0 PI_PACKAGE_DIR="$host" DANKHOLE_BENCH_ROOT="$before" \
  node "$repo/scripts/bench-interface.mjs" > "$before.bench.jsonl"
printf 'source=%s\nresult=%s\n' "$before" "$before.bench.jsonl"
```

Use the **new, identical harness** to load both sources, rather than running the
old script inside the archive. Keep the archive, dependency symlink and JSONL
receipt. `DANKHOLE_BENCH_ROOT` changes only imported source, not host selection.
The header records real source/host paths, Pi/TUI/Node versions, executable,
geometry, palette mode, harness hash and the main participating source-file
hashes. Those listed hashes are not a fingerprint of every transitive dependency;
the archive commit identifies the complete committed baseline.

**Wait for the lead's layout-ready handoff before the after run.** Freeze an
explicit after-source snapshot if relevant files can still change; do not label
a run against concurrently changing sources as a final measurement. With a
stable source directory supplied by the lead:

```sh
# Fill these with the retained baseline receipt and the lead's stable source.
# Reuse the same host, Node executable, harness and terminal geometry.
PI_E2E_LIVE=0 PI_PACKAGE_DIR="$host" DANKHOLE_BENCH_ROOT="$after_source" \
  node "$repo/scripts/bench-interface.mjs" > "$after_result"
```

Before interpreting the pair, compare harness hash, host/version, color mode,
geometry and all workload fields. Compare screen hashes, viewport height and
follow-end state for each new row; any difference requires a geometry/output
investigation, not a performance claim. For pin/reminder-enabled after rows,
`frameAdapter` must be `guarded-instance`; baseline HEAD has `native-unadapted`.
The neither-enabled row legitimately remains unadapted. Check that counts are
bounded and that the shared-predicate pass decreases without removing native
paint. Report timings as local synthetic observations with concurrent-load
caveats, never as proof of reduced real process CPU.

### Captured baseline, 2026-10-29

- Source: unchanged archive of `e40cf31737cd3167cd67463beacd0f78e0d86bba` at
  `/tmp/pi-dankhole-before.7EVE0z` (real path `/private/tmp/pi-dankhole-before.7EVE0z`).
- Dependencies: archive `node_modules` symlink to this checkout's existing tree.
- Host: `/Users/d.cole/.quarterdeck/worktrees/0e607/pi-dankhole/node_modules/@earendil-works/pi-coding-agent`;
  Pi **1.4.0**, TUI **1.4.0**, Node **v22.22.2**, Darwin arm64.
- Executable: `/Users/d.cole/Applications/Quarterdeck.app/Contents/Resources/runtime/bin/nodeHost`.
  This was a direct synthetic Node script, **not** a Quarterdeck/Pi live session.
- Built-in dark, truecolor, 120×40; five warmups and 15 samples.
- Harness SHA-256: `394f1cc2b86721707e4308040920a815ae255090fdcb3bdc7a73f023734fd25a`.
- Receipt: `/tmp/pi-dankhole-before.7EVE0z.bench.jsonl`; 21 preserved workload
  rows plus eight new rows, all completed. Temporary receipts are not durable storage.
- Other agents were running; timings are not controlled process-CPU attribution.

### Historical after measurement — before review fix

**The tables in this section predate the reentrant stale-snapshot review fix.**
They are retained as intermediate evidence, not final-source results. The final
post-review run below supersedes them; the unchanged baseline is reused.

After the lead's layout-ready handoff, `src/` was copied to
`/tmp/pi-dankhole-after.4OPfbO` (real path `/private/tmp/pi-dankhole-after.4OPfbO`),
with a symlink to the same existing `node_modules`. This freezes the source used
by this run despite unrelated concurrent integration. The receipt is
`/tmp/pi-dankhole-after.4OPfbO.bench.jsonl`. Both receipts completed all **29**
workloads. No harness change or repair was needed; the harness hash, pinned host,
Pi/TUI/Node versions, executable, palette, geometry and sample counts match.

After-source layout hashes recorded in the receipt:

- `styling/pinned-prompt.ts`: `0ba9ee31d51e8573b4b427e5a65d41225eb8762243250ae05566bfb5a9cb9313`
- `styling/transcript-measurement.ts`: `d3474e1555a1b18b89e84240f9022eb54dcb3ffda9f6642cfd8b794f4053177c`
- `questions/question-viewport.ts`: `b685ba0136fb09af16c38a28188c5c6576fae2aaa3807976e9f5c520e3bf099f`

All eight real-frame screen hashes, viewport heights, follow-end states and
terminal-write byte counts matched exactly. All eight painted once (163 bytes
in the counted warm frame). Six pin/reminder-enabled after rows reported
`guarded-instance`; the two neither-enabled controls remained `native-unadapted`.
Heights for neither/reminder-only/pin-only/both stayed 35/34/34/33 rows, all
following end. Workload definitions matched across all 29 rows.

| Messages | Pin | Reminder | Before median / p95 ms | After median / p95 ms | Before → after assistant / completion / question renders |
| ---: | :---: | :---: | ---: | ---: | --- |
| 100 | off | off | 0.845 / 0.927 | 0.876 / 1.900 | 100 / 17 / 20 → 100 / 17 / 20 |
| 100 | off | on | 3.169 / 4.001 | 1.760 / 3.346 | 300 / 51 / 60 → 200 / 34 / 40 |
| 100 | on | off | 1.081 / 2.289 | 0.992 / 2.186 | 100 / 22 / 20 → 100 / 22 / 20 |
| 100 | on | on | 3.910 / 4.656 | 2.094 / 3.299 | 400 / 68 / 80 → 200 / 34 / 40 |
| 500 | off | off | 2.831 / 3.971 | 3.148 / 8.257 | 500 / 17 / 20 → 500 / 17 / 20 |
| 500 | off | on | 12.543 / 13.586 | 9.612 / 13.658 | 1500 / 51 / 60 → 1000 / 34 / 40 |
| 500 | on | off | 4.185 / 9.281 | 4.489 / 5.262 | 500 / 22 / 20 → 500 / 22 / 20 |
| 500 | on | on | 18.890 / 19.921 | 9.177 / 9.754 | 2000 / 68 / 80 → 1000 / 34 / 40 |

Question-body render counts equal the question-wrapper counts above. Native
collapsed tool children remained unrendered (`toolRenders=0`): their group
summaries are painted instead. Other per-frame counts, identical for both sizes:

| Pin | Reminder | Metadata reads before → after | Prompt reads before → after | Reminder renders before → after |
| :---: | :---: | ---: | ---: | ---: |
| off | off | 0 → 0 | 0 → 0 | 0 → 0 |
| off | on | 2 → 2 | 0 → 0 | 4 → 4 |
| on | off | 0 → 0 | 2 → 2 | 0 → 0 |
| on | on | 3 → 3 | 7 → 5 | 9 → 9 |

Reminder-only history rendering decreased from three full passes to **two**;
pin+reminder decreased from four to **two**. One full native paint remains,
plus a shared predicate measurement; no native painting was served cached
predicate rows. Pin-only retains its bounded five-card suffix measurement and
one full native paint. Neither-enabled controls remain one full paint.

These counts support reduced duplicate rendering in this specific synthetic
workload. Timings **did not uniformly decrease**: neither-enabled controls,
the 500-message pin-only median, and the 500-message reminder-only p95 increased.
Other agents/tests ran concurrently, and the baseline and after run were not
interleaved or isolated. Do not convert this single pair into a confidence
interval, incident attribution, live CPU improvement or input-latency claim.

For completeness, the 21 preserved workload timing rows (same harness/host, no
new operation counters on these original drivers) were:

| Original workload | Before median / p95 ms | After median / p95 ms |
| --- | ---: | ---: |
| 1 direct completion card | 0.004 / 0.134 | 0.005 / 0.166 |
| 17 direct completion cards | 0.050 / 0.059 | 0.050 / 0.058 |
| 500 Unicode, panels+grouping+pin + 17 completion wrappers | 3.912 / 5.156 | 4.230 / 4.610 |
| 10,000-byte fence | 0.420 / 1.157 | 0.425 / 0.503 |
| 100,000-byte fence | 3.216 / 4.172 | 3.095 / 3.575 |
| 100 ASCII, native | 0.051 / 0.099 | 0.048 / 0.525 |
| 100 ASCII, panels | 0.705 / 2.612 | 0.637 / 1.558 |
| 100 ASCII, panels+pin | 0.876 / 1.435 | 1.047 / 4.009 |
| 100 ASCII, panels+grouping+pin | 1.056 / 1.853 | 0.960 / 1.889 |
| 100 Unicode, native | 0.044 / 0.068 | 0.047 / 0.067 |
| 100 Unicode, panels | 0.558 / 1.736 | 0.519 / 1.693 |
| 100 Unicode, panels+pin | 0.817 / 2.033 | 0.807 / 1.552 |
| 100 Unicode, panels+grouping+pin | 0.851 / 1.449 | 0.803 / 0.848 |
| 500 ASCII, native | 0.120 / 0.174 | 0.116 / 0.800 |
| 500 ASCII, panels | 3.306 / 4.935 | 2.865 / 3.702 |
| 500 ASCII, panels+pin | 4.506 / 6.420 | 4.005 / 4.759 |
| 500 ASCII, panels+grouping+pin | 4.247 / 5.113 | 4.000 / 4.907 |
| 500 Unicode, native | 0.120 / 0.321 | 0.131 / 1.239 |
| 500 Unicode, panels | 2.599 / 3.661 | 2.611 / 3.965 |
| 500 Unicode, panels+pin | 4.008 / 4.625 | 3.913 / 5.320 |
| 500 Unicode, panels+grouping+pin | 3.783 / 4.646 | 4.041 / 4.618 |

### Final post-review measurement

After revision-based reentrant invalidation was fixed, a fresh frozen source copy
was measured at `/tmp/pi-dankhole-final-after.DPEo9g` (real path
`/private/tmp/pi-dankhole-final-after.DPEo9g`). Final receipt:
`/tmp/pi-dankhole-final-after.DPEo9g.bench.jsonl`.

The final `styling/transcript-measurement.ts` SHA-256 is
`7c2794b694bbf4c1dc1b253e771dae0259a2d151e8a3f474a7fcfb4ea0bcf19f`.
The other six participating source-file hashes match the historical after
receipt. The harness remains
`394f1cc2b86721707e4308040920a815ae255090fdcb3bdc7a73f023734fd25a`;
no harness change or repair was needed, and the unchanged baseline was not rerun.
Host/executable/version/palette/geometry/warmup/sample metadata remain identical:
pinned Pi/TUI 1.4.0, Node v22.22.2, dark truecolor, 120×40, five warmups/15 samples.

All **29** final workloads completed. All **eight** native-frame output hashes,
viewport heights, follow-end states and terminal-write byte counts match the
baseline. All operation counters also match the historical after run exactly.
Six enabled rows retain `guarded-instance`, the two neither-enabled controls
remain `native-unadapted`, and every counted frame paints once (163 bytes).

| Messages | Pin | Reminder | Baseline median / p95 ms | Final median / p95 ms | Baseline → final assistant / completion / question renders |
| ---: | :---: | :---: | ---: | ---: | --- |
| 100 | off | off | 0.845 / 0.927 | 0.816 / 1.811 | 100 / 17 / 20 → 100 / 17 / 20 |
| 100 | off | on | 3.169 / 4.001 | 1.674 / 2.787 | 300 / 51 / 60 → 200 / 34 / 40 |
| 100 | on | off | 1.081 / 2.289 | 0.936 / 1.815 | 100 / 22 / 20 → 100 / 22 / 20 |
| 100 | on | on | 3.910 / 4.656 | 1.929 / 2.861 | 400 / 68 / 80 → 200 / 34 / 40 |
| 500 | off | off | 2.831 / 3.971 | 2.704 / 3.457 | 500 / 17 / 20 → 500 / 17 / 20 |
| 500 | off | on | 12.543 / 13.586 | 7.212 / 7.748 | 1500 / 51 / 60 → 1000 / 34 / 40 |
| 500 | on | off | 4.185 / 9.281 | 3.998 / 4.579 | 500 / 22 / 20 → 500 / 22 / 20 |
| 500 | on | on | 18.890 / 19.921 | 8.343 / 8.974 | 2000 / 68 / 80 → 1000 / 34 / 40 |

Reminder-only remains **three → two** full history passes; pin+reminder remains
**four → two**, retaining one native paint. Question-body counts equal question
wrapper counts. Metadata/prompt/reminder counts are unchanged from the earlier
count table, and grouped native tool children still have `toolRenders=0`.
Neither-enabled and pin-only history-render counts remain unchanged.

Controls demonstrate timing variability even without operation-count changes:
100-message neither-enabled p95 increased **0.927 → 1.811 ms**, while its median
and the 500-message control median decreased. These runs were not isolated or
interleaved; other agents/tests were active. Final counts establish the scoped
synthetic work reduction, not live process CPU improvement or incident causality.
The reentrant correctness regression belongs to the owner's/reviewer's tests;
this ordinary-frame benchmark verifies that its final source retains output and
normal-frame work bounds, not that it exercises the reentrant case itself.

Exact final snapshot/run commands (allocated directory
`/tmp/pi-dankhole-final-after.DPEo9g`):

```sh
after=$(mktemp -d /tmp/pi-dankhole-final-after.XXXXXX) &&
  cp -R src "$after/src" &&
  ln -s "$PWD/node_modules" "$after/node_modules" &&
  PI_E2E_LIVE=0 PI_PACKAGE_DIR="$PWD/node_modules/@earendil-works/pi-coding-agent" \
  DANKHOLE_BENCH_ROOT="$after" node scripts/bench-interface.mjs > "$after.bench.jsonl"
```

Exact baseline execution after archive creation:

```sh
PI_E2E_LIVE=0 PI_PACKAGE_DIR="$PWD/node_modules/@earendil-works/pi-coding-agent" \
  DANKHOLE_BENCH_ROOT=/tmp/pi-dankhole-before.7EVE0z \
  node scripts/bench-interface.mjs > /tmp/pi-dankhole-before.7EVE0z.bench.jsonl
```

Exact historical pre-review after snapshot/run commands (the allocated directory was
`/tmp/pi-dankhole-after.4OPfbO`):

```sh
after=$(mktemp -d /tmp/pi-dankhole-after.XXXXXX) &&
  cp -R src "$after/src" &&
  ln -s "$PWD/node_modules" "$after/node_modules" &&
  PI_E2E_LIVE=0 PI_PACKAGE_DIR="$PWD/node_modules/@earendil-works/pi-coding-agent" \
  DANKHOLE_BENCH_ROOT="$after" node scripts/bench-interface.mjs > "$after.bench.jsonl"
```

Receipt comparison used Node assertions, not timing thresholds: 30 JSONL rows
per receipt (header + 29 workloads), equal host/executable/version/geometry/sample/
harness metadata, equal workload definitions, eight equal output/geometry
observations, expected six guarded/two native adapters, no increased
history-render counts, and strictly fewer history renders for all four
reminder-enabled rows. Source paths and participating source-file hashes are
expected to differ. Both reminder-enabled sizes assert exactly `2 × messages`
assistant renders, 34 completion-wrapper renders and 40 question-wrapper/body
renders after. Reproduce those checks without rerunning either benchmark:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
const before = read('/tmp/pi-dankhole-before.7EVE0z.bench.jsonl');
const after = read('/tmp/pi-dankhole-final-after.DPEo9g.bench.jsonl');
assert.equal(before.length, 30); assert.equal(after.length, 30);
for (const key of ['host', 'piVersion', 'tuiVersion', 'node', 'executable', 'platform',
  'arch', 'theme', 'colorMode', 'width', 'height', 'warmups', 'samples', 'harnessSha256'])
  assert.deepEqual(after[0][key], before[0][key], key);
const metrics = new Set(['medianMs', 'p95Ms', 'operations', 'screenSha256',
  'viewportHeight', 'followEnd', 'frameAdapter']);
const workload = row => Object.fromEntries(Object.entries(row).filter(([key]) => !metrics.has(key)));
let frames = 0;
for (let i = 1; i < before.length; i++) {
  const b = before[i], a = after[i];
  assert.deepEqual(workload(a), workload(b));
  if (!a.workload) continue;
  frames++;
  for (const key of ['screenSha256', 'viewportHeight', 'followEnd']) assert.deepEqual(a[key], b[key]);
  assert.equal(a.frameAdapter, a.pin || a.reminder ? 'guarded-instance' : 'native-unadapted');
  assert.equal(a.operations.terminalWrites, 1); assert.equal(b.operations.terminalWrites, 1);
  assert.equal(a.operations.terminalBytes, b.operations.terminalBytes);
  for (const key of ['assistantRenders', 'completionRenders', 'questionRenders', 'questionBodyRenders']) {
    assert.ok(a.operations[key] <= b.operations[key]);
    if (a.reminder) assert.ok(a.operations[key] < b.operations[key]);
  }
  if (a.reminder) {
    assert.equal(a.operations.assistantRenders, 2 * a.messages);
    assert.equal(a.operations.completionRenders, 34);
    assert.equal(a.operations.questionRenders, 40);
    assert.equal(a.operations.questionBodyRenders, 40);
  }
}
assert.equal(frames, 8);
console.log('Matched 29 workloads; all 8 native-frame comparisons passed.');
JS
```

Rendering correctness review and runtime regression validation remain owned by
the lead; this benchmark is not a replacement for those checks.

## Live measurement: user-targeted handoff, not an automatic action

1. The lead first completes integration/review and waits for all active workers
   to finish. The user identifies the exact live session/PID and confirms the
   intended extension source/loading change and reload handoff. This document is
   not that confirmation. Do not inject `-e` beside the configured package, use
   `--no-extensions` as a misleading equivalent workload, change global config,
   or launch another host process against the user's configuration.
2. Capture **before** evidence from that existing session, before loading changes.
   Source identity must be the extension actually loaded by that process, not
   merely the current checkout or a package subsequently changed on disk.
3. After the separately approved loading change, verify actual loaded-source
   identity and repeat the same workload/geometry/history/phase. If a reload or
   session replacement changes those conditions, label the samples unmatched;
   do not manufacture comparability or recreate a busy/hung phase by forcing
   a model request, compaction or cancellation.

Record a content-free receipt for **each** sample:

| Field | Required observation |
| --- | --- |
| Process | PID, parent PID, process start time, executable path/name and Node version; verify not a worker PID or stale/reused PID |
| Host/source | Actual Pi package path/version; actual loaded extension source path/revision or source hashes; load/reload time and whether source identity is verified |
| Geometry | Terminal columns/rows, fullscreen versus regular, follow-end versus manual scroll, approximate history/card counts and expansion state |
| Display | Theme/color mode, panels/grouping, pin setting and whether displayed, pending-question count/reminder presence, show-cost setting |
| Phase | Observed idle/preparation/model/tools/compaction/tree/settlement/unknown; public-idle and last lifecycle observations if already available; time since transition |
| Confounders | Active/queued workers, MCP startup/connection activity, other Pi/Quarterdeck agents and concurrent benchmark/build/test work; no credentials, endpoint headers or transcript content |
| Workload | No-input idle redraw, or a precisely repeated local input/scroll sequence; fixed warmup and sample duration; do not mix these workloads |
| Outcome | Sample receipt path, interruptions/phase changes, CPU observation and uncertainty; no inferred host-internal busy cause |

Record version/source information from already known package metadata and the
approved session's identity. Do not dump environment variables, full command
lines, full configuration, tool arguments, prompts or provider/MCP credentials.
The existing read-only `/agents diagnostics` can record observed extension phase
before sampling, where available; it is not a host-internal cause oracle and
should not be repeatedly invoked during the timed window.

### Bounded macOS process CPU sample

Run only for the user-confirmed target later. This observes one existing process;
it does not send signals, start an inspector, restart/reload Pi or inspect child
command arguments. Replace the PID, use the same 30-second/16-snapshot window
before and after, and stop if the identity or lifecycle phase changes.

```sh
PID=12345 # User-confirmed existing target; never infer a PID from this example.
case "$PID" in ''|*[!0-9]*) printf 'Invalid PID\n' >&2; exit 1;; esac
umask 077
receipt="$(mktemp /tmp/pi-cpu-sample.XXXXXX)"
{
  date -u '+start=%Y-%m-%dT%H:%M:%SZ'
  sample=0
  while [ "$sample" -lt 16 ]; do
    printf 'sample=%s ' "$sample"
    LC_ALL=C ps -p "$PID" -o pid=,ppid=,lstart=,etime=,time=,%cpu=,state=,comm= || break
    sample=$((sample + 1))
    if [ "$sample" -lt 16 ]; then sleep 2; fi
  done
  date -u '+end=%Y-%m-%dT%H:%M:%SZ'
} > "$receipt"
printf 'receipt=%s\n' "$receipt"
```

`comm` records executable identity without full argument/environment disclosure.
Check start time throughout to reject PID reuse. macOS `%cpu` is an OS-maintained
recent-use estimate, not an exact two-second interval measurement; `time` is
cumulative CPU with limited displayed precision. CPU can exceed 100% across
cores. Keep the raw bounded receipts and note short-window/low-usage resolution,
background load and phase changes. These observations can show a matched live
CPU difference, but cannot alone attribute it to an extension function or prove
that every historical incident cause is fixed.

**Current handoff status:** unchanged baseline and final post-review synthetic
after captured; all 29 workloads and eight native-frame comparisons passed. User-approved live before/after CPU
measurement remains pending; no live process inspection or configuration/loading
change was performed.
