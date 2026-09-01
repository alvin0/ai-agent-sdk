/**
 * The OpenAI Responses protocol, as a reusable {@link WireProtocol}.
 *
 * Spoken by `api.openai.com`, by the ChatGPT-backed Codex endpoint, and by a
 * growing number of compatible gateways. None of them needs its own translation
 * code — they differ only in the dialect knobs below.
 *
 * @module ai-agent-sdk/providers/protocols/openai-responses
 */

import type { StreamChunk } from '@ai-agent-sdk/core'
import type { SseEvent } from '../../core/stream/sse.ts'
import type { ProviderRequest } from '../base/http-adapter.ts'
import { serializeResponsesRequest } from '../responses/serialize.ts'
import { translateResponsesStream } from '../responses/translate.ts'
import type { ResponsesDialect } from '../responses/wire.ts'
import type { WireProtocol } from './protocol.ts'

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

/** The OpenAI Responses wire protocol. */
export const openAiResponsesProtocol: WireProtocol<ResponsesDialect> = Object.freeze({
  id: OPENAI_RESPONSES_PROTOCOL_ID,
  defaultDialect: DEFAULT_DIALECT,
  endpointPath: () => '/responses',
  serialize: (request: ProviderRequest, dialect: ResponsesDialect) =>
    serializeResponsesRequest(request, dialect),
  // Params are annotated because `Object.freeze` erases the contextual typing the
  // `WireProtocol` annotation would otherwise supply.
  translate: (
    events: AsyncIterable<SseEvent>,
    request: ProviderRequest,
    displayName: string,
  ): AsyncGenerator<StreamChunk> => translateResponsesStream(events, displayName, request),
})

export type { ResponsesDialect }
