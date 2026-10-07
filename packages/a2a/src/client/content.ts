import {
  Role,
  TaskState,
  type Message,
  type Part,
  type Task,
} from '@a2a-js/sdk'
import type {
  LinkedAgentResult,
} from '@alvin0/ai-agent-sdk-core/agent'
import type { ContentBlock } from '@alvin0/ai-agent-sdk-core'

export function contentPart(block: ContentBlock): Part {
  if (block.type === 'text') return part({ $case: 'text', value: block.text }, 'text/plain')
  if (block.type === 'image') {
    if (block.source.kind === 'url') return part({ $case: 'url', value: block.source.url }, 'image/*')
    if (block.source.kind === 'base64') {
      return part(
        { $case: 'url', value: `data:${block.source.mediaType};base64,${block.source.data}` },
        block.source.mediaType,
      )
    }
    return part({ $case: 'data', value: { type: 'image-file', fileId: block.source.fileId } }, 'application/json')
  }
  return part({ $case: 'data', value: structuredClone(block) }, 'application/json')
}

export function part(content: NonNullable<Part['content']>, mediaType: string): Part {
  return { content, metadata: undefined, filename: '', mediaType }
}

export function normalizeResult(result: Message | Task): LinkedAgentResult {
  return 'messageId' in result ? normalizeMessage(result) : normalizeTask(result)
}

export function normalizeMessage(message: Message): LinkedAgentResult {
  return Object.freeze({
    kind: 'message', succeeded: message.role === Role.ROLE_AGENT,
    text: textOfMessage(message), contextId: message.contextId,
    ...(message.taskId.length === 0 ? {} : { taskId: message.taskId }),
  })
}

export function normalizeTask(task: Task): LinkedAgentResult {
  const state = task.status?.state
  const artifactText = task.artifacts.map(artifact => textOfParts(artifact.parts)).filter(Boolean).join('\n')
  const statusText = textOfMessage(task.status?.message)
  const historyText = [...task.history].reverse()
    .find(message => message.role === Role.ROLE_AGENT)
  return Object.freeze({
    kind: 'task',
    succeeded: state === TaskState.TASK_STATE_COMPLETED,
    text: artifactText || statusText || textOfMessage(historyText),
    contextId: task.contextId,
    taskId: task.id,
    ...(state === undefined ? {} : { state: taskStateName(state) }),
  })
}

export function textOfMessage(message: Message | undefined): string {
  return message === undefined ? '' : textOfParts(message.parts)
}

export function textOfParts(parts: readonly Part[]): string {
  return parts.flatMap(item => item.content?.$case === 'text' ? [item.content.value] : []).join('')
}

export function taskStateName(state: TaskState): string {
  return TaskState[state] ?? String(state)
}
