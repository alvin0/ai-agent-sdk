import { validateAttempts } from '../evaluation/integrity.ts'
import { median, quantile } from '../evaluation/bundle-statistics.ts'

export interface PtcAttempt {
  task: string; category: string; arm: string; repeat: number; status: string; totalTokens: number; elapsedMs: number; effects: number
}
export function validatePtcAttempts(tasks: readonly { id: string; category: string }[], repeats: number, rows: readonly PtcAttempt[]): void {
  validateAttempts({ repeats, selected: tasks.map(task => ({ id: task.id, split: 'development', unsupported: null })) },
    rows.map(row => ({ id: row.task, split: 'development', arm: row.arm, repeat: row.repeat, status: row.status })), true)
  for (const row of rows) {
    if (row.category !== tasks.find(task => task.id === row.task)?.category
      || !Number.isFinite(row.totalTokens) || row.totalTokens < 0 || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0
      || !Number.isSafeInteger(row.effects) || row.effects < 0) throw new Error('Invalid PTC category or measurements')
  }
}

export function ptcPairedQuality(rows: readonly PtcAttempt[]) {
  const pairs = new Map<string, PtcAttempt[]>()
  for (const row of rows) { const key = `${row.task}:${row.repeat}`; pairs.set(key, [...pairs.get(key) ?? [], row]) }
  const losses = [...pairs.entries()].filter(([, pair]) => pair.some(row => row.arm === 'BASE' && row.status === 'passed') && pair.some(row => row.arm === 'PTC' && row.status !== 'passed')).map(([key]) => key)
  const bothPassed = [...pairs.values()].filter(pair => pair.length === 2 && pair.every(row => row.status === 'passed')
    && pair.some(row => row.arm === 'BASE') && pair.some(row => row.arm === 'PTC')).flat()
  return { losses, bothPassed, zeroEffects: rows.every(row => row.effects === 0) }
}

/** Failed BASE timeouts must not make a successful PTC attempt an efficiency win. */
export function ptcPairedEfficiency(rows: readonly PtcAttempt[]) {
  const paired = ptcPairedQuality(rows).bothPassed
  const base = paired.filter(row => row.arm === 'BASE'), ptc = paired.filter(row => row.arm === 'PTC')
  const baseTokens = median(base.map(row => row.totalTokens)), ptcTokens = median(ptc.map(row => row.totalTokens))
  const baseP95 = quantile(base.map(row => row.elapsedMs), .95), ptcP95 = quantile(ptc.map(row => row.elapsedMs), .95)
  return { pairs: paired.length / 2,
    medianTokenReduction: baseTokens === null || ptcTokens === null || baseTokens === 0 ? null : 1 - ptcTokens / baseTokens,
    p95LatencyIncrease: baseP95 === null || ptcP95 === null || baseP95 === 0 ? null : ptcP95 / baseP95 - 1 }
}
