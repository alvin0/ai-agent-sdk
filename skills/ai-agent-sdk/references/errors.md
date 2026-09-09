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
| `OUTPUT_TOKEN_LIMIT_EXCEEDED` | Output selection above the model's hard ceiling |
| `INVALID_ARGUMENTS` | A tool's `parse` threw — reported to the model, which can correct it |
| `CONTEXT_SECTION_INVALID` | A context section broke its id/size contract |

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
