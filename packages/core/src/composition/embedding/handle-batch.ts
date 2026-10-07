import type { PreparedEmbeddingCall } from '../../embedding/adapter.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../embedding/errors.ts'
import type { EmbeddingCacheOptions } from '../../embedding/handle.ts'
import type { EmbeddingPurpose } from '../../embedding/purpose.ts'
import type { EmbeddingBatchRequest, EmbeddingTruncation } from '../../embedding/request.ts'
import { validateBatchResult } from '../../embedding/validation.ts'
import type { OperationLease } from '../lifecycle/types.ts'
import type { EmbeddingCallObservation } from './observation.ts'
import { writeEmbeddingCacheEntry } from './cache.ts'
import type { EmbeddingBatchPlan } from './planner.ts'
import type { EmbeddingBatchOutcome, EmbeddingRetryLedger } from './retry.ts'
import type { BatchResidue, EmbeddingHandleOptions, LogicalCallEvidence } from './handle-types.ts'
import { terminalStatus, truncationWarnings } from './handle-support.ts'

export interface EmbeddingBatchExecution {
  readonly provider: string
  readonly model: string
  readonly purpose: EmbeddingPurpose
  readonly options: EmbeddingHandleOptions
  readonly truncation: EmbeddingTruncation
  readonly lease: OperationLease
  readonly prepared: PreparedEmbeddingCall
  readonly observation: EmbeddingCallObservation
  readonly ledger: EmbeddingRetryLedger
  readonly results: (readonly number[] | undefined)[]
  readonly cacheKeys: Map<number, string>
  readonly cache: EmbeddingCacheOptions | undefined
  readonly report: (evidence: LogicalCallEvidence) => void
  readonly residues: Map<number, BatchResidue>
}

export class EmbeddingBatchRunner {
  private attemptsSpent = 0
  constructor(private readonly execution: EmbeddingBatchExecution) {}

  async run(plan: EmbeddingBatchPlan): Promise<void> {
    const { provider, model, purpose, options, truncation, lease, observation, ledger,
      cacheKeys, cache, prepared, report } = this.execution
    const request: EmbeddingBatchRequest = {
      provider,
      model,
      purpose,
      items: plan.items,
      ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
      truncation,
      signal: lease.signal,
    }
    // Size only: the planner already measured this batch, so describing it
    // costs nothing and reveals nothing (Requirement 16.4).
    const batchObservation = observation.beginBatch({
      batchIndex: plan.batchIndex,
      itemCount: plan.items.length,
      byteCount: plan.bytes,
      estimatedTokens: plan.estimatedTokens,
      ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
    })
    try {
      // The batch context is what parents each `Provider_Attempt` under
      // the batch that provoked it; retry accounting is unchanged.
      const settled = await ledger.dispatch(
        plan.batchIndex,
        request,
        batchObservation.context,
      )
      this.attemptsSpent += settled.attempts
      report({ providerAttempts: this.attemptsSpent })
      const vectors = this.acceptSettlement(plan, request, settled)

      if (cache !== undefined) {
        for (const vector of vectors) {
          const key = cacheKeys.get(vector.index)
          if (key === undefined) continue
          await writeEmbeddingCacheEntry(cache, key, {
            values: vector.values,
            space: prepared.spaceId,
          })
        }
      }
      batchObservation.end('success')
    } catch (error: unknown) {
      batchObservation.end(terminalStatus(error), error)
      throw error
    }
  }

  private acceptSettlement(
    plan: EmbeddingBatchPlan, request: EmbeddingBatchRequest, settled: EmbeddingBatchOutcome,
  ) {
    const { provider, model, results, residues, truncation } = this.execution
    const state = settled.state
    if (state.phase === 'failed') {
      // No fallback model: the primary's failure IS the call's failure
      // (Requirement 6.6).
      throw state.error
    }
    if (state.phase !== 'succeeded') {
      // The ledger only ever returns a terminal state. A non-terminal one
      // means the ledger contract was violated, and guessing which half of
      // the batch exists would be worse than saying so.
      throw new EmbeddingError(
        `embedding batch ${plan.batchIndex} settled in a non-terminal state`,
        EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
        { provider, model, itemIndexes: [...settled.itemIndexes] },
      )
    }

    const vectors = state.vectors
    // Guards the write below. A permuted order is fine — indexes carry
    // the mapping — but a duplicate or foreign index is a protocol fault,
    // never something to reconcile by position.
    validateBatchResult(request, { vectors })

    const truncated: number[] = []
    for (const vector of vectors) {
      results[vector.index] = vector.values
      if (vector.truncated === true) truncated.push(vector.index)
    }

    residues.set(plan.batchIndex, {
      evidence: {
        itemIndexes: settled.itemIndexes,
        attempts: settled.attempts,
        ...(settled.usage === undefined ? {} : { usage: settled.usage }),
      },
      warnings: [...settled.warnings, ...truncationWarnings(truncation, truncated)],
    })

    return vectors
  }
}
