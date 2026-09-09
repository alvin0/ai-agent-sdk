import { describe, expect, it } from 'vitest'
import {
  addUsageCounters,
  classifyUsageCoverage,
  possiblyBilledAttemptsWithoutUsage,
  validateUsageCounters,
  type AttemptUsageReport,
} from '@ai-agent-sdk/core'
import { createSpanId } from '@ai-agent-sdk/core'

function attempt(overrides: Partial<AttemptUsageReport> = {}): AttemptUsageReport {
  return {
    attemptId: 'attempt',
    spanId: createSpanId(),
    attemptNumber: 1,
    status: 'success',
    startedAt: '2026-09-01T00:00:00.000Z',
    endedAt: '2026-09-01T00:00:01.000Z',
    durationMs: 1_000,
    dispatchState: 'sent',
    coverage: 'complete',
    reported: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    ...overrides,
  }
}

describe('usage validation and aggregation', () => {
  it('omits invalid fields and rejects inconsistent totals/reasoning subsets', () => {
    const result = validateUsageCounters({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 3,
      reasoningTokens: 7,
      cacheReadTokens: -1,
    }, true)
    expect(result.reported).toEqual({ inputTokens: 4, outputTokens: 2 })
    expect(result.invalidFields).toEqual(expect.arrayContaining(['totalTokens', 'reasoningTokens', 'cacheReadTokens']))
    expect(result.complete).toBe(false)
  })

  it('saturates aggregate counters and exposes overflow', () => {
    const result = addUsageCounters([
      { inputTokens: Number.MAX_SAFE_INTEGER, totalTokens: Number.MAX_SAFE_INTEGER },
      { inputTokens: 1, totalTokens: 2 },
    ])
    expect(result.counters).toEqual({ inputTokens: Number.MAX_SAFE_INTEGER, totalTokens: Number.MAX_SAFE_INTEGER })
    expect(result.overflow).toBe(true)
  })

  it('retains individually valid buckets when their disjoint total overflows', () => {
    const counters = { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER }
    expect(validateUsageCounters(counters)).toMatchObject({ reported: counters, invalidFields: [], overflow: true })
    expect(addUsageCounters([counters])).toEqual({ counters, overflow: true })
    expect(addUsageCounters([{ inputTokens: Number.MAX_SAFE_INTEGER }, { outputTokens: 1 }]))
      .toEqual({ counters: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }, overflow: true })
  })

  it('contains unreadable provider counters and refuses invalid aggregation input', () => {
    const hostile = new Proxy({}, {
      get(_target, key) {
        if (key === 'inputTokens') throw new Error('hostile usage getter')
        return key === 'outputTokens' ? 2 : undefined
      },
    })
    const result = validateUsageCounters(hostile, true)
    expect(result.reported).toEqual({ outputTokens: 2 })
    expect(result.invalidFields).toContain('inputTokens')
    expect(() => addUsageCounters([{ inputTokens: -1 }])).toThrow(/validated before aggregation/)
  })

  it('classifies complete, partial, estimated, missing, and not-applicable in order', () => {
    expect(classifyUsageCoverage([])).toBe('not-applicable')
    expect(classifyUsageCoverage([attempt({ dispatchState: 'not-sent', coverage: 'not-applicable', reported: {} })])).toBe('not-applicable')
    expect(classifyUsageCoverage([attempt()])).toBe('complete')
    expect(classifyUsageCoverage([
      attempt(),
      attempt({ attemptId: 'two', attemptNumber: 2, coverage: 'missing', reported: {} }),
    ])).toBe('partial')
    expect(classifyUsageCoverage([attempt({ coverage: 'missing', reported: {} })], { inputTokens: 1 })).toBe('estimated')
    expect(classifyUsageCoverage([attempt({ coverage: 'missing', reported: {} })])).toBe('missing')
  })

  it('counts sent or unknown attempts without usage as possibly billed', () => {
    expect(possiblyBilledAttemptsWithoutUsage([
      attempt({ dispatchState: 'not-sent', reported: {} }),
      attempt({ attemptId: 'two', dispatchState: 'sent', reported: {} }),
      attempt({ attemptId: 'three', dispatchState: 'unknown', reported: {} }),
      attempt({ attemptId: 'four', dispatchState: 'sent' }),
    ])).toBe(2)
  })
})
