/**
 * The OpenAI Chat Completions protocol, as a reusable wire protocol.
 *
 * Spoken by `api.openai.com`, by Azure OpenAI deployments, by editor-subscription
 * gateways, and by most self-hosted proxies. None of them needs its own
 * translation code — they differ only in the dialect knobs, which travel as data
 * ({@link ChatCompletionsDialect}) rather than as forks of the serializer.
 *
 * Nothing here names a particular endpoint. Base URL, headers and dialect all
 * arrive as parameters, which is what keeps this package reusable by any
 * OpenAI-compatible provider.
 *
 * @module ai-agent-sdk/protocols/openai-chat-completions/protocol
 */

import type {
  ProtocolDefinition,
  ProtocolRequest,
  ProtocolSseEvent,
  ProtocolStreamChunk,
} from './contract.ts'
import type { ModelTarget, ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core/provider'
import { serializeChatCompletionsRequest } from './serialize.ts'
import { translateChatCompletionsStream } from './translate.ts'
import { DEFAULT_DIALECT, type ChatCompletionsDialect } from './wire.ts'

/** Protocol id, usable as a stable string in configuration. */
export const OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID = 'openai-chat-completions'

interface RuntimeProtocolRequest extends ProtocolRequest {
  readonly model: ResolvedModelInfo
  readonly connection: {
    readonly baseUrl: string
    readonly headers: Readonly<Record<string, string>>
  }
}

/** Marker-based runtime view, kept structurally independent from provider-http. */
export interface ChatCompletionsProtocolDefinition {
  readonly kind: 'http-wire-protocol'
  readonly apiVersion: 1
  readonly id: string
  readonly defaultDialect: ChatCompletionsDialect
  readonly exampleModel?: ModelTarget
  readonly endpointPath: (
    request: RuntimeProtocolRequest,
    dialect: ChatCompletionsDialect,
  ) => string
  readonly protocolHeaders?: (
    dialect: ChatCompletionsDialect,
  ) => Readonly<Record<string, string>>
  readonly serialize: (
    request: RuntimeProtocolRequest,
    dialect: ChatCompletionsDialect,
  ) => Readonly<Record<string, unknown>>
  readonly translate: (
    events: AsyncIterable<ProtocolSseEvent>,
    request: RuntimeProtocolRequest,
    displayName: string,
  ) => AsyncGenerator<ProtocolStreamChunk>
}

/** The OpenAI Chat Completions wire protocol. */
export const openAiChatCompletionsProtocol: ProtocolDefinition<ChatCompletionsDialect>
  & ChatCompletionsProtocolDefinition = Object.freeze({
  kind: 'http-wire-protocol' as const,
  apiVersion: 1 as const,
  id: OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID,
  // Flat and finite, so the runtime's config snapshot survives it unchanged.
  defaultDialect: DEFAULT_DIALECT,
  // The path is a dialect knob: a gateway is free to mount the endpoint
  // elsewhere, and hard-coding it would make such a gateway unreachable.
  endpointPath: (_request: ProtocolRequest, dialect: ChatCompletionsDialect): string =>
    dialect.path,
  serialize(
    request: ProtocolRequest,
    dialect: ChatCompletionsDialect,
  ): Readonly<Record<string, unknown>> {
    return serializeChatCompletionsRequest(request, dialect) as unknown as Readonly<
      Record<string, unknown>
    >
  },
  // Params are annotated because `Object.freeze` erases the contextual typing the
  // `ProtocolDefinition` annotation would otherwise supply.
  translate: (
    events: AsyncIterable<ProtocolSseEvent>,
    _request: ProtocolRequest,
    displayName: string,
  ): AsyncGenerator<ProtocolStreamChunk> => translateChatCompletionsStream(events, displayName),
})

export type { ChatCompletionsDialect }
