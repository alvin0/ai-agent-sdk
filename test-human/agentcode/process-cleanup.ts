/** Windows-only cleanup for processes intentionally started by one npm invocation. */

import { spawn } from 'node:child_process'

const MAX_SNAPSHOT_CHARS = 8 * 1024 * 1024
const SNAPSHOT_TIMEOUT_MS = 10_000
const DEFAULT_TRACKING_INTERVAL_MS = 500
const MAX_TERMINATION_ROOTS = 16

export interface WindowsProcessRecord {
  readonly pid: number
  readonly parentPid: number
  readonly createdAtMs: number
  readonly commandLine: string
}

export interface AgentCodeProcessCleanupInput {
  readonly rootPid: number
  readonly workspaceRoot: string
  readonly startedAtMs: number
  /** Process identities present before the command was spawned. */
  readonly baselineProcesses?: readonly WindowsProcessIdentity[]
  /** Descendants proven by a live ancestry snapshot while the command ran. */
  readonly observedDescendants?: readonly WindowsProcessIdentity[]
}

export interface WindowsProcessIdentity {
  readonly pid: number
  readonly createdAtMs: number
}

export interface AgentCodeProcessCleanupPreparationInput {
  readonly workspaceRoot: string
  readonly startedAtMs: number
  /** Only long-lived dev/e2e-like invocations need live CIM polling. */
  readonly trackDetachedDescendants?: boolean
  readonly signal?: AbortSignal
}

export type AgentCodeProcessCleanupResult = Readonly<{
  readonly attempted: boolean
  readonly matchedProcesses: number
  readonly terminatedProcessTrees: number
  readonly warning?: string
}>

export interface AgentCodeCommandProcessCleanup {
  /** Snapshot before spawn, then monitor ancestry after attachRoot. */
  beginInvocation?(
    input: AgentCodeProcessCleanupPreparationInput,
  ): Promise<AgentCodeCommandProcessCleanupInvocation>
  cleanupAfterExit(
    input: AgentCodeProcessCleanupInput,
    signal?: AbortSignal,
  ): Promise<AgentCodeProcessCleanupResult>
}

export interface AgentCodeCommandProcessCleanupInvocation {
  attachRoot(rootPid: number): void
  cleanupAfterExit(signal?: AbortSignal): Promise<AgentCodeProcessCleanupResult>
  /** Stop observation without killing; the command tree was handled elsewhere. */
  cancel(signal?: AbortSignal): Promise<void>
}

export interface WindowsProcessCleanupDependencies {
  readonly snapshot?: (signal?: AbortSignal) => Promise<readonly WindowsProcessRecord[]>
  readonly terminateTree?: (pid: number, signal?: AbortSignal) => Promise<void>
  readonly currentPid?: number
  readonly trackingIntervalMs?: number
}

export interface AttributedWindowsProcesses {
  readonly matchedPids: readonly number[]
  readonly rootPids: readonly number[]
}

/**
 * Select only live processes attributable to this invocation.
 *
 * A process must have been created after the invocation started and must either
 * have a live parent chain leading to the npm PID, or match a PID + creation-time
 * identity whose ancestry was observed while the npm invocation was alive.
 * Workspace command-line text is intentionally not attribution: another user
 * process can legitimately start in the same directory at the same time.
 */
export function selectAttributedWindowsProcesses(
  processes: readonly WindowsProcessRecord[],
  input: AgentCodeProcessCleanupInput,
  currentPid = process.pid,
): AttributedWindowsProcesses {
  const baseline = identitySet(input.baselineProcesses)
  const eligible = processes.filter(candidate =>
    candidate.pid > 0
    && candidate.pid !== currentPid
    && candidate.pid !== input.rootPid
    && candidate.createdAtMs >= input.startedAtMs
    && !baseline.has(identityKey(candidate)))
  const byParent = new Map<number, WindowsProcessRecord[]>()
  for (const candidate of eligible) {
    const siblings = byParent.get(candidate.parentPid)
    if (siblings === undefined) byParent.set(candidate.parentPid, [candidate])
    else siblings.push(candidate)
  }

  const matched = new Set<number>()
  const observed = identitySet(input.observedDescendants)
  const pending = [input.rootPid]
  for (const candidate of eligible) {
    if (!observed.has(identityKey(candidate))) continue
    matched.add(candidate.pid)
    pending.push(candidate.pid)
  }
  while (pending.length > 0) {
    const parentPid = pending.pop()
    if (parentPid === undefined) break
    for (const child of byParent.get(parentPid) ?? []) {
      if (matched.has(child.pid)) continue
      matched.add(child.pid)
      pending.push(child.pid)
    }
  }

  const matchedPids = [...matched].sort((left, right) => left - right)
  const parentByPid = new Map(eligible.map(candidate => [candidate.pid, candidate.parentPid]))
  const rootPids = matchedPids.filter(pid => {
    const parentPid = parentByPid.get(pid)
    return parentPid === undefined || !matched.has(parentPid)
  })
  return { matchedPids, rootPids }
}

