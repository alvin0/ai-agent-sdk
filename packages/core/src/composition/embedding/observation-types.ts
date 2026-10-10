import type { EmbeddingSpaceId } from '../../embedding/profile.ts'
import type { EmbeddingPurpose } from '../../embedding/purpose.ts'
import type { OperationStatus, ObservationResource } from '../../observation/event.ts'
import type { ObservationPort } from '../../observation/port.ts'
import type { ModelInvocationContext } from '../../observation/report.ts'

/** Safe facts known about one `Logical_Call` before it is dispatched. */
export interface EmbeddingCallObservationFacts {
  /** Route the handle was created for. */
  readonly route: string
  readonly model: string
  readonly purpose: EmbeddingPurpose
  /** Inputs of the `Logical_Call`, cache hits included. */
  readonly itemCount: number
}

/** Safe facts describing one `Physical_Batch`; none of them is content. */
export interface EmbeddingBatchObservationFacts {
  /** Plan coordinate of the batch, in input order. */
  readonly batchIndex: number
  readonly itemCount: number
  /** UTF-8 size of the batch's text, as measured by the planner. */
  readonly byteCount: number
  readonly estimatedTokens: number
  /** Requested output dimensions, when the caller asked for a specific width. */
  readonly dimensions?: number
}

/** How one `Logical_Call` ended, in numbers only. */
export interface EmbeddingCallObservationTerminal {
  readonly status: OperationStatus
  /** Space the produced vectors live in; absent when the call never got that far. */
  readonly spaceId?: EmbeddingSpaceId
  /** Inputs served from cache, so a cache-shaped cost drop is visible. */
  readonly cacheHits: number
  /** `Provider_Attempt`s spent, retries included (Requirement 16.6). */
  readonly providerAttempts: number
  readonly error?: unknown
}

/** One `Physical_Batch` record, open until {@link end} is called. */
export interface EmbeddingBatchObservation {
  /**
   * Context to dispatch this batch with.
   *
   * Attempts started through it are parented under this batch, so retries of one
   * batch stay distinguishable from attempts on its siblings.
   */
  readonly context: ModelInvocationContext | undefined
  /** Closes the batch record. Repeat calls are ignored. */
  end(status: OperationStatus, error?: unknown): void
}

/** One `Logical_Call` record and the factory for its batch records. */
export interface EmbeddingCallObservation {
  /** Context for the call-level work: snapshot capture and cache lookup. */
  readonly context: ModelInvocationContext | undefined
  beginBatch(facts: EmbeddingBatchObservationFacts): EmbeddingBatchObservation
  /** Closes the call record. Repeat calls are ignored. */
  end(terminal: EmbeddingCallObservationTerminal): void
}

/** Where the records go, when anything is listening. */
export interface EmbeddingObservationDependencies {
  /** Caller context; its port, resource, correlation and scope win when present. */
  readonly context?: ModelInvocationContext
  /** Runtime default port, used when the context does not carry one. */
  readonly observation?: ObservationPort
  /** Runtime resource identity, used when the context does not carry one. */
  readonly resource?: ObservationResource
}

