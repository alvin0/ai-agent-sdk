import { rejectionOf } from './check-support.ts'
import { createAgentRuntime, type AgentRuntime } from '@alvin0/ai-agent-sdk-core'
import {
  type EmbeddingModelOptions,
  type EmbeddingPurpose,
  type EmbeddingSpaceId,
} from '@alvin0/ai-agent-sdk-core/embedding'
import { PROVIDER_CONFORMANCE_DEFAULTS  } from '../config.ts'
import {
  assert,
  required,
  within,
  type ResolvedConformanceTimeouts,
} from '../report.ts'
import { EMBEDDING_CONFORMANCE_DEFAULTS, embeddingConformanceInputs  } from './config.ts'
import type {
  EmbeddingConformanceCase,
  EmbeddingConformanceControlSnapshot,
  EmbeddingConformanceFixture,
  EmbeddingConformanceScenario,
} from './types.ts'

import { byteLength, codeOf, messageOf } from './check-support.ts'
// ---------------------------------------------------------------------------
// Case construction
// ---------------------------------------------------------------------------

export function simpleInputs(label: string): readonly string[] {
  return embeddingConformanceInputs(EMBEDDING_CONFORMANCE_DEFAULTS.inputCount, label)
}

export function corpusInputs(label: string): readonly string[] {
  return embeddingConformanceInputs(EMBEDDING_CONFORMANCE_DEFAULTS.corpusCount, label)
}

/** First input, used where one probe vector is enough. */
export function probe(inputs: readonly string[]): string {
  return inputs[0] ?? `${EMBEDDING_CONFORMANCE_DEFAULTS.contentSentinel} probe`
}

/**
 * Build one case and hold the fixture to the identity it was asked for.
 *
 * Also the inert-construction claim for embedding: creating a provider instance
 * must perform no setup, no cleanup and no dispatch.
 */
export function createCase(
  fixture: EmbeddingConformanceFixture,
  scenario: EmbeddingConformanceScenario,
  inputs: readonly string[],
  purpose: EmbeddingPurpose = EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
): EmbeddingConformanceCase {
  const id = `embedding-case-${scenario}`
  const route = `embedding-route-${scenario}`
  const value = fixture.create({
    scenario, id, route, inputs, purpose,
    privateSentinel: PROVIDER_CONFORMANCE_DEFAULTS.failureSentinel,
  })
  assert(value !== null && typeof value === 'object', 'embedding fixture did not return a case')
  assert(value.route === route && value.plugin.id === id, 'embedding fixture changed the requested identity')
  assert(value.plugin.routes.length === 1 && value.plugin.routes[0] === route,
    'embedding fixture changed the requested route')
  assert(typeof value.model === 'string' && value.model.length > 0,
    'embedding fixture returned no model id')
  const snapshot = value.control.snapshot()
  assert(snapshot.setupCalls === 0 && snapshot.cleanupCalls === 0 && snapshot.dispatches.length === 0,
    'embedding fixture performed provider work at construction time')
  return value
}

export function embeddingOptions(
  candidate: EmbeddingConformanceCase,
  overrides: Partial<EmbeddingModelOptions> = {},
): EmbeddingModelOptions {
  return {
    provider: candidate.route,
    model: candidate.model,
    ...(candidate.dimensions === undefined ? {} : { dimensions: candidate.dimensions }),
    ...(candidate.concurrency === undefined ? {} : { concurrency: candidate.concurrency }),
    ...(candidate.batchLimits === undefined ? {} : { batchLimits: candidate.batchLimits }),
    ...overrides,
  }
}

export async function startRuntime(
  candidate: EmbeddingConformanceCase,
  timeouts: ResolvedConformanceTimeouts,
): Promise<AgentRuntime> {
  const runtime = await createAgentRuntime({
    providers: [candidate.plugin],
    startupTimeoutMs: timeouts.startupTimeoutMs,
    closeTimeoutMs: timeouts.closeTimeoutMs,
  })
  assert(candidate.control.snapshot().setupCalls === 1, 'embedding provider setup count is not one')
  return runtime
}

/** Start a runtime for one case, run the task, then close it twice. */
export async function withRuntime(
  candidate: EmbeddingConformanceCase,
  timeouts: ResolvedConformanceTimeouts,
  task: (runtime: AgentRuntime) => Promise<void>,
): Promise<void> {
  const runtime = await startRuntime(candidate, timeouts)
  try {
    await task(runtime)
  } finally {
    await runtime.close()
    await runtime.close()
  }
  assert(candidate.control.snapshot().cleanupCalls === 1, 'embedding provider cleanup count is not one')
}

