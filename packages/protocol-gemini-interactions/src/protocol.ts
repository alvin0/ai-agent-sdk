import type { ProtocolDefinition, ProtocolRequest, ProtocolSseEvent, ProtocolStreamChunk } from './contract.ts'
import { serializeGeminiInteractionsRequest } from './serialize.ts'
import { translateGeminiInteractionsStream } from './translate.ts'
import type { GeminiInteractionsDialect } from './wire.ts'

export const GEMINI_INTERACTIONS_PROTOCOL_ID = 'gemini-interactions'

const DEFAULT_DIALECT: GeminiInteractionsDialect = Object.freeze({
  store: false,
  thinkingSummaries: 'auto',
})

export interface GeminiInteractionsProtocolDefinition {
  readonly kind: 'http-wire-protocol'
  readonly apiVersion: 1
  readonly id: string
  readonly defaultDialect: GeminiInteractionsDialect
  readonly endpointPath: () => '/interactions'
  readonly serialize: (
    request: ProtocolRequest,
    dialect: GeminiInteractionsDialect,
  ) => Readonly<Record<string, unknown>>
  readonly translate: (
    events: AsyncIterable<ProtocolSseEvent>,
    request: ProtocolRequest,
    displayName: string,
  ) => AsyncGenerator<ProtocolStreamChunk>
}

export const geminiInteractionsProtocol: ProtocolDefinition<GeminiInteractionsDialect>
  & GeminiInteractionsProtocolDefinition = Object.freeze({
  kind: 'http-wire-protocol' as const,
  apiVersion: 1 as const,
  id: GEMINI_INTERACTIONS_PROTOCOL_ID,
  defaultDialect: DEFAULT_DIALECT,
  endpointPath: () => '/interactions' as const,
  serialize(request: ProtocolRequest, dialect: GeminiInteractionsDialect): Readonly<Record<string, unknown>> {
    return serializeGeminiInteractionsRequest(request, dialect) as unknown as Readonly<Record<string, unknown>>
  },
  translate: (
    events: AsyncIterable<ProtocolSseEvent>,
    request: ProtocolRequest,
    displayName: string,
  ): AsyncGenerator<ProtocolStreamChunk> => translateGeminiInteractionsStream(events, displayName, request),
})
