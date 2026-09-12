/**
 * Does the embedding conformance harness actually BITE?
 *
 * Task 14.3. Task 14.2 shows the sixteen checks pass over two real providers, and
 * task 6.5 shows the core validator rejects the negative fixtures. Neither can
 * distinguish "the harness verified sixteen claims" from "the harness verified
 * nothing and reported sixteen passes". This spec closes that gap from the other
 * side: each case takes the WORKING OpenAI conformance fixture from task 14.2,
 * breaks exactly one thing about it, and asserts the report names the check that
 * owns the broken claim — with the message that explains it — while every other
 * check still passes.
 *
 * Three properties of the harness are what this file is really about:
 *
 * - **A broken claim fails a NAMED check.** The expected set of failing check ids
 *   is compared as a set, so a sabotage that failed a different check, or failed
 *   nothing, is a failure here.
 * - **One report explains everything.** Because the untouched checks must still
 *   report `passed`, a harness that aborted at its first failure would fail this
 *   spec even though it did detect the fault.
 * - **The failure message is the diagnostic.** Each expectation carries the
 *   wording a provider author would have to act on, so a check that detects a
 *   fault but reports it as an opaque failure is not accepted.
 *
 * Sabotage happens in the FIXTURE, never in the SDK. That is deliberate: the
 * fixture is the harness's only source of provider-specific truth, so a fixture
 * that lies (a permuted vector ledger, an undeclared bound, a mis-declared error
 * code, an identity it was never asked for) is precisely the failure mode a
 * provider author will hit, and the harness's job is to refuse it rather than to
 * report a pass it cannot support.
 *
 * **Validates: Requirements 17.1, 17.2**
 *
 * ## Why the file lives here
 *
 * Task 14.3 names `packages/testkit/tests/unit/`. No such directory exists and no
 * runner collects a per-package `tests` tree: the root `vitest.config.ts` collects
 * `tests/**` and `packages/testkit/vitest.config.ts` collects an explicit list of
 * files from the root `tests/unit`. Placed under the named path this spec would
 * never run, which for a meta-test would be a particularly pointed irony, so it
 * sits in the collected `tests/unit` tree beside `provider-testkit.spec.ts` — the
 * equivalent meta-test for the generation half of the same harness.
 *
 * @module tests/unit/embedding-harness.spec
 */

import { describe, expect, it } from 'vitest'
import {
  EMBEDDING_CONFORMANCE_CHECK_IDS,
  ProviderConformanceError,
  runEmbeddingConformanceSuite,
  type EmbeddingConformanceCase,
  type EmbeddingConformanceCaseInput,
  type EmbeddingConformanceCheckId,
  type EmbeddingConformanceControlSnapshot,
  type EmbeddingConformanceFixture,
  type ProviderConformanceReport,
} from '@alvin0/ai-agent-sdk-testkit'
import { openAiEmbeddingConformanceFixture } from '../contract/embedding/provider-conformance-fixture.ts'

/** Budget for one sabotaged suite: sixteen scenarios, one of which waits on a timeout. */
const SUITE_TIMEOUT_MS = 120_000

/** What one saboteur must produce: a failing check id and the wording it must carry. */
type Expectation = readonly [EmbeddingConformanceCheckId, RegExp]

interface Saboteur {
  /** Name used in test output; also the thing that was broken. */
  readonly name: string
  /** Why breaking this must be visible, rather than merely different. */
  readonly why: string
  /**
   * Build the case the harness will run.
   *
   * Given the WORKING fixture, so a saboteur breaks one property of a case that
   * otherwise passes; everything it does not touch stays real provider behaviour.
   */
  readonly rig: (
    fixture: EmbeddingConformanceFixture,
    input: EmbeddingConformanceCaseInput,
  ) => EmbeddingConformanceCase
  /** Every check that must fail, and nothing else. */
  readonly expected: readonly Expectation[]
}

