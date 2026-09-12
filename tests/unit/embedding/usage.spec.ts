/**
 * Property and fixture tests for embedding usage honesty.
 *
 * Feature: embedding-support, Property 39: Usage không đầy đủ không bao giờ thoát
 * ra dưới dạng số liệu công bố.
 *
 * **Validates: Requirements 13.10, 16.2, 16.3**
 *
 * The claim has four independent halves, and three of them are easy to satisfy
 * vacuously:
 *
 * 1. Incomplete usage never leaves as a published number — asserted as
 *    `'tokens' in report` being equivalent to `status === 'complete'`, so a
 *    report cannot smuggle a partial sum under a `partial` label.
 * 2. No field is ever assigned a fabricated `0`. This one cannot be tested by
 *    asserting "not zero", because a provider is allowed to report a real `0`.
 *    So the generator carries the counters it intended for every payload, the
 *    expected aggregate is folded independently of the code under test, and the
 *    published `inputTokens` must equal that independent sum — a `0` invented
 *    for an unreported batch would break the equality, while an honest `0`
 *    passes.
 * 3. Unreadable usage is still evidence of a `Provider_Attempt`: the attempts of
 *    a batch whose usage could not be read must still appear in
 *    `providerAttempts`, and the batch must raise exactly one warning rather than
 *    being dropped silently — `usage-malformed` when the provider reported
 *    something unreadable, `usage-unreported` when it reported nothing at all.
 *    The two codes are counted separately, so a batch that reported nothing can
 *    neither be silent nor be described as having sent a malformed report.
 * 4. `inputsFromCache + inputsFromProvider === inputCount` holds for every
 *    generated shape, including batches that name indexes outside the
 *    `Logical_Call` range.
 * 5. The generation path keeps its current behaviour: the real SSE pipeline of
 *    `packages/provider-http` emits a `usage` chunk only for a complete report
 *    (Requirement 13.10). See the last describe block.
 *
 * The raw payloads come from the shared negative fixture
 * `tests/negative-fixtures/embedding/bad-usage.ts` rather than being restated
 * here: `BAD_USAGE_CASES` already declares, per payload, whether anything
 * publishable survives, which is exactly the oracle this property needs.
 * `BAD_USAGE_STATUS_CASES` supplies the batch-level status expectations.
 *
 * ## Why the file lives here and not where the task named it
 *
 * The task names `packages/core/tests/unit/embedding/usage.spec.ts`. No runner
 * collects that directory — root `vitest.config.ts` includes `tests/**`, and the
 * package configs reach into the ROOT `tests/` tree by relative path. A property
 * spec there would never run in CI, the one failure mode a property test must not
 * have. It sits beside `tests/unit/embedding/validation.spec.ts` instead, which
 * made the same deviation.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency. The established
 * convention (see `tests/unit/embedding/profile.spec.ts`) is a seeded mulberry32
 * generator: a failure reproduces from the printed seed and no dependency enters
 * the graph for test-only reasons. Each property runs `RUNS` cases, above the
 * spec floor of 100.
 *
 * @module tests/unit/embedding/usage.spec
 */

import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { createRuntimeHttpProvider, defineWireProtocol } from '@alvin0/ai-agent-sdk-provider-http'
import {
  aggregateEmbeddingUsage,
  type EmbeddingBatchUsageEvidence,
} from '../../../packages/core/src/composition/embedding/usage.ts'
import {
  classifyEmbeddingUsageStatus,
  validateEmbeddingUsage,
  type EmbeddingTokenUsage,
  type EmbeddingUsageStatus,
} from '../../../packages/core/src/embedding/usage.ts'
import {
  BAD_USAGE_CASES,
  BAD_USAGE_STATUS_CASES,
} from '../../negative-fixtures/embedding/bad-usage.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Number of generated cases per property; the spec floor is 100. */
const RUNS = 120

