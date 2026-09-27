import { describe, expect, it } from 'vitest'
import { validatePtcAttempts, ptcPairedQuality, ptcPairedEfficiency, type PtcAttempt } from '../../test-human/spikes/ptc-integrity.ts'

const row = (task: string, arm: string, status = 'passed', tokens = 100): PtcAttempt => ({ task, category: 'FILTER', arm, status, repeat: 0, totalTokens: tokens, elapsedMs: 10, effects: 0 })

describe('PTC value evaluation integrity', () => {
  it('rejects duplicate substitutions and partial cohorts even with a matching summary count', () => {
    const tasks = [{ id: 'FILTER-1', category: 'FILTER' }]
    const rows = [row('FILTER-1', 'BASE'), row('FILTER-1', 'PTC')]
    expect(() => validatePtcAttempts(tasks, 1, rows)).not.toThrow()
    expect(() => validatePtcAttempts(tasks, 1, [rows[0]!, rows[0]!])).toThrow('Duplicate')
    expect(() => validatePtcAttempts(tasks, 1, [rows[0]!])).toThrow('Incomplete')
    expect(() => validatePtcAttempts(tasks, 1, [rows[0]!, { ...rows[1]!, category: 'JOIN' }])).toThrow('category')
  })
  it('does not let another task win hide a new paired loss', () => {
    const rows = [row('FILTER-1', 'BASE'), row('FILTER-1', 'PTC', 'failed'), row('FILTER-2', 'BASE', 'failed'), row('FILTER-2', 'PTC')]
    expect(rows.filter(item => item.arm === 'BASE' && item.status === 'passed')).toHaveLength(1)
    expect(rows.filter(item => item.arm === 'PTC' && item.status === 'passed')).toHaveLength(1)
    expect(ptcPairedQuality(rows).losses).toEqual(['FILTER-1:0'])
  })
  it('excludes cheap failures from comparable efficiency and detects effects in target tasks', () => {
    const rows = [row('FILTER-1', 'BASE'), row('FILTER-1', 'PTC', 'failed', 1), row('FILTER-2', 'BASE'), row('FILTER-2', 'PTC', 'passed', 80)]
    expect(ptcPairedQuality(rows).bothPassed.map(item => item.task)).toEqual(['FILTER-2', 'FILTER-2'])
    expect(ptcPairedQuality([...rows, { ...row('FILTER-3', 'PTC'), effects: 1 }]).zeroEffects).toBe(false)
  })
  it('does not let slow failed BASE attempts hide a latency regression on successful pairs', () => {
    const successful = ['FILTER-1', 'FILTER-2'].flatMap(task => [
      { ...row(task, 'BASE'), elapsedMs: 10 }, { ...row(task, 'PTC', 'passed', 80), elapsedMs: 12 },
    ])
    const failed = Array.from({ length: 6 }, (_, index) => [
      { ...row(`JOIN-${index}`, 'BASE', 'failed'), elapsedMs: 1000 }, { ...row(`JOIN-${index}`, 'PTC'), elapsedMs: 1 },
    ]).flat()
    const efficiency = ptcPairedEfficiency([...successful, ...failed])
    expect(efficiency.pairs).toBe(2)
    expect(efficiency.medianTokenReduction).toBeCloseTo(.2)
    expect(efficiency.p95LatencyIncrease).toBeCloseTo(.2)
    expect(efficiency.p95LatencyIncrease).toBeGreaterThan(.15)
    expect(ptcPairedQuality([row('FILTER-1', 'BASE'), row('FILTER-1', 'BASE')]).bothPassed).toEqual([])
  })
})
