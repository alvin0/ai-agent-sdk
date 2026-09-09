import type { GenerateOptions, StreamChunk, UsageCounters } from '@alvin0/ai-agent-sdk-core'

export interface ProtocolRequest {
  readonly options: GenerateOptions
  readonly maxTokens: number
}

export interface ProtocolSseEvent {
  readonly event: string | undefined
  readonly data: string
}

export type ProtocolStreamChunk =
  | Exclude<StreamChunk, { readonly type: 'usage' }>
  | { readonly type: 'usage'; readonly usage: UsageCounters }

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
