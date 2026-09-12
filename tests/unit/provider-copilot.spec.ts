/**
 * The generation conformance contract, run against Copilot ONCE PER ENDPOINT.
 *
 * Copilot is the only provider here whose single route dispatches to two wire
 * protocols. The risk that creates is not that either endpoint is broken — it is
 * that they DIVERGE, and that the one this repository happens to exercise is the
 * one that stays correct. So the entire existing generation scenario set runs
 * twice, and the two passes share every assertion: only the fixture's frames and
 * the `endpointOverrides` pin differ.
 *
 * The harness is untouched. Both passes produce the same 19-check report at
 * `schemaVersion: 1` that every other provider produces; the Copilot data is data.
 *
 * Requirements 15.1, 15.3.
 */

import { describe, expect, it } from 'vitest'
import { createTextMessage, type StreamChunk } from '@alvin0/ai-agent-sdk-core'
// Imported from source, as every other Copilot spec in this directory does: the
// package is not a workspace devDependency of the root, so the built entry point
// is not resolvable from here.
import { copilotAdapter } from '../../packages/provider-copilot/src/adapter.ts'
import { memoryCopilotCredentialStore } from '../../packages/provider-copilot/src/auth.ts'
import {
  COPILOT_CONFORMANCE_GITHUB_TOKEN,
  COPILOT_GENERATION_RUNS,
  PROVIDER_CONFORMANCE_REGISTRY,
  runProviderConformanceSuite,
  withCopilotTokenExchange,
  type CopilotGenerationRun,
  type ProviderConformanceCheckId,
  type ProviderConformanceReport,
} from '@alvin0/ai-agent-sdk-testkit'
import { officialProviderConformanceFixture } from './fixtures/official-provider-conformance.ts'

/** The credential store every pass reads: one long-lived GitHub token, in memory. */
const authStore = () => memoryCopilotCredentialStore({
  version: 1,
  github: { token: COPILOT_CONFORMANCE_GITHUB_TOKEN },
})

/**
 * One pass of the shared contract.
 *
 * `withCopilotTokenExchange` wraps the fixture's scripted fetch rather than
 * replacing it: the exchange is answered locally and everything else is delegated
 * untouched, so the exchange never lands in the dispatch counters the retry and
 * cancellation scenarios read.
 */
function fixtureFor(run: CopilotGenerationRun) {
  return officialProviderConformanceFixture({
    family: 'copilot',
    model: run.model,
    completeFrames: run.frames.completeFrames,
    missingUsageFrames: run.frames.missingUsageFrames,
    malformedUsageFrames: run.frames.malformedUsageFrames,
    createAdapter: input => copilotAdapter({
      authStore: authStore(),
      endpointOverrides: run.endpointOverrides,
      models: input.models,
      maxSseEvents: input.maxSseEvents,
      fetch: withCopilotTokenExchange(input.fetch),
    }),
  })
}

/** Stream one request through a pinned endpoint and return the serialized body. */
async function wireBody(run: CopilotGenerationRun): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined
  const adapter = copilotAdapter({
    authStore: authStore(),
    endpointOverrides: run.endpointOverrides,
    models: [{ id: run.model, name: run.model }],
    fetch: withCopilotTokenExchange((_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const encoded = new TextEncoder().encode(`${run.frames.completeFrames.join('\n\n')}\n\n`)
      return Promise.resolve(new Response(encoded, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      }))
    }),
  })
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'copilot', model: run.model, messages: [createTextMessage('hello')],
  })) chunks.push(chunk)
  expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  if (body === undefined) throw new Error('no generation request was dispatched')
  return body
}

/** Check ids and statuses, which both passes must report identically. */
function outcome(report: ProviderConformanceReport): readonly [ProviderConformanceCheckId, string][] {
  return report.checks.map(check => [check.id, check.status] as const)
}

describe('Copilot generation conformance across both endpoints (Requirements 15.1, 15.3)', () => {
  it('registers the generation scenario set under the Copilot family', () => {
    expect(PROVIDER_CONFORMANCE_REGISTRY.copilot.generation).toBe(COPILOT_GENERATION_RUNS)
    expect(COPILOT_GENERATION_RUNS.map(run => run.endpoint))
      .toEqual(['responses', 'chat-completions'])
    for (const run of COPILOT_GENERATION_RUNS) {
      expect(run.endpointOverrides).toEqual({ [run.model]: run.endpoint })
    }
  })

  /**
   * Both passes, run once on first demand and shared.
   *
   * Lazy rather than eager: a failing pass rejects, and a promise created during
   * collection would reject before any test is there to await it.
   */
  let pending: Promise<Map<string, ProviderConformanceReport>> | undefined
  const passes = () => (pending ??= (async () => {
    const entries: [string, ProviderConformanceReport][] = []
    for (const run of COPILOT_GENERATION_RUNS) {
      entries.push([run.endpoint,
        await runProviderConformanceSuite(fixtureFor(run), { caseTimeoutMs: 2_000 })])
    }
    return new Map(entries)
  })())

  for (const run of COPILOT_GENERATION_RUNS) {
    it(`passes the reusable provider conformance contract: ${run.label}`, async () => {
      const report = (await passes()).get(run.endpoint)
      expect(report).toMatchObject({ schemaVersion: 1, status: 'passed', passed: 19, failed: 0 })
      expect(report?.checks).toHaveLength(19)
    })
  }

  it('reports the identical check set on both endpoints', async () => {
    const reports = await passes()
    const responses = reports.get('responses')
    const chat = reports.get('chat-completions')
    if (responses === undefined || chat === undefined) throw new Error('a conformance pass did not run')
    expect(outcome(responses)).toEqual(outcome(chat))
    expect(responses.schemaVersion).toBe(chat.schemaVersion)
    expect(Object.keys(responses).sort()).toEqual(Object.keys(chat).sort())
  })

  it('dispatches genuinely different wire bodies for the two pinned endpoints', async () => {
    const [responses, chat] = await Promise.all(COPILOT_GENERATION_RUNS.map(wireBody))
    expect(responses).toHaveProperty('input')
    expect(responses).not.toHaveProperty('messages')
    expect(chat).toHaveProperty('messages')
    expect(chat).not.toHaveProperty('input')
  })
})
