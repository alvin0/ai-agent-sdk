# Gemini

Runtime: **Universal** — Edge/Worker, browser, Deno, Bun, and Node.
Composition slot: `runtime.providers`.

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/provider-gemini
```

This provider targets **only** Google's Gemini Interactions API:

```text
POST https://generativelanguage.googleapis.com/v1beta/interactions
```

It does not call `generateContent` and does not use Gemini's OpenAI-compatible
Chat Completions endpoint.

## Compose it

```ts
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { geminiPlugin } from '@ai-agent-sdk/provider-gemini'

const runtime = await createAgentRuntime({
  providers: [geminiPlugin({ apiKey: () => secretStore.get('gemini') })],
})

const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'gemini', id: 'gemini-3-flash-preview' },
})
```

The Universal provider never reads `.env`, files, or `process.env`. On Node,
environment lookup is an optional host-side convenience:

```ts
import { envCredential } from '@ai-agent-sdk/auth-node'

geminiPlugin({ apiKey: envCredential('GEMINI_KEY') })
```

You can inject a Worker secret, vault lookup, or rotating async resolver instead.

## Structured output and tool loops

`outputFormat: { type: 'json_schema' }` maps to the Interactions
`response_format` object with `mime_type: 'application/json'`. Ordinary process
rounds stay provider-native; the SDK's separate final round applies the schema
after tools are disabled.

The adapter uses stateless history by default (`store: false`). It replays
`user_input`, `model_output`, `thought` signatures, `function_call`, and
`function_result` steps, so short and long host-tool loops use the same agent
contract as other providers.

## Supported surface

| Capability | Support |
| --- | --- |
| Streaming text | ✓ |
| Host function calls and results | ✓ |
| Stateless multi-turn replay | ✓, including thought signatures |
| JSON Schema output | ✓ |
| Image input | ✓, URL/URI and base64 |
| Bare native Google Search | ✓ |
| SDK domain/location/search-size filters | ✗ typed `INVALID_REQUEST` |
| Native image-generation tool | ✗ typed `INVALID_REQUEST` |

No model IDs are baked in. Supply `model.id` explicitly and optionally provide
`models` metadata when you need exact context, output, reasoning, or modality
capabilities.

## Live repository test

The repository's human test may load `.env` solely for local acceptance:

```dotenv
GEMINI_KEY=...
GEMINI_MODEL=...
```

```bash
pnpm human:structured-output -- --provider gemini --scenario short
pnpm human:structured-output -- --provider gemini --scenario long
```

This `.env` convention belongs to the test harness, not the provider API.

## Exports

```ts
export {
  GEMINI_BASE_URL,
  geminiAdapter,
  geminiPlugin,
  type GeminiAdapterOptions,
  type GeminiCredential,
  type GeminiPluginOptions,
  type GeminiProviderOptions,
}
export { geminiInteractionsProtocol, type GeminiInteractionsDialect }
```

## Official references

- [Gemini API quickstart](https://ai.google.dev/gemini-api/docs/get-started)
- [Interactions API reference](https://ai.google.dev/api/interactions-api)
- [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
