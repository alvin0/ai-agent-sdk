import { spawn, type ChildProcess } from 'node:child_process'
import {
  forceTerminateWindowsProcessTree,
  type AgentCodeCommandProcessCleanupInvocation,
  type AgentCodeProcessCleanupResult,
} from '../process-cleanup.ts'
import { CLEANUP_CANCEL_TIMEOUT_MS, POST_EXIT_CLEANUP_TIMEOUT_MS, type PostExitCleanupInput, type ProcessResult, type SuccessfulExitProcessCleanup, type ProcessOutputStream, type OutputSegment } from './types.ts'
export async function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  maxOutputChars: number,
  successfulExitCleanup?: SuccessfulExitProcessCleanup,
  environment?: Readonly<Record<string, string>>,
): Promise<ProcessResult> {
  if (signal.aborted) throw abortReason(signal)
  const startedAtMs = Date.now()
  let cleanupInvocation: AgentCodeCommandProcessCleanupInvocation | undefined
  let cleanupSetupWarning: string | undefined
  const beginInvocation = successfulExitCleanup?.cleanup.beginInvocation
  if (beginInvocation !== undefined && successfulExitCleanup !== undefined) {
    try {
      cleanupInvocation = await beginInvocation.call(successfulExitCleanup.cleanup, {
        workspaceRoot: successfulExitCleanup.workspaceRoot,
        startedAtMs,
        trackDetachedDescendants: successfulExitCleanup.trackDetachedDescendants,
        signal,
      })
    } catch (error: unknown) {
      cleanupSetupWarning = `cleanup setup failed: ${processCleanupErrorMessage(error)}`
    }
  }
  if (signal.aborted) {
    await cancelCleanupInvocation(cleanupInvocation)
    throw abortReason(signal)
  }

  let child: ChildProcess
  try {
    child = spawn(executable, args, {
      cwd, shell: false, windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(environment === undefined ? {} : { env: environment }),
    })
  } catch (error: unknown) {
    await cancelCleanupInvocation(cleanupInvocation)
    throw error
  }
  if (cleanupInvocation !== undefined) {
    if (child.pid === undefined) {
      cleanupSetupWarning = 'cleanup setup failed: spawned process has no PID'
      void cancelCleanupInvocation(cleanupInvocation)
      cleanupInvocation = undefined
    } else {
      try {
        cleanupInvocation.attachRoot(child.pid)
      } catch (error: unknown) {
        cleanupSetupWarning = `cleanup setup failed: ${processCleanupErrorMessage(error)}`
        void cancelCleanupInvocation(cleanupInvocation)
        cleanupInvocation = undefined
      }
    }
  }

  return new Promise((fulfill, reject) => {
    const output = new BoundedProcessOutput(maxOutputChars)
    let timedOut = false
    let termination: Promise<string | undefined> | undefined
    let settled = false
    child.stdout?.on('data', (chunk: Buffer) => { output.append('stdout', chunk.toString('utf8')) })
    child.stderr?.on('data', (chunk: Buffer) => { output.append('stderr', chunk.toString('utf8')) })
    const stop = (): Promise<string | undefined> => {
      if (child.exitCode !== null) return Promise.resolve(undefined)
      termination ??= terminateProcessTree(child)
      return termination
    }
    const abort = (): void => { void stop() }
    signal.addEventListener('abort', abort, { once: true })
    // Abort may have raced with spawn and listener registration.
    if (signal.aborted) void stop()
    const timer = setTimeout(() => {
      if (child.exitCode !== null) return
      timedOut = true
      void stop()
    }, timeoutMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    child.once('error', error => {
      if (settled) return
      settled = true
      cleanup()
      void cancelCleanupInvocation(cleanupInvocation)
      reject(error)
    })
    child.once('close', code => {
      if (settled) return
      // The command is already closed. Its timeout and abort listener must not
      // remain armed while potentially slow post-exit discovery is running.
      const abortedAtClose = signal.aborted
      cleanup()
      void (async () => {
        let processCleanup: AgentCodeProcessCleanupResult | undefined
        let terminationWarning: string | undefined
        if (termination !== undefined) {
          try {
            terminationWarning = await termination
          } catch (error: unknown) {
            terminationWarning = `forced process termination failed: ${processCleanupErrorMessage(error)}`
          }
          if (cleanupInvocation !== undefined
            && successfulExitCleanup !== undefined
            && child.pid !== undefined) {
            processCleanup = await runPostExitCleanup({
              cleanup: successfulExitCleanup.cleanup,
              invocation: cleanupInvocation,
              rootPid: child.pid,
              workspaceRoot: successfulExitCleanup.workspaceRoot,
              startedAtMs,
              ...(cleanupSetupWarning === undefined ? {} : { setupWarning: cleanupSetupWarning }),
            })
          } else {
            await cancelCleanupInvocation(cleanupInvocation)
          }
        }
        if (termination === undefined && child.pid !== undefined && successfulExitCleanup !== undefined) {
          processCleanup = await runPostExitCleanup({
            cleanup: successfulExitCleanup.cleanup,
            rootPid: child.pid,
            workspaceRoot: successfulExitCleanup.workspaceRoot,
            startedAtMs,
            ...(cleanupInvocation === undefined ? {} : { invocation: cleanupInvocation }),
            ...(cleanupSetupWarning === undefined ? {} : { setupWarning: cleanupSetupWarning }),
          })
        }
        if (settled) return
        settled = true
        if (abortedAtClose) { reject(abortReason(signal)); return }
        fulfill({
          exitCode: code, timedOut, ...output.result(),
          ...(processCleanup === undefined ? {} : { processCleanup }),
          ...(terminationWarning === undefined ? {} : { terminationWarning }),
        })
      })().catch(error => {
        if (settled) return
        settled = true
        reject(error)
      })
    })
  })
}

async function runPostExitCleanup(input: PostExitCleanupInput): Promise<AgentCodeProcessCleanupResult> {
  try {
    const result = await withDeadline(
      input.invocation === undefined
        ? cleanupSignal => input.cleanup.beginInvocation === undefined
          ? input.cleanup.cleanupAfterExit({
            rootPid: input.rootPid,
            workspaceRoot: input.workspaceRoot,
            startedAtMs: input.startedAtMs,
          }, cleanupSignal)
          : Promise.resolve(emptyProcessCleanup('cleanup tracking unavailable'))
        : cleanupSignal => input.invocation?.cleanupAfterExit(cleanupSignal)
          ?? Promise.resolve(emptyProcessCleanup('cleanup tracking unavailable')),
      POST_EXIT_CLEANUP_TIMEOUT_MS,
      'post-exit process cleanup',
    )
    return input.setupWarning === undefined ? result : appendProcessCleanupWarning(result, input.setupWarning)
  } catch (error: unknown) {
    return emptyProcessCleanup(processCleanupErrorMessage(error))
  }
}

async function cancelCleanupInvocation(
  invocation: AgentCodeCommandProcessCleanupInvocation | undefined,
): Promise<void> {
  if (invocation === undefined) return
  try {
    await withDeadline(
      cleanupSignal => invocation.cancel(cleanupSignal),
      CLEANUP_CANCEL_TIMEOUT_MS,
      'process cleanup cancellation',
    )
  } catch {
    // Cancellation is best-effort and must not replace the command outcome.
  }
}

function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise((fulfill, reject) => {
    const controller = new AbortController()
    let settled = false
    const finish = (error: unknown, value?: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) fulfill(value as T)
      else reject(error)
    }
    const timer = setTimeout(() => {
      const error = new Error(`${label} exceeded ${timeoutMs}ms`)
      controller.abort(error)
      finish(error)
    }, timeoutMs)
    Promise.resolve().then(() => operation(controller.signal)).then(
      value => { finish(undefined, value) },
      error => { finish(error) },
    )
  })
}

