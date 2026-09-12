# Packages, runtime tiers, credentials

## Runtime tiers

| Tier | Meaning |
| --- | --- |
| **Universal** | ECMAScript, Fetch types, Web Streams, `AbortController`, Web Crypto only. No Node built-ins, `process`, `Buffer`, paths, filesystem, child processes, stdio. Runs on Edge/Worker, Deno, Bun, browser, Node. |
| **Node** | Elevated: uses Node built-ins. Install only in a Node process. |

## The 23 published packages

| Package | Tier | Role |
| --- | --- | --- |
| `@alvin0/ai-agent-sdk-core` | Universal | Runtime, agents, sessions, tools, the loop |
| `@alvin0/ai-agent-sdk-provider-anthropic` | Universal | Messages API, injected `apiKey` |
| `@alvin0/ai-agent-sdk-provider-openai` | Universal | Responses API, injected `apiKey` |
| `@alvin0/ai-agent-sdk-provider-codex` | Universal | ChatGPT-backed Codex, injected `CodexAuthStore` |
| `@alvin0/ai-agent-sdk-provider-gemini` | Universal | Gemini Interactions API, injected `apiKey` |
| `@alvin0/ai-agent-sdk-provider-copilot` | Universal | GitHub Copilot subscription surface, injected `CopilotCredentialStore` |
| `@alvin0/ai-agent-sdk-provider-http` | Universal | Shared HTTP adapter base for custom providers |
| `@alvin0/ai-agent-sdk-protocol-responses` | Universal | One Responses implementation shared by openai + codex |
| `@alvin0/ai-agent-sdk-protocol-openai-chat-completions` | Universal | OpenAI Chat Completions wire protocol, dialect-configurable |
| `@alvin0/ai-agent-sdk-protocol-anthropic-messages` | Universal | Messages wire protocol |
| `@alvin0/ai-agent-sdk-protocol-gemini-interactions` | Universal | Gemini wire protocol |
| `@alvin0/ai-agent-sdk-auth-node` | Node | `envCredential()`, Codex and Copilot device-code login |
| `@alvin0/ai-agent-sdk-mcp` | Universal | MCP HTTP client + `ToolSource`; also `/server` |
| `@alvin0/ai-agent-sdk-mcp-server` | Universal | Inert `Request`/`Response` MCP server host |
| `@alvin0/ai-agent-sdk-mcp-node` | Node | MCP stdio client transport |
| `@alvin0/ai-agent-sdk-mcp-node-server` | Node | MCP stdio / `node:http` hosting |
| `@alvin0/ai-agent-sdk-skill-filesystem` | Node | `SKILL.md` folder discovery |
| `@alvin0/ai-agent-sdk-instructions-node` | Node | `AGENTS.md`-style context sections |
| `@alvin0/ai-agent-sdk-observability-fetch` | Universal | HTTPS telemetry exporter |
| `@alvin0/ai-agent-sdk-observability-browser` | Universal | IndexedDB durable queue |
| `@alvin0/ai-agent-sdk-observability-node` | Node | JSONL journal + crash recovery |
| `@alvin0/ai-agent-sdk-observability-otel` | Universal | Bridge to caller-supplied OpenTelemetry objects |
| `@alvin0/ai-agent-sdk-a2a` | Node | A2A protocol v1.0 client + server |

`@alvin0/ai-agent-sdk-a2a` is Node-elevated because the upstream binary codec
calls `Buffer.from`. Do not advertise it for Edge/Worker.

## Subpath entry points

Most packages export only `"."`. The ones that split do it along a runtime or a
capability boundary, so the smaller import pulls in less:

| Specifier | Tier | Contents |
| --- | --- | --- |
| `@alvin0/ai-agent-sdk-core/embedding` | Universal | The whole embedding contract: `EmbeddingAdapter`, request/result vocabulary, profile and `Space_Id`, purpose, embedding catalog, batch limits, `EMBEDDING_ERROR_CODES` + `EmbeddingError`, validation helpers |
| `@alvin0/ai-agent-sdk-auth-node/codex` | Node | `codexNodeProviderPlugin()` + the Universal Codex surface |
| `@alvin0/ai-agent-sdk-auth-node/copilot` | Node | `copilotNodeProviderPlugin()`, `fileCopilotCredentialStore()`, `resolveCopilotAuthPath()` + the Universal Copilot surface |
| `@alvin0/ai-agent-sdk-mcp/server` | Universal | Inert MCP server host |

