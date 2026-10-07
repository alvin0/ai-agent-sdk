/** Staged tool dispatch: prepare/authorize/dispatch/finalize. */
import type { ContentBlock } from '../../message/index.ts'
import type { ToolCallId } from '../../primitives/index.ts'
import { type JsonObject } from '../../primitives/index.ts'
import { waitForSettlement } from '../../async/index.ts'
import { type ApprovalBroker, type ApprovalRequest } from './approval.ts'
import {
  executionModeOf, type ToolCallPosition, type ToolDefinition,
  type ToolExecutionMode, type ToolExecutionResult, type ToolFailure,
} from './definition.ts'
import { TOOL_ERROR_CODES, ToolError } from './errors.ts'
import type { ToolCatalog } from './registry.ts'
import { executeToolBody } from './pipeline-execution.ts'
import { approveToolCall } from './pipeline-authorization.ts'
import {
  chain, messageOf, parseRawArguments, positiveSafeInteger, raceWithSignal, toolFailure, withTimeout,
} from './pipeline-support.ts'
export { toolFailure } from './pipeline-support.ts'
import type { SdkLogger } from '../../logging/types.ts'

export interface ToolCallRequest {
  readonly callId: ToolCallId
  readonly toolName: string
  readonly rawArguments: string
}
export interface ToolCallContext extends ToolCallPosition {
  readonly callId: ToolCallId
  /**
   * Set only when a program tool made this call: the outer call's ID. Lets a
   * policy or durable journal scope decisions and operation IDs to programs.
   */
  readonly parentCallId?: ToolCallId
  readonly toolName: string
  readonly tool: ToolDefinition | undefined
  readonly rawArguments: string
  readonly args: unknown
  readonly signal: AbortSignal
  readonly logger?: SdkLogger
}
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }
export type PostToolDecision =
  | { kind: 'accept' }
  | { kind: 'replace'; content: readonly ContentBlock[]; meta?: JsonObject }
  | { kind: 'block'; feedback: readonly ContentBlock[]; code?: string }
