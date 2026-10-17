# Upgrading to 0.1.13

Upgrade the SDK packages together to **0.1.13**. The workspace has 28 package
manifests, of which 27 are publishable; `testkit` remains private. A push to
`main` triggers guarded publication, while manual Release dispatch defaults to
a dry run. Local checks do not prove npm publication or hosted CI success.

The [0.1.13 changelog](../CHANGELOG.md#0113---2026-10-17) is authoritative. This
guide covers what a host must check.

## Run-stopping limits are opt-in

A run no longer stops part-way through because of a default count, loop or
wall-clock limit. Every limit below now applies only when you set a number.

| Setting | Old default | 0.1.13 default |
| --- | --- | --- |
| `maxTurns` / `maxSteps` | 16 | `'auto'` (no ceiling) |
| `maxToolCalls` | 64 | `'auto'` |
| Run ledger `maxModelCalls`, `maxAttemptsPerCall`, `maxToolCalls`, `maxSerializedBytes` | 1,024 / 16 / 10,000 / 16 MiB | unlimited |
| `repeatToolLimit`, `toolCycleLimit`, `maxConsecutiveToolErrors` | 6 / 3 / 8 | `'auto'` (warn only) |
| `maxModelStreamEvents` | 100,000 | unlimited (response bytes still bound memory) |

To keep a ceiling, set it explicitly:

```ts
const session = agent.createSession({
  registry,
  runtimeLimits: { repeatToolLimit: 6, maxConsecutiveToolErrors: 5, modelTimeoutMs: 600_000 },
  ledgerLimits: { maxModelCalls: 1_024 },
})
const bounded = agent.with({ maxTurns: 16, maxToolCalls: 64 })
```

Loop guards still steer the model. The repeat and cycle reminders now fire at
every multiple of `repeatToolWarningAt` (default 3) and `toolCycleWarningAt`
(default 2). The new `consecutiveToolErrorWarningAt` (default 4) tells the model
to change approach after repeated tool failures. Code that relied on a
`budget-exhausted` outcome with `budget: 'repeated-tool-call'`,
`'tool-call-cycle'`, `'consecutive-tool-errors'`, `'tool-calls'` or `'steps'`
only sees it when the matching limit is set.

## No default deadline on agent work

These have no default deadline now. Set the option to restore one.

| Option | Old default |
| --- | --- |
| `runtimeLimits.modelTimeoutMs` (total model call) | 10 minutes |
| `runtimeLimits.maxToolDurationMs`, `runToolCalls` step, `dispatchToolCall` `defaultTimeoutMs` | 10 minutes |
| `runtimeLimits.hookTimeoutMs` | 10 minutes |
| `runtimeLimits.userInputTimeoutMs` (`request_user_input`) | 10 minutes |
| Managed `workerTimeoutMs`, `spawnTimeoutMs`; collaboration `joinTimeoutMs` | 10 minutes / 30 s / worker timeout |
| Team `operationTimeoutMs`, `waitTimeoutMs` (`wait_agents`, `awaitWorker`) | 10 minutes / 120 s |
| HTTP transport `requestTimeoutMs` | 10 minutes |
| Compaction `summaryTimeoutMs`; skill `operationTimeoutMs`; memory callbacks | 10 minutes / 120 s / 30 s |
| MCP client `toolCallTimeoutMs`, `operationTimeoutMs` (including HTTP/SSE) | 120 s |
| MCP server `operationTimeoutMs`; A2A client `timeoutMs`; A2A server `taskTimeoutMs` | 10 minutes / 120 s / 10 minutes |
| Decision adapter `timeoutMs`; OpenAI and TypeSafe decision `requestTimeoutMs` | 30 s |

Where a library requires a number, the default is the timer maximum,
2,147,483,647 ms. An opt-in deadline above that is rejected (a tool `timeoutMs`
is clamped), because timers would otherwise fire it after 1 ms.

Hung connections are still caught. The new `runtimeLimits.modelIdleTimeoutMs`
(default 10 minutes) resets on every stream chunk and only cuts a model stream
that has gone silent. HTTP providers keep `streamIdleTimeoutMs`. Teardown,
dispose, close, observer and credential/catalog setup bounds are unchanged.

A wait with no deadline still ends: `wait_agents` returns when its targets
settle, when new input steers the caller (`interrupted: true`), or when the run
is cancelled. A model-requested `timeout_ms` keeps its 10-second floor
(`DEFAULT_MIN_WAIT_TIMEOUT_MS`).

## Removed exports and options

- `holdWaitMs` (ignored since event-driven coordination) is removed from
  `ManagedAgentTeamOptions`. Delete it from host code.
- `DEFAULT_HOLD_WAIT_MS` and `DEFAULT_WAIT_TIMEOUT_MS` are no longer exported.
- `AgentTeam.recordTimeline` and `observeSession` are removed. Use
  `onEvent`/`subscribe` and `snapshot()`.

## Managed teams

The [multi-agent guide](multi-agent.md#migrate-from-0112) has the full table.
In short:

- The default model surface is lean: `spawn_agent`, `spawn_agents`,
  `send_input`, `wait_agents`, `close_agent` and paged `get_agent_result`.
  Set `modelToolSurface: 'legacy'` for the earlier tool names and schemas.
- Lead catalogs reserve `spawn_agents` and `progress_updates`. Rename host
  tools with those names, or set `progressUpdates: false`.
- Guidance defaults to proactive delegation and generated workers inherit
  eligible lead tools. Use `delegationMode: 'explicit'` and
  `inheritLeadTools: false` to opt out.
- Finished workers release their slots automatically. Lean `close_agent`
  cancels unfinished work unless model cancellation is disabled.
- Managed `run()` joins through synthesis. When the lead keeps yielding
  without new worker reports, the run now returns the lead's latest answer and
  records the `synthesis` budget as exhausted, instead of failing.
- Aborted `spawn_agents` calls return worker addresses with `cancelled: true`.
- `stopProgressUpdates(reason)` accepts only `host` (default), `run-ended` or
  `aborted`.
- New options: `AgentTeamOptions.mailboxOverflow` (`'reject'` default;
  managed control planes default to `'evict-oldest'`) and
  `ManagedAgentTeamOptions.maxRetainedWorkers` (default 256).

## Event and hook additions

- `AgentTeamEvent` adds `team-timeline` and `team-progress`;
  `RuntimeAgentTeamEvent` adds `team-progress`. Exhaustive switches must handle
  them or keep a default case.
- `onTurnEnd` may return `{ kind: 'yield' }`; `lastOutcome().yielded` reports it.
- `member-run-end` and `member-run-error` carry the member `response`;
  `AgentMemberOutcome` adds `status` and `structured`.

## Workspace JSON writes

The chat sample and agentcode workspace tools reject invalid `.json` content
before writing. Set `validateJsonWrites: false` to opt out, or use the core
`validateJsonFileContent` hook in custom tools. See
[workspace JSON writes](workspace-json-writes.md).

## Checklist

1. Upgrade every `@alvin0/ai-agent-sdk-*` package to 0.1.13 together.
2. Decide which limits and deadlines your deployment needs, and set them.
3. Remove `holdWaitMs` and the removed constants.
4. Handle `team-timeline` / `team-progress` in exhaustive event switches.
5. Rename host tools named `spawn_agents` or `progress_updates`.
6. Run your test suite; outcomes that relied on default limits change.
