import type { ToolExecutionResult } from '../tool/definition.ts'
import type { AuthorizedToolCall, ToolCallRequest } from '../tool/pipeline.ts'
import type { TraceRef } from '../trace/trace.ts'
import type { ProgramRun } from './program.ts'

export interface Slot {
  readonly call: ToolCallRequest
  readonly trace: TraceRef
  readonly authorized?: AuthorizedToolCall
  readonly pending: Promise<ToolExecutionResult>
  readonly dispatched: boolean
  readonly program?: ProgramRun
  readonly declined?: boolean
  readonly recovered?: boolean
  readonly signal: AbortSignal
  readonly deadline: AbortSignal
  readonly teardownTimeoutMs: number
}