const SABOTEURS: readonly Saboteur[] = Object.freeze([
  {
    name: 'a provider vector ledger that is permuted against what was published',
    why: 'index fidelity is only checkable against the provider\'s own output; if the harness compared '
      + 'the SDK with itself it would agree under any permutation',
    rig: (fixture, input) => {
      const base = fixture.create(input)
      if (input.scenario !== 'embedding-reordered-response') return base
      return withControl(base, {
        // Same size, same vectors, one position out: the check must compare
        // element-wise per index rather than compare the two collections.
        providerVectors: () => rotate(base.control.providerVectors()),
      })
    },
    expected: [[
      'embedding-mapping-index-faithful',
      /is not the vector the provider returned for that index/,
    ]],
  },
  {
    name: 'a mapping fault declared under the wrong error code',
    why: 'membership in the fault taxonomy is not enough; a provider that reports a '
      + 'plausible-but-wrong code from that taxonomy must still be caught',
    rig: (fixture, input) => {
      const base = fixture.create(input)
      if (input.scenario !== 'embedding-invalid-index') return base
      // A real code from the embedding taxonomy, just not the one this response
      // malforms — so only the equality half of the claim can catch it.
      return Object.freeze({ ...base, expectedFailureCode: 'EMBEDDING_RESPONSE_MALFORMED' })
    },
    expected: [[
      'embedding-mapping-invalid-rejected',
      /reported "EMBEDDING_VECTOR_INDEX_INVALID" where the fixture expects "EMBEDDING_RESPONSE_MALFORMED"/,
    ]],
  },
  {
    name: 'batch bounds that were never declared',
    why: 'a batching scenario with no bounds sends one batch and satisfies every bound '
      + 'vacuously, which must be refused rather than passed',
    rig: (fixture, input) => {
      const base = fixture.create(input)
      if (input.scenario !== 'embedding-batch-limits') return base
      const { batchLimits: _dropped, ...rest } = base
      return Object.freeze(rest)
    },
    expected: [
      [
        'embedding-batch-limits-respected',
        /must declare maxItems, maxTokens and maxBytes explicitly/,
      ],
      // The memory claim is about the same run, so it cannot be evaluated at all;
      // a dependent check reports a bare failure rather than inventing evidence.
      ['embedding-batch-memory-bounded', /^embedding-batch-memory-bounded failed$/],
    ],
  },
  {
    name: 'an in-flight peak above the concurrency the case declared',
    why: 'memory boundedness is the claim the batching group exists for; a peak over '
      + 'the configured window must not be reported as bounded',
    rig: (fixture, input) => {
      const base = fixture.create(input)
      if (input.scenario !== 'embedding-batch-limits') return base
      const declared = base.concurrency ?? 1
      return withControl(base, {
        snapshot: () => Object.freeze({
          ...base.control.snapshot(),
          peakInFlight: declared + 1,
        }),
      })
    },
    expected: [[
      'embedding-batch-memory-bounded',
      /attempts were in flight at once, over the configured bound of/,
    ]],
  },
  {
    name: 'a dispatch ledger claiming the aborted call sent everything',
    why: 'the whole point of aborting is that unsent batches stay unsent; a run that '
      + 'sent the whole corpus anyway is the regression this check exists to catch',
    rig: (fixture, input) => {
      const base = fixture.create(input)
      if (input.scenario !== 'embedding-abort-in-flight') return base
      const everyIndex = Object.freeze(input.inputs.map((_text, index) => index))
      return withControl(base, {
        snapshot: () => {
          const real = base.control.snapshot()
          // Only once real work exists: the harness also asserts a freshly
          // constructed case has dispatched nothing at all.
          if (real.dispatches.length === 0) return real
          return Object.freeze({
            ...real,
            dispatches: Object.freeze([
              ...real.dispatches,
              Object.freeze({
                model: base.model,
                itemIndexes: everyIndex,
                byteCount: 1,
                failed: false,
              }),
            ]),
          })
        },
      })
    },
    expected: [[
      'embedding-abort-stops-unsent',
      /every input reached the provider despite the abort/,
    ]],
  },
  {
    name: 'an attempt count that does not match the scripted retry',
    why: 'retry cost is a number, not a direction; a scenario that spends more or fewer '
      + 'attempts than it declared has an unexplained cost',
    rig: (fixture, input) => {
      const base = fixture.create(input)
      if (input.scenario !== 'embedding-retry-cost') return base
      return Object.freeze({ ...base, expectedAttempts: 99 })
    },
    expected: [[
      'embedding-retry-no-resend',
      /attempts, not the declared 99/,
    ]],
  },
  {
    name: 'a compatibility scenario with no incompatible space to test against',
    why: 'without a genuinely foreign Space_Id the space guard has nothing to refuse, '
      + 'so both compatibility checks would pass without exercising anything',
    rig: (fixture, input) => {
      const base = fixture.create(input)
      if (input.scenario !== 'embedding-space-mismatch') return base
      const { incompatibleSpace: _dropped, ...rest } = base
      return Object.freeze(rest)
    },
    expected: [
      ['embedding-space-guard', /must declare an incompatible Space_Id/],
      ['embedding-no-model-fallback', /must declare an incompatible Space_Id/],
    ],
  },
  {
    name: 'an embedding plugin standing in for the generation-only plugin',
    why: 'the generation-only scenario asks what happens when a route has NO embedding '
      + 'adapter; a route that has one answers a different question',
    rig: (fixture, input) => {
      if (input.scenario !== 'generation-only-plugin') return fixture.create(input)
      // Same identity, same route, same fixture — only the plugin kind differs,
      // which is the single fact this scenario is built on.
      return fixture.create({ ...input, scenario: 'embedding-success' })
    },
    expected: [[
      'embedding-plugin-generation-only',
      /must supply a model provider plugin/,
    ]],
  },
  {
    name: 'a case built under an identity the harness never asked for',
    why: 'every check resolves its route by the identity it requested; a fixture that '
      + 'substitutes another route makes all sixteen results meaningless',
    rig: (fixture, input) => {
      const base = fixture.create(input)
      return Object.freeze({ ...base, route: `${base.route}-drifted` })
    },
    // Identity is validated by the shared case constructor, so this is the one
    // sabotage every check must reject. The memory check is the exception in
    // WORDING only: its evidence comes from the batching run that never happened,
    // so it reports a bare dependent failure rather than the identity message.
    expected: EMBEDDING_CONFORMANCE_CHECK_IDS.map(id => ([
      id,
      id === 'embedding-batch-memory-bounded'
        ? /^embedding-batch-memory-bounded failed$/
        : /embedding fixture changed the requested identity/,
    ] as const)),
  },
])

