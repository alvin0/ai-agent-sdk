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
  timeoutMs = 30_000,
): RuntimeMemoryPersistence {
  return Object.freeze({
    bindingId: binding.bindingId,
    load: (conversationId: string, signal: AbortSignal, logger: SdkLogger) =>
      loadMemory(binding, agentId, conversationId, signal, logger, timeoutMs),
    commit: (
      conversationId: string, snapshot: AgentMemorySnapshot, expectedRevision: string | null,
      signal: AbortSignal, logger: SdkLogger,
    ) =>
      commitMemory(binding, agentId, conversationId, snapshot, expectedRevision, signal, logger, timeoutMs),
  })
}

async function loadMemory(
  binding: CapturedMemoryBinding,
  agentId: string,
  conversationId: string,
  signal: AbortSignal,
  logger: SdkLogger,
  timeoutMs: number,
): Promise<MemoryLoadState> {
  const fields = fieldsFor(binding, 'load')
  const operation = beginCoreCapabilityOperation(logger, 'core-memory-store', 'load')
  let operationSignal = signal
  let disposeDeadline = (): void => undefined
  try {
    abortIfNeeded(signal)
    const scope = callbackScope(signal, timeoutMs)
    operationSignal = scope.signal
    disposeDeadline = scope.dispose
    logger.info('Memory load started', fields)
    const pending = Promise.resolve().then(() => {
      abortIfNeeded(operationSignal)
      return binding.store.load(
        memoryStoreKey(binding, agentId, conversationId), { signal: operationSignal, logger },
      )
    })
    const value = await raceSignal(pending, operationSignal)
    abortIfNeeded(operationSignal, signal, 'load')
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
  } catch {
    const safe = memoryFailure(signal, operationSignal, 'load')
    if (signal.aborted) operation.abort(); else operation.fail(safe)
    logger.error('Memory load failed', { ...fields, code: safe.code })
    if (signal.aborted || binding.requirement === 'required') throw safe
    return Object.freeze({ status: 'disabled', error: safe })
  } finally { disposeDeadline() }
}

async function commitMemory(
  binding: CapturedMemoryBinding,
  agentId: string,
  conversationId: string,
  snapshot: AgentMemorySnapshot,
  expectedRevision: string | null,
  signal: AbortSignal,
  logger: SdkLogger,
  timeoutMs: number,
): Promise<MemoryCommitState> {
  const fields = fieldsFor(binding, 'commit')
  const operation = beginCoreCapabilityOperation(logger, 'core-memory-store', 'commit')
  let operationSignal = signal
  let dispatched = false
  let disposeDeadline = (): void => undefined
  try {
    abortIfNeeded(signal)
    const scope = callbackScope(signal, timeoutMs)
    operationSignal = scope.signal
    disposeDeadline = scope.dispose
    logger.info('Memory commit started', fields)
    const pending = Promise.resolve().then(() => {
      abortIfNeeded(operationSignal)
      dispatched = true
      return binding.store.commit(Object.freeze({
        key: memoryStoreKey(binding, agentId, conversationId), snapshot, expectedRevision,
      }), { signal: operationSignal, logger })
    })
    const value = await raceSignal(pending, operationSignal)
    const source = objectValue(value)
    if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || key !== 'revision')) {
      throw new TypeError('Invalid commit result')
    }
    const revision = boundedText(ownData(source, 'revision'), MEMORY_LIMITS.revisionBytes)
    logger.info('Memory commit completed', fields)
    operation.success()
    return Object.freeze({ status: 'committed', revision })
  } catch {
    const safe = memoryFailure(signal, operationSignal, 'commit', dispatched)
    if (signal.aborted) operation.abort(); else operation.fail(safe)
    logger.error('Memory commit failed', { ...fields, code: safe.code })
    if (signal.aborted || binding.requirement === 'required') throw safe
    return Object.freeze({ status: 'disabled', error: safe })
  } finally { disposeDeadline() }
}

function fieldsFor(binding: CapturedMemoryBinding, action: 'load' | 'commit') {
  return Object.freeze({ memoryStoreId: binding.store.id, memoryBindingId: binding.bindingId, action })
}

function abortIfNeeded(signal: AbortSignal, caller = signal, stage?: 'load' | 'commit'): void {
  if (!signal.aborted) return
  if (caller.aborted) throw new AgentSdkError(
    stage === 'commit' ? 'Memory commit outcome is unknown after cancellation' : 'Memory operation was aborted',
    stage === 'commit' ? MEMORY_OPERATION_ERROR_CODES.COMMIT_OUTCOME_UNKNOWN : MEMORY_OPERATION_ERROR_CODES.ABORTED,
  )
  throw new AgentSdkError(
    stage === 'commit' ? 'Memory commit outcome is unknown after its deadline' : 'Memory load exceeded its deadline',
    stage === 'commit' ? MEMORY_OPERATION_ERROR_CODES.COMMIT_OUTCOME_UNKNOWN : MEMORY_OPERATION_ERROR_CODES.LOAD_TIMEOUT,
  )
}

function memoryFailure(
  signal: AbortSignal,
  operationSignal: AbortSignal,
  stage: 'load' | 'commit',
  commitDispatched = false,
): AgentSdkError {
  if (!operationSignal.aborted) return new AgentSdkError(
    `Memory ${stage} did not complete`,
    stage === 'load' ? MEMORY_OPERATION_ERROR_CODES.LOAD_FAILED : MEMORY_OPERATION_ERROR_CODES.COMMIT_FAILED,
  )
  if (stage === 'commit' && commitDispatched) return new AgentSdkError(
    'Memory commit outcome is unknown after cancellation or deadline',
    MEMORY_OPERATION_ERROR_CODES.COMMIT_OUTCOME_UNKNOWN,
  )
  if (signal.aborted) return new AgentSdkError(
    'Memory operation was aborted', MEMORY_OPERATION_ERROR_CODES.ABORTED,
  )
  return new AgentSdkError(
    `Memory ${stage} exceeded its deadline${stage === 'commit' ? ' before dispatch' : ''}`,
    stage === 'load' ? MEMORY_OPERATION_ERROR_CODES.LOAD_TIMEOUT : MEMORY_OPERATION_ERROR_CODES.COMMIT_TIMEOUT,
  )
}

function callbackScope(caller: AbortSignal, timeoutMs: number): {
  readonly signal: AbortSignal
  readonly dispose: () => void
} {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error('Memory callback deadline exceeded')), timeoutMs)
  return Object.freeze({
    signal: AbortSignal.any([caller, deadline.signal]),
    dispose: () => clearTimeout(timer),
  })
}

function raceSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { release(); reject(signal.reason) }
    const release = (): void => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { release(); resolve(value) },
      error => { release(); reject(error) },
    )
  })
}
