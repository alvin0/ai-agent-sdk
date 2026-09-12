/**
 * The criteria EVERY `Embedding_Adapter` must meet, as one reusable suite.
 *
 * PLACEMENT NOTE (deviation from the task-named path). Task 6.7 names
 * `packages/core/tests/contract/embedding/adapter-contract.spec.ts`. No runner
 * collects `packages/*&#47;tests/`: root `vitest.config.ts` includes
 * `tests/**&#47;*.spec.ts`, and `pnpm test:contract` runs `vitest run tests/contract`.
 * A suite there would never execute in CI — the one failure mode a contract suite
 * must not have. It therefore lives under the root `tests/contract/` tree, beside
 * `tests/contract/sse-equivalence.spec.ts`, in an `embedding/` subdirectory.
 *
 * WHY THIS IS A MODULE AND NOT THE SPEC ITSELF. Tasks 12.4 and 13.3 run these
 * same criteria against the real OpenAI and Gemini adapters. If the criteria were
 * written inline in a `.spec.ts`, importing them would re-register the fake's own
 * cases in the provider spec. So the criteria are exported as
 * {@link describeEmbeddingAdapterContract}, a function that registers nothing
 * until it is called with a target factory; `adapter-contract.spec.ts` calls it
 * with the fake, and each provider spec calls it with its own adapter.
 *
 * WHAT A TARGET HAS TO SUPPLY. Two things the suite cannot obtain through the
 * `EmbeddingAdapter` surface, because they are evidence ABOUT the adapter rather
 * than part of its contract:
 * - {@link EmbeddingContractTarget.attemptCount} — how many physical provider
 *   requests actually happened, which is what makes "exactly one
 *   `Provider_Attempt` per call" assertable instead of assumed;
 * - {@link EmbeddingContractTarget.providerVector} — what the provider returned
 *   BEFORE post-processing, which is what makes Property 22 a comparison against
 *   the provider rather than a comparison of the SDK against itself.
 *
 * For the fake, both come from `FakeEmbeddingAdapter` instance state. For a real
 * provider, both come from its HTTP fixture: the request count it served, and the
 * vector payloads it was scripted to return.
 *
 * The off-contract responses come from `tests/negative-fixtures/embedding/`,
 * where each case already carries the `EMBEDDING_ERROR_CODES` value it must
 * produce; that shared table is what makes a provider reporting a DIFFERENT code
 * for the same malformation a failure (Requirement 14.8). `bad-usage.ts` and
 * `bad-plugin.ts` are not consumed here: usage normalization belongs to
 * `Embedding_Runtime` and plugin registration to composition, neither of which is
 * an adapter obligation. The one usage criterion that IS the adapter's — never
 * inventing a counter the provider did not send — is checked directly.
 *
 * **Validates: Requirements 4.1, 4.3, 9.8, 14.8, 17.11**
 *
 * @module tests/contract/embedding/adapter-contract-suite
 */

import { describe, expect, it } from 'vitest'
import type { EmbeddingAdapter } from '../../../packages/core/src/embedding/adapter.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../../packages/core/src/embedding/errors.ts'
import type { EmbeddingProfile } from '../../../packages/core/src/embedding/profile.ts'
import type { EmbeddingBatchRequest } from '../../../packages/core/src/embedding/request.ts'
import type { EmbeddingBatchResult } from '../../../packages/core/src/embedding/result.ts'
import { l2Renormalize } from '../../fixtures/embedding/fake-adapter.ts'
import {
  BAD_MAPPING_CASES, REORDERED_VALID_CASE, embeddingBatch,
} from '../../negative-fixtures/embedding/bad-mapping.ts'
import type { BadResponseCase } from '../../negative-fixtures/embedding/bad-mapping.ts'
import {
  ACCEPTABLE_VECTOR_CASES, BAD_VECTOR_CASES,
} from '../../negative-fixtures/embedding/bad-vector.ts'

/** Response orders every adapter must survive; indexes travel with the vectors. */
export type ContractVectorOrder = 'input' | 'reversed' | 'rotated'

