# Combining the personal extensions

This guide covers the ongoing migration from the two local projects into Pi Dankhole. It does not authorize installation changes.

## Snapshot, not a live link

The worker and interface implementations were copied from their working trees, including uncommitted changes. The originals remain the source of any work still happening there. Pi Dankhole does not import code from sibling repositories and does not share their dependency directories.

`migration/sources.json` records source locations, capture times, Git HEADs and per-file SHA-256 hashes. The hashes describe the actual captured bytes; HEAD alone does not. Ignored `.migration/pi-subagents/` and `.migration/compact-tools/` preserve those bytes locally. Keep them until reconciliation is finished.

Check for later work:

```sh
npm run migration:status
```

For a changed file, compare the original against its `.migration/` baseline, then apply the meaningful change to the migrated destination. Do not copy an entire original file over a reorganized one: that would undo import-path changes and integration fixes. Do not reset fingerprints to silence drift before integrating it.

## Latest interface reconciliation

`migration/interface-sync.json` records the latest explicitly reconciled `compact-tools` source and destination hashes, including unchanged files. It is a synchronization receipt, not a replacement for the immutable initial snapshot. Source/destination bytes differ where imports, test-loader paths, formatting or combined-package documentation were adapted. Later edits can invalidate either hash; recheck both before relying on the receipt.

The reconciled interface includes `resolve_question` alongside `ask_user`, current question history/evidence handling, the shared conversation/tool palette, configurable compaction countdown, whole-dollar status costs, pinned-input fixes and keep-awake updates. The combined package loader tests verify both question tools alongside worker controls and preserve the child-session delegation boundary.

`migration:status` continues to compare originals against the **initial** snapshot, not this receipt. Reported drift therefore includes changes already integrated here; do not erase that history to make the output clean. Installation changes require explicit approval; the local replacement below was approved separately.

## File mapping

| Original | Destination |
|---|---|
| `pi-subagents/src/**` | `src/workers/**` |
| `pi-subagents/test/**` | `tests/workers/**` |
| Worker README and guides | `docs/workers/**` |
| Worker description example | `examples/workers/**` |
| `compact-tools/index.ts` | `src/styling/index.ts` |
| `compact-tools/questions.ts`, `question-ui.ts`, `question-palette.ts` | `src/questions/**` |
| `compact-tools/keep-awake.ts` | `src/session/keep-awake.ts` |
| `compact-tools/settings.ts` | `src/settings/interface.ts` |
| Other interface TypeScript files | `src/styling/**` |
| `compact-tools/tests/**` | `tests/interface/**` |
| `compact-tools/vendor/**` | `vendor/**` |

Only `src/index.ts` is exposed in the Pi manifest. Internal feature registrars are not separate package extensions. Worker and interface tests remain separate; package tests verify combined registration and reconciliation behavior.

## Preserve behavior first

Keep existing settings, commands, question-session entries and event names. In particular, retain `compact-tools:question` history, `subagents:*` events and `Symbol.for("pi-subagents:manager")`. Renaming the package does not require migrating these contracts.

The old package allowed Pi 1.1; the combined package is developed against the installed Pi 1.4 host used by the styling code. Validate actual host APIs rather than downgrading styling to older types.

## Local installation

After reconciliation, checks and explicit user approval, the global `pi-subagents` package entry was replaced with `/Users/d.cole/Desktop/Projects/pi-dankhole` and the `~/.pi/agent/extensions/compact-tools` symlink removed. Both original source repositories and existing feature settings remain intact. New sessions use the combined registration; existing sessions were not forcibly reloaded.

Wait for running workers to finish before reloading or restarting Pi. Never load the old and new registrations together. The package loader verifies one set of worker controls plus `ask_user` and `resolve_question`. After reloading, verify existing question history/settings, worker completion/resume, and the UI in that session.
