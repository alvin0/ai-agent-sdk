import { createUserMessage } from '@ai-agent-sdk/core'
import {
  AgentMemory,
  COMPACTION_INSTRUCTION,
  ContextCompactor,
  History,
  estimateContextTokens,
  estimateMessageTokens,
  normalizeToolPairing,
  projectHistorySurface,
  projectMessages,
  resolveCompactionConfig,
  resolveMemoryConfig,
  selectCompactablePrefix,
  type AgentCompactionConfig,
  type AgentCompactionOptions,
  type AgentMemoryConfig,
  type AgentMemoryConfigInput,
  type AgentMemoryItem,
  type AgentMemoryKind,
  type AgentMemorySeed,
  type AgentMemorySnapshot,
  type BeforeStepContext,
  type CheckpointContext,
  type CompactionBackoffReason,
  type CompactionResult,
  type ContextCompactorOptions,
  type HistoryEntry,
  type HistoryEvent,
  type HistoryLimits,
  type HistorySnapshot,
  type HistorySurfaceNode,
  type RequestErrorContext,
  type StepDecision,
  type SurfaceOp,
  type TurnEndContext,
  type TurnHooks,
} from '@ai-agent-sdk/core/agent'

type Equivalent<Left, Right> =
  [Left] extends [Right]
    ? [Right] extends [Left] ? true : false
    : false
type Assert<Value extends true> = Value

export type AgentMemoryHistoryApiShape = [
  Assert<Equivalent<AgentMemoryKind,
    | 'objective'
    | 'constraint'
    | 'decision'
    | 'fact'
    | 'progress'
    | 'next-step'>>,
  Assert<Equivalent<CompactionBackoffReason, 'low-savings' | 'unreachable-threshold'>>,
  Assert<Equivalent<HistorySnapshot['version'], 1>>,
  Assert<Equivalent<HistorySnapshot['entries'], readonly HistoryEntry[]>>,
  Assert<Equivalent<CompactionResult['trigger'], 'pressure' | 'context-overflow' | 'manual'>>,
]

export type AgentMemoryHistoryTypeInventory = [
  AgentCompactionConfig,
  AgentCompactionOptions,
  AgentMemoryConfig,
  AgentMemoryConfigInput,
  AgentMemoryItem,
  AgentMemorySeed,
  AgentMemorySnapshot,
  BeforeStepContext,
  CheckpointContext,
  ContextCompactorOptions,
  HistoryEvent,
  HistoryLimits,
  HistorySurfaceNode,
  RequestErrorContext,
  StepDecision,
  SurfaceOp,
  TurnEndContext,
  TurnHooks,
]

const message = createUserMessage({
  content: [{ type: 'text', text: 'Preserve this objective.' }],
  source: { kind: 'user' },
})

/** Representative deterministic memory/history source compiled unchanged on both modules. */
export function exerciseAgentMemoryHistoryApi(): void {
  const memoryConfig = resolveMemoryConfig({
    autoCaptureObjective: true,
    seed: [{ kind: 'constraint', content: 'Keep the report deterministic.' }],
  })
  const memory = new AgentMemory(memoryConfig.seed, memoryConfig)
  void memory.captureOriginalObjective(message)
  const item = memory.remember({ kind: 'progress', content: 'Compatibility checked.' })
  void memory.items()
  void memory.render(memoryConfig.maxInjectedChars)
  void AgentMemory.fromSnapshot(memory.snapshot(), memoryConfig)
  void memory.forget(item.id)

  const history = new History({ maxEntries: 32 })
  history.append({ kind: 'user', message })
  const entries = history.entries()
  const messages = projectMessages(entries)
  const surface = projectHistorySurface(entries)
  void normalizeToolPairing(messages)
  void estimateContextTokens({ system: 'system', messages })
  void estimateMessageTokens(messages[0])
  void selectCompactablePrefix(surface, 128)
  void History.fromSnapshot(history.snapshot(), { maxEntries: 32 })
  void history.messages()
  void history.surface()
  void history.generation()

  void resolveCompactionConfig({ auto: true, thresholdRatio: 0.8, retainRatio: 0.2 })
  void COMPACTION_INSTRUCTION
  void ContextCompactor
}