export function createWindowsCommandProcessCleanup(
  dependencies: WindowsProcessCleanupDependencies = {},
): AgentCodeCommandProcessCleanup {
  const snapshot = dependencies.snapshot ?? snapshotWindowsProcesses
  const terminateTree = dependencies.terminateTree ?? terminateWindowsProcessTree
  const currentPid = dependencies.currentPid ?? process.pid
  const trackingIntervalMs = boundedTrackingInterval(
    dependencies.trackingIntervalMs ?? DEFAULT_TRACKING_INTERVAL_MS,
  )
  return {
    async beginInvocation(input) {
      if (input.trackDetachedDescendants === false) return inactiveInvocation()
      try {
        const baseline = await snapshot(input.signal)
        throwIfAborted(input.signal)
        return trackedInvocation({
          input,
          baseline: identitiesOf(baseline),
          snapshot,
          terminateTree,
          currentPid,
          trackingIntervalMs,
        })
      } catch (error: unknown) {
        // A failed baseline means attribution cannot be proven. Fail closed and
        // preserve the command result with a cleanup diagnostic.
        return unavailableInvocation(`baseline snapshot failed: ${messageOf(error)}`)
      }
    },
    async cleanupAfterExit(input, signal) {
      throwIfAborted(signal)
      const processes = await snapshot(signal)
      throwIfAborted(signal)
      const attributed = selectAttributedWindowsProcesses(processes, input, currentPid)
      const warnings: string[] = []
      const terminated = await terminateAttributedRoots({
        processes, rootPids: attributed.rootPids, snapshot, terminateTree, warnings, signal,
      })
      return {
        attempted: true,
        matchedProcesses: attributed.matchedPids.length,
        terminatedProcessTrees: terminated,
        ...(warnings.length === 0 ? {} : { warning: warnings.join('; ').slice(0, 2_000) }),
      }
    },
  }
}

interface TrackedInvocationOptions {
  readonly input: AgentCodeProcessCleanupPreparationInput
  readonly baseline: readonly WindowsProcessIdentity[]
  readonly snapshot: (signal?: AbortSignal) => Promise<readonly WindowsProcessRecord[]>
  readonly terminateTree: (pid: number, signal?: AbortSignal) => Promise<void>
  readonly currentPid: number
  readonly trackingIntervalMs: number
}

function trackedInvocation(options: TrackedInvocationOptions): AgentCodeCommandProcessCleanupInvocation {
  let rootPid: number | undefined
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let inFlight = Promise.resolve()
  const trackingAbort = new AbortController()
  const observed = new Map<string, WindowsProcessIdentity>()
  const warnings: string[] = []

  const sample = async (): Promise<void> => {
    // A sample already queued by attachRoot must still complete when close races
    // with it; `stopped` only prevents future scheduling.
    if (rootPid === undefined) return
    try {
      const processes = await options.snapshot(trackingAbort.signal)
      const selected = selectAttributedWindowsProcesses(processes, {
        rootPid,
        workspaceRoot: options.input.workspaceRoot,
        startedAtMs: options.input.startedAtMs,
        baselineProcesses: options.baseline,
        observedDescendants: [...observed.values()],
      }, options.currentPid)
      const selectedPids = new Set(selected.matchedPids)
      for (const process of processes) {
        if (!selectedPids.has(process.pid)) continue
        observed.set(identityKey(process), identityOf(process))
      }
    } catch (error: unknown) {
      appendWarning(warnings, `tracking snapshot failed: ${messageOf(error)}`)
    }
  }
  const schedule = (): void => {
    if (stopped || rootPid === undefined) return
    timer = setTimeout(() => {
      inFlight = inFlight.then(sample).finally(schedule)
    }, options.trackingIntervalMs)
    timer.unref()
  }
  const stopObservation = async (signal?: AbortSignal, abortSampling = false): Promise<void> => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    const abort = (): void => { trackingAbort.abort(signal?.reason) }
    if (abortSampling || signal?.aborted === true) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    try {
      await inFlight
      throwIfAborted(signal)
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  return {
    attachRoot(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1) throw new RangeError('cleanup root PID must be positive')
      if (rootPid !== undefined) throw new Error('cleanup invocation root PID is already attached')
      rootPid = pid
      inFlight = inFlight.then(sample).finally(schedule)
    },
    async cleanupAfterExit(signal) {
      await stopObservation(signal)
      if (rootPid === undefined) {
        return cleanupResult(0, 0, [...warnings, 'cleanup root PID was never attached'])
      }
      let processes: readonly WindowsProcessRecord[]
      try {
        processes = await options.snapshot(signal)
        throwIfAborted(signal)
      } catch (error: unknown) {
        return cleanupResult(0, 0, [
          ...warnings,
          `final snapshot failed: ${messageOf(error)}`,
        ])
      }
      const attributed = selectAttributedWindowsProcesses(processes, {
        rootPid,
        workspaceRoot: options.input.workspaceRoot,
        startedAtMs: options.input.startedAtMs,
        baselineProcesses: options.baseline,
        observedDescendants: [...observed.values()],
      }, options.currentPid)
      const terminated = await terminateAttributedRoots({
        processes,
        rootPids: attributed.rootPids,
        snapshot: options.snapshot,
        terminateTree: options.terminateTree,
        warnings,
        signal,
      })
      return cleanupResult(
        attributed.matchedPids.length,
        terminated,
        warnings,
      )
    },
    cancel: signal => stopObservation(signal, true),
  }
}

