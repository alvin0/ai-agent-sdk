# Managed-team delegation

`createManagedAgentTeam` remains a collection of host hooks. It does not own a filesystem,
process sandbox, credential store, or tool authorization policy.

```ts
const managed = createManagedAgentTeam({
  registry,
  lead,
  delegationMode: 'proactive', // default; use 'explicit' for requested delegation only
  roles: managedAgentRolePresets({ readOnlyTools: ['read_file', 'search_files'] }),
  maxDepth: 1, // default: lead at depth 0, workers at depth 1
  workerSessionOptionsFactory: request => ({
    // Host-owned credentials, approval broker, interceptors, workspace context, etc.
    ...sessionPolicyFor(request),
  }),
})
```

Import `managedAgentRolePresets` and `createManagedAgentTeam` from
`@alvin0/ai-agent-sdk-core/agent`. Role presets are opt-in; existing custom roles remain valid.
`explicit` changes model guidance, not host API availability or tool authorization. The host
must enforce any required approval through its tools and policies.

The lead keeps immediate blockers local, delegates bounded independent work together, assigns
disjoint writes, continues its own work, and synthesizes worker reports. With automatic coordination
enabled it can end its turn when only waiting remains. The coordination hook yields without polling and pushes compact runtime settlements. Managed `run()`
joins workers and synthesis, including lost-wake recovery. `wait_agents` joins all selected workers and returns
only new results; completed workers release their concurrency slots automatically.
With `autoLeadCoordination: false`, guidance instead tells it to wait when blocked, and the host
remains responsible for later turns. Workers focus on their assignment, preserve others' edits,
verify changes, and return concise evidence or a concrete blocker.

## Application tool inheritance and migration

Generated workers inherit the lead definition's and lead session's eligible application tools only
when no explicit worker tools, `workerTemplate`, or `workerFactory` is supplied. Templates/factories
keep only their own definition tools; no lead tools are added. `inheritLeadTools: false` disables
automatic inheritance, including the lead definition's application tools, provider-native tools,
skill sources, and skill ID allowlist. With generated workers, that leaves no application/native tools
or skills unless the host supplies explicit worker grants. Worker session `skills` still work without
the lead's allowlist; use a `workerTemplate` or `workerFactory` to supply native tools and/or a worker
skill allowlist explicitly. Custom templates/factories retain their own native tools and skills.

Use `leadOnlyTools: ['deploy', 'commit']` to exclude host tools from inheritance. Team tools, managed
controls, agent completion/user-input controls, and tools marked `awaitsPerson` are always excluded.
Custom user-input names without that metadata must be listed in `leadOnlyTools`. These exclusions
apply to inheritance; explicit worker tools and custom definitions remain host-owned. Team reporting
tools are created with the worker's own identity, under the existing `workerTeamTools` setting.

Inheritance fails closed at spawn with a host-facing error if the lead has interceptors or an approval
broker and the worker does not explicitly supply the same interceptor array and broker object. The SDK
does not assume a different policy is equivalent or copy session-bound guard closures automatically.
The check uses the final merged worker session options, including per-worker overrides. Either share
those exact objects intentionally, disable inheritance, or supply explicit worker tools/template/factory
with appropriate independent policy. For example:

```ts
const policy = { interceptors, approvals }
const managed = createManagedAgentTeam({
  registry, lead,
  leadSessionOptions: policy,
  workerSessionOptions: policy, // share guards only if suitable across sessions
  leadOnlyTools: ['deploy', 'commit'],
})
```

`workerSessionOptions.tools` replaces this application toolset. A defined factory `tools` value takes
precedence, including an empty array. For the former managed-worker behavior, explicitly pass the
tools you previously placed on the worker definition as well as its session tools. Use `tools: []`
for workers that need no application tools. Undefined values from `workerSessionOptionsFactory`
preserve the corresponding base `workerSessionOptions` value for every option, including tools,
interceptors, approvals, and other policy hooks. Defined values still replace the base option;
for example, `tools: []` remains an explicit empty grant. Ordinary agent sessions retain their additive semantics.
For requested delegation only, set `delegationMode: 'explicit'`. Credentials, user-input brokers,
and workspace-bound session services are not inherited; configure worker hooks explicitly.
Shared tool implementations must be suitable for
worker use, including concurrent execution across sessions. The SDK does not clone tool closure state.

