import { describe, expect, it } from 'vitest'
import type { ObservationDeliverySummary } from '../../../packages/core/src/observation/index.ts'
import { createRunTerminalRecord } from '../../../packages/core/src/composition/delivery/terminal.ts'
import { finalizeRuntimeRunReport } from '../../../packages/core/src/composition/observation/final-report.ts'
import type { TerminalCheckpointResult } from '../../../packages/core/src/composition/observation/port.ts'
import { ledgerReport } from './delivery-fixtures.ts'

function summary(mode: 'operational' | 'reliable' | 'audit', boundary: 'none' | 'local-durable' = mode === 'operational' ? 'none' : 'local-durable'):
ObservationDeliverySummary {
  return { mode, requiredBoundary: boundary, reachedBoundary: boundary, complete: true,
    acceptedCritical: 5, rejectedCritical: 0, pendingCritical: 0 }
}

function terminal(runId: string, input: Partial<TerminalCheckpointResult> = {}): TerminalCheckpointResult {
  return { runId, status: 'accepted', durable: true, boundary: 'local-durable', ...input }
}

describe('post-checkpoint target run report projection', () => {
  it('adds delivery only to a new report and preserves canonical record object identities', async () => {
    const record = createRunTerminalRecord(await ledgerReport('final-run')), previous = summary('reliable')
    const report = finalizeRuntimeRunReport(record, previous, terminal(record.runId), 'reliable', 'local-durable')
    expect(report).not.toBe(record)
    expect(record).not.toHaveProperty('delivery')
    expect(report).toMatchObject({ kind: 'run-terminal-record', runId: record.runId,
      delivery: { mode: 'reliable', complete: true, acceptedCritical: 6, rejectedCritical: 0, pendingCritical: 0 } })
    expect(report.usage).toBe(record.usage)
    expect(report.modelCalls).toBe(record.modelCalls)
    expect(report.toolSourceSnapshots).toBe(record.toolSourceSnapshots)
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.delivery)).toBe(true)
  })

  it('keeps operational delivery non-durable and retains a prior safe failure', async () => {
    const record = createRunTerminalRecord(await ledgerReport('operational-final'))
    const previous = { ...summary('operational'), lastFailure: { type: 'Error', message: 'safe', code: 'OPERATION_FAILED' } }
    const report = finalizeRuntimeRunReport(record, previous,
      terminal(record.runId, { durable: false, boundary: 'none' }), 'operational', 'none')
    expect(report.delivery).toMatchObject({ complete: true, requiredBoundary: 'none', reachedBoundary: 'none',
      acceptedCritical: 6, lastFailure: { code: 'OPERATION_FAILED' } })
  })

  it.each(['capacity', 'exporter-unavailable', 'closed'] as const)('reports failed terminal %s without exposing a cause', async reason => {
    const record = createRunTerminalRecord(await ledgerReport(`failed-${reason}`))
    const result = terminal(record.runId, { status: reason === 'closed' ? 'closed' : 'rejected', durable: false, boundary: 'none', reason,
      delivery: { status: reason === 'closed' ? 'closed' : 'incomplete', requiredComplete: false, complete: false,
        reachedBoundary: 'none', targetItems: 1, pendingRequired: 1, pendingItems: 1, batches: [] } })
    const report = finalizeRuntimeRunReport(record, summary('reliable'), result, 'reliable', 'local-durable')
    expect(report.delivery).toMatchObject({ complete: false, reachedBoundary: 'none', acceptedCritical: 5,
      rejectedCritical: 1, pendingCritical: 1,
      lastFailure: { code: reason === 'capacity' ? 'OBSERVABILITY_CAPTURE_REJECTED' : 'OBSERVABILITY_EXPORT_FAILED' } })
    expect(report.delivery.lastFailure).toEqual({
      type: 'Error', message: 'Agent operation failed',
      code: reason === 'capacity' ? 'OBSERVABILITY_CAPTURE_REJECTED' : 'OBSERVABILITY_EXPORT_FAILED',
    })
    expect(report.delivery.lastFailure).not.toHaveProperty('cause')
  })

  it('uses the weakest boundary shared by the prior event checkpoint and terminal record', async () => {
    const record = createRunTerminalRecord(await ledgerReport('boundary-final'))
    const previous = { ...summary('reliable', 'local-durable'), reachedBoundary: 'remote-acknowledged' as const }
    const report = finalizeRuntimeRunReport(record, previous,
      terminal(record.runId, { boundary: 'local-durable' }), 'reliable', 'local-durable')
    expect(report.delivery.reachedBoundary).toBe('local-durable')
  })

  it('rejects mismatched run, mode, boundary grammar and malformed prior data', async () => {
    const record = createRunTerminalRecord(await ledgerReport('invalid-final'))
    for (const invoke of [
      () => finalizeRuntimeRunReport(record, summary('reliable'), terminal('other'), 'reliable', 'local-durable'),
      () => finalizeRuntimeRunReport(record, summary('operational'), terminal(record.runId), 'reliable', 'local-durable'),
      () => finalizeRuntimeRunReport(record, summary('reliable'), terminal(record.runId), 'reliable', 'none'),
      () => finalizeRuntimeRunReport(record, summary('reliable'), terminal(record.runId, { boundary: 'local-durable' }), 'reliable', 'remote-acknowledged'),
      () => finalizeRuntimeRunReport(record, { ...summary('reliable'), requiredBoundary: 'remote-acknowledged' }, terminal(record.runId), 'reliable', 'local-durable'),
      () => finalizeRuntimeRunReport(record, summary('reliable'), terminal(record.runId, { durable: false }), 'reliable', 'local-durable'),
      () => finalizeRuntimeRunReport(record, { ...summary('reliable'), acceptedCritical: -1 }, terminal(record.runId), 'reliable', 'local-durable'),
    ]) expect(invoke).toThrow(expect.objectContaining({ code: 'OBSERVATION_DELIVERY_DATA_INVALID' }))
    expect(record).not.toHaveProperty('delivery')
  })

  it('saturates final counters instead of wrapping', async () => {
    const record = createRunTerminalRecord(await ledgerReport('counter-final'))
    const report = finalizeRuntimeRunReport(record, { ...summary('reliable'), acceptedCritical: Number.MAX_SAFE_INTEGER },
      terminal(record.runId), 'reliable', 'local-durable')
    expect(report.delivery.acceptedCritical).toBe(Number.MAX_SAFE_INTEGER)
  })
})
