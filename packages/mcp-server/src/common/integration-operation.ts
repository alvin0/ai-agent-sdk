import type { IntegrationOperationEvidenceFields, SdkLogger } from '@alvin0/ai-agent-sdk-core/observability'

export const MCP_SERVER_INTEGRATION_OPERATIONS = Object.freeze({
  'mcp-web-server': Object.freeze(['request', 'tool-call', 'agent-call']),
  'mcp-stdio-server': Object.freeze(['request', 'tool-call', 'agent-call', 'close']),
} as const)

export type McpServerIntegrationFamily = keyof typeof MCP_SERVER_INTEGRATION_OPERATIONS
export type McpServerIntegrationOperation =
  (typeof MCP_SERVER_INTEGRATION_OPERATIONS)[McpServerIntegrationFamily][number]

export interface IntegrationAttempt {
  success(): void
  fail(errorCode?: string): void
  abort(): void
}

export interface IntegrationOperation {
  attempt(attemptNumber: number): IntegrationAttempt
  success(): void
  fail(errorCode?: string): void
  abort(): void
}

const MESSAGES = Object.freeze({
  start: 'SDK integration operation started',
  attempt: 'SDK integration attempt started',
  success: 'SDK integration operation completed',
  failure: 'SDK integration operation failed',
  abort: 'SDK integration operation aborted',
})

export function beginIntegrationOperation(
  logger: SdkLogger | undefined,
  family: McpServerIntegrationFamily,
  operation: McpServerIntegrationOperation,
): IntegrationOperation {
  validateOperation(family, operation)
  const operationId = crypto.randomUUID(), startedAt = monotonicNow()
  emit(logger, 'info', MESSAGES.start, {
    integrationSchemaVersion: 1, integrationFamily: family,
    integrationOperation: operation, operationId, kind: 'logical-start',
  })
  let terminal = false
  const finish = (status: 'success' | 'error' | 'aborted', errorCode?: string): void => {
    if (terminal) return
    terminal = true
    emit(logger, status === 'error' ? 'error' : 'info', terminalMessage(status), {
      integrationSchemaVersion: 1, integrationFamily: family,
      integrationOperation: operation, operationId, kind: 'logical-terminal',
      status, durationMs: durationSince(startedAt),
      ...(errorCode === undefined ? {} : { errorCode: boundedCode(errorCode) }),
    })
  }
  return Object.freeze({
    attempt(attemptNumber: number) {
      if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
        throw new TypeError('integration attemptNumber must be a positive safe integer')
      }
      const attemptId = crypto.randomUUID(), attemptStartedAt = monotonicNow()
      emit(logger, 'info', MESSAGES.attempt, {
        integrationSchemaVersion: 1, integrationFamily: family,
        integrationOperation: operation, operationId, kind: 'attempt-start',
        attemptId, attemptNumber,
      })
      let attemptTerminal = false
      const finishAttempt = (status: 'success' | 'error' | 'aborted', errorCode?: string): void => {
        if (attemptTerminal) return
        attemptTerminal = true
        emit(logger, status === 'error' ? 'error' : 'info', terminalMessage(status), {
          integrationSchemaVersion: 1, integrationFamily: family,
          integrationOperation: operation, operationId, kind: 'attempt-terminal',
          attemptId, attemptNumber, status, durationMs: durationSince(attemptStartedAt),
          ...(errorCode === undefined ? {} : { errorCode: boundedCode(errorCode) }),
        })
      }
      return Object.freeze({
        success: () => finishAttempt('success'),
        fail: (code?: string) => finishAttempt('error', code),
        abort: () => finishAttempt('aborted'),
      })
    },
    success: () => finish('success'),
    fail: (code?: string) => finish('error', code),
    abort: () => finish('aborted'),
  })
}

export function integrationErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    for (const key of ['code', 'name']) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key)
      if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string') {
        return boundedCode(descriptor.value)
      }
    }
  }
  return 'INTEGRATION_ERROR'
}

export function integrationChildLogger(logger: SdkLogger | undefined, scope: string): SdkLogger | undefined {
  assertIdentity(scope, 64, 'integration scope')
  try { return logger?.child({ integrationScope: scope }) } catch { return undefined }
}

function validateOperation(family: McpServerIntegrationFamily, operation: McpServerIntegrationOperation): void {
  const operations = MCP_SERVER_INTEGRATION_OPERATIONS[family] as readonly string[] | undefined
  assertIdentity(family, 64, 'integration family')
  assertIdentity(operation, 64, 'integration operation')
  if (operations === undefined || !operations.includes(operation)) throw new TypeError('Invalid MCP integration operation')
}

function emit(logger: SdkLogger | undefined, level: 'info' | 'error', message: string,
  fields: IntegrationOperationEvidenceFields): void {
  try { logger?.[level](message, fields) } catch { /* logging never owns protocol completion */ }
}

function terminalMessage(status: 'success' | 'error' | 'aborted'): string {
  return status === 'success' ? MESSAGES.success : status === 'error' ? MESSAGES.failure : MESSAGES.abort
}
function monotonicNow(): number { return performance.now() }
function durationSince(startedAt: number): number {
  const value = monotonicNow() - startedAt
  return Number.isFinite(value) ? Math.max(0, value) : 0
}
function boundedCode(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/g, '_')
  return (normalized.length === 0 ? 'INTEGRATION_ERROR' : normalized).slice(0, 128)
}
function assertIdentity(value: string, limit: number, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) {
    throw new TypeError(`${label} must contain 1-${limit} characters`)
  }
}
