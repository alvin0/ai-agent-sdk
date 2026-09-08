/**
 * What a tool is, what it receives, and what it produces.
 *
 * Two shape decisions worth stating up front.
 *
 * **The body returns a value, not model-facing text.** `execute` produces a
 * lossless-JSON value; `render` turns it into the blocks the model reads. Keeping
 * them apart means the value can be logged, replayed, asserted on in tests, and
 * handed to a UI, while the model-facing wording stays free to change without
 * invalidating any of that. Simple tools ignore `render` entirely and get a
 * sensible default.
 *
 * **Side channels live on the context, not in the return type.** A tool that wants
 * to end the turn or inject extra context calls `ctx.concludeTurn()` /
 * `ctx.addContext()`. That keeps the common return type trivial — a string or an
 * object — instead of forcing every tool to wrap its result in an envelope.
 *
 * @module ai-agent-sdk/agent/tool/definition
 */

import type { ToolSchema } from '../../contract/index.ts'
import type { ContentBlock } from '../../message/index.ts'
import type { ToolCallId } from '../../primitives/index.ts'
import type { JsonObject, JsonValue } from '../../primitives/index.ts'
import type { SdkLogger } from '../../logging/types.ts'
import { captureToolDefinition } from './capture.ts'

type ReadonlyToolBehavior<Args extends readonly unknown[], Result> = {
  bivarianceHack(...args: Args): Result
}['bivarianceHack']

/** Where a tool call sits in the run, for logging and diagnostics. */
export interface ToolCallPosition {
  /** 1-based turn number within the conversation. */
  readonly turn: number
  /** 1-based step number within the turn. */
  readonly step: number
}

/** What a tool body receives besides its arguments. */
export interface ToolRunContext extends ToolCallPosition {
  /** Provider-issued id of this call. */
  readonly callId: ToolCallId
  /** The tool's own name, so shared helpers can report which tool called them. */
  readonly toolName: string
  /**
   * Cancellation for this call.
   *
   * A tool that declares `timeoutMs` is ASSERTING that it forwards this signal;
   * the timeout is cooperative and cannot interrupt code that ignores it.
   */
  readonly signal: AbortSignal
  /** Always present on AgentRuntime execution paths; optional for legacy callers. */
  readonly logger?: SdkLogger

  /**
   * End the turn after this batch of tool calls commits.
   *
   * For a tool that IS the answer — submitting a final result, handing off to a
   * human. The loop still commits every call in the current batch first, so a
   * parallel sibling's work is never discarded.
   */
  concludeTurn(): void

  /**
   * Inject extra context for the next step, beyond this call's result.
   *
   * The blocks become a user message the model sees on the following request. Use
   * it for information the model needs but did not ask for — a reminder that it
   * has repeated itself, a warning that a file changed underneath it.
   */
  addContext(content: string | readonly ContentBlock[]): void
}

/**
 * How a tool call may be scheduled relative to its siblings.
 *
 * Both reference implementations default to `exclusive` and require an explicit
 * opt-in, because the failure mode of guessing wrong is silent data corruption
 * from two tools mutating the same state, not a visible error.
 */
export type ToolExecutionMode = 'parallel' | 'exclusive'

/** A tool the model can call. */
export interface ToolDefinition<Args = unknown> extends ToolSchema {
  /**
   * Validate and narrow raw arguments before {@link execute} sees them.
   *
   * The hook exists so this package needs no schema library of its own: plug in
   * zod, valibot, ajv, or hand-written checks. Throwing here produces an
   * `INVALID_ARGUMENTS` result the model can correct.
   *
   * Omitting it means `execute` receives the parsed JSON UNVALIDATED, typed as
   * `Args` on trust. That is fine for a tool whose body checks its own inputs.
   */
  readonly parse?: ReadonlyToolBehavior<[raw: unknown], Args>

  /**
   * Do the work.
   * @param args - validated arguments.
   * @param ctx - call identity, cancellation, and the side channels.
   * @returns a lossless-JSON value, or nothing.
   */
  readonly execute: ReadonlyToolBehavior<
    [args: Args, ctx: ToolRunContext],
    Promise<JsonValue | void> | JsonValue | void
  >

  /**
   * Turn the returned value into what the model reads.
   *
   * Defaults to {@link renderJsonValue}: a string is passed through verbatim,
   * anything else is pretty-printed JSON. Override to give the model prose, or to
   * return an image block.
   */
  readonly render?: ReadonlyToolBehavior<
    [value: JsonValue | undefined, args: Args],
    readonly ContentBlock[]
  >

  /**
   * Metadata for a UI, kept out of what the model sees.
   *
   * Must be lossless JSON — it is persisted with the result.
   */
  readonly meta?: ReadonlyToolBehavior<
    [value: JsonValue | undefined, args: Args],
    JsonObject | undefined
  >

  /**
   * Wall-clock bound for one call, enforced cooperatively.
   *
   * NEVER sent to the model. Declaring it is a promise that {@link execute}
   * forwards `ctx.signal`, because the pipeline aborts the signal and waits — it
   * does not abandon the promise, since an orphaned tool would keep mutating state
   * behind the loop's back.
   */
  readonly timeoutMs?: number

