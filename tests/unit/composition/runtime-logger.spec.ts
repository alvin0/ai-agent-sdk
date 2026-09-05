import { describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '../../../packages/core/src/primitives/index.ts'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'
import { createRuntimeResource } from '../../../packages/core/src/composition/delivery/resource.ts'
import { RuntimeObservationPort, type RuntimeObservationPortOptions } from '../../../packages/core/src/composition/observation/port.ts'
import { event } from './delivery-fixtures.ts'

function fixture(options: RuntimeObservationPortOptions = {}) {
  const platform = createRuntimePlatform(), resources = new RuntimeResources(platform), resource = createRuntimeResource(undefined, platform)
  const port = new RuntimeObservationPort(resource, [], platform, resources, { mode: 'operational', ...options })
  return { platform, resources, resource, port }
}

function integration(kind: 'logical-start' | 'attempt-start' | 'attempt-terminal' | 'logical-terminal' = 'logical-start'): JsonObject {
  return { integrationSchemaVersion: 1, integrationFamily: 'mcp', integrationOperation: 'tool-call', operationId: 'operation-1', kind,
    ...(kind === 'attempt-start' || kind === 'attempt-terminal' ? { attemptId: 'attempt-1', attemptNumber: 1 } : {}),
    ...(kind === 'attempt-terminal' || kind === 'logical-terminal' ? { status: 'success', durationMs: 4 } : {}) }
}

describe('runtime-bound logger', () => {
  it('binds generated resource/correlation, stable child context and increasing sequence', () => {
    const { resources, resource, port } = fixture(), logger = port.logger({ scope: 'application', fields: { component: 'chat' } })
    const child = logger.child({ action: 'send' })
    logger.info('started'); child.warn('continued')
    const [first, second] = port.diagnostics().events
    expect(first!.resource).toBe(resource)
    expect(second!.resource).toBe(resource)
    expect(first!.correlation).toEqual(second!.correlation)
    expect([first!.sequence, second!.sequence]).toEqual([1, 2])
    expect(first!.priority).toBe('normal')
    expect(second!.data).toMatchObject({ level: 'warn', scope: 'application', fields: { component: 'chat', action: 'send' } })
    resources.close()
  })

  it('maps log levels to priority and filters before allocating an event', () => {
    const { resources, port } = fixture({ minimumLogLevel: 'info' }), logger = port.logger()
    logger.trace('trace'); logger.debug('debug'); logger.info('info'); logger.warn('warn'); logger.error('error'); logger.fatal('fatal')
    expect(port.diagnostics().events.map(value => [value.data.level, value.priority])).toEqual([
      ['info', 'normal'], ['warn', 'normal'], ['error', 'critical'], ['fatal', 'critical'],
    ])
    expect(port.integrationEvidenceSnapshot()).toEqual({ accepted: 0, filtered: 0, dropped: 0, rejected: 0 })
    resources.close()
  })

  it('privacy-processes bound fields before retaining them and redacts inline message credentials', () => {
    const { resources, port } = fixture(), source = {
      authorization: 'Bearer PRIVATE_AUTH/VALUE~SENTINEL%',
      prompt: 'PRIVATE_PROMPT/BODY~SENTINEL%',
      nested: { password: 'PRIVATE_PASSWORD/VALUE~SENTINEL%' },
    }
    const logger = port.logger({ fields: source })
    source.nested.password = 'changed'
    logger.info('authorization=PRIVATE_INLINE/VALUE~SENTINEL%', {
      body: 'PRIVATE_LOG/BODY~SENTINEL%', count: 2,
    })
    const rendered = JSON.stringify(port.diagnostics().events)
    expect(rendered).not.toContain('PRIVATE_AUTH/VALUE~SENTINEL%')
    expect(rendered).not.toContain('PRIVATE_PROMPT/BODY~SENTINEL%')
    expect(rendered).not.toContain('PRIVATE_PASSWORD/VALUE~SENTINEL%')
    expect(rendered).not.toContain('PRIVATE_LOG/BODY~SENTINEL%')
    expect(rendered).not.toContain('PRIVATE_INLINE/VALUE~SENTINEL%')
    expect(rendered).toContain('[REDACTED]')
    resources.close()
  })

  it('rejects accessors, cycles, classes, sparse arrays and correlation/resource spoof fields without invoking getters', () => {
    const { resources, port } = fixture(), get = vi.fn(() => 'secret'), cycle: Record<string, unknown> = {}; cycle.self = cycle
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get })
    for (const context of [
      { fields: accessor }, { fields: cycle }, { fields: { date: new Date() } }, { fields: { sparse: new Array(1) } },
      { resource: {} }, Object.defineProperty({}, 'scope', { get }),
    ]) expect(() => port.logger(context as never)).toThrow()
    expect(get).not.toHaveBeenCalled()
    expect(port.diagnostics().retainedEvents).toBe(0)
    resources.close()
  })

  it('counts valid integration evidence before filtering and after admission', () => {
    const filtered = fixture({ minimumLogLevel: 'warn' }), filteredLogger = filtered.port.logger()
    filteredLogger.info('integration start', integration())
    expect(filtered.port.integrationEvidenceSnapshot()).toEqual({ accepted: 0, filtered: 1, dropped: 0, rejected: 0 })
    expect(filtered.port.diagnostics().retainedEvents).toBe(0)
    filtered.resources.close()

    const accepted = fixture(), acceptedLogger = accepted.port.logger()
    acceptedLogger.info('integration start', integration())
    expect(accepted.port.integrationEvidenceSnapshot()).toEqual({ accepted: 1, filtered: 0, dropped: 0, rejected: 0 })
    expect(accepted.port.health().integrationEvidence).toEqual({ accepted: 1, filtered: 0, dropped: 0, rejected: 0 })
    accepted.resources.close()
  })

  it.each(['marker', 'attempt', 'terminal', 'code'] as const)('rejects invalid integration %s as evidence instead of an ordinary log', variant => {
    const { resources, port } = fixture(), fields: Record<string, unknown> = { ...integration('attempt-terminal') }
    if (variant === 'marker') fields.integrationSchemaVersion = 2
    if (variant === 'attempt') fields.attemptNumber = 0
    if (variant === 'terminal') fields.durationMs = -1
    if (variant === 'code') fields.errorCode = 'x'.repeat(129)
    expect(() => port.logger().info('invalid integration', fields as JsonObject)).toThrow('Invalid integration evidence')
    expect(port.integrationEvidenceSnapshot()).toEqual({ accepted: 0, filtered: 0, dropped: 0, rejected: 1 })
    expect(port.diagnostics().retainedEvents).toBe(0)
    resources.close()
  })

  it('keeps accepted cumulative evidence when the queue later evicts that log', () => {
    const { resources, port } = fixture({ maxEvents: 1 }), logger = port.logger()
    logger.info('integration start', integration())
    logger.info('ordinary replacement')
    expect(port.integrationEvidenceSnapshot()).toEqual({ accepted: 1, filtered: 0, dropped: 1, rejected: 0 })
    expect(port.diagnostics().retainedEvents).toBe(2)
    resources.close()
  })

  it('counts a valid critical integration log rejected by queue capacity', () => {
    const { resources, port } = fixture({ maxEvents: 1 })
    port.capture({ ...event('full'), priority: 'critical' })
    port.logger().error('integration terminal', integration('logical-terminal'))
    expect(port.integrationEvidenceSnapshot()).toEqual({ accepted: 0, filtered: 0, dropped: 0, rejected: 1 })
    resources.close()
  })

  it('becomes a no-op after close before reading context, messages or fields', () => {
    const { resources, port } = fixture(), get = vi.fn(() => { throw new Error('PRIVATE_GETTER') })
    port.seal()
    const logger = port.logger(Object.defineProperty({}, 'fields', { get }))
    expect(() => logger.info(undefined as never, Object.defineProperty({}, 'value', { get }) as never)).not.toThrow()
    expect(logger.child(Object.defineProperty({}, 'value', { get }) as never)).toBe(logger)
    expect(get).not.toHaveBeenCalled()
    resources.close()
  })

  it('validates scope, message and minimum-level bounds without changing compiler/runtime policy', () => {
    const active = fixture()
    expect(() => active.port.logger({ scope: '' })).toThrow()
    expect(() => active.port.logger().info('x'.repeat(2_049))).toThrow('Invalid runtime log message')
    active.resources.close()
    expect(() => fixture({ minimumLogLevel: 'invalid' as never })).toThrow('Invalid minimum log level')
  })
})
