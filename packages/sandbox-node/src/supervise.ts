/**
 * Watching what a confined execution consumes, and ending it when it stops
 * being reasonable.
 *
 * This is not a quota. A quota is the kernel refusing the allocation; this is
 * a sampler that notices afterwards and tears the execution down. The
 * difference is a spike between two samples, which a host with cgroup v2 or a
 * Job Object would have refused outright — so the enforcement level reported
 * here is `monitor`, and a caller that needs `quota` is told it cannot have it
 * rather than left to assume.
 *
 * It is still the difference between a fork storm that ends in a second and one
 * that takes the host down.
 */

import { spawnSync, type ChildProcess } from 'node:child_process'
import {
  breachedLimit, hasResourceLimits,
  type ResourceBreach, type ResourceEnforcement, type ResourceLimits, type ResourceUsage,
} from '@alvin0/ai-agent-sdk-sandbox'
import { terminateConfined } from './terminate.ts'

/** How an execution is supervised. */
export interface SuperviseOptions extends ResourceLimits {
  /** Sampling period. Shorter bounds the overshoot and costs more. */
  readonly intervalMs?: number
  /** Platform identifier; defaults to the running one. Injectable for tests. */
  readonly platform?: string
}

/** What supervision observed, and whether it intervened. */
export interface SupervisionResult extends ResourceUsage {
  /** Whether the execution was ended by supervision rather than by itself. */
  readonly terminated: boolean
  /** Which limit it exceeded, when it was ended for exceeding one. */
  readonly breach?: ResourceBreach
}

/** A supervision in progress. */
export interface Supervision {
  /** Resolves once the execution ends, by itself or by intervention. */
  readonly done: Promise<SupervisionResult>
  /** Stop watching without ending the execution. */
  stop(): void
}

/**
 * What this host can promise for resource limits.
 *
 * Always `monitor` where an execution can be supervised at all, because no
 * kernel quota is applied here: saying `quota` would claim the allocation is
 * refused, and it is not.
 */
export function resourceEnforcement(limits: ResourceLimits): ResourceEnforcement {
  return hasResourceLimits(limits) ? 'monitor' : 'none'
}

/**
 * Watch a confined execution against its limits.
 * @param child - the process returned by spawning `confine()`'s argv.
 */
export function superviseConfined(
  child: ChildProcess,
  options: SuperviseOptions = {},
): Supervision {
  const startedAt = Date.now()
  const platform = options.platform ?? process.platform
  const interval = options.intervalMs ?? 250
  let peakMemoryBytes = 0
  let peakProcesses = 0
  let cpuMs = 0
  let breach: ResourceBreach | undefined
  let stopped = false
  let timer: NodeJS.Timeout | undefined

  const usage = (): ResourceUsage => Object.freeze({
    peakMemoryBytes, peakProcesses, cpuMs, wallClockMs: Date.now() - startedAt,
  })

  const done = new Promise<SupervisionResult>((resolve) => {
    const finish = async (): Promise<void> => {
      if (stopped) return
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      child.off('exit', onExit)
      if (breach !== undefined) await terminateConfined(child, { platform })
      resolve(Object.freeze({
        ...usage(), terminated: breach !== undefined,
        ...(breach === undefined ? {} : { breach }),
      }))
    }
    function onExit(): void { void finish() }
    child.once('exit', onExit)

    if (!hasResourceLimits(options) || child.pid === undefined) {
      // Nothing to watch for; still resolve when the execution ends.
      return
    }
    timer = setInterval(() => {
      const sample = sampleTree(child.pid ?? 0, platform)
      peakMemoryBytes = Math.max(peakMemoryBytes, sample.memoryBytes)
      peakProcesses = Math.max(peakProcesses, sample.processes)
      cpuMs = Math.max(cpuMs, sample.cpuMs)
      breach = breachedLimit(usage(), options)
      if (breach !== undefined) void finish()
    }, interval)
    timer.unref?.()
  })

  return Object.freeze({
    done,
    stop(): void {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
    },
  })
}

/** One sample of the process tree rooted at `root`. */
interface TreeSample {
  readonly memoryBytes: number
  readonly processes: number
  readonly cpuMs: number
}

/**
 * Read resident memory, process count and CPU time for a process tree.
 *
 * Reads the process table rather than any per-process API, because the tree is
 * what consumes the host and a single pid says nothing about what it spawned.
 */
export function sampleTree(root: number, platform: string = process.platform): TreeSample {
  const empty: TreeSample = { memoryBytes: 0, processes: 0, cpuMs: 0 }
  if (platform === 'win32' || root <= 0) return empty
  let table: string
  try {
    const listing = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss=,time='], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
    })
    if (listing.status !== 0) return empty
    table = listing.stdout ?? ''
  } catch { return empty }

  interface Row { readonly ppid: number; readonly pgid: number; readonly rss: number; readonly cpuMs: number }
  const rows = new Map<number, Row>()
  const children = new Map<number, number[]>()
  for (const line of table.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5) continue
    const pid = Number(parts[0]); const ppid = Number(parts[1]); const pgid = Number(parts[2])
    const rss = Number(parts[3])
    if (Number.isNaN(pid) || Number.isNaN(ppid)) continue
    rows.set(pid, { ppid, pgid, rss: Number.isNaN(rss) ? 0 : rss, cpuMs: parseCpuTime(parts[4] ?? '') })
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }

  const seen = new Set<number>()
  const queue = [root]
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined || seen.has(next)) continue
    seen.add(next)
    for (const child of children.get(next) ?? []) queue.push(child)
  }
  // A process that left the tree but kept the group still belongs to this run.
  for (const [pid, row] of rows) if (row.pgid === root) seen.add(pid)

  let memoryBytes = 0; let cpuMs = 0
  for (const pid of seen) {
    const row = rows.get(pid)
    if (row === undefined) continue
    memoryBytes += row.rss * 1024
    cpuMs += row.cpuMs
  }
  return { memoryBytes, processes: seen.size, cpuMs }
}

/** Parse the `ps` TIME column, which is `[[dd-]hh:]mm:ss[.ff]`. */
export function parseCpuTime(value: string): number {
  const [days, rest] = value.includes('-') ? value.split('-') : [undefined, value]
  const parts = (rest ?? '').split(':').map(Number)
  if (parts.some(Number.isNaN) || parts.length === 0) return 0
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  if (days !== undefined) seconds += Number(days) * 86_400
  return Math.round(seconds * 1000)
}
