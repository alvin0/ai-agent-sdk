import type { ResolvedRetryPolicy } from '../../contract/retry-policy.ts'
import type { EmbeddingAdapter, PreparedEmbeddingCall } from '../../embedding/adapter.ts'
import type { EmbeddingModelOptions } from '../../embedding/handle.ts'
import type { EmbeddingSpaceId } from '../../embedding/profile.ts'
import type { EmbeddingWarning } from '../../embedding/result.ts'
import type { EmbeddingUsageReport } from '../../embedding/usage.ts'
import type { ObservationResource } from '../../observation/event.ts'
import type { ObservationPort } from '../../observation/port.ts'
import type { ModelInvocationContext } from '../../observation/report.ts'
import type { OperationLease, OperationOptions } from '../lifecycle/types.ts'
import type { EmbeddingBatchUsageEvidence } from './usage.ts'

/**
 * The admission surface this handle needs from `RuntimeOperations`.
 *
 * Structural on purpose: the handle needs a lease whose signal already fuses the
 * runtime root controller with the caller's signal, and nothing else. Declaring
 * the dependency this narrowly is what lets a test drive one `Logical_Call`
 * without standing up a whole runtime.
 */
export interface EmbeddingOperationScheduler {
  execute<T>(
    kind: 'embedding-call',
    options: OperationOptions,
    work: (lease: OperationLease) => Promise<T>,
  ): Promise<T>
}

/**
 * One member of a declared fallback group.
 *
 * `compatibilityIdentity` is REQUIRED, and that is the whole point: a fallback is
 * only legitimate when the provider has declared that the two models share an
 * embedding space. Naming a model id alone would ask the runtime to infer
 * compatibility from a name, which is exactly what Requirement 6.3 forbids.
 */
export interface EmbeddingFallbackDeclaration {
  readonly model: string
  /** The provider's declaration that this model shares the primary's space. */
  readonly compatibilityIdentity: string
}

/**
 * Handle configuration: the public {@link EmbeddingModelOptions} plus the two
 * fields that only exist to make a fallback group checkable.
 *
 * These live here rather than on `EmbeddingModelOptions` because they are
 * runtime configuration of one handle, not part of the type-only public surface
 * that `embedding/handle.ts` owns.
 */
export interface EmbeddingHandleOptions extends EmbeddingModelOptions {
  /**
   * The `compatibilityIdentity` the caller believes this route resolves to.
   *
   * When present it is enforced against the prepared call, so a route whose
   * declared identity has changed fails loudly instead of quietly producing
   * vectors in another space.
   */
  readonly compatibilityIdentity?: string
  /** Models declared to share this call's embedding space. */
  readonly fallback?: readonly EmbeddingFallbackDeclaration[]
}

/** Everything {@link createEmbeddingModelHandle} needs, resolved by the manager. */
export interface EmbeddingHandleDependencies {
  /** Runtime admission; supplies the lease whose signal covers `close()`. */
  readonly operations: EmbeddingOperationScheduler
  /** The adapter the registry resolved for this route + model. */
  readonly adapter: Pick<EmbeddingAdapter, 'prepareEmbeddingCall'>
  readonly options: EmbeddingHandleOptions
  /** Route policy captured at registration; omission takes the SDK defaults. */
  readonly retryPolicy?: ResolvedRetryPolicy
  /**
   * Caller invocation context.
   *
   * Its port, resource, correlation and scope are adopted so an embedding call
   * nested in a larger trace joins that trace. When it already performs attempt
   * accounting, that accounting is kept and this handle adds none of its own.
   */
  readonly context?: ModelInvocationContext
  /** Runtime default observation port, used when the context carries none. */
  readonly observation?: ObservationPort
  /** Runtime resource identity, used when the context carries none. */
  readonly resource?: ObservationResource
}

/** One settled batch's small, order-independent residue. */
export interface BatchResidue {
  readonly evidence: EmbeddingBatchUsageEvidence
  readonly warnings: readonly EmbeddingWarning[]
}

/**
 * Facts a `Logical_Call` learns as it progresses, reported outward so the
 * terminal observation record is accurate even when the call fails.
 *
 * Every field is optional because each becomes known at a different point, and a
 * field that is not yet known must stay absent rather than be reported as zero.
 */
export interface LogicalCallEvidence {
  readonly space?: EmbeddingSpaceId
  readonly cacheHits?: number
  readonly providerAttempts?: number
}

/** What one `Logical_Call` produces, before it is shaped into one of two results. */
export interface LogicalCallOutcome {
  readonly vectors: readonly (readonly number[])[]
  readonly space: EmbeddingSpaceId
  readonly prepared: PreparedEmbeddingCall
  readonly usage: EmbeddingUsageReport
  readonly warnings: readonly EmbeddingWarning[]
}

