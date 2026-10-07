import type { RunAccountingPort } from '../../accounting/contracts.ts'
import type { LegacyRunReport } from '../../accounting/report.ts'
import type { CompactionResult, ContextCompactor } from '../../memory/compaction.ts'
import type { AgentInvocationOptions } from './types.ts'

export interface RuntimeCompactionInput {
  readonly compactor?: ContextCompactor
  readonly invocation: AgentInvocationOptions
  readonly accounting: RunAccountingPort
  readonly prepare: () => Promise<void>
}

export interface RuntimeCompactionOutcome {
  readonly result: CompactionResult | null
  readonly report: LegacyRunReport
  readonly failure?: unknown
}

export async function runRuntimeCompaction(input: RuntimeCompactionInput): Promise<RuntimeCompactionOutcome> {
  const { accounting, invocation } = input
  let result: CompactionResult | null = null
  let failure: unknown
  let operation: string | undefined
  try {
    await input.prepare()
    operation = accounting.startOperation('compaction', { data: { trigger: 'manual' } })
    result = await input.compactor?.compactNow(invocation.signal) ?? null
    accounting.endOperation(operation, 'success')
    operation = undefined
  } catch (error: unknown) {
    failure = error
    if (operation !== undefined) accounting.endOperation(
      operation,
      invocation.signal?.aborted === true ? 'aborted' : 'error',
      { error },
    )
  }
  const outcome = invocation.signal?.aborted === true ? 'aborted' : compactionOutcome(failure)
  const report = await accounting.finalize(
    outcome,
    failure === undefined,
    failure,
  )
  return Object.freeze({ result, report, ...(failure === undefined ? {} : { failure }) })
}

function compactionOutcome(failure: unknown): 'success' | 'error' {
  return failure === undefined ? 'success' : 'error'
}