/** One suite run per saboteur, memoised so each `it` reads one report. */
const REPORTS = new Map<string, Promise<ProviderConformanceReport>>()

function reportFor(saboteur: Saboteur): Promise<ProviderConformanceReport> {
  const existing = REPORTS.get(saboteur.name)
  if (existing !== undefined) return existing
  const working = openAiEmbeddingConformanceFixture()
  const sabotaged: EmbeddingConformanceFixture = Object.freeze({
    create: (input: EmbeddingConformanceCaseInput) => saboteur.rig(working, input),
  })
  // A failing suite throws, carrying the report; here the throw is the EXPECTED
  // outcome, so the report is unwrapped and read rather than propagated.
  const started = runEmbeddingConformanceSuite(sabotaged).catch((error: unknown) => {
    if (error instanceof ProviderConformanceError) return error.report
    throw error
  })
  REPORTS.set(saboteur.name, started)
  return started
}

describe('Feature: embedding-support, Task 14.3: the embedding harness detects a broken fixture', () => {
  for (const saboteur of SABOTEURS) {
    describe(saboteur.name, () => {
      it('fails exactly the checks that own the broken claim', async () => {
        const report = await reportFor(saboteur)
        const failed = report.checks.filter(check => check.status === 'failed').map(check => check.id)
        expect([...failed].sort()).toEqual([...saboteur.expected.map(([id]) => id)].sort())
      }, SUITE_TIMEOUT_MS)

      it('explains each failure in terms a provider author can act on', async () => {
        const report = await reportFor(saboteur)
        const messages = new Map(report.checks.map(check => [check.id, check.message]))
        // Compared as one object so a failure shows the wording that DID appear
        // rather than only that a pattern did not match.
        expect(Object.fromEntries(saboteur.expected.map(([id, pattern]) => [
          id,
          pattern.test(messages.get(id) ?? '') ? 'explained' : messages.get(id) ?? 'no such check ran',
        ]))).toEqual(Object.fromEntries(saboteur.expected.map(([id]) => [id, 'explained'])))
      }, SUITE_TIMEOUT_MS)

      it('still runs and reports every other check', async () => {
        const report = await reportFor(saboteur)
        const broken = new Set(saboteur.expected.map(([id]) => id))
        const untouched = EMBEDDING_CONFORMANCE_CHECK_IDS.filter(id => !broken.has(id))
        const passed = new Set(
          report.checks.filter(check => check.status === 'passed').map(check => check.id),
        )
        expect(untouched.filter(id => !passed.has(id))).toEqual([])
        expect({
          ids: report.checks.map(check => check.id),
          status: report.status,
          failed: report.failed,
          passed: report.passed,
        }).toEqual({
          ids: [...EMBEDDING_CONFORMANCE_CHECK_IDS],
          status: 'failed',
          failed: broken.size,
          passed: EMBEDDING_CONFORMANCE_CHECK_IDS.length - broken.size,
        })
      }, SUITE_TIMEOUT_MS)
    })
  }

  it('breaks a claim in six of the nine contract-test groups', () => {
    // A meta-test that only sabotaged mapping would show the harness bites in one
    // place. This holds the table above to breadth, and it counts only the SCOPED
    // saboteurs: the identity drift fails all sixteen checks, so including it
    // would make any breadth claim true for free.
    const scoped = SABOTEURS.filter(
      saboteur => saboteur.expected.length < EMBEDDING_CONFORMANCE_CHECK_IDS.length,
    )
    const touched = new Set(scoped.flatMap(saboteur => saboteur.expected.map(([id]) => id)))
    const groupOf: Readonly<Record<EmbeddingConformanceCheckId, string>> = {
      'embedding-mapping-index-faithful': 'mapping and validation',
      'embedding-mapping-invalid-rejected': 'mapping and validation',
      'embedding-vector-validation': 'mapping and validation',
      'embedding-batch-limits-respected': 'batching',
      'embedding-batch-memory-bounded': 'batching',
      'embedding-abort-stops-unsent': 'cancellation and close',
      'embedding-close-covers-operation': 'cancellation and close',
      'embedding-retry-no-resend': 'retry and cost',
      'embedding-timeout-dispatch-unknown': 'retry and cost',
      'embedding-cache-key-composition': 'cache',
      'embedding-space-guard': 'compatibility',
      'embedding-no-model-fallback': 'compatibility',
      'embedding-plugin-generation-only': 'plugin compatibility',
      'embedding-plugin-embedding-only': 'plugin compatibility',
      'embedding-usage-honesty': 'usage honesty',
      'embedding-trace-privacy': 'privacy',
    }
    const groups = new Set([...touched].map(id => groupOf[id]))
    expect([...groups].sort()).toEqual([
      'batching',
      'cancellation and close',
      'compatibility',
      'mapping and validation',
      'plugin compatibility',
      'retry and cost',
    ])
  })
})

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The same case with some control methods replaced; the rest stay the fixture's. */
function withControl(
  base: EmbeddingConformanceCase,
  overrides: {
    readonly snapshot?: () => EmbeddingConformanceControlSnapshot
    readonly providerVectors?: () => ReadonlyMap<number, readonly number[]>
  },
): EmbeddingConformanceCase {
  return Object.freeze({
    ...base,
    control: Object.freeze({ ...base.control, ...overrides }),
  })
}

/** Every vector moved one index along, so no index holds its own vector. */
function rotate(
  vectors: ReadonlyMap<number, readonly number[]>,
): ReadonlyMap<number, readonly number[]> {
  const indexes = [...vectors.keys()].sort((left, right) => left - right)
  const rotated = new Map<number, readonly number[]>()
  for (const [position, index] of indexes.entries()) {
    const source = indexes[(position + 1) % indexes.length]
    const values = source === undefined ? undefined : vectors.get(source)
    if (values !== undefined) rotated.set(index, values)
  }
  return rotated
}