/** What the suite asks a target's provider to do for one test. */
export interface EmbeddingContractScenario {
  /** Requested vector width, or absent for the model default. */
  readonly dimensions?: number
  /** Post-processing the adapter applies AND records in its profile. */
  readonly postProcessing?: 'l2-renormalize'
  /** Order the provider answers in. */
  readonly order?: ContractVectorOrder
  /** Delay before the response, so abort is observable mid-flight. */
  readonly delayMs?: number
  /** `'absent'` means the provider reports no usage at all. */
  readonly usage?: 'reported' | 'absent'
}

/** One adapter under test, plus the evidence the criteria need. */
export interface EmbeddingContractTarget {
  readonly adapter: EmbeddingAdapter
  /** Physical provider requests observed so far. */
  attemptCount(): number
  /**
   * What the provider returned for one `Logical_Call` index, before any
   * post-processing, or `undefined` if it produced nothing for that index.
   */
  providerVector(index: number): readonly number[] | undefined
}

/** How to build targets for one adapter implementation. */
export interface EmbeddingContractOptions {
  /** Appears in every test name, e.g. `'FakeEmbeddingAdapter'`. */
  readonly name: string
  /** Route key and model id the target answers for. */
  readonly provider: string
  readonly model: string
  /** A FRESH target per test; nothing may leak between cases. */
  createTarget(scenario: EmbeddingContractScenario): EmbeddingContractTarget
  /**
   * A target whose single attempt answers `batch` with EXACTLY `result`.
   *
   * `result` may be off-contract; a compliant adapter raises a protocol error
   * rather than repairing it. This is the hook a real provider implements with an
   * HTTP fixture serving that payload verbatim.
   */
  createScriptedTarget(
    batch: EmbeddingBatchRequest,
    result: EmbeddingBatchResult,
  ): EmbeddingContractTarget
  /** Seed for the generated Property 22 cases. */
  readonly seed?: number
  /** Generated cases for Property 22; the spec floor is 100. */
  readonly runs?: number
}

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

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

function intBetween(rng: Rng, min: number, maxInclusive: number): number {
  return min + intBelow(rng, maxInclusive - min + 1)
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  const value = values[intBelow(rng, values.length)]
  if (value === undefined) throw new Error('empty choice list')
  return value
}

/**
 * Choice from a list where `undefined` is a MEANINGFUL member — "no requested
 * width", "no post-processing" — so it cannot double as the empty-list signal.
 */
