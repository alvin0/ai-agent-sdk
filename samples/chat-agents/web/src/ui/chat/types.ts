import type { ToolCard, WireQuestion } from '@chat-agents/backend'

/** One rendered row of the transcript, in arrival order. */
export type ChatNode =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'text'
      readonly id: string
      readonly text: string
      readonly phase: 'commentary' | 'final-answer' | 'unknown'
      readonly streaming: boolean
      /** Team member that produced it; absent means the agent you talk to. */
      readonly member?: string
    }
  | { readonly kind: 'reasoning'; readonly id: string; readonly text: string; readonly member?: string }
  | {
      readonly kind: 'tool'
      readonly id: string
      readonly name: string
      readonly args: string
      readonly state: 'running' | 'ok' | 'error'
      readonly output?: string
      readonly card?: ToolCard
      readonly errorMessage?: string
      readonly member?: string
    }
  | {
      readonly kind: 'question'
      readonly id: string
      readonly requestId: string
      readonly questions: readonly WireQuestion[]
      readonly answered: boolean
    }
  | { readonly kind: 'error'; readonly id: string; readonly message: string }

/** One team member's live state during a run. */
export interface MemberState {
  readonly name: string
  readonly status: 'idle' | 'running' | 'done'
  readonly toolCalls: number
}

export interface ChatState {
  readonly nodes: readonly ChatNode[]
  readonly running: boolean
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
  /** Roster for the current run; empty outside team modes. */
  readonly members: readonly MemberState[]
}
