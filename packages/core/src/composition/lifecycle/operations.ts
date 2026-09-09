import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import { timeoutValue } from '../../platform/config.ts'
import { RuntimeResources, type CancellationScope } from '../../platform/resources.ts'
import {
  RUNTIME_OPERATION_KINDS, type OperationLease, type OperationOptions,
  type QuiescenceReport, type RuntimeOperationKind,
} from './types.ts'

interface Entry {
  readonly kind: RuntimeOperationKind
  readonly cancellation: CancellationScope
  readonly seal: () => void
  settled: boolean
  sealed: boolean
}

function operationCancelled(): AgentSdkError {
  return new AgentSdkError('Runtime operation was cancelled', 'RUNTIME_OPERATION_ABORTED')
}

/** Atomic admission, quiescence and generation sealing shared by every runtime operation. */
export class RuntimeOperations {
  private state: 'active' | 'closing' | 'closed' = 'active'
  private readonly root: AbortController
  private readonly active = new Set<Entry>()
  private readonly settledListeners = new Set<() => void>()
  private quiescence: Promise<QuiescenceReport> | undefined
  private quiesced = false
  private deadlineAt: number | undefined

  constructor(private readonly resources: RuntimeResources) {
    this.root = resources.platform.controller()
  }

  get status(): 'active' | 'closing' | 'closed' { return this.state }
  get activeCount(): number { return this.active.size }

  assertActive(): void {
    if (this.state !== 'active') throw new AgentSdkError(
      'Runtime is not accepting operations', this.state === 'closed' ? 'RUNTIME_CLOSED' : 'RUNTIME_CLOSING',
    )
  }

  acquire(kind: RuntimeOperationKind, options: OperationOptions = {}): OperationLease {
    this.assertActive()
    if (!RUNTIME_OPERATION_KINDS.includes(kind)) throw new TypeError('Unknown runtime operation kind')
    const signal = options.signal
    const timeoutMs = options.timeoutMs
    if (timeoutMs !== undefined) timeoutValue(timeoutMs)
    if (signal?.aborted) throw operationCancelled()
    this.assertActive()
    const cancellation = this.resources.cancellation(
      [this.root.signal, ...signal === undefined ? [] : [signal]], timeoutMs,
    )
    let seal = (): void => undefined
    const whenSealed = new Promise<void>(resolve => { seal = resolve })
    const entry: Entry = { kind, cancellation, seal, settled: false, sealed: false }
    // Recheck after captured platform calls; even a reentrant host cannot admit work after close.
    try { this.assertActive() } catch (error) { cancellation.dispose(); throw error }
    this.active.add(entry)
    return Object.freeze({
      signal: cancellation.signal, whenSealed,
      publish: (commit: () => void): boolean => {
        if (entry.sealed || entry.settled || this.state === 'closed') return false
        commit()
        return true
      },
      settle: (): void => {
        if (entry.settled) return
        entry.settled = true
        this.active.delete(entry)
        cancellation.dispose()
        for (const notify of [...this.settledListeners]) notify()
      },
    })
  }

  /** Admit before evaluating an executable callback and settle public waits even if its work ignores abort. */
  execute<T>(kind: RuntimeOperationKind, options: OperationOptions, work: (lease: OperationLease) => Promise<T>): Promise<T> {
    const lease = this.acquire(kind, options)
    const task = Promise.resolve().then(() => {
      if (lease.signal.aborted) throw operationCancelled()
      return work(lease)
    }).then(value => {
      if (lease.signal.aborted) throw operationCancelled()
      return value
    })
    const sealed = lease.whenSealed.then((): never => { throw operationCancelled() })
    const result = Promise.race([task, sealed]).finally(() => lease.settle())
    // Observing internal promises does not replace the caller's rejecting result promise.
    void result.catch(() => undefined)
    return result
  }

  /** First call locks admission synchronously. Later calls do not read or replace options. */
  beginClose(options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<QuiescenceReport> {
    if (this.quiescence !== undefined) return this.quiescence
    const timeoutMs = timeoutValue(options.timeoutMs)
    const caller = options.signal
    const deadline = this.resources.platform.monotonicNow() + timeoutMs
    let resolve!: (report: QuiescenceReport) => void
    this.quiescence = new Promise<QuiescenceReport>(done => { resolve = done })
    this.deadlineAt = deadline
    this.state = 'closing'
    const entries = [...this.active]
    let ended = false
    let rootAbortComplete = false
    const releases: (() => void)[] = []
    const finish = (reason: QuiescenceReport['quiescenceEnd']): void => {
      if (ended) return
      ended = true
      this.settledListeners.delete(checkSettled)
      for (const release of releases.splice(0).reverse()) release()
      for (const entry of entries) {
        if (entry.settled) continue
        entry.sealed = true
        entry.cancellation.dispose()
        this.active.delete(entry)
        entry.seal()
      }
      const operations = Object.freeze(RUNTIME_OPERATION_KINDS.map(kind => {
        const rows = entries.filter(entry => entry.kind === kind)
        const settled = rows.filter(entry => entry.settled).length
        return Object.freeze({
          kind, activeAtClose: rows.length, aborted: rows.filter(entry => entry.cancellation.signal.aborted).length,
          settled, unsettled: rows.length - settled,
        })
      }))
      const runs = operations[0]!
      this.quiesced = true
      resolve(Object.freeze({
        quiescenceEnd: reason, deadlineReached: reason === 'timeout', operations,
        activeRunsAtClose: runs.activeAtClose, abortedRuns: runs.aborted, unsettledRuns: runs.unsettled,
      }))
    }
    const checkSettled = (): void => {
      // Settlement callbacks run inside root abort dispatch. Do not remove later
      // leases' root listeners until all of them have received cancellation.
      if (!rootAbortComplete) return
      if (caller?.aborted) finish('caller-abort')
      else if (entries.every(entry => entry.settled)) finish('settled')
    }
    this.settledListeners.add(checkSettled)
    this.root.abort(new Error('Runtime is closing'))
    rootAbortComplete = true
    checkSettled()
    if (!ended && caller !== undefined) {
      const release = this.resources.onAbort(caller, () => finish('caller-abort'))
      if (ended) release(); else releases.push(release)
    }
    if (!ended) {
      const remaining = Math.max(0, deadline - this.resources.platform.monotonicNow())
      if (remaining === 0) finish('timeout')
      else releases.push(this.resources.after(Math.ceil(remaining), () => finish('timeout')))
    }
    return this.quiescence
  }

  /** Shared deadline continues across team/provider cleanup and observation flush/shutdown. */
  remainingCloseMs(): number {
    if (this.deadlineAt === undefined) throw new Error('Runtime close has not started')
    return Math.max(0, this.deadlineAt - this.resources.platform.monotonicNow())
  }

  /** Absolute shared deadline used by every cleanup phase after quiescence. */
  closeDeadlineAt(): number {
    if (this.deadlineAt === undefined) throw new Error('Runtime close has not started')
    return this.deadlineAt
  }

  /** Called only after component cleanup and final observation delivery. */
  finishClose(): void {
    if (this.state === 'closed') return
    if (!this.quiesced) throw new Error('Runtime operations have not quiesced')
    this.state = 'closed'
    this.resources.close()
  }
}
