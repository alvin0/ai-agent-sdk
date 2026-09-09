import { createToolResultMessage, createUserMessage } from '../../message/index.ts'
import type { ContentBlock } from '../../message/index.ts'
import { detachedFrozen } from '../../primitives/index.ts'
import type { JsonObject } from '../../primitives/index.ts'
import { waitForSettlement } from '../../async/index.ts'
import type { History } from '../history/history.ts'
import type { ApprovalBroker } from '../tool/approval.ts'
import type { ToolCallPosition, ToolExecutionResult } from '../tool/definition.ts'
import {
  estimateTextBlockTokens, previewForSpill, truncateMiddleToTokens,
  type SpillStore, type ToolOutputOverflowPolicy,
} from '../tool/output-budget.ts'
import { TOOL_ERROR_CODES, ToolError, toolErrorDisposition } from '../tool/errors.ts'
import {
  authorizeToolCall, dispatchAuthorizedToolCall, finalizeToolCall, prepareToolCall, toolFailure,
  type AuthorizedToolCall, type ToolCallRequest, type ToolInterceptor,
} from '../tool/pipeline.ts'
import type { ToolCatalog } from '../tool/registry.ts'
import { createSpanId, type TraceRef } from '../trace/trace.ts'
import type { AgentEvent, ToolDeclineReason, TurnHooks } from './events.ts'
import type { RunAccountingPort } from '../accounting/contracts.ts'
import type { SdkLogger } from '../../logging/types.ts'

export interface RunToolCallsOptions {
  readonly calls: readonly ToolCallRequest[]
  readonly catalog: ToolCatalog
  readonly history: History
  readonly position: ToolCallPosition
  readonly signal: AbortSignal
  readonly logger?: SdkLogger
  readonly parentTrace: TraceRef
  readonly maxParallel?: number
  /**
   * How many BUDGETED calls may still be dispatched this step.
   *
   * Calls to a `budgetExempt` tool are not counted against it, so a spent
   * budget never blocks the model from submitting, asking, or delegating.
   */
  readonly dispatchLimit?: number
  /** Why calls past `dispatchLimit` are not run; shown to the model verbatim. */
  readonly declineReason?: ToolDeclineReason
  /** Estimated tokens of text one result may put in front of the model. */
  readonly maxResultTokens?: number
  /** What happens to output over that budget. Defaults to `auto`. */
  readonly resultOverflow?: ToolOutputOverflowPolicy
  /** Where spilled output goes; `auto` spills only when this is mounted. */
  readonly spillStore?: SpillStore
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
  readonly accounting?: RunAccountingPort
}
export interface ToolCallsOutcome {
  readonly results: readonly ToolExecutionResult[]
  readonly concluded: boolean
  readonly concludedBy?: string
  readonly dispatched: number
  /** Dispatched calls that spent budget; exempt tools are excluded. */
  readonly budgeted: number
  /** Calls the loop refused to run, for the reason in `declineReason`. */
  readonly declined: number
}

interface Slot {
  readonly call: ToolCallRequest
  readonly trace: TraceRef
  readonly authorized?: AuthorizedToolCall
  readonly pending: Promise<ToolExecutionResult>
  readonly dispatched: boolean
  /** Whether this dispatch spent turn budget; exempt tools never do. */
  readonly budgeted?: boolean
  /** Set when the loop refused to run the call. */
  readonly declined?: boolean
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
  let budgeted = 0
  let declined = 0
  let concludedBy: string | undefined
  let index = 0
  let carried: ReturnType<typeof prepareToolCall> | undefined

