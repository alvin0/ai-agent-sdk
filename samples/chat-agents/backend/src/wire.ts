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

/**
 * One breadth a `session` or `workspace` grant can be given at.
 *
 * Two axes make one decision: `WireApprovalScope` is how LONG an allow lasts,
 * a rule is how WIDE it reaches. The pair is what lets "allow `git diff` for
 * this project" exist without also meaning "allow `git push`".
 */
export interface WireRule {
  /** The key the grant is stored under, e.g. `run_command:prefix:git diff`. */
  readonly key: string
  /** What it covers, in words, e.g. "every `git diff …` command". */
  readonly label: string
}

/**
 * Something about a pending call the user has to read before allowing it.
 *
 * The workspace root confines the filesystem tools, not a shell: `rm -rf ~`,
 * `del /s /q C:\` and `diskutil eraseDisk` are ordinary command lines as far
 * as `run_command` is concerned. A hazard is the card saying so in words
 * instead of leaving it as one more line of monospace.
 */
export interface WireHazard {
  readonly severity: 'critical' | 'warning'
  /** The headline, e.g. "Deletes files outside the workspace". */
  readonly title: string
  /** What was recognised, quoting the operative words of the call. */
  readonly detail: string
}

/** What the user is being asked to permit. */
export interface WireApproval {
  /** Provider tool identity for display correlation; callId is the approval request identity. */
  readonly providerCallId?: string
  /** Provider call id; the handle the decision is sent back with. */
  readonly callId: string
  readonly toolName: string
  /** Short action title, e.g. "Run command". */
  readonly title: string
  /** One line saying what will happen, e.g. the command or the target path. */
  readonly summary: string
  /**
   * The grant breadths this prompt offers, NARROWEST FIRST — `git diff *`
   * before `git *`. The first is the default; an empty list means this call
   * can only be permitted once.
   */
  readonly rules: readonly WireRule[]
  /**
   * What this call would destroy, most severe first. Empty is the ordinary
   * case and is NOT a claim of safety — only that nothing recognisable was
   * found. A prompt with any hazard offers no `rules`: it is answered once.
   */
  readonly hazards?: readonly WireHazard[]
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
  | { readonly t: 'text-end'; readonly id: string; readonly text?: string; readonly phase?: 'commentary' | 'final-answer'; readonly member?: string; readonly incomplete?: true }
  | ({ readonly t: 'reasoning-delta'; readonly id: string; readonly text: string } & WireMember)
  | ({ readonly t: 'tool-call'; readonly id: string; readonly name: string; readonly args: string } & WireMember)
  | ({
      readonly t: 'tool-result'
      readonly id: string
      readonly ok: boolean
      /** The loop refused to run this call — a spent budget, a loop guard. */
      readonly declined?: true
      /**
       * The loop shortened this result so it could not spend the context
       * window: `truncated` cut the middle out, `spilled` saved the full text
       * and left the model a locator to read it back.
       */
      readonly shortened?: 'truncated' | 'spilled'
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
      /** The rule an `allow` was remembered under; absent for `once`. */
      readonly ruleKey?: string
    }
  /**
   * Something the run did that belongs in the record — a model call retried,
   * say. Kept in the transcript because a silent recovery is how a stalled run
   * gets mistaken for a working one.
   */
  | { readonly t: 'notice'; readonly level: 'info' | 'warn'; readonly message: string; readonly member?: string }
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

/**
 * One file the user attached to a prompt, as the transcript remembers it.
 *
 * A durable record rather than the bytes: the browser drops its object URLs
 * when the tab closes, and a reloaded conversation still has to draw the
 * screenshot the question was about. `GET /api/attachments/:id` serves it.
 */
export interface WireAttachment {
  readonly id: string
  readonly name: string
  readonly mediaType: string
  readonly bytes: number
  /** `image` is model input; `file` is material the prompt describes. */
  readonly kind: 'image' | 'file'
  readonly width?: number
  readonly height?: number
}

/** One request body accepted by `POST /api/chat`. */
export interface ChatRequestBody {
  readonly sessionId: string
  readonly prompt: string
  /** Group the conversation belongs to; omitted uses the default group. */
  readonly groupId?: string
  /** Ids from `POST /api/attachments`, in the order the user picked them. */
  readonly attachmentIds?: readonly string[]
  /**
   * Skill ids the composer attached as chips, in pick order.
   *
   * A mention picked from the `/` menu leaves the message text and travels
   * here; one typed by hand is still read out of the text. Unknown ids are
   * dropped against the project's catalogue rather than trusted.
   */
  readonly skillIds?: readonly string[]
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
  /** Skill chips on the steering message; same contract as `ChatRequestBody`. */
  readonly skillIds?: readonly string[]
}

/** One request body accepted by `POST /api/approve`. */
export interface ApproveRequestBody {
  readonly sessionId: string
  /** The parked call, from the `approval` event. */
  readonly callId: string
  readonly decision: 'allow' | 'deny' | 'abort'
  /** How long an `allow` lasts; ignored for `deny` and `abort`. */
  readonly scope?: WireApprovalScope
  /**
   * Which of the prompt's `rules` an `allow` is remembered under. Ignored for
   * scope `once`; defaults to the narrowest rule the prompt offered. A key the
   * prompt did not offer is refused rather than stored.
   */
  readonly ruleKey?: string
}
