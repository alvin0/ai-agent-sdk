/** Staged tool dispatch: prepare/authorize/dispatch/finalize. */
import type { ContentBlock } from '@ai-agent-sdk/core'
import type { ToolCallId } from '@ai-agent-sdk/core'
import { isJsonValue, type JsonObject, type JsonValue } from '@ai-agent-sdk/core'
import { waitForSettlement } from '@ai-agent-sdk/core'
import type { ApprovalBroker, ApprovalRequest } from './approval.ts'
import {
  executionModeOf, renderJsonValue, type ToolCallPosition, type ToolDefinition,
  type ToolExecutionMode, type ToolExecutionResult, type ToolFailure, type ToolRunContext,
  type ToolSuccess,
} from './definition.ts'
import { TOOL_ERROR_CODES, ToolError, toolErrorDisposition } from './errors.ts'
import type { ToolCatalog } from './registry.ts'

export interface ToolCallRequest {
  readonly callId: ToolCallId
  readonly toolName: string
  readonly rawArguments: string
}
export interface ToolCallContext extends ToolCallPosition {
  readonly callId: ToolCallId
  readonly toolName: string
  readonly tool: ToolDefinition | undefined
  readonly rawArguments: string
  readonly args: unknown
  readonly signal: AbortSignal
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
  before?(call: ToolCallContext, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
  around?(call: ToolCallContext, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
  after?(call: ToolCallContext, result: ToolExecutionResult, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
}
export interface DispatchToolCallOptions {
  readonly catalog: ToolCatalog
  readonly call: ToolCallRequest
  readonly position: ToolCallPosition
  readonly signal: AbortSignal
  readonly interceptors?: readonly ToolInterceptor[]
  readonly approvals?: ApprovalBroker
  /** Maximum wait after a timed-out in-process tool ignores cancellation. */
  readonly teardownTimeoutMs?: number
  /** Timeout used when the tool definition does not declare one. */
  readonly defaultTimeoutMs?: number
  /** Called immediately before an approval broker is awaited. */
  readonly onApprovalRequest?: (request: ApprovalRequest) => Promise<void> | void
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

export function toolFailure(
  message: string,
  code: string,
  extra: { meta?: JsonObject; additionalContext?: readonly ContentBlock[] } = {},
): ToolFailure {
  return {
    isError: true,
    error: { message, code },
    content: [{ type: 'text', text: `Error: ${message}` }],
    ...extra.meta === undefined ? {} : { meta: extra.meta },
    ...extra.additionalContext === undefined ? {} : { additionalContext: extra.additionalContext },
  }
}

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
  }
  return {
    options, context,
    ...argumentFailure === undefined ? {} : { argumentFailure },
    mode: argumentFailure === undefined ? executionModeOf(tool, args) : 'exclusive',
  }
}

/** Ordered pre-policy and approval stage. */
export async function authorizeToolCall(prepared: PreparedToolCall): Promise<AuthorizationOutcome> {
  const interceptors = prepared.options.interceptors ?? []
  const decision = await chain<PreToolDecision>(
    interceptors,
    interceptor => interceptor.before?.bind(interceptor, prepared.context),
    () => Promise.resolve({ kind: 'allow' } as const),
  )()
  if (decision.kind === 'deny') return { kind: 'final', result: toolFailure(decision.reason, TOOL_ERROR_CODES.DENIED) }
  if (decision.kind === 'ask') {
    const broker = prepared.options.approvals
    if (broker === undefined) {
      return { kind: 'final', result: toolFailure(
        decision.reason ?? 'this tool requires approval, and no approver is configured',
        TOOL_ERROR_CODES.DENIED,
      ) }
    }
    const request: ApprovalRequest = {
      callId: prepared.context.callId, toolName: prepared.context.toolName,
      args: prepared.context.args, turn: prepared.context.turn, step: prepared.context.step,
      ...decision.reason === undefined ? {} : { reason: decision.reason },
    }
    // Start the broker first. The streamed approval event is backpressured, and
    // a UI is allowed to answer synchronously while handling it. Publishing
    // before request() installs its waiter loses that answer and parks forever.
    const publication = new AbortController()
    const signal = AbortSignal.any([prepared.context.signal, publication.signal])
    const pending = broker.request(request, signal)
    try {
      await prepared.options.onApprovalRequest?.(request)
    } catch (error: unknown) {
      publication.abort(error)
      await pending.catch(() => undefined)
      throw error
    }
    const answer = await pending
    if (answer === 'abort') throw ToolError.fatal('the turn was withdrawn while awaiting approval', TOOL_ERROR_CODES.ABORTED)
    if (answer === 'deny') return { kind: 'final', result: toolFailure(
      decision.reason ?? `the call to "${prepared.context.toolName}" was not approved`,
      TOOL_ERROR_CODES.DENIED,
    ) }
  }
  if (prepared.argumentFailure !== undefined) return { kind: 'final', result: prepared.argumentFailure }
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
  const body = async (signal: AbortSignal): Promise<ToolExecutionResult> => {
    const extraContext: ContentBlock[] = []
    let concludes = false
    const runContext: ToolRunContext = {
      turn: context.turn, step: context.step, callId: context.callId,
      toolName: context.toolName, signal,
      concludeTurn: () => { concludes = true },
      addContext: content => {
        if (typeof content === 'string') extraContext.push({ type: 'text', text: content })
        else extraContext.push(...content)
      },
    }
    let value: JsonValue | undefined
    try {
      const returned = await tool.execute(context.args as never, runContext)
      value = returned === undefined ? undefined : returned
    } catch (error: unknown) {
      if (toolErrorDisposition(error) === 'fatal') throw error
      if (signal.aborted && !(error instanceof ToolError)) return toolFailure('the call was cancelled', TOOL_ERROR_CODES.ABORTED)
      return toolFailure(messageOf(error), error instanceof ToolError ? error.code : TOOL_ERROR_CODES.FAILED, {
        additionalContext: extraContext,
      })
    }
    if (value !== undefined && !isJsonValue(value)) return toolFailure(
      `tool "${tool.name}" returned a value that is not lossless JSON; return plain objects, arrays, strings, finite numbers, booleans, or null`,
      TOOL_ERROR_CODES.INVALID_RESULT,
    )
    let content: readonly ContentBlock[]
    let meta: JsonObject | undefined
    try {
      content = tool.render === undefined ? renderJsonValue(value) : tool.render(value, context.args as never)
      meta = tool.meta?.(value, context.args as never)
    } catch (error: unknown) {
      return {
        isError: false, value, content: renderJsonValue(value),
        ...extraContext.length === 0 ? {} : { additionalContext: extraContext },
        ...concludes ? { concludesTurn: true as const } : {},
        meta: { renderError: messageOf(error) },
      } satisfies ToolSuccess
    }
    return {
      isError: false, value, content,
      ...meta === undefined ? {} : { meta },
      ...extraContext.length === 0 ? {} : { additionalContext: extraContext },
      ...concludes ? { concludesTurn: true as const } : {},
    } satisfies ToolSuccess
  }
  return await chain<ToolExecutionResult>(
    call.options.interceptors ?? [],
    interceptor => interceptor.around?.bind(interceptor, context),
    () => withTimeout(
      tool.timeoutMs ?? call.options.defaultTimeoutMs,
      context.signal,
      body,
      call.options.teardownTimeoutMs ?? 30_000,
    ),
  )()
}

/** Ordered post-policy stage. */
export async function finalizeToolCall(call: AuthorizedToolCall, executed: ToolExecutionResult): Promise<ToolExecutionResult> {
  const verdict = await chain<PostToolDecision>(
    call.options.interceptors ?? [],
    interceptor => interceptor.after?.bind(interceptor, call.context, executed),
    () => Promise.resolve({ kind: 'accept' } as const),
  )()
  if (verdict.kind === 'accept') return executed
  if (verdict.kind === 'replace') return {
    ...executed, content: verdict.content,
    ...verdict.meta === undefined ? {} : { meta: verdict.meta },
  } as ToolExecutionResult
  const text = verdict.feedback.map(block => block.type === 'text' ? block.text : '').filter(Boolean).join('\n')
  return {
    isError: true,
    error: { message: text || 'the result was blocked by policy', code: verdict.code ?? TOOL_ERROR_CODES.DENIED },
    content: verdict.feedback,
    ...executed.additionalContext === undefined ? {} : { additionalContext: executed.additionalContext },
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
        `tool pipeline ignored cancellation for more than ${teardownTimeoutMs}ms; the in-process operation may still be running`,
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

function parseRawArguments(raw: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: true, value: {} }
  try { return { ok: true, value: JSON.parse(trimmed) as unknown } }
  catch (error: unknown) { return { ok: false, message: `arguments were not valid JSON: ${messageOf(error)}` } }
}
function messageOf(value: unknown): string {
  if (value instanceof Error && value.message.length > 0) return value.message
  const rendered = String(value)
  return rendered.length > 0 ? rendered : 'the tool failed without a message'
}
function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive safe integer`)
  return value
}
function chain<T>(
  interceptors: readonly ToolInterceptor[],
  pick: (interceptor: ToolInterceptor) => ((next: () => Promise<T>) => Promise<T>) | undefined,
  terminal: () => Promise<T>,
): () => Promise<T> {
  let next = terminal
  for (let index = interceptors.length - 1; index >= 0; index--) {
    const interceptor = interceptors[index]
    if (interceptor === undefined) continue
    const hook = pick(interceptor)
    if (hook === undefined) continue
    const inner = next
    next = () => hook(inner)
  }
  return next
}
async function withTimeout(
  timeoutMs: number | undefined,
  outer: AbortSignal,
  run: (signal: AbortSignal) => Promise<ToolExecutionResult>,
  teardownTimeoutMs: number,
): Promise<ToolExecutionResult> {
  if (timeoutMs === undefined) return await run(outer)
  const expiry = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    expiry.abort(new Error(`tool timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  const pending = run(AbortSignal.any([outer, expiry.signal]))
  try {
    const result = await raceWithSignal(pending, expiry.signal)
    return expired
      ? toolFailure(`the tool exceeded its ${timeoutMs}ms time limit`, TOOL_ERROR_CODES.TIMEOUT)
      : result
  } catch (error: unknown) {
    if (!expired) throw error
    const settled = await waitForSettlement(pending, teardownTimeoutMs)
    if (!settled) {
      throw ToolError.fatal(
        `tool ignored timeout cancellation for more than ${teardownTimeoutMs}ms; the in-process operation may still be running`,
        TOOL_ERROR_CODES.TEARDOWN_TIMEOUT,
        { cause: error },
      )
    }
    return toolFailure(`the tool exceeded its ${timeoutMs}ms time limit`, TOOL_ERROR_CODES.TIMEOUT)
  } finally { clearTimeout(timer) }
}

async function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('tool timed out')
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('tool timed out'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}
