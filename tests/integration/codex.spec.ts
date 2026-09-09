/**
 * End-to-end tests against the real Codex endpoint.
 *
 * Excluded from `npm test`; run with `npm run test:integration`. Requires
 * `npm run provider:codex:login-device` first.
 *
 * These exercise the whole stack in one go — registry, base HTTP pipeline, SSE
 * decoding, the shared Responses wire, and the assembler — which is exactly what
 * unit tests with a mock server cannot tell you: that the wire contract is
 * actually right.
 */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BlockAssembler } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { createTextMessage } from '@alvin0/ai-agent-sdk-core'
import { ReasoningEffortId } from '@alvin0/ai-agent-sdk-core'
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { withRetry } from '@alvin0/ai-agent-sdk-core'
import { codexNodeAdapter as codexAdapter, fileCodexAuthStore } from '@alvin0/ai-agent-sdk-auth-node/codex'
import {
  MemoryObservationExporter,
  createObservability,
  type Observability,
} from '@alvin0/ai-agent-sdk-core/observability'

/** A model this account can reach. Discovered via the adapter's own catalog. */
const MODEL = 'gpt-5.6-luna'
const PROVIDER = 'codex'
const PROMPT = 'What colour is a clear midday sky? One word.'
const SYSTEM = 'Answer with a single lowercase word and no punctuation.'
const CONTENT_FIELD_NAMES = new Set([
  'answer', 'arguments', 'body', 'completion', 'content', 'filecontent', 'image',
  'input', 'messages', 'output', 'prompt', 'reasoning', 'requestbody', 'responsebody',
  'result', 'system', 'text', 'toolarguments', 'toolresult',
])

function contentFieldPaths(value: unknown, path: readonly string[] = []): string[] {
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item, index) => contentFieldPaths(item, [...path, String(index)]))
  return Object.entries(value).flatMap(([key, child]) => {
    const next = [...path, key]
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    return CONTENT_FIELD_NAMES.has(normalized) ? [next.join('.')] : contentFieldPaths(child, next)
  })
}

/** Skip the whole suite rather than fail it when nobody has logged in. */
const signedIn = await (async () => {
  const file = await fileCodexAuthStore(undefined, {
    cwd: process.cwd(),
    env: process.env,
  }).read()
  return file?.tokens != null
})()

async function collect(stream: AsyncIterable<StreamChunk>): Promise<{
  chunks: StreamChunk[]
  assembler: BlockAssembler
}> {
  const chunks: StreamChunk[] = []
  const assembler = new BlockAssembler()
  for await (const chunk of stream) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  return { chunks, assembler }
}

function registry(observation?: Observability): ModelRegistry {
  const instance = new ModelRegistry(observation === undefined ? {} : { observation })
  instance.registerAdapter([PROVIDER], codexAdapter({
    authStore: fileCodexAuthStore(undefined, {
      cwd: process.cwd(),
      env: process.env,
    }),
  }))
  return instance
}

