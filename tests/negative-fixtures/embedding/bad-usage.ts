/**
 * Usage payloads a provider can return that must never become published numbers.
 *
 * Placement follows `./bad-mapping.ts` (Requirement 17.11).
 *
 * Usage is the one area where the tempting repair is a `0`: an absent counter
 * looks like "nothing was used", and a malformed one looks close enough to fix.
 * Both would publish a number no provider reported. So every case here declares
 * what `validateEmbeddingUsage` must produce — in particular whether `reported`
 * survives at all — and the batch-level cases declare the
 * {@link EmbeddingUsageStatus} the `Logical_Call` must end up with.
 *
 * Note the asymmetry these cases pin down: a malformed field is dropped and
 * recorded in `invalidFields`, but a missing `inputTokens` drops the WHOLE report,
 * because a total with no input bucket describes no call anyone can audit.
 *
 * @module tests/negative-fixtures/embedding/bad-usage
 */

import type {
  EmbeddingCounterKey, EmbeddingTokenUsage, EmbeddingUsageStatus,
} from '../../../packages/core/src/embedding/usage.ts'
import type { UsageCounters } from '../../../packages/core/src/observation/usage.ts'

/** One raw usage payload and the validation outcome it must produce. */
export interface BadUsageCase {
  readonly name: string
  readonly why: string
  /** Exactly what the provider put on the wire, unknown-typed on purpose. */
  readonly payload: unknown
  /** Counters that must survive; `undefined` means nothing publishable remains. */
  readonly expectedReported?: EmbeddingTokenUsage
  /** Fields that must be recorded as rejected. */
  readonly expectedInvalidFields: readonly EmbeddingCounterKey[]
  readonly expectedComplete: boolean
  readonly expectedOverflow: boolean
}

/** A payload whose getter throws, as a hostile proxy would. */
const THROWING_PAYLOAD: unknown = new Proxy({}, {
  get(): never {
    throw new Error('usage field is not readable')
  },
  has(): boolean {
    return true
  },
})

