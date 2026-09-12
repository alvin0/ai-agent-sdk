import { describe, expect, it } from 'vitest'
import { ModelRegistry, withRetry } from '@alvin0/ai-agent-sdk-core'
import { defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import { anthropicAdapter } from '@alvin0/ai-agent-sdk-provider-anthropic'

const start = { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }
const content = [
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
]
const delta = (output: number) => ({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } })
const stop = { type: 'message_stop' }
const response = (frames: object[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } })

function session(fetch: typeof globalThis.fetch, retry = false) {
  const registry = new ModelRegistry()
  const adapter = anthropicAdapter({ apiKey: 'fixture', fetch, models: [{ id: 'test' }] })
  registry.registerAdapter(['test'], retry ? withRetry(adapter, { policy: {
    mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  } }) : adapter)
  return defineAgent({ id: 'progress', provider: 'test', model: 'test', effort: 'low',
    instructions: 'Reply.', compaction: false }).createSession({ registry })
}

describe('Anthropic provisional usage through SDK accounting', () => {
  it('replaces cumulative snapshots and finalizes exactly once', async () => {
    const handle = session(async () => response([start, ...content, delta(5), delta(9), stop])).stream('hello')
    const progress = []
    for await (const event of handle) if (event.type === 'usage-progress') progress.push(event)
    const report = await handle.report
    expect(progress.map(event => event.usage.outputTokens)).toEqual([1, 5, 9])
    expect(new Set(progress.map(event => event.attemptId)).size).toBe(1)
    expect(progress[0]?.attemptId).toBeTruthy()
    expect(report.modelCalls[0]?.attempts[0]).toMatchObject({ coverage: 'complete',
      reported: { inputTokens: 10, outputTokens: 9, totalTokens: 19 } })
    expect(report.usage.authoritative).toBe(true)
  })

  it('retains the last snapshot as partial when the stream ends before message_stop', async () => {
    const handle = session(async () => response([start, ...content, delta(5), delta(9)])).stream('hello')
    await handle.result.catch(() => undefined)
    const report = await handle.report
    expect(report.modelCalls[0]?.attempts[0]).toMatchObject({ coverage: 'partial',
      reported: { inputTokens: 10, outputTokens: 9, totalTokens: 19 } })
    expect(report.usage.authoritative).toBe(false)
  })

  it('still retries a pre-content error and keeps attempts separate', async () => {
    let calls = 0
    const handle = session(async () => response(++calls === 1
      ? [start, { type: 'error', error: { type: 'overloaded_error', message: 'try again' } }]
      : [start, ...content, delta(9), stop]), true).stream('hello')
    const ids = new Set<string | undefined>()
    for await (const event of handle) if (event.type === 'usage-progress') ids.add(event.attemptId)
    const report = await handle.report
    expect(calls).toBe(2)
    expect(ids.size).toBe(2)
    expect(report.modelCalls[0]?.attempts.map(attempt => attempt.coverage)).toEqual(['partial', 'complete'])
    expect(report.modelCalls[0]?.reported).toMatchObject({ inputTokens: 20, outputTokens: 10 })
    expect(report.usage.authoritative).toBe(false)
  })

  it('retains provisional usage and closes the body when aborted after the first snapshot', async () => {
    let cancelled = false
    const controller = new AbortController()
    const handle = session(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(start)}\n\n`)) },
      cancel() { cancelled = true },
    }), { headers: { 'content-type': 'text/event-stream' } }), true).stream('hello', { signal: controller.signal })
    await expect((async () => {
      for await (const event of handle) if (event.type === 'usage-progress') controller.abort()
    })()).rejects.toThrow(/aborted/i)
    const report = await handle.report
    expect(cancelled).toBe(true)
    expect(report.modelCalls[0]?.attempts[0]).toMatchObject({ coverage: 'partial',
      reported: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } })
    expect(report.usage.authoritative).toBe(false)
  })
})
