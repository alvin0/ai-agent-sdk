# Providers — routing, dialects, authoring

## Two layers, one rule

**Adapters are the only layer that knows a wire format.** A provider supplies
four things — `connect`, `endpointPath`, `buildBody`, `translate` — and
`stream()` lives in the base class. That is what stops a provider from shipping
its own fetch loop that forgets attribution headers, mishandles abort, or
invents error codes.

`openai` and `codex` share **one** Responses implementation
(`@alvin0/ai-agent-sdk-protocol-responses`) and differ only by a dialect record:
base URL, auth, and which optional fields the endpoint accepts.

## Three protocols ship today

| Protocol | Package |
| --- | --- |
| OpenAI Responses / Codex | `@alvin0/ai-agent-sdk-protocol-responses` |
| Anthropic Messages | `@alvin0/ai-agent-sdk-protocol-anthropic-messages` |
| Gemini Interactions | `@alvin0/ai-agent-sdk-protocol-gemini-interactions` |

All three are Universal, own no endpoint or credentials, and depend only on
`@alvin0/ai-agent-sdk-core`.

## The registerAdapter trap

Two methods with the same name take their arguments in **opposite orders**.
Nothing but the type checker will catch it:

```ts
registry.registerAdapter(routes, adapter)     // ModelRegistry: routes FIRST
registrar.registerAdapter(adapter, routes?)   // plugin registrar: adapter FIRST
```

## Level 1 — configuration only

For any endpoint speaking a protocol the SDK already implements, adding it is
configuration. No new file, no SDK edit.

```ts
import { createHttpProvider } from '@alvin0/ai-agent-sdk-provider-http'
import { openAiResponsesProtocol } from '@alvin0/ai-agent-sdk-protocol-responses'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node/env'

registry.registerAdapter(['openrouter'], createHttpProvider({
  displayName: 'OpenRouter',
  protocol: openAiResponsesProtocol,
  baseUrl: 'https://openrouter.ai/api/v1',
  auth: { kind: 'bearer', token: envCredential('OPENROUTER_API_KEY') },
}))
```

`HttpProviderOptions` in full: `displayName`, `protocol`, `baseUrl`, `auth`
(required), plus `allowInsecureHttp`, `fetch`, `dialect` (a `Partial<Dialect>`
merged over protocol defaults), `headers`, `models`, and the timeout/size
bounds.

### Auth schemes

```ts
type AuthScheme =
  | { kind: 'none' }
  | { kind: 'bearer'; token: CredentialSource; label?: string }
  | { kind: 'header'; name: string; value: CredentialSource; label?: string }
  | { kind: 'dynamic'
      resolve: (signal?: AbortSignal, context?: ModelInvocationContext, provider?: string)
        => Record<string, string> | Promise<Record<string, string>> }
```

**Careful:** `CredentialSource` here is the `provider-http` one —
`string | ((signal?, context?) => string | Promise<string>)`, a function is
fine. That is a *different* type from the core `CredentialSource` object the
runtime plugins take. See references/packages.md.

`kind: 'dynamic'` is the OAuth escape hatch: called once per operation, so it
can refresh a token, read a rotating secret, or add account-scoping headers. The
built-in `codex` provider is itself only configuration over the Responses
protocol.

## Level 2 — a transactional runtime plugin

For a package you intend to publish:

```ts
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { createRuntimeHttpProvider } from '@alvin0/ai-agent-sdk-provider-http'

export const myProviderPlugin = defineModelProviderPlugin({
  id: 'my-provider',
  displayName: 'My Provider',        // required
  routes: ['my-provider'],           // required: the claims declared up front
  setup(registrar) {
    registrar.registerAdapter(createRuntimeHttpProvider({
      displayName: 'My Provider',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://api.example.com/v1',
      auth: { kind: 'bearer', token: options.apiKey },
    }), ['my-provider'])
    return undefined                 // or a cleanup function
  },
})
```

```ts
interface ComposableModelProviderRegistrar {
  readonly logger: SdkLogger
  registerAdapter(adapter: ModelAdapter, routes?: readonly string[]): AdapterRegistrationHandle
  use(middleware: StreamMiddleware): () => void
}
```

Route claims are declared up front, so a conflict fails **before setup
completes** rather than at first use. The registrar handle is
activation-scoped: middleware or cleanup registered during setup is removed
with the registration. Factories are complete and **inert** — creating one
performs no I/O.

## Level 3 — subclass `HttpModelAdapter`

Only when connection facts cannot be expressed as data — request signing over
the body, such as AWS SigV4. Even then you supply four things and inherit the
rest:

| You implement | The base class owns |
| --- | --- |
| `connect` | `stream()` |
| `endpointPath` | Attribution headers |
| `buildBody` | Abort handling |
| `translate` | Error code assignment |

For a fully non-HTTP provider, the `ModelAdapter` author surface stays public.

## What the registry enforces before any I/O

`ModelRegistry` validates and snapshots each adapter's declared capabilities.
`prepareCall()` returns a **generation-bound** capability snapshot: combined
context window, default and hard output limits, reasoning efforts, input/output
modalities, explicit native-tool support.

Before provider I/O it rejects an unsupported reasoning effort
(`UNSUPPORTED_REASONING_EFFORT`), an unsupported native tool
(`UNSUPPORTED_NATIVE_TOOL`), and an output selection above the hard ceiling
(`OUTPUT_TOKEN_LIMIT_EXCEEDED`); it projects image input away only for models
that explicitly lack vision, and prevents an output reservation from consuming
the whole context window. These are execution invariants, not catalog
decoration.

## Retry is a decorator

```ts
registry.registerAdapter(['openai'], withRetry(openAiAdapter({ apiKey }), {
  policy: { mode: 'normal', maxRetries: 3 },
  onRetry: attempt => console.warn(`retry ${attempt.attempt}: ${attempt.failure.code}`),
}))
```

It only retries failures that occur **before the first chunk reaches the
consumer** — replaying delivered tokens would duplicate output. The adapter
assigns a stable `code` at the wire boundary; **policy** decides which codes are
eligible. `mode: 'always'` is accepted only when the request carries an
`AbortSignal`. See references/errors.md for the code table.

## Per-provider notes

| Route | Endpoint | Credential | Notes |
| --- | --- | --- | --- |
| `anthropic` | Messages API | injected `apiKey` | — |
| `openai` | Responses API | injected `apiKey` | prefer for production |
| `codex` | ChatGPT-backed Codex | injected `CodexAuthStore` | discovers its catalog from the endpoint, because available models depend on the account plan |
| `gemini` | Gemini Interactions | injected `apiKey` | — |

The Codex endpoint serves the Codex CLI and identifies its client with an
`originator` header; the adapter defaults to the CLI's value so requests are
accepted. On Node, `@alvin0/ai-agent-sdk-auth-node/codex` adds project-local
device-code login.

## Multiple accounts of one family

Provider instances carry explicit IDs and routes, so `{ provider: 'openai-eu' }`
and `{ provider: 'openai-us' }` are unambiguous. `runtime.providers()` reports
one row per route:

```ts
interface RuntimeProviderInfo {
  readonly id: string
  readonly name: string
  readonly route: string
  readonly pluginId: string
  readonly family: string
  readonly defaultModel?: ModelTarget
}
```
