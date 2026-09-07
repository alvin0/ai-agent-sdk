/**
 * The UI wire protocol: the only contract the Next.js frontend knows about.
 *
 * The frontend never imports the SDK event union directly — the backend
 * projects `runAgent` events into these display-shaped records, so tool cards,
 * question cards, and markdown streams stay stable when the SDK loop changes.
 */

/** A tool result rendered as a rich card instead of raw JSON. */
export type ToolCard =
  | { readonly kind: 'terminal'; readonly command: string; readonly output: string; readonly exitCode?: number }
  | { readonly kind: 'read'; readonly path: string; readonly firstLine: number; readonly lines: readonly string[]; readonly truncated: boolean }
  | { readonly kind: 'diff'; readonly path: string; readonly lines: readonly DiffLine[] }
  | { readonly kind: 'search'; readonly query: string; readonly matches: readonly SearchMatch[] }
  | { readonly kind: 'web'; readonly url: string; readonly title: string; readonly snippet: string }
  | { readonly kind: 'todo'; readonly items: readonly TodoItem[] }

export interface DiffLine {
  readonly kind: 'add' | 'del' | 'ctx' | 'meta'
  readonly text: string
}
export interface SearchMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}
export interface TodoItem {
  readonly text: string
  readonly status: 'pending' | 'active' | 'done'
}

/** One suggested answer on a blocking question. */
export interface WireQuestionOption {
  readonly label: string
  readonly description: string
}
export interface WireQuestion {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly options: readonly WireQuestionOption[]
}

/** Which agent produced an event; absent means the agent the user talks to. */
export interface WireMember {
  readonly member?: string
}

export type WireEvent =
  | { readonly t: 'run-start'; readonly runId: string; readonly members: readonly string[] }
  /** A team member started or finished a delegated run. */
  | { readonly t: 'member-start'; readonly member: string }
  | { readonly t: 'member-end'; readonly member: string }
  /** Assistant markdown, streamed. `phase` separates progress narration from the answer. */
  | ({ readonly t: 'text-delta'; readonly id: string; readonly text: string; readonly phase: 'commentary' | 'final-answer' | 'unknown' } & WireMember)
  | { readonly t: 'text-end'; readonly id: string }
  | ({ readonly t: 'reasoning-delta'; readonly id: string; readonly text: string } & WireMember)
  | ({ readonly t: 'tool-call'; readonly id: string; readonly name: string; readonly args: string } & WireMember)
  | ({
      readonly t: 'tool-result'
      readonly id: string
      readonly ok: boolean
      readonly output: string
      readonly card?: ToolCard
      readonly errorMessage?: string
    } & WireMember)
  | { readonly t: 'question'; readonly requestId: string; readonly questions: readonly WireQuestion[] }
  | { readonly t: 'question-answered'; readonly requestId: string }
  | { readonly t: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly t: 'run-end'; readonly reason: string; readonly text: string }
  | { readonly t: 'error'; readonly message: string }

/** One request body accepted by `POST /api/chat`. */
export interface ChatRequestBody {
  readonly sessionId: string
  readonly prompt: string
  /** Group the conversation belongs to; omitted uses the default group. */
  readonly groupId?: string
}

/** One request body accepted by `POST /api/answer`. */
export interface AnswerRequestBody {
  readonly sessionId: string
  readonly requestId: string
  /** Answers keyed by question id; each value is a selected label or free-form text. */
  readonly answers: Readonly<Record<string, string>>
}
