import type { Task } from './tasks.ts'

export interface Timing { timeoutMs: number; workerTimeoutMs: number; orphanGraceMs: number }
export function taskTiming(task: Pick<Task, 'kind'>, opts: Map<string, string>): Timing {
  const positive = (flag: string, fallback: number) => {
    const value = Number(opts.get(flag) ?? fallback)
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`)
    return value
  }
  const timeoutMs = task.kind === 'volume'
    ? positive('volume-timeout-ms', positive('timeout-ms', 1200000)) : positive('timeout-ms', 180000)
  const workerTimeoutMs = task.kind === 'volume'
    ? positive('volume-worker-timeout-ms', positive('worker-timeout-ms', timeoutMs))
    : positive('worker-timeout-ms', timeoutMs)
  return { timeoutMs, workerTimeoutMs, orphanGraceMs: positive('orphan-grace-ms', 30000) }
}
