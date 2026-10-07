import { boundOutput } from './schedule-output.ts'
import { createToolResultMessage, createUserMessage } from '../../message/index.ts'
import { waitForSettlement } from '../../async/index.ts'
import type { ToolExecutionResult } from '../tool/definition.ts'
import { TOOL_ERROR_CODES, ToolError, toolErrorDisposition } from '../tool/errors.ts'
import { finalizeToolCall, toolFailure } from '../tool/pipeline.ts'
import { emitEvent, errorCode, immutableResult, messageOf, now, raceWithSignal, teardownFailure,
} from './tool-call-support.ts'
import type { RunToolCallsOptions } from './schedule.ts'
import type { Slot } from './schedule-types.ts'

export async function commit(
  options: RunToolCallsOptions,
  slot: Slot,
  maxResultBytes: number,
): Promise<ToolExecutionResult> {
  let result: ToolExecutionResult
  let fatal: unknown
  let hasFatal = false
  try {
    const pending = await settleSlot(slot, slot.pending, 'execution')
    await closeSlotProgram(slot)
    const finalized = slot.authorized === undefined ? pending
      : await settleSlot(slot, finalizeToolCall(slot.authorized, pending), 'finalization')
    result = immutableResult(await boundOutput(options, slot.call, finalized), maxResultBytes)
  } catch (error: unknown) {
    slot.program?.abort(error)
    hasFatal = toolErrorDisposition(error) === 'fatal'
    fatal = error
    result = immutableResult(toolFailure(messageOf(error), errorCode(error)), maxResultBytes)
  }
  await publishResult(options, slot, result)
  if (hasFatal) throw fatal
  return result
}

async function settleSlot(
  slot: Slot, pending: Promise<ToolExecutionResult>, stage: 'execution' | 'finalization',
): Promise<ToolExecutionResult> {
  try { return await raceWithSignal(pending, slot.signal) }
  catch (error: unknown) {
    if (!slot.signal.aborted) throw error
    if (!await waitForSettlement(pending, slot.teardownTimeoutMs)) {
      throw teardownFailure(slot.call.toolName, stage, slot.teardownTimeoutMs, error)
    }
    return cancelledResult(slot.deadline)
  }
}

async function closeSlotProgram(slot: Slot): Promise<void> {
  if (slot.program === undefined) return
  const closed = await slot.program.close(slot.teardownTimeoutMs)
  if (!closed) throw teardownFailure(slot.call.toolName, 'nested call', slot.teardownTimeoutMs, undefined)
  const latched: unknown = slot.program.fatal
  if (latched !== undefined) {
    throw toolErrorDisposition(latched) === 'fatal'
      ? latched : ToolError.fatal(messageOf(latched), errorCode(latched), { cause: latched })
  }
}

async function publishResult(
  options: RunToolCallsOptions, slot: Slot, result: ToolExecutionResult,
): Promise<void> {
  const message = createToolResultMessage({ callId: slot.call.callId, content: [...result.content],
    isError: result.isError })
  options.history.append({ kind: 'tool-result', callId: slot.call.callId, message, result })
  await emitEvent(options, { type: 'tool-result', call: slot.call, result, trace: slot.trace,
    ...slot.declined === true ? { declined: true as const } : {},
    ...slot.recovered === true ? { recovered: true as const } : {},
    ...slot.dispatched ? {} : { dispatched: false as const } })
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

