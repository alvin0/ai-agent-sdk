import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import { asJson, object } from './common.ts'
import type { CollaborationTaskBoard } from './collaboration-board.ts'
import type { CreateCollaborationTask, UpdateCollaborationTask } from './collaboration-types.ts'

const fields = {
  id: { type: 'string', description: 'Stable team-local task id, at most 128 UTF-8 bytes.' },
  title: { type: 'string', description: 'Concrete objective and completion criteria.' },
  blockedBy: { type: 'array', items: { type: 'string' },
    description: 'Existing task ids that must complete before work can finish. Cycles are rejected.' },
  notes: { type: 'string',
    description: 'Shared task scratchpad. Replace using the latest revision; preserve others’ findings.' },
}

function input(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const value = object(raw, 'task arguments')
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('unknown task argument')
  return value
}

function parseCreate(raw: unknown): CreateCollaborationTask {
  return input(raw, Object.keys(fields)) as unknown as CreateCollaborationTask
}

function parseUpdate(raw: unknown): UpdateCollaborationTask {
  const value = input(raw, [...Object.keys(fields), 'expectedRevision', 'action', 'result'])
  const common = ['id', 'expectedRevision', 'action']
  const actions: Record<string, readonly string[]> = {
    claim: ['notes'], release: ['notes'], complete: ['notes', 'result'], reopen: ['notes'],
    annotate: ['notes'],
  }
  const allowed = typeof value.action === 'string' ? actions[value.action] : undefined
  if (allowed === undefined || Object.keys(value).some(key => ![...common, ...allowed].includes(key))) {
    throw new TypeError('unsupported task action or fields for action')
  }
  return value as unknown as UpdateCollaborationTask
}

function parseList(raw: unknown): { ids?: string[]; status?: 'pending' | 'claimed' | 'completed' } {
  const value = input(raw, ['ids', 'status'])
  if (value.ids !== undefined && (!Array.isArray(value.ids) || value.ids.length > 128
    || !value.ids.every(id => typeof id === 'string' && id.length > 0))) {
    throw new TypeError('ids must be an array of at most 128 task ids')
  }
  if (value.status !== undefined && !['pending', 'claimed', 'completed'].includes(String(value.status))) {
    throw new TypeError('unknown task status')
  }
  return value as ReturnType<typeof parseList>
}

export function collaborationBoardTools(board: CollaborationTaskBoard, sender: string,
  lead: string): readonly ToolDefinition<any>[] {
  return [
    defineTool({ name: 'task_create', budgetExempt: true,
      description: 'Create a shared pending task. All members can read its notes, dependencies and result.',
      parameters: { type: 'object', properties: fields, required: ['id', 'title'], additionalProperties: false },
      parse: parseCreate,
      execute: async (args, ctx) => asJson(await board.create(sender, args, ctx.signal)),
      isConcurrencySafe: () => true }),
    defineTool({ name: 'task_list', budgetExempt: true,
      description: 'List compact task status, revisions, owners and readiness. Filter by status or ids. '
        + 'Use ids to fetch full task notes and results.',
      parameters: { type: 'object', properties: {
        ids: { type: 'array', items: { type: 'string' }, maxItems: 128 },
        status: { type: 'string', enum: ['pending', 'claimed', 'completed'] },
      }, additionalProperties: false },
      parse: parseList, execute: ({ ids, status }) => asJson(board.list()
        .filter(task => (ids === undefined || ids.includes(task.id))
          && (status === undefined || task.status === status))
        .map(task => {
          if (ids !== undefined) return task
          const { notes: _notes, result: _result, ...compact } = task
          return compact
        })),
      isConcurrencySafe: () => true }),
    defineTool({ name: 'task_update', budgetExempt: true,
      description: 'Compare-and-set a task using expectedRevision from task_list. Claim reserves even a blocked task; '
        + 'work only when ready=true. Release/complete require the owner or lead; reopen is lead-only. '
        + 'annotate replaces shared notes for any member. A completed task can reopen after its completed dependents. '
        + 'A stale revision changes nothing: read again before retrying.',
      parameters: { type: 'object', properties: { id: fields.id, notes: fields.notes,
        expectedRevision: { type: 'integer', minimum: 1 },
        action: { type: 'string', enum: sender === lead
          ? ['claim', 'release', 'complete', 'reopen', 'annotate'] : ['claim', 'release', 'complete', 'annotate'] },
        result: { type: 'string', description: 'Retained findings on complete; readable by every member.' },
      }, required: ['id', 'expectedRevision', 'action'], additionalProperties: false },
      parse: parseUpdate,
      execute: async (args, ctx) => asJson(await board.update(sender, args, ctx.signal)),
      isConcurrencySafe: () => true }),
  ]
}