/** mulberry32 — small, fast, and reproducible from a 32-bit seed. */
function rngOf(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Rng = () => number

function intBelow(rng: Rng, bound: number): number {
  return Math.floor(rng() * bound)
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[intBelow(rng, values.length)] as T
}

/**
 * A raw payload paired with the counters it is KNOWN to report.
 *
 * `expectedReported === undefined` means nothing publishable survives it, which
 * is the fixture's own verdict for the negative cases and a deliberate choice for
 * the generated positive ones.
 */
interface PayloadCase {
  readonly payload: unknown
  readonly expectedReported?: EmbeddingTokenUsage
  /**
   * True when at least one field was rejected. A payload can be BOTH readable
   * and partly rejected — `{ inputTokens: 9, totalTokens: 'nine' }` publishes the
   * good bucket and still warns — so this is tracked separately from
   * `expectedReported`.
   */
  readonly rejectedFields: boolean
}

/** Payloads a well-behaved provider returns, including a legitimate `0`. */
const GOOD_PAYLOADS: readonly PayloadCase[] = Object.freeze([
  { payload: { inputTokens: 0, totalTokens: 0 }, expectedReported: { inputTokens: 0, totalTokens: 0 }, rejectedFields: false },
  { payload: { inputTokens: 7, totalTokens: 7 }, expectedReported: { inputTokens: 7, totalTokens: 7 }, rejectedFields: false },
  { payload: { inputTokens: 13, totalTokens: 21 }, expectedReported: { inputTokens: 13, totalTokens: 21 }, rejectedFields: false },
  { payload: { inputTokens: 5 }, expectedReported: { inputTokens: 5 }, rejectedFields: false },
  { payload: { inputTokens: 0 }, expectedReported: { inputTokens: 0 }, rejectedFields: false },
])

/** Every negative payload the fixture declares, with the fixture's own verdict. */
const BAD_PAYLOADS: readonly PayloadCase[] = Object.freeze(
  BAD_USAGE_CASES.map(badCase => ({
    payload: badCase.payload,
    ...(badCase.expectedReported === undefined ? {} : { expectedReported: badCase.expectedReported }),
    rejectedFields: badCase.expectedInvalidFields.length > 0 || badCase.expectedOverflow,
  })),
)

const ALL_PAYLOADS: readonly PayloadCase[] = Object.freeze([...GOOD_PAYLOADS, ...BAD_PAYLOADS])

/** Attempt counts, including the invalid ones the aggregator must not trust. */
const ATTEMPTS = [1, 1, 2, 3, 0, -1, 1.5, Number.NaN] as const

/** One generated batch: the evidence, plus what the test knows about it. */
interface GeneratedBatch {
  readonly evidence: EmbeddingBatchUsageEvidence
  readonly expectedReported?: EmbeddingTokenUsage
  /** True when the provider reported nothing at all, as a cache-free miss. */
  readonly absent: boolean
  /** True when at least one reported field was rejected. */
  readonly rejectedFields: boolean
}

function batchOf(rng: Rng, inputCount: number): GeneratedBatch {
  const payloadCase = pick(rng, ALL_PAYLOADS)
  const attempts = pick(rng, ATTEMPTS)
  const itemCount = 1 + intBelow(rng, 3)
  const itemIndexes: number[] = []
  for (let index = 0; index < itemCount; index += 1) {
    // Occasionally name an index outside the call so the sum invariant is
    // exercised against evidence the aggregator has to refuse to count.
    itemIndexes.push(rng() < 0.15 ? inputCount + intBelow(rng, 4) : intBelow(rng, inputCount))
  }
  const absent = payloadCase.payload === undefined
  return {
    evidence: {
      itemIndexes,
      attempts,
      ...(absent ? {} : { usage: payloadCase.payload }),
    },
    ...(payloadCase.expectedReported === undefined ? {} : { expectedReported: payloadCase.expectedReported }),
    absent,
    rejectedFields: payloadCase.rejectedFields,
  }
}

/** What the report must say, folded independently of the code under test. */
interface ExpectedAggregate {
  readonly status: EmbeddingUsageStatus
  readonly batchesWithUsage: number
  readonly providerAttempts: number
  readonly inputsFromProvider: number
  readonly malformedBatches: number
  readonly unreportedBatches: number
  readonly inputTokens: number
  readonly everyReadableBatchHasTotal: boolean
  readonly totalTokens: number
}

function expectedOf(batches: readonly GeneratedBatch[], inputCount: number): ExpectedAggregate {
  let batchesWithUsage = 0
  let providerAttempts = 0
  let malformedBatches = 0
  let unreportedBatches = 0
  let inputTokens = 0
  let totalTokens = 0
  let everyReadableBatchHasTotal = true
  const seen = new Set<number>()
  for (const batch of batches) {
    const attempts = batch.evidence.attempts
    if (Number.isSafeInteger(attempts) && attempts > 0) providerAttempts += attempts
    for (const index of batch.evidence.itemIndexes) {
      if (index >= 0 && index < inputCount) seen.add(index)
    }
    const reported = batch.expectedReported
    // A present payload warns whenever anything about it was unreadable, even if
    // a good bucket survived. Absence warns too, under its own code.
    if (batch.absent) unreportedBatches += 1
    else if (reported === undefined || batch.rejectedFields) malformedBatches += 1
    if (reported === undefined) continue
    batchesWithUsage += 1
    inputTokens += reported.inputTokens
    if (reported.totalTokens === undefined) everyReadableBatchHasTotal = false
    else totalTokens += reported.totalTokens
  }
  const status: EmbeddingUsageStatus = batchesWithUsage <= 0
    ? 'missing'
    : batchesWithUsage >= batches.length ? 'complete' : 'partial'
  return {
    status,
    batchesWithUsage,
    providerAttempts,
    inputsFromProvider: seen.size,
    malformedBatches,
    unreportedBatches,
    inputTokens,
    everyReadableBatchHasTotal,
    totalTokens,
  }
}

// ---------------------------------------------------------------------------
// Property 39
// ---------------------------------------------------------------------------

describe('Property 39: incomplete usage never escapes as a published number', () => {
  it(`holds for ${RUNS} generated Logical_Calls`, () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x39_0000 + run
      const rng = rngOf(seed)
      const inputCount = 1 + intBelow(rng, 8)
      const batchCount = intBelow(rng, 5)
      const batches: GeneratedBatch[] = []
      for (let index = 0; index < batchCount; index += 1) batches.push(batchOf(rng, inputCount))

      const expected = expectedOf(batches, inputCount)
      const { report, warnings } = aggregateEmbeddingUsage({
        inputCount,
        batches: batches.map(batch => batch.evidence),
      })
      // The context carries only the seed: one generated payload is a hostile
      // proxy whose getters throw, so it must not be walked by a matcher.
      const context = { seed }

      // Coverage is reported, never averaged away.
      expect({ ...context, status: report.status }).toEqual({ ...context, status: expected.status })
      expect(report.batchesWithUsage).toBe(expected.batchesWithUsage)
      expect(report.batches).toBe(batchCount)

      // Half 1: tokens are published for full coverage and for nothing else.
      expect({ ...context, published: 'tokens' in report })
        .toEqual({ ...context, published: expected.status === 'complete' })

      if (expected.status === 'complete') {
        // Half 2: the published number is the independently folded sum, so a
        // fabricated 0 for an unreported batch could not survive here.
        expect(report.tokens?.inputTokens).toBe(expected.inputTokens)
        expect('totalTokens' in (report.tokens as object))
          .toBe(expected.everyReadableBatchHasTotal)
        if (expected.everyReadableBatchHasTotal) {
          expect(report.tokens?.totalTokens).toBe(expected.totalTokens)
        }
        expect(report.tokens).not.toHaveProperty('outputTokens')
      }

      // Half 3: unreadable usage stays evidence of a Provider_Attempt.
      expect(report.providerAttempts).toBe(expected.providerAttempts)
      expect(warnings).toHaveLength(expected.malformedBatches + expected.unreportedBatches)
      const codes = { malformed: 0, unreported: 0 }
      for (const warning of warnings) {
        expect(['usage-malformed', 'usage-unreported']).toContain(warning.code)
        if (warning.code === 'usage-malformed') codes.malformed += 1
        else codes.unreported += 1
      }
      // Each batch that produced no publishable count says why, in its own terms:
      // silence from the provider is never reported as a malformed payload.
      expect({ ...context, ...codes })
        .toEqual({
          ...context,
          malformed: expected.malformedBatches,
          unreported: expected.unreportedBatches,
        })

      // Half 4: the two input buckets always reconstruct the call.
      expect(report.inputsFromProvider).toBe(expected.inputsFromProvider)
      expect({ ...context, sum: report.inputsFromCache + report.inputsFromProvider })
        .toEqual({ ...context, sum: inputCount })
      expect(report.inputsFromCache).toBeGreaterThanOrEqual(0)
    }
  })

  it('never publishes tokens when any dispatched batch reported nothing readable', () => {
    for (const badCase of BAD_USAGE_CASES) {
      const { report, warnings } = aggregateEmbeddingUsage({
        inputCount: 2,
        batches: [
          { itemIndexes: [0], attempts: 2, usage: { inputTokens: 11, totalTokens: 11 } },
          { itemIndexes: [1], attempts: 3, ...(badCase.payload === undefined ? {} : { usage: badCase.payload }) },
        ],
      })
      const publishable = badCase.expectedReported !== undefined
      expect({ name: badCase.name, status: report.status })
        .toEqual({ name: badCase.name, status: publishable ? 'complete' : 'partial' })
      expect({ name: badCase.name, published: 'tokens' in report })
        .toEqual({ name: badCase.name, published: publishable })
      // The failed batch is still counted: its attempts survive.
      expect({ name: badCase.name, attempts: report.providerAttempts })
        .toEqual({ name: badCase.name, attempts: 5 })
      if (!publishable) {
        // Same absence of a publishable count, two different provider facts.
        expect(warnings.map(warning => warning.code))
          .toEqual([badCase.payload === undefined ? 'usage-unreported' : 'usage-malformed'])
        expect(warnings[0]?.itemIndexes).toEqual([1])
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Fixture-driven validation
// ---------------------------------------------------------------------------

describe('validateEmbeddingUsage against the shared negative fixture', () => {
  for (const badCase of BAD_USAGE_CASES) {
    it(`${badCase.name}: ${badCase.why}`, () => {
      const validation = validateEmbeddingUsage(badCase.payload)
      expect(validation.reported).toEqual(badCase.expectedReported)
      expect([...validation.invalidFields].sort())
        .toEqual([...badCase.expectedInvalidFields].sort())
      expect(validation.complete).toBe(badCase.expectedComplete)
      expect(validation.overflow).toBe(badCase.expectedOverflow)
      // Nothing that survives is a fabricated bucket.
      if (validation.reported !== undefined) {
        expect(validation.reported).not.toHaveProperty('outputTokens')
      }
    })
  }
})

describe('aggregateEmbeddingUsage against the shared status fixture', () => {
  for (const statusCase of BAD_USAGE_STATUS_CASES) {
    it(`${statusCase.name}: ${statusCase.why}`, () => {
      const batches: EmbeddingBatchUsageEvidence[] = statusCase.batchUsage.map((usage, index) => ({
        itemIndexes: [index],
        attempts: 1,
        ...(usage === undefined ? {} : { usage }),
      }))
      const { report } = aggregateEmbeddingUsage({ inputCount: batches.length, batches })
      expect(report.status).toBe(statusCase.expectedStatus)
      expect(report.batchesWithUsage).toBe(statusCase.expectedBatchesWithUsage)
      expect('tokens' in report).toBe(!statusCase.expectedTokensOmitted)
      expect(report.providerAttempts).toBe(batches.length)
      expect(report.inputsFromCache + report.inputsFromProvider).toBe(batches.length)
    })
  }

  it('reports missing plus usage-unreported for a provider that reports no usage at all', () => {
    // Gemini's `batchEmbedContents` is exactly this shape: every dispatched batch
    // comes back without usage.
    const { report, warnings } = aggregateEmbeddingUsage({
      inputCount: 3,
      batches: [
        { itemIndexes: [0, 1], attempts: 1 },
        { itemIndexes: [2], attempts: 2 },
      ],
    })
    expect(report.status).toBe('missing')
    expect(report).not.toHaveProperty('tokens')
    expect(report.batchesWithUsage).toBe(0)
    // The absence is not free: the attempts it cost are still reported.
    expect(report.providerAttempts).toBe(3)
    expect(report.inputsFromProvider).toBe(3)
    expect(report.inputsFromCache).toBe(0)
    expect(warnings.map(warning => warning.code))
      .toEqual(['usage-unreported', 'usage-unreported'])
    expect(warnings.map(warning => warning.itemIndexes)).toEqual([[0, 1], [2]])
  })

  it('reports missing with no tokens for a call served entirely from cache', () => {
    const { report, warnings } = aggregateEmbeddingUsage({ inputCount: 4, batches: [] })
    expect(report.status).toBe('missing')
    expect(report).not.toHaveProperty('tokens')
    expect(report.batches).toBe(0)
    expect(report.providerAttempts).toBe(0)
    expect(report.inputsFromCache).toBe(4)
    expect(report.inputsFromProvider).toBe(0)
    expect(warnings).toEqual([])
  })

  it('classifies coverage without inventing a complete status', () => {
    expect(classifyEmbeddingUsageStatus(0, 0)).toBe('missing')
    expect(classifyEmbeddingUsageStatus(2, 0)).toBe('missing')
    expect(classifyEmbeddingUsageStatus(2, 1)).toBe('partial')
    expect(classifyEmbeddingUsageStatus(2, 2)).toBe('complete')
  })
})
// ---------------------------------------------------------------------------
// Property 39, generation half
// ---------------------------------------------------------------------------

/**
 * The fourth half of the claim: the generation path keeps its current behaviour
 * of not emitting a `TokenUsage` while usage is incomplete (Requirement 13.10).
 *
 * This runs the real SSE pipeline of `packages/provider-http` — a wire protocol
 * that turns each event's JSON into a `usage` chunk — so the gate under test is
 * the one in `base/http-adapter.ts`, not a re-description of it.
 *
 * The oracle is the generator's own table, not `validateUsageCounters`: each
 * payload declares what the pipeline is allowed to publish, so a change that
 * loosened the gate could not be masked by the validator agreeing with itself.
 *
 * The other side of Requirement 13.10 — an incomplete report still being
 * evidence of a `Provider_Attempt` — is covered end to end by
 * `tests/unit/provider-http/final-review-accounting.spec.ts`, which asserts a
 * `{ inputTokens: 100 }` attempt survives in the ledger while never becoming an
 * authoritative total. It is not restated here.
 */
interface GenerationUsageCase {
  readonly name: string
  readonly payload: unknown
  /** Absent when the pipeline must publish nothing at all. */
  readonly published?: Readonly<Record<string, number>>
}

const GENERATION_USAGE_CASES: readonly GenerationUsageCase[] = Object.freeze([
  {
    name: 'both buckets with a consistent total',
    payload: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    published: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
  },
  {
    name: 'both buckets, total derived',
    payload: { inputTokens: 5, outputTokens: 2 },
    published: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
  },
  {
    // An honest zero is publishable. This is why "no fabricated 0" cannot be
    // tested by asserting the absence of zeros.
    name: 'honest zeros',
    payload: { inputTokens: 0, outputTokens: 0 },
    published: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  },
  {
    name: 'cache buckets included in the derived total',
    payload: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3 },
    published: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, totalTokens: 10 },
  },
  { name: 'input bucket only', payload: { inputTokens: 5 } },
  { name: 'output bucket only', payload: { outputTokens: 5 } },
  { name: 'no counters at all', payload: {} },
  { name: 'string counter', payload: { inputTokens: '5', outputTokens: 2 } },
  { name: 'negative counter', payload: { inputTokens: -1, outputTokens: 2 } },
  { name: 'fractional counter', payload: { inputTokens: 1.5, outputTokens: 2 } },
  { name: 'null counter', payload: { inputTokens: 5, outputTokens: null } },
  { name: 'total below the disjoint buckets', payload: { inputTokens: 5, outputTokens: 2, totalTokens: 3 } },
  { name: 'reasoning above output', payload: { inputTokens: 5, outputTokens: 2, reasoningTokens: 9 } },
  {
    name: 'counter past safe-integer precision',
    payload: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 2 },
  },
])

const usageProtocol = defineWireProtocol({
  id: 'usage-honesty',
  defaultDialect: {},
  endpointPath: () => '/stream',
  serialize: () => ({}),
  async *translate(events) {
    for await (const event of events) {
      if (event.data === 'finish') {
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        continue
      }
      yield { type: 'usage' as const, usage: JSON.parse(event.data) as never }
    }
  },
})

async function streamUsageChunks(payload: unknown): Promise<StreamChunk[]> {
  const adapter = createRuntimeHttpProvider({
    displayName: 'Usage honesty',
    protocol: usageProtocol,
    baseUrl: 'https://usage-honesty.invalid',
    auth: { kind: 'none' },
    fetch: async () => new Response(
      `data: ${JSON.stringify(payload)}\n\ndata: finish\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  })
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({ provider: 'usage-honesty', model: 'model', messages: [] })) {
    chunks.push(chunk)
  }
  return chunks
}

describe('Property 39: the generation path publishes no TokenUsage while usage is incomplete', () => {
  it(`holds for ${RUNS} generated streams`, async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x39_1000 + run
      const rng = rngOf(seed)
      const usageCase = pick(rng, GENERATION_USAGE_CASES)
      const chunks = await streamUsageChunks(usageCase.payload)
      const published = chunks.filter(chunk => chunk.type === 'usage')
      const context = { seed, case: usageCase.name }

      expect({ ...context, count: published.length })
        .toEqual({ ...context, count: usageCase.published === undefined ? 0 : 1 })
      // The stream stays intact either way: the gate drops the report, not the turn.
      expect({ ...context, terminal: chunks.at(-1)?.type }).toEqual({ ...context, terminal: 'finish' })

      if (usageCase.published !== undefined) {
        // Exact equality, so a bucket the provider never reported cannot appear
        // as a 0 and a reported bucket cannot be silently dropped.
        expect({ ...context, usage: (published[0] as { usage: unknown }).usage })
          .toEqual({ ...context, usage: usageCase.published })
      }
    }
  })
})