  while (index < calls.length) {
    const first = calls[index]
    if (first === undefined) break
    const prepared = carried ?? prepare(options, first)
    carried = undefined
    if (prepared.mode === 'exclusive') {
      const slot = await start(options, prepared, budgeted < dispatchLimit, maxDurationMs, teardownTimeoutMs)
      dispatched += slot.dispatched ? 1 : 0
      budgeted += slot.budgeted === true ? 1 : 0
      declined += slot.declined === true ? 1 : 0
      const result = await commit(options, slot, maxResultBytes)
      results.push(result)
      if (concludedBy === undefined && !result.isError && result.concludesTurn) concludedBy = first.toolName
      index++
      continue
    }

    // A rolling parallel segment. Re-prepare each call immediately before start;
    // an updated registry can therefore turn the next call into a barrier.
    const segment: Slot[] = []
    const segmentAbort = new AbortController()
    const segmentOptions: RunToolCallsOptions = {
      ...options,
      signal: AbortSignal.any([options.signal, segmentAbort.signal]),
    }
    let nextPrepared = prepared
    try {
      while (index < calls.length && segment.length < maxParallel) {
        const call = calls[index]
        if (call === undefined) break
        const candidate = nextPrepared
        if (candidate.mode !== 'parallel') break
        const slot = await start(segmentOptions, candidate, budgeted < dispatchLimit, maxDurationMs, teardownTimeoutMs)
        dispatched += slot.dispatched ? 1 : 0
        budgeted += slot.budgeted === true ? 1 : 0
        declined += slot.declined === true ? 1 : 0
        segment.push(slot)
        index++
        const nextCall = calls[index]
        if (nextCall !== undefined && segment.length < maxParallel) {
          nextPrepared = prepare(segmentOptions, nextCall)
          if (nextPrepared.mode !== 'parallel') carried = nextPrepared
        }
      }
    } catch (error: unknown) {
      // Admission of a later sibling failed after earlier bodies started.
      // Cancel and drain everything already owned before propagating that error.
      segmentAbort.abort(error)
      await drainSegment(options, segment, maxResultBytes)
      throw error
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
        segmentAbort.abort(error)
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
    budgeted,
    declined,
  }
}

function prepare(options: RunToolCallsOptions, call: ToolCallRequest) {
  return prepareToolCall({
    catalog: options.catalog, call, position: options.position, signal: options.signal,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
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
  // A tool the model may always reach: submitting, asking, delegating. Letting
  // a budget block these is what turns a spent budget into a dead run.
  const exempt = options.catalog.get(call.toolName)?.budgetExempt === true
  if (!hasBudget && !exempt) return {
    call, trace, signal, deadline, teardownTimeoutMs, dispatched: false, declined: true,
    pending: Promise.resolve(declinedResult(options.declineReason ?? 'tool-calls')),
  }
  if (options.signal.aborted) return {
    call, trace, signal, deadline, teardownTimeoutMs, dispatched: false,
    pending: Promise.resolve(toolFailure('the call was cancelled before it started', TOOL_ERROR_CODES.ABORTED_BEFORE_DISPATCH)),
  }
  let approvalOperation: string | undefined
  const withApprovalEvent = {
    ...boundedPrepared,
    options: {
      ...boundedPrepared.options,
      onApprovalRequest: async (request: Parameters<NonNullable<typeof prepared.options.onApprovalRequest>>[0]) => {
        approvalOperation = options.accounting?.startOperation('user-input', {
          toolCallId: request.callId,
          data: { action: 'approval', toolName: request.toolName },
        })
        await emitEvent(options, { type: 'approval-request', request, trace })
      },
      ...options.accounting === undefined ? {} : {
        onApprovalSettled: (status: 'success' | 'error' | 'aborted', error?: unknown) => {
          if (approvalOperation !== undefined) {
            options.accounting?.endOperation(approvalOperation, status, error === undefined ? {} : { error })
            approvalOperation = undefined
          }
        },
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
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    })
  } catch (error: unknown) {
    return {
      call, trace, signal, deadline, teardownTimeoutMs, dispatched: false,
      pending: Promise.resolve(toolFailure(`history checkpoint failed: ${messageOf(error)}`, TOOL_ERROR_CODES.CHECKPOINT_FAILED)),
    }
  }
  const pending = dispatchAuthorizedToolCall(authorization.call)
  // Observe rejection in the same turn in which dispatch creates the promise.
  // commit() still receives and propagates the original rejection in order.
  void pending.catch(() => undefined)
  return {
    call, trace, signal, deadline, teardownTimeoutMs,
    authorized: authorization.call, dispatched: true, budgeted: !exempt,
    pending,
  }
}

/**
 * What the model reads when the loop refuses to run a call.
 *
 * Not a failure. A failure is something that went wrong, and a model answers
 * one by retrying — with a smaller argument, a different path — which spends
 * exactly what is no longer there. This says what happened and what to do
 * instead, in the plainest terms available, and nothing about it reads as
 * broken tooling.
 * @param reason - Which limit refused the call.
 * @returns A successful result carrying the instruction.
 */
function declinedResult(reason: ToolDeclineReason): ToolExecutionResult {
  return {
    isError: false,
    value: undefined,
    content: [{ type: 'text', text: declineText(reason) }],
    // Never shown to the model; lets a UI render this as declined rather than
    // as work that succeeded.
    meta: { declined: true, reason },
  }
}

/**
 * The instruction for one decline reason.
 *
 * Each limit gets its own wording: a model told "no remaining tool-call
 * budget" when it actually tripped the repeat guard learns the wrong lesson
 * and repeats the call in the next turn.
 * @param reason - Which limit refused the call.
 * @returns The sentence the model reads.
 */
function declineText(reason: ToolDeclineReason): string {
  const finish = ' Answer now from what you already have, and say plainly what is'
    + ' unverified or unfinished.'
  switch (reason) {
    case 'tool-calls':
      return 'This call was not run: the turn has spent its tool-call budget.'
        + ' Further work calls will not run either, so do not retry it.' + finish
    case 'repeated-tool-call':
      return 'This call was not run: it repeats a call already made with the same'
        + ' arguments, and repeating it cannot produce a new result. Change'
        + ' approach or finish.' + finish
    case 'tool-call-cycle':
      return 'This call was not run: the same sequence of calls has repeated'
        + ' several times without progress. Break the cycle rather than'
        + ' re-entering it.' + finish
    case 'tokens':
      return 'This call was not run: the turn has spent its token budget.' + finish
    case 'consecutive-tool-errors':
      return 'This call was not run: too many calls in a row have failed.'
        + ' Something in the approach is wrong, not the individual call.' + finish
    case 'steps':
      return 'This call was not run: the turn has no model steps left.' + finish
    case 'usage-required':
      return 'This call was not run: the run policy requires provider usage'
        + ' reporting that the last model call did not supply.' + finish
  }
}

async function drainSegment(
  options: RunToolCallsOptions,
  segment: readonly Slot[],
  maxResultBytes: number,
): Promise<void> {
  for (const slot of segment) {
    try { await commit(options, slot, maxResultBytes) }
    catch { /* The admission failure remains primary after every owned slot settles. */ }
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
    result = immutableResult(await boundOutput(options, slot, finalized), maxResultBytes)
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

/**
 * Keep one tool result inside its share of the context window.
 *
 * This runs at the RESULT boundary rather than when the request is assembled,
 * which is the whole point: by the time an oversized result reaches the model
 * the window is already gone, and the turn's only remaining move is to lose
 * everything it has paid for. Both reference harnesses cut here.
 *
 * The budget is the stricter of the turn's and the tool's own declaration, so
 * a tool that knows it returns a lot can ask for room without any tool being
 * able to exceed what the host allows.
 * @param options - The scheduling options carrying budget and store.
 * @param slot - The call this result belongs to.
 * @param result - The finalized result.
 * @returns The result the model will read.
 */
async function boundOutput(
  options: RunToolCallsOptions,
  slot: Slot,
  result: ToolExecutionResult,
): Promise<ToolExecutionResult> {
  const turnBudget = options.maxResultTokens
  const toolBudget = options.catalog.get(slot.call.toolName)?.maxOutputTokens
  const budget = turnBudget === undefined
    ? toolBudget
    : toolBudget === undefined ? turnBudget : Math.min(turnBudget, toolBudget)
  if (budget === undefined) return result
  const tokens = estimateTextBlockTokens(result.content)
  if (tokens <= budget) return result

  // Only text is shortened. Cutting an image block produces a corrupt image
  // rather than a smaller one, so those pass through and are counted by the
  // byte cap instead.
  const texts = result.content.filter(block => block.type === 'text')
  if (texts.length === 0) return result
  const full = texts.map(block => block.text).join('\n')
  const policy = options.resultOverflow ?? 'auto'
  const store = options.spillStore

  if (policy !== 'truncate' && store !== undefined) {
    try {
      // Reserve room for the notice inside the budget, so the replacement is
      // never bigger than what it replaced.
      const record = await store.save(full, {
        toolName: slot.call.toolName, callId: String(slot.call.callId),
      })
      const preview = previewForSpill(full, Math.max(1, Math.floor(budget * 0.75)))
      return replaceText(result, `${preview}\n\n[Output exceeded this call's budget of `
        + `${String(budget)} estimated tokens. The full ${String(record.bytes)} bytes are saved. `
        + `${record.retrieval}]`, {
        outputSpilled: { locator: record.locator, bytes: record.bytes, estimatedTokens: tokens },
      })
    } catch {
      // Best-effort, deliberately: a store that is full or unreachable must not
      // cost the model a result it can still read most of.
    }
  }

  const truncated = truncateMiddleToTokens(full, budget)
  return replaceText(result, truncated.text
    + `\n\n[Output was ${String(truncated.originalTokens)} estimated tokens, over this call's `
    + `budget of ${String(budget)}. Re-run more narrowly if you need the omitted part.]`, {
    outputTruncated: { estimatedTokens: truncated.originalTokens, budget },
  })
}

/**
 * Swap a result's text for one shortened block, keeping everything else.
 * @param result - The original result.
 * @param text - The replacement text.
 * @param meta - What a UI should know about the replacement.
 * @returns The rewritten result.
 */
function replaceText(
  result: ToolExecutionResult,
  text: string,
  meta: JsonObject,
): ToolExecutionResult {
  // The replacement takes the FIRST text block's position and the other text
  // blocks drop out. Appending it after the non-text blocks instead would
  // reorder a result whose image came after its caption.
  let placed = false
  const content: ContentBlock[] = []
  for (const block of result.content) {
    if (block.type !== 'text') { content.push(block); continue }
    if (placed) continue
    placed = true
    content.push({ type: 'text', text })
  }
  // `value` is deliberately untouched: it is what a host logs and replays, and
  // shortening it would make the record disagree with what the tool returned.
  return { ...result, content, meta: { ...result.meta, ...meta } }
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
