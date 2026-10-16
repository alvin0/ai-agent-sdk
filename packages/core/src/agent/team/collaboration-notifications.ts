import { createUserMessage } from '../../message/index.ts'
import type { TeamSessionPort } from './contracts.ts'
import type { AgentTeam } from './team.ts'
import type { CollaborationBoardSnapshot, CollaborationTask } from './collaboration-types.ts'
import { taskReady } from './collaboration-task-state.ts'

/** Each member/task gets at most one notice of each kind over the team lifetime.
 * Reopen/complete and claim/release loops cannot renew automatic turn credits. */
export class CollaborationNotifications {
  private readonly delivered = new Set<string>()

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

  private notifyAvailable(id: string): void {
    for (const member of this.team.members()) {
      if (member.name === this.lead || member.status !== 'idle') continue
      this.notify(member.name, id, 'available', `Shared task '${id}' is ready and unclaimed. `
        + 'Read task_list and claim with its current revision if you can help.')
    }
  }

  private notify(name: string, id: string, kind: string, text: string): void {
    const key = JSON.stringify([name, id, kind])
    if (this.delivered.has(key)) return
    const session = this.sessions.get(name)
    if (session === undefined) return
    this.delivered.add(key)
    try {
      session.inject(createUserMessage({ source: { kind: 'app', producer: 'managed-team' },
        content: [{ type: 'text', text }] }))
      // Lead joining owns its continuation. Members use the ordinary pending-start-aware wake queue.
      if (name !== this.lead) { this.team.wake(name); this.onWake() }
    } catch { /* closed claimant; retained board state remains authoritative */ }
  }
}
