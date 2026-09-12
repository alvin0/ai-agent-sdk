# Errors and retry

One `code`-routed taxonomy, assigned at the wire boundary, consumed by retry
policy. The code is a stable string, not a TypeScript enum, so a third-party
adapter can emit its own code without the union knowing about it.

## Two shapes

- **`AgentSdkError`** — the thrown class, with `code`, `message`, `cause`.
- **`ModelFailure`** — its serializable twin, carried inline on a terminal
  `finish` chunk rather than thrown.

```ts
type FinishReason =
  | { kind: 'aborted'; failure: ModelFailure }
  | { kind: 'error'; failure: ModelFailure }
  // …
```

A stream that fails still has to **end**: a throw mid-iteration would strand
already-assembled text, so the registry normalizes an adapter throw into a
terminal `error` or `aborted` finish before any consumer sees it.

## Handling

```ts
import { AgentSdkError, MODEL_ERROR_CODES } from '@alvin0/ai-agent-sdk-core'

try {
  const response = await agent.generate(input)
} catch (error) {
  if (error instanceof AgentSdkError) {
    switch (error.code) {
      case MODEL_ERROR_CODES.AUTH:            return promptForCredentials()
      case MODEL_ERROR_CODES.RATE_LIMIT:      return backOffAndQueue()
      case MODEL_ERROR_CODES.INVALID_REQUEST: return reportBug(error)
      default:                                return surfaceGenericFailure(error)
    }
  }
  throw error
}
```

In a stream, read the terminal event instead:

```ts
for await (const event of agent.stream(input)) {
  if (event.type === 'error') {
    console.error(event.error.code, event.error.message)
    console.error(event.report.usage)   // usage up to the failure is still real
  }
}
```

## Model error codes

| Code | Origin | Meaning | Retried by default | Usual fix |
| --- | --- | --- | --- | --- |
| `AUTH` | 401/403 | Credentials rejected | ✗ | Refresh or replace the credential |
| `RATE_LIMIT` | 429 | Transient rate limiting | ✓ | Back off; raise `maxRetries` or queue |
| `SERVER` | 5xx | Provider-side fault | ✓ | Retry; escalate if persistent |
| `TIMEOUT` | — | No output past the idle bound | ✓ | Raise the bound, or check provider health |
| `TRANSPORT` | — | Request never completed at the network layer | ✓ | Check egress, DNS, proxy, TLS |
| `ABORTED` | — | The caller's signal aborted it | ✗ | Expected on cancellation |
| `MODEL_TEARDOWN_TIMEOUT` | — | An adapter ignored cancellation and may still own live work | ✗ | **Adapter defect.** Fix signal forwarding |
| `INVALID_REQUEST` | 400/413 | Provider rejected it as malformed | ✗ | Fix the request; often an oversized payload |
| `MALFORMED_RESPONSE` | — | Well-formed response could not be parsed | ✓ | Protocol drift — check the changelog |
| `STREAM_CLOSED` | — | Body ended before its terminating sentinel | ✓ | Usually a network cut mid-stream |
| `UNSUPPORTED_CONTENT` | — | Content the model cannot accept | ✗ | Choose a model with the modality |
| `UNSUPPORTED_OPTION` | — | No provider equivalent for the option | ✗ | Remove it or change provider |
| `UNKNOWN` | — | Nothing classified it | ✗ | Inspect `cause`; report if reproducible |

Also excluded from retry because they fail identically every attempt: `QUOTA`
and `CONTEXT_WINDOW_EXCEEDED`.

`CONTEXT_WINDOW_EXCEEDED` is special: when the provider **confirms** it,
automatic compaction may compact and retry once (`maxOverflowRetries`).

## Registry-level rejections, before any provider I/O

| Code | Cause |
| --- | --- |
| `UNSUPPORTED_REASONING_EFFORT` | Effort the model does not declare |
| `UNSUPPORTED_NATIVE_TOOL` | Native tool the model does not support |
| `UNSUPPORTED_IMAGE_INPUT` | `imagePolicy: 'strict'` and the model declares no image modality |
| `UNSUPPORTED_DOCUMENT_INPUT` | `documentPolicy: 'strict'` and the model declares no document modality |
| `INVALID_IMAGE_POLICY` / `INVALID_DOCUMENT_POLICY` | Policy value was neither `'strict'` nor `'project'` |
| `OUTPUT_TOKEN_LIMIT_EXCEEDED` | Output selection above the model's hard ceiling |
| `INVALID_ARGUMENTS` | A tool's `parse` threw — reported to the model, which can correct it |
| `CONTEXT_SECTION_INVALID` | A context section broke its id/size contract |

## Embedding codes

Embedding has its own taxonomy, `EMBEDDING_ERROR_CODES`, exported from
`@alvin0/ai-agent-sdk-core/embedding` together with the `EmbeddingError` class.
Fifteen codes, frozen flat strings for the same reason the model codes are.

The split is deliberate: transport faults keep using `MODEL_ERROR_CODES`, so
"the provider is rate limiting us" (`RATE_LIMIT`) stays distinguishable from
"the provider returned a vector of the wrong width"
(`EMBEDDING_VECTOR_DIMENSIONS_MISMATCH`) without parsing a message. Both the
OpenAI and Gemini adapters emit the **same** embedding codes for mapping,
dimension and vector faults — that is what lets one contract suite run against
both.

