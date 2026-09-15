/**
 * Tearing down a confined execution and everything it started.
 *
 * Killing the process a runner spawned is not the same as ending the work.
 * Measured on macOS, a command that forks twice and calls `setsid` kept writing
 * after its sandbox was killed: it had left the process group and been
 * reparented, so nothing connected it to the execution any more. On Linux the
 * PID namespace makes this a non-issue — bubblewrap's `--die-with-parent` takes
 * the whole namespace down — which is exactly why the platforms need different
 * handling rather than the same hopeful `child.kill()`.
 */

import { spawnSync, type ChildProcess } from 'node:child_process'

/** How a confined execution is torn down. */
export interface TerminateOptions {
  /** Time allowed for a graceful exit before the group is killed. */
  readonly graceMs?: number
  /**
   * Also hunt descendants that left the process group. Defaults to on wherever
   * the backend has no PID namespace to do it for us.
   */
  readonly sweep?: boolean
  /** Platform identifier; defaults to the running one. Injectable for tests. */
  readonly platform?: string
}

/** What the teardown actually reached. */
export interface TerminateResult {
  /** Process ids signalled, including the sandbox process itself. */
  readonly signalled: readonly number[]
  /** Whether a descendant was found outside the process group. */
  readonly strays: boolean
}

/**
 * End a confined execution and its descendants.
 * @param child - the process returned by spawning `confine()`'s argv.
 */
export async function terminateConfined(
  child: ChildProcess,
  options: TerminateOptions = {},
): Promise<TerminateResult> {
  const platform = options.platform ?? process.platform
  const pid = child.pid
  if (pid === undefined) return Object.freeze({ signalled: Object.freeze([]), strays: false })

  // Linux confines into a PID namespace, so the namespace's own teardown is
  // both sufficient and cheaper than walking the process table.
  const sweep = options.sweep ?? platform !== 'linux'
  const before = sweep ? descendantsOf(pid, platform) : []

  signalGroup(pid, 'SIGTERM')
  await settle(child, options.graceMs ?? 2_000)
  signalGroup(pid, 'SIGKILL')

  const signalled = new Set<number>([pid])
  let strays = false
  if (sweep) {
    // Sampled before the kill: a process that detaches is no longer reachable
    // from the tree afterwards, so the list has to be taken while it is.
    for (const stray of [...before, ...descendantsOf(pid, platform)]) {
      if (signalled.has(stray)) continue
      signalled.add(stray)
      strays = true
      try { process.kill(stray, 'SIGKILL') } catch { /* already gone */ }
    }
  }
  return Object.freeze({ signalled: Object.freeze([...signalled]), strays })
}

/** Signal the whole process group, falling back to the process alone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); return } catch { /* not a group leader */ }
  try { process.kill(pid, signal) } catch { /* already gone */ }
}

/** Resolve once the process exits, or once the grace period is over. */
function settle(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', done); resolve() }, graceMs)
    function done(): void { clearTimeout(timer); resolve() }
    child.once('exit', done)
  })
}

/**
 * Every process reachable from `root` through parent links, plus everything
 * sharing its process group.
 *
 * A process that forks twice is reparented away from its own tree and changes
 * group when it calls `setsid`, so it appears in neither — closing that needs
 * fork notifications from the kernel, which Node does not expose. This finds
 * the rest.
 */
export function descendantsOf(root: number, platform: string = process.platform): readonly number[] {
  if (platform === 'win32') return Object.freeze([])
  let table: string
  try {
    const listing = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
    })
    if (listing.status !== 0) return Object.freeze([])
    table = listing.stdout ?? ''
  } catch { return Object.freeze([]) }

  const children = new Map<number, number[]>()
  const group = new Set<number>()
  for (const line of table.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    if (pid === undefined || ppid === undefined || Number.isNaN(pid)) continue
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
    if (pgid === root) group.add(pid)
  }

  const found = new Set<number>(group)
  const queue = [root]
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) continue
    for (const child of children.get(next) ?? []) {
      if (found.has(child) || child === root) continue
      found.add(child)
      queue.push(child)
    }
  }
  found.delete(root)
  return Object.freeze([...found])
}
