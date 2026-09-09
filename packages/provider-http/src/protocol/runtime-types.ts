import type {
  GenerateOptions,
  ModelInvocationContext,
  ResolvedModelInfo,
  StreamChunk,
  UsageCounters,
} from '@alvin0/ai-agent-sdk-core/provider'
import type { HTTP_PROTOCOL_API_VERSION } from './config.ts'
import type { HttpConnection } from '../base/http-adapter.ts'

export interface ProtocolSseEvent {
  readonly event: string | undefined
  readonly data: string
}

export type ProtocolStreamChunk =
  | Exclude<StreamChunk, { readonly type: 'usage' }>
  | { readonly type: 'usage'; readonly usage: UsageCounters }

export interface ProtocolRequest {
  readonly options: GenerateOptions
  readonly model: ResolvedModelInfo
  readonly connection: HttpConnection
  readonly maxTokens: number
}

/** Versioned executable protocol accepted by the runtime HTTP adapter. */
export interface RuntimeWireProtocol<Dialect extends object> {
  readonly kind: 'http-wire-protocol'
  readonly apiVersion: typeof HTTP_PROTOCOL_API_VERSION
  readonly id: string
  readonly defaultDialect: Dialect
  readonly endpointPath: (request: ProtocolRequest, dialect: Dialect) => string
  readonly protocolHeaders?: (dialect: Dialect) => Readonly<Record<string, string>>
  readonly serialize: (request: ProtocolRequest, dialect: Dialect) => Readonly<Record<string, unknown>>
  readonly translate: (
    events: AsyncIterable<ProtocolSseEvent>,
    request: ProtocolRequest,
    displayName: string,
  ) => AsyncGenerator<ProtocolStreamChunk>
}

export type WireProtocolDefinition<Dialect extends object> = Omit<
  RuntimeWireProtocol<Dialect>,
  'kind' | 'apiVersion'
>

export interface HttpAuthResolveOptions {
  readonly provider: string
  readonly baseUrl: URL
  readonly signal: AbortSignal
  readonly context?: ModelInvocationContext
}
