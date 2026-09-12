/**
 * Both real embedding providers, through ONE contract.
 *
 * Task 14.2. The sixteen embedding checks of `runEmbeddingConformanceSuite` are
 * run twice — once over `openAiEmbeddingPlugin`, once over `geminiEmbeddingPlugin`
 * — from fixtures that differ only in what the wire genuinely differs in. Then the
 * two providers are held to ONE error taxonomy: every fault both wires can express
 * must surface the SAME `EMBEDDING_ERROR_CODES` value on both (Requirement 14.8).
 *
 * The report is not read as a boolean. Three things are asserted about it, because
 * a suite that silently ran fewer checks would otherwise look like a pass:
 *
 * 1. every check id the harness declares actually ran, exactly once;
 * 2. all of them passed;
 * 3. the nine contract-test groups of Requirement 17 each have at least one check
 *    that passed, on BOTH providers — the group table below is the mapping, and it
 *    is itself checked for being total and disjoint.
 *
 * **Validates: Requirements 14.8, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10**
 *
 * ## Why the file lives here
 *
 * A per-package `tests` directory is collected by no runner in this repository; the
 * root `vitest.config.ts` collects the root `tests` tree, and `pnpm test:contract`
 * runs `tests/contract`. A conformance suite spanning two provider packages plus the
 * testkit belongs to no single package anyway, so the cross-package contract tree
 * is where it can run at all.
 *
 * @module tests/contract/embedding/provider-conformance.spec
 */

import { describe, expect, it } from 'vitest'
import {
  EMBEDDING_CONFORMANCE_CHECK_IDS,
  ProviderConformanceError,
  runEmbeddingConformanceSuite,
  type EmbeddingConformanceCheckId,
  type ProviderConformanceReport,
} from '@alvin0/ai-agent-sdk-testkit'
import {
  EMBEDDING_FAULTS,
  EMBEDDING_FAULT_CODES,
  EMBEDDING_WIRE_PROVIDERS,
  geminiEmbeddingConformanceFixture,
  openAiEmbeddingConformanceFixture,
  probeEmbeddingFault,
  type EmbeddingFault,
} from './provider-conformance-fixture.ts'

/** Budget for one suite: sixteen scenarios, several of which wait on a timeout. */
const SUITE_TIMEOUT_MS = 120_000

/**
 * The nine contract-test groups of Requirement 17, and the checks that answer each.
 *
 * Written out rather than derived from the check ids, because "the nine groups are
 * covered" is a claim about MEANING: a group with no check would otherwise be
 * indistinguishable from a group whose check happens to be named differently.
 */
const CONTRACT_GROUPS: Readonly<Record<string, readonly EmbeddingConformanceCheckId[]>> =
  Object.freeze({
    'mapping and validation': Object.freeze([
      'embedding-mapping-index-faithful',
      'embedding-mapping-invalid-rejected',
      'embedding-vector-validation',
    ] as const),
    batching: Object.freeze([
      'embedding-batch-limits-respected',
      'embedding-batch-memory-bounded',
    ] as const),
    'cancellation and close': Object.freeze([
      'embedding-abort-stops-unsent',
      'embedding-close-covers-operation',
    ] as const),
    'retry and cost': Object.freeze([
      'embedding-retry-no-resend',
      'embedding-timeout-dispatch-unknown',
    ] as const),
    cache: Object.freeze(['embedding-cache-key-composition'] as const),
    compatibility: Object.freeze([
      'embedding-space-guard',
      'embedding-no-model-fallback',
    ] as const),
    'plugin compatibility': Object.freeze([
      'embedding-plugin-generation-only',
      'embedding-plugin-embedding-only',
    ] as const),
    'usage honesty': Object.freeze(['embedding-usage-honesty'] as const),
    privacy: Object.freeze(['embedding-trace-privacy'] as const),
  })

/** One suite run per provider, memoised: two describes read the same report. */
const REPORTS = new Map<string, Promise<ProviderConformanceReport>>()