/** The batch bounds a batching scenario must declare, with the reason they matter. */
export function declaredLimits(
  candidate: EmbeddingConformanceCase,
  inputCount: number,
): { readonly maxItems: number; readonly maxTokens: number; readonly maxBytes: number } {
  const limits = candidate.batchLimits
  assert(limits !== undefined
    && limits.maxItems !== undefined && limits.maxTokens !== undefined && limits.maxBytes !== undefined,
  'a batching scenario must declare maxItems, maxTokens and maxBytes explicitly')
  assert(limits.maxItems < inputCount,
    `the declared maxItems of ${limits.maxItems} covers the whole corpus of ${inputCount} inputs`)
  return { maxItems: limits.maxItems, maxTokens: limits.maxTokens, maxBytes: limits.maxBytes }
}

export function declaredConcurrency(candidate: EmbeddingConformanceCase): number {
  const value = candidate.concurrency
  assert(value !== undefined && Number.isInteger(value) && value > 0,
    'a batching scenario must declare a positive concurrency')
  return value
}

export function requiredSpace(candidate: EmbeddingConformanceCase): EmbeddingSpaceId {
  const space = candidate.incompatibleSpace
  assert(space !== undefined && String(space).length > 0,
    'a compatibility scenario must declare an incompatible Space_Id')
  return space
}

export function dispatchBarrier(candidate: EmbeddingConformanceCase): Promise<void> {
  const entered = candidate.control.waitForDispatch?.()
  assert(entered !== undefined, 'this scenario has no dispatch barrier; abort would be a race')
  return entered
}

// ---------------------------------------------------------------------------
// Shared scenario bodies
// ---------------------------------------------------------------------------

export interface BatchingEvidence {
  readonly limits: { readonly maxItems: number; readonly maxTokens: number; readonly maxBytes: number }
  readonly concurrency: number
  readonly inputs: readonly string[]
  readonly snapshot: EmbeddingConformanceControlSnapshot
  readonly corpusBytes: number
}

/**
 * One batching run, shared by the two batching checks.
 *
 * Run once rather than twice because the memory claim is about the SAME run that
 * respected the bounds: two runs could each satisfy one half.
 */
export async function runBatching(
  fixture: EmbeddingConformanceFixture,
  timeouts: ResolvedConformanceTimeouts,
): Promise<BatchingEvidence> {
  const inputs = corpusInputs('corpus')
  const candidate = createCase(fixture, 'embedding-batch-limits', inputs)
  const limits = declaredLimits(candidate, inputs.length)
  const concurrency = declaredConcurrency(candidate)
  let snapshot: EmbeddingConformanceControlSnapshot | undefined
  await withRuntime(candidate, timeouts, async (runtime) => {
    const result = await within(runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
      values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
    }), timeouts.caseTimeoutMs)
    assert(result.embeddings.length === inputs.length,
      `a batched call published ${result.embeddings.length} vectors for ${inputs.length} inputs`)
    snapshot = candidate.control.snapshot()
  })
  return Object.freeze({
    limits,
    concurrency,
    inputs,
    snapshot: required(snapshot),
    corpusBytes: inputs.reduce((sum, text) => sum + byteLength(text), 0),
  })
}

/**
 * A scenario whose response breaks the contract: it must fail, with a code from
 * `allowed`, and with the exact code the fixture declared.
 *
 * Two assertions rather than one on purpose. Membership in `allowed` is the
 * taxonomy claim — both providers report mapping faults from the same small set.
 * Equality with `expectedFailureCode` is the fixture's own claim about which one,
 * and it is what catches a provider that reports a plausible-but-wrong code.
 */
export async function rejectingCase(
  fixture: EmbeddingConformanceFixture,
  timeouts: ResolvedConformanceTimeouts,
  scenario: EmbeddingConformanceScenario,
  expectation: { allowed: ReadonlySet<string>; label: string },
): Promise<void> {
  const { allowed, label } = expectation
  const inputs = simpleInputs(scenario)
  const candidate = createCase(fixture, scenario, inputs)
  await withRuntime(candidate, timeouts, async (runtime) => {
    const failure = await rejectionOf(
      runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
        values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
      }),
      timeouts.caseTimeoutMs,
      label,
    )
    const code = codeOf(failure)
    assert(allowed.has(code), `${label} was reported as "${code}", outside the embedding fault taxonomy`)
    const expected = candidate.expectedFailureCode
    assert(typeof expected === 'string' && expected.length > 0,
      `the "${scenario}" fixture declared no expected failure code`)
    assert(code === expected, `${label} reported "${code}" where the fixture expects "${expected}"`)
    assert(!messageOf(failure).includes(PROVIDER_CONFORMANCE_DEFAULTS.failureSentinel),
      'a private provider value crossed the failure boundary')
  })
}

