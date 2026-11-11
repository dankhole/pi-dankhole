# Testing

## Default: validate the change, not the whole package

1. Select test files covering the changed behavior **and affected consumers**. Use the map below and search imports/references when a helper is shared. Add a regression test for a behavior fix.
2. Run selected files. A name filter is useful during iteration; run the affected files without that filter before finishing so neighboring cases are covered.
3. For code changes, run `npm run lint` and `npm run typecheck` once on the final state. Documentation-only changes need no test run; check links, commands, and `git diff --check` instead.
4. After a fix, rerun the checks it can affect. Reuse passing checks for unchanged code. Report exact commands, results, and any untested relevant behavior; do not imply a full run happened.

Do **not** automatically follow this with `npm run check`, `npm test`, `npm run test:workers`, or `npm run test:interface` without file selection. Those commands run all tests in their respective scopes. One lead owns any necessary broad validation; delegated workers run their focused checks rather than each repeating the full suite.

## Commands

Run from the checkout root after `npm ci --ignore-scripts` (Node 22.19+).

```sh
# Worker/package tests: Vitest file filters, optionally a test-name filter.
npm run test:workers -- tests/workers/completion-outbox.test.ts
npm run test:workers -- tests/workers/completion-outbox.test.ts -t 'settlement'
npm run test:workers -- tests/package/entrypoint.test.ts

# Interface tests: use Node directly for precise file selection.
node --test tests/interface/questions-ui.test.mjs tests/interface/palette.test.mjs
node --test --test-name-pattern='contrast' tests/interface/questions-ui.test.mjs

# Cheap static checks for code changes.
npm run lint
npm run typecheck
```

Vitest paths are filters: verify the selected files/count in its output. Node options belong **before** file paths. Do not append file paths to `npm run test:interface -- …`: its script already expands `tests/interface/*.test.mjs`, so that does not narrow the run. Do not use `npm test -- …` to select tests across both runners.

Tests normally use fake model responses, fixtures, and temporary directories; no live provider calls are needed. Keep `PI_E2E_LIVE` unset or set to `0` (for example, `PI_E2E_LIVE=0 npm run test:workers -- tests/workers/completion-outbox.test.ts`): truthy values opt some worker suites into real provider calls, including a smoke test with a 600-second allowance. Interface tests use the real Pi loader/components, not just mocks. They find Pi on PATH, or accept `PI_PACKAGE_DIR` pointing to the coding-agent package root. To select the pinned development host explicitly:

```sh
PI_PACKAGE_DIR="$PWD/node_modules/@earendil-works/pi-coding-agent" \
  node --test tests/interface/palette.test.mjs
```

The default installed host and pinned development host are not necessarily identical. Record the host when investigating a host-sensitive failure or comparing timings; don't silently switch hosts to get a passing result.

## Selecting coverage

These are starting points, not an exhaustive dependency graph. All interface paths below are under `tests/interface/`; worker paths are under `tests/workers/`.

| Changed area | Starting test files / affected consumers |
|---|---|
| Question overlay, selection, keyboard/mouse | `questions-ui.test.mjs`; include `questions.test.mjs` for integration or submission changes |
| Question history, evidence, delivery, branch/lifecycle state | `questions.test.mjs`; include `questions-ui.test.mjs` when overlay behavior changes |
| Prose question choices, transcript styling and click targets | `prose-question-choices.test.mjs`, `questions.test.mjs`; include `viewport-performance.test.mjs` and `pinned-prompt.test.mjs` for viewport changes |
| Shared styling/question palettes | `palette.test.mjs`, plus the affected panel/renderer suites (e.g. `questions-ui`, `questions`, `rendering`, `assistant-panels`) |
| Compact tool rows / grouping | `rendering.test.mjs`, `grouping.test.mjs`; include `questions` or `pinned-prompt` when shared transcript projection changes |
| Pinned prompt / transcript visibility | `pinned-prompt.test.mjs`; include `questions.test.mjs` for shared viewport changes |
| Input, status line, timer | `input-bar.test.mjs`, `status-line.test.mjs`, or `timer.test.mjs`; select consumers when shared input geometry changes |
| Conversation, thinking, text panels | `assistant-panels.test.mjs`, `thinking-collapse.test.mjs`, or `text-panels.test.mjs` |
| Keep-awake | `keep-awake.test.mjs`; include `input-bar.test.mjs` for indicator changes |
| Interface settings / registrar | Relevant settings cases in `rendering.test.mjs` and feature suites; `tests/package/entrypoint.test.ts` for combined registration |
| Worker logic / UI helper | Matching worker test file plus its wiring/consumer tests; search the helper name in `tests/workers/` |
| Worker runner, scope, resume, lifecycle | Matching `agent-runner*`, scope, resume, shutdown, completion, or RPC suites; use the relevant synthetic end-to-end test when the behavior crosses a real child-session boundary |
| Package composition | `tests/package/entrypoint.test.ts` and affected feature wiring |
| Migration status script | `tests/package/migration-status.test.ts` |

For example, a question color change does not need worker execution/worktree tests. A shared viewport change does need both question and pinned-prompt consumers. Do not replace meaningful integration coverage with a cheap unrelated unit test.

## When to broaden

Broaden for an explicit user request, release validation, or a concrete cross-cutting risk: host/dependency updates, test-runner configuration, package entrypoint composition, shared lifecycle/scope contracts, or behavior spanning several modules. State why and choose the smallest sufficient broader set. An entire subsystem can be enough; a full package run is not mandatory for every shared helper.

```sh
npm run test:workers    # All worker + package Vitest suites, including synthetic E2E/perf invariants
npm run test:interface  # All interface Node suites
npm test               # Both, sequentially
npm run check          # Lint + typecheck + both test runners
```

`npm run build` emits JavaScript/declarations using the same TypeScript project; use it when emitted artifacts/build behavior matter, not as an automatic second typecheck. `npm run migration:status` checks sibling-source drift, not runtime correctness. `npm run bench:workers` is a separate benchmark, not part of `check`.

## Assessing full-suite performance

The [recorded suite assessment](testing-performance.md) measured all check phases at about 88 seconds, with worker tests dominating; the reported twelve minutes was not reproduced. It includes environment details, caveats, and optimization candidates.

Time each phase separately before changing coverage or concurrency. Use one full run, not parallel full runs that distort timings through CPU/memory contention:

```sh
/usr/bin/time -p npm run lint
/usr/bin/time -p npm run typecheck
PI_E2E_LIVE=0 /usr/bin/time -p npm run test:workers
/usr/bin/time -p npm run test:interface
```

Record Node/Pi versions, host path, machine/concurrent load, test/file counts, failures, and wall times. Vitest reports transform/import/setup/test timings; Node's TAP reporter reports per-test durations. Add a JSON/JUnit reporter when machine-readable per-file timing is needed. File durations from concurrent workers overlap: summing them is **not** suite wall time.

Distinguish slow assertions from host imports/transpilation, repeated extension loading, fixture setup, process startup, fixed waits, and teardown/open handles. Preserve isolation and real scope/lifecycle tests when optimizing; do not simply drop slow tests or increase timeouts. Reproduce a bottleneck with a selected test before a structural test-harness rewrite.
