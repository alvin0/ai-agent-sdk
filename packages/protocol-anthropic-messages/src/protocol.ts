/**
 * The Anthropic Messages protocol, as a reusable {@link WireProtocol}.
 *
 * @module ai-agent-sdk/providers/protocols/anthropic-messages
 */

import type {
  ProtocolDefinition,
  ProtocolRequest,
  ProtocolSseEvent,
  ProtocolStreamChunk,
} from './contract.ts'
import type { ModelTarget, ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core/provider'
import { serializeAnthropicRequest, type ThinkingBudgets } from './serialize.ts'
import { translateAnthropicStream } from './translate.ts'

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

interface RuntimeProtocolRequest extends ProtocolRequest {
  readonly model: ResolvedModelInfo
  readonly connection: {
    readonly baseUrl: string
    readonly headers: Readonly<Record<string, string>>
  }
}

/** Marker-based runtime view, kept structurally independent from provider-http. */
export interface AnthropicMessagesProtocolDefinition {
  readonly kind: 'http-wire-protocol'
  readonly apiVersion: 1
  readonly id: string
  readonly defaultDialect: AnthropicDialect
  readonly exampleModel?: ModelTarget
  readonly endpointPath: (request: RuntimeProtocolRequest, dialect: AnthropicDialect) => string
  readonly protocolHeaders?: (dialect: AnthropicDialect) => Readonly<Record<string, string>>
  readonly serialize: (
    request: RuntimeProtocolRequest,
    dialect: AnthropicDialect,
  ) => Readonly<Record<string, unknown>>
  readonly translate: (
    events: AsyncIterable<ProtocolSseEvent>,
    request: RuntimeProtocolRequest,
    displayName: string,
  ) => AsyncGenerator<ProtocolStreamChunk>
}

/** The Anthropic Messages wire protocol. */
export const anthropicMessagesProtocol: ProtocolDefinition<AnthropicDialect>
  & AnthropicMessagesProtocolDefinition = Object.freeze({
  kind: 'http-wire-protocol' as const,
  apiVersion: 1 as const,
  id: ANTHROPIC_MESSAGES_PROTOCOL_ID,
  defaultDialect: DEFAULT_DIALECT,
  endpointPath: () => '/v1/messages',
  protocolHeaders: (dialect: AnthropicDialect) => ({
    'anthropic-version': dialect.version,
    ...dialect.beta.length === 0 ? {} : { 'anthropic-beta': dialect.beta.join(',') },
  }),
  serialize(request: ProtocolRequest, dialect: AnthropicDialect): Readonly<Record<string, unknown>> {
    const body: unknown = serializeAnthropicRequest(request, { budgets: dialect.budgets })
    return body as Readonly<Record<string, unknown>>
  },
  // Params are annotated because `Object.freeze` erases the contextual typing the
  // `WireProtocol` annotation would otherwise supply.
  translate: (
    events: AsyncIterable<ProtocolSseEvent>,
    _request: ProtocolRequest,
    displayName: string,
  ): AsyncGenerator<ProtocolStreamChunk> => translateAnthropicStream(events, displayName),
})

export type { ThinkingBudgets }