  /**
   * Whether this call may run alongside its siblings.
   *
   * Fail-closed: only an exact `true` opts in. A throwing or absent classifier
   * means `exclusive`. Return `true` only when the call cannot observe or mutate
   * state another concurrent call touches — a pure read of an immutable source
   * qualifies, "probably fine" does not.
   */
  readonly isConcurrencySafe?: ReadonlyToolBehavior<[args: Args], boolean>

  /**
   * Exempt this tool from the turn's tool-call budget and its loop guards.
   *
   * For the calls that END work rather than do it: submitting a final result,
   * asking the user a blocking question, handing a task to another agent. A
   * budget exists to stop exploration, and a spent budget that also blocks the
   * only remaining useful action leaves the model with no legal move — the run
   * then dies mid-plan instead of finishing. Both reference harnesses avoid
   * that by never failing a call for a limit at all; this flag is the narrow
   * version of the same rule.
   *
   * Exempt calls still count toward the RUN-level ledger limits, so this
   * cannot be used to escape accounting — only to reach a terminal action.
   */
  readonly budgetExempt?: true

  /**
   * Progress/reporting only: calling this tool does not invalidate an accepted
   * deep-mode completion submission. Examples include updating a visible todo
   * list after the work has been verified. Never set this for tools that edit
   * work, obtain new evidence, delegate, or change the user's requirements.
   * This is independent of budgetExempt and is never sent to the model.
   */
  readonly completionExempt?: true

  /**
   * Estimated tokens of text this tool's result may put in front of the model.
   *
   * For a tool that knows its own shape: a file reader can ask for room a
   * one-line status check has no use for. The turn's budget still applies, and
   * the STRICTER of the two wins — Codex resolves a model-requested
   * `max_output_tokens` against its deployment policy the same way — so this
   * can lower a tool's share but never raise it past what the host allows.
   *
   * Never sent to the model.
   */
  readonly maxOutputTokens?: number
}

/** A tool call that succeeded. */
export interface ToolSuccess {
  readonly isError: false
  /** The raw value the body returned; omitted when post-policy replaces the result. */
  readonly value: JsonValue | undefined
  /** What the model reads. */
  readonly content: readonly ContentBlock[]
  /** UI metadata, never shown to the model. */
  readonly meta?: JsonObject
  /** Extra context requested via `ctx.addContext`. */
  readonly additionalContext?: readonly ContentBlock[]
  /** Set when the tool called `ctx.concludeTurn()`. */
  readonly concludesTurn?: true
}

/** A tool call that failed. */
export interface ToolFailure {
  readonly isError: true
  readonly error: {
    readonly message: string
    readonly code: string
  }
  /** What the model reads — the failure, phrased for the model. */
  readonly content: readonly ContentBlock[]
  readonly meta?: JsonObject
  readonly additionalContext?: readonly ContentBlock[]
  /**
   * Typed `never`: a failure must not be able to end the turn.
   *
   * Otherwise a denied or crashed tool could silently stop work the user asked
   * for, which is the opposite of what a failure should do.
   */
  readonly concludesTurn?: never
}

/** The outcome of one tool call. */
export type ToolExecutionResult = ToolSuccess | ToolFailure

/**
 * The default {@link ToolDefinition.render}.
 *
 * A string is passed through as-is, because a tool that returns prose meant it.
 * Everything else is indented JSON, which models parse reliably and humans can
 * read in a transcript.
 * @param value - the value the body returned.
 * @returns model-facing blocks.
 */
export function renderJsonValue(value: JsonValue | undefined): readonly ContentBlock[] {
  if (value === undefined) return [{ type: 'text', text: '(no output)' }]
  if (typeof value === 'string') {
    return [{ type: 'text', text: value.length === 0 ? '(empty)' : value }]
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Author a tool with argument types inferred from `parse`.
 *
 * Returns a detached frozen execution view. Schema and method references are
 * captured once while method calls retain the caller object's receiver.
 *
 * ```ts
 * const getWeather = defineTool({
 *   name: 'get_weather',
 *   description: 'Current weather for a city.',
 *   parameters: {
 *     type: 'object',
 *     properties: { city: { type: 'string' } },
 *     required: ['city'],
 *   },
 *   parse: raw => WeatherArgs.parse(raw),
 *   execute: async ({ city }) => ({ tempC: await lookup(city) }),
 * })
 * ```
 * @param definition - the tool.
 * @returns a new immutable definition, typed.
 */
export function defineTool<Args>(definition: ToolDefinition<Args>): ToolDefinition<Args> {
  return captureToolDefinition(definition)
}

/**
 * Decide how one call may be scheduled.
 *
 * Fail-closed on every uncertainty, including a classifier that throws: a tool
 * whose safety check is broken is not a tool whose safety can be assumed.
 * @param tool - the definition, or `undefined` for an unknown tool.
 * @param args - the parsed arguments.
 * @returns the scheduling mode.
 */
export function executionModeOf(
  tool: ToolDefinition | undefined,
  args: unknown,
): ToolExecutionMode {
  if (tool?.isConcurrencySafe === undefined) return 'exclusive'
  try {
    return tool.isConcurrencySafe(args) === true ? 'parallel' : 'exclusive'
  } catch {
    return 'exclusive'
  }
}
