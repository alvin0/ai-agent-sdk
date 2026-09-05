import { systemRandomId } from '../../../platform/adapter.ts'
import type { ToolDefinition } from '../../tool/definition.ts'
import { ToolRegistry, type ToolCatalog } from '../../tool/registry.ts'
import type { Message, UserMessage } from '../../../message/index.ts'
import { createTextMessage, freezeMessage } from '../../../message/index.ts'
import { type AgentInput } from './types.ts'

export function conversationId(value: string | undefined): string {
  if (value === undefined) return newConversationId()
  if (value.trim().length === 0 || value.length > 256) {
    throw new TypeError('agent conversationId must be a non-empty string of at most 256 characters')
  }
  return value
}

export function newConversationId(): string {
  return systemRandomId()
}

export function userMessage(input: AgentInput): UserMessage {
  if (typeof input === 'string') return createTextMessage(input)
  if (input.role !== 'user') throw new TypeError('agent input message must have role user')
  return freezeMessage(input)
}

export function isUserMessage(message: Message): message is UserMessage { return message.role === 'user' }

export interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function errorCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

export function toolCatalog(
  defined: readonly ToolDefinition<any>[],
  additional: ToolCatalog | readonly ToolDefinition<any>[] | undefined,
  generated: readonly ToolDefinition<any>[] = [],
): ToolCatalog | undefined {
  if (defined.length === 0 && additional === undefined && generated.length === 0) return undefined
  const registry = new ToolRegistry()
  for (const tool of defined) registry.register(tool)
  if (additional !== undefined) {
    const tools = 'names' in additional
      ? additional.names().map(name => additional.get(name))
        .filter((tool): tool is ToolDefinition => tool !== undefined)
      : additional
    for (const tool of tools) registry.register(tool)
  }
  for (const tool of generated) registry.register(tool)
  return registry
}