## Roles and authority

`ManagedAgentRole.tools` is a list of names to intersect with the worker's available application
tools, never a source of tool implementations. Unknown names grant nothing. The role is applied
after all host worker overrides, including `workerFactory` and `workerSessionOptionsFactory`.
Allowlist arrays are copied when constructing the team so later host mutation cannot widen a role.
Restricted roles also disable provider-native tools, skill discovery and activation, and experimental
program grants, and cap team tools at reporting so they cannot issue active peer follow-ups.
SDK reporting and scoped dependency-result readers remain available independently of application tools.

The built-in explorer/reviewer presets have no application tools until the host supplies
`readOnlyTools`. Choose tools whose entire behavior is read-only: a shell or generic RPC tool does
not become read-only because its name appears in that list. A worker preset retains the host's
available tools. A reviewer forces fresh context, overriding both a requested fork and the team
default; include the artifact and review criteria in its brief. Custom roles may also force `context`.

Write scopes remain scheduling declarations. They do not restrict actual filesystem access:
the host must enforce workspace authorization in its tools. Dependencies bind already registered
producer instances and pass their results or failure status; closing/reusing an address does not
rebind an existing dependent. Finished workers release active slots and retain their addresses/results.

## Depth

`depth` is the lead's host-supplied depth (default zero); `maxDepth` defaults to one. At or above
the limit, managed spawning is rejected before worker setup and `spawn_agent`/`spawn_agents` are hidden
from the lead's application catalog. Workers at the limit also lose these host-supplied spawning tools
without being told they previously had spawning capabilities. Lead synthesis and wait guidance remains
at the limit. Worker overrides and roles cannot restore that tool.

This helper has one managed lead; it does not install recursive managed controls into workers.
Hosts implementing nested teams can provide their own spawn hook below the limit and must propagate
`depth + 1` and the same `maxDepth`. Arbitrarily named host tools and services are opaque: hosts must
enforce nesting constraints in those hooks as well.

## Reusing guidance on another tool surface

`buildDelegationStrategy(mode)` and the tool-neutral `DELEGATION_STRATEGY` are exported from
`@alvin0/ai-agent-sdk-core/agent`. The builder supplies the proactive/explicit prefix and shared
strategy without scheduling claims. Append runtime facts appropriate to the host; this branch uses
`MANAGED_DELEGATION_RUNTIME` (automatic report injection, retained results, automatic slot release).
`filterToolsByDepth(tools, { depth, maxDepth }, child?)` accepts any named control list and removes
`spawn_agent` and `spawn_agents` at the depth limit while retaining wait/join/report tools.

## Model surface and result delivery

The default lean lead tools are `spawn_agent`, `spawn_agents`, `send_input`, `wait_agents`, `close_agent`,
and `get_agent_result`. Spawn advertises task, context, optional role, writes and dependencies;
name/specialty remain accepted for replayed histories and host requests. `send_input` returns acceptance,
queues follow-up tasks, and optionally interrupts current work. Reporting workers have `send_input`;
full workers also have wait and retained-result reads. Set `modelToolSurface: 'legacy'` to retain the
older model names/schemas; this does not restore polling, duplicate reports or occupied finished slots.

### Batch fan-out

Plan the split before reading bulk inputs: give workers input locations and let each read its own
partition. Start independent tasks in one call, reserving disjoint write scopes where needed:

```ts
spawn_agents({
  tasks: [
    { name: 'north', task: 'Extract totals from input/north. Return compact totals and evidence.' },
    { name: 'south', task: 'Extract totals from input/south. Return compact totals and evidence.' },
  ],
  join: true,
})
```

