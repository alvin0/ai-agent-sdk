import type { Message } from '../../../message/index.ts'
import type { BlockAssembler } from '../../../stream/index.ts'
import type { ModelCallReport } from '../../../observation/index.ts'
import type { ToolCallId } from '../../../primitives/index.ts'
import type { TraceRef } from '../../trace/trace.ts'
import type { AgentEvent, AgentMaintenanceEvent } from '../types.ts'
import type { ModelRoundPhase, RunTurnOptions } from './types.ts'

export interface ModelRoundInput {
  readonly options: RunTurnOptions
  readonly signal: AbortSignal
  readonly emit: (event: AgentEvent) => Promise<void>
  readonly emitMaintenance: (event: AgentMaintenanceEvent) => Promise<void>
  readonly root: TraceRef
  readonly turn: number
  readonly step: number
  readonly phase: ModelRoundPhase
  readonly position?: { readonly workStep: number; readonly finalizing: boolean }
}

export interface ModelRoundContext extends ModelRoundInput {
  readonly position: { readonly workStep: number; readonly finalizing: boolean }
  readonly trace: TraceRef
  readonly forcedFinal: boolean
  readonly finalOutput: boolean
  readonly initialMessages: readonly Message[]
  readonly afterToolCallIds: readonly ToolCallId[]
  readonly generation: number
  readonly entries: number
}

export interface ModelStreamResult {
  readonly assembler: BlockAssembler
  readonly modelCallReport?: ModelCallReport
  readonly usageRequired: boolean
  readonly usageUnavailable: boolean
}