function pickOptional<T>(rng: Rng, values: readonly (T | undefined)[]): T | undefined {
  if (values.length === 0) throw new Error('empty choice list')
  return values[intBelow(rng, values.length)]
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789 '

/** Short ASCII text; content only has to vary, not be realistic. */
function text(rng: Rng): string {
  const length = intBetween(rng, 1, 24)
  let value = ''
  for (let index = 0; index < length; index += 1) {
    value += ALPHABET.charAt(intBelow(rng, ALPHABET.length))
  }
  return value
}

/** Widths a caller may request, plus "request none". */
const WIDTHS: readonly (number | undefined)[] = [undefined, 2, 3, 5, 8]

const ORDERS: readonly ContractVectorOrder[] = ['input', 'reversed', 'rotated']

const POST_PROCESSINGS: readonly ('l2-renormalize' | undefined)[] = [undefined, 'l2-renormalize']

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Milliseconds a delayed attempt waits; long enough that abort is unambiguous. */
const ABORT_DELAY_MS = 1_000

/** A batch of `count` items whose texts differ, starting at `startIndex`. */
function batchOf(
  count: number,
  rng: Rng,
  overrides: { readonly dimensions?: number; readonly startIndex?: number } = {},
): EmbeddingBatchRequest {
  const base = embeddingBatch(count, overrides)
  return {
    ...base,
    items: base.items.map(item => ({
      ...item,
      contentParts: [{ type: 'text' as const, text: `${text(rng)}#${String(item.index)}` }],
    })),
  }
}

/** The captured rejection of `promise`, or a failure if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error) {
    return error
  }
  throw new Error('expected the call to reject, but it resolved')
}

/** Element-wise identity, so `-0` and `0` are not silently interchangeable. */
function expectSameValues(
  actual: readonly number[],
  expected: readonly number[],
  context: string,
): void {
  expect(actual.length, `${context}: vector width`).toBe(expected.length)
  for (const [position, value] of expected.entries()) {
    expect(
      Object.is(actual[position], value),
      `${context}: component ${String(position)} was ${String(actual[position])}, `
      + `provider said ${String(value)}`,
    ).toBe(true)
  }
}

/**
 * The values a faithful adapter must publish for one provider vector.
 *
 * Reads the transform off the PROFILE, not off the scenario: the profile is the
 * adapter's own statement about what it did, so this is what turns Property 22
 * into "the recorded step is exactly the step that happened".
 */
function expectedValues(
  profile: EmbeddingProfile,
  providerValues: readonly number[],
): readonly number[] {
  if (profile.postProcessing === undefined) return providerValues
  expect(profile.postProcessing.kind, 'v1 declares exactly one post-processing kind')
    .toBe('l2-renormalize')
  return l2Renormalize(providerValues)
}

/**
 * Registers the criteria every `Embedding_Adapter` must meet.
 *
 * @param options - how to build fresh targets, and the generation budget.
 */
export function describeEmbeddingAdapterContract(options: EmbeddingContractOptions): void {
  const runs = options.runs ?? 110
  const seed = options.seed ?? 0x22_45_4d_42

  /** Prepares one call generation and dispatches `batch` through it. */
  async function dispatch(
    target: EmbeddingContractTarget,
    batch: EmbeddingBatchRequest,
  ): Promise<{ readonly profile: EmbeddingProfile; readonly result: EmbeddingBatchResult }> {
    const prepared = await target.adapter.prepareEmbeddingCall(
      options.provider,
      options.model,
      batch.dimensions === undefined ? {} : { dimensions: batch.dimensions },
    )
    return { profile: prepared.profile, result: await prepared.embedBatch(batch) }
  }

  describe(`Embedding_Adapter contract: ${options.name}`, () => {
    // -----------------------------------------------------------------------
    // Requirement 4.3 — exactly one Provider_Attempt per call
    // -----------------------------------------------------------------------
    describe('performs exactly one Provider_Attempt per call', () => {
      it('makes one attempt for one dispatch', async () => {
        const rng = rngOf(seed)
        const target = options.createTarget({})
        const batch = batchOf(3, rng)

        const { result } = await dispatch(target, batch)

        expect(target.attemptCount(), 'one dispatch is one physical request').toBe(1)
        expect(result.vectors).toHaveLength(batch.items.length)
      })

      it('makes N attempts for N dispatches, never batching or coalescing them', async () => {
        const rng = rngOf(seed + 1)
        const target = options.createTarget({})

        for (let call = 1; call <= 3; call += 1) {
          await dispatch(target, batchOf(2, rng, { startIndex: call * 10 }))
          expect(target.attemptCount(), `after dispatch ${String(call)}`).toBe(call)
        }
      })

      it('does not retry after a protocol error; retry belongs to Embedding_Runtime', async () => {
        const broken = BAD_MAPPING_CASES[0]
        if (broken === undefined) throw new Error('bad-mapping table is empty')
        const target = options.createScriptedTarget(broken.batch, broken.result)

        await rejectionOf(dispatch(target, broken.batch))

        expect(target.attemptCount(), 'a rejected attempt is still exactly one attempt').toBe(1)
      })
    })

    // -----------------------------------------------------------------------
    // Requirement 4.1 — honours batch.signal
    // -----------------------------------------------------------------------
    describe('respects batch.signal', () => {
      it('rejects a batch whose signal is already aborted', async () => {
        const rng = rngOf(seed + 2)
        const target = options.createTarget({})
        const controller = new AbortController()
        controller.abort(new EmbeddingError('aborted before dispatch', EMBEDDING_ERROR_CODES.ABORTED))
        const batch = { ...batchOf(2, rng), signal: controller.signal }

        const error = await rejectionOf(dispatch(target, batch))

        expect(error).toBeInstanceOf(EmbeddingError)
        expect((error as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.ABORTED)
        expect(
          target.providerVector(batch.items[0]?.index ?? 0),
          'an aborted call publishes no vector',
        ).toBeUndefined()
        expect(target.attemptCount(), 'abort never causes a second attempt')
          .toBeLessThanOrEqual(1)
      })

      it('settles promptly when the signal aborts mid-flight', async () => {
        const rng = rngOf(seed + 3)
        const target = options.createTarget({ delayMs: ABORT_DELAY_MS })
        const controller = new AbortController()
        const batch = { ...batchOf(2, rng), signal: controller.signal }
        const started = Date.now()

        const pending = rejectionOf(dispatch(target, batch))
        controller.abort(new EmbeddingError('aborted in flight', EMBEDDING_ERROR_CODES.ABORTED))
        const error = await pending

        expect(error).toBeInstanceOf(EmbeddingError)
        expect((error as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.ABORTED)
        expect(
          Date.now() - started,
          'the call must not wait out the provider delay after abort',
        ).toBeLessThan(ABORT_DELAY_MS)
      })

      it('completes normally when a signal is present but never aborted', async () => {
        const rng = rngOf(seed + 4)
        const target = options.createTarget({})
        const controller = new AbortController()
        const batch = { ...batchOf(2, rng), signal: controller.signal }

        const { result } = await dispatch(target, batch)

        expect(result.vectors).toHaveLength(batch.items.length)
      })
    })

    // -----------------------------------------------------------------------
    // Requirement 4.1 — carries the original input index
    // -----------------------------------------------------------------------
    describe('carries the original input index onto every vector', () => {
      for (const order of ORDERS) {
        it(`answers a ${order}-ordered response with the Logical_Call indexes`, async () => {
          const rng = rngOf(seed + 5)
          const target = options.createTarget({ order })
          // startIndex 40: batch-local numbering would show up as 0..2 here.
          const batch = batchOf(3, rng, { startIndex: 40 })

          const { result } = await dispatch(target, batch)

          const requested = batch.items.map(item => item.index)
          const answered = result.vectors.map(vector => vector.index)
          expect([...answered].sort((a, b) => a - b), `${order}: index set`)
            .toStrictEqual([...requested].sort((a, b) => a - b))
          expect(new Set(answered).size, `${order}: no index answered twice`)
            .toBe(requested.length)
        })
      }

      it('keeps each vector with its own input, not with its response position', async () => {
        const rng = rngOf(seed + 6)
        const target = options.createTarget({ order: 'reversed' })
        const batch = batchOf(4, rng, { startIndex: 7 })

        const { profile, result } = await dispatch(target, batch)

        for (const vector of result.vectors) {
          const providerValues = target.providerVector(vector.index)
          expect(providerValues, `index ${String(vector.index)} was answered`).toBeDefined()
          expectSameValues(
            vector.values,
            expectedValues(profile, providerValues ?? []),
            `reversed response, index ${String(vector.index)}`,
          )
        }
      })
    })

    // -----------------------------------------------------------------------
    // Requirements 9.8, 14.8 — protocol error rather than inference
    // -----------------------------------------------------------------------
    describe('raises a protocol error instead of inferring', () => {
      const badCases: readonly BadResponseCase[] = [...BAD_MAPPING_CASES, ...BAD_VECTOR_CASES]

      for (const bad of badCases) {
        it(`rejects ${bad.name} with ${bad.expectedCode} — ${bad.why}`, async () => {
          const target = options.createScriptedTarget(bad.batch, bad.result)

          const error = await rejectionOf(dispatch(target, bad.batch))

          expect(error, `${bad.name}: must be an EmbeddingError`).toBeInstanceOf(EmbeddingError)
          expect((error as EmbeddingError).code, `${bad.name}: code`).toBe(bad.expectedCode)
        })
      }

      it('accepts a reordered response; a permutation is legal, not a fault', async () => {
        const target = options.createScriptedTarget(
          REORDERED_VALID_CASE.batch,
          REORDERED_VALID_CASE.result,
        )

        const { result } = await dispatch(target, REORDERED_VALID_CASE.batch)

        expect(result.vectors).toHaveLength(REORDERED_VALID_CASE.batch.items.length)
      })

      for (const acceptable of ACCEPTABLE_VECTOR_CASES) {
        it(`accepts ${acceptable.name}; rejecting it would be rejecting on inference`, async () => {
          const target = options.createScriptedTarget(acceptable.batch, acceptable.result)

          const { result } = await dispatch(target, acceptable.batch)

          expect(result.vectors).toHaveLength(acceptable.batch.items.length)
        })
      }

      it('leaves usage absent when the provider reports none', async () => {
        const rng = rngOf(seed + 7)
        const target = options.createTarget({ usage: 'absent' })

        const { result } = await dispatch(target, batchOf(2, rng))

        expect(result.usage, 'an unreported call is unknown, not free').toBeUndefined()
      })
    })

    // -----------------------------------------------------------------------
    // Property 22
    // -----------------------------------------------------------------------
    describe(
      'Feature: embedding-support, Property 22: Vector trả ra trung thực với vector '
      + 'provider trả về',
      () => {
        it(`publishes provider values unchanged, or exactly the recorded transform, `
          + `across ${String(runs)} generated cases`, async () => {
          const rng = rngOf(seed)
          const coveredWidths = new Set<string>()
          const coveredSteps = new Set<string>()
          let renormalizedRuns = 0

          for (let run = 0; run < runs; run += 1) {
            const dimensions = pickOptional(rng, WIDTHS)
            const postProcessing = pickOptional(rng, POST_PROCESSINGS)
            const order = pick(rng, ORDERS)
            const scenario: EmbeddingContractScenario = {
              ...(dimensions === undefined ? {} : { dimensions }),
              ...(postProcessing === undefined ? {} : { postProcessing }),
              order,
            }
            const target = options.createTarget(scenario)
            const batch = batchOf(intBetween(rng, 1, 4), rng, {
              ...(dimensions === undefined ? {} : { dimensions }),
              startIndex: intBelow(rng, 12),
            })

            const { profile, result } = await dispatch(target, batch)
            const context = `seed ${String(seed)} run ${String(run)}: `
              + `${String(batch.items.length)} items, width ${String(dimensions)}, `
              + `step ${String(postProcessing)}, order ${order}`

            coveredWidths.add(String(dimensions))
            coveredSteps.add(String(profile.postProcessing?.kind))
            if (profile.postProcessing !== undefined) renormalizedRuns += 1

            expect(result.vectors, `${context}: one vector per input`)
              .toHaveLength(batch.items.length)

            for (const vector of result.vectors) {
              const providerValues = target.providerVector(vector.index)
              expect(
                providerValues,
                `${context}: no provider vector recorded for index ${String(vector.index)}`,
              ).toBeDefined()
              if (providerValues === undefined) continue

              expectSameValues(
                vector.values,
                expectedValues(profile, providerValues),
                `${context}, index ${String(vector.index)}`,
              )

              // The other half of the claim: with no step recorded, the values are
              // the provider's own. Asserted separately so a suite cannot pass by
              // reporting a transform it did not perform.
              if (profile.postProcessing === undefined) {
                expectSameValues(
                  vector.values,
                  providerValues,
                  `${context}, index ${String(vector.index)}: unrecorded transform`,
                )
              }

              // A vector may only answer an input that was actually sent.
              expect(
                batch.items.some(item => item.index === vector.index),
                `${context}: index ${String(vector.index)} is not in the batch`,
              ).toBe(true)
            }
          }

          expect(coveredWidths.size, 'generation covered several requested widths')
            .toBeGreaterThan(1)
          expect(renormalizedRuns, 'generation covered post-processed runs').toBeGreaterThan(0)
          expect(coveredSteps.size, 'generation covered both recorded and absent steps').toBe(2)
        })
      },
    )
  })
}