This model tool is available on both lean and legacy surfaces; host `spawn()` remains unchanged.
Each item accepts `name?`, `item_id?`, `task`, `context?: 'fresh' | 'fork'`, `role?` (host-declared), and `writes?`.
It accepts independent work only: dependency fields are rejected, and peers cannot wait on queued
siblings. Use single spawning for registered dependency chains. Admission validates names, item ids,
roles and write conflicts before setup. It reserves free worker slots plus backlog capacity atomically.
`maxQueued` defaults to `2 * maxWorkers` (capped at 1024); set zero to disable the backlog. Queued items
return `status: 'queued'`, hold no worker slot or session, and start FIFO as finished workers release slots.
Overflow reports both free slots and the current queued count. Invalid requests start no workers;
mandatory addresses and coverage ids must themselves fit the 48 KiB response budget.
Host-controlled setup can still fail after admission; failed items return `{ target, status: 'failed', error }`
while successful siblings continue. Recover only deficits rather than retrying successful items.

Without `join` (default false), returns `workers` and initial `coverage` after bounded setup of the
immediately started tasks. Ordinary push delivery handles results; one final compact batch settlement
carries coverage after every item settles. With `join: true`, the same call waits across queued waves
and returns compact `results`, `coverage`, `omitted`, `timed_out` and optional `interrupted`. No model
calls are made to dispatch queued items or poll while joining. Coverage is
`{ completed: n, failed: [ids], pending: [ids], deficit: [ids] }`; ids use `item_id` or the worker address.
Completed counts usable successful results. Deficits include failures, cancellation, and completed work
with neither nonblank text nor structured output. Coverage never duplicates result text.

Results use the lean compact shape on both surfaces: `{ target, status, result }` for success,
`{ target, status, partial_result, error }` for unsuccessful evidence, with structured fields when present.
The whole serialized response shares one 48 KiB byte budget, including diagnostics and coverage;
`workers[].warnings` is additionally limited to four 256-byte entries. `omitted` lists targets whose
result or diagnostics did not fit; use `get_agent_result` for retained result pages. Captures begin before
setup and exclude archived generations. The inner batch barrier claims no results. The existing
`captureResults(sender, targets, retained = true)` host hook retains its default and adds `release()`
for unreturned claims. Timeout or steering returns partial evidence and leaves other results for push.

Cancelling the call, its owning lead invocation, or the team drains queued reservations exactly once.
Call cancellation returns addresses with `cancelled: true` even after partial setup; joining aborts
release captured-but-unreturned outcomes and resume push delivery. Standalone call cancellation leaves
already running workers alive; invocation cancellation and team disposal also close owned workers.
Returned worker statuses are setup snapshots; consult terminal results and coverage for completion.

Push notices and active joins claim the same outcome objects through `TeamResults.take`.
A join captures publications before notices can claim them, joins all selected work, and returns all
new evidence it observed. Joining only already-settled workers returns immediately with no repeated
results. Timeout may return partial results while other targets remain active. Steering returns early;
caller cancellation rejects the wait. Use a retained read to recover evidence after a cancelled wait.
Lean failed results use `partial_result` and `error`; host outcomes also retain unsuccessful text.

`get_agent_result({ target, field?, offset?, maxBytes? })` reads repeatable retained pages: 6 KiB by
default, maximum 16 KiB. Follow `page.nextOffset` with the same field until null. Explicit reads do not
consume deliveries. `workers()`, `members()` and `awaitWorker()` retain full host evidence. A retained
address must be closed/removed when no longer needed; freeing an active slot is automatic, not eviction.
`holdWaitMs` is accepted but deprecated. Long waits cost no periodic lead calls. Scheduled synthesis
failure rejects; three synthesis-only wakes without worker progress reject as a stall.

Invocation cancellation stops workers owned by that invocation and leaves independently host-started
work and the team usable. `dispose()` remains terminal. Concurrent `run()` calls are refused.
Model cancellation policy applies to both close and interrupt; host cancellation remains available.
Host `followup` continues producing runtime settlements, even alongside model-input jobs. Result identity
is per outcome rather than text, so separate runs returning identical text are separate evidence.
For board/peer collaboration, see `packages/core/src/agent/team/COLLABORATION.md`.
