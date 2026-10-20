/**
 * The tool error taxonomy, and the single most important decision in the whole
 * tool layer: **a tool failure is normally INPUT FOR THE MODEL, not an exception
 * that ends the turn.**
 *
 * Both reference implementations converged on this independently. Codex spells it
 * as a two-variant enum (`FunctionCallError::{RespondToModel, Fatal}`) and
 * deepseek-harness spells it as a registry that normalizes any throw into an
 * `isError: true` result. The reasoning is the same: a model that asked for a
 * file that does not exist, or passed a malformed argument, has made a mistake it
 * can recover from — if it is told. Aborting the turn throws away everything the
 * model has already accomplished and gives the user nothing.
 *
 * So a thrown tool error becomes a tool result by default. `fatal` is the narrow
 * exception, reserved for a violated contract that the model cannot fix by trying
 * something else.
 *
 * @module ai-agent-sdk/agent/tool/errors
 */

import { AgentSdkError } from '../../errors/index.ts'
import type { ToolExecutionResult } from './definition.ts'

export interface ToolErrorModelInput {
  readonly code: string
  readonly message: string
}

/** `false` preserves legacy error text; a callback can render a custom neutral message. */
export type ToolErrorRendering = false | ((error: ToolErrorModelInput) => string)

/** What the loop should do with a tool failure. */
export type ToolErrorDisposition =
  /** Feed the message back as the tool's result and let the model try again. */
  | 'respond-to-model'
  /** End the turn. A contract violation the model cannot recover from. */
  | 'fatal'

/** Codes the tool layer itself produces. */
export const TOOL_ERROR_CODES = Object.freeze({
  /** The model named a tool that is not registered or not visible to it. */
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  /** Arguments failed the tool's own validation. */
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  /** The model emitted arguments that are not valid JSON. */
  MALFORMED_ARGUMENTS: 'MALFORMED_ARGUMENTS',
  /** The tool exceeded its declared `timeoutMs`. */
  TIMEOUT: 'TOOL_TIMEOUT',
  /** Cancelled after the tool body started. */
  ABORTED: 'TOOL_ABORTED',
  /** Cancelled before the tool body was entered. */
  ABORTED_BEFORE_DISPATCH: 'TOOL_ABORTED_BEFORE_DISPATCH',
  /** An interceptor refused the call. */
  DENIED: 'TOOL_DENIED',
  /** The tool returned a value that is not losslessly JSON. */
  INVALID_RESULT: 'INVALID_TOOL_RESULT',
  /** The tool threw something that carried no useful classification. */
  FAILED: 'TOOL_FAILED',
  /** The turn had no remaining tool-call allowance. */
  BUDGET_EXHAUSTED: 'TOOL_BUDGET_EXHAUSTED',
  /** Caller-owned durability failed before the tool side effect. */
  CHECKPOINT_FAILED: 'CHECKPOINT_FAILED',
  /** In-process tool/interceptor ignored cancellation beyond the teardown budget. */
  TEARDOWN_TIMEOUT: 'TOOL_TEARDOWN_TIMEOUT',
} as const)

/**
 * A tool failure, carrying its disposition.
 *
 * Construct through {@link ToolError.respondToModel} or {@link ToolError.fatal}
 * rather than the constructor, so the disposition is always a deliberate choice
 * at the throw site instead of a default nobody looked at.
 */
export class ToolError extends AgentSdkError {
  /** Whether this ends the turn or becomes the tool's result. */
  readonly disposition: ToolErrorDisposition

  constructor(
    message: string,
    disposition: ToolErrorDisposition,
    code: string = TOOL_ERROR_CODES.FAILED,
    options?: ErrorOptions,
  ) {
    super(message, code, options)
    this.name = 'ToolError'
    this.disposition = disposition
  }

  /**
   * The normal case: report the failure to the model and continue the turn.
   *
   * Write the message FOR THE MODEL. It is the only thing the model will see, so
   * "file not found: /tmp/x.txt" is useful and "ENOENT" is not.
   * @param message - model-facing explanation of what went wrong.
   * @param code - stable code for routing and metrics.
   * @param options - optional cause.
   */
  static respondToModel(
    message: string,
    code: string = TOOL_ERROR_CODES.FAILED,
    options?: ErrorOptions,
  ): ToolError {
    return new ToolError(message, 'respond-to-model', code, options)
  }

  /**
   * The rare case: end the turn.
   *
   * Reserve this for a broken contract — a tool registered with the wrong shape,
   * a host invariant violated — where letting the model retry would just produce
   * the same failure with more tokens spent.
   * @param message - operator-facing explanation.
   * @param code - stable code for routing.
   * @param options - optional cause.
   */
  static fatal(
    message: string,
    code: string = TOOL_ERROR_CODES.FAILED,
    options?: ErrorOptions,
  ): ToolError {
    return new ToolError(message, 'fatal', code, options)
  }
}

/**
 * Read the disposition of an arbitrary thrown value.
 *
 * Anything that is not an explicitly fatal {@link ToolError} is treated as
 * `respond-to-model`. That default is the point: an ordinary `TypeError` from
 * inside a tool body should reach the model as a failed tool result, not kill the
 * user's turn.
 * @param value - the caught value.
 * @returns the disposition to apply.
 */
export function toolErrorDisposition(value: unknown): ToolErrorDisposition {
  return value instanceof ToolError && value.disposition === 'fatal'
    ? 'fatal'
    : 'respond-to-model'
}

/**
 * Render only the stable code and safe message into model-visible tool content.
 *
 * Only the default `Error: <message>` content is rewritten. Content a tool or
 * interceptor wrote for the model (block feedback, replacements, images) is
 * passed through as written.
 */
export function renderToolError(
  result: ToolExecutionResult,
  rendering: ToolErrorRendering | undefined,
): ToolExecutionResult {
  if (!result.isError || rendering === false || !hasDefaultErrorContent(result)) return result
  const view = Object.freeze({ code: result.error.code, message: result.error.message })
  let message: string
  try {
    message = rendering === undefined ? `[${view.code}] ${view.message}` : rendering(view)
  } catch {
    message = `[${view.code}] ${view.message}`
  }
  if (typeof message !== 'string') message = `[${view.code}] ${view.message}`
  return { ...result, content: [{ type: 'text', text: message }] }
}

function hasDefaultErrorContent(result: Extract<ToolExecutionResult, { readonly isError: true }>): boolean {
  const [block, ...rest] = result.content
  return rest.length === 0 && block?.type === 'text' && block.text === `Error: ${result.error.message}`
}

/** Validate a `toolErrorRendering` option at a configuration boundary. */
export function resolveToolErrorRendering(value: unknown): ToolErrorRendering | undefined {
  if (value !== undefined && value !== false && typeof value !== 'function') {
    throw new TypeError('toolErrorRendering must be false or a function')
  }
  return value as ToolErrorRendering | undefined
}
