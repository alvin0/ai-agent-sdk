import { describe, expect, it, vi } from 'vitest'
import { createRunTerminalRecord, withTerminalDelivery } from '../../../packages/core/src/composition/delivery/terminal.ts'
import { disabledDeliverySummary } from '../../../packages/core/src/observation/index.ts'
import { DELIVERY_LIMITS } from '../../../packages/core/src/composition/delivery/config.ts'
import { ledgerReport } from './delivery-fixtures.ts'

describe('immutable terminal projection from the canonical run ledger', () => {
  it.each(['complete', 'missing', 'estimated', 'retry', 'retry-exhausted', 'failed', 'overflow', 'aggregate-overflow'] as const)('preserves %s accounting without summing a second time', async mode => {
    const report = await ledgerReport(`run-${mode}`, mode)
    const record = createRunTerminalRecord(report)
    expect(record.usage).toEqual(report.usage)
    expect(record.modelCalls.map(call => call.reported)).toEqual(report.modelCalls.map(call => call.reported))
    expect(record.modelCalls.map(call => call.attempts.map(attempt => attempt.reported)))
      .toEqual(report.modelCalls.map(call => call.attempts.map(attempt => attempt.reported)))
    expect(record.modelCalls[0]).toMatchObject({ provider: 'account-a', model: 'specialist' })
    expect(record).not.toHaveProperty('delivery')
    expect(record.usage).not.toBe(report.usage)
    expect(Object.isFrozen(record.usage.reported)).toBe(true)
    expect(Object.isFrozen(record.modelCalls[0]!.attempts)).toBe(true)
    if (mode === 'complete') expect(record.usage.reported).toEqual({ inputTokens: 2, outputTokens: 3, cacheReadTokens: 5,
      cacheWriteTokens: 7, reasoningTokens: 2, totalTokens: 17 })
    if (mode === 'missing') expect(record.usage.authoritative).toBe(false)
    if (mode === 'overflow' || mode === 'aggregate-overflow') {
      expect(record.usage.authoritative).toBe(false)
      expect(record.modelCalls[0]!.authoritative).toBe(false)
      expect(record.modelCalls[0]!.error?.code).toBe('USAGE_COUNTER_OVERFLOW')
      expect(record.errors).toContainEqual(expect.objectContaining({ code: 'USAGE_COUNTER_OVERFLOW' }))
    }
    if (mode === 'aggregate-overflow') {
      expect(record.modelCalls[0]!.attempts.every(attempt => attempt.coverage === 'complete')).toBe(true)
      expect(record.modelCalls[0]!.attempts).toHaveLength(2)
    }
    if (mode === 'estimated') {
      expect(record.usage.authoritative).toBe(false)
      expect(record.usage.estimated).toEqual(report.usage.estimated)
      expect(record.usage.reported).not.toHaveProperty('inputTokens')
    }
    if (mode === 'retry' || mode === 'retry-exhausted') expect(record.modelCalls[0]!.attempts).toHaveLength(2)
    if (mode === 'retry-exhausted') {
      expect(record.status).toBe('error')
      expect(record.usage.coverage).toMatchObject({ missing: 1, possiblyBilledAttemptsWithoutUsage: 2 })
      expect(record.modelCalls[0]!.attempts.every(attempt => attempt.coverage === 'missing')).toBe(true)
    }
    if (mode === 'failed' || mode === 'retry-exhausted') {
      expect(record.errors).toContainEqual(expect.objectContaining({
        code: 'TRANSIENT', stage: 'provider-attempt', provider: 'account-a', route: 'account-a',
        origin: 'https://fixture.invalid', status: 503, requestId: expect.stringMatching(/^fixture-request-/),
        dispatchState: 'sent', usageCoverage: record.usage.coverage,
      }))
    }
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('PRIVATE_PROVIDER/BODY~SENTINEL%')
    expect(serialized).not.toContain('PRIVATE_PROMPT/BODY~SENTINEL%')
  })

  it('constructs a separate caller report only after its delivery result is known', async () => {
    const report = await ledgerReport()
    const record = createRunTerminalRecord(report, [{ sourceId: 'tools', revision: 'v1' }])
    const saved = JSON.stringify(record)
    const caller = withTerminalDelivery(record, { ...disabledDeliverySummary(), complete: false, pendingCritical: 1 })
    expect(caller.delivery.complete).toBe(false)
    expect(caller.usage).toBe(record.usage)
    expect(caller.toolSourceSnapshots).toEqual([{ sourceId: 'tools', revision: 'v1' }])
    expect(Object.isFrozen(caller)).toBe(true)
    expect(JSON.stringify(record)).toBe(saved)
    expect(record).not.toHaveProperty('delivery')
    expect(() => withTerminalDelivery({ ...record }, disabledDeliverySummary())).toThrow()
  })

  it('ignores unknown fields and raw error details without reading their getters', async () => {
    const report = await ledgerReport('error-run', 'failed')
    const clone = structuredClone(report)
    const get = vi.fn(() => { throw new Error('PRIVATE_GETTER/BODY~SENTINEL%') })
    for (const object of [clone, clone.usage, clone.modelCalls[0]!, ...clone.errors]) {
      Object.defineProperty(object, 'prompt', { enumerable: true, get })
    }
    for (const error of clone.errors) Object.defineProperty(error, 'message', { get })
    const record = createRunTerminalRecord(clone)
    expect(get).not.toHaveBeenCalled()
    expect(record.errors.every(error => error.message === 'Agent operation failed'
      || error.message === 'Provider operation failed')).toBe(true)
    expect(JSON.stringify(record)).not.toContain('PRIVATE_GETTER/BODY~SENTINEL%')
  })

  it('rejects duplicate model-call/attempt/source identities and malformed canonical fields', async () => {
    const report = await ledgerReport()
    const call = report.modelCalls[0]!
    for (const input of [
      { ...report, modelCalls: [call, call] },
      { ...report, modelCalls: [{ ...call, attempts: [call.attempts[0]!, call.attempts[0]!] }] },
      { ...report, modelCalls: [{ ...call, runId: 'another-run' }] },
      { ...report, usage: { ...report.usage, reported: { inputTokens: Number.NaN } } },
      { ...report, durationMs: -1 },
    ]) expect(() => createRunTerminalRecord(input)).toThrow(expect.objectContaining({ code: 'OBSERVATION_DELIVERY_DATA_INVALID' }))
    expect(() => createRunTerminalRecord(report, [{ sourceId: 'a', revision: '1' }, { sourceId: 'a', revision: '2' }])).toThrow()
    const get = vi.fn()
    const input = { ...report }
    Object.defineProperty(input, 'usage', { get })
    expect(() => createRunTerminalRecord(input)).toThrow()
    expect(get).not.toHaveBeenCalled()
  })

  it('enforces the record byte budget while copying attempts, before inspecting an oversized tail', async () => {
    const report = await ledgerReport(), call = report.modelCalls[0]!, get = vi.fn()
    const attempts = Array.from({ length: DELIVERY_LIMITS.attemptsPerCall }, (_, index) => ({
      ...call.attempts[0]!, attemptId: `attempt-${index}`, attemptNumber: index + 1, providerRequestId: 'r'.repeat(256),
    }))
    Object.defineProperty(attempts.at(-1)!, 'attemptId', { get })
    expect(() => createRunTerminalRecord({ ...report, modelCalls: [{ ...call, attempts }] })).toThrow(
      expect.objectContaining({ code: 'OBSERVATION_DELIVERY_DATA_INVALID' }),
    )
    expect(get).not.toHaveBeenCalled()
  })
})
