/** The run driver can access only this session state and these lifecycle operations. */
import type { AgentSession } from '../session.ts'
import type { AgentMemory } from '../../memory/memory.ts'
import type { ContextCompactor } from '../../memory/compaction.ts'
import type { SkillCatalog } from '../../skill/index.ts'
import type { ToolCatalog } from '../../tool/registry.ts'
import type { SessionInputState } from './input-state.ts'
import type { RuntimeSessionConfiguration } from './runtime-binding.ts'
import type { createSessionLedger } from './accounting.ts'
import type { RunAccountingPort } from '../../accounting/contracts.ts'
import type { AgentInvocationOptions } from './types.ts'

export type SessionRunLedger = ReturnType<typeof createSessionLedger>

export interface SessionRunHost extends Pick<AgentSession,
  'definition' | 'options' | 'currentHistory' | 'currentConversationId' | 'history'
  | 'callConfig' | 'observeRoundBoundary' | 'runDefinition' | 'activeAdditionalInstructions'> {
  readonly catalog: ToolCatalog | undefined
  readonly skillCatalog: SkillCatalog | undefined
  readonly compactor: ContextCompactor | undefined
  readonly inputState: SessionInputState
  currentMemory: AgentMemory
  activeRuntimeCatalog: ToolCatalog | undefined
  active: boolean
  activeInvocation: AgentInvocationOptions | undefined
  runtime(): RuntimeSessionConfiguration | undefined
  createLedger(): SessionRunLedger
  prepareSkills(signal?: AbortSignal, accounting?: RunAccountingPort): Promise<void>
  drainInjections(): void
  releaseRun(): void
}
