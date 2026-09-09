import type { IntegrationOperationEvidenceFields, SdkLogger } from '@alvin0/ai-agent-sdk-core/observability'

type OperationName = 'request' | 'close'
type Status = 'success' | 'error' | 'aborted'

export interface EvidenceAttempt {
  success(): void
  fail(code?: string): void
  abort(): void
}
export interface EvidenceOperation {
  attempt(number: number): EvidenceAttempt
  success(): void
  fail(code?: string): void
  abort(): void
}

export function beginStdioServerOperation(
  logger: SdkLogger | undefined, name: OperationName,
): EvidenceOperation {
  const operationId = crypto.randomUUID(), startedAt = performance.now()
  emit(logger, 'info', 'SDK integration operation started', {
    integrationSchemaVersion: 1, integrationFamily: 'mcp-stdio-server',
    integrationOperation: name, operationId, kind: 'logical-start',
  })
  let terminal = false
  const finish = (status: Status, code?: string): void => {
    if (terminal) return
    terminal = true
    emit(logger, status === 'error' ? 'error' : 'info', message(status), {
      integrationSchemaVersion: 1, integrationFamily: 'mcp-stdio-server',
      integrationOperation: name, operationId, kind: 'logical-terminal', status,
      durationMs: duration(startedAt), ...(code === undefined ? {} : { errorCode: safeCode(code) }),
    })
  }
  return Object.freeze({
    attempt(number: number) {
      if (!Number.isSafeInteger(number) || number < 1) throw new TypeError('Invalid MCP stdio attempt number')
      const attemptId = crypto.randomUUID(), attemptStartedAt = performance.now()
      emit(logger, 'info', 'SDK integration attempt started', {
        integrationSchemaVersion: 1, integrationFamily: 'mcp-stdio-server',
        integrationOperation: name, operationId, kind: 'attempt-start', attemptId, attemptNumber: number,
      })
      let ended = false
      const end = (status: Status, code?: string): void => {
        if (ended) return
        ended = true
        emit(logger, status === 'error' ? 'error' : 'info', message(status), {
          integrationSchemaVersion: 1, integrationFamily: 'mcp-stdio-server',
          integrationOperation: name, operationId, kind: 'attempt-terminal', attemptId,
          attemptNumber: number, status, durationMs: duration(attemptStartedAt),
          ...(code === undefined ? {} : { errorCode: safeCode(code) }),
        })
      }
      return Object.freeze({ success: () => end('success'), fail: (code?: string) => end('error', code),
        abort: () => end('aborted') })
    },
    success: () => finish('success'), fail: (code?: string) => finish('error', code),
    abort: () => finish('aborted'),
  })
}

export function safeChildLogger(logger: SdkLogger | undefined, scope: string): SdkLogger | undefined {
  try { return logger?.child({ integrationScope: scope }) } catch { return undefined }
}

function emit(logger: SdkLogger | undefined, level: 'info' | 'error', message: string,
  fields: IntegrationOperationEvidenceFields): void {
  try { logger?.[level](message, fields) } catch { /* diagnostics do not own server lifecycle */ }
}
function duration(startedAt: number): number {
  const elapsed = performance.now() - startedAt
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0
}
function message(status: Status): string {
  return status === 'success' ? 'SDK integration operation completed'
    : status === 'error' ? 'SDK integration operation failed' : 'SDK integration operation aborted'
}
function safeCode(code: string): string {
  const normalized = code.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 128)
  return normalized.length === 0 ? 'MCP_SERVER_OPERATION_FAILED' : normalized
}
