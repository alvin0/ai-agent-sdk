import type { WireSpan } from '@chat-agents/backend'
import type { ChatNode, MemberState } from '../types'

export interface LiveRun {
  readonly controller: AbortController
  nodes: readonly ChatNode[]
  members: readonly MemberState[]
  spans: readonly WireSpan[]
  /** The server's id for this run, once its first event has arrived. */
  runId: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
  progress: string | null
}
