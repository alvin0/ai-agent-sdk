import { AgentMemory, type AgentMemoryConfig, type AgentMemorySnapshot } from '../../memory/memory.ts'
import type { RunLedger } from '../../accounting/ledger.ts'
import type { RunAccountingPort } from '../../accounting/contracts.ts'
import type { MemoryLoadState, RuntimeMemoryPersistence } from '../../memory/persistence-types.ts'
import { createUserMessage, type UserMessage } from '../../../message/index.ts'
import type { History } from '../../history/history.ts'
import { isUserMessage } from './common.ts'

export interface PreparedRuntimeMemory {
  readonly state: MemoryLoadState
  readonly memory?: AgentMemory
}

export async function loadRuntimeMemory(
  persistence: RuntimeMemoryPersistence,
  conversationId: string,
  limits: AgentMemoryConfig,
  signal: AbortSignal,
  ledger: RunLedger,
): Promise<PreparedRuntimeMemory> {
  const logger = ledger.modelInvocation.logger
  if (logger === undefined) throw new Error('runtime memory logger is unavailable')
  const operation = ledger.startOperation('memory', { data: { action: 'load' } })
  try {
    const state = await persistence.load(conversationId, signal, logger)
    const memory = state.status === 'loaded'
      ? AgentMemory.fromSnapshot(state.snapshot, limits)
      : undefined
    ledger.endOperation(operation, state.status === 'disabled' ? 'error' : 'success',
      state.status === 'disabled' ? { error: state.error } : {})
    return Object.freeze({ state, ...(memory === undefined ? {} : { memory }) })
  } catch (error) {
    ledger.endOperation(operation, signal.aborted ? 'aborted' : 'error')
    throw error
  }
}

export async function commitRuntimeMemory(
  persistence: RuntimeMemoryPersistence,
  conversationId: string,
  snapshot: AgentMemorySnapshot,
  state: Exclude<MemoryLoadState, { readonly status: 'disabled' }>,
  signal: AbortSignal,
  ledger: RunLedger,
): Promise<void> {
  const logger = ledger.modelInvocation.logger
  if (logger === undefined) throw new Error('runtime memory logger is unavailable')
  const operation = ledger.startOperation('memory', { data: { action: 'commit' } })
  try {
    const committed = await persistence.commit(
      conversationId, snapshot, state.revision, signal, logger,
    )
    ledger.endOperation(operation, committed.status === 'disabled' ? 'error' : 'success',
      committed.status === 'disabled' ? { error: committed.error } : {})
  } catch (error) {
    ledger.endOperation(operation, signal.aborted ? 'aborted' : 'error')
    throw error
  }
}

export function renderRuntimeMemory(
  memory: AgentMemory,
  maxInjectedChars: number,
  accounting?: RunAccountingPort,
): readonly UserMessage[] {
  const operation = accounting?.startOperation('memory', { data: { action: 'render' } })
  try {
    const content = memory.render(maxInjectedChars)
    if (operation !== undefined) accounting?.endOperation(operation, 'success')
    return content.length === 0 ? [] : [createUserMessage({
      source: { kind: 'app', producer: 'agent-task-memory' },
      content: [{ type: 'text', text: content }],
    })]
  } catch (error) {
    if (operation !== undefined) accounting?.endOperation(operation, 'error', { error })
    throw error
  }
}

export function captureResumedObjective(
  memory: AgentMemory,
  history: History,
  enabled: boolean,
): void {
  if (!enabled) return
  const entry = history.entries().find(entry => entry.event.kind === 'user'
    && entry.event.message.role === 'user' && entry.event.message.source.kind === 'user')
  if (entry?.event.kind === 'user' && isUserMessage(entry.event.message)) {
    memory.captureOriginalObjective(entry.event.message)
  }
}
