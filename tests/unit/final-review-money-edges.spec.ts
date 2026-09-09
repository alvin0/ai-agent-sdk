/**
 * SDK regressions for final review 0c217c5, exercised against repository source.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { ModelAdapter } from '../../packages/core/src/contract/adapter.ts'
import type { StreamChunk } from '../../packages/core/src/stream/chunk.ts'
import type { ModelCallReport } from '../../packages/core/src/observation/report.ts'
import type { UsageCounters } from '../../packages/core/src/observation/usage.ts'
import { disabledDeliverySummary } from '../../packages/core/src/observation/port.ts'
import { addUsageCounters, validateUsageCounters } from '../../packages/core/src/observation/usage.ts'
import { aggregateUsage, aggregateCounterSets, budgetTokenTotal } from '../../packages/core/src/agent/accounting/usage.ts'
import { withRetry } from '../../packages/core/src/runtime/with-retry.ts'
import { raceWithSignal } from '../../packages/provider-http/src/base/transport.ts'

function report(id: string, reported: UsageCounters, estimated?: UsageCounters): ModelCallReport {
  // Stable fake identities only; the projection under test does not validate them.
  return {
    runId: 'money-test', traceId: '0123456789abcdef0123456789abcdef',
    modelCallId: id, spanId: '0123456789abcdef', provider: 'fake', model: 'fake',
    status: 'success', startedAt: '2026-09-06T00:00:00.000Z',
    endedAt: '2026-09-06T00:00:00.001Z', durationMs: 1,
    dispatchState: 'sent', attempts: [], reported,
    ...(estimated === undefined ? {} : { estimated }),
    coverage: estimated === undefined ? 'complete' : 'estimated',
    possiblyBilledAttemptsWithoutUsage: estimated === undefined ? 0 : 1,
    authoritative: estimated === undefined, delivery: disabledDeliverySummary(),
  } as unknown as ModelCallReport
}

class CleanupAdapter extends ModelAdapter {
  closed = 0
  async * stream(): AsyncIterable<StreamChunk> {
    try {
      yield { type: 'text-delta', index: 0, text: 'first' }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally { this.closed++ }
  }
}

describe('final review: money and cancellation invariants', () => {
  it('retains total-only attempt contributions when the logical aggregate cannot expose a total', () => {
    const call = { ...report('mixed-attempts', { inputTokens: 100 }), authoritative: false,
      coverage: 'partial', attempts: [
        { reported: { inputTokens: 100 }, coverage: 'partial', dispatchState: 'sent' },
        { reported: { totalTokens: 220 }, coverage: 'partial', dispatchState: 'sent' },
      ],
    } as unknown as ModelCallReport
    expect(budgetTokenTotal(aggregateUsage([call], []))).toBe(320)
  })

  it('uses a total-only estimate without losing the known reported input', () => {
    const usage = aggregateUsage([report('partial', { inputTokens: 100 }, { totalTokens: 220 })], [])
    expect(budgetTokenTotal(usage)).toBe(220)
    expect(usage.reported).toEqual({ inputTokens: 100 })
  })

  it('does not manufacture a total from buckets aggregated across partial attempts', () => {
    const attempts = addUsageCounters([{ inputTokens: 100 }, { inputTokens: 200, outputTokens: 20, totalTokens: 220 }])
    expect(aggregateCounterSets([attempts.counters], []).totalTokens).toBeUndefined()
  })

  it.each([1, 2, 3])('closes exactly once when explicitly returning at chunk %s', async stop => {
    const adapter = new CleanupAdapter()
    const iterator = withRetry(adapter).stream({ provider: 'test', model: 'test', messages: [] })[Symbol.asyncIterator]()
    for (let index = 0; index < stop; index++) await iterator.next()
    await iterator.return?.()
    await iterator.return?.()
    expect(adapter.closed).toBe(1)
  })

  it('closes the first-chunk iterator when the consumer throws', async () => {
    const adapter = new CleanupAdapter()
    await expect((async () => {
      for await (const _chunk of withRetry(adapter).stream({ provider: 'test', model: 'test', messages: [] })) {
        throw new Error('consumer failure')
      }
    })()).rejects.toThrow('consumer failure')
    expect(adapter.closed).toBe(1)
  })

  it('bounds an uncooperative first-chunk iterator return', async () => {
    class HangingClose extends ModelAdapter {
      stream(): AsyncIterable<StreamChunk> {
        return { [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false, value: { type: 'text-delta', index: 0, text: 'first' } }),
          return: () => new Promise(() => undefined),
        }) }
      }
    }
    const iterator = withRetry(new HangingClose(), { teardownTimeoutMs: 5 })
      .stream({ provider: 'test', model: 'test', messages: [] })[Symbol.asyncIterator]()
    await iterator.next()
    await expect(iterator.return?.()).rejects.toMatchObject({ code: 'MODEL_TEARDOWN_TIMEOUT' })
  })

  it('sums complete, partial and estimated calls without double-counting cache or reasoning', () => {
    const calls = [
      report('one', { inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
      report('two', { inputTokens: 20, cacheReadTokens: 30 }, { outputTokens: 5, reasoningTokens: 4 }),
      report('three', {}, { inputTokens: 200, cacheWriteTokens: 40, outputTokens: 20, reasoningTokens: 10 }),
    ].map((call, index) => ({ ...call, model: `model-${index}` }))
    for (const ordered of [calls, [...calls].reverse(), [calls[1]!, calls[2]!, calls[0]!]]) {
      const total = aggregateUsage(ordered, [])
      expect(budgetTokenTotal(total)).toBe(425)
      expect(total.authoritative).toBe(false)
      expect(total.reported.inputTokens).toBe(120)
      expect(total.estimated?.inputTokens).toBe(200)
    }
  })

  it('closes seeded valid counter sets under nested aggregation', () => {
    let seed = 0x0c217c5
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    for (let index = 0; index < 5_000; index++) {
      const values: UsageCounters[] = Array.from({ length: 1 + next() % 5 }, () => {
        const input = next() % 1000, output = next() % 200, cache = next() % 100
        switch (next() % 6) {
          case 0: return { inputTokens: input }
          case 1: return { totalTokens: input + output }
          case 2: return { outputTokens: output }
          case 3: return { reasoningTokens: output }
          case 4: return {}
          default: return { inputTokens: input, outputTokens: output, cacheReadTokens: cache,
            reasoningTokens: Math.floor(output / 2), totalTokens: input + output + cache }
        }
      })
      const sum = addUsageCounters(values)
      expect(validateUsageCounters(sum.counters).invalidFields).toEqual([])
      const nested = addUsageCounters([sum.counters, { inputTokens: 100 }])
      expect(validateUsageCounters(nested.counters).invalidFields).toEqual([])
      expect(() => aggregateCounterSets([nested.counters], [])).not.toThrow()
    }
  })

  it('preserves all known per-call contributions in 5000 seeded mixed budgets', () => {
    let seed = 0x0c217c5
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    for (let index = 0; index < 5_000; index++) {
      let expected = 0
      const calls = Array.from({ length: 1 + next() % 5 }, (_, call) => {
        const input = next() % 1000, output = next() % 200
        expected += input + output
        const counters = { inputTokens: input, outputTokens: output, totalTokens: input + output }
        return next() % 2 ? report(String(call), counters) : report(String(call), {}, counters)
      })
      expect(budgetTokenTotal(aggregateUsage(calls, []))).toBe(expected)
    }
  })

  it('preserves another call\'s estimated usage in the cumulative budget', () => {
    const total = aggregateUsage([
      report('known', { inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
      report('estimated', {}, { inputTokens: 200, outputTokens: 20, totalTokens: 220 }),
    ], [])
    expect(total.authoritative).toBe(false)
    expect(budgetTokenTotal(total)).toBe(330)
  })

  it('keeps an aggregate of valid partial attempts valid and re-aggregatable', () => {
    const values = [
      { inputTokens: 100 },
      { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
    ]
    for (const value of values) expect(validateUsageCounters(value).invalidFields).toEqual([])
    const total = addUsageCounters(values)
    expect(total.counters.inputTokens).toBe(300)
    expect(validateUsageCounters(total.counters).invalidFields).toEqual([])
    expect(() => aggregateCounterSets([total.counters], [])).not.toThrow()
    // No assertion invents a precise total for the missing output of attempt one.
  })

  it('closes the wrapped iterator when a retry consumer breaks on its first chunk', async () => {
    const adapter = new CleanupAdapter()
    const retried = withRetry(adapter, { policy: { mode: 'normal', maxRetries: 0 } })
    for await (const _chunk of retried.stream({ provider: 'fake', model: 'fake', messages: [] })) {
      break
    }
    expect(adapter.closed).toBe(1)
  })

  it('observes a rejected fetch promise even when the race signal is already aborted', () => {
    // This helper is self-contained: serialize the actual imported function into
    // a subprocess so a regression cannot crash/pollute the Vitest parent process.
    const body = `
      const race = ${raceWithSignal.toString()};
      const ac = new AbortController(); ac.abort(new Error('test cancellation'));
      await race(fetch('data:text/plain,local-only', { signal: ac.signal }), ac.signal).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 30));
    `
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    const child = spawnSync(process.execPath, ['--unhandled-rejections=throw', '--input-type=module', '-e', body], {
      encoding: 'utf8', timeout: 5_000, env,
    })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
  })
})