export interface ToolInterceptor {
  readonly name: string
  readonly before?: (call: ToolCallContext, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
  readonly around?: (call: ToolCallContext, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>
  readonly after?: (
    call: ToolCallContext,
    result: ToolExecutionResult,
    next: () => Promise<PostToolDecision>,
  ) => Promise<PostToolDecision>
}
export interface DispatchToolCallOptions {
  readonly catalog: ToolCatalog
  readonly call: ToolCallRequest
  readonly position: ToolCallPosition
  readonly signal: AbortSignal
  readonly logger?: SdkLogger
  readonly interceptors?: readonly ToolInterceptor[]
  readonly approvals?: ApprovalBroker
  /** Maximum wait after a timed-out in-process tool ignores cancellation. */
  readonly teardownTimeoutMs?: number
  /** Timeout used when the tool definition does not declare one. */
  readonly defaultTimeoutMs?: number
  /** Called immediately before an approval broker is awaited. */
  readonly onApprovalRequest?: (request: ApprovalRequest) => Promise<void> | void
  /** Called exactly once after an approval wait settles or fails. */
  readonly onApprovalSettled?: (status: 'success' | 'error' | 'aborted', error?: unknown) => void
  /** The outer program call, when this call is a program's child. */
  readonly parentCallId?: ToolCallId
}
export interface PreparedToolCall {
  readonly options: DispatchToolCallOptions
  readonly context: ToolCallContext
  readonly argumentFailure?: ToolFailure
  readonly mode: ToolExecutionMode
}
export interface AuthorizedToolCall extends PreparedToolCall { readonly tool: ToolDefinition }
export type AuthorizationOutcome =
  | { readonly kind: 'authorized'; readonly call: AuthorizedToolCall }
  | { readonly kind: 'final'; readonly result: ToolExecutionResult }

/** Resolve, parse exactly once, validate and classify one call. */
export function prepareToolCall(options: DispatchToolCallOptions): PreparedToolCall {
  const { catalog, call, position, signal } = options
  const tool = catalog.get(call.toolName)
  let args: unknown
  let argumentFailure: ToolFailure | undefined
  if (tool === undefined) {
    argumentFailure = toolFailure(`no tool named "${call.toolName}" is available`, TOOL_ERROR_CODES.UNKNOWN_TOOL)
  } else {
    const parsed = parseRawArguments(call.rawArguments)
    if (!parsed.ok) argumentFailure = toolFailure(parsed.message, TOOL_ERROR_CODES.MALFORMED_ARGUMENTS)
    else if (tool.parse === undefined) args = parsed.value
    else {
      try { args = tool.parse(parsed.value) }
      catch (error: unknown) {
        argumentFailure = toolFailure(`invalid arguments: ${messageOf(error)}`, TOOL_ERROR_CODES.INVALID_ARGUMENTS)
      }
    }
  }
  const context: ToolCallContext = {
    ...position, callId: call.callId, toolName: call.toolName, tool,
    rawArguments: call.rawArguments, args, signal,
    ...(options.parentCallId === undefined ? {} : { parentCallId: options.parentCallId }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  }
  return {
    options, context,
    ...argumentFailure === undefined ? {} : { argumentFailure },
    mode: argumentFailure === undefined ? executionModeOf(tool, args) : 'exclusive',
  }
}

/** Ordered pre-policy and approval stage. */
export async function authorizeToolCall(prepared: PreparedToolCall): Promise<AuthorizationOutcome> {
  if (prepared.argumentFailure !== undefined) return { kind: 'final', result: prepared.argumentFailure }
  const interceptors = prepared.options.interceptors ?? []
  const decision = await chain<PreToolDecision>(
    interceptors,
    interceptor => interceptor.before?.bind(interceptor, prepared.context),
    () => Promise.resolve({ kind: 'allow' } as const),
  )()
  if (decision.kind === 'deny') return { kind: 'final', result: toolFailure(decision.reason, TOOL_ERROR_CODES.DENIED) }
  if (decision.kind === 'ask') {
    const final = await approveToolCall(prepared, decision)
    if (final !== undefined) return final
  }
  const tool = prepared.context.tool
  if (tool === undefined) return { kind: 'final', result: toolFailure(
    `no tool named "${prepared.context.toolName}" is available`, TOOL_ERROR_CODES.UNKNOWN_TOOL,
  ) }
  return { kind: 'authorized', call: { ...prepared, tool } }
}

/** Body/around stage; this is the only stage the scheduler overlaps. */
export async function dispatchAuthorizedToolCall(call: AuthorizedToolCall): Promise<ToolExecutionResult> {
  const { context, tool } = call
  if (context.signal.aborted) return toolFailure(
    'the call was cancelled before it started', TOOL_ERROR_CODES.ABORTED_BEFORE_DISPATCH,
  )
  const body = (signal: AbortSignal) => executeToolBody(call, signal)
  const executed = await chain<ToolExecutionResult>(
    call.options.interceptors ?? [],
    interceptor => interceptor.around?.bind(interceptor, context),
    () => withTimeout(
      tool.timeoutMs ?? call.options.defaultTimeoutMs,
      context.signal,
      body,
      call.options.teardownTimeoutMs ?? 30_000,
    ),
  )()
  if (!executed.isError || executed.meta !== undefined || tool.meta === undefined) return executed
  // Provenance and UI metadata are just as important for a failed call as for a
  // successful one. In particular, remote bridges use this to identify which
  // integration produced the error. Metadata is a side channel, so a buggy
  // metadata callback must never replace the original tool failure.
  try {
    const meta = tool.meta(undefined, context.args as never)
    return meta === undefined ? executed : { ...executed, meta }
  } catch {
    return executed
  }
}

/** Ordered post-policy stage. */
export async function finalizeToolCall(call: AuthorizedToolCall,
  executed: ToolExecutionResult): Promise<ToolExecutionResult> {
  const verdict = await chain<PostToolDecision>(
    call.options.interceptors ?? [],
    interceptor => interceptor.after?.bind(interceptor, call.context, executed),
    () => Promise.resolve({ kind: 'accept' } as const),
  )()
  if (verdict.kind === 'accept') return executed
  if (verdict.kind === 'replace') return replaceToolResult(verdict, executed)
  const text = verdict.feedback.map(block => block.type === 'text' ? block.text : '').filter(Boolean).join('\n')
  return {
    isError: true,
    error: { message: text || 'the result was blocked by policy', code: verdict.code ?? TOOL_ERROR_CODES.DENIED },
    content: verdict.feedback,
  }
}

/** Compatibility facade for callers that do not need scheduling. */
export async function dispatchToolCall(options: DispatchToolCallOptions): Promise<ToolExecutionResult> {
  if (options.signal.aborted) {
    return toolFailure('the call was cancelled before it started', TOOL_ERROR_CODES.ABORTED_BEFORE_DISPATCH)
  }
  const timeoutMs = positiveSafeInteger(options.defaultTimeoutMs ?? 10 * 60_000, 'defaultTimeoutMs')
  const teardownTimeoutMs = positiveSafeInteger(options.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs')
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([options.signal, deadline])
  const pending = dispatchToolCallInternal({
    ...options, signal, defaultTimeoutMs: timeoutMs, teardownTimeoutMs,
  })
  try {
    return await raceWithSignal(pending, signal)
  } catch (error: unknown) {
    if (!signal.aborted) throw error
    const settled = await waitForSettlement(pending, teardownTimeoutMs)
    if (!settled) {
      throw ToolError.fatal(
        `tool pipeline ignored cancellation for more than ${teardownTimeoutMs}ms; `
          + 'the in-process operation may still be running',
        TOOL_ERROR_CODES.TEARDOWN_TIMEOUT,
        { cause: error },
      )
    }
    if (deadline.aborted && !options.signal.aborted) {
      return toolFailure(`the tool pipeline exceeded its ${timeoutMs}ms time limit`, TOOL_ERROR_CODES.TIMEOUT)
    }
    return await pending
  }
}

async function dispatchToolCallInternal(options: DispatchToolCallOptions): Promise<ToolExecutionResult> {
  const authorization = await authorizeToolCall(prepareToolCall(options))
  if (authorization.kind === 'final') return authorization.result
  return await finalizeToolCall(authorization.call, await dispatchAuthorizedToolCall(authorization.call))
}

function replaceToolResult(
  verdict: Extract<PostToolDecision, { kind: 'replace' }>, executed: ToolExecutionResult,
): ToolExecutionResult {
  // Replacement is a sanitization boundary, not a model-content-only edit.
  // Rebuild the envelope so raw value, metadata, errors, and additional
  // context cannot escape through public events, history, or telemetry.
  if (executed.isError) {
    const text = verdict.content.map(block => block.type === 'text' ? block.text : '').filter(Boolean).join('\n')
    return {
      isError: true,
      error: { message: text || 'the tool result was replaced by policy', code: TOOL_ERROR_CODES.DENIED },
      content: verdict.content,
      ...verdict.meta === undefined ? {} : { meta: verdict.meta },
    }
  }
  return {
    isError: false,
    value: undefined,
    content: verdict.content,
    ...verdict.meta === undefined ? {} : { meta: verdict.meta },
    ...executed.concludesTurn === true ? { concludesTurn: true as const } : {},
  }
}