function emptyProcessCleanup(warning: string): AgentCodeProcessCleanupResult {
  return {
    attempted: true,
    matchedProcesses: 0,
    terminatedProcessTrees: 0,
    warning: warning.slice(0, 2_000),
  }
}

function appendProcessCleanupWarning(
  result: AgentCodeProcessCleanupResult,
  warning: string,
): AgentCodeProcessCleanupResult {
  return {
    ...result,
    warning: [result.warning, warning].filter((item): item is string => item !== undefined)
      .join('; ').slice(0, 2_000),
  }
}

/** One shared process-output budget retaining the beginning and most recent tail. */
class BoundedProcessOutput {
  private readonly headLimit: number
  private readonly tailLimit: number
  private readonly head: OutputSegment[] = []
  private readonly tail: OutputSegment[] = []
  private headChars = 0
  private tailChars = 0
  private stdoutChars = 0
  private stderrChars = 0

  constructor(maxChars: number) {
    this.headLimit = Math.ceil(maxChars * 0.6)
    this.tailLimit = maxChars - this.headLimit
  }

  append(stream: ProcessOutputStream, text: string): void {
    if (text.length === 0) return
    if (stream === 'stdout') this.stdoutChars += text.length
    else this.stderrChars += text.length
    const headRemaining = this.headLimit - this.headChars
    if (headRemaining > 0) {
      const prefix = text.slice(0, headRemaining)
      this.head.push({ stream, text: prefix })
      this.headChars += prefix.length
      text = text.slice(prefix.length)
    }
    if (text.length === 0 || this.tailLimit === 0) return
    this.tail.push({ stream, text })
    this.tailChars += text.length
    this.trimTail()
  }

