/**
 * Structural protocol contract for the OpenAI Chat Completions wire protocol.
 *
 * Declared here rather than imported from `provider-http` on purpose (DD-10):
 * a wire protocol is a pure translation layer, so its only dependency is
 * `@alvin0/ai-agent-sdk-core`, and only for types. The shapes below are
 * structurally compatible with `RuntimeWireProtocol`, which is what lets the
 * runtime HTTP adapter accept this protocol without either package importing
 * the other.
 *
 * @module ai-agent-sdk/protocols/openai-chat-completions/contract
 */

import type { GenerateOptions, StreamChunk, UsageCounters } from '@alvin0/ai-agent-sdk-core'
import type { ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core/provider'

/**
 * The request fields a pure wire protocol is allowed to inspect.
 *
 * `model` is present at every decision point — `endpointPath`, `serialize` and
 * `translate` all receive this shape — which is what makes model-keyed routing
 * possible for a composite protocol built on top of this one.
 */
export interface ProtocolRequest {
  readonly options: GenerateOptions
  readonly model: ResolvedModelInfo
  readonly maxTokens: number
}

/** One decoded SSE event, expressed without depending on an HTTP transport. */
export interface ProtocolSseEvent {
  readonly event: string | undefined
  readonly data: string
}

/** Protocol-internal chunks may carry a partial untrusted usage report. */
export type ProtocolStreamChunk =
  | Exclude<StreamChunk, { readonly type: 'usage' }>
  | { readonly type: 'usage'; readonly usage: UsageCounters }

/** Structural protocol contract implemented without importing provider-http. */
export interface ProtocolDefinition<Dialect> {
  readonly id: string
  readonly defaultDialect: Dialect
  endpointPath(request: ProtocolRequest, dialect: Dialect): string
  protocolHeaders?(dialect: Dialect): Record<string, string>
  serialize(request: ProtocolRequest, dialect: Dialect): unknown | Promise<unknown>
  translate(
    events: AsyncIterable<ProtocolSseEvent>,
    request: ProtocolRequest,
    displayName: string,
  ): AsyncGenerator<ProtocolStreamChunk>
}
