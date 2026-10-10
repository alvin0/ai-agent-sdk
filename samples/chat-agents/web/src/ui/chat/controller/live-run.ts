import type { WireAttachment } from '@chat-agents/backend'
import type { ChatState } from '../types'
import type { LiveRun } from './run-types'

export function createRun(input: {
  state: ChatState
  prompt: string
  attachments: readonly WireAttachment[]
  skillIds: readonly string[]
}): LiveRun {
  const { state, prompt, attachments, skillIds } = input
  const controller = new AbortController()
  const run: LiveRun = {
    controller,
    nodes: [...state.nodes, {
        kind: 'user',
        id: `u_${String(Date.now())}`,
        text: prompt,
        at: Date.now(),
        ...attachments.length === 0 ? {} : { attachments },
        ...skillIds.length === 0 ? {} : { skills: skillIds },
      }],
    members: [],
    spans: [],
    runId: '',
    usage: state.usage,
    progress: null,
  }
  return run
}

export function reportRunError(run: LiveRun, error: unknown, show: () => void): void {
  if (!(error instanceof DOMException && error.name === 'AbortError')) {
    const message = error instanceof Error ? error.message : String(error)
    run.nodes = [...run.nodes, {
        kind: 'error',
        id: `e_${String(Date.now())}`,
        message,
        at: Date.now(),
      }]
    show()
  }
}
