# Pi Dankhole

Personal Pi customizations in one package, with separate feature modules.

**Configured as the single personal extension package.** The global `pi-subagents` package entry has been replaced with this path and the `compact-tools` autoload symlink removed; both original source directories remain intact. New sessions use this package. Existing sessions need `/reload` after active workers finish. Never load the old extensions alongside it: duplicate tool registrations, UI adapters and lifecycle handlers would compete.

## Modules

| Path | Responsibility |
|---|---|
| `src/index.ts` | Sole Pi entrypoint; composes workers then interface features |
| `src/workers/` | Plain worker execution, scope, completion delivery, resume, usage and worker UI |
| `src/questions/` | Persistent questions, answer UI and its accessibility palette |
| `src/styling/` | Compact tool rows, grouping, transcript panels, pinned prompt, input/status presentation |
| `src/session/` | Request-local prompt guidance and optional macOS keep-awake |
| `src/settings/interface.ts` | Existing interface settings and settings command |
| `vendor/` | Attributed third-party helpers and licenses |

Feature modules retain their own state and shutdown cleanup. Questions are not part of worker orchestration. Settings files remain separate; the interface settings command is now `/dankhole`.

- Worker settings: `~/.pi/agent/subagents.json`, with project overrides in `.pi/subagents.json`.
- Interface settings: `~/.pi/agent/compact-tools.json`.
- Commands: `/agents`, `/dankhole`, `/latest-input`, `/q`, and `/questions`.
- Quarterdeck's existing worker events and manager-registry lookup remain unchanged.
- Worktrees and namespaced memory remain supported; profiles, nesting, scheduling, workflows and grouped completion strategies stay removed.

See [workers](docs/workers/README.md), [worker RPC](docs/workers/rpc.md), [interface and questions](docs/interface.md), and [migration/reconciliation](docs/migration.md).

## Prompt guidance

The combined extension removes Pi's exact default **“Be concise in your responses”** rule from outgoing model requests. The global `AGENTS.md` Communication section defines useful concision instead: enough plain-English context to understand and act, without unnecessary process detail.

This request-local hook preserves dynamic tool guidance, documentation, project instructions, skills, and saved transcripts. It does not install `SYSTEM.md` or replace the full prompt. Explicit custom/forced prompts, current rules overrides, and explicit contributed brevity guidance are left alone. Historical rules sections have no provenance: after resume, an unobserved override using the identical default wrapper and bullet cannot be distinguished from Pi's default. Only that exact bullet in a structured rules section is eligible; prose and other sections are untouched.

## Development

Requires Node.js 22.19+; this package is tested against Pi **1.4.0**. Pi supplies host modules at runtime; local development uses pinned host dependencies.

```sh
npm ci --ignore-scripts
npm run lint
npm run typecheck
# Run the test files covering your change; examples and selection map:
# docs/testing.md
```

**Use targeted tests for normal changes.** See [testing guidance](docs/testing.md) for exact commands, affected-consumer coverage, and when to broaden validation. Documentation-only edits need no test run. `npm run build` emits distributable files; it is not an additional routine test gate. `npm run migration:status` is only relevant to source reconciliation.

`npm run check` remains the explicit full check: lint, typecheck, all worker/package Vitest suites, then all interface Node suites. Reserve it for cross-cutting changes, release validation, or an explicit full-suite request; do not automatically run it after focused tests. Tests use synthetic model responses or UI fixtures, not live provider calls. Interface tests use the Pi installation on PATH unless `PI_PACKAGE_DIR` points at another Pi package root.

Performance changes and their validation are described in [extension performance](docs/performance.md). `npm run bench:interface` runs repeatable synthetic panel/pinning and text-transform CPU benchmarks; it does not measure end-to-end input latency.

`migration:status` is read-only: it reports changes in the original projects since capture, including new files in the imported source areas. Use `npm run migration:status -- --check` to exit nonzero when reconciliation is needed. It never overwrites your styling work or the migrated code. It reports source drift, not merge status: changes deliberately applied to both copies will still appear until their baseline is explicitly reconciled.

The latest completed interface reconciliation is recorded in [`migration/interface-sync.json`](migration/interface-sync.json), with source-to-destination paths and SHA-256 hashes for all imported interface files. It includes the question resolver, palette/panel updates, compaction countdown settings, and keep-awake changes. The original baseline is preserved, so `migration:status` still reports historical source drift.

## Provenance

The initial import includes the originals' uncommitted work, not just their Git HEADs. Exact source fingerprints are in `migration/sources.json`; local immutable baseline copies are in ignored `.migration/` for later comparison. Neither original repository was moved or modified.

This is a private personal package. Upstream notices are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), `licenses/`, and `vendor/`.
