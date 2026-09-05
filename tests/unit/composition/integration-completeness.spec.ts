import { describe, expect, it } from 'vitest'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'
import { createRuntimeResource } from '../../../packages/core/src/composition/delivery/resource.ts'
import { RuntimeObservationPort, type RuntimeObservationPortOptions } from '../../../packages/core/src/composition/observation/port.ts'
import { assessIntegrationCompleteness,
  type IntegrationCompletenessInput } from '../../../packages/core/src/composition/logging/completeness.ts'
import type { SdkLogger } from '../../../packages/core/src/observability/types.ts'
import { event } from './delivery-fixtures.ts'

const EXPECTED = Object.freeze([{
  family: 'fixture-client', operation: 'request', logicalOperations: 1, attempts: 1,
}])

function fixture(options: RuntimeObservationPortOptions = {}) {
  const platform = createRuntimePlatform(), resources = new RuntimeResources(platform)
  const port = new RuntimeObservationPort(createRuntimeResource(undefined, platform), [], platform, resources,
    { mode: 'operational', ...options })
  return { resources, port }
}

function emitComplete(logger: SdkLogger): void {
  const base = { integrationSchemaVersion: 1 as const, integrationFamily: 'fixture-client',
    integrationOperation: 'request', operationId: 'operation-1' }
  logger.info('SDK integration operation started', { ...base, kind: 'logical-start' })
  logger.info('SDK integration attempt started', { ...base, kind: 'attempt-start',
    attemptId: 'attempt-1', attemptNumber: 1 })
  logger.info('SDK integration operation completed', { ...base, kind: 'attempt-terminal',
    attemptId: 'attempt-1', attemptNumber: 1, status: 'success', durationMs: 1 })
  logger.info('SDK integration operation completed', { ...base, kind: 'logical-terminal',
    status: 'success', durationMs: 2 })
}

function input(port: RuntimeObservationPort, overrides: Partial<IntegrationCompletenessInput> = {}):
IntegrationCompletenessInput {
  const events = port.diagnostics().events
  return {
    expected: EXPECTED, events, acceptedEventIds: events.map(row => row.eventId),
    health: port.health(), source: 'authoritative-export', cleanup: 'complete', ...overrides,
  }
}

describe('integration trace completeness reconciliation', () => {
  it('certifies balanced default-info evidence only with exact event acknowledgments and cleanup', () => {
    const { resources, port } = fixture()
    emitComplete(port.logger())
    expect(assessIntegrationCompleteness(input(port))).toEqual({ status: 'complete', reason: 'complete' })
    const { acceptedEventIds: _acceptedEventIds, ...withoutAcknowledgments } = input(port)
    expect(assessIntegrationCompleteness(withoutAcknowledgments))
      .toEqual({ status: 'unknown', reason: 'delivery-acknowledgment-unavailable' })
    expect(assessIntegrationCompleteness(input(port, {
      acceptedEventIds: port.diagnostics().events.slice(0, 3).map(row => row.eventId),
    }))).toEqual({ status: 'incomplete', reason: 'delivery-acknowledgment-incomplete' })
    resources.close()
  })

  it('detects warn filtering, queue eviction and queue rejection independently', () => {
    const filtered = fixture({ minimumLogLevel: 'warn' })
    emitComplete(filtered.port.logger())
    expect(assessIntegrationCompleteness(input(filtered.port))).toEqual({ status: 'incomplete', reason: 'evidence-loss' })
    expect(filtered.port.health().integrationEvidence.filtered).toBe(4)
    filtered.resources.close()

    const evicted = fixture({ maxEvents: 1 })
    emitComplete(evicted.port.logger())
    expect(evicted.port.health().integrationEvidence.dropped).toBeGreaterThan(0)
    expect(assessIntegrationCompleteness(input(evicted.port))).toEqual({ status: 'incomplete', reason: 'evidence-loss' })
    evicted.resources.close()

    const rejected = fixture({ maxEvents: 1 })
    rejected.port.capture({ ...event('occupied'), priority: 'critical' })
    rejected.port.logger().error('SDK integration operation failed', {
      integrationSchemaVersion: 1, integrationFamily: 'fixture-client', integrationOperation: 'request',
      operationId: 'rejected', kind: 'logical-terminal', status: 'error', durationMs: 1,
    })
    expect(rejected.port.health().integrationEvidence.rejected).toBe(1)
    expect(assessIntegrationCompleteness(input(rejected.port))).toEqual({ status: 'incomplete', reason: 'evidence-loss' })
    rejected.resources.close()
  })

  it('rejects unbalanced pairing and treats an evicted diagnostic support view as unknown', () => {
    const unbalanced = fixture()
    unbalanced.port.logger().info('SDK integration operation started', {
      integrationSchemaVersion: 1, integrationFamily: 'fixture-client', integrationOperation: 'request',
      operationId: 'unbalanced', kind: 'logical-start',
    })
    expect(assessIntegrationCompleteness(input(unbalanced.port, {
      expected: [{ ...EXPECTED[0]!, attempts: 0 }],
    }))).toEqual({ status: 'incomplete', reason: 'operation-pairing-invalid' })
    unbalanced.resources.close()

    const ring = fixture({ diagnosticMaxEvents: 1 })
    emitComplete(ring.port.logger())
    const snapshot = ring.port.diagnostics()
    expect(snapshot.evictedEvents).toBeGreaterThan(0)
    expect(assessIntegrationCompleteness(input(ring.port, {
      source: 'diagnostic-ring', diagnosticEvictions: snapshot.evictedEvents,
    }))).toEqual({ status: 'unknown', reason: 'diagnostic-ring-incomplete' })
    ring.resources.close()
  })

  it('keeps missing expectations, counter overflow and teardown evidence non-successful', () => {
    const { resources, port } = fixture()
    emitComplete(port.logger())
    const { expected: _expected, ...withoutExpectations } = input(port)
    expect(assessIntegrationCompleteness(withoutExpectations))
      .toEqual({ status: 'unknown', reason: 'expected-instrumentation-unavailable' })
    expect(assessIntegrationCompleteness(input(port, { health: { integrationEvidence: {
      accepted: Number.MAX_SAFE_INTEGER, filtered: 0, dropped: 0, rejected: 0,
    } } }))).toEqual({ status: 'unknown', reason: 'evidence-counter-overflow' })
    expect(assessIntegrationCompleteness(input(port, { cleanup: 'failed' })))
      .toEqual({ status: 'incomplete', reason: 'cleanup-failed' })
    expect(assessIntegrationCompleteness(input(port, { cleanup: 'unavailable' })))
      .toEqual({ status: 'unknown', reason: 'cleanup-unavailable' })
    resources.close()
  })
})
