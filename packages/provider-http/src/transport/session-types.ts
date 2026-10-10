import type {
  ModelFailure,
  ModelInvocationContext,
  ProviderRequestId,
  UsageCounters,
} from '@alvin0/ai-agent-sdk-core'
import type { HttpTransportConnection } from './connection.ts'
import { type ResolvedTransportLimits } from './limits.ts'

/** One serialized request body, measured before anything is sent. */
export interface PreparedWireBody {
  /** The value handed to the diagnostic observer; never re-serialized. */
  readonly value: unknown
  /** Exact bytes sent on the wire. */
  readonly encoded: string
  /** UTF-8 length of {@link encoded}. */
  readonly bytes: number
}

/**
 * How the transport obtains the body.
 *
 * A thunk exists because the pipeline that owns serialization also owns caching it
 * across repeated `stream()` calls on one prepared call, and because building the
 * body may itself do work that must observe the fused signal — which does not exist
 * until the transport creates it.
 */
export type WireBodySource =
  | PreparedWireBody
  | ((signal: AbortSignal) => PreparedWireBody | Promise<PreparedWireBody>)

/**
 * One exact wire request, observed immediately before dispatch.
 *
 * Structurally identical to the generation pipeline's record, and deliberately
 * declared here so the transport does not depend on a pipeline for its own shape.
 */
export interface WireRequestRecord {
  readonly schemaVersion: 1
  readonly type: 'provider-request'
  readonly id: string
  readonly timestamp: string
  readonly provider: string
  readonly model: string
  readonly method: 'POST'
  readonly url: string
  /** Credentials and cookies already replaced by `[REDACTED]`. */
  readonly headers: Readonly<Record<string, string>>
  /** The exact serialized value. This may contain prompts and tool output. */
  readonly body: unknown
  readonly bodyBytes: number
}

/** Everything the shared chain needs to issue ONE request. */
export interface HttpTransportRequestInput {
  /** The snapshot this request is bound to; read once, never re-read mid-request. */
  readonly connection: HttpTransportConnection
  /** Provider display name used in every message this chain raises. */
  readonly displayName: string
  /** Route being served. */
  readonly provider: string
  /** Wire model id. */
  readonly model: string
  /** Path appended to {@link HttpTransportConnection.baseUrl}. */
  readonly path: string
  /**
   * Media type this pipeline requires back.
   *
   * The transport does not enforce it — the `accept` header travels on the
   * connection snapshot and the check belongs to whoever decodes — but it is carried
   * on the session so `decode` states its expectation in one place.
   */
  readonly accept: string
  readonly body: WireBodySource
  /** The caller's cancellation, fused with the deadline and our teardown. */
  readonly signal?: AbortSignal
  readonly context?: ModelInvocationContext
  /** Override status-to-code mapping for a provider with codes of its own. */
  readonly errorCode?: (status: number, detail: string) => string
  /** Best-effort diagnostic observer; never a dispatch veto. */
  readonly observeRequest?: (record: WireRequestRecord) => Promise<void> | void
}

/** Outcome vocabulary a pipeline may report for the attempt ledger. */
export type TransportAttemptStatus = 'success' | 'error' | 'aborted' | 'unknown'

/** A response that already cleared every transport guard, plus its ledger hooks. */
export interface HttpTransportSession {
  /** The response; its body is still unread and is owned by the transport. */
  readonly response: Response
  readonly url: string
  readonly origin: string
  /** Fused signal: caller + request deadline + transport teardown. */
  readonly signal: AbortSignal
  /** Provider correlation id, when the response carried one. */
  readonly providerRequestId?: ProviderRequestId
  /**
   * The id this request's own diagnostic record carries, whether or not
   * `observeRequest` was configured to receive one. A response-side observer
   * reuses it so the two halves of one call — sent and received — correlate
   * without either side having to compute a fingerprint of its own.
   */
  readonly requestLogId: string
  /** Media type the pipeline asked for; see {@link HttpTransportRequestInput.accept}. */
  readonly accept: string
  readonly limits: ResolvedTransportLimits
  /**
   * Record a usage report as attempt evidence.
   *
   * Evidence only: whether a report is complete enough to leave the SDK as
   * `TokenUsage` is a pipeline decision, and this hook does not make it.
   */
  readonly attemptId?: string
  reportUsage(usage: UsageCounters, final?: boolean): void
  /** Record the terminal outcome the decoded stream reported. */
  reportOutcome(status: TransportAttemptStatus, failure?: ModelFailure): void
}
