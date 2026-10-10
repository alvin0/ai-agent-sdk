/** Starts managed workers and retains their terminal evidence before reporting it. */
import type { AgentResponse } from '../define/session.ts'
import type { AgentRunEvent } from '../mode/run-agent.ts'
import type { AgentTeam } from './team.ts'
import type { ManagedAgentTeamOptions, WorkerRuntime } from './managed-types.ts'
import { managedDependencyReport } from './managed-reports.ts'
import {
  abortable, combineSignals,
} from './managed-cancellation.ts'
import {
  errorMessage, failureOf, recordEvidence,
} from './managed-outcomes.ts'
import { waitForSettlement } from '../../async/index.ts'

interface ManagedWorkerHost {
  readonly options: ManagedAgentTeamOptions
  readonly team: AgentTeam
  readonly signal: AbortSignal
  readonly workerRuntimes: ReadonlyMap<string, WorkerRuntime>
  readonly leadName: string
  readonly workerTimeoutMs: number
  readonly observerTimeoutMs: number
  readonly spawnTimeoutMs: number
  readonly maxDependencyReportBytes: number
  notifyLead(runtime: WorkerRuntime, summary: string): Promise<void>
  releaseDependents(runtime: WorkerRuntime): Promise<void>
}

export class ManagedWorkerExecution {
  constructor(private readonly host: ManagedWorkerHost) {}

  /**
   * Put a worker on the model, at last.
   *
   * Separate from `spawn` because a worker with dependencies is created now and
   * started later; the two used to be the same moment.
   */
  private beginWorker(runtime: WorkerRuntime): void {
    const name = runtime.request.name
    if (runtime.status !== 'pending' || runtime.closing || this.host.signal.aborted
      || this.host.workerRuntimes.get(name) !== runtime) return
    runtime.start?.()
    runtime.start = undefined
    this.host.team.markPending(name, undefined)
    // Closed while it was held: there is nothing left to start, and starting it
    // anyway would resurrect a worker the lead had already let go.
    runtime.status = 'running'

    // Started, NOT awaited. `runPending` begins the run eagerly and
    // synchronously, so by the time this returns the worker is genuinely
    // going; the promise is simply left for `followWorker` to watch.
    // Awaiting it in `spawn` is what blinded the lead: parked inside its own
    // tool call it could not read the worker's messages, could not spawn
    // anything else, and could not be told that the worker had gone quiet.
    //
    // `runPending` rather than `streamPending`, and that is load-bearing:
    // `onEvent` is delivered by the consumer `runPending` wraps around the
    // handle, so a bare `streamPending` starts the run and reports NOTHING.
    // Every worker event is lost with it — including the approval requests a
    // worker parks on, which leaves it waiting for an answer nobody was ever
    // shown, and the run hangs.
    const deadline = AbortSignal.timeout(this.host.workerTimeoutMs)
    runtime.deadline = deadline
    const running = runtime.session.runPending({
      signal: combineSignals(runtime.controller.signal, deadline),
      ...(this.host.options.onWorkerEvent === undefined
        ? {}
        : { onEvent: (event: AgentRunEvent) => this.observeWorkerEvent(name, event) }),
    })
    void this.followWorker(runtime, running)
  }

  /** One handoff path for both already-settled and asynchronously released dependencies. */
  private cannotStartWorker(runtime: WorkerRuntime): boolean {
    return runtime.starting || runtime.status !== 'pending' || runtime.closing || this.host.signal.aborted
  }

  async startWorker(runtime: WorkerRuntime, setupSignal?: AbortSignal): Promise<void> {
    if (this.cannotStartWorker(runtime)) return
    runtime.starting = true
    try {
      const report = managedDependencyReport(runtime.dependencies, this.host.maxDependencyReportBytes)
      if (report !== undefined) {
        const signal = combineSignals(setupSignal, runtime.controller.signal, this.host.signal,
          AbortSignal.timeout(this.host.spawnTimeoutMs))
        await abortable(this.host.team.sendMessage({ from: this.host.leadName, target: runtime.request.name,
          message: report, delivery: 'quiet', signal }), signal)
        signal.throwIfAborted()
      }
      this.beginWorker(runtime)
    } catch (error: unknown) {
      // Missing required context is a visible failure, never a successful task
      // dispatched with the dependencies silently omitted.
      if (!runtime.closing && !this.host.signal.aborted) {
        runtime.status = 'failed'
        runtime.error = `dependency handoff failed: ${errorMessage(error)}`
        recordEvidence(runtime)
        runtime.start?.()
        runtime.start = undefined
        try {
          this.host.team.markPending(runtime.request.name, undefined)
          this.host.team.recordOutcome(runtime.request.name, { kind: 'failed', message: runtime.error })
        } catch { /* shared team already disposed */ }
        await this.host.notifyLead(runtime, `failed: ${runtime.error}`)
        runtime.markSettled()
        await this.host.releaseDependents(runtime)
      }
    } finally {
      // Retain producer facts only while queued/preparing. Completed ancestors
      // must not keep entire sessions alive through an arbitrarily long chain.
      runtime.dependencies = []
    }
  }