  result(): Omit<ProcessResult, 'exitCode' | 'timedOut'> {
    const retained = [...this.head, ...this.tail]
    const stdout = retained.filter(segment => segment.stream === 'stdout')
      .map(segment => segment.text).join('')
    const stderr = retained.filter(segment => segment.stream === 'stderr')
      .map(segment => segment.text).join('')
    const stdoutOmittedChars = Math.max(0, this.stdoutChars - stdout.length)
    const stderrOmittedChars = Math.max(0, this.stderrChars - stderr.length)
    const omittedOutputChars = stdoutOmittedChars + stderrOmittedChars
    return {
      stdout, stderr,
      outputTruncated: omittedOutputChars > 0,
      omittedOutputChars, stdoutOmittedChars, stderrOmittedChars,
    }
  }

  private trimTail(): void {
    let excess = this.tailChars - this.tailLimit
    while (excess > 0) {
      const first = this.tail[0]
      if (first === undefined) break
      if (first.text.length <= excess) {
        excess -= first.text.length
        this.tailChars -= first.text.length
        this.tail.shift()
      } else {
        first.text = first.text.slice(excess)
        this.tailChars -= excess
        excess = 0
      }
    }
  }
}

async function terminateProcessTree(child: ChildProcess): Promise<string | undefined> {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    return forceTerminateWindowsProcessTree(pid, () => {
      if (child.exitCode === null) child.kill('SIGKILL')
    })
  }

  const warnings: string[] = []
  try { signalProcessGroup(pid, 'SIGTERM') }
  catch (error: unknown) { warnings.push(`SIGTERM failed: ${processCleanupErrorMessage(error)}`) }
  await delay(250)
  // Always address the group again: the leader may exit while descendants remain.
  try { signalProcessGroup(pid, 'SIGKILL') }
  catch (error: unknown) { warnings.push(`SIGKILL group failed: ${processCleanupErrorMessage(error)}`) }
  try {
    if (child.exitCode === null) child.kill('SIGKILL')
  } catch (error: unknown) {
    warnings.push(`SIGKILL root fallback failed: ${processCleanupErrorMessage(error)}`)
  }
  return warnings.length === 0 ? undefined : warnings.join('; ').slice(0, 2_000)
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal) }
  catch (error: unknown) {
    if (!isMissingProcess(error)) throw error
  }
}

function isMissingProcess(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ESRCH'
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('the process was aborted')
}

function processCleanupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}
