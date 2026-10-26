# Pi Dankhole

Personal, non-DraftKings Pi extension package. Read `README.md` and the guide for the feature you change.

## Boundaries

- `src/workers/`: worker execution, scope, completion delivery, resume and worker UI.
- `src/styling/`: transcript presentation, input/status controls and settings integration.
- `src/questions/`: question state, answering UI and its palette.
- `src/session/`: optional session behavior such as keep-awake.
- `src/settings/interface.ts`: interface preferences and settings command.
- `src/index.ts`: composition only; keep feature behavior in its owning module.
- `tests/`: feature-specific suites plus package integration coverage.
- `migration/sources.json`: fingerprints of the imported source snapshots.
- `.migration/`: local, unmodified import baselines; do not edit or package them.

The originals in `../compact-tools` and `../pi-subagents` are not owned by this migration. The user is actively editing styling in `../compact-tools`. Never write to either original or overwrite concurrent changes. Reconcile later source changes explicitly; don't silently resnapshot over migrated edits.

## Development

- Read full files before broad edits. Use installed Pi API declarations/examples rather than inventing APIs.
- Keep top-level imports, sound types, and no unnecessary `any` or compatibility shims.
- Preserve feature behavior during moves. Do not remove additional functionality without approval.
- Preserve worktrees, worker scope/trust enforcement, usage, resume, safe-boundary notifications, and Quarterdeck lifecycle/registry contracts.
- Keep questions separate from worker orchestration. The question UI is not an authorization gate.
- Preserve existing `subagents.json` and `compact-tools.json` settings and command names for this initial migration.
- Keep upstream notices, licenses and vendored provenance.
- Default to targeted validation, not `npm run check`, `npm test`, or entire feature suites. Read [testing guidance](docs/testing.md), select the files covering changed behavior and affected consumers, and run only those tests. For code changes, also run lint and typecheck; documentation-only changes need no test run.
- Broaden testing only for a concrete cross-cutting risk (such as host dependency, runner, shared lifecycle, or package-registration changes), an explicit full-suite request, or release validation. Explain the scope. A lead owns any broad run; workers run focused tests, not duplicate full suites. Reuse passing results for unchanged code, rerun affected checks after fixes, and report exact commands, outcomes, and omitted coverage. No live provider calls are required.
- Do not change installed extension configuration or symlinks until the user approves switching.
- Do not commit, stage, switch branches, push, publish, or initialize a Git repository unless requested.
