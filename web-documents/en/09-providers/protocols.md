# Protocols

A protocol package owns the **wire schema, request serializer, stream
translator, and dialect record**. It owns no endpoint, credentials, fetch
implementation, filesystem access, or Node APIs.

All three packages are **Universal**, their only runtime dependency is
`@ai-agent-sdk/core`, composition slot is `provider-author.protocol`, and
lifecycle is `inert-value` — select one in `createRuntimeHttpProvider()` with no
startup or cleanup obligation.

---

## `@ai-agent-sdk/protocol-responses`

The OpenAI Responses / Codex wire protocol. `openai` and `codex` share this one
implementation and differ only by a small dialect record.

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/protocol-responses
```

```ts
export type {
  ProtocolDefinition, ProtocolRequest, ProtocolSseEvent, ProtocolStreamChunk,
}
export {
  OPENAI_RESPONSES_PROTOCOL_ID,
  openAiResponsesProtocol,
  type ResponsesProtocolDefinition,
}
export {
  serializeResponsesRequest,
  type ResponsesReasoningState,
}
export { translateResponsesStream }
export type * from './wire.ts'   // the complete wire schema types
```

```ts
import { openAiResponsesProtocol } from '@ai-agent-sdk/protocol-responses'

createRuntimeHttpProvider({ protocol: openAiResponsesProtocol, baseUrl, auth })
```

Supports native web search and image generation, `{ kind: 'file', fileId }` image
input, and `detail: 'original'`.

---

## `@ai-agent-sdk/protocol-gemini-interactions`

The Google Gemini Interactions wire protocol. It serializes stateless Step
history and translates the current `step.*` / `interaction.completed` SSE
events. It does not implement `generateContent` or Chat Completions.

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/protocol-gemini-interactions
```

It preserves thought signatures across function-call loops and maps JSON Schema
output to `response_format` with `application/json`.

---

## `@ai-agent-sdk/protocol-anthropic-messages`

The Anthropic Messages wire protocol.

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/protocol-anthropic-messages
```

```ts
export type {
  ProtocolDefinition, ProtocolRequest, ProtocolSseEvent, ProtocolStreamChunk,
}
export {
  ANTHROPIC_MESSAGES_PROTOCOL_ID,
  ANTHROPIC_VERSION,
  DEFAULT_THINKING_BUDGETS,
  anthropicMessagesProtocol,
  type AnthropicDialect,
  type AnthropicMessagesProtocolDefinition,
}
export {
  serializeAnthropicRequest,
  type AnthropicReasoningState,
  type AnthropicSerializeOptions,
  type ThinkingBudgets,
}
export { translateAnthropicStream }
export type * from './wire.ts'
```

Maps native web search and preserves its encrypted result/citation replay state.
Reports unsupported native image generation and file-id image input as typed
`INVALID_REQUEST` errors rather than dropping them silently.

---

## The protocol contract

```ts
interface ProtocolDefinition {
  // Build the request body from a neutral prepared call.
  serialize(request: ProtocolRequest): JsonObject
  // Translate provider SSE events into neutral stream chunks.
  translate(event: ProtocolSseEvent): readonly ProtocolStreamChunk[]
  // Endpoint-specific dialect facts.
  dialect: ProtocolDialect
}
```

Two constraints a protocol implementation must honour:

**Serialization is synchronous and JSON-object-only**, with bounded pre-dispatch
validation and detachment, and **one encoded request body reused across
retries** — a retry must not re-serialize a mutated object.

**SSE parsing is provider-local and exact-pinned**, with media-type checks,
byte/chunk/event bounds, comment-heartbeat activity, linear draining, and one
**required** terminal finish. A stream that ends without its terminating sentinel
produces `STREAM_CLOSED`, not a silently truncated message.

## Read next

- [Custom Provider](/en/09-providers/custom-provider)
- [Adapter pipeline](/en/11-internals/adapter-pipeline)
