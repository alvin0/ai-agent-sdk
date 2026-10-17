import { createUserMessage } from '../../../message/index.ts'
import type { ToolDefinition, ToolExecutionResult } from '../../tool/definition.ts'
import type { ResolvedTurnBounds } from '../types.ts'
import type { RunTurnOptions } from './types.ts'
import type { modelRound } from './model-round.ts'
import { repeatKey } from './repetition.ts'

type Call = Awaited<ReturnType<typeof modelRound>>['calls'][number]

export type ToolProgress = {
  options: RunTurnOptions; bounds: ResolvedTurnBounds; consecutiveErrors: number; repeatedLimit: boolean
  lastRepeat: { key: string; count: number; callId: string; succeeded: boolean } | undefined
  successfulCalls: Map<string, {
    readonly callId: string; readonly rawArguments: string; readonly definition: ToolDefinition | undefined
    readonly result: Extract<ToolExecutionResult, { readonly isError: false }>
  }>
}

function warnRepeatedCall(ctx: ToolProgress, call: Call, count: number): void {
  // Repetition is not stopped by default, so the reminder repeats at each multiple of its threshold.
  if (count % ctx.bounds.repeatToolWarningAt !== 0) return
  ctx.options.history.append({ kind: 'user', message: createUserMessage({
    source: { kind: 'app', producer: 'tool-loop-repeat-guard' },
    content: [{ type: 'text',
      text: 'You have called ' + call.toolName + ' with the same arguments ' + count
        + ' consecutive times. Reassess before repeating it.' }],
  }) })
}

function warnConsecutiveErrors(ctx: ToolProgress): void {
  const count = ctx.consecutiveErrors
  if (count === 0 || count % ctx.bounds.consecutiveToolErrorWarningAt !== 0) return
  ctx.options.history.append({ kind: 'user', message: createUserMessage({
    source: { kind: 'app', producer: 'tool-loop-error-guard' },
    content: [{ type: 'text',
      text: `The last ${count} tool calls failed. Read the errors, change the approach or the arguments, `
        + 'and do not retry the same failing call unchanged.' }],
  }) })
}

function recordSuccessfulCall(ctx: ToolProgress, call: Call, result: ToolExecutionResult): void {
  if (result.isError || result.meta?.declined === true
    || ctx.options.tools?.get(call.toolName)?.budgetExempt === true) return
  ctx.successfulCalls.set(repeatKey(call), {
    callId: String(call.callId), rawArguments: call.rawArguments,
    definition: ctx.options.tools?.get(call.toolName), result,
  })
}

function recordToolResult(ctx: ToolProgress, call: Call, result: ToolExecutionResult): void {
  ctx.consecutiveErrors = result.isError ? ctx.consecutiveErrors + 1 : 0
  warnConsecutiveErrors(ctx)
  const key = repeatKey(call)
  const count = ctx.lastRepeat?.key === key ? ctx.lastRepeat.count + 1 : 1
  ctx.lastRepeat = { key, count, callId: String(call.callId),
    succeeded: !result.isError && result.meta?.declined !== true
      && ctx.options.tools?.get(call.toolName)?.budgetExempt !== true,
  }
  warnRepeatedCall(ctx, call, count)
  if (count >= ctx.bounds.repeatToolLimit) ctx.repeatedLimit = true
  recordSuccessfulCall(ctx, call, result)
}

export function recordToolResults(
  ctx: ToolProgress, calls: readonly Call[], results: readonly ToolExecutionResult[],
): void {
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]
    const result = results[index]
    if (call === undefined || result === undefined) continue
    recordToolResult(ctx, call, result)
  }
}
