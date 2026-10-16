import { AgentSdkError } from '../../errors/index.ts'
import { boundedString, positiveInteger } from './common.ts'
import type { CollaborationTask, CreateCollaborationTask, UpdateCollaborationTask } from './collaboration-types.ts'

export function taskError(message: string, code: string): never {
  throw new AgentSdkError(message, code)
}

export function taskId(value: unknown): string { return boundedString(value, 'task id', 128) }

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`)
  return value
}

function strings(value: readonly string[], parse: (value: unknown) => string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError('task dependencies must be arrays')
  if (value.length > 128) throw new TypeError('task dependencies are limited to 128 entries')
  const result = value.map(parse)
  if (new Set(result).size !== result.length) throw new TypeError('task dependencies must be unique')
  return result
}

export function newTask(input: CreateCollaborationTask): CollaborationTask {
  return { id: taskId(input.id), revision: 1, title: boundedString(input.title, 'task title', 1024),
    status: 'pending', blockedBy: strings(input.blockedBy ?? [], taskId),
    notes: text(input.notes ?? '', 'notes'), result: '' }
}

export function taskReady(task: CollaborationTask, tasks: ReadonlyMap<string, CollaborationTask>): boolean {
  return task.blockedBy.every(id => tasks.get(id)?.status === 'completed')
}

function assertOwner(task: CollaborationTask, actor: string, lead: string): void {
  if (actor !== lead && task.owner !== undefined && task.owner !== actor) {
    taskError(`task '${task.id}' requires its owner or lead`, 'TEAM_TASK_UNAUTHORIZED')
  }
}

function transition(task: CollaborationTask, input: UpdateCollaborationTask, actor: string): CollaborationTask {
  switch (input.action) {
    case 'claim':
      requireStatus(task, 'pending', 'TEAM_TASK_ALREADY_CLAIMED')
      return { ...task, status: 'claimed', owner: actor }
    case 'release': {
      if (task.status !== 'claimed') taskError('only claimed tasks can be released', 'TEAM_TASK_INVALID_TRANSITION')
      const { owner: _owner, ...rest } = task
      return { ...rest, status: 'pending' }
    }
    case 'complete':
      if (task.status !== 'claimed') taskError('only claimed tasks can complete', 'TEAM_TASK_INVALID_TRANSITION')
      return { ...task, status: 'completed', result: resultText(input.result) }
    case 'reopen': {
      if (task.status !== 'completed') taskError('only completed tasks can reopen', 'TEAM_TASK_INVALID_TRANSITION')
      const { owner: _owner, ...rest } = task
      return { ...rest, status: 'pending', result: '' }
    }
    case 'annotate':
      return { ...task, notes: text(input.notes, 'notes') }
    default: throw new TypeError('unknown task action')
  }
}

function requireStatus(task: CollaborationTask, status: CollaborationTask['status'], code: string): void {
  if (task.status !== status) taskError(`task must be ${status}`, code)
}

function resultText(value: unknown): string { return text(value ?? '', 'result') }

export function updateTask(task: CollaborationTask, input: UpdateCollaborationTask,
  identity: { actor: string; lead: string }, tasks: ReadonlyMap<string, CollaborationTask>): CollaborationTask {
  positiveInteger(input.expectedRevision, 'expectedRevision')
  if (input.expectedRevision !== task.revision) {
    taskError(`stale task '${task.id}'; current revision is ${task.revision}`, 'TEAM_TASK_STALE_REVISION')
  }
  if (input.action !== 'claim' && input.action !== 'annotate') assertOwner(task, identity.actor, identity.lead)
  if (input.action === 'complete' && !taskReady(task, tasks)) {
    taskError('blocked tasks cannot complete', 'TEAM_TASK_BLOCKED')
  }
  if (input.action === 'reopen') assertReopen(task, identity, tasks)
  const next = transition(task, input, identity.actor)
  return { ...next, revision: task.revision + 1,
    ...(input.notes === undefined ? {} : { notes: text(input.notes, 'notes') }) }
}

function assertReopen(task: CollaborationTask, identity: { actor: string; lead: string },
  tasks: ReadonlyMap<string, CollaborationTask>): void {
  if (identity.actor !== identity.lead) {
    taskError('only the lead can reopen completed tasks', 'TEAM_TASK_UNAUTHORIZED')
  }
  if ([...tasks.values()].some(other => other.status === 'completed' && other.blockedBy.includes(task.id))) {
    taskError('reopen completed dependents first', 'TEAM_TASK_HAS_DEPENDENTS')
  }
}

export function assertTaskGraph(tasks: ReadonlyMap<string, CollaborationTask>): void {
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) taskError(`task dependency cycle at '${id}'`, 'TEAM_TASK_DEPENDENCY_CYCLE')
    if (visited.has(id)) return
    const task = tasks.get(id)
    if (task === undefined) taskError(`missing blocker '${id}'`, 'TEAM_TASK_NOT_FOUND')
    visiting.add(id)
    task.blockedBy.forEach(visit)
    visiting.delete(id)
    visited.add(id)
  }
  tasks.forEach(task => visit(task.id))
}
