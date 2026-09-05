import { AgentRunError } from '../../accounting/error.ts'
import type { RunLedger } from '../../accounting/ledger.ts'
import { RunEventBuffer } from '../../accounting/event-buffer.ts'
import type { RunReport, ToolSourceRunReference } from '../../accounting/delivery-types.ts'
import { createRunTerminalRecord, withTerminalDelivery } from '../../accounting/delivery/terminal.ts'
import type { AgentRunEvent } from '../../mode/run-agent.ts'
import type { AgentResponse } from './types.ts'
import type { Deferred } from './common.ts'

interface RuntimeRunSealInput {
  readonly ledger: RunLedger
  readonly buffer: RunEventBuffer<AgentRunEvent>
  readonly report: Deferred<RunReport>
  readonly result: Deferred<AgentResponse>
  readonly toolSources: Deferred<readonly ToolSourceRunReference[]>
  readonly currentToolSources: () => readonly ToolSourceRunReference[]
  readonly isTerminal: () => boolean
  readonly markTerminal: () => void
  readonly abort: () => void
  readonly release: () => void
}

/** Seal one uncooperative run without allowing its eventual return to replace public terminal state. */
export function sealRuntimeRun(input: RuntimeRunSealInput): Promise<RunReport> {
  if (input.isTerminal()) return input.report.promise
  input.markTerminal()
  input.abort()
  input.toolSources.resolve(input.currentToolSources())
  const failure = Object.assign(new Error('Runtime close sealed an unsettled agent run'), {
    code: 'RUNTIME_OPERATION_ABORTED',
  })
  void input.ledger.finalize('aborted', false, failure).then(legacy => {
    const report = withTerminalDelivery(createRunTerminalRecord(legacy), legacy.delivery)
    const error = new AgentRunError('Agent run did not complete', failure.code, report, { cause: failure })
    input.report.resolve(report)
    input.result.reject(error)
    input.buffer.fail(error)
  }, error => {
    input.report.reject(error)
    input.result.reject(error)
    input.buffer.fail(error)
  }).finally(input.release)
  return input.report.promise
}
