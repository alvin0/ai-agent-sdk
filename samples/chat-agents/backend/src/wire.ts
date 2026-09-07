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
  /** A filesystem change with no useful line-level preview. */
  | {
      readonly kind: 'fs'
      readonly action: 'created' | 'updated' | 'deleted' | 'moved'
      readonly path: string
      readonly detail?: string
    }

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

/**
 * How far a permission decision reaches.
 *
 * `once` answers this call only, `session` every later call of the same kind in
 * the open conversation, and `workspace` every call of that kind in the
 * project's directory — remembered in SQLite across restarts.
 */
export type WireApprovalScope = 'once' | 'session' | 'workspace'

/** What the user is being asked to permit. */
export interface WireApproval {
  /** Provider call id; the handle the decision is sent back with. */
  readonly callId: string
  readonly toolName: string
  /** Short action title, e.g. "Run command". */
  readonly title: string
  /** One line saying what will happen, e.g. the command or the target path. */
  readonly summary: string
  /** What a session/workspace grant would cover, e.g. `run_command:git`. */
  readonly ruleKey: string
  /** That coverage in words, e.g. "every `git` command". */
  readonly ruleLabel: string
  /** Preview of the pending change: the diff, the command, or the path. */
  readonly card?: ToolCard
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
  /** A tool call is parked until the user permits it. */
  | ({ readonly t: 'approval' } & WireApproval & WireMember)
  | {
      readonly t: 'approval-resolved'
      readonly callId: string
      readonly decision: 'allow' | 'deny' | 'abort'
      readonly scope: WireApprovalScope
    }
  /**
   * Something the run did that belongs in the record — a model call retried,
   * say. Kept in the transcript because a silent recovery is how a stalled run
   * gets mistaken for a working one.
   */
  | { readonly t: 'notice'; readonly level: 'info' | 'warn'; readonly message: string }
  /**
   * Output from a tool call that has NOT finished yet.
   *
   * A tool result arrives once, when the tool returns, so everything a long
   * command prints before that would be invisible until it exits. Not a
   * transcript node: the settled `tool-result` carries the whole output, and
   * keeping both would store it twice.
   */
  | { readonly t: 'tool-output'; readonly id: string; readonly chunk: string }
  /**
   * What a quiet run is currently waiting on; `null` clears it.
   *
   * Deliberately NOT a transcript node: it is a live status line, true only
   * while it is on screen, and a log of "still installing (40s)" lines would be
   * noise the moment the run moved on.
   */
  | { readonly t: 'progress'; readonly message: string | null }
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

/**
 * One request body accepted by `POST /api/steer`.
 *
 * Steering is not a new prompt: it joins the run already in flight, so the
 * agent reads it on its next model round instead of after it finishes.
 */
export interface SteerRequestBody {
  readonly sessionId: string
  readonly prompt: string
}

/** One request body accepted by `POST /api/approve`. */
export interface ApproveRequestBody {
  readonly sessionId: string
  /** The parked call, from the `approval` event. */
  readonly callId: string
  readonly decision: 'allow' | 'deny' | 'abort'
  /** How far an `allow` reaches; ignored for `deny` and `abort`. */
  readonly scope?: WireApprovalScope
}