function unavailableInvocation(warning: string): AgentCodeCommandProcessCleanupInvocation {
  return {
    attachRoot() {},
    cleanupAfterExit: () => Promise.resolve(cleanupResult(0, 0, [warning])),
    cancel: () => Promise.resolve(),
  }
}

function inactiveInvocation(): AgentCodeCommandProcessCleanupInvocation {
  return {
    attachRoot() {},
    cleanupAfterExit: () => Promise.resolve({
      attempted: false, matchedProcesses: 0, terminatedProcessTrees: 0,
    }),
    cancel: () => Promise.resolve(),
  }
}

function cleanupResult(
  matchedProcesses: number,
  terminatedProcessTrees: number,
  warnings: readonly string[],
): AgentCodeProcessCleanupResult {
  const warning = warnings.length === 0 ? undefined : warnings.join('; ').slice(0, 2_000)
  return {
    attempted: true,
    matchedProcesses,
    terminatedProcessTrees,
    ...(warning === undefined ? {} : { warning }),
  }
}

interface TerminateAttributedRootsInput {
  readonly processes: readonly WindowsProcessRecord[]
  readonly rootPids: readonly number[]
  readonly snapshot: (signal?: AbortSignal) => Promise<readonly WindowsProcessRecord[]>
  readonly terminateTree: (pid: number, signal?: AbortSignal) => Promise<void>
  readonly warnings: string[]
  readonly signal: AbortSignal | undefined
}

async function terminateAttributedRoots(input: TerminateAttributedRootsInput): Promise<number> {
  const expectedByPid = new Map(input.processes.map(item => [item.pid, identityOf(item)]))
  let terminated = 0
  const rootPids = input.rootPids.slice(0, MAX_TERMINATION_ROOTS)
  if (rootPids.length < input.rootPids.length) {
    appendWarning(input.warnings, `termination roots capped at ${MAX_TERMINATION_ROOTS}`)
  }
  for (const pid of rootPids) {
    throwIfAborted(input.signal)
    const expected = expectedByPid.get(pid)
    if (expected === undefined) continue
    let current: readonly WindowsProcessRecord[]
    try {
      current = await input.snapshot(input.signal)
      throwIfAborted(input.signal)
    } catch (error: unknown) {
      appendWarning(input.warnings, `could not revalidate PID ${pid}: ${messageOf(error)}`)
      continue
    }
    const stillSameProcess = current.some(candidate => identityKey(candidate) === identityKey(expected))
    if (!stillSameProcess) {
      appendWarning(input.warnings, `skipped PID ${pid}: process identity changed before termination`)
      continue
    }
    try {
      await input.terminateTree(pid, input.signal)
      throwIfAborted(input.signal)
      terminated++
    } catch (error: unknown) {
      appendWarning(input.warnings, `failed to terminate PID ${pid}: ${messageOf(error)}`)
    }
  }
  return terminated
}

export async function terminateWindowsProcessTree(pid: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolveTermination, rejectTermination) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    })
    let done = false
    const finish = (error?: Error): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error === undefined) resolveTermination()
      else rejectTermination(error)
    }
    const timer = setTimeout(() => {
      killer.kill('SIGKILL')
      finish(new Error(`taskkill timed out for PID ${pid}`))
    }, 5_000)
    const abort = (): void => {
      killer.kill('SIGKILL')
      finish(abortError(signal))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted === true) abort()
    killer.once('error', error => { finish(error) })
    killer.once('close', code => {
      finish(code === 0 ? undefined : new Error(`taskkill failed for PID ${pid} with exit code ${String(code)}`))
    })
  })
}

