import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ModelAdapter, ModelRegistry, createTextMessage,
  type GenerateOptions, type ModelInvocationContext, type ResolvedModelInfo, type StreamChunk,
} from '../../packages/core/src/index.ts'
import { modelCall } from '../../packages/core/src/agent/accounting/delivery/accounting-data.ts'

/** A monotonic clock the test advances by hand, so durations are exact. */
let now = 0
function advance(ms: number): void { now += ms }

type Script = (context: ModelInvocationContext | undefined) => AsyncIterable<StreamChunk>

class ScriptedAdapter extends ModelAdapter {
  constructor(private readonly script: Script) { super() }
  override providerInfo(provider: string) { return { id: provider, name: 'Scripted' } }
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  stream(_options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    return this.script(context)
  }
}

async function run(script: Script) {
  const registry = new ModelRegistry()
  registry.registerAdapter(['scripted'], new ScriptedAdapter(script))
  const call = registry.stream({ provider: 'scripted', model: 'm', messages: [createTextMessage('hi')] })
  for await (const _chunk of call) { /* drain */ }
  return call.report
}

async function startAttempt(context: ModelInvocationContext | undefined) {
  context?.declareProviderAttemptAccounting?.()
  const attempt = await context?.startProviderAttempt?.({
    provider: 'scripted', model: 'm', method: 'POST', origin: 'https://example.test',
  })
  if (attempt === undefined) throw new Error('registry did not expose provider attempts')
  return attempt
}

const usage = { inputTokens: 10, outputTokens: 40 }

beforeEach(() => {
  now = 1_000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})

afterEach(() => { vi.restoreAllMocks() })

