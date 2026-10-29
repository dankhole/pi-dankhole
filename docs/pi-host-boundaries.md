# Pi 1.4.0 host boundaries

This is a local investigation note, not a published upstream report or an
installed-host patch. Default and development hosts inspected for this work are
both Pi 1.4.0; their relevant session/layout files match. Historical incident CPU
and the cause of the stuck-busy session have not been reproduced here.

## Spinner rendering

`@earendil-works/pi-tui/dist/components/loader.js` uses an 80 ms default animation
interval and requests a render on each tick. The main-screen renderer evaluates
component rows before terminal diffing; fullscreen `TuiAltScreen.doRender()` calls
`renderLayoutFrame()`. Therefore an animation tick can cause whole-layout work;
it does **not** necessarily write the entire screen to the terminal.

The public extension UI API offers `setWorkingIndicator()` with custom frames and
`intervalMs`, plus `setWorkingVisible()`. A static frame or slower cadence can
reduce work caused by the **main working indicator**. This is not a generic
spinner setting: compaction, retry and branch-summary indicators instantiate
separate loaders. This change does not silently change animation preferences.

Pi currently exposes no public before/after-frame transaction or retained
transcript-layout contract. Pi Dankhole's supported-host adapters can share fresh
visibility calculations within one synchronous render, but cannot safely treat
width, transcript length or object identity as cross-frame content versions.
Native painting must also update mouse-layout state at the actual paint width.

An upstream API could expose a frame-scoped layout snapshot with displayed-child
positions, content revision and viewport geometry, plus explicit invalidation.
It must cover streaming, expansion, themes, resize, images, search and multiple
layout evaluations in one render. Terminal output diffing alone does not solve
layout CPU.

## Compaction, tree summaries and busy state

Sources: `@earendil-works/pi-coding-agent/dist/core/agent-session.js`,
`dist/core/compaction/compaction.js`, and `dist/core/extensions/types.d.ts`.

- Public `isIdle` includes preparation and summary controllers, not merely the
  model's streaming signal. The low-level agent signal is not an operation-wide
  preparation/summary signal.
- Summarization awaits its provider stream and retry handling without a universal
  operation-wide deadline. Individual provider timeouts are not such a deadline.
- Successful `session_compact`/`session_tree` hooks run before final busy cleanup.
  A later awaited hook can hold cleanup after this extension's hook returns.
- `session_before_tree` exposes an operation signal. Some cancelled/failed tree
  paths have no matching terminal extension event.
- Public `ctx.abort()` requests cancellation of parent work, including summaries;
  it is not proof cleanup completed. Hooks can ignore signals or await forever.

An extension cannot safely turn these observations into a universal timeout by
racing a promise and declaring the host idle. The underlying operation can still
be running. Pi Dankhole uses bounded public-idle observation and explicit recovery,
retains results on expiry, and reports observed lifecycle phases without naming
an unproven internal cause. No unattended auto-abort or forced-idle patch is made.

Useful upstream contracts would be a paired post-finalizer summary outcome event
(including cancelled/failed paths), operation-wide cancellation observability,
and an optional cooperative summary deadline whose expiry aborts real work while
preserving honest busy/cleanup state. Tests should hold provider streams and
extension hooks independently; timeout, cancellation request and final settlement
must remain distinct states.

## Child MCP startup

Pi Dankhole constructs fresh built-in MCP extensions in `agent-runner.ts`.
Binding each child emits `session_start`; Pi's MCP extension connects every
enabled configured/registered server before the runner's call-time scope gates
are installed. Tool exposure and `startupWaitMs` do not make those connections
lazy.

The existing `exclude_extensions: ["builtin:mcp"]` can disable this startup
explicitly. The opt-in `mcp_startup: "skip-unreachable"` policy avoids built-in
MCP startup only when the explicit extension-tool allowlist makes that owner
unreachable; default inheritance stays unchanged. A built-in-only tool list such
as `["read"]` does not restrict extension tools and is not sufficient evidence.

Pi 1.4's public MCP factory options do not filter the merged initial and late
registered server set. Its default config loader is not a public root export.
Replacing config loading would duplicate trust, overrides and authentication;
sharing a transport would also require client request-ID, initialization, roots,
cancellation and lifetime isolation. Neither is implemented here.

A future host filter should apply before initial and late connection creation,
default to existing behavior, and preserve the normal config/trust/auth pipeline.
A shared-client API would need explicit session-scoped leases and isolation, not
just a process-global transport cache.

## Runtime handoff

The user explicitly declined Pi-core changes. No new core checkout, installed
package edit, configuration switch or session reload is part of this work.
See [the measurement protocol](pi-live-measurement.md) before claiming live CPU
improvement or loading this separate extension worktree into a real session.
