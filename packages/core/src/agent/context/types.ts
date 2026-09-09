/**
 * Turn-scoped model-visible context sections.
 *
 * A section owns at most one live node on the model surface and is recomputed
 * before every model round. Unchanged sections cost nothing: the loop compares
 * the returned {@link ContextSectionState.revision} against the live node and
 * writes only on a difference. A changed section *replaces* its own node rather
 * than appending beside it, so the model never reads two versions of the same
 * context at once.
 *
 * Nothing here touches a filesystem, a clock, or a network. A section is a
 * pure recompute callback; where its content comes from is the host's concern.
 *
 * @module ai-agent-sdk/core/agent/context/types
 */

/** What one context section currently wants the model to read. */
export interface ContextSectionState {
  /**
   * Change key for this content.
   *
   * Equal to the live node's revision means no rewrite and no token cost. Any
   * other value replaces the live node. A content digest is the usual choice;
   * a monotonic counter works when the producer already tracks versions.
   */
  readonly revision: string
  /** Exact model-facing text. The loop never trims, wraps, or rewrites it. */
  readonly text: string
}

/** One tool call committed since the previous resolve. */
export interface ContextToolTouch {
  readonly toolName: string
  /** Verbatim provider arguments; a section parses only what it recognizes. */
  readonly rawArguments: string
  /** Whether the call ended in a tool failure. */
  readonly failed: boolean
}

export interface ContextSectionResolveInput {
  readonly signal: AbortSignal
  /** 0 before the first model round of the turn, then one per completed step. */
  readonly step: number
  /** Tool calls committed since the previous resolve, in model order. */
  readonly touches: readonly ContextToolTouch[]
  /** The state currently on the model surface, when this section has one. */
  readonly current: ContextSectionState | undefined
  /**
   * Who is asking, so a section instance shared by several agents can keep its
   * state apart.
   *
   * One section object is routinely mounted on a definition that many sessions
   * instantiate — every member of a team, every worker cloned from a lead — and
   * those sessions run concurrently. A section that accumulates anything across
   * steps must key that state by this scope, or one agent's discoveries leak
   * into another's context. Both fields are absent for a bare `runTurn` that
   * was given no trace identity.
   */
  readonly scope: ContextSectionScope
}

/** Stable identity of the conversation a resolve belongs to. */
export interface ContextSectionScope {
  readonly agentId: string | undefined
  readonly conversationId: string | undefined
}

/**
 * A recomputed block of model-visible context.
 *
 * ```ts
 * const clock = defineContextSection({
 *   id: 'wall-clock',
 *   resolve() {
 *     const text = `Current time: ${new Date().toISOString()}`
 *     return { revision: text, text }
 *   },
 * })
 * ```
 */
export interface ContextSection {
  /** Kebab-case identity, unique within one turn. */
  readonly id: string
  /**
   * Recompute this section.
   *
   * Return the same revision to leave the surface untouched, a new state to
   * replace it, or `undefined` to retract the section entirely.
   */
  resolve(input: ContextSectionResolveInput):
  | ContextSectionState | undefined | Promise<ContextSectionState | undefined>
  /**
   * Replaces the live node when a section that had one retracts.
   *
   * The loop cannot delete a surface node, so a retraction becomes a short
   * message saying the earlier text no longer applies. Defaults to a generic
   * line naming the section id.
   */
  readonly retractionText?: string
}