Raised by the runtime **before** any request goes out:

| Code | Meaning | Do this |
| --- | --- | --- |
| `EMBEDDING_ADAPTER_MISSING` | No embedding adapter registered for the requested route/model | Install an embedding plugin for that route |
| `EMBEDDING_REQUEST_INVALID` | Malformed at the SDK boundary: missing `purpose`, empty `values`, empty item | Fix the call |
| `EMBEDDING_DIMENSIONS_UNSUPPORTED` | `dimensions` is not a width the route declares | Use a declared width, or declare it in the route's `models` |
| `EMBEDDING_INPUT_TOO_LARGE` | Input exceeds the declared `maxInputTokens`; carries `itemIndexes` and `limit` | Chunk or drop the named items |
| `EMBEDDING_SPACE_INCOMPATIBLE` | The `expectedSpace` you passed is not compatible with the resolved call | Re-embed the index, or point at the space it was built in |
| `EMBEDDING_PURPOSE_UNSUPPORTED` | The route cannot express the purpose and the caller demands the distinction | Choose a route with a purpose mechanism |
| `EMBEDDING_TRUNCATION_UNSUPPORTED` | `truncation` requested where the provider has no equivalent parameter | Truncate upstream; SDK default is `'reject'` |
| `EMBEDDING_CONFIGURATION_INVALID` | Invalid handle configuration — cache enabled without `scope`, fallback outside the group | Fix the `embeddingModel()` options |

Raised by an adapter while it **validates a response**:

| Code | Meaning | Do this |
| --- | --- | --- |
| `EMBEDDING_VECTOR_COUNT_MISMATCH` | Response carried a different number of vectors than inputs sent | Protocol drift — check the changelog |
| `EMBEDDING_VECTOR_INDEX_INVALID` | A vector index is duplicated, missing, or out of range | Protocol drift |
| `EMBEDDING_VECTOR_VALUE_INVALID` | A vector contains `NaN` or `Infinity` | Provider fault; retry, then escalate |
| `EMBEDDING_VECTOR_DIMENSIONS_MISMATCH` | A vector's width differs from the requested `dimensions` | Check the route's declared widths |
| `EMBEDDING_RESPONSE_MALFORMED` | Response does not satisfy the embedding contract structurally | Protocol drift |

And two that belong to neither phase:

| Code | Meaning |
| --- | --- |
| `EMBEDDING_ABORTED` | The caller's signal, or a runtime close, aborted the call |
| `EMBEDDING_UNKNOWN` | Nothing in this taxonomy classified the failure |

`EmbeddingError` carries the facts a caller would otherwise re-derive:
`itemIndexes` (frozen, only when the fault is attributable to specific inputs),
`limit`, `provider`, `model`, `space`. No field carries raw input text or vector
values — redaction keeps those out of errors and traces alike.

```ts
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '@alvin0/ai-agent-sdk-core/embedding'

try {
  await embeddings.embedMany({ values: chunks, purpose: 'retrieval-document' })
} catch (error) {
  if (error instanceof EmbeddingError
    && error.code === EMBEDDING_ERROR_CODES.INPUT_TOO_LARGE) {
    return rechunk(error.itemIndexes ?? [], error.limit)
  }
  throw error
}
```

The constructor validates rather than trusts: a negative `itemIndexes` entry or
a non-positive `limit` throws, because a nonsense bound in an authoritative
message is worse than a crash at the point that computed it.

## JSON transport code

The shared `Http_Transport` in `@alvin0/ai-agent-sdk-provider-http` grew one
code when the JSON pipeline landed beside the SSE one:
`HTTP_JSON_MEDIA_TYPE_INVALID`, in `HTTP_PROVIDER_ERROR_CODES`. It is the JSON
counterpart of `HTTP_STREAM_MEDIA_TYPE_INVALID` — a 200 whose `Content-Type` is
not JSON, which usually means a proxy or captive portal answered instead of the
provider. Refusing it is the point: parsing an HTML error page as though it were
the provider's answer is how a proxy outage becomes a mysterious schema error
further up. It is not in the default retryable set — fix the endpoint or the
egress path.

## Route–operation conflicts at construction

Generation and embedding plugins are **namespaced by operation**, so
`openAiPlugin()` and `openAiEmbeddingPlugin()` may both claim route `openai`.
Two plugins of the *same* operation claiming one route is a construction
failure, and the two operations have separate codes on
`AgentRuntimeConstructionError.failureCode`:

| Failure code | Raised when |
| --- | --- |
| `PROVIDER_ROUTE_CONFLICT` | Two **generation** plugins claim one route |
| `PROVIDER_OPERATION_CONFLICT` | Two **embedding** plugins claim one route |

Both surface as `AgentRuntimeConstructionError` with `code:
'RUNTIME_CONSTRUCTION_FAILED'` and `stage: 'preflight'`. Startup preflight
sweeps the whole `providers` list before committing any plugin, so
`failureCode` is the first failure while `aggregate` lists every one of them,
each entry naming its `index`, `pluginId` and the `conflictsWithIndex` it
collides with. Nothing is installed and no `setup()` runs when the sweep fails.

