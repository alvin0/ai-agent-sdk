import { describe, expect, it } from 'vitest'
import type { IntegrationOperationEvidenceFields, SdkLogger } from '@alvin0/ai-agent-sdk-core/observability'
import {
  MCP_INTEGRATION_OPERATIONS,
  beginIntegrationOperation,
  type McpIntegrationFamily,
  type McpIntegrationOperationName,
} from '../../packages/mcp/src/common/integration-operation.ts'
import {
  A2A_INTEGRATION_OPERATIONS,
  beginA2AIntegrationOperation,
  type A2AIntegrationFamily,
  type A2AIntegrationOperationName,
} from '../../packages/a2a/src/common/integration-operation.ts'
import { RecordingLogger, type RecordedLogEntry } from './fixtures/integration-logger.ts'

const EXPECTED_MATRIX = Object.freeze({
  'mcp-http-client': ['connect', 'authenticate', 'catalog-refresh', 'reconnect', 'tool-call', 'close'],
  'mcp-stdio-client': ['connect', 'catalog-refresh', 'reconnect', 'tool-call', 'close'],
  'mcp-web-server': ['request', 'tool-call', 'agent-call'],
  'mcp-stdio-server': ['request', 'tool-call', 'agent-call', 'close'],
  'a2a-client-link': ['agent-card-resolve', 'link', 'send', 'stream', 'unlink'],
  'a2a-server': ['request', 'execute', 'cancel', 'dispose'],
} as const)

describe('first-party integration operation evidence', () => {
  it('freezes the exact six-family, 27-operation matrix', () => {
    const matrix = { ...MCP_INTEGRATION_OPERATIONS, ...A2A_INTEGRATION_OPERATIONS }
    expect(matrix).toEqual(EXPECTED_MATRIX)
    expect(Object.values(matrix).reduce((sum, operations) => sum + operations.length, 0)).toBe(27)
    expect(Object.values(matrix).every(Object.isFrozen)).toBe(true)
  })

  it('emits balanced, bounded, metadata-only success evidence for every matrix row', () => {
    const logger = new RecordingLogger()
    for (const [family, operations] of Object.entries(MCP_INTEGRATION_OPERATIONS)) {
      for (const name of operations) {
        const operation = beginIntegrationOperation(logger, family as McpIntegrationFamily,
          name as McpIntegrationOperationName)
        operation.attempt(1).success(); operation.success()
      }
    }
    for (const [family, operations] of Object.entries(A2A_INTEGRATION_OPERATIONS)) {
      for (const name of operations) {
        const operation = beginA2AIntegrationOperation(logger, family as A2AIntegrationFamily,
          name as A2AIntegrationOperationName)
        operation.attempt(1).success(); operation.success()
      }
    }
    expect(logger.entries).toHaveLength(27 * 4)
    assertCompleteEvidence(logger.entries)
    expect(new Set(logger.entries.map(entry => entry.message))).toEqual(new Set([
      'SDK integration operation started', 'SDK integration attempt started',
      'SDK integration operation completed',
    ]))
    expect(logger.entries.every(entry => entry.level === 'info')).toBe(true)
  })

  it('uses error terminals with bounded support codes and contains logger observer failures', () => {
    const logger = new RecordingLogger()
    const operation = beginIntegrationOperation(logger, 'mcp-http-client', 'connect')
    operation.attempt(1).fail(`PRIVATE CODE/${'x'.repeat(180)}`)
    operation.fail(`PRIVATE CODE/${'x'.repeat(180)}`)
    expect(logger.entries.map(entry => entry.level)).toEqual(['info', 'info', 'error', 'error'])
    for (const entry of logger.entries.slice(2)) {
      const fields = entry.fields as IntegrationOperationEvidenceFields
      const code = fields.errorCode
      expect(code).toMatch(/^PRIVATE_CODE_/)
      expect(typeof code === 'string' ? code.length : Infinity).toBeLessThanOrEqual(128)
      expect(fields).not.toHaveProperty('error')
    }

    const throwing = throwingLogger()
    expect(() => {
      const contained = beginA2AIntegrationOperation(throwing, 'a2a-client-link', 'send')
      contained.attempt(1).success(); contained.success()
    }).not.toThrow()
  })

  it('rejects invalid generated identities and attempt numbers before their row is enqueued', () => {
    const logger = new RecordingLogger()
    expect(() => beginIntegrationOperation(logger, 'mcp-http-client', '' as McpIntegrationOperationName))
      .toThrow(/1-64/)
    expect(logger.entries).toHaveLength(0)
    const operation = beginA2AIntegrationOperation(logger, 'a2a-server', 'execute')
    expect(() => operation.attempt(0)).toThrow(/positive safe integer/)
    expect(logger.entries).toHaveLength(1)
  })
})

function assertCompleteEvidence(entries: readonly RecordedLogEntry[]): void {
  const operations = new Map<string, RecordedLogEntry[]>()
  for (const entry of entries) {
    const fields = entry.fields as IntegrationOperationEvidenceFields
    expect(fields.integrationSchemaVersion).toBe(1)
    expect(fields.integrationFamily.length).toBeGreaterThan(0)
    expect(fields.integrationFamily.length).toBeLessThanOrEqual(64)
    expect(fields.integrationOperation.length).toBeGreaterThan(0)
    expect(fields.integrationOperation.length).toBeLessThanOrEqual(64)
    expect(fields.operationId.length).toBeLessThanOrEqual(128)
    if ('attemptId' in fields) {
      const attemptId = fields.attemptId
      expect(typeof attemptId).toBe('string')
      expect(typeof attemptId === 'string' ? attemptId.length : Infinity).toBeLessThanOrEqual(128)
      expect(fields.attemptNumber).toBe(1)
    }
    if ('durationMs' in fields) {
      expect(Number.isFinite(fields.durationMs)).toBe(true)
      expect(fields.durationMs).toBeGreaterThanOrEqual(0)
    }
    const key = `${fields.integrationFamily}:${fields.integrationOperation}:${fields.operationId}`
    operations.set(key, [...operations.get(key) ?? [], entry])
  }
  expect(operations).toHaveLength(27)
  for (const rows of operations.values()) {
    expect(rows.map(row => row.fields.kind)).toEqual([
      'logical-start', 'attempt-start', 'attempt-terminal', 'logical-terminal',
    ])
    expect(rows[1]!.fields.attemptId).toBe(rows[2]!.fields.attemptId)
  }
}

function throwingLogger(): SdkLogger {
  const fail = (): never => { throw new Error('PRIVATE_LOGGER_FAILURE') }
  const logger: SdkLogger = {
    child: () => logger,
    trace: fail, debug: fail, info: fail, warn: fail, error: fail, fatal: fail,
  }
  return logger
}
