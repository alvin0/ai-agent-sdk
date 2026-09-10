/** The transcript shapes the view renders. */

/** Browser wall-clock stamp used by the collapsed Process duration. */
type Timed<T> = T extends unknown ? T & { readonly at?: number } : never

export type ChatNode = Timed<
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | {
    readonly kind: 'assistant'
    readonly id: string
    readonly text: string
    readonly live: boolean
    /** Provider block identity; absent only on legacy cached rows. */
    readonly blockId?: string
    /** Who produced it; absent in a single-agent run. */
    readonly member?: string
  }
  | {
    readonly kind: 'reasoning'
    readonly id: string
    readonly text: string
    readonly blockId?: string
    readonly member?: string
  }
  | {
    readonly kind: 'tool'
    readonly id: string
    readonly name: string
    readonly input: unknown
    readonly status: 'running' | 'completed' | 'failed'
    readonly family: 'host' | 'provider-native'
    readonly member?: string
  }
  /** A peer started or finished, drawn as a rule across the transcript. */
  | {
    readonly kind: 'member-mark'
    readonly id: string
    readonly member: string
    readonly phase: 'start' | 'end'
    readonly failed?: true
  }
  | {
    readonly kind: 'error'
    readonly id: string
    readonly message: string
    /** Codes and status, shown under the message for someone diagnosing it. */
    readonly detail?: string
  }
>

/** One conversation as the sidebar lists it. */
export interface ConversationRow {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
}

/** One team member, as the roster strip draws it. */
export interface MemberState {
  readonly name: string
  readonly status: 'idle' | 'running' | 'done' | 'failed'
  readonly toolCalls: number
  readonly role?: 'lead' | 'peer'
  /** The member's own model, when it differs from the run's. */
  readonly model?: string
}
