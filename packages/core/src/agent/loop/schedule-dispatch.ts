import { waitForSettlement } from '../../async/index.ts'
import type { ToolExecutionResult } from '../tool/definition.ts'
import { TOOL_ERROR_CODES, ToolError } from '../tool/errors.ts'
import { authorizeToolCall, dispatchAuthorizedToolCall, prepareToolCall, toolFailure,
  type ToolCallRequest } from '../tool/pipeline.ts'
import { createSpanId, type TraceRef } from '../trace/trace.ts'
import type { ToolDeclineReason } from './events.ts'
import type { RunToolCallsOptions, InternalScheduleOptions } from './schedule.ts'
import type { AdmissionTicket } from './admission.ts'
import { ProgramRun } from './program.ts'
import type { StepRuntime } from './program.ts'
import { emitEvent, messageOf, now, raceWithSignal, teardownFailure, withApprovalEvents } from './tool-call-support.ts'
import { attachNestedToolPort, NESTED_TOOL_ERROR_CODES, type ProgramGrant } from '../tool/nested.ts'
import { commit } from './schedule-commit.ts'
import type { Slot } from './schedule-types.ts'

function cancelledResult(deadline: AbortSignal, maxDurationMs?: number): ToolExecutionResult {
  const limit = maxDurationMs === undefined ? 'configured time limit' : `${maxDurationMs}ms time limit`
  return deadline.aborted ? toolFailure(`the tool exceeded its ${limit}`, TOOL_ERROR_CODES.TIMEOUT)
    : toolFailure('the call was cancelled', TOOL_ERROR_CODES.ABORTED)
}

export async function start(
  options: RunToolCallsOptions,
  prepared: ReturnType<typeof prepareToolCall>,
  step: StepRuntime,
  internal: InternalScheduleOptions,
): Promise<Slot> {
  const { teardownTimeoutMs } = step
  const definition = options.catalog.get(prepared.options.call.toolName)
  // A call that waits for a person is bounded by its own limit, not the turn's
  // tool limit; without one it ends only with the run.
  const maxDurationMs = definition?.awaitsPerson === true ? definition.timeoutMs : step.maxDurationMs
  const deadline = maxDurationMs === undefined ? new AbortController().signal : AbortSignal.timeout(maxDurationMs)
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
  const recovered = !options.signal.aborted && !signal.aborted
    ? options.recover?.(call)
    : undefined
  options.history.append({ kind: 'tool-call', callId: call.callId, name: call.toolName,
    rawArguments: call.rawArguments })
  await emitEvent(options, { type: 'span-start', trace, at: now(), name: `execute_tool ${call.toolName}`,
    kind: 'execute_tool', attributes: {
    'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': call.toolName, 'gen_ai.tool.call.id': call.callId,
    ...recovered === undefined ? {} : { 'sdk.tool.recovered': true },
  }, input: call.rawArguments })
  await emitEvent(options, { type: 'tool-call', call, trace })
  const preflight = preDispatch({ options, prepared, call, trace, signal, deadline,
    teardownTimeoutMs, maxDurationMs, recovered, step, internal })
  if ('slot' in preflight) return preflight.slot
  return dispatchReserved({ options, call, trace, signal, deadline, teardownTimeoutMs,
    step, internal, boundedPrepared, preflight })
}

async function dispatchReserved(context: Omit<StartContext, 'maxDurationMs' | 'recovered' | 'prepared'> & {
  readonly boundedPrepared: ReturnType<typeof prepareToolCall>
  readonly preflight: { readonly exempt: boolean; readonly grant: ProgramGrant | undefined }
}): Promise<Slot> {
  const { options, call, trace, signal, deadline, teardownTimeoutMs, step, internal,
    boundedPrepared, preflight } = context
  const { exempt, grant } = preflight
  const ticket = step.admission.reserve(exempt)
  if (ticket === undefined) return {
    call, trace, signal, deadline, teardownTimeoutMs, dispatched: false, declined: true,
    pending: Promise.resolve(declinedResult(options.declineReason ?? 'tool-calls')),
  }
  // Every path below that does not start the body returns the reservation.
  try {
    return await authorizeAndDispatch({ options, boundedPrepared, call, trace, signal, deadline,
      ticket, step, grant, internal })
  } finally {
    ticket.release()
  }
}

