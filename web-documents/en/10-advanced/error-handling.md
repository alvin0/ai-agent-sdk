# Error Handling

One `code`-routed taxonomy, assigned at the wire boundary and consumed by retry
policy. The code is a stable string, not a TypeScript enum, so a third-party
adapter can emit its own code without the union having to know about it.

## The two error shapes

**`AgentSdkError`** is the thrown class, with `code`, `message`, and `cause`.

**`ModelFailure`** is its serializable twin, carried inline on a terminal
`finish` chunk rather than thrown:

```ts
type FinishReason =
  | { kind: 'aborted'; failure: ModelFailure }
  | { kind: 'error'; failure: ModelFailure }
  // …
```

A stream that fails still has to **end**. A thrown exception mid-iteration would
strand whatever text had already been assembled, so the registry normalizes an
adapter throw into a terminal `error` or `aborted` finish before a consumer sees
it.

## Handling errors

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

## Support-safe errors

`SupportSafeError` is a sanitized projection intended for support tickets and
cross-service propagation. It carries the code and correlation identity without
credentials, endpoints, headers, or raw provider text.

MCP and A2A server surfaces return generic internal errors by default. Set
`exposeInternalErrors: true` only for a trusted diagnostic surface.

## Capability identity conflicts

`CapabilityIdentityConflict` is raised when two capabilities claim the same
identity — two provider plugins on one route, two tool sources publishing the
same prefixed tool name, or a duplicate exporter registration. Normal runtime
conflicts fail **before setup completes**, not at first use.

---

## Error codes, in full

## Model errors — assigned at the wire boundary

| Code | HTTP-ish origin | Meaning | Retried by default | Usual fix |
| --- | --- | --- | --- | --- |
| `AUTH` | 401 / 403 | Credentials were rejected. | ✗ | Refresh or replace the credential. |
| `RATE_LIMIT` | 429 | Transient request-rate limiting. | ✓ | Back off; raise `maxRetries` or queue. |
| `SERVER` | 5xx | Provider-side fault. | ✓ | Retry; escalate to the provider if persistent. |
| `TIMEOUT` | — | No output for longer than the idle bound. | ✓ | Raise the idle bound, or check provider health. |
| `TRANSPORT` | — | The request never completed at the network layer. | ✓ | Check egress, DNS, proxy, TLS. |
| `ABORTED` | — | The caller's signal aborted the request. | ✗ | Expected on cancellation. |
| `MODEL_TEARDOWN_TIMEOUT` | — | An adapter ignored cancellation and may still own live work. | ✗ | **Adapter defect.** Fix signal forwarding. |
| `INVALID_REQUEST` | 400 / 413 | The provider rejected the request as malformed. | ✗ | Fix the request; often an oversized payload. |
| `MALFORMED_RESPONSE` | — | A well-formed response could not be parsed. | ✓ | Protocol drift — check the provider's changelog. |
| `STREAM_CLOSED` | — | The body ended before its terminating sentinel. | ✓ | Usually a network cut mid-stream. |
| `UNSUPPORTED_CONTENT` | — | Content the selected model cannot accept. | ✗ | Choose a model with the modality. |
| `UNSUPPORTED_OPTION` | — | An option this provider has no equivalent for. | ✗ | Remove the option or change provider. |
| `UNKNOWN` | — | Nothing classified it. Treated as non-retryable. | ✗ | Inspect `cause`; report if reproducible. |

Two more codes are excluded from retry by default because they fail identically
on every attempt: `QUOTA` and `CONTEXT_WINDOW_EXCEEDED`.

> `CONTEXT_WINDOW_EXCEEDED` is special: when the provider **confirms** it,
> automatic compaction may compact and retry once (`maxOverflowRetries`).

## Registry errors — raised before any provider I/O

These are composition and validation failures. None of them reached the network.

| Code | Meaning | Usual fix |
| --- | --- | --- |
| `NO_ADAPTER` | No adapter is registered for the requested route. | Register the provider, or fix `model.provider`. |
| `DUPLICATE_ADAPTER` | Two registrations claim the same route. | Give one an explicit distinct instance id/route. |
| `INVALID_ADAPTER` | The adapter failed contract validation. | Run the testkit conformance suite. |
| `INVALID_CATALOG` | A model catalog snapshot failed validation. | Fix the adapter's `listModels` output. |
| `INVALID_MODEL_INFO` | Declared model capabilities are inconsistent. | Check context window vs output limits. |
| `UNSUPPORTED_REASONING_EFFORT` | The model does not declare the requested effort. | Use a declared effort, or fix the declaration. |
| `UNSUPPORTED_NATIVE_TOOL` | The model does not declare the requested native tool. | Drop the native tool, or change model. |
| `OUTPUT_TOKEN_LIMIT_EXCEEDED` | `maxTokens` exceeds the model's hard output ceiling. | Lower `maxTokens`. |
| `INVALID_PREPARED_CALL` | A prepared call was mutated or reused across generations. | Do not cache a prepared call. |
| `REGISTRATION_DISPOSED` | The provider registration was removed while in use. | A run outlived `runtime.close()`. |

## Tool errors

Tool failures do not throw into your code — they become a `ToolFailure` the model
sees:

| Code | Cause |
| --- | --- |
| `INVALID_ARGUMENTS` | `parse` threw. The model can correct itself. |
| — (`status: 'rejected'`) | An approval broker rejected the call. |
| — (`status: 'aborted'`) | The run was cancelled during the call. |
| — (`status: 'failed'`) | `execute` threw. |

`concludesTurn` is typed `never` on failure by design: a denied or crashed tool
must not be able to silently stop the work the user asked for.

## Other error types

| Type | Purpose |
| --- | --- |
| `AgentSdkError` | The thrown class — `code`, `message`, `cause`. |
| `ModelFailure` | The serializable twin, carried inline on a terminal `finish`. |
| `SupportSafeError` | Sanitized projection for tickets and cross-service propagation. |
| `CapabilityIdentityConflict` | Two capabilities claim the same identity. Fails before setup completes. |
| `McpConnectionError` | Carries the connection stage and a bounded close report. |
| `ProviderConformanceError` | Carries the frozen conformance report. |
| `CodexRefreshError` | Carries a `RefreshFailureKind`. |
| `BrowserObservationError` / `NodeObservationError` | Exporter-specific, with their own code enums. |
| `OpenTelemetryBridgeError` | Bridge configuration or mapping failure. |

## Read next

- [Troubleshooting](/en/10-advanced/troubleshooting) — symptom to cause
- [Tool Error Handling](/en/03-tools/error-handling) — the tool-level contract
- [Providers](/en/09-providers/)
