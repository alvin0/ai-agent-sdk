import { abortable, byteLength, combineSignals, deepCloneFreeze, positiveInteger } from './common.ts'
import { assertTaskGraph, newTask, taskError, taskId, taskReady, updateTask } from './collaboration-task-state.ts'
import type { CollaborationBoardSnapshot, CollaborationTask, CollaborationTaskView,
  CreateCollaborationTask, ManagedTeamCollaborationOptions, UpdateCollaborationTask } from './collaboration-types.ts'

interface BoardHost {
  readonly lead: string
  readonly signal: AbortSignal
  assertMember(name: string): void
  changed(before: CollaborationBoardSnapshot, after: CollaborationBoardSnapshot, actor: string): void
}

/** Team-owned task state. Mutations, dependency checks and revision checks share one queue. */
export class CollaborationTaskBoard {
  private state: CollaborationBoardSnapshot = deepCloneFreeze({ tasks: [] })
  private tail: Promise<unknown> = Promise.resolve()
  private readonly maxTasks: number
  private readonly maxTaskBytes: number
  private readonly maxBoardBytes: number

  constructor(options: ManagedTeamCollaborationOptions, private readonly host: BoardHost) {
    this.maxTasks = positiveInteger(options.maxTasks ?? 128, 'collaboration.maxTasks')
    this.maxTaskBytes = positiveInteger(options.maxTaskBytes ?? 16 * 1024, 'collaboration.maxTaskBytes')
    this.maxBoardBytes = positiveInteger(options.maxBoardBytes ?? 1024 * 1024, 'collaboration.maxBoardBytes')
  }

  snapshot(): CollaborationBoardSnapshot { return this.state }

  list(): readonly CollaborationTaskView[] {
    const tasks = new Map(this.state.tasks.map(task => [task.id, task]))
    return deepCloneFreeze(this.state.tasks.map(task => ({ ...task, ready: taskReady(task, tasks) })))
  }

  create(actor: string, input: CreateCollaborationTask, signal?: AbortSignal): Promise<CollaborationTaskView> {
    const captured = structuredClone(input)
    return this.transact(actor, tasks => {
      if (tasks.size >= this.maxTasks) taskError('task board capacity reached', 'TEAM_TASK_LIMIT')
      const task = newTask(captured)
      if (tasks.has(task.id)) taskError(`task '${task.id}' already exists`, 'TEAM_TASK_ALREADY_EXISTS')
      return task
    }, signal)
  }

  update(actor: string, input: UpdateCollaborationTask, signal?: AbortSignal): Promise<CollaborationTaskView> {
    const captured = structuredClone(input)
    return this.transact(actor, tasks => {
      const task = tasks.get(taskId(captured.id))
      if (task === undefined) taskError(`unknown task '${captured.id}'`, 'TEAM_TASK_NOT_FOUND')
      return updateTask(task, captured, { actor, lead: this.host.lead }, tasks)
    }, signal)
  }

  private transact(actor: string, mutation: (tasks: Map<string, CollaborationTask>) => CollaborationTask,
    signal?: AbortSignal): Promise<CollaborationTaskView> {
    const operation = combineSignals(this.host.signal, signal)
    const pending = this.tail.then(() => {
      operation.throwIfAborted()
      this.host.assertMember(actor)
      const before = this.state
      const tasks = new Map(before.tasks.map(task => [task.id, task]))
      const task = mutation(tasks)
      tasks.set(task.id, task)
      this.validate(tasks, task)
      const after = deepCloneFreeze({ tasks: [...tasks.values()] })
      if (byteLength(after) > this.maxBoardBytes) taskError('task board byte limit exceeded', 'TEAM_TASK_LIMIT')
      operation.throwIfAborted()
      this.host.assertMember(actor)
      this.state = after
      this.host.changed(before, after, actor)
      return deepCloneFreeze({ ...task, ready: taskReady(task, tasks) })
    })
    this.tail = pending.catch(() => {})
    return abortable(pending, operation)
  }

  private validate(tasks: ReadonlyMap<string, CollaborationTask>, task: CollaborationTask): void {
    if (byteLength(task) > this.maxTaskBytes) taskError('task byte limit exceeded', 'TEAM_TASK_LIMIT')
    assertTaskGraph(tasks)
    for (const candidate of tasks.values()) {
      if (candidate.status === 'completed' && !taskReady(candidate, tasks)) {
        taskError('completed tasks must have completed dependencies', 'TEAM_TASK_BLOCKED')
      }
    }
  }
}