## Copilot codes

A provider may own codes for failures no other provider has. Copilot has
**fourteen**, exported as `COPILOT_ERROR_CODES` from
`@alvin0/ai-agent-sdk-provider-copilot` — frozen flat strings, not a TS enum, for
the reason the core taxonomy is: the value has to survive serialization into a
log line.

Credential path:

| Code | Meaning | Do this |
| --- | --- | --- |
| `COPILOT_CREDENTIAL_REJECTED` | Token exchange refused the credential (401 or 403) | Run `npm run provider:copilot:login-device`. A personal access token, or an OAuth App off GitHub's allowlist, can never work here |
| `COPILOT_TOKEN_EXCHANGE_FAILED` | Exchange failed for a reason that is not the credential | Read `kind`: `transient` (5xx, 429) is worth retrying, `permanent` is not |
| `COPILOT_TOKEN_MALFORMED` | Exchange response was not JSON, or carried no readable `expires_at` | Protocol drift — check the changelog; retrying will not help |
| `COPILOT_TENANT_UNSUPPORTED` | `ghe.com` or a host under it; no token-exchange surface exists there | Unsupported. Use a non-data-residency account, or a first-party provider |
| `COPILOT_CREDENTIAL_REVISION_CONFLICT` | A commit found a revision other than the expected one — another writer won | Re-read the credential and retry the operation |

Device flow:

| Code | Meaning | Do this |
| --- | --- | --- |
| `COPILOT_DEVICE_LOGIN_DENIED` | The user declined the request | Run the login again and approve it |
| `COPILOT_DEVICE_LOGIN_EXPIRED` | The code expired server-side | Run the login again and enter the code sooner |
| `COPILOT_DEVICE_LOGIN_TIMEOUT` | The absolute 15-minute bound passed without approval | Run the login again |
| `COPILOT_DEVICE_LOGIN_FAILED` | Ended without a token for any other reason | Inspect `cause`; check egress to `github.com` |

Request path:

| Code | Meaning | Do this |
| --- | --- | --- |
| `COPILOT_EDITOR_HEADERS_MISSING` | Endpoint rejected the request for a missing editor header | Restore the header, or set `editorHeaders` — the message names both |
| `COPILOT_ENDPOINT_ORIGIN_INVALID` | Target URL was not on the configured issuer/base origin | Fix `baseUrl` or `githubApiBaseUrl`; a bearer token is never sent cross-origin |
| `COPILOT_REDIRECT_REJECTED` | Response was a redirect, which this SDK does not follow | Point the config at the final URL yourself |
| `COPILOT_CATALOG_MALFORMED` | `/models` was the wrong shape structurally | Protocol drift; pass an explicit `models` list to unblock |
| `COPILOT_ENDPOINT_OVERRIDE_INVALID` | `endpointOverrides` pinned a nonexistent endpoint | Use `'responses'` or `'chat-completions'`. Thrown at construction, not at dispatch |

### Three situations reuse an existing code

A second code for a situation the SDK already names forces every consumer to
write a second branch for it, so Copilot deliberately does not mint one:

- **No credential at all** — `MISSING_CREDENTIAL`, with a message naming the
  login command.
- **Abort** — `ABORTED`. `CopilotDeviceLoginError` with `reason: 'aborted'` maps
  to it rather than minting a Copilot abort code, which is why `reason` has five
  values and the code table above has four device rows.
- **HTTP failures of the generation and embedding endpoints** —
  `MODEL_ERROR_CODES` plus `HTTP_PROVIDER_ERROR_CODES`, same classification and
  same `retry-after` handling as every other provider. In particular there is no
  `COPILOT_RATE_LIMIT`: a 429 from Copilot is `RATE_LIMIT`.

## Retry policy

```ts
import { withRetry } from '@alvin0/ai-agent-sdk-core'

registry.registerAdapter(['openai'], withRetry(openAiAdapter({ apiKey }), {
  policy: { mode: 'normal', maxRetries: 3 },
  onRetry: attempt => console.warn(`retry ${attempt.attempt}: ${attempt.failure.code}`),
}))
```

Retry is a decorator and only retries failures that occur **before the first
chunk reaches the consumer** — replaying delivered tokens would duplicate
output.

Adapters assign a stable `code` at the wire boundary; **policy** decides which
codes are eligible, never the adapter that assigned them.

`mode: 'always'` is accepted only when the request carries an `AbortSignal`.
Normal agent turns supply one through their model deadline; direct callers must
supply their own cancellation boundary.

## Support-safe errors

`SupportSafeError` is a sanitized projection for support tickets and
cross-service propagation. It carries the code and correlation identity without
credentials, endpoints, headers, or raw provider text.

## Capability identity conflicts

`CapabilityIdentityConflict` is raised when two capabilities claim one identity
— two provider plugins on a route, two tool sources publishing the same
prefixed tool name, a duplicate exporter registration. Normal runtime conflicts
fail **before setup completes**, not at first use.
