import { describe, expect, it } from 'vitest'
import {
  createSpanId,
  createTraceId,
  disabledDeliverySummary,
  type ModelCallReport,
} from '@ai-agent-sdk/core'
import { RunLedger } from '../../src/agent/accounting/ledger.ts'

function call(overrides: Partial<ModelCallReport> = {}): ModelCallReport {
  return {
    runId: 'run',
    traceId: createTraceId(),
    modelCallId: 'call-1',
    spanId: createSpanId(),
    provider: 'fixture',
    model: 'model',
    status: 'success',
    startedAt: '2026-09-01T00:00:00.000Z',
    endedAt: '2026-09-01T00:00:01.000Z',
    durationMs: 1_000,
    finishReason: 'stop',
    coverage: 'complete',
    reported: { inputTokens: 2, outputTokens: 3, reasoningTokens: 2, totalTokens: 5 },
    attempts: [],
    possiblyBilledAttemptsWithoutUsage: 0,
    authoritative: true,
    delivery: disabledDeliverySummary(),
    ...overrides,
  }
}

function ledger(overrides: Partial<ConstructorParameters<typeof RunLedger>[0]> = {}) {
  return new RunLedger({ agentId: 'agent', mode: 'basic', maxTurns: 4, defectMode: 'test', ...overrides })
}

const request = { provider: 'fixture', model: 'model', messages: [] } as const

describe('canonical agent run ledger', () => {
  it('aggregates complete usage without double-counting reasoning tokens', async () => {
    const state = ledger()
    await state.recordModelCall(call(), request)
    const report = await state.finalize('success', true)

    expect(report.usage).toMatchObject({
      reported: { inputTokens: 2, outputTokens: 3, reasoningTokens: 2, totalTokens: 5 },
      authoritative: true,
      coverage: { logicalCalls: 1, complete: 1, missing: 0 },
    })
    expect(report.operationCounts['model-call']).toMatchObject({ total: 1, success: 1 })
    expect(report.modelCalls[0]?.delivery).toBe(report.delivery)
    expect(Object.isFrozen(report)).toBe(true)
  })

  it('uses explicit zero only for an authoritative run with no model calls', async () => {
    const report = await ledger().finalize('success', true)
    expect(report.usage).toEqual({
      reported: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      coverage: {
        logicalCalls: 0, attempts: 0, complete: 0, partial: 0, estimated: 0,
        missing: 0, notApplicable: 0, possiblyBilledAttemptsWithoutUsage: 0,
      },
      authoritative: true,
    })
  })

  it('keeps missing usage empty and applies warn budget protection', async () => {
    const state = ledger({ cumulativeTokenBudget: true })
    const decision = await state.recordModelCall(call({
      coverage: 'missing', reported: {}, authoritative: false,
      possiblyBilledAttemptsWithoutUsage: 1,
    }), request)
    expect(decision).toMatchObject({ usageRequired: false, usageUnavailable: true })
    const report = await state.finalize('success', false)
    expect(report.usage.reported).toEqual({})
    expect(report.usage.authoritative).toBe(false)
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'USAGE_MISSING' }))
  })

  it('stores estimates separately and fills only counters absent from reported usage', async () => {
    const state = ledger({
      usagePolicy: {
        onMissing: 'estimate',
        estimator: {
          id: 'fixture-estimator',
          estimate: () => ({ inputTokens: 7, outputTokens: 3, totalTokens: 10 }),
        },
      },
    })
    const decision = await state.recordModelCall(call({
      coverage: 'partial', reported: { outputTokens: 3 }, authoritative: false,
      possiblyBilledAttemptsWithoutUsage: 1,
    }), request)
    expect(decision.report.estimated).toEqual({ inputTokens: 7, totalTokens: 10 })
    expect(decision.report.coverage).toBe('partial')
    const report = await state.finalize('success', true)
    expect(report.usage.reported).toEqual({ outputTokens: 3, totalTokens: 3 })
    expect(report.usage.estimated).toEqual({ inputTokens: 7, totalTokens: 10 })
    expect(report.usage.authoritative).toBe(false)
  })

  it('turns fail policy and estimator failure into USAGE_REQUIRED decisions', async () => {
    for (const usagePolicy of [
      { onMissing: 'fail' as const },
      { onMissing: 'estimate' as const, estimator: { id: 'broken', estimate: () => { throw new Error('broken') } } },
    ]) {
      const state = ledger({ usagePolicy })
      const decision = await state.recordModelCall(call({
        coverage: 'missing', reported: {}, authoritative: false,
        possiblyBilledAttemptsWithoutUsage: 1,
      }), request)
      expect(decision.usageRequired).toBe(true)
      const report = await state.finalize('error', false)
      expect(report.errors).toContainEqual(expect.objectContaining({ code: 'USAGE_REQUIRED' }))
    }
  })

  it('rejects duplicate/orphan terminals in test mode and closes leaks as unknown in production', async () => {
    const strict = ledger()
    const id = strict.startOperation('tool', { operationId: 'tool-1' })
    expect(() => strict.startOperation('tool', { operationId: id })).toThrow(/duplicate/)
    strict.endOperation(id, 'success')
    expect(() => strict.endOperation(id, 'success')).toThrow(/duplicate/)
    expect(() => strict.endOperation('absent', 'success')).toThrow(/orphan/)

    const production = new RunLedger({ agentId: 'agent', mode: 'basic', maxTurns: 1 })
    production.startOperation('hook', { operationId: 'open-hook' })
    const report = await production.finalize('success', true)
    expect(report.status).toBe('unknown')
    expect(report.operationCounts.hook).toMatchObject({ total: 1, unknown: 1 })
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'OPERATION_TERMINAL_MISSING' }))
  })

  it('fails closed when ledger model, attempt, tool, or byte limits are exceeded', async () => {
    const modelBound = ledger({ limits: { maxModelCalls: 1 } })
    await modelBound.recordModelCall(call(), request)
    await expect(modelBound.recordModelCall(call({ modelCallId: 'call-2' }), request))
      .rejects.toMatchObject({ code: 'LEDGER_LIMIT_EXCEEDED' })

    const attemptBound = ledger({ limits: { maxAttemptsPerCall: 1 } })
    await expect(attemptBound.recordModelCall(call({
      attempts: [
        { attemptId: 'one', spanId: createSpanId(), attemptNumber: 1, status: 'success', startedAt: '', endedAt: '', durationMs: 0, dispatchState: 'sent', coverage: 'complete', reported: {} },
        { attemptId: 'two', spanId: createSpanId(), attemptNumber: 2, status: 'success', startedAt: '', endedAt: '', durationMs: 0, dispatchState: 'sent', coverage: 'complete', reported: {} },
      ],
    }), request)).rejects.toMatchObject({ code: 'LEDGER_LIMIT_EXCEEDED' })

    const toolBound = ledger({ limits: { maxToolCalls: 1 } })
    toolBound.startOperation('tool')
    expect(() => toolBound.startOperation('tool')).toThrow(expect.objectContaining({ code: 'LEDGER_LIMIT_EXCEEDED' }))

    const byteBound = ledger({ limits: { maxSerializedBytes: 32 } })
    expect(() => byteBound.startOperation('memory', { data: { operation: 'x'.repeat(64) } }))
      .toThrow(expect.objectContaining({ code: 'LEDGER_LIMIT_EXCEEDED' }))
  })
})
