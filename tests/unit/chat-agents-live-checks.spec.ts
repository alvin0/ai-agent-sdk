import { describe, expect, it } from 'vitest'
import type { StoredNode } from '../../samples/chat-agents/backend/src/event-projection.ts'
import { assessLiveMatrixRun } from '../helpers/live-matrix-checks.ts'

const message = (text: string, member?: string, phase = 'final-answer'): StoredNode => ({
  kind: 'text', id: `${member ?? 'lead'}-${phase}`, text, phase, streaming: false,
  ...(member === undefined ? {} : { member }),
})
const plan = (status: 'done' | 'active'): StoredNode => ({
  kind: 'tool', id: 'todos', name: 'write_todos', args: '{}', state: 'ok',
  card: { kind: 'todo', items: [{ text: 'Compare sources', status }] },
})
const evidence = 'Observed prices normalize to USD 120/kWh and USD 150/kWh. October 2026 remains an unverified forecast, not an observed price.'
const worker = 'Read the source, verified its arithmetic, and identified an unverified future forecast.'

describe('live matrix acceptance criteria', () => {
  it('accepts equivalent dates and a reconciled plan', () => {
    const checks = assessLiveMatrixRun('research', [plan('done'), message(worker, 'a'), message(worker, 'b'), message(evidence)], [])
    expect(Object.values(checks).every(Boolean)).toBe(true)
  })
  it('rejects worker commentary without final reports even when the lead has an answer', () => {
    const checks = assessLiveMatrixRun('research', [plan('done'), message(worker, 'a', 'commentary'), message(worker, 'b', 'commentary'), message(evidence)], [])
    expect(checks.workerReports).toBe(false)
    expect(checks.leadLast).toBe(true)
  })
  it('rejects a plan that is published but never reconciled', () => {
    expect(assessLiveMatrixRun('research', [plan('active'), message(evidence)], []).planReconciled).toBe(false)
  })
  it('rejects repeated conclusions even when their wording differs', () => {
    const nodes = Array.from({ length: 4 }, (_, index) => message(`${evidence} Revision ${index}.`))
    expect(assessLiveMatrixRun('research', nodes, []).noConclusionLoop).toBe(false)
  })
  it('rejects a larger total containing the expected digits', () => {
    const checks = assessLiveMatrixRun('analysis', [message('Revenue is 1340 USD; duplicate b excluded and missing c reported. This is the verified final reconciliation.')], [])
    expect(checks.evidence).toBe(false)
  })
  it('rejects the right total with the wrong duplicate and missing record IDs', () => {
    const checks = assessLiveMatrixRun('analysis', [message('The total is 340 USD. Duplicate a was removed. Missing d was excluded. The source data was reconciled.')], [])
    expect(checks.evidence).toBe(false)
  })
})
