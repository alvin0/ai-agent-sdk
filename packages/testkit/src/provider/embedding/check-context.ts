import {
  EMBEDDING_ERROR_CODES,
} from '@alvin0/ai-agent-sdk-core/embedding'
import {
  createCheckCollector,
  type ResolvedConformanceTimeouts,
} from '../report.ts'
import type {
  EmbeddingConformanceFixture,
} from './types.ts'

import type { BatchingEvidence  } from './case-support.ts'
export interface CheckContext {
  fixture: EmbeddingConformanceFixture
  timeouts: ResolvedConformanceTimeouts
  check: ReturnType<typeof createCheckCollector>['check']
  budget: number
  batching?: BatchingEvidence
}
/** Codes that mean "the response broke the mapping contract". */
export const MAPPING_CODES: ReadonlySet<string> = new Set([
  EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH,
  EMBEDDING_ERROR_CODES.VECTOR_INDEX_INVALID,
  EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
])

/** Codes that mean "a vector itself was unusable". */
export const VECTOR_CODES: ReadonlySet<string> = new Set([
  EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID,
  EMBEDDING_ERROR_CODES.VECTOR_DIMENSIONS_MISMATCH,
  EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
])

/**
 * Codes that mean "someone stopped this".
 *
 * A set rather than one value because three owners can be the first to notice a
 * cancellation: the embedding runtime, a transport reporting its own abort, and
 * `RuntimeOperations` sealing a lease during `close()`.
 */
export const ABORT_CODES: ReadonlySet<string> = new Set([
  EMBEDDING_ERROR_CODES.ABORTED,
  'ABORTED',
  'RUNTIME_OPERATION_ABORTED',
  'RUNTIME_CLOSING',
  'RUNTIME_CLOSED',
])

/** Dispatch states a `Provider_Attempt` may honestly report. */
export const DISPATCH_STATES: ReadonlySet<string> = new Set(['not-sent', 'sent', 'unknown'])

