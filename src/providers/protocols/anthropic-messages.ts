/**
 * The Anthropic Messages protocol, as a reusable {@link WireProtocol}.
 *
 * @module ai-agent-sdk/providers/protocols/anthropic-messages
 */

import type { StreamChunk } from '@ai-agent-sdk/core'
import type { SseEvent } from '../../core/stream/sse.ts'
import { serializeAnthropicRequest, type ThinkingBudgets } from '../anthropic/serialize.ts'
import { translateAnthropicStream } from '../anthropic/translate.ts'
import type { ProviderRequest } from '../base/http-adapter.ts'
import type { WireProtocol } from './protocol.ts'

/** Protocol id, usable as a stable string in configuration. */
export const ANTHROPIC_MESSAGES_PROTOCOL_ID = 'anthropic-messages'

/**
 * The API version header value.
 *
 * Mandatory on every request. Stable across the entire lifetime of this API — new
 * capabilities arrive as opt-in beta headers rather than a version bump — which is
 * why it lives on the protocol instead of being restated by each endpoint.
 */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Default reasoning efforts, expressed as thinking-token budgets.
 *
 * Budgets rather than an opaque level because that is what this API takes. The
 * SDK's effort ids are a neutral surface over a provider-specific knob, and
 * mapping them here is the whole reason `ReasoningEffortId` is opaque.
 */
export const DEFAULT_THINKING_BUDGETS: ThinkingBudgets = Object.freeze({
  off: 0,
  low: 2_048,
  medium: 8_192,
  high: 24_576,
})

/** Per-endpoint knobs of the Messages protocol. */
export interface AnthropicDialect {
  /** Effort id to thinking-token budget. */
  readonly budgets: ThinkingBudgets
  /** `anthropic-version` header value. */
  readonly version: string
  /** Opt-in beta features, sent as `anthropic-beta`. */
  readonly beta: readonly string[]
}

const DEFAULT_DIALECT: AnthropicDialect = Object.freeze({
  budgets: DEFAULT_THINKING_BUDGETS,
  version: ANTHROPIC_VERSION,
  beta: Object.freeze([]),
})

/** The Anthropic Messages wire protocol. */
export const anthropicMessagesProtocol: WireProtocol<AnthropicDialect> = Object.freeze({
  id: ANTHROPIC_MESSAGES_PROTOCOL_ID,
  defaultDialect: DEFAULT_DIALECT,
  endpointPath: () => '/v1/messages',
  protocolHeaders: (dialect: AnthropicDialect) => ({
    'anthropic-version': dialect.version,
    ...dialect.beta.length === 0 ? {} : { 'anthropic-beta': dialect.beta.join(',') },
  }),
  serialize: (request: ProviderRequest, dialect: AnthropicDialect) =>
    serializeAnthropicRequest(request, { budgets: dialect.budgets }),
  // Params are annotated because `Object.freeze` erases the contextual typing the
  // `WireProtocol` annotation would otherwise supply.
  translate: (
    events: AsyncIterable<SseEvent>,
    _request: ProviderRequest,
    displayName: string,
  ): AsyncGenerator<StreamChunk> => translateAnthropicStream(events, displayName),
})

export type { ThinkingBudgets }
