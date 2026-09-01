/**
 * ai-agent-sdk — build AI agents on the Anthropic Claude and OpenAI APIs.
 *
 * This entry point is the provider-neutral core: the message model, the streaming
 * protocol and its assembler, the error taxonomy, the adapter contract, and the
 * registry that routes calls.
 *
 * Providers are separate entry points so that using one does not pull in the
 * others' wire code:
 *
 * ```ts
 * import { ModelRegistry, BlockAssembler, createTextMessage } from 'ai-agent-sdk'
 * import { anthropicAdapter } from 'ai-agent-sdk/anthropic'
 * import { openAiAdapter } from 'ai-agent-sdk/openai'
 * import { codexAdapter } from 'ai-agent-sdk/codex'
 *
 * const registry = new ModelRegistry()
 * registry.registerAdapter(['openai'], openAiAdapter())
 *
 * const assembler = new BlockAssembler()
 * for await (const chunk of registry.stream({
 *   provider: 'openai',
 *   model: 'gpt-5.4',
 *   messages: [createTextMessage('hello')],
 * })) {
 *   assembler.push(chunk)
 * }
 * const reply = assembler.message({ kind: 'model', provider: 'openai', model: 'gpt-5.4' })
 * ```
 *
 * @module ai-agent-sdk
 */

export * from '@ai-agent-sdk/core'
// Compatibility ownership until provider-http extraction (P0).
export { parseSse, type SseEvent } from './core/stream/sse.ts'
export * from './agent/index.ts'

// The shared provider pipeline, for building your own endpoint.
export {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  HttpModelAdapter,
  httpErrorCode,
  parseErrorBody,
  requestIdFrom,
  retryAfterMs,
  type HttpConnection,
  type ParsedErrorBody,
  type ProviderCatalogModel,
  type ProviderRequest,
  type ProviderRequestLogger,
  type ProviderRequestLogRecord,
} from './providers/base/index.ts'

// The configuration path: add an endpoint that speaks a known protocol without
// writing an adapter, a folder, or an entry in this package's build config.
export {
  apiKeyFromEnv,
  createHttpProvider,
  type AuthScheme,
  type CredentialSource,
  type HttpProviderOptions,
  type ModelDiscoveryContext,
} from './providers/http-provider.ts'
export {
  ANTHROPIC_MESSAGES_PROTOCOL_ID,
  OPENAI_RESPONSES_PROTOCOL_ID,
  anthropicMessagesProtocol,
  openAiResponsesProtocol,
  resolveDialect,
  type AnthropicDialect,
  type ResponsesDialect,
  type WireProtocol,
} from './providers/protocols/index.ts'
