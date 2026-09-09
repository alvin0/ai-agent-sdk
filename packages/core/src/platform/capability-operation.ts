import type { IntegrationOperationEvidenceFields, SdkLogger } from '../logging/types.ts'
import { systemMonotonicNow, systemRandomHex, type RuntimePlatform } from './adapter.ts'
import { runtimePlatformForLogger } from './logger-platform.ts'

export const CORE_CAPABILITY_OPERATIONS = Object.freeze({
  'core-provider': Object.freeze(['setup']),
  'core-credential': Object.freeze(['resolve', 'read', 'commit']),
  'core-tool-source': Object.freeze(['snapshot']),
  'core-skill-provider': Object.freeze(['list', 'load', 'read-resource']),
  'core-memory-store': Object.freeze(['load', 'commit']),
} as const)

export type CoreCapabilityFamily = keyof typeof CORE_CAPABILITY_OPERATIONS
export type CoreCapabilityOperationName = (typeof CORE_CAPABILITY_OPERATIONS)[CoreCapabilityFamily][number]
type TerminalStatus = 'success' | 'error' | 'aborted'

export interface CoreCapabilityOperation {
  success(): void
  fail(error?: unknown): void
  abort(): void
}

export function beginCoreCapabilityOperation(
  logger: SdkLogger,
  family: CoreCapabilityFamily,
  name: CoreCapabilityOperationName,
): CoreCapabilityOperation {
  validateOperation(family, name)
  const platform = operationPlatform(logger)
  const operationId = platform.randomHex(16), startedAt = platform.monotonicNow()
  emit(logger, 'info', 'SDK capability operation started', {
    integrationSchemaVersion: 1, integrationFamily: family,
    integrationOperation: name, operationId, kind: 'logical-start',
  })
  const attemptId = platform.randomHex(16), attemptStartedAt = platform.monotonicNow()
  emit(logger, 'info', 'SDK capability attempt started', {
    integrationSchemaVersion: 1, integrationFamily: family,
    integrationOperation: name, operationId, kind: 'attempt-start', attemptId, attemptNumber: 1,
  })
  let terminal = false
  const finish = (status: TerminalStatus, error?: unknown): void => {
    if (terminal) return
    terminal = true
    const errorCode = status === 'error' ? safeErrorCode(error) : undefined
    emit(logger, status === 'error' ? 'error' : 'info', terminalMessage(status), {
      integrationSchemaVersion: 1, integrationFamily: family,
      integrationOperation: name, operationId, kind: 'attempt-terminal', attemptId, attemptNumber: 1,
      status, durationMs: duration(platform, attemptStartedAt),
      ...(errorCode === undefined ? {} : { errorCode }),
    })
    emit(logger, status === 'error' ? 'error' : 'info', terminalMessage(status), {
      integrationSchemaVersion: 1, integrationFamily: family,
      integrationOperation: name, operationId, kind: 'logical-terminal',
      status, durationMs: duration(platform, startedAt),
      ...(errorCode === undefined ? {} : { errorCode }),
    })
  }
  return Object.freeze({ success: () => finish('success'), fail: (error: unknown) => finish('error', error),
    abort: () => finish('aborted') })
}

export function runCoreCapabilitySync<T>(
  logger: SdkLogger, family: CoreCapabilityFamily, name: CoreCapabilityOperationName,
  signal: AbortSignal | undefined, invoke: () => T,
): T {
  const operation = beginCoreCapabilityOperation(logger, family, name)
  try {
    signal?.throwIfAborted()
    const value = invoke()
    operation.success()
    return value
  } catch (error: unknown) {
    if (signal?.aborted === true) operation.abort()
    else operation.fail(error)
    throw error
  }
}

export async function runCoreCapabilityAsync<T>(
  logger: SdkLogger, family: CoreCapabilityFamily, name: CoreCapabilityOperationName,
  signal: AbortSignal | undefined, invoke: () => Promise<T>,
): Promise<T> {
  const operation = beginCoreCapabilityOperation(logger, family, name)
  try {
    signal?.throwIfAborted()
    const value = await invoke()
    signal?.throwIfAborted()
    operation.success()
    return value
  } catch (error: unknown) {
    if (signal?.aborted === true) operation.abort()
    else operation.fail(error)
    throw error
  }
}

export function runCoreCapabilityMaybeAsync<T>(
  logger: SdkLogger, family: CoreCapabilityFamily, name: CoreCapabilityOperationName,
  signal: AbortSignal | undefined, invoke: () => T,
): T {
  const operation = beginCoreCapabilityOperation(logger, family, name)
  try {
    signal?.throwIfAborted()
    const value = invoke()
    const pending = captureThenable(value)
    if (pending !== undefined) {
      return pending.then(result => {
        if (signal?.aborted === true) {
          operation.abort()
          signal.throwIfAborted()
        }
        operation.success()
        return result
      }, error => {
        if (signal?.aborted === true) operation.abort(); else operation.fail(error)
        throw error
      }) as T
    }
    operation.success()
    return value
  } catch (error: unknown) {
    if (signal?.aborted === true) operation.abort(); else operation.fail(error)
    throw error
  }
}

function emit(logger: SdkLogger, level: 'info' | 'error', message: string,
  fields: IntegrationOperationEvidenceFields): void {
  try { logger[level](message, fields) } catch { /* diagnostics never replace capability results */ }
}

function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    for (const key of ['code', 'name']) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key)
      if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string') {
        const clean = descriptor.value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 128)
        if (clean.length > 0) return clean
      }
    }
  }
  return 'CAPABILITY_OPERATION_FAILED'
}

function operationPlatform(logger: SdkLogger): Pick<RuntimePlatform, 'monotonicNow' | 'randomHex'> {
  return runtimePlatformForLogger(logger) ?? Object.freeze({
    monotonicNow: systemMonotonicNow,
    randomHex: systemRandomHex,
  })
}

function duration(platform: Pick<RuntimePlatform, 'monotonicNow'>, startedAt: number): number {
  const value = platform.monotonicNow() - startedAt
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function validateOperation(family: CoreCapabilityFamily, name: CoreCapabilityOperationName): void {
  const operations = CORE_CAPABILITY_OPERATIONS[family] as readonly string[] | undefined
  if (typeof family !== 'string' || family.length < 1 || family.length > 64
    || typeof name !== 'string' || name.length < 1 || name.length > 64
    || operations === undefined || !operations.includes(name)) {
    throw new TypeError('Invalid core capability operation')
  }
}

function captureThenable<T>(value: T): Promise<Awaited<T>> | undefined {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined
  const then = Reflect.get(value as object, 'then')
  if (typeof then !== 'function') return undefined
  return new Promise<Awaited<T>>((resolve, reject) => {
    try { Reflect.apply(then, value, [resolve, reject]) }
    catch (error) { reject(error) }
  })
}

function terminalMessage(status: TerminalStatus): string {
  return status === 'success' ? 'SDK capability operation completed'
    : status === 'error' ? 'SDK capability operation failed' : 'SDK capability operation aborted'
}
