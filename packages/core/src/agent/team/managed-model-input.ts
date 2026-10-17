/** Serializes model follow-ups and binds reports to their own run responses. */
import { progressActivity } from './team-progress-internal.ts'
import { recordTeamTimeline } from './team-observation-internal.ts'
import { asJson, failureOf, recordEvidence } from './managed-outcomes.ts'
import type { AgentMemberOutcome } from './types.ts'
import type { AgentResponse } from '../define/session.ts'
import type { AgentTeam } from './team.ts'
import type { WorkerRuntime } from './managed-types.ts'
import { abortable, combineSignals } from './managed-cancellation.ts'
import { optionalDeadline } from './common.ts'
import { messageContent } from './common.ts'

interface InputHost {
  readonly team: AgentTeam
  readonly signal: AbortSignal
  readonly timeoutMs: number | undefined
  readonly maxPendingInputs: number
  worker(name: string): WorkerRuntime | undefined
  run(runtime: WorkerRuntime, signal: AbortSignal): Promise<AgentResponse>
  report(runtime: WorkerRuntime, summary: string, outcome: AgentMemberOutcome): Promise<void>
  admit(runtime: WorkerRuntime): void
  releaseDependents(runtime: WorkerRuntime): Promise<void>
}

interface InputTask {
  readonly runtime: WorkerRuntime
  readonly from: string
  readonly message: string
  readonly replacingHeld: boolean
  readonly controller: AbortController
  readonly signal: AbortSignal
}

export class ManagedModelInput {
  private readonly jobs = new Map<string, { controller: AbortController; settled: Promise<void> }>()
  private pendingInputs = 0

  constructor(private readonly host: InputHost) {}

  outstanding(): readonly { name: string; settled: Promise<void> }[] {
    return [...this.jobs].map(([name, job]) => ({ name, settled: job.settled }))
  }

  cancel(target: string): void { this.jobs.get(target)?.controller.abort() }

  async whenIdle(target: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const job = this.jobs.get(target)
      if (job !== undefined) await abortable(job.settled, signal)
      await this.host.team.whenIdle(target, signal)
      if (this.jobs.get(target) === undefined) return
    }
  }

  /** Accepted work belongs to the team lifecycle, rather than the accepting tool call. */
  enqueue(from: string, target: string, message: string, interrupt: boolean): void {
    this.host.signal.throwIfAborted()
    if (this.pendingInputs >= this.host.maxPendingInputs) {
      recordTeamTimeline(this.host.team, { kind: 'budget', member: from, budget: 'pending-inputs',
        action: 'exhausted', used: this.pendingInputs, limit: this.host.maxPendingInputs })
      throw new Error('Wait for a worker result before sending more tasks.')
    }
    const runtime = this.host.worker(target)
    if (runtime === undefined || runtime.closing) throw new Error(`unknown worker '${target}'`)
    this.host.admit(runtime)
    messageContent(message, this.host.team.messageByteLimit)
    const previous = this.jobs.get(target)
    const replacingHeld = this.replacesHeld(runtime, interrupt)
    if (interrupt) {
      previous?.controller.abort()
      this.redirect(runtime, replacingHeld)
    }
    const controller = !interrupt && previous !== undefined ? previous.controller : new AbortController()
    const signal = combineSignals(controller.signal, this.host.signal, optionalDeadline(this.host.timeoutMs))
    const task = { runtime, from, message, replacingHeld, controller, signal }
    this.pendingInputs++
    const settled = Promise.resolve().then(async () => {
      if (previous !== undefined) await abortable(previous.settled, signal)
      if (!replacingHeld) await abortable(runtime.settled, signal)
      if (interrupt) await abortable(this.host.team.cancel(target), signal)
      await this.host.team.whenIdle(target, signal)
      signal.throwIfAborted()
      await this.dispatch(task)
    }).catch((error: unknown) => this.fail(task, error)).finally(async () => {
      await this.finishReplacement(task)
      this.pendingInputs--
      if (this.jobs.get(target)?.settled === settled) this.jobs.delete(target)
      await this.host.releaseDependents(runtime)
      progressActivity(this.host.team, { kind: 'settlement', member: target })
    })
    this.jobs.set(target, { controller, settled })
  }

  private async finishReplacement(task: InputTask): Promise<void> {
    const { runtime, replacingHeld, controller } = task
    if (replacingHeld && (!controller.signal.aborted || runtime.closing || this.host.signal.aborted)) {
      runtime.inputOwnsSettlement = false
      if (runtime.closing || this.host.signal.aborted || runtime.status === 'pending') {
        runtime.status = runtime.closing || this.host.signal.aborted ? 'closed' : 'failed'
        recordEvidence(runtime)
      }
      runtime.markSettled()
      await this.host.releaseDependents(runtime)
    }
  }

  private replacesHeld(runtime: WorkerRuntime, interrupt: boolean): boolean {
    return interrupt && (runtime.inputOwnsSettlement === true || runtime.status === 'pending')
  }

  private redirect(runtime: WorkerRuntime, replacingHeld: boolean): void {
    runtime.controller.abort(new Error('work redirected'))
    if (!replacingHeld) return
    // Detach the old task from its producers, retaining this producer's
    // pending identity for its dependents until the replacement settles.
    runtime.inputOwnsSettlement = true
    runtime.starting = true
    runtime.dependencies = []
    runtime.start?.()
    runtime.start = undefined
    this.host.team.markPending(runtime.request.name, undefined)
  }

  private async dispatch(task: InputTask): Promise<void> {
    const { runtime, from, message, signal } = task
    const target = runtime.request.name
    // Inject and start eagerly in the same stack. A concurrent host wake waits
    // for this session run; reporting uses the response owned by this dispatch.
    runtime.status = 'running'
    runtime.result = undefined
    runtime.error = undefined
    const delivery = this.host.team.sendMessage({ from, target, message, delivery: 'quiet', signal })
    const running = this.host.run(runtime, signal)
    const [, response] = await abortable(Promise.all([delivery, running]), signal)
    signal.throwIfAborted()
    const failure = failureOf(response, false)
    const structured = response.outcome.completion === undefined
      ? {} : { structured: asJson(response.outcome.completion) }
    const outcome: AgentMemberOutcome = failure === undefined
      ? { kind: 'completed', text: response.text, ...structured }
      : { kind: 'failed', message: failure, ...structured, ...response.text === '' ? {} : { text: response.text } }
    runtime.status = failure === undefined ? 'completed' : 'failed'
    runtime.error = failure
    runtime.result = { worker: target, agentId: runtime.session.definition.id,
      conversationId: runtime.session.conversationId, text: response.text,
      succeeded: failure === undefined, ...structured }
    recordEvidence(runtime)
    this.host.team.recordOutcome(target, outcome, response.report)
    await this.host.report(runtime, response.text || failure || '', outcome)
  }

  private async fail(task: InputTask, error: unknown): Promise<void> {
    if (task.controller.signal.aborted || this.host.signal.aborted) return
    const { runtime } = task
    const failure = error instanceof Error ? error.message : String(error)
    try {
      this.host.team.recordOutcome(runtime.request.name, { kind: 'failed', message: failure })
    } catch { /* a host may already have detached this address */ }
    runtime.status = 'failed'
    runtime.error = failure
    runtime.result = undefined
    recordEvidence(runtime)
    await this.host.report(runtime, failure, { kind: 'failed', message: failure })
  }

}
