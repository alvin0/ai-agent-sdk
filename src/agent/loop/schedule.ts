import { createToolResultMessage, createUserMessage } from '@ai-agent-sdk/core'
import { detachedFrozen } from '@ai-agent-sdk/core'
import { waitForSettlement } from '@ai-agent-sdk/core'
import type { History } from '../history/history.ts'
import type { ApprovalBroker } from '../tool/approval.ts'
import type { ToolCallPosition, ToolExecutionResult } from '../tool/definition.ts'
import { TOOL_ERROR_CODES, ToolError, toolErrorDisposition } from '../tool/errors.ts'
import {
  authorizeToolCall, dispatchAuthorizedToolCall, finalizeToolCall, prepareToolCall, toolFailure,
  type AuthorizedToolCall, type ToolCallRequest, type ToolInterceptor,
} from '../tool/pipeline.ts'
import type { ToolCatalog } from '../tool/registry.ts'
import { createSpanId, type TraceRef } from '../trace/trace.ts'
import type { AgentEvent, TurnHooks } from './events.ts'

export interface RunToolCallsOptions {
  readonly calls: readonly ToolCallRequest[]
  readonly catalog: ToolCatalog
  readonly history: History
  readonly position: ToolCallPosition
  readonly signal: AbortSignal
  readonly parentTrace: TraceRef
  readonly maxParallel?: number
  readonly dispatchLimit?: number
  /** Maximum serialized bytes retained for one finalized result. Defaults to 4 MiB. */
  readonly maxResultBytes?: number
  /** End-to-end wall-clock allowance for one call. Defaults to 10 minutes. */
  readonly maxDurationMs?: number
  /** Maximum cancellation settlement wait. Defaults to 30 seconds. */
  readonly teardownTimeoutMs?: number
  readonly interceptors?: readonly ToolInterceptor[]
  readonly approvals?: ApprovalBroker
  readonly emit?: (event: AgentEvent) => Promise<void>
  readonly checkpoint?: TurnHooks['checkpoint']
}
export interface ToolCallsOutcome {
  readonly results: readonly ToolExecutionResult[]
  readonly concluded: boolean
  readonly concludedBy?: string
  readonly dispatched: number
}

interface Slot {
  readonly call: ToolCallRequest
  readonly trace: TraceRef
  readonly authorized?: AuthorizedToolCall
  readonly pending: Promise<ToolExecutionResult>
  readonly dispatched: boolean
  readonly signal: AbortSignal
  readonly deadline: AbortSignal
  readonly teardownTimeoutMs: number
}

