import type { IntegrationOperationEvidenceFields, SdkLogger } from '@alvin0/ai-agent-sdk-core/observability'

export const A2A_INTEGRATION_OPERATIONS = Object.freeze({
  'a2a-client-link': Object.freeze(['agent-card-resolve', 'link', 'send', 'stream', 'unlink']),
  'a2a-server': Object.freeze(['request', 'execute', 'cancel', 'dispose']),
} as const)

export type A2AIntegrationFamily = keyof typeof A2A_INTEGRATION_OPERATIONS
export type A2AIntegrationOperationName = (typeof A2A_INTEGRATION_OPERATIONS)[A2AIntegrationFamily][number]
type TerminalStatus = 'success' | 'error' | 'aborted'

export interface A2AIntegrationAttempt {
  success(): void
  fail(errorCode?: string): void
  abort(): void
}

export interface A2AIntegrationOperation extends A2AIntegrationAttempt {
  attempt(attemptNumber: number): A2AIntegrationAttempt
}

export function beginA2AIntegrationOperation(
  logger: SdkLogger | undefined,
  family: A2AIntegrationFamily,
  operation: A2AIntegrationOperationName,
): A2AIntegrationOperation {
  assertIdentity(operation, 64, 'integration operation')
  const operationId = crypto.randomUUID(), startedAt = now()
  log(logger, 'info', 'SDK integration operation started', {
    integrationSchemaVersion: 1, integrationFamily: family,
    integrationOperation: operation, operationId, kind: 'logical-start',
  })
  let terminal = false
  const finish = (status: TerminalStatus, errorCode?: string): void => {
    if (terminal) return
    terminal = true
    log(logger, status === 'error' ? 'error' : 'info', message(status), {
      integrationSchemaVersion: 1, integrationFamily: family,
      integrationOperation: operation, operationId, kind: 'logical-terminal',
      status, durationMs: elapsed(startedAt),
      ...(errorCode === undefined ? {} : { errorCode: boundedCode(errorCode) }),
    })
  }
  return {
    attempt(attemptNumber) {
      if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
        throw new TypeError('integration attemptNumber must be a positive safe integer')
      }
      const attemptId = crypto.randomUUID(), attemptStartedAt = now()
      log(logger, 'info', 'SDK integration attempt started', {
        integrationSchemaVersion: 1, integrationFamily: family,
        integrationOperation: operation, operationId, kind: 'attempt-start',
        attemptId, attemptNumber,
      })
      let ended = false
      const end = (status: TerminalStatus, errorCode?: string): void => {
        if (ended) return
        ended = true
        log(logger, status === 'error' ? 'error' : 'info', message(status), {
          integrationSchemaVersion: 1, integrationFamily: family,
          integrationOperation: operation, operationId, kind: 'attempt-terminal',
          attemptId, attemptNumber, status, durationMs: elapsed(attemptStartedAt),
          ...(errorCode === undefined ? {} : { errorCode: boundedCode(errorCode) }),
        })
      }
      return { success: () => end('success'), fail: code => end('error', code), abort: () => end('aborted') }
    },
    success: () => finish('success'),
    fail: code => finish('error', code),
    abort: () => finish('aborted'),
  }
}

export function a2aErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    for (const key of ['code', 'name']) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key)
      if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string') {
        return boundedCode(descriptor.value)
      }
    }
  }
  return 'A2A_OPERATION_FAILED'
}

export function a2aIntegrationChildLogger(logger: SdkLogger | undefined, scope: string): SdkLogger | undefined {
  assertIdentity(scope, 64, 'integration scope')
  try { return logger?.child({ integrationScope: scope }) } catch { return undefined }
}

function log(logger: SdkLogger | undefined, level: 'info' | 'error', message: string,
  fields: IntegrationOperationEvidenceFields): void {
  try { logger?.[level](message, fields) } catch { /* diagnostic observers never own operation correctness */ }
}
function now(): number { return globalThis.performance?.now() ?? Date.now() }
function elapsed(startedAt: number): number {
  const value = now() - startedAt
  return Number.isFinite(value) ? Math.max(0, value) : 0
}
function message(status: TerminalStatus): string {
  return status === 'success' ? 'SDK integration operation completed'
    : status === 'error' ? 'SDK integration operation failed' : 'SDK integration operation aborted'
}
function boundedCode(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/g, '_')
  return (normalized.length === 0 ? 'A2A_OPERATION_FAILED' : normalized).slice(0, 128)
}
function assertIdentity(value: string, limit: number, label: string): void {
  if (value.length === 0 || value.length > limit) throw new TypeError(`${label} must contain 1-${limit} characters`)
}
