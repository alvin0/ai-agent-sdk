import type { ToolCard, WireApproval, WireApprovalScope, WireQuestion } from '@chat-agents/backend'

/**
 * Wall-clock stamp every row carries.
 *
 * The transcript is the only record of when a turn's work happened, so the
 * collapsed summary reads its duration from these. Optional because a
 * transcript stored before this existed replays without one.
 */
type Timed<T> = T extends unknown ? T & { readonly at?: number } : never

/** One rendered row of the transcript, in arrival order. */
export type ChatNode = Timed<
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'assignment'; readonly id: string; readonly text: string; readonly member: string; readonly from: string; readonly followup: boolean }
  | {
      readonly kind: 'text'
      readonly id: string
      readonly text: string
      readonly phase: 'commentary' | 'final-answer' | 'unknown'
      readonly streaming: boolean
      readonly incomplete?: true
      /** Team member that produced it; absent means the agent you talk to. */
      readonly member?: string
    }
  | { readonly kind: 'reasoning'; readonly id: string; readonly text: string; readonly member?: string }
  | {
      readonly kind: 'tool'
      readonly id: string
      readonly name: string
      readonly args: string
      readonly state: 'running' | 'ok' | 'error' | 'declined'
      /** The loop shortened the result so it could not spend the context window. */
      readonly shortened?: 'truncated' | 'spilled'
      readonly output?: string
      /**
       * Output streamed while the call is still running.
       *
       * Separate from `output`, which is the settled result: this exists only
       * between the call and its result, and is what makes a two-minute
       * command something you can watch instead of wait for.
       */
      readonly liveOutput?: string
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
  /**
   * A tool call waiting for permission, and afterwards the record of what was
   * decided. `decision` absent means the call is still parked.
   */
  | (WireApproval & {
      readonly kind: 'approval'
      readonly id: string
      readonly decision?: 'allow' | 'deny' | 'abort'
      readonly scope?: WireApprovalScope
      readonly member?: string
    })
  /** A retry or other in-flight notice; not output, not a failure. */
  | {
      readonly kind: 'notice'
      readonly id: string
      readonly level: 'info' | 'warn'
      readonly message: string
      readonly member?: string
    }
  | { readonly kind: 'error'; readonly id: string; readonly message: string }
>

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
  /** What a quiet run is waiting on, or null when it is producing. */
  readonly progress: string | null
  /** Roster for the current run; empty outside team modes. */
  readonly members: readonly MemberState[]
}
