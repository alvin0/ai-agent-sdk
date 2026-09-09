import type { IntegrationOperationEvidenceFields, SdkLogger } from '@alvin0/ai-agent-sdk-core/observability'

export const MCP_INTEGRATION_OPERATIONS = Object.freeze({
  'mcp-http-client': Object.freeze(['connect', 'authenticate', 'catalog-refresh', 'reconnect', 'tool-call', 'close']),
  'mcp-stdio-client': Object.freeze(['connect', 'catalog-refresh', 'reconnect', 'tool-call', 'close']),
  'mcp-web-server': Object.freeze(['request', 'tool-call', 'agent-call']),
  'mcp-stdio-server': Object.freeze(['request', 'tool-call', 'agent-call', 'close']),
} as const)

export type McpIntegrationFamily = keyof typeof MCP_INTEGRATION_OPERATIONS
export type McpIntegrationOperationName = (typeof MCP_INTEGRATION_OPERATIONS)[McpIntegrationFamily][number]

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

const START_MESSAGE = 'SDK integration operation started'
const ATTEMPT_START_MESSAGE = 'SDK integration attempt started'
const SUCCESS_MESSAGE = 'SDK integration operation completed'
const FAILURE_MESSAGE = 'SDK integration operation failed'
const ABORT_MESSAGE = 'SDK integration operation aborted'

export function beginIntegrationOperation(
  logger: SdkLogger | undefined,
  family: McpIntegrationFamily,
  operation: McpIntegrationOperationName,
): IntegrationOperation {
  assertIdentity(operation, 64, 'integration operation')
  const operationId = operationIdentity()
  const startedAt = monotonicNow()
  emit(logger, 'info', START_MESSAGE, {
    integrationSchemaVersion: 1, integrationFamily: family,
    integrationOperation: operation, operationId, kind: 'logical-start',
  })
  let terminal = false
  const finish = (status: 'success' | 'error' | 'aborted', errorCode?: string): void => {
    if (terminal) return
    terminal = true
    const fields: IntegrationOperationEvidenceFields = {
      integrationSchemaVersion: 1, integrationFamily: family,
      integrationOperation: operation, operationId, kind: 'logical-terminal',
      status, durationMs: durationSince(startedAt),
      ...(errorCode === undefined ? {} : { errorCode: boundedCode(errorCode) }),
    }
    emit(logger, status === 'error' ? 'error' : 'info',
      status === 'success' ? SUCCESS_MESSAGE : status === 'error' ? FAILURE_MESSAGE : ABORT_MESSAGE,
      fields)
  }
  return {
    attempt(attemptNumber) {
      if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
        throw new TypeError('integration attemptNumber must be a positive safe integer')
      }
      const attemptId = operationIdentity(), attemptStartedAt = monotonicNow()
      emit(logger, 'info', ATTEMPT_START_MESSAGE, {
        integrationSchemaVersion: 1, integrationFamily: family,
        integrationOperation: operation, operationId, kind: 'attempt-start',
        attemptId, attemptNumber,
      })
      let attemptTerminal = false
      const finishAttempt = (status: 'success' | 'error' | 'aborted', errorCode?: string): void => {
        if (attemptTerminal) return
        attemptTerminal = true
        emit(logger, status === 'error' ? 'error' : 'info',
          status === 'success' ? SUCCESS_MESSAGE : status === 'error' ? FAILURE_MESSAGE : ABORT_MESSAGE, {
            integrationSchemaVersion: 1, integrationFamily: family,
            integrationOperation: operation, operationId, kind: 'attempt-terminal',
            attemptId, attemptNumber, status, durationMs: durationSince(attemptStartedAt),
            ...(errorCode === undefined ? {} : { errorCode: boundedCode(errorCode) }),
          })
      }
      return {
        success: () => finishAttempt('success'),
        fail: code => finishAttempt('error', code),
        abort: () => finishAttempt('aborted'),
      }
    },
    success: () => finish('success'),
    fail: code => finish('error', code),
    abort: () => finish('aborted'),
  }
}

export function integrationErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = Object.getOwnPropertyDescriptor(error, 'code')
    if (code !== undefined && 'value' in code && typeof code.value === 'string') return boundedCode(code.value)
    const name = Object.getOwnPropertyDescriptor(error, 'name')
    if (name !== undefined && 'value' in name && typeof name.value === 'string') return boundedCode(name.value)
  }
  return 'INTEGRATION_ERROR'
}

export function integrationChildLogger(logger: SdkLogger | undefined, scope: string): SdkLogger | undefined {
  assertIdentity(scope, 64, 'integration scope')
  try { return logger?.child({ integrationScope: scope }) } catch { return undefined }
}

function emit(
  logger: SdkLogger | undefined,
  level: 'info' | 'error',
  message: string,
  fields: IntegrationOperationEvidenceFields,
): void {
  try { logger?.[level](message, fields) } catch { /* diagnostic observers never own operation correctness */ }
}

function operationIdentity(): string {
  return globalThis.crypto.randomUUID()
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now()
}

function durationSince(startedAt: number): number {
  const value = monotonicNow() - startedAt
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function boundedCode(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/g, '_')
  return (normalized.length === 0 ? 'INTEGRATION_ERROR' : normalized).slice(0, 128)
}

function assertIdentity(value: string, limit: number, label: string): void {
  if (value.length === 0 || value.length > limit) throw new TypeError(`${label} must contain 1-${limit} characters`)
}