interface StartContext {
  readonly options: RunToolCallsOptions
  readonly prepared: ReturnType<typeof prepareToolCall>
  readonly call: ToolCallRequest
  readonly trace: TraceRef
  readonly signal: AbortSignal
  readonly deadline: AbortSignal
  readonly teardownTimeoutMs: number
  readonly maxDurationMs: number | undefined
  readonly recovered: ToolExecutionResult | undefined
  readonly step: StepRuntime
  readonly internal: InternalScheduleOptions
}

type Preflight = { readonly slot: Slot } | { readonly exempt: boolean; readonly grant: ProgramGrant | undefined }

function preDispatch(context: StartContext): Preflight {
  const cancellation = preDispatchCancellation(context)
  if (cancellation !== undefined) return cancellation
  const restriction = preDispatchRestriction(context)
  if (restriction !== undefined) return restriction
  const { options, prepared, call, step, internal } = context
  const exempt = options.catalog.get(call.toolName)?.budgetExempt === true
  const decline = exempt ? undefined : internal.decline?.(call)
  if (decline !== undefined) return { slot: declinedSlot(context, decline) }
  const grant = step.programs.get(call.toolName)
  if (grant !== undefined && (exempt || prepared.mode !== 'exclusive')) return {
    slot: configurationSlot(context),
  }
  return { exempt, grant }
}

function preDispatchCancellation(context: StartContext): Preflight | undefined {
  if (context.options.signal.aborted) return { slot: cancelledBeforeDispatch(context) }
  if (context.signal.aborted) return { slot: cancelledSlot(context) }
  return undefined
}

function preDispatchRestriction(context: StartContext): Preflight | undefined {
  const restricted = context.internal.restrict?.(context.call)
  if (restricted !== undefined) return { slot: declinedSlot(context, restricted) }
  if (context.recovered !== undefined) return { slot: recoveredSlot(context) }
  return undefined
}

function cancelledBeforeDispatch(context: StartContext): Slot {
  return { ...baseSlot(context), pending: Promise.resolve(toolFailure(
    'the call was cancelled before it started', TOOL_ERROR_CODES.ABORTED_BEFORE_DISPATCH,
  )) }
}

function cancelledSlot(context: StartContext): Slot {
  return { ...baseSlot(context), pending: Promise.resolve(cancelledResult(context.deadline, context.maxDurationMs)) }
}

function declinedSlot(context: StartContext, reason: ToolDeclineReason): Slot {
  return { ...baseSlot(context), declined: true, pending: Promise.resolve(declinedResult(reason)) }
}

function recoveredSlot(context: StartContext): Slot {
  return { ...baseSlot(context), recovered: true, pending: Promise.resolve(context.recovered!) }
}

function configurationSlot(context: StartContext): Slot {
  return { ...baseSlot(context), pending: Promise.resolve(toolFailure(
    'this program tool must be exclusive and must not be budget-exempt', NESTED_TOOL_ERROR_CODES.CONFIGURATION,
  )) }
}

function baseSlot(context: StartContext): Omit<Slot, 'pending'> {
  return { call: context.call, trace: context.trace, signal: context.signal,
    deadline: context.deadline, teardownTimeoutMs: context.teardownTimeoutMs, dispatched: false }
}

interface DispatchContext {
  readonly options: RunToolCallsOptions
  readonly boundedPrepared: ReturnType<typeof prepareToolCall>
  readonly call: ToolCallRequest
  readonly trace: TraceRef
  readonly signal: AbortSignal
  readonly deadline: AbortSignal
  readonly ticket: AdmissionTicket
  readonly step: StepRuntime
  readonly grant: ProgramGrant | undefined
  readonly internal: InternalScheduleOptions
}