  /**
   * Say what actually happened to a worker, in words the lead can act on.
   *
   * A raw abort reads "The operation was aborted due to timeout", which tells
   * the lead nothing about WHOSE timeout or whether re-delegating would help.
   * Codex reports a status the parent can branch on; the DeepSeek harness
   * records a blocker code with an explanation. This is the same idea at the
   * size this harness needs.
   * @param error - Whatever ended the run.
   * @returns The explanation to record and report.
   */
  private describeWorkerFailure(error: unknown, runtime: WorkerRuntime | undefined): string {
    if (runtime?.deadline?.aborted === true) return this.deadlineFailure()
    const name = (error as { name?: unknown } | null)?.name
    if (name === 'TimeoutError') return this.deadlineFailure()
    if (name === 'AbortError') return 'its work was cancelled before it finished'
    return errorMessage(error)
  }

  /** The one explanation an expired worker deadline deserves. */
  private deadlineFailure(): string {
    return `it ran past its ${String(this.host.workerTimeoutMs)}ms deadline without finishing.`
      + ' Narrow the task, or split it, before delegating it again'
  }

  private recordWorkerResponse(runtime: WorkerRuntime, response: AgentResponse, name: string): string {
    // A run that RESOLVES has not necessarily succeeded: a model call that
    // failed ends the turn with an error reason and an empty answer. Read
    // as a success it became "Worker 'x' finished:" with nothing after the
    // colon — the lead told a sector was done by a worker that never got
    // an answer out of the model, which is worse than being told nothing.
    const failure = runtime.deadline?.aborted === true
      ? this.deadlineFailure()
      : failureOf(response, this.host.options.requireWorkerText === true)
    if (failure !== undefined) {
      runtime.status = 'failed'
      runtime.error = failure
      // A failed final request must not erase evidence already returned.
      // Preserve partial output, but never report it as successful work.
      if (response.text.trim() !== '') {
        runtime.result = Object.freeze({
          worker: name,
          agentId: runtime.session.definition.id,
          conversationId: runtime.session.conversationId,
          text: response.text,
          succeeded: false,
        })
      }
      recordEvidence(runtime)
      this.host.team.recordOutcome(name, { kind: 'failed', message: failure })
      return `failed: ${failure}`
        + (runtime.result === undefined ? '' : `\nPartial findings (not a completed task): ${runtime.result.text}`)
    } else {
      runtime.status = 'completed'
      runtime.result = Object.freeze({
        worker: name,
        agentId: runtime.session.definition.id,
        conversationId: runtime.session.conversationId,
        text: response.text,
        succeeded: response.outcome.completed,
      })
      recordEvidence(runtime)
      this.host.team.recordOutcome(name, { kind: 'completed', text: response.text })
      return `finished: ${response.text}`
    }
  }

  /**
   * Watch a detached worker run to its end and report it.
   *
   * Never rejects: the run has no awaiting caller, so a throw here would be an
   * unhandled rejection. Failures are recorded on the runtime and told to the
   * lead instead, which is the same shape `AgentTeam.runWakeLoop` uses for the
   * other kind of un-awaited member run.
   */
  private async followWorker(
    runtime: WorkerRuntime,
    running: Promise<AgentResponse>,
  ): Promise<void> {
    const name = runtime.request.name
    try {
      const response = await running
      if (runtime.status !== 'closed' && !runtime.closing) {
        await this.host.notifyLead(runtime, this.recordWorkerResponse(runtime, response, name))
      }
    } catch (error: unknown) {
      // A close is not a failure. Reporting the abort it caused would tell the
      // lead its own decision went wrong, and — once a report can wake an idle
      // lead — would start a turn about a worker it deliberately abandoned.
      if (runtime.status !== 'closed' && !runtime.closing) {
        runtime.status = 'failed'
        runtime.error = this.describeWorkerFailure(error, runtime)
        recordEvidence(runtime)
        try { this.host.team.recordOutcome(name, { kind: 'failed',
          message: runtime.error }) } catch { /* shared team disposed */ }
        await this.host.notifyLead(runtime, `failed: ${runtime.error}`)
      }
    } finally {
      runtime.markSettled()
      // Whatever ended this worker — success, failure, or a close — the work
      // planned after it is no longer waiting on anything.
      await this.host.releaseDependents(runtime)
    }
  }

  private async observeWorkerEvent(worker: string, event: AgentRunEvent): Promise<void> {
    const observer = Promise.resolve().then(() => this.host.options.onWorkerEvent?.(worker, event))
    await waitForSettlement(observer, this.host.observerTimeoutMs)
  }

}
