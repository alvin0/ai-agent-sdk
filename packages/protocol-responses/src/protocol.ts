/**
 * The OpenAI Responses protocol, as a reusable {@link WireProtocol}.
 *
 * Spoken by `api.openai.com`, by the ChatGPT-backed Codex endpoint, and by a
 * growing number of compatible gateways. None of them needs its own translation
 * code — they differ only in the dialect knobs below.
 *
 * @module ai-agent-sdk/providers/protocols/openai-responses
 */

import type {
  ProtocolDefinition,
  ProtocolRequest,
  ProtocolSseEvent,
  ProtocolStreamChunk,
} from './contract.ts'
import type { ModelTarget, ResolvedModelInfo } from '@ai-agent-sdk/core/provider'
import { serializeResponsesRequest } from './serialize.ts'
import { translateResponsesStream } from './translate.ts'
import type { ResponsesDialect } from './wire.ts'

/** Protocol id, usable as a stable string in configuration. */
export const OPENAI_RESPONSES_PROTOCOL_ID = 'openai-responses'

/**
 * Conservative defaults.
 *
 * `store: false` because retaining prompts server-side should be an explicit
 * decision, not something an SDK turns on for you. `include` carries
 * `reasoning.encrypted_content` because without it a reasoning model loses its
 * chain of thought between a tool call and the tool's result.
 */
const DEFAULT_DIALECT: ResponsesDialect = Object.freeze({
  sampling: true,
  maxOutputTokens: true,
  store: false,
  include: Object.freeze(['reasoning.encrypted_content']),
  reasoningSummary: 'auto',
})

interface RuntimeProtocolRequest extends ProtocolRequest {
  readonly model: ResolvedModelInfo
  readonly connection: {
    readonly baseUrl: string
    readonly headers: Readonly<Record<string, string>>
  }
}

/** Marker-based runtime view, kept structurally independent from provider-http. */
export interface ResponsesProtocolDefinition {
  readonly kind: 'http-wire-protocol'
  readonly apiVersion: 1
  readonly id: string
  readonly defaultDialect: ResponsesDialect
  readonly exampleModel?: ModelTarget
  readonly endpointPath: (request: RuntimeProtocolRequest, dialect: ResponsesDialect) => string
  readonly protocolHeaders?: (dialect: ResponsesDialect) => Readonly<Record<string, string>>
  readonly serialize: (
    request: RuntimeProtocolRequest,
    dialect: ResponsesDialect,
  ) => Readonly<Record<string, unknown>>
  readonly translate: (
    events: AsyncIterable<ProtocolSseEvent>,
    request: RuntimeProtocolRequest,
    displayName: string,
  ) => AsyncGenerator<ProtocolStreamChunk>
}

/** The OpenAI Responses wire protocol. */
export const openAiResponsesProtocol: ProtocolDefinition<ResponsesDialect>
  & ResponsesProtocolDefinition = Object.freeze({
  kind: 'http-wire-protocol' as const,
  apiVersion: 1 as const,
  id: OPENAI_RESPONSES_PROTOCOL_ID,
  defaultDialect: DEFAULT_DIALECT,
  endpointPath: () => '/responses',
  serialize(request: ProtocolRequest, dialect: ResponsesDialect): Readonly<Record<string, unknown>> {
    return serializeResponsesRequest(request, dialect) as unknown as Readonly<Record<string, unknown>>
  },
  // Params are annotated because `Object.freeze` erases the contextual typing the
  // `WireProtocol` annotation would otherwise supply.
  translate: (
    events: AsyncIterable<ProtocolSseEvent>,
    request: ProtocolRequest,
    displayName: string,
  ): AsyncGenerator<ProtocolStreamChunk> => translateResponsesStream(events, displayName, request),
})

export type { ResponsesDialect }
