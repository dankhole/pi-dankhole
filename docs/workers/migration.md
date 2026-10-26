# Migrating to plain workers

This fork replaces named agent profiles with configuration supplied when a worker starts. The worker's short `description` is its visible goal; its returned ID identifies its conversation.

## Removed systems

- Scripted workflows, saved workflow scripts, workflow cards and inspectors.
- Scheduled launches, schedule persistence and scheduler menus.
- Built-in, project, global and package-provided profiles; profile creation and management.
- Agent mentions, aliases, agent autocomplete and model-assisted mention launching.
- Nested delegation and its ownership/depth controls: only the main agent launches workers.
- Synthetic structured-output capture, schema options and retry prompts.
- Grouped joins, sibling-completion timers and the join-mode setting.

Existing profile files and saved schedules outside this repository are not deleted or executed. Their settings no longer configure workers. Remove stale `defaultJoinMode` and `maxSubagentDepth` settings and stop supplying `allow_nested`. Background results now always use safe-boundary delivery, without waiting for sibling workers. Normal Pi file attachment and autocomplete remain host-owned.

Worktrees and explicit namespaced memory remain available. Removing profiles does not remove either feature.

## Starting a worker

Before:

```js
Agent({
  subagent_type: "general-purpose",
  name: "auth-audit",
  description: "Audit authentication",
  prompt: "Inspect authentication without changing files.",
})
```

Now:

```js
Agent({
  description: "Audit authentication",
  prompt: "Inspect authentication without changing files.",
  model: "provider/model-id",
  thinking: "high",
  instructions: "Report findings and supporting evidence concisely.",
})
```

Omit `model` and `thinking` to inherit them. The example model ID is a placeholder: use a model configured in your Pi installation. There are no profile pins overriding explicit launch choices.

Move useful instructions from old profiles into each worker's briefing or `instructions`. Workers should report further work to the main agent rather than spawn children. Update parent `AGENTS.md` guidance that tells the assistant to select profile names such as `general-purpose`, `planner` or `astra`; describe the model, reasoning level and task directly instead.

Workers inherit the parent's system rules. `instructions` adds to those rules; it does not replace them. `inherit_context` separately controls whether the parent's conversation is included. Tool and extension selection are launch configuration, not an operating-system sandbox; an allowed shell can still write files or run other programs.

## Controlling workers

Open a worker through `/agents` or FleetView. The conversation viewer retains inspection, steering and stopping. Use the returned ID with `get_subagent_result`, `steer_subagent`, or `Agent({resume: id, prompt: "Continue..."})` for model-driven control.

Descriptions do not have to be unique. They are labels, not handles. There is no `@description` command.

A continuation reuses its original configuration and conversation. Start a new worker when different tools, instructions or a different model are needed. Session persistence is not a promise that an arbitrary worker ID can be reopened across process restarts.

## Integrations

Quarterdeck's background-work tracking must continue to receive the worker lifecycle events and the read-only `Symbol.for("pi-subagents:manager").getRecord(id)` lookup. Removing profiles and mentions does not remove that integration.

Cross-extension callers must use the plain-worker spawn contract described in [rpc.md](rpc.md), not a profile type. There is no profile-name compatibility layer.

## Pi Dankhole package layout

Workers now live in `src/workers/`, with their retained suite in `tests/workers/`, documentation here, and the custom-description template in `examples/workers/`. The default export of `src/workers/index.ts` remains the standalone worker registrar; `src/index.ts` composes it with the other package features. Source provenance is recorded in `migration/sources.json`; the original repositories and captured baselines are not runtime dependencies.

The declared combined entrypoint matches extension selectors as `pi-dankhole` (also its path-derived name `src`). Loading `src/workers/index.ts` directly matches as `workers`, not `pi-subagents`. Update explicit `extensions`, `exclude_extensions`, and `ext:` selectors when switching entrypoints. Selecting the combined entrypoint selects its other features too; use the standalone worker path when only workers are needed.

The move does not rename `Agent`, `get_subagent_result`, `steer_subagent`, `/agents`, `subagents.json`, the `subagents:*` event/RPC channels, memory namespaces, or the process-shared registry/context symbols. Child sessions still cannot expose delegation tools or worker RPC, even when they discover the registrar through a different module loader. The suite is validated against Pi 1.4.0 with synthetic responses, not live providers.
