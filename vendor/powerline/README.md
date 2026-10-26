# Compact pi-powerline adaptation

Upstream: https://github.com/jwu/pi-powerline
Pinned commit: `51fc7d3d3893d380267e66b4d48e8b682c14ab83`
License: MIT, copyright (c) 2026 jwu; the original notice is in LICENSE.

`footer-helpers.ts` adapts the token formatting, reasoning labels/colors, and
font detection from `extensions/footer.ts` and `extensions/utils.ts`.
`../../src/styling/status-line.ts` adapts the upstream branch/context/stats/right-hand
reasoning layout through Pi's public `setFooter` API. `../../src/styling/input-bar.ts` is
an original native `CustomEditor` border composition inspired by the upstream
model/folder breadcrumb screenshot; no upstream editor code is copied.

We intentionally do not load upstream's package entry point: it unconditionally
registers editor, header, widget, flags, commands, and settings writers. Even its
footer registration depends on those settings/events and module-global state.
Keeping this small attributed adaptation isolates the requested input/footer
composition without importing the unrelated UI.

Differences:
- Move the selected model and cwd basename into the input's top border, without
  duplicating them in the footer or adding a separate cwd row.
- Use active Pi theme colors in the footer and appearance-aware pink/teal/blue
  colors in the input border, via Pi's supported color conversion API.
- Follow native cumulative accounting for all session usage sources, including
  errored/aborted billed requests; never extrapolate context after compaction.
- Keep exactly one footer row. Show all fields when they fit; at narrow widths,
  prefer the minute timer and published extension statuses over secondary counters,
  then truncate or omit lower-priority fields without wrapping.
- Native MCP tools are labeled `MCP N registered`, never connected/healthy.
  No MCP config or credentials are read; published extension statuses stay intact.
- Respect `PI_NERD_FONTS=0`; `TERM=dumb` or `NO_COLOR` gives ASCII/uncolored
  output. Terminal guessing is only a heuristic; force the override if necessary.
- Use a native `CustomEditor` subclass that changes only its top border. Native
  completion, history, keybindings, image paste, and editing remain untouched;
  working and overflow indicators stay in the same input frame.
- No settings writes, subprocesses, header changes, or progress widget.
- Do not guess an "(auto)" compaction flag: the public extension context does not
  expose the runtime setting (including SDK overrides and live /settings changes).
