/**
 * Runs the shared `Embedding_Adapter` contract against the fake adapter.
 *
 * PLACEMENT NOTE (deviation from the task-named path). Task 6.7 names
 * `packages/core/tests/contract/embedding/adapter-contract.spec.ts`. That
 * directory is collected by no runner — root `vitest.config.ts` includes
 * `tests/**&#47;*.spec.ts` and `pnpm test:contract` runs `vitest run tests/contract`
 * — so the spec lives in the root `tests/contract/` tree beside
 * `tests/contract/sse-equivalence.spec.ts`, per Requirement 17.11.
 *
 * The criteria themselves are in `./adapter-contract-suite.ts` so tasks 12.4 and
 * 13.3 can run the SAME suite against the real OpenAI and Gemini adapters. This
 * file contains only the fake-specific wiring: how a `FakeEmbeddingAdapter` is
 * built for each scenario, and how it is made to answer with one exact payload.
 *
 * ## Why a scripted response goes in through `errorFor`
 *
 * `FakeEmbeddingAdapter` produces well-formed vectors; it has no way to put a
 * duplicate index or a `NaN` component on the wire. A real adapter reaches those
 * cases by parsing a hostile HTTP body and calling `validateBatchResult`, so the
 * fake models the same step: {@link protocolErrorFor} runs the scripted payload
 * through `validateBatchResult` and hands the resulting error to the fake to
 * throw, while a payload that passes validation is returned verbatim through the
 * order hook. What is under test here is that the shared taxonomy in the negative
 * fixtures matches the codes `validateBatchResult` actually assigns — the same
 * table both provider suites must then reproduce (Requirement 14.8).
 *
 * ## Why the vectors come from the fake's own recording
 *
 * `FakeEmbeddingAdapter.providerVectors` holds what "the provider" produced
 * BEFORE post-processing, so Property 22 compares the published vector against
 * the provider's values rather than against a second copy of the SDK's output.
 *
 * **Validates: Requirements 4.1, 4.3, 9.8, 14.8, 17.11**
 */

import { describe, expect, it } from 'vitest'
import type { ResolvedEmbeddingModelInfo } from '../../../packages/core/src/embedding/catalog.ts'
import {
  EMBEDDING_ERROR_CODES, EmbeddingError,
} from '../../../packages/core/src/embedding/errors.ts'
import type {
  EmbeddingProfile, EmbeddingProfileInput,
} from '../../../packages/core/src/embedding/profile.ts'
import { defaultEmbeddingProfile } from '../../../packages/core/src/embedding/profile.ts'
import type { EmbeddingBatchRequest } from '../../../packages/core/src/embedding/request.ts'
import type {
  EmbeddingBatchResult, EmbeddingVector,
} from '../../../packages/core/src/embedding/result.ts'
import { validateBatchResult } from '../../../packages/core/src/embedding/validation.ts'
import {
  FakeEmbeddingAdapter, l2Renormalize,
} from '../../fixtures/embedding/fake-adapter.ts'
import type { FakeEmbeddingBehaviour } from '../../fixtures/embedding/fake-adapter.ts'
import { describeEmbeddingAdapterContract } from './adapter-contract-suite.ts'
import type {
  EmbeddingContractScenario, EmbeddingContractTarget,
} from './adapter-contract-suite.ts'

/** Revision recorded beside the post-processing kind; any stable value will do. */
const POST_PROCESSING_REVISION = '1'

/** A profile that DECLARES the l2 step the behaviour actually applies. */
function renormalizingProfile(
  model: ResolvedEmbeddingModelInfo,
  request: EmbeddingProfileInput,
): EmbeddingProfile {
  return {
    ...defaultEmbeddingProfile(model, request),
    postProcessing: { kind: 'l2-renormalize', revision: POST_PROCESSING_REVISION },
  }
}

/** Wraps a fake adapter as a contract target. */
function targetOf(adapter: FakeEmbeddingAdapter): EmbeddingContractTarget {
  return {
    adapter,
    attemptCount: () => adapter.attempts.length,
    providerVector: (index: number) => adapter.providerVectors.get(index),
  }
}

/** Translates one scenario into fake behaviour. */
function createTarget(scenario: EmbeddingContractScenario): EmbeddingContractTarget {
  const renormalizes = scenario.postProcessing === 'l2-renormalize'
  const behaviour: FakeEmbeddingBehaviour = {
    ...(scenario.dimensions === undefined ? {} : { dimensions: scenario.dimensions }),
    ...(scenario.order === undefined ? {} : { order: scenario.order }),
    ...(scenario.delayMs === undefined ? {} : { delayMs: scenario.delayMs }),
    ...(scenario.usage === undefined ? {} : { usage: scenario.usage }),
    ...(renormalizes ? { postProcess: l2Renormalize, profileFor: renormalizingProfile } : {}),
  }
  return targetOf(new FakeEmbeddingAdapter(behaviour))
}

/**
 * The error a compliant adapter raises for `result`, or `undefined` when the
 * payload satisfies the contract and must be published as-is.
 */
function protocolErrorFor(
  batch: EmbeddingBatchRequest,
  result: EmbeddingBatchResult,
): unknown {
  try {
    validateBatchResult(batch, result)
    return undefined
  }
  catch (error) {
    return error
  }
}

/**
 * A fake whose one attempt answers `batch` with EXACTLY `result`.
 *
 * The order hook returns the scripted vectors verbatim, which is what lets a
 * payload keep a wrong count, a duplicate index or a `truncated` flag the fake
 * would never generate on its own.
 */
function createScriptedTarget(
  batch: EmbeddingBatchRequest,
  result: EmbeddingBatchResult,
): EmbeddingContractTarget {
  const error = protocolErrorFor(batch, result)
  return targetOf(new FakeEmbeddingAdapter({
    errorFor: () => error,
    order: (): readonly EmbeddingVector[] => result.vectors,
  }))
}

describeEmbeddingAdapterContract({
  name: 'FakeEmbeddingAdapter',
  provider: 'fake',
  model: 'fake-embed',
  createTarget,
  createScriptedTarget,
  runs: 110,
})

// One guard that belongs to this wiring rather than to the shared criteria: the
// scripted hook must be able to FAIL. If `protocolErrorFor` silently returned
// `undefined` for a broken payload, every protocol-error criterion above would
// pass vacuously.
describe('fake wiring: the scripted hook is capable of rejecting', () => {
  it('derives a coded protocol error from a malformed payload', () => {
    const batch: EmbeddingBatchRequest = {
      provider: 'fake',
      model: 'fake-embed',
      purpose: 'retrieval-document',
      items: [{ index: 0, contentParts: [{ type: 'text', text: 'a' }] }],
      truncation: 'reject',
    }
    const error = protocolErrorFor(batch, { vectors: [] })

    expect(error).toBeInstanceOf(EmbeddingError)
    expect((error as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH)
  })

  it('returns no error for a payload that satisfies the contract', () => {
    const batch: EmbeddingBatchRequest = {
      provider: 'fake',
      model: 'fake-embed',
      purpose: 'retrieval-document',
      items: [{ index: 0, contentParts: [{ type: 'text', text: 'a' }] }],
      truncation: 'reject',
    }

    expect(protocolErrorFor(batch, { vectors: [{ index: 0, values: [0.1, 0.2] }] }))
      .toBeUndefined()
  })
})
