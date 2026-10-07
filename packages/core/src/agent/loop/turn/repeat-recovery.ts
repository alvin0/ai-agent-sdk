import { detachedFrozen } from '../../../primitives/index.ts'
import type { ToolDefinition, ToolExecutionResult } from '../../tool/definition.ts'
import type { ToolCatalog } from '../../tool/registry.ts'
import { repeatKey } from './repetition.ts'
import type { modelRound } from './model-round.ts'

type Call = Awaited<ReturnType<typeof modelRound>>['calls'][number]
type Success = {
  readonly callId: string; readonly rawArguments: string; readonly definition: ToolDefinition | undefined
  readonly result: Extract<ToolExecutionResult, { readonly isError: false }>
}

type RecoveryContext = {
  successfulCalls: Map<string, Success>
  lastRepeat: { key: string; count: number; callId: string; succeeded: boolean } | undefined
  individuallyRepeatedCallIds: Set<string>; recoveredCallIds: Set<string>; tools: ToolCatalog | undefined
}

function matchingPrior(ctx: RecoveryContext, call: Call): Success | undefined {
  if (!ctx.individuallyRepeatedCallIds.has(String(call.callId))
    || ctx.lastRepeat?.key !== repeatKey(call) || ctx.lastRepeat.succeeded !== true) return undefined
  const prior = ctx.successfulCalls.get(repeatKey(call))
  if (prior === undefined || prior.callId !== ctx.lastRepeat.callId
    || prior.rawArguments !== call.rawArguments || prior.definition !== ctx.tools?.get(call.toolName)) return undefined
  return prior
}

function reusableResult(prior: Success, call: Call, tools: ToolCatalog | undefined): boolean {
  return prior.result.additionalContext === undefined && prior.result.concludesTurn !== true
    && tools?.get(call.toolName)?.budgetExempt !== true
}

export function createRepeatRecovery(ctx: RecoveryContext): (call: Call) => ToolExecutionResult | undefined {
  return (call: Call): ToolExecutionResult | undefined => {
    const prior = matchingPrior(ctx, call)
    if (prior === undefined || !reusableResult(prior, call, ctx.tools)) return undefined
    ctx.recoveredCallIds.add(String(call.callId))
    return duplicateOfResult(prior)
  }
}

function duplicateOfResult(prior: {
  readonly callId: string
  readonly result: Extract<ToolExecutionResult, { readonly isError: false }>
}): ToolExecutionResult {
  return detachedFrozen({
    isError: false,
    // The prior structured value remains the host's canonical result. The
    // header is model-visible so it knows this call was intentionally reused.
    value: prior.result.value,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          status: 'duplicate_of',
          callId: prior.callId,
          instruction: 'This exact call already succeeded in this run. Use the retained result below; '
            + 'do not call it again.',
        }),
      },
      ...prior.result.content,
    ],
    meta: { ...prior.result.meta, recovered: true, duplicateOfCallId: prior.callId },
  })
}

