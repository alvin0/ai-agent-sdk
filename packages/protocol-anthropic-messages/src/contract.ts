import type { GenerateOptions, StreamChunk, UsageCounters } from '@ai-agent-sdk/core'

/** The request fields a pure wire protocol is allowed to inspect. */
export interface ProtocolRequest {
  readonly options: GenerateOptions
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
