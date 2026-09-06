# Troubleshooting

Symptom → cause → fix.

## The agent stops early

**"It answered without using the tools I gave it."**

Check `maxTurns` and `maxToolCalls`. Exhaustion normally reserves one
tool-disabled final answer, so a short budget produces exactly this. Watch for
the app-authored budget warning injected at **75% of `maxToolCalls`**.

**"It stopped mid-task with no final answer."**

Token exhaustion stops **immediately** — the safety budget must not spend itself
explaining that it was reached. Check `maxTotalTokens` in `runtimeLimits`.

**"It keeps calling the same tool."**

Exact-repeat detection warns at `repeatToolWarningAt` and stops at
`repeatToolLimit`. Short multi-step cycle detection uses `toolCycleWarningAt`,
`toolCycleLimit`, and `maxToolCycleLength`. If the model genuinely needs
repetition, raise these — but first check whether your tool's result is
uninformative.

## Nothing gets compacted

Automatic pressure compaction is a **no-op** when the adapter reports no context
window, unless `maxInputTokens` is configured.

If it runs but achieves nothing, look at the `compaction-end` event:

| `backoffReason` | Meaning |
| --- | --- |
| `unreachable-threshold` | The retained tail alone already exceeds the threshold. Lower `retainRatio`. |
| `low-savings` | The checkpoint saved too little. Your history is mostly non-compactable. |

Pressure compaction backs off for four model steps after either. Manual
`session.compact()` and provider-confirmed overflow recovery stay available
during that cooldown.

## Usage numbers look wrong

**"Input tokens are lower than I expected."**

`inputTokens` is **uncached input only**. Billed input is:

```ts
usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
```

**"`totalTokens` is missing."**

It is set only when authoritative — preserved from a provider total, or derived
from aggregate counters that agree. It is **omitted rather than guessed**.

**"My cost calculation is too low."**

Check `report.coverage`. `reported` is a lower-bound sum when coverage is
incomplete, and `possiblyBilledAttemptsWithoutUsage` counts attempts that were
sent (or may have been) and returned no counters. Never label a non-authoritative
total "total cost".

## Cancellation does not work

**`unsettledRuns > 0` in the close report.**

Something ignored cancellation. The usual culprit is a tool that declares
`timeoutMs` but does not forward `ctx.signal`. Declaring `timeoutMs` is a
**promise** that `execute` forwards the signal — the pipeline aborts and
**waits**; it does not abandon the promise, because an orphaned tool would keep
mutating state behind the loop's back.

**`MODEL_TEARDOWN_TIMEOUT`.**

An adapter ignored cancellation and may still own live work. This is an adapter
defect, not a transient failure.

## Provider selection fails

| Error | Cause |
| --- | --- |
| `NO_ADAPTER` | No provider registered for the route, or `model.provider` is misspelled. |
| `DUPLICATE_ADAPTER` | Two plugins claim the same route. Give one an explicit distinct instance id. |
| `UNSUPPORTED_*` | The model does not declare the capability. Check `runtime.modelCatalog(route)`. |
| `OUTPUT_TOKEN_LIMIT_EXCEEDED` | `maxTokens` is above the model's hard ceiling. |

All of these are raised **before any provider I/O**, so they cost nothing.

## MCP problems

**"The tools never appear."**

Tools are published only after a successful handshake **and** `tools/list`. Check
`connection.state.status` and `state.protocol`.

**"It works but the server is on the legacy protocol."**

`state.protocol` exposes the negotiated `era`, exact `version`, selected
`transport`, and whether transport `fallback` occurred. That is deliberately
visible so a legacy deployment does not hide in a health UI.

**"OAuth is not completing."**

Distinguish the four states before writing UI:

| State | Host action |
| --- | --- |
| `authentication-required` | No recognized credential provider was configured. |
| `authentication-failed` | A bearer/API token was supplied but rejected. |
| `oauth-authorization-required` | Complete the redirect/callback and call `finishOAuth()`. |
| `scope-authorization-required` | Request consent for `authorization.requiredScope`. |

Treating every `401` as OAuth is the classic mistake here.

**"A refresh failed and I lost the whole catalog."**

You did not — a failed refresh retains the last-known-good catalog. Only a fully
fetched snapshot is swapped in.

## Skills do not load

**"The model never calls `load_skill`."**

Discovery only puts `id`, name, description, and selection boundary in the system
prompt, capped by `maxCatalogChars` (8,000 by default). If your catalog is large,
descriptions may be truncated. Make `whenToUse` decisive.

**"A declared skill id is not available."**

The session fails **before** its model request rather than silently running with
a different capability. Check the provider actually lists that id.

**"An edited `SKILL.md` is not taking effect."**

Same-path edits change the shallow file revision and invalidate the old resource
manifest, so the skill must be loaded again. Previously selected instructions
remain in history until compaction.

## Resume fails

| Situation | Behaviour |
| --- | --- |
| Different agent id | Fails early. |
| Skill provider/source/resource location drifted | Fails before the model request. |
| Legacy v1 snapshot without skill state | Valid — accepted. |
| Unknown fields | Discarded. |

Skill bodies and resources are never persisted. Resume rediscovers and rehydrates
them from **current** providers.

## Telemetry is missing

**"Events are not reaching my backend."**

Check the registration's `boundary`. An exporter that claims `none` is not
claiming delivery. Memory delivery **never** claims durability.

**"Events vanish in an Edge worker."**

An Edge host cannot rely on process exit. Hand the flush promise to the
platform's explicit `waitUntil`:

```ts
flushObservabilityWithWaitUntil(observability, ctx.waitUntil)
```

**"Browser events vanish on tab close."**

`installBrowserObservabilityLifecycle()` flushes on hidden visibility and
`pagehide` and makes **no unload-durability claim**. Stored events remain
unacknowledged until you call `acknowledgeBatch()` — recover them with
`recoverEvents()` on next load.

**"I enabled the OTel bridge but nothing is exported."**

The bridge is **not an exporter**. It installs no global provider and owns no
OTLP exporter. Configure your own OpenTelemetry SDK, or add a journal /
acknowledged exporter.

## Bundling problems

**"My Edge bundle pulled in `node:fs`."**

A Node-tier package entered the graph. The Node-tier packages are `auth-node`,
`mcp-node`, `mcp-node-server`, `skill-filesystem`, `observability-node`, and
`a2a`.

**"Deep import broke after an upgrade."**

Only the documented root plus listed subpaths are public. Internal source paths
are not compatibility contracts.

## Read next

- [Error Handling](/en/10-advanced/error-handling) — the full taxonomy
- [Performance](/en/10-advanced/performance) — every bound and budget
