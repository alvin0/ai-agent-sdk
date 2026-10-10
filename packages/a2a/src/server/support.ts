import {
  Role,
  TaskState,
  type Message as A2AMessage,
  type Task,
} from '@a2a-js/sdk'
import {
  type RequestContext,
} from '@a2a-js/sdk/server'
import type { SupportSafeError } from '@alvin0/ai-agent-sdk-core'
import type { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { cleanupFailure } from '../common/cleanup-report.ts'
import type { A2ADisposeReport } from './types.ts'

export function initialTask(context: RequestContext): Task {
  return context.task ?? {
    id: context.taskId,
    contextId: context.contextId,
    status: status(TaskState.TASK_STATE_SUBMITTED),
    artifacts: [],
    history: [structuredClone(context.userMessage)],
    metadata: context.request.metadata,
  }
}

export function status(state: TaskState, message?: A2AMessage): NonNullable<Task['status']> {
  return {
    state,
    message,
    timestamp: new Date().toISOString(),
  }
}

export function agentMessage(context: RequestContext, text: string): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    contextId: context.contextId,
    taskId: context.taskId,
    role: Role.ROLE_AGENT,
    parts: [{
      content: { $case: 'text', value: text },
      mediaType: 'text/plain',
      filename: '',
      metadata: undefined,
    }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

export function requiredRegistry(registry: ModelRegistry | undefined): ModelRegistry {
  if (registry === undefined) throw new TypeError('A2A executor requires registry')
  return registry
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function boundedKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  if (utf8Bytes(value) > 1024) throw new TypeError(`${label} must not exceed 1024 bytes`)
  return value
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function byteLength(value: unknown): number {
  return utf8Bytes(JSON.stringify(value))
}

export async function scopedConversationId(sessionKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionKey))
  const hex = [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')
  return `a2a-${hex}`
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function disposeReport(status: A2ADisposeReport['status'], alreadyDisposed: boolean,
  error: SupportSafeError | undefined = status === 'disposed' ? undefined
    : cleanupFailure(status === 'timed-out' ? 'A2A_DISPOSE_TIMEOUT' : 'A2A_DISPOSE_FAILED',
      'a2a-dispose', status === 'timed-out' ? 'A2A executor cleanup timed out' : 'A2A executor cleanup failed')):
  A2ADisposeReport {
  return Object.freeze({ status, alreadyDisposed, ...(error === undefined ? {} : { error }) })
}
