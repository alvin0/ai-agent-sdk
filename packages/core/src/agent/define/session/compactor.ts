import { ContextCompactor, type ContextCompactorOptions } from '../../memory/compaction.ts'
import { resolveCompactionConfig } from '../../memory/compaction-config.ts'
import type { AgentMemory } from '../../memory/memory.ts'
import type { AgentDefinition } from '../definition.ts'
import type { AgentSessionOptions } from './types.ts'
import { renderRuntimeMemory } from './runtime-memory.ts'

interface SessionCompactionInput {
  readonly options: AgentSessionOptions
  readonly definition: AgentDefinition
  readonly config: ContextCompactorOptions['config']
  readonly history: ContextCompactorOptions['history']
  readonly system: ContextCompactorOptions['system']
  readonly memory: () => AgentMemory
  readonly tools: ContextCompactorOptions['tools']
}

/** Keeps compaction callbacks live across memory loads, model switches and resets. */
export function createSessionCompactor(input: SessionCompactionInput): ContextCompactor | undefined {
  const configured = resolveSessionCompaction(input.options.compaction, input.definition.compaction)
  if (configured === false) return undefined
  return new ContextCompactor({
    registry: input.options.registry,
    config: input.config,
    history: input.history,
    system: input.system,
    pinnedMessages: () => renderRuntimeMemory(input.memory(), input.definition.memory.maxInjectedChars),
    tools: input.tools,
    policy: configured,
  })
}

function resolveSessionCompaction(
  option: AgentSessionOptions['compaction'], definition: AgentDefinition['compaction'],
) {
  if (option === false) return false
  if (option === undefined) return definition
  return resolveCompactionConfig(option)
}
