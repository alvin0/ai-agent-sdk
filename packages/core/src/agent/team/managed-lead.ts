/** Coordinates the lead's next turn with worker reports and host steering. */
import { createUserMessage } from '../../message/index.ts'
import type { AgentSession } from '../define/session.ts'
import type { TurnHooks } from '../loop/events.ts'
import type { AgentTeam } from './team.ts'
import type { ManagedAgentTeamOptions, WorkerRuntime } from './managed-types.ts'
import { abortable, combineSignals } from './managed-support.ts'

interface ManagedLeadHost {
  readonly options: ManagedAgentTeamOptions
  readonly team: AgentTeam
  readonly leadName: string
  readonly holdWaitMs: number
  readonly signal: AbortSignal
  workers(): Iterable<WorkerRuntime>
  lead(): AgentSession
}

export class ManagedLeadCoordination {
  /** Set when a worker report was delivered quietly and no round has read it. */
  private unreadReports = false
  private leadSteer = new AbortController()
  private leadSignal: AbortSignal | undefined

  constructor(private readonly host: ManagedLeadHost) {}

  markUnread(): void { this.unreadReports = true }

  interruptWait(): void { this.leadSteer.abort() }

  /**
   * Hold the lead's turn open while a worker of its is unfinished.
   *
   * This is Codex's shape, arrived at from the other side: there the parent
   * stays inside its turn and loops on its wait tool until it has what it
   * needs. A lead that concludes while its workers are still running answers
   * from nothing — and once the turn is over, the reports that arrive
   * afterwards have no turn left to be read in, so the work stops with no
   * synthesis at all.
   *
   * `runTurn` re-runs a turn whose `onTurnEnd` hook appended history, so
   * saying so is enough to send the lead round again. Its own step and turn
   * budgets bound this, and `canContinue` leaves an aborted or exhausted turn
   * free to end.
   * @param host - Hooks the host supplied; theirs run first and are kept.
   * @returns The hooks to give the lead's session.
   */
  hooks(host: TurnHooks | undefined): TurnHooks {
    return {
      ...host,
      beforeStep: async (context) => {
        // The request for this round is rebuilt from history, so anything
        // delivered quietly before now is about to be read.
        this.unreadReports = false
        this.leadSteer = new AbortController()
        this.leadSignal = context.signal
        return await host?.beforeStep?.(context) ?? { kind: 'proceed' as const }
      },
      onTurnEnd: async (context) => {
        await host?.onTurnEnd?.(context)
        if (this.host.options.autoLeadCoordination === false) return
        if (!context.canContinue) {
          // The turn is over and cannot be extended — a spent step budget, an
          // error, a stop. A report that arrived during it has no round left to
          // be read in, and the run would end with the synthesis unwritten, so
          // one more turn is scheduled for when the lead goes idle.
          if (this.unreadReports) {
            this.unreadReports = false
            try { this.host.team.wake(this.host.leadName) } catch { /* team disposed */ }
          }
          return
        }
        // Pending counts as busy. A worker held behind `dependsOn` has not
        // started, but it WILL run and report, and a lead that concluded while
        // its dependency chain was still queued answers from work that never
        // reached it.
        const outstanding = [...this.host.workers()]
          .filter(runtime => runtime.status === 'running' || runtime.status === 'pending')
        if (outstanding.length === 0) return
        // WAIT for news before spending another model call.
        //
        // Re-prompting immediately is a spin: measured on a real run, a lead
        // with slow researchers answered "still waiting" twelve times in half a
        // second and had no budget left when the results finally arrived. Codex
        // has the parent block inside `wait_agent` until a mailbox update
        // arrives or a deadline passes; the DeepSeek harness starts the next
        // round only when there is something to start it for. This is the same
        // shape from inside the hook: the turn stays open, costing nothing,
        // until a worker reports or the wait expires.
        await this.awaitWorkerNews(outstanding)
        const busy = [...this.host.workers()]
          .filter(runtime => runtime.status === 'running' || runtime.status === 'pending')
          .map(runtime => runtime.request.name)
        if (busy.length === 0) {
          this.host.lead().inject(createUserMessage({
            source: { kind: 'app', producer: 'managed-team' },
            content: [{ type: 'text',
              text: 'All outstanding managed workers have settled. '
                + 'Their statuses and retained results are available through list_agents.' }],
          }))
          return
        }
        this.host.lead().inject(createUserMessage({
          source: { kind: 'app', producer: 'managed-team' },
          content: [{ type: 'text', text: `Outstanding managed workers: ${busy.join(', ')}. `
            + 'Their current lifecycle status is available through list_agents; '
            + 'wait_agents is bounded by its timeout.' }],
        }))
      },
    }
  }

  /**
   * Block until a worker reports, or the hold deadline passes.
   *
   * Bounded on purpose. An unbounded wait would hand the whole run's liveness to
   * the slowest worker and, since this runs inside a turn hook, would be cut off
   * by the hook timeout rather than by anything that understands the work. When
   * it expires the lead gets its turn back and decides for itself — wait again
   * with `wait_agents`, close one, or answer with what it has.
   * @param outstanding - Workers that have not settled.
   */
  private async awaitWorkerNews(outstanding: readonly WorkerRuntime[]): Promise<void> {
    let removeSteer: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.host.holdWaitMs)
      // A timer must never be the reason a process stays alive. Node exposes
      // `unref`; a browser timer has no such handle and needs none.
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    try {
      const steered = this.leadSteer.signal
      const correction = new Promise<void>(resolve => {
        if (steered.aborted) resolve()
        else steered.addEventListener('abort', resolveSteer, { once: true })
        function resolveSteer() { resolve() }
        removeSteer = () => steered.removeEventListener('abort', resolveSteer)
      })
      await abortable(Promise.race([...outstanding.map(runtime => runtime.settled), deadline, correction]),
        combineSignals(this.host.signal, this.leadSignal))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      removeSteer?.()
    }
  }

}
