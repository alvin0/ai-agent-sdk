import type { GenerateOptions } from '@alvin0/ai-agent-sdk-core'
import type { ModelModality, ModelReasoningInfo, ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core'
import type { NativeToolName } from '@alvin0/ai-agent-sdk-core'
import type { SseEvent } from '../stream/sse.ts'
import { DEFAULT_MAX_SSE_EVENT_CHARS, DEFAULT_MAX_SSE_EVENTS } from '../stream/config.ts'
import { type HttpTransportConnection } from '../transport/connection.ts'
import { positiveInteger } from '../transport/limits.ts'
import type { PreparedWireBody } from '../transport/session.ts'

/** Default idle bound: five minutes without a single byte is a hung stream. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** One model a provider's configuration advertises. */
export interface ProviderCatalogModel {
  /** Wire model id, passed to the provider verbatim. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional detail distinguishing similar variants. */
  description?: string
  /** Combined request/response capacity, when known. */
  contextWindow?: number
  /** Standard-price operating budget before a contextWindow override. */
  defaultContextWindow?: number
  /** Known technical ceiling; overrides cannot exceed it. */
  maxContextWindow?: number
  /** Input-token threshold for long-context pricing, when known. */
  standardPriceInputTokens?: number
  /** Per-request output cap for this model. */
  maxTokens?: number
  /** Default output budget, independently of the ceiling. Falls back to maxTokens. */
  defaultMaxTokens?: number
  /**
   * Accepted request modalities. Omission is UNKNOWN, not text-only — the
   * registry fills the SDK's own permissive default (text + image + document)
   * when neither this nor a runtime default names one. See RuntimeDefaults.
   */
  inputModalities?: readonly ModelModality[]
  /** Modalities this model route may return. */
  outputModalities?: readonly ModelModality[]
  /** Provider-native tools explicitly supported; omission means unknown. */
  nativeTools?: readonly NativeToolName[]
  /** Reasoning levels this model offers, when any. */
  reasoning?: ModelReasoningInfo
  /** Extra headers for requests to this exact model; wins over the route's own, loses to the agent's. */
  headers?: Readonly<Record<string, string>>
  /** Fields merged into this model's body; overrides the route and yields to the agent. */
  body?: Readonly<Record<string, unknown>>
}

/**
 * Everything needed to issue ONE generation request, captured as a single snapshot.
 *
 * The transport half — endpoint, headers, bounds, retry policy — is
 * {@link HttpTransportConnection} and is shared with every other pipeline in this
 * package. What this interface adds is the part only generation has: the SSE
 * decoding bounds and the advisory model catalog. The field set and the optionality
 * of every field are unchanged from before the split, so existing provider
 * configurations satisfy it exactly as they did.
 *
 * The catalog stays here deliberately. Embedding routes carry a catalog with
 * different semantics, and folding the two into one shape is precisely the
 * conflation this split avoids.
 */
export interface HttpConnection extends HttpTransportConnection {
  /** Maximum idle interval while a read is outstanding. */
  readonly streamIdleTimeoutMs: number
  /** Maximum decoded SSE events accepted from one response. */
  readonly maxSseEvents?: number
  /** Maximum characters accepted in one decoded SSE event. */
  readonly maxSseEventChars?: number
  /** Advisory catalog; requests are never restricted to it. */
  readonly models: readonly ProviderCatalogModel[]
  /**
   * Output cap applied when neither the caller nor the model entry names one.
   * Absent means this ROUTE names no default either — the registry's own
   * RuntimeDefaults tier may still fill it; if nothing does, no cap is sent.
   */
  readonly defaultMaxTokens?: number
  /**
   * Context capacity used when the selected model has no exact value. Absent
   * means this route names no default either — the registry's own
   * RuntimeDefaults/SDK-constant tier fills it instead of this connection.
   */
  readonly defaultContextWindow?: number
}

/** What {@link HttpModelAdapter.buildBody} and `translate` receive. */
export interface ProviderRequest {
  /** The normalized request, with registry-resolved defaults already applied. */
  readonly options: GenerateOptions
  /** Exact model metadata for this call. */
  readonly model: ResolvedModelInfo
  /** The connection snapshot this call is bound to. */
  readonly connection: HttpConnection
  /**
   * Output cap to send. Absent when neither the caller, the model, nor the
   * route names one — an endpoint that requires the field regardless (such as
   * Anthropic's Messages API) supplies its own fallback at the protocol layer,
   * not here.
   */
  readonly maxTokens?: number
  /** Stable code-owned agent identity, when this call belongs to one and the caller supplied it. */
  readonly agentId?: string
  /** The agent's own body fields, when it configured one. Merged in by `buildBody`, agent wins over the route. */
  readonly providerOptionsBody?: Readonly<Record<string, unknown>>
}

/**
 * One exact wire request observed immediately before the shared pipeline calls `fetch`.
 * @deprecated High-risk compatibility diagnostics; prefer structured observation.
 */
export interface ProviderRequestLogRecord {
  /** Version of this durable/debug record shape. */
  readonly schemaVersion: 1
  readonly type: 'provider-request'
  /** Locally generated correlation id; providers may assign a different id later. */
  readonly id: string
  readonly timestamp: string
  readonly provider: string
  readonly model: string
  readonly method: 'POST'
  readonly url: string
  /** Request headers with credentials and cookies replaced by `[REDACTED]`. */
  readonly headers: Readonly<Record<string, string>>
  /** Exact protocol-serialized JSON body. This may contain prompts and tool output. */
  readonly body: unknown
  readonly bodyBytes: number
}

/**
 * Optional observer for exact provider-wire requests.
 * @deprecated High-risk compatibility diagnostics; prefer structured observation.
 */
export type ProviderRequestLogger = (
  record: ProviderRequestLogRecord,
) => Promise<void> | void

/**
 * The provider's exact wire answer to one streamed call, observed once the
 * stream ends (successfully, with an error, or aborted).
 *
 * The counterpart {@link ProviderRequestLogRecord} misses entirely: a trace
 * that shows what went OUT but not what came BACK still leaves "did the
 * provider actually receive this the way I meant it" unanswered from the
 * response alone. `frames` is every decoded SSE event in arrival order,
 * BEFORE this provider's own `translate()` reshapes them into the SDK's
 * neutral `StreamChunk`s — this is the provider's own vocabulary
 * (`response.output_text.delta`, `content_block_delta`, …), not a
 * lossy summary of it.
 */
export interface ProviderResponseLogRecord {
  /** Version of this durable/debug record shape. */
  readonly schemaVersion: 1
  readonly type: 'provider-response'
  /** Same value as the matching {@link ProviderRequestLogRecord.id}. */
  readonly id: string
  readonly timestamp: string
  readonly provider: string
  readonly model: string
  readonly status: number
  /** Response headers; redacted the same way as the request's. */
  readonly headers: Readonly<Record<string, string>>
  readonly providerRequestId?: string
  /** Every decoded SSE frame, in arrival order. May contain the full answer. */
  readonly frames: readonly SseEvent[]
}

/** Optional observer for exact provider-wire responses. */
export type ProviderResponseLogger = (
  record: ProviderResponseLogRecord,
) => Promise<void> | void

/**
 * The serialized body of ONE prepared call, kept across repeated `stream()` calls.
 *
 * This stays with the pipeline rather than moving into the transport: the transport
 * issues one request and has no notion of a prepared call to cache against, and a
 * cache that outlived a request would be a way for one call's body to reach another
 * call's wire.
 */
export interface PreparedWireBodyCache {
  prepared?: Promise<PreparedWireBody>
}

/** The decoding bounds the SSE pipeline adds on top of the transport's. */
export interface ResolvedSseLimits {
  /** Maximum decoded SSE events accepted from one response. */
  readonly maxEvents: number
  /** Maximum characters accepted in one decoded SSE event. */
  readonly maxEventChars: number
}

/**
 * Resolve the SSE bounds before any transport work starts.
 *
 * Deliberately validated in the pipeline and not inside `decodeSse`: an
 * unusable bound is a configuration error, and configuration errors must not
 * arrive after a provider attempt has been opened and a request sent.
 * @param connection - the snapshot this call is bound to.
 * @returns defaulted, validated event bounds.
 */
export function resolveSseLimits(connection: HttpConnection): ResolvedSseLimits {
  return Object.freeze({
    maxEvents: positiveInteger(
      connection.maxSseEvents ?? DEFAULT_MAX_SSE_EVENTS,
      'maxSseEvents',
    ),
    maxEventChars: positiveInteger(
      connection.maxSseEventChars ?? DEFAULT_MAX_SSE_EVENT_CHARS,
      'maxSseEventChars',
    ),
  })
}

/**
 * Mirror every decoded SSE event into `sink` on the way through, unchanged.
 *
 * `sink` grows only as fast as `parseSseBounded` already lets it — bounded by
 * the SAME `maxEvents`/`maxEventChars` this generator's caller resolved — so
 * this adds no bound of its own and no risk of it drifting from the real one.
 */
export async function* tapSseEvents(
  events: AsyncGenerator<SseEvent>,
  sink: SseEvent[],
): AsyncGenerator<SseEvent> {
  for await (const event of events) {
    sink.push(event)
    yield event
  }
}

