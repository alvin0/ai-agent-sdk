# Troubleshooting — symptom to cause

## The agent stops early

| Symptom | Cause | Fix |
| --- | --- | --- |
| Answered without using the tools | `maxTurns` / `maxToolCalls` exhausted; exhaustion reserves one tools-disabled final answer, which looks exactly like this | Raise the budget, or set `onExhausted: 'continue'` |
| Stopped mid-task with no final answer | Token exhaustion stops **immediately** — the safety budget must not spend itself explaining it was reached | Check `maxTotalTokens` in `runtimeLimits` |
| Keeps calling the same tool | Exact-repeat detection (`repeatToolWarningAt`, `repeatToolLimit`) or cycle detection (`toolCycleWarningAt`, `toolCycleLimit`, `maxToolCycleLength`) | Raise them — but first check whether the tool's result is uninformative |
| `deep` mode never finishes | The turn cannot end until the `submit_result` self-check is accepted | Read the terminal report; the submission was rejected, not missing |

Watch for the app-authored budget warning injected at **75%** of
`maxToolCalls` — it appears in history as a lifecycle entry.

## Nothing gets compacted

Automatic pressure compaction is a **no-op** when the adapter reports no
context window, unless `maxInputTokens` is configured.

If it runs and achieves nothing, read `backoffReason` on the `compaction-end`
event:

| `backoffReason` | Meaning |
| --- | --- |
| `unreachable-threshold` | The retained tail alone already exceeds the threshold. Lower `retainRatio`. |
| `low-savings` | The checkpoint saved too little; history is mostly non-compactable. |

Pressure compaction backs off for four model steps after either. Manual
`session.compact()` and provider-confirmed overflow recovery stay available
during that cooldown.

## Usage numbers look wrong

**Input tokens lower than expected.** `inputTokens` is **uncached input only**:

```ts
usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
```

**`totalTokens` missing.** It is set only when authoritative — preserved from a
provider total, or derived from aggregate counters that agree. Omitted rather
than guessed.

**Cost calculation too low.** Check `coverage`. `reported` is a lower-bound sum
when coverage is incomplete, and `possiblyBilledAttemptsWithoutUsage` counts
attempts that were sent (or may have been) and returned no counters. Never
label a non-authoritative number "total cost".

## Cancellation does not work

| Signal | Meaning |
| --- | --- |
| `unsettledRuns > 0` in the close report | Something ignored cancellation — usually a tool that declares `timeoutMs` without forwarding `ctx.signal` |
| `MODEL_TEARDOWN_TIMEOUT` | An adapter ignored cancellation and may still own live work. **Adapter defect**, not a transient failure |

Declaring `timeoutMs` is a **promise** that `execute` forwards the signal: the
pipeline aborts and **waits**, it does not abandon the promise, because an
orphaned tool keeps mutating state behind the loop's back.

## Provider selection fails

| Error | Cause |
| --- | --- |
| `NO_ADAPTER` | No provider for the route, or `model.provider` is misspelled |
| `DUPLICATE_ADAPTER` | Two plugins claim one route. Give one a distinct instance id |
| `UNSUPPORTED_*` | The model does not declare the capability. Check `runtime.modelCatalog(route)` |
| `OUTPUT_TOKEN_LIMIT_EXCEEDED` | `maxTokens` is above the model's hard ceiling |

All raised **before any provider I/O**, so they cost nothing.

## Types reject code that looks right

These are the shapes that most often surprise people; each is verified against
the shipped typings.

