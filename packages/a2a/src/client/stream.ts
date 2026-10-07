import {
  TaskState,
  type Message,
  type SendMessageRequest,
  type Task,
} from '@a2a-js/sdk'
import {
  type Client,
  type RequestOptions,
} from '@a2a-js/sdk/client'
import type {
  LinkedAgentResult,
} from '@alvin0/ai-agent-sdk-core/agent'
import { detachedFrozen } from '@alvin0/ai-agent-sdk-core'
import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import { byteLength, raceWithSignal } from './values.ts'
import { normalizeMessage, normalizeTask, textOfMessage, textOfParts, taskStateName } from './content.ts'
import type { StreamResponse } from '@a2a-js/sdk'

interface StreamLimits {
  maxStreamEvents: number; maxStreamBytes: number; teardownTimeoutMs: number
  onStreamEvent: ((event: StreamResponse) => void) | undefined
}

export async function sendStreaming(
  client: Client, request: SendMessageRequest, options: RequestOptions, limits: StreamLimits,
): Promise<LinkedAgentResult> {

  const state: StreamState = {
    lastTask: undefined, lastMessage: undefined, taskId: '', contextId: request.message?.contextId ?? '',
    state: undefined, streamedArtifactText: [], streamedStatusText: [], eventCount: 0, streamBytes: 0,
  }
  const iterator = client.sendMessageStream(request, options)[Symbol.asyncIterator]()
  let exhausted = false
  try {
    while (true) {
      const next = await raceWithSignal(iterator.next(), options.signal)
      if (next.done === true) {
        exhausted = true
        break
      }
      const rawEvent = next.value
      checkStreamBudget(rawEvent, state, limits)
      // A diagnostic observer must never be able to mutate the protocol value
      // before transport state is reduced from it.
      const event = detachedFrozen(rawEvent)
      try { limits.onStreamEvent?.(event) } catch { /* observers do not own transport correctness */ }
      reduceEvent(event, state)
    }
  } finally {
    if (!exhausted) await closeStream(iterator, limits.teardownTimeoutMs)
  }
  return streamResult(state)
}

function checkStreamBudget(event: StreamResponse, state: StreamState, limits: StreamLimits): void {
  state.eventCount++
  state.streamBytes += byteLength(event)
  if (state.eventCount > limits.maxStreamEvents) {
    throw new Error(`A2A stream exceeds the ${limits.maxStreamEvents}-event limit`)
  }
  if (state.streamBytes > limits.maxStreamBytes) {
    throw new Error(`A2A stream exceeds the ${limits.maxStreamBytes}-byte limit`)
  }
}

function reduceEvent(event: StreamResponse, state: StreamState): void {
  const payload = event.payload
  if (payload === undefined) return
  if (payload.$case === 'task') {
    state.lastTask = payload.value
    state.taskId = payload.value.id
    state.contextId = payload.value.contextId
    state.state = payload.value.status?.state
  } else if (payload.$case === 'message') {
    state.lastMessage = payload.value
    state.contextId = payload.value.contextId
    state.taskId = payload.value.taskId
  } else {
    reduceUpdate(payload, state)
  }
}

async function closeStream(iterator: AsyncIterator<StreamResponse>, timeoutMs: number): Promise<void> {
  const close = iterator.return?.bind(iterator)
  if (close !== undefined) {
    const settled = await waitForSettlement(
      Promise.resolve().then(async () => { await close() }),
      timeoutMs,
    )
    if (!settled) {
      throw new Error(`A2A stream teardown exceeded ${timeoutMs}ms`)
    }
  }
}

function streamResult(input: StreamState): LinkedAgentResult {
  const { lastTask, lastMessage, taskId, contextId, state, streamedArtifactText, streamedStatusText } = input
  if (lastMessage !== undefined && (state === undefined || taskId.length === 0)) {
    return normalizeMessage(lastMessage)
  }
  if (lastMessage !== undefined) return messageTaskResult(input, lastMessage)
  if (lastTask !== undefined) return taskResult(input, lastTask)
  if (taskId.length === 0) throw new Error('A2A stream ended without a message or task')
  return Object.freeze({
    kind: 'task',
    succeeded: state === TaskState.TASK_STATE_COMPLETED,
    text: streamedArtifactText.join('') || streamedStatusText.at(-1) || '',
    contextId,
    taskId,
    ...(state === undefined ? {} : { state: taskStateName(state) }),
  })
}

interface StreamState {
  lastTask: Task | undefined; lastMessage: Message | undefined; taskId: string; contextId: string
  state: TaskState | undefined; streamedArtifactText: string[]; streamedStatusText: string[]
  eventCount: number; streamBytes: number
}

function reduceUpdate(payload: NonNullable<StreamResponse['payload']>, state: StreamState): void {
  if (payload.$case === 'statusUpdate') {
    state.taskId = payload.value.taskId
    state.contextId = payload.value.contextId
    state.state = payload.value.status?.state
    const text = textOfMessage(payload.value.status?.message)
    if (text.length > 0) state.streamedStatusText.push(text)
  } else if (payload.$case === 'artifactUpdate') {
    state.taskId = payload.value.taskId
    state.contextId = payload.value.contextId
    const text = textOfParts(payload.value.artifact?.parts ?? [])
    if (text.length > 0) state.streamedArtifactText.push(text)
  }
}

function messageTaskResult(input: StreamState, lastMessage: Message): LinkedAgentResult {
  const { state, streamedArtifactText, streamedStatusText, contextId, taskId } = input
  return Object.freeze({
    kind: 'task',
    succeeded: state === TaskState.TASK_STATE_COMPLETED,
    text: textOfMessage(lastMessage) || streamedArtifactText.join('') || streamedStatusText.at(-1) || '',
    contextId,
    taskId,
    ...(state === undefined ? {} : { state: taskStateName(state) }),
  })
}

function taskResult(input: StreamState, lastTask: Task): LinkedAgentResult {
  const { state, streamedArtifactText, streamedStatusText } = input
  const normalized = normalizeTask(lastTask)
  const streamed = streamedArtifactText.join('') || streamedStatusText.at(-1) || ''
  const effectiveState = state ?? lastTask.status?.state
  return Object.freeze({
    ...normalized,
    succeeded: effectiveState === TaskState.TASK_STATE_COMPLETED,
    text: normalized.text || streamed,
    ...(effectiveState === undefined ? {} : { state: taskStateName(effectiveState) }),
  })
}
