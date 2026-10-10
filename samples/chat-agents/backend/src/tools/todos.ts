import { defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import type { TodoItem } from '../wire'
import { json, card } from './values'

export function writeTodosTool(_root: string) {
  return defineTool({
    name: 'write_todos',
    budgetExempt: true,
    completionExempt: true,
    description: 'Publish the current task list so the user can follow along.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'active', 'done'] },
            },
            required: ['text', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    parse: (raw) => {
      const items = (raw as { items?: unknown }).items
      if (!Array.isArray(items)) throw new Error('"items" must be an array')
      return {
        items: items.map((entry): TodoItem => {
          const record = entry as { text?: unknown; status?: unknown }
          if (typeof record.text !== 'string') throw new Error('every item needs a "text" string')
          const status = record.status
          return {
            text: record.text,
            status: status === 'active' || status === 'done' ? status : 'pending',
          }
        }),
      }
    },
    execute: ({ items }) => json({ items, count: items.length }),
    meta: value => {
      const record = value as { items: TodoItem[] } | undefined
      return record === undefined ? undefined : card({ kind: 'todo', items: record.items })
    },
  })
}