describe.skipIf(!signedIn)('codex provider (live)', () => {
  it('finalizes an actual provider attempt when the consumer stops at its first text delta', async () => {
    const instance = new ModelRegistry()
    instance.registerAdapter([PROVIDER], withRetry(codexAdapter({
      authStore: fileCodexAuthStore(undefined, { cwd: process.cwd(), env: process.env }),
    }), { policy: { mode: 'normal', maxRetries: 0 } }))
    const handle = instance.stream({ provider: PROVIDER, model: MODEL,
      messages: [createTextMessage('Reply with the numbers one to ten in words.')],
      signal: AbortSignal.timeout(30_000),
    })
    let stopped = false
    for await (const chunk of handle) {
      if (chunk.type === 'text-delta') { stopped = true; break }
    }
    expect(stopped).toBe(true)
    const report = await handle.report
    expect(report.status).toBe('aborted')
    expect(report.attempts.length).toBeGreaterThan(0)
    expect(report.attempts.every(attempt => typeof attempt.endedAt === 'string')).toBe(true)
    expect(report.authoritative).toBe(false)
  })

  it('cancels a real provider response delivered late by an abort-ignoring custom fetch', async () => {
    let ready!: (status: number) => void, release!: () => void
    const headersReady = new Promise<number>(resolve => { ready = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let cancellations = 0
    const caller = new AbortController()
    const instance = new ModelRegistry()
    instance.registerAdapter([PROVIDER], codexAdapter({
      authStore: fileCodexAuthStore(undefined, { cwd: process.cwd(), env: process.env }),
      models: [{ id: MODEL }],
      fetch: async (input, init) => {
        const response = await fetch(input, { ...init, signal: AbortSignal.timeout(30_000) })
        if (response.body === null) throw new Error('live provider returned no body')
        reader = response.body.getReader()
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await reader!.read()
            if (next.done) controller.close()
            else controller.enqueue(next.value)
          },
          async cancel(reason) { cancellations++; await reader!.cancel(reason) },
        })
        ready(response.status)
        await released
        return new Response(body, { status: response.status, headers: response.headers })
      },
    }))
    const handle = instance.stream({ provider: PROVIDER, model: MODEL,
      messages: [createTextMessage(PROMPT)], signal: caller.signal })
    const consuming = collect(handle)
    void consuming.catch(() => undefined)
    try {
      const status = await Promise.race([
        headersReady,
        consuming.then(() => { throw new Error('live request ended before response headers') }),
      ])
      expect(status).toBe(200)
      caller.abort(new Error('live ownership probe'))
      await consuming
      const report = await handle.report
      expect(report.status).toBe('aborted')
      expect(report.authoritative).toBe(false)
      release()
      await vi.waitFor(() => expect(cancellations).toBe(1), { timeout: 5_000 })
    } finally {
      caller.abort()
      release()
      await reader?.cancel().catch(() => undefined)
      await consuming.catch(() => undefined)
    }
  })

  it('discovers the account model catalog', async () => {
    const models = await registry().listModels(PROVIDER)
    expect(models.length).toBeGreaterThan(0)
    // Discovery must report modalities, otherwise the base pipeline would treat
    // every model as text-only and silently strip image input.
    expect(models.some(model => model.inputModalities?.includes('image') === true)).toBe(true)
  }, 60_000)

  it('streams text and assembles a message', async () => {
    const exporter = new MemoryObservationExporter('codex-live-safe-report')
    const observation = createObservability({
      content: 'none',
      exporters: [{ exporter, requirement: 'best-effort', boundary: 'none' }],
    })
    onTestFinished(async () => { await observation.shutdown() })
    const handle = registry(observation).stream({
      provider: PROVIDER,
      model: MODEL,
      reasoningEffort: ReasoningEffortId('medium'),
      system: SYSTEM,
      messages: [createTextMessage(PROMPT)],
    })
    const { chunks, assembler } = await collect(handle)
    const report = await handle.report

    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type !== 'finish') throw new Error('expected a terminal finish chunk')
    expect(finish.reason.kind).toBe('stop')

    // The protocol promises deltas arrive before the authoritative block-end.
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    expect(chunks.some(chunk => chunk.type === 'block-end')).toBe(true)

    const message = assembler.message({ kind: 'model', provider: PROVIDER, model: MODEL })
    const text = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(text.toLowerCase()).toContain('blue')

    const usage = assembler.usage
    expect(usage).toBeDefined()
    expect(usage?.inputTokens).toBeGreaterThan(0)
    expect(usage?.outputTokens).toBeGreaterThan(0)

    expect(report).toMatchObject({
      runId: handle.runId,
      modelCallId: handle.modelCallId,
      provider: PROVIDER,
      model: MODEL,
      status: 'success',
      finishReason: 'stop',
      coverage: 'complete',
      authoritative: true,
      possiblyBilledAttemptsWithoutUsage: 0,
      delivery: { complete: true },
    })
    expect(report.reported.inputTokens).toBeGreaterThan(0)
    expect(report.reported.outputTokens).toBeGreaterThan(0)
    expect(report.reported.totalTokens).toBeGreaterThan(0)
    expect(report.attempts.length).toBeGreaterThan(0)
    expect(report.attempts.every(attempt => attempt.coverage === 'complete')).toBe(true)
    expect(report.attempts.every(attempt => attempt.dispatchState === 'sent')).toBe(true)

    const flush = await observation.flush()
    expect(flush).toMatchObject({ complete: true, pendingEvents: 0, rejectedCritical: 0 })
    const health = observation.health()
    expect(health).toMatchObject({
      state: 'healthy', queuedEvents: 0, criticalRejected: 0,
      processorFailures: 0, exporterFailures: 0,
    })
    const events = exporter.events()
    const modelEvents = events.filter(event => event.name === 'sdk.model.call')
    const attemptEvents = events.filter(event => event.name === 'sdk.provider.attempt')
    expect(modelEvents.length).toBe(2)
    expect(modelEvents.every(event => event.correlation.runId === report.runId
      && event.correlation.modelCallId === report.modelCallId)).toBe(true)
    expect(attemptEvents.length).toBe(report.attempts.length * 2)
    expect(attemptEvents.every(event => event.correlation.runId === report.runId
      && event.correlation.modelCallId === report.modelCallId
      && report.attempts.some(attempt => attempt.attemptId === event.correlation.attemptId))).toBe(true)
    for (const attempt of report.attempts) {
      const terminal = attemptEvents.find(event => event.phase === 'end'
        && event.correlation.attemptId === attempt.attemptId)
      expect(terminal).toBeDefined()
      if (attempt.providerRequestId !== undefined) {
        expect(terminal?.correlation.providerRequestId).toBe(attempt.providerRequestId)
        expect(terminal?.data.providerRequestId).toBe(attempt.providerRequestId)
      }
    }
    expect(events.flatMap(event => contentFieldPaths(event.data))).toEqual([])

    const artifactDirectory = resolve(
      process.env.AI_AGENT_SDK_LIVE_REPORT_DIR ?? '.temp/live-acceptance',
    )
    await mkdir(artifactDirectory, { recursive: true })
    const artifactPath = resolve(artifactDirectory, 'codex-luna-safe-report.json')
    await writeFile(artifactPath, `${JSON.stringify({
      schemaVersion: 1,
      provider: report.provider,
      model: report.model,
      status: report.status,
      finishReason: report.finishReason,
      runId: report.runId,
      traceId: report.traceId,
      modelCallId: report.modelCallId,
      spanId: report.spanId,
      coverage: report.coverage,
      reported: report.reported,
      attempts: report.attempts,
      delivery: report.delivery,
      observationHealth: health,
      observedEventNames: [...new Set(events.map(event => event.name))].sort(),
    }, null, 2)}\n`, { mode: 0o600 })
    await chmod(artifactPath, 0o600)
  }, 120_000)

  it('emits a tool call with parseable arguments', async () => {
    const { chunks, assembler } = await collect(registry().stream({
      provider: PROVIDER,
      model: MODEL,
      reasoningEffort: ReasoningEffortId('medium'),
      system: 'Use the get_weather tool to answer. Do not answer from memory.',
      messages: [createTextMessage('What is the weather in Hanoi right now?')],
      tools: [{
        name: 'get_weather',
        description: 'Look up the current weather for a city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      }],
      toolChoice: 'required',
    }))

    const finish = chunks.at(-1)
    if (finish?.type !== 'finish') throw new Error('expected a terminal finish chunk')
    expect(finish.reason.kind).toBe('tool-calls')

    const calls = assembler.blocks()
      .filter((block): block is Extract<typeof block, { type: 'tool-call' }> =>
        block.type === 'tool-call')
    expect(calls.length).toBeGreaterThan(0)
    const call = calls[0]
    expect(call?.name).toBe('get_weather')
    expect(call?.id.length).toBeGreaterThan(0)
    // Arguments stay a raw string on the wire; they must still be valid JSON here.
    const args = JSON.parse(call?.arguments ?? '{}') as { city?: string }
    expect(typeof args.city).toBe('string')
  }, 120_000)

  it('reports an unknown model as a non-retryable request error', async () => {
    const { chunks } = await collect(registry().stream({
      provider: PROVIDER,
      model: 'definitely-not-a-real-model',
      messages: [createTextMessage('hi')],
    }))
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish') throw new Error('expected a terminal finish chunk')
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind !== 'error') return
    expect(finish.reason.failure.code).toBe('INVALID_REQUEST')
    expect(finish.reason.failure.status).toBe(400)
    // The `{"detail": ...}` body shape must survive into a readable message.
    expect(finish.reason.failure.message).toMatch(/not supported/i)
  }, 60_000)
})
