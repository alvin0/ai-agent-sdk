import { partsToContent } from './content.ts'
import { TaskState } from '@a2a-js/sdk'
import { AgentEvent, type RequestContext, type ExecutionEventBus } from '@a2a-js/sdk/server'
import { createUserMessage } from '@alvin0/ai-agent-sdk-core'
import type { AgentSession } from '@alvin0/ai-agent-sdk-core/agent'
import { abortable, utf8Bytes, agentMessage, status } from './support.ts'

export async function runSession(execution: {
  context: RequestContext; eventBus: ExecutionEventBus; session: AgentSession; taskSignal: AbortSignal
}, options: { maxOutputBytes: number; agentName: string }): Promise<void> {
  const { context, eventBus, session, taskSignal } = execution

  const input = createUserMessage({
    content: partsToContent(context.userMessage.parts),
    source: {
      kind: 'a2a-message',
      contextId: context.contextId,
      messageId: context.userMessage.messageId,
      taskId: context.taskId,
    },
  })
  const response = await abortable(session.run(input, { signal: taskSignal }), taskSignal)
  taskSignal.throwIfAborted()
  if (!response.outcome.completed) {
    const reason = response.outcome.reason
    const detail = reason.kind === 'error'
      ? reason.failure.message
      : `agent run ended with ${reason.kind}`
    throw new Error(detail)
  }
  if (utf8Bytes(response.text) > options.maxOutputBytes) {
    throw new Error(`A2A response exceeds the ${options.maxOutputBytes}-byte limit`)
  }

  const reply = agentMessage(context, response.text)
  eventBus.publish(AgentEvent.artifactUpdate({
    taskId: context.taskId,
    contextId: context.contextId,
    artifact: {
      artifactId: crypto.randomUUID(),
      name: `${options.agentName} result`,
      description: `Final result produced by ${options.agentName}`,
      parts: [{
        content: { $case: 'text', value: response.text },
        mediaType: 'text/plain',
        filename: '',
        metadata: undefined,
      }],
      metadata: undefined,
      extensions: [],
    },
    append: false,
    lastChunk: true,
    metadata: undefined,
  }))
  eventBus.publish(AgentEvent.statusUpdate({
    taskId: context.taskId,
    contextId: context.contextId,
    status: status(TaskState.TASK_STATE_COMPLETED, reply),
    metadata: undefined,
  }))
  }
