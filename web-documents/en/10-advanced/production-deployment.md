# Production Deployment

## Startup

```ts
const apiKey = defineCredentialSource({
  id: 'openai',
  resolve: () => secrets.get('openai'),
})

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey })],
  resource: { serviceName: 'checkout-api', environment: 'production' },
  observability: { mode: 'reliable', exporters: [/* … */] },
  startupTimeoutMs: 10_000,
  closeTimeoutMs: 30_000,
  signal: bootController.signal,
})
```

`createAgentRuntime()` is async because provider plugins have a `ready()`
lifecycle boundary — that is where a capability actually acquires resources.
Registration is **transactional**: route claims are declared up front, so a
conflict fails *before setup completes*, and a failed startup rolls back every
partial registration.

`resource.serviceName` and `resource.runtime` appear on **every** observation
event. Set them, or your telemetry cannot tell two deployments apart.

## Shutdown

```ts
const report = await runtime.close({ signal })

if (report.unsettledRuns > 0) {
  logger.error('shutdown left work unsettled', {
    quiescenceEnd: report.quiescenceEnd,
    activeRunsAtClose: report.activeRunsAtClose,
    abortedRuns: report.abortedRuns,
    unsettledRuns: report.unsettledRuns,
  })
}
```

| Field | Read it for |
| --- | --- |
| `quiescenceEnd` | `settled` / `timeout` / `caller-abort` |
| `deadlineReached` | Did `closeTimeoutMs` expire? |
| `activeRunsAtClose` | How much was in flight |
| `abortedRuns` | How much was cancelled cleanly |
| `unsettledRuns` | **> 0 is a defect** — something ignored cancellation |
| `components` | Per-component close reports |
| `observationHealth` | Retained/evicted event and byte counts |

Close admission is atomic, cancellation is composed, late generations are sealed,
one shared close task is safe against caller abort, and loggers become no-ops
after close.

### Close order, when you connected something

```ts
try {
  await runtime.close()               // 1. quiesce runs
} finally {
  await mcp?.closeWithReport()        // 2. close what YOU connected
  await team?.dispose?.()             // 3. unlink remote peers
  await db.end()                      // 4. your own borrowed resources
}
```

The runtime closes what it **owns** and never invents a close action for
something it did not acquire. An **owned** observation exporter is closed by the
runtime after all active runs settle; a **borrowed** one is yours.

## Per-runtime checklists

### Node service

```text
[ ] resource.serviceName + environment
[ ] jsonlObservationExporter → ownership 'owned', requirement 'required',
    boundary 'local-durable'
[ ] SIGTERM handler → await runtime.close(), then close connections
[ ] closeTimeoutMs shorter than your orchestrator's grace period
[ ] recoverRuntimeObservationJournal() on next boot
[ ] credentials injected — never read process.env inside a provider
```

```ts
process.on('SIGTERM', async () => {
  const report = await runtime.close()
  if (report.unsettledRuns > 0) process.exitCode = 1
})
```

### Edge / Worker

```text
[ ] Universal packages only — no auth-node, mcp-node, skill-filesystem,
    observability-node, a2a
[ ] resource.serviceName + environment
[ ] fetchObservationExporter → boundary 'remote-acknowledged',
    requirement 'best-effort'
[ ] flush handed to the platform's explicit waitUntil — never assume a global
[ ] conversation snapshots in KV / D1 / Durable Objects, not worker memory
[ ] handle.abort() on client disconnect
```

```ts
ctx.waitUntil((async () => {
  try {
    await handle.result
    await env.CONVERSATIONS.put(id, JSON.stringify(session.snapshot()))
  } finally {
    await runtime.close()
  }
})())
```

See [Deploying to an Edge Worker](/en/10-advanced/deploy-edge-worker).

### Browser

```text
[ ] short-lived token minted by your backend — not a provider API key
[ ] indexedDbObservationExporter → boundary 'local-durable'
[ ] installBrowserObservabilityLifecycle() — opt-in, no unload-durability claim
[ ] recoverEvents() on load, acknowledgeBatch() only after YOUR sink confirms
[ ] session.snapshot() persisted yourself
```

See [Deploying to a Browser](/en/10-advanced/deploy-browser).

## Budgets before traffic

Defaults are safe for unattended use, not tuned for your cost model.

```ts
const session = agent.createSession({
  runtimeLimits: {
    maxTotalTokens: 250_000,
    maxToolDurationMs: 120_000,
    toolTeardownTimeoutMs: 15_000,
    maxConsecutiveToolErrors: 3,
  },
  usagePolicy: { onMissing: 'warn' },   // 'estimate' | 'fail' for hard cost control
})
```

If you have hard cost controls, pick `estimate` or `fail` deliberately. A
total-token guard **cannot** enforce an exact limit when a provider omits usage —
the policy makes that explicit rather than pretending.

## Cost accounting, honestly

```ts
const r = response.report
const billedInput = r.reported.inputTokens
  + (r.reported.cacheReadTokens ?? 0)
  + (r.reported.cacheWriteTokens ?? 0)

if (!r.authoritative) {
  // reported is a LOWER BOUND. Do not bill from it as if it were a total.
  metrics.increment('usage.incomplete', r.coverage.missingCalls)
}
```

`possiblyBilledAttemptsWithoutUsage` counts attempts that were sent (or may have
been) and returned no counters. That is the honest answer when exact billing is
unknowable from the response — surface it rather than rounding it away.

## Health and readiness

```ts
// Readiness: can we reach a provider at all?
await runtime.modelCatalog('openai')

// Liveness / debug: bounded in-memory diagnostics
runtime.diagnostics()
```

Observability observes itself: `sdk.observer.failure` and `sdk.exporter.state`
record failures, drops, recovery, and queue state. A rising drop rate is a
capacity signal, not noise.

## Before you ship

```text
[ ] runtime.close() called on every exit path, and its report inspected
[ ] unsettledRuns > 0 treated as an alert
[ ] exporter boundary matches real durability
[ ] content policy reviewed — the exact-wire logger is OFF unless debugging
[ ] endpoint policy set for MCP and A2A clients (HTTPS, origins, private network)
[ ] MCP/A2A server surfaces authenticate BEFORE handler.fetch()
[ ] exposeInternalErrors is false outside trusted diagnostics
[ ] bundle checked for the wrong runtime tier
[ ] budgets and usagePolicy chosen for your cost model
```

## Read next

- [Security](/en/10-advanced/security)
- [Observability](/en/10-advanced/observability)
- [Troubleshooting](/en/10-advanced/troubleshooting)