function reportFor(provider: 'openai' | 'gemini'): Promise<ProviderConformanceReport> {
  const existing = REPORTS.get(provider)
  if (existing !== undefined) return existing
  const fixture = provider === 'openai'
    ? openAiEmbeddingConformanceFixture()
    : geminiEmbeddingConformanceFixture()
  // A failing suite THROWS, carrying the same report. It is unwrapped rather than
  // propagated so the assertions below can name which checks failed and why —
  // "the suite threw" is the least informative version of that.
  const started = runEmbeddingConformanceSuite(fixture).catch((error: unknown) => {
    if (error instanceof ProviderConformanceError) return error.report
    throw error
  })
  REPORTS.set(provider, started)
  return started
}

describe('Feature: embedding-support, Task 14.2: one embedding contract over two providers', () => {
  for (const provider of EMBEDDING_WIRE_PROVIDERS) {
    describe(`${provider} embedding plugin`, () => {
      it('runs every declared embedding check exactly once', async () => {
        const report = await reportFor(provider)
        expect(report.checks.map(check => check.id))
          .toEqual([...EMBEDDING_CONFORMANCE_CHECK_IDS])
      }, SUITE_TIMEOUT_MS)

      it('passes the whole embedding contract', async () => {
        const report = await reportFor(provider)
        // The failed checks' messages are the useful diagnostic, so they are the
        // value compared rather than a bare count.
        expect(report.checks.filter(check => check.status === 'failed').map(check => check.message))
          .toEqual([])
        expect({
          schemaVersion: report.schemaVersion,
          status: report.status,
          passed: report.passed,
          failed: report.failed,
        }).toEqual({
          schemaVersion: 1,
          status: 'passed',
          passed: EMBEDDING_CONFORMANCE_CHECK_IDS.length,
          failed: 0,
        })
      }, SUITE_TIMEOUT_MS)

      it('covers all nine contract-test groups', async () => {
        const report = await reportFor(provider)
        const passed = new Set(
          report.checks.filter(check => check.status === 'passed').map(check => check.id),
        )
        const coverage = Object.entries(CONTRACT_GROUPS).map(([group, ids]) => [
          group,
          ids.every(id => passed.has(id)),
        ])
        expect(Object.fromEntries(coverage))
          .toEqual(Object.fromEntries(Object.keys(CONTRACT_GROUPS).map(group => [group, true])))
      }, SUITE_TIMEOUT_MS)
    })
  }

  it('assigns every declared check to exactly one contract group', () => {
    const assigned = Object.values(CONTRACT_GROUPS).flatMap(ids => [...ids])
    expect(new Set(assigned).size).toBe(assigned.length)
    expect([...assigned].sort()).toEqual([...EMBEDDING_CONFORMANCE_CHECK_IDS].sort())
    expect(Object.keys(CONTRACT_GROUPS)).toHaveLength(9)
  })

  describe('one error taxonomy across both providers (Requirement 14.8)', () => {
    for (const fault of EMBEDDING_FAULTS) {
      it(`reports the same code on both providers for ${fault}`, async () => {
        // Both codes are compared to the expected value in ONE assertion, so a
        // failure shows which provider drifted and what it drifted to.
        const codes = await Promise.all(
          EMBEDDING_WIRE_PROVIDERS.map(async provider => [
            provider,
            await probeEmbeddingFault(provider, fault),
          ] as const),
        )
        expect(Object.fromEntries(codes)).toEqual({
          openai: EMBEDDING_FAULT_CODES[fault],
          gemini: EMBEDDING_FAULT_CODES[fault],
        })
      }, SUITE_TIMEOUT_MS)
    }

    it('covers a fault in each of mapping, dimensions and vector validity', () => {
      // The three families task 14.2 names, each pinned to the code both wires
      // must produce. Grouped rather than listed so a fault silently dropped from
      // EMBEDDING_FAULTS fails here instead of passing quietly.
      const families: Readonly<Record<string, readonly EmbeddingFault[]>> = {
        mapping: ['vector-count', 'response-shape'],
        dimensions: ['vector-width', 'dimensions-unsupported'],
        'vector validity': ['vector-value'],
      }
      const declared = new Set<EmbeddingFault>(EMBEDDING_FAULTS)
      expect(Object.fromEntries(
        Object.entries(families).map(([family, faults]) => [
          family,
          faults.every(fault => declared.has(fault)),
        ]),
      )).toEqual({ mapping: true, dimensions: true, 'vector validity': true })
    })
  })
})
