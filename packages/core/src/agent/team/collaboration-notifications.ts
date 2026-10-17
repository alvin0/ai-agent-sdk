import { createUserMessage } from '../../message/index.ts'
import type { TeamSessionPort } from './contracts.ts'
import type { AgentTeam } from './team.ts'
import type { CollaborationBoardSnapshot, CollaborationTask } from './collaboration-types.ts'
import { taskReady } from './collaboration-task-state.ts'

/** Each member/task gets at most one notice of each kind over the team lifetime.
 * Reopen/complete and claim/release loops cannot renew automatic turn credits. */
export class CollaborationNotifications {
  private readonly delivered = new Set<string>()
  private cursor = 0

  constructor(private readonly team: AgentTeam, private readonly lead: string,
    private readonly sessions: ReadonlyMap<string, TeamSessionPort>, private readonly onWake: () => void) {}

  changed(before: CollaborationBoardSnapshot, after: CollaborationBoardSnapshot): void {
    const previous = new Map(before.tasks.map(task => [task.id, task]))
    const current = new Map(after.tasks.map(task => [task.id, task]))
    for (const task of after.tasks) {
      const old = previous.get(task.id)
      const ready = taskReady(task, current)
      const wasReady = old !== undefined && taskReady(old, previous)
      this.notifyClaimant(task, old, ready, wasReady)
      if (task.status === 'pending' && ready && !(old?.status === 'pending' && wasReady)) {
        this.notifyAvailable(task.id)
      }
    }
  }

  private notifyClaimant(task: CollaborationTask, old: CollaborationTask | undefined,
    ready: boolean, wasReady: boolean): void {
    if (task.status !== 'claimed' || task.owner === undefined || old === undefined || ready === wasReady) return
    const kind = ready ? 'unblocked' : 'blocked'
    this.notify(task.owner, task.id, kind, `Shared task '${task.id}' is now ${kind}. `
      + 'Read task_list with ids for dependencies and findings; work only when ready=true.')
  }

  /** One idle member per newly ready task, rotating, so members do not all spend a turn racing one claim.
   * The lead still sees every ready task on the board and can assign work an offered member skips. */
  private notifyAvailable(id: string): void {
    const offered = noticeKey('', id, 'available') // Member names are non-empty; this marks the task itself.
    if (this.delivered.has(offered)) return
    const idle = this.team.members().filter(member => member.name !== this.lead && member.status === 'idle'
      && this.sessions.has(member.name) && !this.delivered.has(noticeKey(member.name, id, 'available')))
    for (let offset = 0; offset < idle.length; offset++) {
      const index = (this.cursor + offset) % idle.length
      if (this.notify(idle[index]!.name, id, 'available', `Shared task '${id}' is ready and unclaimed. `
        + 'Read task_list and claim with its current revision if you can help.')) {
        this.cursor = index + 1
        this.delivered.add(offered)
        return
      }
    }
  }

  /** A notice counts as delivered only once it reached the member's session. */
  private notify(name: string, id: string, kind: string, text: string): boolean {
    const key = noticeKey(name, id, kind)
    if (this.delivered.has(key)) return false
    const session = this.sessions.get(name)
    if (session === undefined) return false
    try {
      session.inject(createUserMessage({ source: { kind: 'app', producer: 'managed-team' },
        content: [{ type: 'text', text }] }))
    } catch { return false /* closed claimant; retained board state remains authoritative */ }
    this.delivered.add(key)
    // Lead joining owns its continuation. Members use the ordinary pending-start-aware wake queue.
    try { if (name !== this.lead) { this.team.wake(name); this.onWake() } } catch { /* member closed after inject */ }
    return true
  }
}

function noticeKey(name: string, id: string, kind: string): string { return JSON.stringify([name, id, kind]) }
