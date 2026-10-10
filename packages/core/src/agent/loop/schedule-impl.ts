import { detachedFrozen } from '../../primitives/index.ts'
import type { ToolExecutionResult } from '../tool/definition.ts'
import { prepareToolCall, type ToolCallRequest } from '../tool/pipeline.ts'
import { createToolAdmission } from './admission.ts'
import { validPrograms, type StepRuntime } from './program.ts'
import { start, drainSegment } from './schedule-dispatch.ts'
import { commit } from './schedule-commit.ts'
import type { Slot } from './schedule-types.ts'
import type { RunToolCallsOptions, ToolCallsOutcome, InternalScheduleOptions } from './schedule.ts'

export function createScheduleContext(
  options: RunToolCallsOptions, internal: InternalScheduleOptions,
): ScheduleContext {
  const maxParallel = positiveInteger(options.maxParallel ?? 8, 'maxParallel')
  const maxResultBytes = positiveInteger(options.maxResultBytes ?? 4 * 1024 * 1024, 'maxResultBytes')
  const maxDurationMs = positiveInteger(options.maxDurationMs ?? 10 * 60_000, 'maxDurationMs')
  const teardownTimeoutMs = positiveInteger(options.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs')
  const admissionLimit = internal.admissionLimit ?? Math.max(0, options.dispatchLimit ?? options.calls.length)
  const admission = createToolAdmission(admissionLimit)
  const step: StepRuntime = {
    admission, maxDurationMs, teardownTimeoutMs, maxResultBytes,
    programs: validPrograms(internal.programs), programResults: internal.programResults,
  }
  return { options, internal, step, maxParallel, maxResultBytes }
}

export function scheduleOutcome(state: ScheduleState, budgeted: number): ToolCallsOutcome {
  return { results: Object.freeze(state.results), concluded: state.concludedBy !== undefined,
    ...state.concludedBy === undefined ? {} : { concludedBy: state.concludedBy },
    dispatched: state.dispatched, budgeted, declined: state.declined }
}

export interface ScheduleState {
  readonly results: ToolExecutionResult[]
  dispatched: number
  declined: number
  concludedBy: string | undefined
}

interface ScheduleProgress {
  readonly nextIndex: number
  readonly results: readonly ToolExecutionResult[]
  readonly dispatched: number
  readonly declined: number
  readonly concludedBy?: string
  readonly carried?: ReturnType<typeof prepareToolCall>
}

export interface ScheduleContext {
  readonly options: RunToolCallsOptions
  readonly internal: InternalScheduleOptions
  readonly step: StepRuntime
  readonly maxResultBytes: number
  readonly maxParallel: number
}

export function applyProgress(state: ScheduleState, progress: ScheduleProgress): void {
  state.results.push(...progress.results)
  state.dispatched += progress.dispatched
  state.declined += progress.declined
  if (state.concludedBy === undefined) state.concludedBy = progress.concludedBy
}

export async function runExclusive(
  context: ScheduleContext,
  call: ToolCallRequest,
  index: number,
  prepared: ReturnType<typeof prepareToolCall>,
): Promise<ScheduleProgress> {
  const slot = await start(context.options, prepared, context.step, context.internal)
  const result = await commit(context.options, slot, context.maxResultBytes)
  return {
    nextIndex: index + 1,
    results: [result],
    dispatched: slot.dispatched ? 1 : 0,
    declined: slot.declined === true ? 1 : 0,
    ...(result.isError || !result.concludesTurn ? {} : { concludedBy: call.toolName }),
  }
}

export async function runParallel(
  context: ScheduleContext,
  calls: readonly ToolCallRequest[],
  startIndex: number,
  prepared: ReturnType<typeof prepareToolCall>,
): Promise<ScheduleProgress> {
  const segment: Slot[] = []
  const segmentAbort = new AbortController()
  const segmentOptions = {
    ...context.options,
    signal: AbortSignal.any([context.options.signal, segmentAbort.signal]),
  }
  let index = startIndex
  let nextPrepared = prepared
  let carried: ReturnType<typeof prepareToolCall> | undefined
  try {
    ({ index, nextPrepared, carried } = await fillParallelSegment({
      options: segmentOptions, calls, startIndex: index, prepared: nextPrepared, segment, context,
    }))
  } catch (error: unknown) {
    segmentAbort.abort(error)
    await drainSegment(context.options, segment, context.maxResultBytes)
    throw error
  }
  if (segment.length === 0) return {
    nextIndex: index, results: [], dispatched: 0, declined: 0,
    ...(carried === undefined ? {} : { carried }),
  }
  const progress = await commitSegment({ options: context.options, segment, nextIndex: index, segmentAbort,
    maxResultBytes: context.maxResultBytes })
  return { ...progress, ...(carried === undefined ? {} : { carried }) }
}

interface ParallelFillContext {
  readonly options: RunToolCallsOptions
  readonly calls: readonly ToolCallRequest[]
  readonly startIndex: number
  readonly prepared: ReturnType<typeof prepareToolCall>
  readonly segment: Slot[]
  readonly context: ScheduleContext
}

async function fillParallelSegment(context: ParallelFillContext): Promise<{
  index: number; nextPrepared: ReturnType<typeof prepareToolCall>; carried?: ReturnType<typeof prepareToolCall>
}> {
  const { options, calls, segment, context: schedule } = context
  let index = context.startIndex
  let nextPrepared = context.prepared
  let carried: ReturnType<typeof prepareToolCall> | undefined
  while (index < calls.length && segment.length < schedule.maxParallel) {
    const call = calls[index]
    if (call === undefined || nextPrepared.mode !== 'parallel') break
    segment.push(await start(options, nextPrepared, schedule.step, schedule.internal))
    index++
    const nextCall = calls[index]
    if (nextCall !== undefined && segment.length < schedule.maxParallel) {
      nextPrepared = prepare(options, nextCall)
      if (nextPrepared.mode !== 'parallel') carried = nextPrepared
    }
  }
  return { index, nextPrepared, ...(carried === undefined ? {} : { carried }) }
}

interface CommitSegmentContext {
  readonly options: RunToolCallsOptions
  readonly segment: readonly Slot[]
  readonly nextIndex: number
  readonly segmentAbort: AbortController
  readonly maxResultBytes: number
}

async function commitSegment(context: CommitSegmentContext): Promise<ScheduleProgress> {
  const { options, segment, nextIndex, segmentAbort, maxResultBytes } = context
  const results: ToolExecutionResult[] = []
  let fatal: unknown
  let hasFatal = false
  let concludedBy: string | undefined
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
  if (hasFatal) throw fatal
  return {
    nextIndex,
    results,
    dispatched: segment.filter(slot => slot.dispatched).length,
    declined: segment.filter(slot => slot.declined === true).length,
    ...(concludedBy === undefined ? {} : { concludedBy }),
  }
}

export function prepare(options: RunToolCallsOptions, call: ToolCallRequest) {
  return prepareToolCall({
    catalog: options.catalog, call, position: options.position, signal: options.signal,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...options.interceptors === undefined ? {} : { interceptors: options.interceptors },
    ...options.approvals === undefined ? {} : { approvals: options.approvals },
  })
}

export function immutableCall(call: ToolCallRequest): ToolCallRequest {
  if (typeof call.callId !== 'string' || call.callId.length === 0
    || typeof call.toolName !== 'string' || call.toolName.length === 0
    || typeof call.rawArguments !== 'string') {
    throw new TypeError('tool call identity, name, and raw arguments must be strings')
  }
  return detachedFrozen(call)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  return value
}
