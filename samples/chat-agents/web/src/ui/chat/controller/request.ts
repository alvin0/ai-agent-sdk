import type { WireAttachment } from '@chat-agents/backend'

export function requestRun(input: {
  sessionId: string
  prompt: string
  groupId: string
  attachments: readonly WireAttachment[]
  skillIds: readonly string[]
  signal: AbortSignal
}): Promise<Response> {
  const { sessionId: id, prompt, groupId, attachments, skillIds, signal } = input
  return fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: id,
      prompt,
      groupId,
      ...attachments.length === 0 ? {} : { attachmentIds: attachments.map(item => item.id) },
      ...skillIds.length === 0 ? {} : { skillIds },
    }),
    signal,
  })
}
