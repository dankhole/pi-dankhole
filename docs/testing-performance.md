# Full-suite performance assessment

## Result

One complete lint/typecheck/worker/interface run against runtime/test code at `d71effe` passed in **87.69 seconds**. The reported twelve-minute full-suite duration was **not reproduced**. The screenshot shows overall agent activity and a broad check command, but does not establish twelve minutes of test-runner wall time. Repeated full runs and surrounding agent work must be distinguished from a single suite run.

| Phase | External wall time | Result |
|---|---:|---|
| Lint | 1.42s | 142 files, passed |
| Typecheck | 7.18s | Passed |
| Worker + package Vitest | 72.94s | 84 files; 1,275 passed, 4 skipped |
| Interface Node tests | 6.15s | 13 files; 298 passed |
| **Total** | **87.69s** | **1,573 passed; 4 opt-in live tests skipped** |

Environment: Apple M3 Pro, 12 logical CPUs, 36 GiB RAM, macOS arm64, Node 22.22.2, Vitest 4.1.11, Pi 1.4.0. Interface host: `/Users/d.cole/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent`. Dependencies were freshly installed with `npm ci --ignore-scripts` (about six seconds, excluded). `PI_E2E_LIVE` was unset. This is a single-run observation, not a stable performance budget or a cold/warm comparison.

Each phase was timed with `/usr/bin/time -p`. The worker command added `--reporter=default --reporter=json --outputFile.json=… --cache=false`; the interface command used `node --test` with TAP and JUnit reporters over the same glob as `test:interface`. Thus this covers all `check` phases, but is not a byte-for-byte measurement of the unmodified `npm run check` command. No worker concurrency settings were changed. A deprecated `--cache.dir` attempt failed during argument parsing before any tests ran; the corrected invocation ran the suite once. One separate focused worker run overlapped for about eleven seconds, so contention may have inflated the baseline. No benchmark or live-provider calls were run.

Raw evidence from this session is in `/tmp/pi-dankhole-audit-fdcRmX/`: `commands.txt`, `exits.tsv`, phase stdout/stderr logs, `workers.json`, and `interface.junit.xml`. These are temporary local artifacts, not committed fixtures. For reproduction, see [timing commands](testing.md#assessing-full-suite-performance).

## Where the time goes

**Workers dominate (~83% of wall time), not interface rendering.** Vitest reported 72.06s wall, with aggregate transform 157.93s, import 619.47s, and test execution 133.12s. Those aggregate durations overlap across isolated workers; notably **619s of imports does not mean ten minutes elapsed**.

Slowest worker files by test-execution duration (also overlapping):

| File under `tests/workers/` | Test execution |
|---|---:|
| `agent-runner-e2e.test.ts` | 21.91s |
| `worktree.test.ts` | 18.52s |
| `subagents-print-mode-e2e.test.ts` | 16.21s |

The longest individual worker test was 6.36s. The longest interface test was 2.17s (real compact/expanded palette surfaces). No test failed or timed out.

## Assessment and optimization priorities

1. **Stop redundant broad validation first.** The former repository instruction required focused tests followed by package checks. Targeted checks are now the default; see [testing guidance](testing.md). A question-color edit should not pay for worker execution/worktree tests, and each delegated worker should not independently repeat full checks.
2. **Profile heavy imports before changing runner settings.** `vitest.config.mts` inlines all Pi dependencies. `src/workers/tool-names.ts` imports Pi's barrel and constructs tools to derive built-in names, so even configuration tests inherit a large graph. Wiring tests such as `completion-notification-wiring.test.ts` use `vi.importActual` for the runner despite mocking execution. `documented-defaults.test.ts` explicitly resets modules before every case and allows 60 seconds for runner reimports. Minimal explicit mocks or fewer fresh imports are candidates; retain real integration coverage and the shared `pi-ai` registry/deduplication contract.
3. **Investigate fixture lifetime and deterministic waits.** `agent-runner-e2e.test.ts` and `ext-templates-e2e.test.ts` create real sessions without explicit session disposal in their teardown. Negative MCP checks poll to a fixed limit; `worktree.test.ts` creates/commits real Git fixtures per case. These are concrete cleanup/setup opportunities, but their contribution to suite wall time needs isolated measurement. Do not remove scope/trust/lifecycle or real Git coverage merely because it is slower.
4. **Test bounded concurrency experimentally, not by assumption.** Vitest has no explicit worker cap here. Compare selected import-heavy files at two/four/default workers before changing the default. Do not switch to threads or disable isolation blindly: fixtures mutate cwd, environment, provider registries, and global manager symbols.

No test harness, runtime behavior, coverage, timeout, or concurrency changes were made for this assessment. An ~88-second broad run is still substantial for local iteration, but this evidence does not justify a wholesale suite rewrite. If twelve minutes recurs, capture the exact command, individual phase timings, host, concurrent processes, and whether `PI_E2E_LIVE` was enabled: opt-in live smoke tests include a **600-second allowance**.