/**
 * Forced command timeout/abort must still address the root when taskkill fails.
 * Post-exit cleanup intentionally calls terminateWindowsProcessTree directly so
 * the same failure remains visible in its successful-termination count.
 */
export async function forceTerminateWindowsProcessTree(
  pid: number,
  killRoot: () => void,
  terminateTree: (pid: number) => Promise<void> = terminateWindowsProcessTree,
): Promise<string | undefined> {
  const warnings: string[] = []
  try {
    await terminateTree(pid)
  } catch (error: unknown) {
    appendWarning(warnings, `taskkill failed for PID ${pid}: ${messageOf(error)}`)
  }
  try {
    killRoot()
  } catch (error: unknown) {
    appendWarning(warnings, `root fallback failed for PID ${pid}: ${messageOf(error)}`)
  }
  return warnings.length === 0 ? undefined : warnings.join('; ').slice(0, 2_000)
}

function identityOf(process: WindowsProcessRecord): WindowsProcessIdentity {
  return Object.freeze({ pid: process.pid, createdAtMs: process.createdAtMs })
}

function identitiesOf(processes: readonly WindowsProcessRecord[]): readonly WindowsProcessIdentity[] {
  return Object.freeze(processes.map(identityOf))
}

function identitySet(
  identities: readonly WindowsProcessIdentity[] | undefined,
): ReadonlySet<string> {
  return new Set((identities ?? []).map(identityKey))
}

function identityKey(identity: WindowsProcessIdentity): string {
  return `${identity.pid}:${identity.createdAtMs}`
}

function appendWarning(warnings: string[], warning: string): void {
  if (warnings.length >= 20) return
  warnings.push(warning.slice(0, 500))
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

function boundedTrackingInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TRACKING_INTERVAL_MS
  return Math.max(10, Math.min(60_000, Math.floor(value)))
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal)
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(signal?.reason === undefined ? 'process cleanup aborted' : String(signal.reason))
}

async function snapshotWindowsProcesses(signal?: AbortSignal): Promise<readonly WindowsProcessRecord[]> {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$epoch = [DateTime]::SpecifyKind([DateTime]'1970-01-01', [DateTimeKind]::Utc)
$items = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {
  $createdAtMs = [long]0
  if ($null -ne $_.CreationDate) {
    $createdAtMs = [long](($_.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds)
  }
  [PSCustomObject]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    createdAtMs = $createdAtMs
    commandLine = [string]$_.CommandLine
  }
})
ConvertTo-Json -Compress -InputObject $items
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const stdout = await runSnapshotProcess(encoded, signal)
  return parseProcessSnapshot(stdout)
}

function runSnapshotProcess(encodedScript: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  return new Promise((fulfill, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript,
    ], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error === undefined) fulfill(stdout)
      else reject(error)
    }
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      if (stream === 'stdout') stdout += text
      else stderr += text
      if (stdout.length + stderr.length > MAX_SNAPSHOT_CHARS) {
        child.kill('SIGKILL')
        finish(new Error('Windows process snapshot exceeded its output budget'))
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => { append('stdout', chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { append('stderr', chunk) })
    child.once('error', error => { finish(error) })
    child.once('close', code => {
      if (code === 0) finish()
      else finish(new Error(`Windows process snapshot failed (${String(code)}): ${stderr.trim()}`))
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error('Windows process snapshot timed out'))
    }, SNAPSHOT_TIMEOUT_MS)
    const abort = (): void => {
      child.kill('SIGKILL')
      finish(abortError(signal))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted === true) abort()
  })
}

function parseProcessSnapshot(text: string): readonly WindowsProcessRecord[] {
  const raw: unknown = JSON.parse(text.trim() || '[]')
  const records = Array.isArray(raw) ? raw : [raw]
  return records.flatMap(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const candidate = value as Record<string, unknown>
    if (!Number.isInteger(candidate.pid) || !Number.isInteger(candidate.parentPid)
      || typeof candidate.createdAtMs !== 'number' || !Number.isFinite(candidate.createdAtMs)
      || typeof candidate.commandLine !== 'string') return []
    return [{
      pid: candidate.pid as number,
      parentPid: candidate.parentPid as number,
      createdAtMs: candidate.createdAtMs,
      commandLine: candidate.commandLine,
    }]
  })
}
