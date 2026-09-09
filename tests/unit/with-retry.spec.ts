import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '@ai-agent-sdk/core'
import type { GenerateOptions } from '@ai-agent-sdk/core'
import { ModelError } from '@ai-agent-sdk/core'
import { createTextMessage } from '@ai-agent-sdk/core'
import { withRetry, type RetryAttempt } from '@ai-agent-sdk/core'
import type { StreamChunk } from '@ai-agent-sdk/core'

/** Replays a scripted outcome per attempt, counting how many were made. */
class ScriptedAdapter extends ModelAdapter {
  attempts = 0

  constructor(private readonly outcomes: readonly (() => AsyncIterable<StreamChunk>)[]) {
    super()
  }

  stream(): AsyncIterable<StreamChunk> {
    const outcome = this.outcomes[Math.min(this.attempts, this.outcomes.length - 1)]
    this.attempts += 1
    if (outcome === undefined) throw new Error('no scripted outcome')
    return outcome()
  }
}

function failing(code: string): () => AsyncIterable<StreamChunk> {
  return () => {
    throw new ModelError(`failed with ${code}`, code)
  }
}

function succeeding(text = 'ok'): () => AsyncIterable<StreamChunk> {
  return async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const request: GenerateOptions = {
  provider: 'p',
  model: 'm',
  messages: [createTextMessage('hi')],
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** No jitter and near-zero delays so tests do not actually sleep. */
const fast = {
  policy: {
    mode: 'normal' as const,
    maxRetries: 3,
    backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  },
  random: () => 0.5,
}

describe('withRetry', () => {
  it('retries a transient failure and forwards the eventual success', async () => {
    const inner = new ScriptedAdapter([failing('SERVER'), succeeding('recovered')])
    const chunks = await drain(withRetry(inner, fast).stream(request))
    expect(inner.attempts).toBe(2)
    expect(chunks[0]).toEqual({ type: 'text-delta', index: 0, text: 'recovered' })
  })

  it('does not retry a permanent failure', async () => {
    const inner = new ScriptedAdapter([failing('AUTH'), succeeding()])
    const chunks = await drain(withRetry(inner, fast).stream(request))
    expect(inner.attempts).toBe(1)
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') {
      throw new Error('expected a terminal error finish')
    }
    expect(finish.reason.failure.code).toBe('AUTH')
  })

  it('stops at the retry ceiling', async () => {
    const inner = new ScriptedAdapter([failing('SERVER')])
    await drain(withRetry(inner, fast).stream(request))
    // The first attempt plus three retries.
    expect(inner.attempts).toBe(4)
  })

  it('does NOT retry once a chunk has reached the consumer', async () => {
    // The load-bearing constraint. Re-running after output has been delivered
    // would replay those tokens and the consumer would render them twice, so a
    // mid-stream failure is passed through untouched.
    //
    // "Passed through" means it stays THROWN at this layer. This decorator wraps
    // an adapter, and adapters sit inside the registry's failure funnel, which is
    // the one place that converts a throw into a terminal error finish. Asserting
    // a finish chunk here would be asserting the registry's job on a bare adapter.
    const emitted: StreamChunk[] = []
    const inner = new ScriptedAdapter([
      async function* () {
        yield { type: 'text-delta', index: 0, text: 'already sent' }
        throw new ModelError('died mid-stream', 'SERVER')
      },
      succeeding('would-be-duplicate'),
    ])

    await expect((async () => {
      for await (const chunk of withRetry(inner, fast).stream(request)) emitted.push(chunk)
    })()).rejects.toThrow('died mid-stream')

    expect(inner.attempts).toBe(1)
    expect(emitted).toEqual([{ type: 'text-delta', index: 0, text: 'already sent' }])
  })

  it('lets the registry funnel convert that same mid-stream failure to a finish', async () => {
    // The other half of the layering above: composed as intended, the caller does
    // get a terminal chunk rather than a throw.
    const { ModelRegistry } = await import('@ai-agent-sdk/core')
    const inner = new ScriptedAdapter([
      async function* () {
        yield { type: 'text-delta', index: 0, text: 'already sent' }
        throw new ModelError('died mid-stream', 'SERVER')
      },
    ])
    const registry = new ModelRegistry()
    registry.registerAdapter(['p'], withRetry(inner, fast))

    const chunks = await drain(registry.stream(request))
    expect(chunks.map(c => c.type)).toEqual(['text-delta', 'finish'])
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') {
      throw new Error('expected a terminal error finish')
    }
    expect(finish.reason.failure.code).toBe('SERVER')
  })

  it('retries a terminal error finish delivered as the first chunk', async () => {
    // Behind the registry's funnel a failure arrives as a chunk rather than a
    // throw. As the first chunk, nothing was emitted, so it is still retryable.
    const inner = new ScriptedAdapter([
      async function* () {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'x', code: 'SERVER' } },
        }
      },
      succeeding('recovered'),
    ])

    const chunks = await drain(withRetry(inner, fast).stream(request))
    expect(inner.attempts).toBe(2)
    expect(chunks[0]).toEqual({ type: 'text-delta', index: 0, text: 'recovered' })
  })

  it('never retries an abort', async () => {
    const inner = new ScriptedAdapter([failing('ABORTED'), succeeding()])
    const chunks = await drain(withRetry(inner, fast).stream(request))
    expect(inner.attempts).toBe(1)
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish') throw new Error('expected a finish chunk')
    expect(finish.reason.kind).toBe('aborted')
  })

  it('reports each scheduled retry so it can be logged', async () => {
    const onRetry = vi.fn<(attempt: RetryAttempt) => void>()
    const inner = new ScriptedAdapter([failing('TIMEOUT'), succeeding()])
    await drain(withRetry(inner, { ...fast, onRetry }).stream(request))
    expect(onRetry).toHaveBeenCalledTimes(1)
    const attempt = onRetry.mock.calls[0]?.[0]
    expect(attempt?.attempt).toBe(1)
    expect(attempt?.maxRetries).toBe(3)
    expect(attempt?.failure.code).toBe('TIMEOUT')
  })

  it('contains a broken retry observer', async () => {
    const inner = new ScriptedAdapter([failing('TIMEOUT'), succeeding('recovered')])
    const chunks = await drain(withRetry(inner, {
      ...fast,
      onRetry: () => { throw new Error('metrics sink unavailable') },
    }).stream(request))
    expect(inner.attempts).toBe(2)
    expect(chunks[0]).toEqual({ type: 'text-delta', index: 0, text: 'recovered' })
  })

  it('refuses to retry when the failed attempt ignores teardown', async () => {
    const hangingFailure = (): AsyncIterable<StreamChunk> => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({
            done: false as const,
            value: {
              type: 'finish' as const,
              reason: { kind: 'error' as const, failure: { message: 'retry', code: 'TIMEOUT' } },
            },
          }),
          return: () => new Promise<IteratorResult<StreamChunk>>(() => {}),
        }
      },
    })
    const inner = new ScriptedAdapter([hangingFailure, succeeding('bounded')])
    const started = Date.now()
    await expect(drain(withRetry(inner, {
      ...fast, teardownTimeoutMs: 10,
    }).stream(request))).rejects.toMatchObject({ code: 'MODEL_TEARDOWN_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(250)
    expect(inner.attempts).toBe(1)
  })

  it('requires a cancellation boundary for an always retry policy', async () => {
    const inner = new ScriptedAdapter([failing('SERVER')])
    const chunks = await drain(withRetry(inner, {
      policy: { mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1 } },
    }).stream(request))
    expect(inner.attempts).toBe(0)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST' } },
    })
  })

  it('gives up when the provider asks to wait longer than the policy allows', async () => {
    // Sleeping less than asked would just earn another rate-limit response.
    const inner = new ScriptedAdapter([() => {
      throw new ModelError('slow down', 'RATE_LIMIT', { providerRetryAfterMs: 60_000 })
    }])
    const chunks = await drain(withRetry(inner, fast).stream(request))
    expect(inner.attempts).toBe(1)
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') {
      throw new Error('expected a terminal error finish')
    }
    expect(finish.reason.failure.code).toBe('RATE_LIMIT')
  })

  it('delegates metadata to the wrapped adapter', async () => {
    const inner = new ScriptedAdapter([succeeding()])
    const wrapped = withRetry(inner, fast)
    expect(wrapped.providerInfo('p')).toEqual(inner.providerInfo('p'))
    await expect(wrapped.resolveModel('p', 'm')).resolves.toEqual(
      await inner.resolveModel('p', 'm'),
    )
  })
})
