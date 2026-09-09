# Packages, runtime tiers, credentials

## Runtime tiers

| Tier | Meaning |
| --- | --- |
| **Universal** | ECMAScript, Fetch types, Web Streams, `AbortController`, Web Crypto only. No Node built-ins, `process`, `Buffer`, paths, filesystem, child processes, stdio. Runs on Edge/Worker, Deno, Bun, browser, Node. |
| **Node** | Elevated: uses Node built-ins. Install only in a Node process. |

## The 21 published packages

| Package | Tier | Role |
| --- | --- | --- |
| `@alvin0/ai-agent-sdk-core` | Universal | Runtime, agents, sessions, tools, the loop |
| `@alvin0/ai-agent-sdk-provider-anthropic` | Universal | Messages API, injected `apiKey` |
| `@alvin0/ai-agent-sdk-provider-openai` | Universal | Responses API, injected `apiKey` |
| `@alvin0/ai-agent-sdk-provider-codex` | Universal | ChatGPT-backed Codex, injected `CodexAuthStore` |
| `@alvin0/ai-agent-sdk-provider-gemini` | Universal | Gemini Interactions API, injected `apiKey` |
| `@alvin0/ai-agent-sdk-provider-http` | Universal | Shared HTTP adapter base for custom providers |
| `@alvin0/ai-agent-sdk-protocol-responses` | Universal | One Responses implementation shared by openai + codex |
| `@alvin0/ai-agent-sdk-protocol-anthropic-messages` | Universal | Messages wire protocol |
| `@alvin0/ai-agent-sdk-protocol-gemini-interactions` | Universal | Gemini wire protocol |
| `@alvin0/ai-agent-sdk-auth-node` | Node | `envCredential()`, Codex device-code login |
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