`@alvin0/ai-agent-sdk-auth-node/copilot` is the one import a Node caller needs.
It re-exports the whole Universal Copilot surface so you do not import two
specifiers, and its only added behaviour is defaulting `authStore` to the
project-local file store:

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { copilotNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/copilot'

const runtime = await createAgentRuntime({ providers: [copilotNodeProviderPlugin()] })
```

Credentials land in `.providers/.copilot/auth.json` below `process.cwd()`.
Override the path with `AI_AGENT_SDK_COPILOT_AUTH`, or read the resolved location
with `resolveCopilotAuthPath()`. Same isolation reasoning as Codex: the SDK does
not share a credential file with an editor that rotates the same token.

> **`@alvin0/ai-agent-sdk-provider-copilot/embedding` does not exist.**
> `@alvin0/ai-agent-sdk-core/embedding` is a core export now, but no Copilot
> embedding adapter has been written against it. `provider-copilot` ships `"."`
> only. The repository's Copilot embedding integration test calls the remote
> `/embeddings` endpoint directly; it does not make that endpoint available via
> `runtime.embeddingModel()`. Do not write an import against that specifier; it
> will not resolve. The two SDK-integrated adapters are
> `openAiEmbeddingPlugin()` and `geminiEmbeddingPlugin()`, both from their
> provider package's `"."`.

## Where the embedding code lives

The embedding capability sits beside generation under the same runtime, in three
places — and the dependency between the first two runs one way only, checked by
the `no-circular` rule in `.dependency-cruiser.cjs`:

| Location | Owns |
| --- | --- |
| `packages/core/src/embedding/` | The contract, published as `@alvin0/ai-agent-sdk-core/embedding`. Imports nothing from `composition/` |
| `packages/core/src/composition/embedding/` | The runtime that consumes the contract: batching, concurrency, retry, optional cache, usage aggregation, order restoration, the embedding plugin kind and its startup preflight. Not published as its own specifier — its type surface reaches callers through `runtime.embeddingModel()` at the root entry point |
| `packages/provider-http/src/transport/` | The shared `Http_Transport` chain plus the JSON pipeline the embedding adapters dispatch through, next to the SSE pipeline generation uses. Exported from `provider-http`'s `"."` |

The provider adapters themselves stay in their provider packages
(`packages/provider-openai/src/embedding.ts`,
`packages/provider-gemini/src/embedding.ts`) and register through a distinct
plugin kind, `'embedding-provider-plugin'`. Nothing was added to
`ModelProviderRegistrar` and `PROVIDER_PLUGIN_API_VERSION` did not move, so an
app that only generates carries no embedding configuration:

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin, openAiEmbeddingPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const runtime = await createAgentRuntime({
  // Route claims are namespaced by operation, so both may claim 'openai'.
  providers: [openAiPlugin({ apiKey }), openAiEmbeddingPlugin({ apiKey })],
})
```

Two plugins of the *same* operation claiming one route fails construction:
`PROVIDER_ROUTE_CONFLICT` for generation, `PROVIDER_OPERATION_CONFLICT` for
embedding.

## Reusing the Chat Completions protocol for a non-Copilot endpoint

`@alvin0/ai-agent-sdk-protocol-openai-chat-completions` knows nothing about
Copilot, or about any provider. It is a wire protocol plus a dialect record, and
it is the shortest path to an OpenAI-compatible gateway that is **not** OpenAI:

```ts
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { createRuntimeHttpProvider } from '@alvin0/ai-agent-sdk-provider-http'
import { openAiChatCompletionsProtocol } from '@alvin0/ai-agent-sdk-protocol-openai-chat-completions'

export const gatewayPlugin = defineModelProviderPlugin({
  id: 'gateway',
  displayName: 'Internal Gateway',
  routes: ['gateway'],
  setup(registrar) {
    registrar.registerAdapter(createRuntimeHttpProvider({
      displayName: 'Internal Gateway',
      protocol: openAiChatCompletionsProtocol,
      baseUrl: 'https://gateway.internal/v1',
      auth: { kind: 'bearer', token: apiKey },
      dialect: {
        path: '/openai/v1/chat/completions',   // gateway mounts it elsewhere
        maxTokensField: 'max_completion_tokens',
        structuredOutputs: 'json-object',
        systemRole: 'developer',
      },
    }), ['gateway'])
    return undefined
  },
})
```

`dialect` is a `Partial<ChatCompletionsDialect>` merged over the protocol's
frozen `defaultDialect`. The four knobs that actually decide whether a gateway
answers:

| Knob | Values | Why it matters |
| --- | --- | --- |
| `maxTokensField` | `'max_tokens' \| 'max_completion_tokens' \| false` | Not a boolean, because this is exactly where OpenAI-compatible endpoints split into two families — reasoning models reject `max_tokens`, older gateways only understand it |
| `structuredOutputs` | `'json-schema' \| 'json-object' \| false` | Three-state: full schema with `strict: true`, bare JSON mode, or no `response_format` at all |
| `path` | any string | A gateway is free to mount the endpoint anywhere; a hard-coded path would make it unreachable without forking the protocol |
| `systemRole` | `'system' \| 'developer'` | Which role the system prompt travels under in `messages[0]` |

The defaults are conservative in one direction on purpose:
`parallelToolCalls`, `seed`, and `reasoningEffort` are **off**. A field an
endpoint does not understand is usually a hard HTTP 400, while a field left
unsent merely forgoes a feature — so opt in per endpoint rather than discovering
the rejection in production. Every disabled flag means the wire field is absent
entirely: no `null`, no default value.

The protocol package has one peer dependency, `core`, and no runtime dependency
on `provider-http`. Selecting it performs no I/O and carries no cleanup
obligation.

## Requirements

| Target | Requirement |
| --- | --- |
| Installed Node capability packages | Node 22.12+ |
| SDK repo tooling | Node 22.18+ |
| TypeScript | `moduleResolution: "bundler"` or `"nodenext"` |

## Install profiles — take the smallest closure

```bash
# Edge/Worker, remote provider, acknowledged HTTPS telemetry
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai \
  @alvin0/ai-agent-sdk-observability-fetch

# Browser, IndexedDB crash recovery
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai \
  @alvin0/ai-agent-sdk-observability-browser

# Node coding harness
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-auth-node \
  @alvin0/ai-agent-sdk-provider-codex @alvin0/ai-agent-sdk-mcp-node \
  @alvin0/ai-agent-sdk-observability-node @alvin0/ai-agent-sdk-skill-filesystem
```

All profiles share the same Universal core and agent loop.

## Credentials are injected, always

A plugin destined for `createAgentRuntime({ providers })` takes
`CredentialInput`, which is `string | CredentialSource` — and `CredentialSource`
here is the **core object form**, not a bare function:

```ts
interface CredentialSource {
  readonly kind: 'credential-source'
  readonly apiVersion: 1
  readonly id: string
  readonly resolve: (options: { signal: AbortSignal; logger: SdkLogger }) => string | Promise<string>
}
```

```ts
// Node, from the environment — returns CredentialSource & (() => string)
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'
openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })

// Anywhere else: a literal, or your own source
openAiPlugin({ apiKey: env.OPENAI_API_KEY })

import { defineCredentialSource } from '@alvin0/ai-agent-sdk-core/provider'
openAiPlugin({
  apiKey: defineCredentialSource({
    id: 'secret-store-openai',
    resolve: ({ signal }) => secretStore.get('openai', { signal }),
  }),
})
```

`envCredential()` is lazy, receives the model-operation cancellation signal, and
is borrowed — it has no close lifecycle.

> **Overload trap.** `openAiPlugin()` has two overloads. Passing a bare function
> (`apiKey: () => token`) matches the legacy `OpenAiPluginOptions` overload,
> which returns a `ModelProviderPlugin` — that type is **not** assignable to
> `createAgentRuntime({ providers })` and only works through
> `registry.install()`. Use a string or a `CredentialSource` object for the
> runtime path.

Codex device-code login, project-local:

```bash
pnpm exec ai-agent-sdk-codex-login            # sign in
pnpm exec ai-agent-sdk-codex-login --status   # account/status
```

Tokens land in `.providers/.codex/auth.json`, deliberately **not** the Codex
CLI's `~/.codex/auth.json`: OAuth refresh tokens are single-use and rotate, so
two programs sharing one file eventually race and log you out.

## Two provider registration styles

```ts
// Plugin — recommended. Transactional; the runtime activates and removes it.
const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey })],
})

// Adapter — manual route control.
const registry = new ModelRegistry()
registry.registerAdapter(['openai'], openAiAdapter({ apiKey }))
registry.install(plugin)   // also accepts a plugin
```

## Declaring context and output limits

```ts
openAiPlugin({
  apiKey,
  defaultContextWindow: 128_000,
  defaultMaxTokens: 8_192,
  models: [
    { id: 'model-a', contextWindow: 128_000, maxTokens: 16_384 },
    { id: 'model-b', contextWindow: 200_000, maxTokens: 32_768 },
  ],
})
```

| Setting | Meaning |
| --- | --- |
| `models[].contextWindow` | Combined input/output capacity for that exact ID |
| `models[].maxTokens` | Default output budget **and** SDK ceiling for that ID |
| `defaultContextWindow` | Fallback when the model declares none |
| `defaultMaxTokens` | Fallback default and ceiling |
| agent `maxTokens` | Output budget; may be lower than the ceiling |

Fallback is per field. Exceeding a declared ceiling rejects with
`OUTPUT_TOKEN_LIMIT_EXCEEDED` — the SDK never silently clamps. Declaring these
values does not raise real server limits.

Before any provider I/O the registry rejects an unsupported reasoning effort
(`UNSUPPORTED_REASONING_EFFORT`), an unsupported native tool
(`UNSUPPORTED_NATIVE_TOOL`), and an output reservation that would consume the
whole context window.

## Model discovery

```ts
const catalog = await runtime.modelCatalog('openai')
```

Codex discovers its catalog from the endpoint because available models depend on
the account plan. Prefer `openai` for production.

## Multiple accounts of one family

Provider instances carry explicit IDs and routes, so `{ provider: 'openai-eu' }`
and `{ provider: 'openai-us' }` are unambiguous. Discovery reports one row per
route with separate route, plugin-instance, and family identity.
