# Custom Provider

There are three levels of effort, and most endpoints need only the first.

## Level 1 — Configuration only

For any endpoint speaking a protocol this package already implements, adding it
is **configuration**. No new file, no new folder, no edit to the SDK.

```ts
import { openAiResponsesProtocol } from '@alvin0/ai-agent-sdk-protocol-responses'
import { createHttpProvider } from '@alvin0/ai-agent-sdk-provider-http'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node/env'

registry.registerAdapter(['openrouter'], createHttpProvider({
  displayName: 'OpenRouter',
  protocol: openAiResponsesProtocol,
  baseUrl: 'https://openrouter.ai/api/v1',
  auth: { kind: 'bearer', token: envCredential('OPENROUTER_API_KEY') },
}))
```

Three protocols ship today:

| Protocol | Package |
| --- | --- |
| OpenAI Responses / Codex | `@alvin0/ai-agent-sdk-protocol-responses` |
| Anthropic Messages | `@alvin0/ai-agent-sdk-protocol-anthropic-messages` |
| Gemini Interactions | `@alvin0/ai-agent-sdk-protocol-gemini-interactions` |

All three are Universal, own no endpoint or credentials, and depend only on
`@alvin0/ai-agent-sdk-core`.

### OAuth needs no subclass

`auth: { kind: 'dynamic' }` covers refreshing credentials. The built-in `codex`
provider is itself only configuration on top of the Responses protocol.

## Level 2 — Runtime provider plugin

For a package you intend to publish, wrap the adapter in a transactional plugin
so the runtime can activate and remove the registration:

```ts
import { createRuntimeHttpProvider } from '@alvin0/ai-agent-sdk-provider-http'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'

export const myProviderPlugin = defineModelProviderPlugin({
  id: 'my-provider',
  displayName: 'My Provider',
  routes: ['my-provider'],
  setup(registrar) {
    // The registrar takes the adapter FIRST, then its routes — the opposite
    // order from ModelRegistry.registerAdapter().
    registrar.registerAdapter(createRuntimeHttpProvider({
      displayName: 'My Provider',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://api.example.com/v1',
      auth: { kind: 'bearer', token: options.apiKey },
    }), ['my-provider'])
    return undefined
  },
})
```

The two `registerAdapter` overloads take their arguments in **opposite orders**,
and nothing but the type checker will tell you:

```ts
registry.registerAdapter(routes, adapter)     // ModelRegistry: routes first
registrar.registerAdapter(adapter, routes?)   // plugin registrar: adapter first
```

The plugin declares its route claims up front, so normal runtime conflicts fail
**before setup completes** rather than at first use. The registrar handle is
activation-scoped: a middleware or cleanup registered during setup is removed
with the registration.

Provider factories are complete and **inert** — creating one performs no I/O.
The custom id is also the default route, which hides transitive HTTP/protocol
support without losing provider options.

## Level 3 — Subclass `HttpModelAdapter`

Subclass only when connection facts **cannot be expressed as data** — request
signing over the body, such as AWS SigV4.

Even then, you supply four things and inherit everything else:

| You implement | The base class owns |
| --- | --- |
| `connect` | `stream()` |
| `endpointPath` | Attribution headers |
| `buildBody` | Abort handling |
| `translate` | Error code assignment |

That split is why a provider cannot accidentally ship its own fetch loop that
forgets attribution headers, mishandles abort, or invents error codes.

For a fully non-HTTP provider, the direct `ModelAdapter` author surface remains
public, along with activation-scoped registrar handles and middleware.

## Declaring model capabilities

An adapter may declare combined context capacity, default and hard output limits,
reasoning efforts, modalities, and supported native tools. `ModelRegistry`
validates and snapshots those and rejects impossible selections before dispatch.

Declaring them accurately is what makes automatic compaction reserve the right
output headroom and what turns an unsupported selection into a clear
`UNSUPPORTED_*` error instead of a provider 400.

## Writing a new protocol

A protocol package owns the wire schema, request serializer, stream translator,
and dialect record. It owns **no** endpoint, credentials, fetch implementation,
filesystem access, or Node APIs.

Two constraints worth knowing:

- **Serialization is synchronous and JSON-object-only**, with bounded
  pre-dispatch validation and detachment, and one encoded request body reused
  across retries.
- **SSE parsing is provider-local and exact-pinned**, with media-type checks,
  byte/chunk/event bounds, comment-heartbeat activity, linear draining, and one
  required terminal finish.

## Verify with the conformance suite

`@alvin0/ai-agent-sdk-testkit` drives a fresh provider fixture through marker preflight,
route conflicts, rollback, streaming, usage, retries, cancellation, catalog
behavior, bounded-stream failure, observation privacy/correlation,
cleanup-failure containment, and idempotent cleanup.

```ts
import { runProviderConformanceSuite } from '@alvin0/ai-agent-sdk-testkit'

const report = await runProviderConformanceSuite(fixture)
```

It returns a frozen structured report and throws `ProviderConformanceError`
carrying that same report when any check fails, so Vitest, `node:test`, or
another harness can use it without an adapter dependency.

Provider credentials, endpoints, and raw failures must not be placed in the
control snapshot or report.

## Read next

- [Protocols](/en/09-providers/protocols) — the shipped wire protocols
- [Gemini](/en/09-providers/gemini) — the Interactions-only provider
- [Adapter pipeline](/en/11-internals/adapter-pipeline)
