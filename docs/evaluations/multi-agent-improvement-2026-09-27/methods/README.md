# Multi-agent orchestration benchmark

This benchmark compares the prepared SDK **after the previous plan completion**
against the current multi-agent fixes. It does not reuse PTC scores as team evidence.

`conformance.ts` uses public `ManagedAgentTeam`, `AgentTeam` and real session/model
loops with controlled adapters and handshake gates. The 33 cases test concurrent
admission, identity after closure/address reuse, awaited preparation, required
handoff, wait cancellation/delivery, scoped history limits, bounded teardown,
large reports/full scoped reads, Unicode pagination and truthful terminal failure. Independent work,
ordered overlapping writes and failed dependencies remain controls. This is an
exposed regression cohort: cases were added as audit findings were reproduced;
it is not a blind task distribution or a provider-token benchmark.

```sh
node --experimental-strip-types test-human/multi-agent/conformance.ts \
  --sdk-root /path/to/prepared-sdk --output /path/to/new-results
```

`fixtures-v1.json` and `live-protocol-v1.json` freeze six lifecycle workflow
families, English/Vietnamese variants, three repeats and two arms. Each provider
executes 72 workflows (144 total). The host controls ordering, then real producer
and consumer sessions use the SDK tools and supplied evidence. This measures
handoff/synthesis under those lifecycle conditions; autonomous lead planning and
production task breadth need a separate cohort.

The baseline and candidate are **immutable built SDK trees**, loaded in separate
processes. One workflow per provider is active; arm order is counterbalanced
within variant/repeat. The canonical run/model observations cover every child,
not just the final consumer. Synthetic source failure is explicitly labeled and
has no external provider call. All failures stay in the denominator. Both arms
have the same session limits, instructions, evidence and read-only authority.
Expected aggregate answers are kept only by the grader. No USD claim is made.

```sh
node --env-file=.env --experimental-strip-types \
  test-human/multi-agent/live-runner.ts \
  --baseline /path/to/immutable-before --candidate /path/to/immutable-after \
  --output /path/to/new-live-results
python3 test-human/multi-agent/analyze.py /path/to/new-live-results
```

Use `--pilot` for the separate eight-attempt readiness cohort. Never replace
formal rows with pilots or selectively rerun an arm. Model credentials remain in
the existing project credential store/environment; neither prepared bundle nor
evidence copies them. The runner retains canonical usage, answer text, tool
names and evidence-presence metrics, without HTTP bodies or environment dumps.

The primary grade requires the exact requested JSON fields, correct numbers and
source identities. A prose answer with a correct embedded JSON block can fail the
primary format requirement; any secondary semantic review must preserve that raw
failure. Paired-success token/latency means use the **same successful pairs**;
all-attempt totals also include failures and report missing usage as unknown.
Translations and repeats share family facts and are not independent families.

SDK changes exercised here:

- Admission reserves names, slots and declared write scopes before asynchronous
  setup. Factories receive frozen request declarations. Absolute/escaping scopes
  are rejected; lexical normalization catches equivalent relative paths.
- Dependencies bind to the original producer instance, including its result after
  closing its address. Pending and already-completed dependencies share the same
  required handoff path. A refused handoff fails visibly without dispatching work.
- Large notifications and dependency summaries retain head and tail within their
  byte cap. A dependent gets `read_dependency_result` for only its commissioned
  producers. `offset`/`nextOffset` count UTF-16 code units; each page is byte
  bounded. Closed producers' full reports remain readable for that consumer.
  Detached evidence stores retain results without retaining producer sessions.
  For the lead, mount `leadSessionOptions.spillStore` so an oversized
  `list_agents` result can be recovered with `read_tool_output`; without a store
  the existing tool-output policy truncates it. Host `workers()` exposes full
  current results. Read needed reports before closing their lead-visible address.
- `spawnTimeoutMs` bounds asynchronous setup; `workerTimeoutMs` bounds the active
  run and does not include dependency queue time. `closeTimeoutMs` also bounds
  waiting for host cancellation. Timeouts cannot forcibly stop a provider or
  host callback that ignores its cancellation signal.
- `whenQuiet` includes preparations and report delivery. Abort stops the caller's
  wait while worker-owned work continues. Steer wakes the automatic lead hold.
- Dispose stops further managed admission, and concurrent close calls operate on
  the same worker instance. The underlying shared `AgentTeam` stays host-owned.
- Generic team wakeups preserve incomplete/error status and partial text instead
  of reporting a resolved budget-limited response as successful completion.

Declared write scopes coordinate scheduling; they are not a filesystem sandbox.
Symlinks, platform case folding and external-tool authorization belong to host
policy. Full reports are retained in memory for the dependent's lifetime, not a
durable cross-restart result store. An oversized combined handoff under a custom
small team message limit fails visibly; it does not silently omit evidence.

## SDK and host policy boundary

`ManagedAgentTeam` is an optional convenience layer over the lower-level
`AgentTeam` and session APIs. Its injected guidance describes lifecycle/tool
contracts; the host supplies task strategy, roles, tool authority and output
format. The benchmark's synthesis workflow and JSON schema are fixtures, not SDK
requirements.

Host controls added in this audit:

```ts
createManagedAgentTeam({
  registry,
  lead,
  autoLeadCoordination: false, // host starts each lead turn; reports are delivered quietly
  workerTeamTools: 'full',     // allow peer coordination; false disables team tools
  requireWorkerText: false,    // clean tool-only completion is valid (default)
})
```

The convenience defaults retain automatic lead coordination and reporting-only
worker tools. `requireWorkerText: true` opts into textual completion for a host
that needs it. `workerFactory`, per-worker session/tool factories, fresh/fork
context and reject/warn/off scheduling policies remain host extension points.
The four policy cases check actual model/tool boundaries, including a worker
that completes a tool action without producing text. The manual-turn case checks
that a model-spawned worker neither prolongs nor restarts the lead's turn when
the host disables automatic coordination.