| Symptom | Cause |
| --- | --- |
| `ModelProviderPlugin is not assignable to ComposableModelProviderPlugin` | `apiKey: () => token` selected the legacy plugin overload. Pass a string or a core `CredentialSource` — see references/packages.md |
| `registerAdapter` argument order rejected | `ModelRegistry.registerAdapter(routes, adapter)` but `registrar.registerAdapter(adapter, routes?)` — opposite orders |
| `DefinedAgent is not assignable to RuntimeAgentBindingInput` | `runtime.agent(definedAgent)` is not a thing; their `model` shapes differ. Use `definedAgent.createSession({ registry })` |
| `'runtime' does not exist in RuntimeObservationResourceInput` | The runtime label is **detected**; pass `serviceName` / `environment` instead |
| `session.memory` / `session.skills` undefined | Those live on the `defineAgent()` layer's `AgentSession`, not on `RuntimeAgentSession` |
| `ToolDefinition<{…}> is not assignable to ToolDefinition<never>` | `catalog.registerAll([tool])` is typed `never[]`; use `catalog.register(tool)` |
| `Expected 0 arguments, but got 1` on host validation | `localhostHostValidation()` is a **factory**; call it once, then use the returned predicate |
| `ObservationExporterPlugin is not assignable to ObservationExporter` | Package exporter factories go to `createAgentRuntime`; `createObservability` takes the bus-level shape |
| `Property 'flush' is missing in type 'AgentRuntime'` | `installBrowserObservabilityLifecycle` needs an `Observability`; a runtime-owned bus flushes at `runtime.close()` |
| `revision`/`namespace` errors on a memory store | `revision` is a string, `load()` takes a key, and conversation scope requires `namespace` |

## MCP problems

| Symptom | Cause |
| --- | --- |
| Tools never appear | They publish only after a successful handshake **and** `tools/list`. Check `connection.state.status` and `state.protocol` |
| Works, but on the legacy protocol | `state.protocol` exposes negotiated `era`, exact `version`, selected `transport`, and whether `fallback` occurred — deliberately visible |
| A refresh failed and the catalog looks gone | It is not: a failed refresh retains the last-known-good catalog. Only a fully fetched snapshot swaps in |
| One hung server wedges the agent | It should not — a server that ignores the deadline has its generation removed and closed within `closeTimeoutMs` |

OAuth has four distinct states; treating every `401` as OAuth is the classic
mistake:

| State | Host action |
| --- | --- |
| `authentication-required` | No recognized credential provider was configured |
| `authentication-failed` | A bearer/API token was supplied and rejected |
| `oauth-authorization-required` | Complete the redirect/callback, then `finishOAuth()` |
| `scope-authorization-required` | Request consent for `authorization.requiredScope` |

## Skills do not load

| Symptom | Cause |
| --- | --- |
| The model never calls `load_skill` | Discovery only puts id, name, description, and selection boundary in the prompt, capped by `maxCatalogChars` (8,000). Make `whenToUse` decisive |
| A declared skill id is not available | The session fails **before** its model request rather than running with a different capability. Check the provider lists that id |
| An edited `SKILL.md` has no effect | A same-path edit changes the file revision and invalidates the manifest, so it must be loaded again. Earlier instructions stay in history until compaction |

## Resume fails

| Situation | Behaviour |
| --- | --- |
| Different agent id | Fails early |
| Skill provider/source/resource location drifted | Fails before the model request |
| Legacy v1 snapshot without skill state | Valid — accepted |
| Unknown fields | Discarded |

Skill bodies and resources are never persisted; resume rediscovers them from
**current** providers.

## Telemetry is missing

| Symptom | Cause |
| --- | --- |
| Events never reach the backend | Check the registration's `boundary`. `none` claims no delivery; memory delivery **never** claims durability |
| Events vanish in an Edge worker | An Edge host cannot rely on process exit: `flushObservabilityWithWaitUntil(observability, ctx.waitUntil)` |
| Browser events vanish on tab close | The lifecycle helper makes **no unload-durability claim**. Stored events stay unacknowledged until `acknowledgeBatch(batchId)`; recover with `recoverEvents()` on next load |
| The OTel bridge exports nothing | It is **not an exporter** — it installs no global provider and owns no OTLP exporter. Configure your own OpenTelemetry SDK |

## Bundling problems

| Symptom | Cause |
| --- | --- |
| An Edge bundle pulled in `node:fs` | A Node-tier package entered the graph: `auth-node`, `mcp-node`, `mcp-node-server`, `skill-filesystem`, `observability-node`, `a2a` |
| A deep import broke after an upgrade | Only the documented root plus listed subpaths are public. Internal source paths are not compatibility contracts |
