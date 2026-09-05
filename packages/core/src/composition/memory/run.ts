import { AgentMemory, type AgentMemorySnapshot } from '../../agent/memory/memory.ts'
import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import type { SdkLogger } from '../../logging/types.ts'
import { boundedText, objectValue, ownData } from '../common/data.ts'
import { MEMORY_LIMITS, MEMORY_OPERATION_ERROR_CODES } from './config.ts'
import { memoryStoreKey } from './key.ts'
import { beginCoreCapabilityOperation } from '../logging/capability.ts'
import type {
  CapturedMemoryBinding, MemoryCommitState, MemoryLoadState, RuntimeMemoryPersistence,
} from './types.ts'

export function createRuntimeMemoryPersistence(
  binding: CapturedMemoryBinding,
  agentId: string,
): RuntimeMemoryPersistence {
  return Object.freeze({
    bindingId: binding.bindingId,
    load: (conversationId: string, signal: AbortSignal, logger: SdkLogger) =>
      loadMemory(binding, agentId, conversationId, signal, logger),
    commit: (
      conversationId: string, snapshot: AgentMemorySnapshot, expectedRevision: string | null,
      signal: AbortSignal, logger: SdkLogger,
    ) =>
      commitMemory(binding, agentId, conversationId, snapshot, expectedRevision, signal, logger),
  })
}

async function loadMemory(
  binding: CapturedMemoryBinding,
  agentId: string,
  conversationId: string,
  signal: AbortSignal,
  logger: SdkLogger,
): Promise<MemoryLoadState> {
  const fields = fieldsFor(binding, 'load')
  const operation = beginCoreCapabilityOperation(logger, 'core-memory-store', 'load')
  try {
    abortIfNeeded(signal)
    logger.info('Memory load started', fields)
    const value = await binding.store.load(memoryStoreKey(binding, agentId, conversationId), { signal, logger })
    abortIfNeeded(signal)
    if (value === undefined) {
      logger.info('Memory load completed', { ...fields, outcome: 'not-found' })
      operation.success()
      return Object.freeze({ status: 'not-found', revision: null })
    }
    const source = objectValue(value)
    if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || (key !== 'snapshot' && key !== 'revision'))) {
      throw new TypeError('Invalid load result')
    }
    const revision = boundedText(ownData(source, 'revision'), MEMORY_LIMITS.revisionBytes)
    const snapshot = AgentMemory.fromSnapshot(ownData(source, 'snapshot') as AgentMemorySnapshot).snapshot()
    logger.info('Memory load completed', { ...fields, outcome: 'loaded' })
    operation.success()
    return Object.freeze({ status: 'loaded', snapshot, revision })
  } catch (error) {
    const safe = memoryFailure(signal, 'load')
    if (signal.aborted) operation.abort(); else operation.fail(safe)
    logger.error('Memory load failed', { ...fields, code: safe.code })
    if (signal.aborted || binding.requirement === 'required') throw safe
    return Object.freeze({ status: 'disabled', error: safe })
  }
}

async function commitMemory(
  binding: CapturedMemoryBinding,
  agentId: string,
  conversationId: string,
  snapshot: AgentMemorySnapshot,
  expectedRevision: string | null,
  signal: AbortSignal,
  logger: SdkLogger,
): Promise<MemoryCommitState> {
  const fields = fieldsFor(binding, 'commit')
  const operation = beginCoreCapabilityOperation(logger, 'core-memory-store', 'commit')
  try {
    abortIfNeeded(signal)
    logger.info('Memory commit started', fields)
    const value = await binding.store.commit(Object.freeze({
      key: memoryStoreKey(binding, agentId, conversationId), snapshot, expectedRevision,
    }), { signal, logger })
    abortIfNeeded(signal)
    const source = objectValue(value)
    if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || key !== 'revision')) {
      throw new TypeError('Invalid commit result')
    }
    const revision = boundedText(ownData(source, 'revision'), MEMORY_LIMITS.revisionBytes)
    logger.info('Memory commit completed', fields)
    operation.success()
    return Object.freeze({ status: 'committed', revision })
  } catch (error) {
    const safe = memoryFailure(signal, 'commit')
    if (signal.aborted) operation.abort(); else operation.fail(safe)
    logger.error('Memory commit failed', { ...fields, code: safe.code })
    if (signal.aborted || binding.requirement === 'required') throw safe
    return Object.freeze({ status: 'disabled', error: safe })
  }
}

function fieldsFor(binding: CapturedMemoryBinding, action: 'load' | 'commit') {
  return Object.freeze({ memoryStoreId: binding.store.id, memoryBindingId: binding.bindingId, action })
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentSdkError('Memory operation was aborted', MEMORY_OPERATION_ERROR_CODES.ABORTED)
}

function memoryFailure(signal: AbortSignal, stage: 'load' | 'commit'): AgentSdkError {
  return signal.aborted
    ? new AgentSdkError('Memory operation was aborted', MEMORY_OPERATION_ERROR_CODES.ABORTED)
    : new AgentSdkError(`Memory ${stage} did not complete`, stage === 'load'
      ? MEMORY_OPERATION_ERROR_CODES.LOAD_FAILED : MEMORY_OPERATION_ERROR_CODES.COMMIT_FAILED)
}
