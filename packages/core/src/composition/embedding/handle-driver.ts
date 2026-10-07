import type { ResolvedRetryPolicy } from '../../contract/retry-policy.ts'
import type { EmbeddingAdapter, PreparedEmbeddingCall } from '../../embedding/adapter.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../embedding/errors.ts'
import type { EmbeddingCacheOptions } from '../../embedding/handle.ts'
import type { EmbeddingSpaceId } from '../../embedding/profile.ts'
import type { EmbeddingPurpose } from '../../embedding/purpose.ts'
import type { EmbeddingItem, EmbeddingTruncation } from '../../embedding/request.ts'
import { validatePreDispatch } from '../../embedding/validation.ts'
import type { OperationLease } from '../lifecycle/types.ts'
import type { EmbeddingCallObservation } from './observation.ts'
import { runBatchesWithConcurrency } from './limiter.ts'
import { planEmbeddingBatches } from './planner.ts'
import { createEmbeddingRetryLedger } from './retry.ts'
import { aggregateEmbeddingUsage } from './usage.ts'
import { configurationError, partitionByCache } from './handle-support.ts'
import { EmbeddingBatchRunner } from './handle-batch.ts'
import type { BatchResidue, EmbeddingHandleOptions, EmbeddingOperationScheduler,
  LogicalCallEvidence, LogicalCallOutcome } from './handle-types.ts'

interface HandleExecution {
  readonly adapter: Pick<EmbeddingAdapter, 'prepareEmbeddingCall'>
  readonly operations: EmbeddingOperationScheduler
  readonly options: EmbeddingHandleOptions
  readonly retryPolicy: ResolvedRetryPolicy | undefined
  readonly provider: string
  readonly model: string
  readonly truncation: EmbeddingTruncation
  readonly concurrency: number
  readonly cache: EmbeddingCacheOptions | undefined
  readonly groupIdentity: string | undefined
}

interface LogicalCallInput {
  readonly signal: AbortSignal | undefined
  readonly expectedSpace: EmbeddingSpaceId | undefined
  readonly report: (evidence: LogicalCallEvidence) => void
}

interface AdmittedCall {
  readonly observation: EmbeddingCallObservation
  readonly purpose: EmbeddingPurpose
  readonly items: readonly EmbeddingItem[]
  readonly input: LogicalCallInput
}

interface CallResults {
  readonly results: (readonly number[] | undefined)[]
  readonly residues: Map<number, BatchResidue>
}

export class EmbeddingHandleDriver {
  constructor(private readonly execution: HandleExecution) {}

  async run(
    observation: EmbeddingCallObservation, purpose: EmbeddingPurpose,
    items: readonly EmbeddingItem[], input: LogicalCallInput,
  ): Promise<LogicalCallOutcome> {
    return this.execution.operations.execute(
      'embedding-call', input.signal === undefined ? {} : { signal: input.signal },
      lease => this.executeLease({ observation, purpose, items, input }, lease),
    )
  }

  private assertDeclaredIdentity(prepared: PreparedEmbeddingCall): void {
    const { groupIdentity, provider } = this.execution
    if (groupIdentity === undefined) return
    if (prepared.profile.compatibilityIdentity === groupIdentity) return
    throw configurationError(
      `embedding fallback group declares compatibility identity "${groupIdentity}" `
      + `but route "${provider}" resolved "${prepared.profile.compatibilityIdentity}"`,
    )
  }

  private validatePrepared(call: AdmittedCall, prepared: PreparedEmbeddingCall): void {
    const { options, truncation } = this.execution
    this.assertDeclaredIdentity(prepared)
    call.input.report({ space: prepared.spaceId })
    validatePreDispatch({
      purpose: call.purpose, items: call.items,
      ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }), truncation,
      ...(call.input.expectedSpace === undefined ? {} : { expectedSpace: call.input.expectedSpace }),
    }, prepared)
  }

  private async executeLease(call: AdmittedCall, lease: OperationLease): Promise<LogicalCallOutcome> {
    const { adapter, provider, model, options, truncation, cache, retryPolicy, concurrency } = this.execution
    const { observation, purpose, items, input } = call
    // Capture one generation before validation, cache lookup, and every dispatch.
    const prepared = await adapter.prepareEmbeddingCall(provider, model, {
      ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
      ...(options.batchLimits === undefined ? {} : { limits: options.batchLimits }),
    }, lease.signal, observation.context)
    this.validatePrepared(call, prepared)
    const results = new Array<readonly number[] | undefined>(items.length)
    const cacheKeys = new Map<number, string>()
    const pending = cache === undefined ? items
      : await partitionByCache(cache, items, prepared, { purpose, results, keys: cacheKeys })
    input.report({ cacheHits: items.length - pending.length })
    const ledger = createEmbeddingRetryLedger(prepared, {
      ...(retryPolicy === undefined ? {} : { policy: retryPolicy }), signal: lease.signal,
      ...(observation.context === undefined ? {} : { context: observation.context }),
    })
    const residues = new Map<number, BatchResidue>()
    const runner = new EmbeddingBatchRunner({
      provider, model, purpose, options, truncation, lease, prepared, observation, ledger,
      results, cacheKeys, cache, report: input.report, residues,
    })
    const outcome = await runBatchesWithConcurrency(
      planEmbeddingBatches(pending, prepared.limits), plan => runner.run(plan),
      { concurrency, signal: lease.signal },
    )
    if (outcome.aborted) throw new EmbeddingError(
      'embedding call aborted before every batch was dispatched', EMBEDDING_ERROR_CODES.ABORTED,
      { provider, model, space: prepared.spaceId },
    )
    return this.completeCall(items.length, prepared, { results, residues })
  }

  private completeCall(
    inputCount: number, prepared: PreparedEmbeddingCall, state: CallResults,
  ): LogicalCallOutcome {
    const ordered = [...state.residues.keys()].sort((left, right) => left - right)
    const usage = aggregateEmbeddingUsage({
      inputCount, batches: ordered.map(index => state.residues.get(index)!.evidence),
    })
    const warnings = [
      ...ordered.flatMap(index => state.residues.get(index)!.warnings), ...usage.warnings,
    ]
    const vectors = state.results.map((values, index) => {
      if (values !== undefined) return values
      throw new EmbeddingError(
        'embedding call produced no vector for an input', EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
        { provider: this.execution.provider, model: this.execution.model, itemIndexes: [index] },
      )
    })
    return { vectors, space: prepared.spaceId, prepared, usage: usage.report, warnings: Object.freeze(warnings) }
  }
}
