import type { LocalMemberRuntime, RemoteMemberRuntime, AddressableMember } from './team-runtime-types.ts'
import type { AgentTeamEvent } from './types.ts'
import type { AgentRunEvent } from '../mode/run-agent.ts'
import { abortable, combineSignals, withTimeout } from './common.ts'
import { localMemberIdle } from './team-support.ts'
import { runWakeLoop } from './team-wake.ts'
import { AgentSdkError } from '../../errors/index.ts'

interface TeamWorkOptions {
  readonly id: string
  readonly disposeTimeoutMs: number
  readonly operationTimeoutMs: number
  localMembers(): Iterable<LocalMemberRuntime>
  remoteMembers(): Iterable<RemoteMemberRuntime>
  cancelMember(name: string, reason: unknown): Promise<void>
  clear(): void
  emit(event: AgentTeamEvent): void
  observeAgentEvent(member: string, event: AgentRunEvent): Promise<void>
}

/** Owns cancellation and wake scheduling, including late wake requests. */
export class TeamWork {
  private readonly lifecycle = new AbortController()
  private disposed = false
  private disposeTask: Promise<void> | undefined

  constructor(private readonly options: TeamWorkOptions) {}

  get signal(): AbortSignal { return this.lifecycle.signal }

  async whenIdle(member: AddressableMember, signal?: AbortSignal): Promise<void> {
    if (member.kind === 'remote') {
      while (true) {
        const tail = member.tail
        await abortable(tail, signal)
        if (tail === member.tail && member.pending === 0) break
      }
      return
    }
    while (true) {
      const requested = member.wakeRequestedSeq
      const task = member.wakeTask
      const held = member.pendingStart
      if (held !== undefined) await abortable(held, signal)
      if (task !== undefined) await abortable(task, signal)
      await member.session.whenIdle(signal)
      if (localMemberIdle(member, requested)) return
    }
  }

  async cancel(member: AddressableMember, reason: unknown): Promise<void> {
    if (member.kind === 'remote') {
      for (const controller of member.controllers) controller.abort(reason)
      await withTimeout(
        member.tail,
        this.options.disposeTimeoutMs,
        `A2A member '${member.name}' did not cancel within ${this.options.disposeTimeoutMs}ms`,
        'TEAM_CANCELLATION_TIMEOUT',
      )
      return
    }
    member.wakeConsumedSeq = member.wakeRequestedSeq
    const controller = member.wakeController
    const task = member.wakeTask
    controller?.abort(reason)
    if (task !== undefined) {
      await withTimeout(
        task,
        this.options.disposeTimeoutMs,
        `A2A member '${member.name}' did not cancel within ${this.options.disposeTimeoutMs}ms`,
        'TEAM_CANCELLATION_TIMEOUT',
      )
    }
  }

  scheduleWake(member: LocalMemberRuntime, seq: number): void {
    this.assertActive()
    member.wakeRequestedSeq = Math.max(member.wakeRequestedSeq, seq)
    if (member.wakeTask !== undefined) return
    const controller = new AbortController()
    member.wakeController = controller
    const signal = combineSignals(
      this.lifecycle.signal, controller.signal, AbortSignal.timeout(this.options.operationTimeoutMs),
    )
    const task = runWakeLoop(member, signal, this.options).finally(() => {
      if (member.wakeTask === task) member.wakeTask = undefined
      if (member.wakeController === controller) member.wakeController = undefined
      if (member.wakeConsumedSeq < member.wakeRequestedSeq) {
        this.scheduleWake(member, member.wakeRequestedSeq)
      }
    })
    member.wakeTask = task
  }

  dispose(reason: unknown): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.disposed = true
    this.lifecycle.abort(reason)
    const settling = Promise.allSettled([
      ...[...this.options.localMembers()].map(member => this.options.cancelMember(member.name, reason)),
      ...[...this.options.remoteMembers()].map(member => this.options.cancelMember(member.name, reason)),
    ]).then(results => {
      this.options.clear()
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure !== undefined) {
        throw new AgentSdkError(
          `A2A team '${this.options.id}' did not dispose within ${this.options.disposeTimeoutMs}ms`,
          'TEAM_DISPOSE_TIMEOUT',
          { cause: failure.reason },
        )
      }
    })
    this.disposeTask = withTimeout(
      settling,
      this.options.disposeTimeoutMs,
      `A2A team '${this.options.id}' did not dispose within ${this.options.disposeTimeoutMs}ms`,
      'TEAM_DISPOSE_TIMEOUT',
    )
    return this.disposeTask
  }

  assertActive(): void {
    if (this.disposed) throw new Error(`A2A team '${this.options.id}' is disposed`)
  }
}