export const BAD_USAGE_CASES: readonly BadUsageCase[] = Object.freeze([
  {
    name: 'no usage object at all',
    why: 'an unreported call is unknown, not free',
    payload: undefined,
    expectedInvalidFields: [],
    expectedComplete: false,
    expectedOverflow: false,
  },
  {
    name: 'null usage',
    why: 'null is absence with a shape, and must behave like absence',
    payload: null,
    expectedInvalidFields: [],
    expectedComplete: false,
    expectedOverflow: false,
  },
  {
    name: 'empty usage object',
    why: 'a present envelope with no counters reports nothing',
    payload: {},
    expectedInvalidFields: [],
    expectedComplete: false,
    expectedOverflow: false,
  },
  {
    name: 'string inputTokens',
    why: 'parsing "17" would publish a number the provider never sent as one',
    payload: { inputTokens: '17', totalTokens: 17 },
    expectedInvalidFields: ['inputTokens'],
    expectedComplete: false,
    expectedOverflow: false,
  },
  {
    name: 'negative inputTokens',
    why: 'no call consumes a negative number of tokens',
    payload: { inputTokens: -4 },
    expectedInvalidFields: ['inputTokens'],
    expectedComplete: false,
    expectedOverflow: false,
  },
  {
    name: 'fractional inputTokens',
    why: 'tokens are counted, not measured; rounding would invent precision',
    payload: { inputTokens: 12.5 },
    expectedInvalidFields: ['inputTokens'],
    expectedComplete: false,
    expectedOverflow: false,
  },
  {
    name: 'NaN inputTokens',
    why: 'NaN is the arithmetic residue of a failed parse upstream',
    payload: { inputTokens: Number.NaN },
    expectedInvalidFields: ['inputTokens'],
    expectedComplete: false,
    expectedOverflow: false,
  },
  {
    name: 'inputTokens past safe-integer precision',
    why: 'beyond 2^53 the count has lost authority, which is worse than a bad field',
    payload: { inputTokens: Number.MAX_SAFE_INTEGER + 2 },
    expectedInvalidFields: ['inputTokens'],
    expectedComplete: false,
    expectedOverflow: true,
  },
  {
    name: 'malformed totalTokens beside a valid inputTokens',
    why: 'the good bucket survives alone; the bad one is dropped, not derived',
    payload: { inputTokens: 9, totalTokens: 'nine' },
    expectedReported: { inputTokens: 9 },
    expectedInvalidFields: ['totalTokens'],
    expectedComplete: false,
    expectedOverflow: false,
  },
  {
    name: 'totalTokens below inputTokens',
    why: 'a total under its only disjoint bucket cannot describe the same call',
    payload: { inputTokens: 20, totalTokens: 5 },
    expectedReported: { inputTokens: 20 },
    expectedInvalidFields: ['totalTokens'],
    expectedComplete: false,
    expectedOverflow: false,
  },
  {
    name: 'totalTokens only',
    why: 'with no input bucket there is nothing honest to publish, total or not',
    payload: { totalTokens: 30 },
    expectedInvalidFields: [],
    expectedComplete: false,
    expectedOverflow: false,
  },
  {
    name: 'generation-shaped usage',
    why: 'outputTokens is not an embedding counter and must not rescue the report',
    payload: { outputTokens: 12, totalTokens: 12 },
    expectedInvalidFields: [],
    expectedComplete: false,
    expectedOverflow: false,
  },
  {
    name: 'unreadable field',
    why: 'a throwing getter is a rejected field, not a crash and not a zero',
    payload: THROWING_PAYLOAD,
    expectedInvalidFields: ['inputTokens', 'totalTokens'],
    expectedComplete: false,
    expectedOverflow: false,
  },
  {
    name: 'usage is a number',
    why: 'a scalar where an object belongs reports no counter',
    payload: 42,
    expectedInvalidFields: [],
    expectedComplete: false,
    expectedOverflow: false,
  },
  {
    name: 'usage is an array',
    why: 'an array has no named counters to read',
    payload: [8, 8],
    expectedInvalidFields: [],
    expectedComplete: false,
    expectedOverflow: false,
  },
])

/** Per-batch usage evidence and the status the whole `Logical_Call` must publish. */
export interface BadUsageStatusCase {
  readonly name: string
  readonly why: string
  /** One entry per batch actually sent to the provider, in dispatch order. */
  readonly batchUsage: readonly (UsageCounters | undefined)[]
  readonly expectedStatus: EmbeddingUsageStatus
  /** Batches whose usage was readable, which is what `status` is derived from. */
  readonly expectedBatchesWithUsage: number
  /** True when the published report must carry no `tokens` at all. */
  readonly expectedTokensOmitted: boolean
}

const GOOD: UsageCounters = Object.freeze({ inputTokens: 10, totalTokens: 10 })
const UNREADABLE = { inputTokens: '10' } as unknown as UsageCounters

export const BAD_USAGE_STATUS_CASES: readonly BadUsageStatusCase[] = Object.freeze([
  {
    name: 'one batch reports nothing',
    why: 'partial coverage must be visible, not averaged away',
    batchUsage: [GOOD, undefined],
    expectedStatus: 'partial',
    expectedBatchesWithUsage: 1,
    expectedTokensOmitted: true,
  },
  {
    name: 'one batch reports malformed usage',
    why: 'unreadable counts as unreported; it does not count as covered',
    batchUsage: [GOOD, UNREADABLE],
    expectedStatus: 'partial',
    expectedBatchesWithUsage: 1,
    expectedTokensOmitted: true,
  },
  {
    name: 'no batch reports usage',
    why: 'missing is a status, not a total of zero',
    batchUsage: [undefined, undefined],
    expectedStatus: 'missing',
    expectedBatchesWithUsage: 0,
    expectedTokensOmitted: true,
  },
  {
    name: 'every batch reports usage',
    why: 'the control: only full coverage may publish tokens',
    batchUsage: [GOOD, GOOD],
    expectedStatus: 'complete',
    expectedBatchesWithUsage: 2,
    expectedTokensOmitted: false,
  },
])
