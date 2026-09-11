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

## Four protocols ship today

| Protocol | Package |
| --- | --- |
| OpenAI Responses / Codex | `@alvin0/ai-agent-sdk-protocol-responses` |
| OpenAI Chat Completions | `@alvin0/ai-agent-sdk-protocol-openai-chat-completions` |
| Anthropic Messages | `@alvin0/ai-agent-sdk-protocol-anthropic-messages` |
| Gemini Interactions | `@alvin0/ai-agent-sdk-protocol-gemini-interactions` |

All four are Universal, own no endpoint or credentials, and depend only on
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
| `copilot` | Copilot subscription surface, **both** Responses and Chat Completions | injected `CopilotCredentialStore` | discovers its catalog, and picks the endpoint per model |

The Codex endpoint serves the Codex CLI and identifies its client with an
`originator` header; the adapter defaults to the CLI's value so requests are
accepted. On Node, `@alvin0/ai-agent-sdk-auth-node/codex` adds project-local
device-code login.

## GitHub Copilot

### Setup

```bash
npm run provider:copilot:login-device   # OAuth device flow; writes the credential
npm run provider:copilot:status         # credential state + one trial token exchange
npm run provider:copilot:models         # catalog, with the endpoint chosen per model
```

The login writes a long-lived GitHub user token to
`.providers/.copilot/auth.json`, a project-local file this SDK owns, beside
`.providers/.codex/auth.json`. `AI_AGENT_SDK_COPILOT_AUTH` overrides the path;
precedence is explicit argument (`--path`) → environment → default, and a
relative path resolves against `cwd`.

`--status` is worth knowing about: the short-lived Copilot API token is never
persisted, so status performs **one real exchange** rather than reading a token
off disk. That is the only honest answer to "will a request work right now" — a
stored user token says nothing about whether the account still carries a Copilot
subscription, and the exchange surface is the thing that knows.

Then compose:

```ts
import { copilotNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/copilot'

runtime.use(copilotNodeProviderPlugin())   // defaults authStore to the file store
```

`copilotNodeProviderPlugin` is the Node path and is deliberately thin: the only
thing it adds is defaulting `authStore` to `fileCopilotCredentialStore()`.
`copilotPlugin` from `@alvin0/ai-agent-sdk-provider-copilot` is the Universal
one and takes `authStore` as a **required** injected option, because paths, the
filesystem and the environment belong to the Node package. It accepts only the
compare-and-swap store variant — transactional registration and a store with no
revisions are a poor pair.

### A personal access token does not work here

The Copilot API is reached through a two-tier credential: the GitHub user token
is exchanged at `copilot_internal/v2/token` for a short-lived API token, and
that exchange accepts **only** a token minted by an OAuth App on GitHub's
allowlist. A PAT is refused there with HTTP 403 — as is a token from a
non-allowlisted OAuth App, and the response does not distinguish the two. The
device flow is the supported way to get an accepted credential.

### `*.ghe.com` is out of scope

Data-residency tenants have no token-exchange surface at all, so the provider
refuses `ghe.com` and any host under it with `COPILOT_TENANT_UNSUPPORTED`
**before** sending anything. The match is on domain labels, not a substring, so
`notghe.com` and `ghe.com.evil.tld` are ordinary hosts. A 404 from the exchange
path is classified the same way, because a missing exchange surface is a missing
exchange surface however it is discovered.

### Endpoint selection per model

Copilot serves two wire protocols, and which models accept `/responses` depends
on the account. The router decides **once per model id**, in this order:

| Order | Source | Decision |
| --- | --- | --- |
| 1 | `override` | `endpointOverrides[modelId]`, pinned by the application |
| 2 | `catalog` | the discovered catalog disclosed an endpoint |
| 3 | `allowlist` | model id matches `COPILOT_RESPONSES_MODEL_PREFIXES` ⇒ `/responses` |
| 4 | `default` | `/chat/completions` |

There is deliberately **no probe**. Trying `/responses` to find out whether a
model accepts it is a real request that spends real quota, so it would have an
observable side effect on the account purely to answer a metadata question.

The default leans to `/chat/completions` because guessing wrong is asymmetric:
sending Chat Completions to a Responses-capable model works and loses only
Responses-specific features, while sending Responses to a model that lacks it is
an HTTP 400 and a dead request. That asymmetry is also why the prefix allowlist
is short — an absent prefix is the cheaper error.

**Careful:** decisions are **append-only** for the lifetime of the adapter
instance. Nothing rewrites a recorded decision, including a later catalog
refresh that now disagrees, because a catalog TTL expiring between two retries
would otherwise split one logical call across two wire protocols. The cost is
that a model misclassified on its first call stays that way:

```ts
copilotNodeProviderPlugin({
  endpointOverrides: { 'some-model': 'responses' },  // the instant fix
  responsesModelPrefixes: ['my-prefix-'],            // ADDS to the shipped list
  onEndpointDecision: d => console.log(d.model, d.endpoint, d.source),
})
```

`responsesModelPrefixes` adds to `COPILOT_RESPONSES_MODEL_PREFIXES` rather than
replacing it, so an override cannot silently drop a shipped prefix. An override
naming an endpoint that does not exist fails at provider construction with
`COPILOT_ENDPOINT_OVERRIDE_INVALID`, not at the first request to that model.
`--models` is the discovery path — it prints each model's chosen endpoint **and**
the `source` that decided it — and rebuilding the runtime is the reset.

### Client identity

Every request carries `Editor-Version` and `Editor-Plugin-Version`; both are
mandatory, and a missing one is an HTTP 400 surfacing as
`COPILOT_EDITOR_HEADERS_MISSING`. `editorHeaders` overrides them per field, so
overriding one keeps the other's default rather than dropping the header. The
shipped defaults were confirmed accepted against a live Copilot account on
2026-09-10.

`COPILOT_OAUTH_CLIENT_ID` is **not** confirmed. That live run was handed an
existing user token out of band, so it exercised the exchange without ever
running the device flow that would put this client id on the wire. What is
established is that the exchange surface and its allowlist check are reachable;
what is untested is whether they accept a token minted by this particular app.

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
