import { systemRandomId } from '../../platform/adapter.ts'
import type { ContentBlock } from '../../message/index.ts'
import type { JsonValue } from '../../primitives/index.ts'
import { deepFreeze as freezeDeep } from '../../primitives/index.ts'
import { AgentSdkError } from '../../errors/index.ts'

export const MEMBER_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/
export const MAX_MEMBER_NAME_LENGTH = 128
export const TEAM_TOOL_NAMES = Object.freeze({
  list: 'list_agents',
  send: 'send_message',
  followup: 'followup_task',
  wait: 'wait_agents',
} as const)
export function messageToolSchema(messageDescription: string): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Exact agent name returned by list_agents.' },
      message: { type: 'string', description: messageDescription },
    },
    required: ['target', 'message'], additionalProperties: false,
  }
}

export function parseMessageTool(raw: unknown): { target: string; message: string } {
  const value = object(raw, 'A2A tool arguments')
  if (Object.keys(value).some(key => key !== 'target' && key !== 'message')) {
    throw new TypeError('A2A tool arguments contain unknown fields')
  }
  return { target: memberName(value.target), message: nonEmpty(value.message, 'message') }
}

export function parseWaitTool(raw: unknown): { targets: readonly string[] } {
  const value = object(raw, 'wait_agents arguments')
  if (Object.keys(value).some(key => key !== 'targets')) {
    throw new TypeError('wait_agents arguments contain unknown fields')
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    throw new TypeError('wait_agents targets must be a non-empty array')
  }
  const targets = value.targets.map(memberName)
  if (new Set(targets).size !== targets.length) {
    throw new TypeError('wait_agents targets must be unique')
  }
  return { targets: Object.freeze(targets) }
}

export function emptyObject(raw: unknown, label: string): Record<string, never> {
  const value = object(raw, `${label} arguments`)
  if (Object.keys(value).length > 0) throw new TypeError(`${label} takes no arguments`)
  return value as Record<string, never>
}

export function messageContent(
  value: string | readonly ContentBlock[],
  maxBytes: number,
): readonly ContentBlock[] {
  if (byteLength(value) > maxBytes) throw new TypeError(`A2A message exceeds the ${maxBytes}-byte limit`)
  if (typeof value === 'string') return deepCloneFreeze([{ type: 'text', text: nonEmpty(value, 'message') }])
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('A2A message content must not be empty')
  return deepCloneFreeze(value)
}

export function memberName(value: unknown): string {
  const name = nonEmpty(value, 'A2A member name')
  if (!MEMBER_NAME.test(name)) {
    throw new TypeError('A2A member name must start with a letter and contain only letters, digits, _ or -')
  }
  if (name.length > MAX_MEMBER_NAME_LENGTH) {
    throw new TypeError(`A2A member name must not exceed ${MAX_MEMBER_NAME_LENGTH} characters`)
  }
  return name
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`)
  return value
}

export function boundedString(value: unknown, label: string, maxBytes: number): string {
  const text = nonEmpty(value, label)
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new TypeError(`${label} must not exceed ${maxBytes} bytes`)
  }
  return text
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
  return value
}

export function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function asJson(value: unknown): JsonValue { return value as JsonValue }

export function deepCloneFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

export function deepFreeze<T>(value: T): T {
  return freezeDeep(value)
}

export function newTeamId(): string {
  return systemRandomId()
}

export function newMessageId(): string {
  return systemRandomId()
}

export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function combineSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (active.length === 1) return active[0]!
  return AbortSignal.any(active)
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  code = 'TEAM_OPERATION_TIMEOUT',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentSdkError(message, code)), timeoutMs)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}
