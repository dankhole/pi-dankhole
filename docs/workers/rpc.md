# Driving workers from another extension

The extension exposes in-process request/reply channels on `pi.events`, lifecycle events, and a small manager registry. These are not network RPCs: callbacks and abort signals work only inside the same JavaScript process.

## Protocol and availability

`subagents:rpc:ping` replies with `{success: true, data: {version: 3}}`. Version 3 removes profile dispatch and uses flat launch fields. There is no v2 profile-spawn compatibility layer.

Wait for `subagents:ready` before sending requests. It is emitted when handlers are bound at `session_start`, not when the extension factory executes. A session excluding this extension must neither advertise the service nor answer its channels. Handlers are removed on shutdown.

Every request needs a unique `requestId`. Replies arrive on `<channel>:reply:<requestId>`:

```ts
{ success: true, data?: T }
{ success: false, error: string }
```

Subscribe before emitting, unsubscribe after the reply, and give availability and replies a timeout. A successful operation with no return value omits `data`.

## Spawn

The payload uses the same flat launch field names as the `Agent` tool, plus optional `cwd`:

```ts
const requestId = crypto.randomUUID();
const channel = "subagents:rpc:spawn";
const unsubscribe = pi.events.on(`${channel}:reply:${requestId}`, reply => {
  unsubscribe();
  if (reply.success) {
    const id = reply.data.id;
    // Track this ID through lifecycle events.
  }
});
pi.events.emit(channel, {
  requestId,
  description: "Audit authentication",
  prompt: "Inspect authentication without changing files.",
  thinking: "high",
  instructions: "Return findings with supporting evidence.",
  run_in_background: true,
});
```

There is no `type`, `subagent_type`, `name`, or nested `options` payload. `prompt` and `description` must be non-empty strings. Configuration is normalized by `resolveAgentInvocationConfig`; explicit model selection is resolved and scope-checked before execution. See the [Agent parameter table](README.md#agent) for launch fields.

The reply is `{id}` after startup succeeds. RPC calls themselves return asynchronously through the bus; use `run_in_background: true` to charge launches to the background pool. `cwd`, if supplied, must identify an existing absolute directory. It changes tool execution location, not project trust or the parent's configuration root.

RPC also accepts `mcp_startup: "inherit" | "skip-unreachable"` through the same launch resolver. The opt-in policy skips only unreachable `builtin:mcp` startup under an explicit extension-tool allowlist, including that built-in's resources and command; it does not share server connections or change trust/tool permissions. Defaults and resume retention match the Agent tool.

Public RPC payloads cannot supply root-session identity, a file to replay as a conversation, internal queue flags or execution callbacks. These are controlled by the dispatcher, not callers. Use the normal tool's `resume` path for continuations.

An RPC spawn is not guaranteed to emit `subagents:created`: use the returned ID and `subagents:started` to track it. Completion arrives through `subagents:completed` or `subagents:failed`.

## Steer, stop and consume

```ts
pi.events.emit("subagents:rpc:steer", {
  requestId: crypto.randomUUID(), agentId: id,
  message: "Also inspect password resets.",
});
pi.events.emit("subagents:rpc:stop", {
  requestId: crypto.randomUUID(), agentId: id,
});
pi.events.emit("subagents:rpc:consume", {
  requestId: crypto.randomUUID(), agentId: id,
});
```

These operations use stable IDs, never goal labels or handles. All workers are managed by the main agent; worker sessions cannot launch or control other workers. Steering requires a non-empty message; accepted startup-time messages wait until the session exists. Stopping a settled worker reports that it is no longer running. Consuming requires a settled result.

Consume means the caller has already handled the result and does not need an additional parent completion notification. To prevent scheduling that notification, consume synchronously inside the completion handler. If it is already queued in the completion outbox, consumption can cancel it before delivery. Once handed to Pi, it cannot be recalled; send acceptance is not proof of transcript delivery. New completions retain captured run identities and unconfirmed delivery state. After restart, RPC consumption can acknowledge captured terminal results even when no live manager record exists. This suppresses additional notification attempts but does not restore execution or promise that an earlier accepted send cannot arrive. See [completion recovery](README.md#completion-recovery).

## Lifecycle and accounting

The [README event table](README.md#integrations) lists the retained events. Created, started, completed, failed, steered and compacted events describe managed workers. `subagents:usage` is the per-message ledger; sum that ledger rather than repeatedly adding cumulative worker totals. There is no nesting depth or parent-worker identity.

Worker identity is `id` plus human-facing `description`; there is no profile type. Terminal events retain status, result/error information, duration and usage. Non-normal results may contain partial output and must not be treated as successful completion.

`subagents:disposed` is emitted after child shutdown. No further worker usage should follow it. Event dispatch does not await listeners: shutdown-time flushing must finish synchronously rather than rely on work after an `await`.

## Manager registry

`globalThis[Symbol.for("pi-subagents:manager")]` provides:

| Member | Purpose |
|---|---|
| `getRecord(id)` | Read a managed worker record |
| `hasRunning()` | Whether managed work is still active |
| `waitForAll()` | Shutdown barrier for all managed workers |
| `spawn(pi, ctx, prompt, options)` | Internal-style generic spawn; no profile-type argument |

The first activation owns the slot. A child activation must not replace it or delete it on shutdown. Only the owning activation releases it. The registry does not add authority to forge internal session identity or resume fields. Synthetic structured-output options are no longer supported; workers return normal assistant text.

**Quarterdeck depends on** `getRecord(id)` and the `subagents:created`, `subagents:started`, `subagents:completed` and `subagents:failed` events. Preserve these even if the request/reply implementation changes.

Prefer the versioned bus for programmatic control. The registry is useful for read-only lookup and headless shutdown coordination; it has no reply envelope.

## Validation

The retained tests cover RPC envelopes and scope, lifecycle gating, result consumption, registry ownership, and background completion delivery. Spawn and scope failures should reach callers as error envelopes, not as successful workers whose result merely contains an error message.
