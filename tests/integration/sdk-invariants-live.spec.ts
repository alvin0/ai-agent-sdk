/**
 * SDK invariants against a real endpoint.
 *
 * Excluded from `npm test`; run with `npm run test:integration`. Needs
 * `npm run provider:codex:login-device`; without a credential the suite SKIPS.
 *
 * Everything here is a claim the SDK makes about ITSELF — accounting, run
 * status, tool-call pairing, structured output, trace shape — checked against
 * traffic nobody scripted. A mock adapter answers exactly what a fixture says,
 * so it can prove the code handles that shape; it cannot prove the shape is the
 * one a provider sends, and these invariants are the ones that would go quiet
 * rather than loud if it were not.
 */

import { describe, expect, it } from 'vitest'
import { createAgentRuntime, type AgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { codexNodeProviderPlugin, fileCodexAuthStore } from '@alvin0/ai-agent-sdk-auth-node/codex'

const ROUTE = 'codex'
const MODEL = 'gpt-5.6-luna'

const codexLive = await (async () => {
  const file = await fileCodexAuthStore(undefined, { cwd: process.cwd(), env: process.env }).read()
  return file?.tokens != null
})()

async function runtimeFor(): Promise<AgentRuntime> {
  return await createAgentRuntime({
    providers: [codexNodeProviderPlugin({ defaultModel: MODEL })],
    defaultProvider: ROUTE,
  })
}

describe.skipIf(!codexLive)('SDK invariants on live traffic', () => {
  it('accounts a finished run with disjoint counts and one report per model call', async () => {
    const runtime = await runtimeFor()
    const session = runtime.agent({
      id: 'accounting', model: { provider: ROUTE, id: MODEL }, effort: 'low',
      instructions: 'Answer in one short sentence.', compaction: false,
    }).createSession()

    const response = await session.run('Name the largest ocean on Earth.')
    const report = response.report

    expect(report.status).toBe('success')
    expect(report.modelCalls.length).toBeGreaterThan(0)
    for (const call of report.modelCalls) {
      expect(call.provider).toBe(ROUTE)
      expect(call.model).toBe(MODEL)
      expect(call.status).toBe('success')
      expect(call.attempts.length).toBeGreaterThan(0)
      expect(new Date(call.endedAt).getTime()).toBeGreaterThanOrEqual(new Date(call.startedAt).getTime())
    }
    const usage = report.usage.reported
    // The three input kinds are disjoint by contract, so a total that is less
    // than their sum means one of them was counted twice.
    const inputs = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    expect(usage.totalTokens ?? 0).toBeGreaterThanOrEqual(inputs + (usage.outputTokens ?? 0))
    expect(report.usage.coverage.possiblyBilledAttemptsWithoutUsage).toBe(0)
    expect(report.usage.authoritative).toBe(true)
    expect(report.errors).toEqual([])

    const closed = await runtime.close()
    expect(closed).toMatchObject({ state: 'closed', unsettledRuns: 0, abortedRuns: 0 })
  }, 300_000)

  it('stops a run mid-stream on abort and reports it as aborted, once', async () => {
    const runtime = await runtimeFor()
    const session = runtime.agent({
      id: 'aborting', model: { provider: ROUTE, id: MODEL }, effort: 'low',
      instructions: 'Answer at length.', compaction: false,
    }).createSession()

    const handle = session.stream('Write 500 words about the history of the bicycle.')
    const seen: string[] = []
    let abortedAt = -1
    for await (const event of handle) {
      seen.push(event.type)
      if (abortedAt < 0 && event.type === 'assistant-delta') {
        abortedAt = seen.length
        handle.abort()
      }
    }
    expect(abortedAt, 'the model never produced text to interrupt').toBeGreaterThan(0)

    const report = await handle.report
    expect(report.status).toBe('aborted')
    // One terminal record for one run, and the ledger still closes its calls.
    expect(report.runId).toBe(handle.runId)
    for (const call of report.modelCalls) {
      expect(['success', 'aborted', 'error']).toContain(call.status)
    }
    // The session is reusable: an abort ends a run, not a conversation.
    expect(session.isRunning).toBe(false)
    const after = await session.run('Reply with exactly: ready')
    expect(after.report.status).toBe('success')

    await runtime.close()
  }, 300_000)

  it('pairs every live tool call with exactly one result and unique ids', async () => {
    const runtime = await runtimeFor()
    const calls: { id: string; name: string }[] = []
    const results: string[] = []
    const session = runtime.agent({
      id: 'tools', model: { provider: ROUTE, id: MODEL }, effort: 'low',
      instructions: 'Use the supplied tools. Never guess a value a tool can give you.',
      compaction: false,
      tools: [{
        name: 'lookup_population',
        description: 'Population of one city, in millions.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        execute: (input: unknown) => {
          const city = String((input as { city?: unknown }).city ?? '')
          const table: Record<string, number> = { hanoi: 8.4, oslo: 0.7, lima: 10.1 }
          return { value: table[city.toLowerCase()] ?? 0 }
        },
      }],
    }).createSession()

    const response = await session.run(
      'Use the tool for Hanoi, Oslo and Lima, then report the three numbers in one line.',
      {
        onEvent: (event) => {
          if (event.type === 'tool-call') calls.push({ id: event.callId, name: event.name })
          if (event.type === 'tool-result') results.push(event.callId)
        },
      },
    )

    expect(calls.length).toBeGreaterThan(0)
    expect(new Set(calls.map(call => call.id)).size).toBe(calls.length)
    // Every call is answered exactly once; an unanswered one leaves the provider
    // history unpaired on the next turn, which providers reject outright.
    expect([...results].sort()).toEqual([...calls.map(call => call.id)].sort())
    expect(response.report.status).toBe('success')

    // And the conversation survives replaying that tool traffic to the model.
    const followUp = await session.run('Which of those three was the largest? One word.')
    expect(followUp.report.status).toBe('success')

    await runtime.close()
  }, 420_000)

  it('returns validated structured output alongside the text', async () => {
    const runtime = await runtimeFor()
    const session = runtime.agent({
      id: 'structured', model: { provider: ROUTE, id: MODEL }, effort: 'low',
      instructions: 'Answer only through the supplied schema.', compaction: false,
    }).createSession()

    const response = await session.run('The capital of Norway, and the year it was founded.', {
      structuredOutput: {
        name: 'capital',
        schema: {
          jsonSchema: {
            type: 'object',
            properties: { city: { type: 'string' }, founded: { type: 'number' } },
            required: ['city', 'founded'],
            additionalProperties: false,
          },
          parse: (value: unknown) => {
            const record = value as { city?: unknown; founded?: unknown }
            if (typeof record.city !== 'string' || typeof record.founded !== 'number') {
              throw new TypeError('structured output did not match the schema')
            }
            return { city: record.city, founded: record.founded }
          },
        },
      },
    })

    expect(response.report.status).toBe('success')
    expect(response.output).toMatchObject({ city: expect.any(String), founded: expect.any(Number) })
    expect(String((response.output as { city: string }).city).toLowerCase()).toContain('oslo')
    await runtime.close()
  }, 300_000)

  it('compacts a real conversation and keeps answering from the summary', async () => {
    const runtime = await runtimeFor()
    const session = runtime.agent({
      id: 'compacting', model: { provider: ROUTE, id: MODEL }, effort: 'low',
      instructions: 'Answer briefly.',
      // A deliberately tiny threshold, so a handful of ordinary turns crosses it
      // against the live model rather than needing a fabricated context window.
      compaction: { auto: true, maxInputTokens: 900, thresholdRatio: 0.5, retainTokens: 200 },
    }).createSession()

    await session.run('Remember these two facts: the safe code is 7741, and the courier is named Mira.')
    for (const filler of [
      'Describe the water cycle in three sentences.',
      'Describe photosynthesis in three sentences.',
      'Describe plate tectonics in three sentences.',
      'Describe the carbon cycle in three sentences.',
    ]) await session.run(filler)

    const recall = await session.run('What is the safe code and who is the courier? One line.')
    expect(recall.report.status).toBe('success')
    // Compaction rewrites history; it must not lose what the conversation was
    // told to keep. Failing here means the summary dropped the objective.
    expect(recall.text).toContain('7741')
    expect(recall.text.toLowerCase()).toContain('mira')

    const snapshot = session.snapshot()
    expect(snapshot.history.entries.length).toBeGreaterThan(0)
    await runtime.close()
  }, 600_000)

  it('runs two sessions of one runtime at the same time without mixing them up', async () => {
    const runtime = await runtimeFor()
    const agent = runtime.agent({
      id: 'parallel', model: { provider: ROUTE, id: MODEL }, effort: 'low',
      instructions: 'Reply with the single word you are given, lowercase.', compaction: false,
    })
    const left = agent.createSession()
    const right = agent.createSession()

    const [first, second] = await Promise.all([
      left.run('Reply with exactly: albatross'),
      right.run('Reply with exactly: zeppelin'),
    ])

    expect(first.text.toLowerCase()).toContain('albatross')
    expect(second.text.toLowerCase()).toContain('zeppelin')
    // Two runs, two identities: a shared counter or a shared ledger would show
    // up here as one run id, or as one conversation.
    expect(first.runId).not.toBe(second.runId)
    expect(first.traceId).not.toBe(second.traceId)
    expect(left.conversationId).not.toBe(right.conversationId)
    for (const report of [first.report, second.report]) {
      expect(report.status).toBe('success')
      expect(report.modelCalls.every(call => call.runId === report.runId)).toBe(true)
    }

    const closed = await runtime.close()
    expect(closed).toMatchObject({ state: 'closed', unsettledRuns: 0 })
  }, 420_000)

  it('closes a runtime while a run is in flight and says what it ended', async () => {
    const runtime = await runtimeFor()
    const session = runtime.agent({
      id: 'closing', model: { provider: ROUTE, id: MODEL }, effort: 'low',
      instructions: 'Answer at length.', compaction: false,
    }).createSession()

    const handle = session.stream('Write 500 words about the history of lighthouses.')
    // Wait for the model to be genuinely mid-answer before pulling the runtime
    // out from under it. Closing on the first event proves nothing: the first
    // event arrives before the provider has been dialled at all.
    //
    // The stream is consumed in the background rather than broken out of:
    // abandoning the iterator is itself a cancellation, and a run this test
    // cancelled is not a run the close had to end.
    let announce: (() => void) | undefined
    const streaming = new Promise<void>((resolve) => { announce = resolve })
    let sawContent = false
    const consumed = (async () => {
      for await (const event of handle) {
        if (event.type === 'assistant-delta' || event.type === 'assistant-reasoning') {
          sawContent = true
          announce?.()
        }
      }
    })().catch(() => undefined)
    await Promise.race([streaming, new Promise(settle => setTimeout(settle, 60_000))])
    expect(sawContent, 'the model never started answering').toBe(true)
    const closed = await runtime.close()
    await consumed

    expect(closed.state).toBe('closed')
    expect(closed.activeRunsAtClose).toBeGreaterThan(0)
    // Every run is accounted for: the ones it ended are counted, none are left
    // unsettled, and the report does not claim a clean idle shutdown.
    expect(closed.unsettledRuns).toBe(0)
    expect(closed.abortedRuns + closed.activeRunsAtClose).toBeGreaterThan(0)
    const report = await handle.report
    expect(['aborted', 'error']).toContain(report.status)
  }, 300_000)

  it('emits a trace whose spans all close, under one run and one trace id', async () => {
    const runtime = await runtimeFor()
    const session = runtime.agent({
      id: 'tracing', model: { provider: ROUTE, id: MODEL }, effort: 'low',
      instructions: 'Answer in one word.', compaction: false,
    }).createSession()

    const started = new Map<string, string>()
    const ended = new Set<string>()
    const traceIds = new Set<string>()
    const handle = session.stream('Reply with exactly: ok', { includeTraceEvents: true })
    for await (const event of handle) {
      traceIds.add(event.traceId)
      if (event.type === 'span-start') started.set(event.trace.spanId, event.name)
      if (event.type === 'span-end') ended.add(event.trace.spanId)
    }
    await handle.result

    expect(started.size).toBeGreaterThan(0)
    // A span that never closes is a leak in the trace, and the one place it
    // shows up is a live stream where timing is not a fixture's to decide.
    const open = [...started].filter(([spanId]) => !ended.has(spanId)).map(([, name]) => name)
    expect(open, `spans left open: ${open.join(', ')}`).toEqual([])
    expect(traceIds.size, 'one run must report under one trace id').toBe(1)

    await runtime.close()
  }, 300_000)
})