async function authorizeAndDispatch(context: DispatchContext): Promise<Slot> {
  const { options, call, trace, signal, deadline, ticket, step, grant, internal } = context
  const { maxDurationMs, teardownTimeoutMs } = step
  if (options.signal.aborted) return { call, trace, signal, deadline, teardownTimeoutMs,
    dispatched: false, pending: Promise.resolve(toolFailure('the call was cancelled before it started',
      TOOL_ERROR_CODES.ABORTED_BEFORE_DISPATCH)) }
  const authorization = await resolveAuthorization(context)
  if ('slot' in authorization) return authorization.slot
  if (authorization.kind === 'final') return {
    call, trace, signal, deadline, teardownTimeoutMs,
    dispatched: false, pending: Promise.resolve(authorization.result),
  }
  const checkpoint = await runDispatchCheckpoint(context)
  if (checkpoint !== undefined) return checkpoint
  if (signal.aborted) return {
    call, trace, signal, deadline, teardownTimeoutMs, dispatched: false,
    pending: Promise.resolve(cancelledResult(deadline, maxDurationMs)),
  }
  const program = grant === undefined
    ? undefined
    : new ProgramRun(options, step, grant, { call, trace, signal })
  if (program !== undefined) attachNestedToolPort(authorization.call, program.port,
    signal => program.bindExecutionSignal(signal))
  ticket.confirm()
  const awaitsPerson = authorization.call.tool.awaitsPerson === true
  internal.onToolActivity?.(awaitsPerson, true)
  const pending = dispatchAuthorizedToolCall(authorization.call)
  // Observe rejection in the same turn in which dispatch creates the promise.
  // commit() still receives and propagates the original rejection in order.
  const settled = (): void => { internal.onToolActivity?.(awaitsPerson, false) }
  void pending.then(settled, settled)
  return {
    call, trace, signal, deadline, teardownTimeoutMs,
    authorized: authorization.call, dispatched: true,
    ...program === undefined ? {} : { program },
    pending,
  }
}

type AuthorizationResult = Awaited<ReturnType<typeof authorizeToolCall>>
type AuthorizationAttempt = { readonly slot: Slot } | AuthorizationResult

async function resolveAuthorization(context: DispatchContext): Promise<AuthorizationAttempt> {
  const { options, boundedPrepared, call, trace, signal, step } = context
  const pending = authorizeToolCall(withApprovalEvents(options, boundedPrepared, trace))
  try { return await raceWithSignal(pending, signal) }
  catch (error: unknown) {
    if (!signal.aborted) throw error
    if (!await waitForSettlement(pending, step.teardownTimeoutMs)) {
      throw teardownFailure(call.toolName, 'authorization', step.teardownTimeoutMs, error)
    }
    return { slot: { call, trace, signal, deadline: context.deadline,
      teardownTimeoutMs: step.teardownTimeoutMs, dispatched: false,
      pending: Promise.resolve(cancelledResult(context.deadline, step.maxDurationMs)) } }
  }
}

async function runDispatchCheckpoint(context: DispatchContext): Promise<Slot | undefined> {
  const { call, trace, signal, deadline, step } = context
  try { await awaitDispatchCheckpoint(context); return undefined }
  catch (error: unknown) {
    if (error instanceof ToolError && error.code === TOOL_ERROR_CODES.TEARDOWN_TIMEOUT) throw error
    return { call, trace, signal, deadline, teardownTimeoutMs: step.teardownTimeoutMs, dispatched: false,
      pending: Promise.resolve(toolFailure(`history checkpoint failed: ${messageOf(error)}`,
        TOOL_ERROR_CODES.CHECKPOINT_FAILED)) }
  }
}

async function awaitDispatchCheckpoint(context: DispatchContext): Promise<void> {
  const { options, call, signal, step } = context
  const checkpointing = Promise.resolve(options.checkpoint?.({
    kind: 'before-tool-dispatch', call, snapshot: options.history.snapshot(), signal,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  }))
  try { await raceWithSignal(checkpointing, signal) }
  catch (error: unknown) {
    if (!signal.aborted) throw error
    if (!await waitForSettlement(checkpointing, step.teardownTimeoutMs)) {
      throw teardownFailure(call.toolName, 'checkpoint', step.teardownTimeoutMs, error)
    }
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
    case 'time':
      return 'This call was not run: the turn has spent its time budget.' + finish
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

export async function drainSegment(
  options: RunToolCallsOptions,
  segment: readonly Slot[],
  maxResultBytes: number,
): Promise<void> {
  for (const slot of segment) {
    try { await commit(options, slot, maxResultBytes) }
    catch { /* The admission failure remains primary after every owned slot settles. */ }
  }
}