describe('model-call first output time', () => {
  it('records time to first output for the call and the attempt that produced it', async () => {
    const report = await run(async function* (context) {
      advance(100)
      const attempt = await startAttempt(context)
      advance(250)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'he' }
      advance(400)
      yield { type: 'text-delta', index: 0, text: 'llo' }
      yield { type: 'usage', usage }
      attempt.end({ status: 'success', dispatchState: 'sent', reported: usage })
      yield { type: 'finish', reason: { kind: 'stop' } }
    })

    expect(report.firstOutputMs).toBe(350)
    expect(report.durationMs).toBe(750)
    expect(report.attempts).toHaveLength(1)
    expect(report.attempts[0]?.firstOutputMs).toBe(250)
    expect(report.attempts[0]?.durationMs).toBe(650)
    // The streaming window the caller divides output tokens by.
    expect(report.durationMs - (report.firstOutputMs ?? 0)).toBe(400)
  })

  it('does not count block-start as output', async () => {
    const report = await run(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      advance(300)
      yield { type: 'text-delta', index: 0, text: 'x' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(report.firstOutputMs).toBe(300)
  })

  it('counts a tool-call delta as the first output', async () => {
    const report = await run(async function* () {
      advance(120)
      yield { type: 'tool-call-delta', index: 0, id: 'call_1' as never, name: 'lookup', argumentsDelta: '{' }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })
    expect(report.firstOutputMs).toBe(120)
  })

  it('omits the field when a call produces no output', async () => {
    const report = await run(async function* (context) {
      const attempt = await startAttempt(context)
      advance(50)
      attempt.end({ status: 'success', dispatchState: 'sent', reported: usage })
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(report).not.toHaveProperty('firstOutputMs')
    expect(report.attempts[0]).not.toHaveProperty('firstOutputMs')
  })

  it('attributes first output only to the retry attempt that streamed it', async () => {
    const report = await run(async function* (context) {
      const failed = await startAttempt(context)
      advance(200)
      failed.end({ status: 'error', dispatchState: 'sent' })
      advance(100)
      const retry = await startAttempt(context)
      advance(80)
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'usage', usage }
      retry.end({ status: 'success', dispatchState: 'sent', reported: usage })
      yield { type: 'finish', reason: { kind: 'stop' } }
    })

    expect(report.firstOutputMs).toBe(380)
    const [first, second] = report.attempts
    expect(first).not.toHaveProperty('firstOutputMs')
    expect(second?.firstOutputMs).toBe(80)
  })

  it('keeps the first-output time when the caller stops reading mid-stream', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['scripted'], new ScriptedAdapter(async function* (context) {
      const attempt = await startAttempt(context)
      try {
        advance(60)
        yield { type: 'text-delta', index: 0, text: 'a' }
        advance(10)
        yield { type: 'text-delta', index: 0, text: 'b' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        attempt.end({ status: 'aborted', dispatchState: 'sent' })
      }
    }))
    const call = registry.stream({ provider: 'scripted', model: 'm', messages: [createTextMessage('hi')] })
    for await (const chunk of call) if (chunk.type === 'text-delta') break
    const report = await call.report
    expect(report.status).toBe('aborted')
    expect(report.firstOutputMs).toBe(60)
    expect(report.attempts[0]?.firstOutputMs).toBe(60)
  })

  it('keeps the first-output time when the stream throws after output', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['scripted'], new ScriptedAdapter(async function* () {
      advance(45)
      yield { type: 'text-delta', index: 0, text: 'partial' }
      throw new Error('connection reset')
    }))
    const call = registry.stream({ provider: 'scripted', model: 'm', messages: [createTextMessage('hi')] })
    const chunks = []
    for await (const chunk of call) chunks.push(chunk)
    const report = await call.report
    expect(report.status).not.toBe('success')
    expect(report.firstOutputMs).toBe(45)
  })

  it('keeps the first-output time on an attempt the adapter never ended', async () => {
    const report = await run(async function* (context) {
      await startAttempt(context)
      advance(30)
      yield { type: 'text-delta', index: 0, text: 'x' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(report.attempts[0]?.status).toBe('unknown')
    expect(report.attempts[0]?.firstOutputMs).toBe(30)
  })

  it('stamps an attempt opened after earlier output with its own first output', async () => {
    const report = await run(async function* (context) {
      advance(10)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'cached preamble' } }
      advance(5)
      const attempt = await startAttempt(context)
      advance(70)
      yield { type: 'text-delta', index: 1, text: 'fresh' }
      attempt.end({ status: 'success', dispatchState: 'sent', reported: usage })
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(report.firstOutputMs).toBe(10)
    expect(report.attempts[0]?.firstOutputMs).toBe(70)
  })

  it('ignores usage, usage-progress and finish chunks', async () => {
    const report = await run(async function* () {
      advance(20)
      yield { type: 'usage-progress', usage: { outputTokens: 3 } }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(report).not.toHaveProperty('firstOutputMs')
  })

  it('counts an image delta as output', async () => {
    const report = await run(async function* () {
      advance(500)
      yield { type: 'image-delta', index: 0, itemId: 'img_1', data: 'AAAA', mediaType: 'image/png', partialIndex: 0 }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(report.firstOutputMs).toBe(500)
  })

  it('reports a zero streaming window for a buffered (non-streaming) response', async () => {
    const report = await run(async function* () {
      advance(900)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'whole answer at once' } }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    // Throughput is undefined here: callers must not divide by this window.
    expect(report.firstOutputMs).toBe(900)
    expect(report.durationMs - (report.firstOutputMs ?? 0)).toBe(0)
  })

  it('truncates to whole microseconds and never exceeds durationMs', async () => {
    const report = await run(async function* (context) {
      const attempt = await startAttempt(context)
      advance(12.3456789)
      yield { type: 'text-delta', index: 0, text: 'x' }
      advance(0.0000004)
      attempt.end({ status: 'success', dispatchState: 'sent', reported: usage })
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(report.firstOutputMs).toBe(12.345)
    expect(report.attempts[0]?.firstOutputMs).toBe(12.345)
    expect(report.firstOutputMs).toBeLessThanOrEqual(report.durationMs)
    expect(report.attempts[0]?.firstOutputMs).toBeLessThanOrEqual(report.attempts[0]?.durationMs ?? 0)
  })

  it('rejects a negative firstOutputMs in the delivery sanitizer', async () => {
    const report = await run(async function* () {
      advance(5)
      yield { type: 'text-delta', index: 0, text: 'x' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const tampered = { ...report, firstOutputMs: -1 }
    expect(() => modelCall(tampered, report.runId, report.traceId, 1_000_000)).toThrow()
  })

  it('rejects a firstOutputMs beyond durationMs in the delivery sanitizer', async () => {
    const report = await run(async function* (context) {
      const attempt = await startAttempt(context)
      advance(5)
      yield { type: 'text-delta', index: 0, text: 'x' }
      attempt.end({ status: 'success', dispatchState: 'sent', reported: usage })
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const callTampered = { ...report, firstOutputMs: report.durationMs + 1 }
    expect(() => modelCall(callTampered, report.runId, report.traceId, 1_000_000)).toThrow()
    const attemptTampered = { ...report, attempts: report.attempts.map(row => ({ ...row, firstOutputMs: 1e9 })) }
    expect(() => modelCall(attemptTampered, report.runId, report.traceId, 1_000_000)).toThrow()
  })

  it('keeps firstOutputMs through the run-report delivery sanitizer', async () => {
    const report = await run(async function* (context) {
      const attempt = await startAttempt(context)
      advance(90)
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'usage', usage }
      attempt.end({ status: 'success', dispatchState: 'sent', reported: usage })
      yield { type: 'finish', reason: { kind: 'stop' } }
    })

    const sanitized = modelCall(report, report.runId, report.traceId, 1_000_000)
    expect(sanitized.firstOutputMs).toBe(90)
    expect(sanitized.attempts[0]?.firstOutputMs).toBe(90)
  })
})