/** Execute safe siblings concurrently while committing every result in model order. */
export async function runToolCalls(options: RunToolCallsOptions): Promise<ToolCallsOutcome> {
  const maxParallel = positiveInteger(options.maxParallel ?? 8, 'maxParallel')
  const maxResultBytes = positiveInteger(options.maxResultBytes ?? 4 * 1024 * 1024, 'maxResultBytes')
  const maxDurationMs = positiveInteger(options.maxDurationMs ?? 10 * 60_000, 'maxDurationMs')
  const teardownTimeoutMs = positiveInteger(options.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs')
  const calls = Object.freeze(options.calls.map(immutableCall))
  const dispatchLimit = Math.max(0, options.dispatchLimit ?? calls.length)
  const results: ToolExecutionResult[] = []
  let dispatched = 0
  let concludedBy: string | undefined
  let index = 0
  let carried: ReturnType<typeof prepareToolCall> | undefined

  while (index < calls.length) {
    const first = calls[index]
    if (first === undefined) break
    const prepared = carried ?? prepare(options, first)
    carried = undefined
    if (prepared.mode === 'exclusive') {
      const slot = await start(options, prepared, dispatched < dispatchLimit, maxDurationMs, teardownTimeoutMs)
      dispatched += slot.dispatched ? 1 : 0
      const result = await commit(options, slot, maxResultBytes)
      results.push(result)
      if (concludedBy === undefined && !result.isError && result.concludesTurn) concludedBy = first.toolName
      index++
      continue
    }

    // A rolling parallel segment. Re-prepare each call immediately before start;
    // an updated registry can therefore turn the next call into a barrier.
    const segment: Slot[] = []
    let nextPrepared = prepared
    while (index < calls.length && segment.length < maxParallel) {
      const call = calls[index]
      if (call === undefined) break
      const candidate = nextPrepared
      if (candidate.mode !== 'parallel') break
      const slot = await start(options, candidate, dispatched < dispatchLimit, maxDurationMs, teardownTimeoutMs)
      dispatched += slot.dispatched ? 1 : 0
      segment.push(slot)
      index++
      const nextCall = calls[index]
      if (nextCall !== undefined && segment.length < maxParallel) {
        nextPrepared = prepare(options, nextCall)
        if (nextPrepared.mode !== 'parallel') carried = nextPrepared
      }
    }
    if (segment.length === 0) continue
    // Bodies have already started. Finalization and history publication remain ordered.
    let fatal: unknown
    let hasFatal = false
    for (const slot of segment) {
      try {
        const result = await commit(options, slot, maxResultBytes)
        results.push(result)
        if (concludedBy === undefined && !result.isError && result.concludesTurn) concludedBy = slot.call.toolName
      } catch (error: unknown) {
        if (!hasFatal) fatal = error
        hasFatal = true
      }
    }
    // Every parallel body was already dispatched. Commit/drain all siblings so
    // none is orphaned, then propagate the first fatal contract violation.
    if (hasFatal) throw fatal
  }
  return {
    results: Object.freeze(results),
    concluded: concludedBy !== undefined,
    ...concludedBy === undefined ? {} : { concludedBy },
    dispatched,
  }
}

function prepare(options: RunToolCallsOptions, call: ToolCallRequest) {
  return prepareToolCall({
    catalog: options.catalog, call, position: options.position, signal: options.signal,
    ...options.interceptors === undefined ? {} : { interceptors: options.interceptors },
    ...options.approvals === undefined ? {} : { approvals: options.approvals },
  })
}

async function start(
  options: RunToolCallsOptions,
  prepared: ReturnType<typeof prepareToolCall>,
  hasBudget: boolean,
  maxDurationMs: number,
  teardownTimeoutMs: number,
): Promise<Slot> {
  const deadline = AbortSignal.timeout(maxDurationMs)
  const signal = AbortSignal.any([options.signal, deadline])
  const boundedPrepared = {
    ...prepared,
    options: { ...prepared.options, signal, teardownTimeoutMs },
    context: { ...prepared.context, signal },
  }
  const call = boundedPrepared.options.call
  const trace: TraceRef = {
    traceId: options.parentTrace.traceId,
    spanId: createSpanId(),
    parentSpanId: options.parentTrace.spanId,
  }
  options.history.append({ kind: 'tool-call', callId: call.callId, name: call.toolName, rawArguments: call.rawArguments })
  await emitEvent(options, { type: 'span-start', trace, at: now(), name: `execute_tool ${call.toolName}`, kind: 'execute_tool', attributes: {
    'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': call.toolName, 'gen_ai.tool.call.id': call.callId,
  } })
  await emitEvent(options, { type: 'tool-call', call, trace })
  if (!hasBudget) return {
    call, trace, signal, deadline, teardownTimeoutMs, dispatched: false,
    pending: Promise.resolve(toolFailure('the turn has no remaining tool-call budget', TOOL_ERROR_CODES.BUDGET_EXHAUSTED)),
  }
  if (options.signal.aborted) return {
    call, trace, signal, deadline, teardownTimeoutMs, dispatched: false,
    pending: Promise.resolve(toolFailure('the call was cancelled before it started', TOOL_ERROR_CODES.ABORTED_BEFORE_DISPATCH)),
  }
  const withApprovalEvent = {
    ...boundedPrepared,
    options: {
      ...boundedPrepared.options,
      onApprovalRequest: async (request: Parameters<NonNullable<typeof prepared.options.onApprovalRequest>>[0]) => {
        await emitEvent(options, { type: 'approval-request', request, trace })
      },
    },
  }
  const authorizationPending = authorizeToolCall(withApprovalEvent)
  let authorization: Awaited<ReturnType<typeof authorizeToolCall>>
  try {
    authorization = await raceWithSignal(authorizationPending, signal)
  } catch (error: unknown) {
    if (!signal.aborted) throw error
    const settled = await waitForSettlement(authorizationPending, teardownTimeoutMs)
    if (!settled) throw teardownFailure(call.toolName, 'authorization', teardownTimeoutMs, error)
    return {
      call, trace, signal, deadline, teardownTimeoutMs, dispatched: false,
      pending: Promise.resolve(cancelledResult(deadline, maxDurationMs)),
    }
  }
  if (authorization.kind === 'final') return {
    call, trace, signal, deadline, teardownTimeoutMs,
    dispatched: false, pending: Promise.resolve(authorization.result),
  }
  try {
    await options.checkpoint?.({
      kind: 'before-tool-dispatch', call, snapshot: options.history.snapshot(), signal,
    })
  } catch (error: unknown) {
    return {
      call, trace, signal, deadline, teardownTimeoutMs, dispatched: false,
      pending: Promise.resolve(toolFailure(`history checkpoint failed: ${messageOf(error)}`, TOOL_ERROR_CODES.CHECKPOINT_FAILED)),
    }
  }
  return {
    call, trace, signal, deadline, teardownTimeoutMs,
    authorized: authorization.call, dispatched: true,
    pending: dispatchAuthorizedToolCall(authorization.call),
  }
}

async function commit(
  options: RunToolCallsOptions,
  slot: Slot,
  maxResultBytes: number,
): Promise<ToolExecutionResult> {
  let result: ToolExecutionResult
  let fatal: unknown
  let hasFatal = false
  try {
    let pending: ToolExecutionResult
    try {
      pending = await raceWithSignal(slot.pending, slot.signal)
    } catch (error: unknown) {
      if (!slot.signal.aborted) throw error
      const settled = await waitForSettlement(slot.pending, slot.teardownTimeoutMs)
      if (!settled) throw teardownFailure(slot.call.toolName, 'execution', slot.teardownTimeoutMs, error)
      pending = cancelledResult(slot.deadline)
    }
    let finalized = pending
    if (slot.authorized !== undefined) {
      const finalizing = finalizeToolCall(slot.authorized, pending)
      try {
        finalized = await raceWithSignal(finalizing, slot.signal)
      } catch (error: unknown) {
        if (!slot.signal.aborted) throw error
        const settled = await waitForSettlement(finalizing, slot.teardownTimeoutMs)
        if (!settled) throw teardownFailure(slot.call.toolName, 'finalization', slot.teardownTimeoutMs, error)
        finalized = cancelledResult(slot.deadline)
      }
    }
    result = immutableResult(finalized, maxResultBytes)
  } catch (error: unknown) {
    hasFatal = toolErrorDisposition(error) === 'fatal'
    fatal = error
    result = immutableResult(toolFailure(messageOf(error), errorCode(error)), maxResultBytes)
  }
  const message = createToolResultMessage({ callId: slot.call.callId, content: [...result.content], isError: result.isError })
  options.history.append({ kind: 'tool-result', callId: slot.call.callId, message, result })
  await emitEvent(options, { type: 'tool-result', call: slot.call, result, trace: slot.trace })
  await emitEvent(options, {
    type: 'span-end', trace: slot.trace, at: now(), status: result.isError ? 'error' : 'success',
    output: result.isError ? { error: result.error } : result.value,
    ...result.isError ? { error: { type: 'ToolError', message: result.error.message, code: result.error.code } } : {},
  })
  if (result.additionalContext !== undefined) {
    // Additional context is deliberately a separate application message.
    options.history.append({ kind: 'user', message: createUserMessage({
      content: [...result.additionalContext], source: { kind: 'app', producer: `tool:${slot.call.toolName}` },
    }) })
  }
  if (hasFatal) throw fatal
  return result
}

function immutableCall(call: ToolCallRequest): ToolCallRequest {
  if (typeof call.callId !== 'string' || call.callId.length === 0
    || typeof call.toolName !== 'string' || call.toolName.length === 0
    || typeof call.rawArguments !== 'string') {
    throw new TypeError('tool call identity, name, and raw arguments must be strings')
  }
  return detachedFrozen(call)
}

function immutableResult(result: ToolExecutionResult, maxResultBytes: number): ToolExecutionResult {
  try {
    if (serializedBytes(result) > maxResultBytes) {
      return detachedFrozen(toolFailure(
        `tool result exceeds the ${maxResultBytes}-byte retention limit`,
        TOOL_ERROR_CODES.INVALID_RESULT,
      ))
    }
    const detached = detachedFrozen(result)
    const bytes = serializedBytes(detached)
    if (bytes > maxResultBytes) {
      return detachedFrozen(toolFailure(
        `tool result exceeds the ${maxResultBytes}-byte retention limit`,
        TOOL_ERROR_CODES.INVALID_RESULT,
      ))
    }
    return detached
  } catch (error: unknown) {
    throw ToolError.fatal(
      'tool result could not be detached as lossless structured data',
      TOOL_ERROR_CODES.INVALID_RESULT,
      { cause: error },
    )
  }
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('tool result is not lossless JSON')
  return new TextEncoder().encode(serialized).byteLength
}

function cancelledResult(deadline: AbortSignal, maxDurationMs?: number): ToolExecutionResult {
  const limit = maxDurationMs === undefined ? 'configured time limit' : `${maxDurationMs}ms time limit`
  return deadline.aborted
    ? toolFailure(
        `the tool exceeded its ${limit}`,
        TOOL_ERROR_CODES.TIMEOUT,
      )
    : toolFailure('the call was cancelled', TOOL_ERROR_CODES.ABORTED)
}

function teardownFailure(
  toolName: string,
  stage: string,
  timeoutMs: number,
  cause: unknown,
): ToolError {
  return ToolError.fatal(
    `tool "${toolName}" ${stage} ignored cancellation for more than ${timeoutMs}ms; the in-process operation may still be running`,
    TOOL_ERROR_CODES.TEARDOWN_TIMEOUT,
    { cause },
  )
}

async function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('tool call aborted')
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('tool call aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

async function emitEvent(options: RunToolCallsOptions, event: AgentEvent): Promise<void> {
  await options.emit?.(detachedFrozen(event))
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  return value
}
function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : TOOL_ERROR_CODES.FAILED
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function now(): string { return new Date().toISOString() }
