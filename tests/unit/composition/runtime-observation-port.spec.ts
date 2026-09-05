import { describe, expect, it, vi } from 'vitest'
import type { DeliveryMode } from '../../../packages/core/src/observation/index.ts'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'
import { createRuntimeResource } from '../../../packages/core/src/composition/delivery/resource.ts'
import { createRunTerminalRecord } from '../../../packages/core/src/composition/delivery/terminal.ts'
import { defineObservationExporter } from '../../../packages/core/src/composition/exporter/definition.ts'
import type { ObservationDeliveryAck, ObservationDeliveryBatch } from '../../../packages/core/src/composition/exporter/delivery-types.ts'
import type { RuntimeObservationExporterRegistration } from '../../../packages/core/src/composition/exporter/types.ts'
import { RuntimeObservationPort, type RuntimeObservationPortOptions } from '../../../packages/core/src/composition/observation/port.ts'
import { event, ledgerReport } from './delivery-fixtures.ts'

function ack(batch: ObservationDeliveryBatch): ObservationDeliveryAck {
  return { batchId: batch.id, acceptedEventIds: batch.events.map(value => value.eventId), acceptedRunIds: batch.runRecords.map(value => value.runId) }
}

function registration(
  requirement: 'required' | 'best-effort', send: (batch: ObservationDeliveryBatch, signal: AbortSignal) => unknown = ack,
  stage?: (item: unknown) => void,
): RuntimeObservationExporterRegistration {
  const boundary = 'local-durable' as const
  return { exporter: defineObservationExporter({ id: `${requirement}-exporter`, supportedBoundaries: [boundary],
    ...(stage === undefined ? {} : { stage }), export: async (batch, signal) => await send(batch, signal) as ObservationDeliveryAck }),
  requirement, ownership: 'borrowed', boundary }
}

function fixture(mode: DeliveryMode, registrations: readonly RuntimeObservationExporterRegistration[], options: RuntimeObservationPortOptions = {}) {
  const platform = createRuntimePlatform(), resources = new RuntimeResources(platform), resource = createRuntimeResource(undefined, platform)
  const port = new RuntimeObservationPort(resource, registrations, platform, resources, { ...options, mode })
  return { platform, resources, resource, port }
}

describe('runtime observation port', () => {
  it('stops admission before close while preserving one final queue drain', async () => {
    const sink = vi.fn(ack)
    const { port } = fixture('operational', [registration('best-effort', sink)])
    const logger = port.logger({ scope: 'close-race' })
    logger.info('captured before close')
    port.stopAdmission()
    logger.info('ignored after admission closes')
    expect(port.capture(event('after-close', 2))).toMatchObject({ status: 'rejected', reason: 'closed' })

    const report = await port.flush()
    expect(report).toMatchObject({ status: 'complete', targetItems: 1, pendingItems: 0 })
    expect(sink).toHaveBeenCalledTimes(1)
    port.seal()
    expect(port.health()).toMatchObject({ state: 'closed', accepted: 1, exported: 1 })
  })

  it('captures synchronously in operational mode and flushes best-effort without a durability claim', async () => {
    const sent: ObservationDeliveryBatch[] = [], target = registration('best-effort', batch => { sent.push(batch); return ack(batch) })
    const { resources, port } = fixture('operational', [target])
    const input = { ...event('operational'), data: { prompt: 'PRIVATE_PROMPT/BODY~SENTINEL%', count: 2 } }
    expect(port.capture(input)).toEqual({ eventId: input.eventId, status: 'accepted', durable: false, boundary: 'none' })
    expect(port.diagnostics()).toMatchObject({ retainedEvents: 1, evictedEvents: 0 })
    expect(JSON.stringify(port.diagnostics())).not.toContain('PRIVATE_PROMPT/BODY~SENTINEL%')
    expect(await port.flush()).toMatchObject({ complete: true, reachedBoundary: 'none' })
    expect(sent).toHaveLength(1)
    resources.close()
  })

  it('checkpoints one reliable run through the terminal event sequence', async () => {
    const sent: ObservationDeliveryBatch[] = [], target = registration('required', batch => { sent.push(batch); return ack(batch) })
    const { resources, port } = fixture('reliable', [target])
    const first = event('reliable', 1), terminal = event('reliable', 2)
    expect(port.capture(first).durable).toBe(false)
    expect(await port.checkpoint(terminal)).toEqual({ eventId: terminal.eventId, status: 'accepted', durable: true, boundary: 'local-durable' })
    expect(sent.flatMap(batch => batch.events).map(value => value.sequence)).toEqual([1, 2])
    resources.close()
  })

  it('stages and checkpoints an atomic terminal record without self-delivery state', async () => {
    const sent: ObservationDeliveryBatch[] = [], target = registration('required', batch => { sent.push(batch); return ack(batch) })
    const { resources, port } = fixture('reliable', [target])
    port.capture(event('terminal-run', 1))
    const record = createRunTerminalRecord(await ledgerReport('terminal-run'))
    expect(record).not.toHaveProperty('delivery')
    const result = await port.checkpointTerminal(record)
    expect(result).toMatchObject({ runId: 'terminal-run', status: 'accepted', durable: true, boundary: 'local-durable',
      delivery: { requiredComplete: true, complete: true, targetItems: 2 } })
    expect(sent.flatMap(batch => batch.runRecords)).toEqual([record])
    expect(sent.flatMap(batch => batch.runRecords)[0]).toBe(record)
    expect(record).not.toHaveProperty('delivery')
    resources.close()
  })

  it('returns support-safe rejection when required export or caller cancellation prevents a checkpoint', async () => {
    const failed = fixture('audit', [registration('required', () => { throw new Error('PRIVATE_EXPORT/BODY~SENTINEL%') })])
    const receipt = await failed.port.checkpoint(event('failed'))
    expect(receipt).toEqual({ eventId: receipt.eventId, status: 'rejected', durable: false, boundary: 'none', reason: 'exporter-unavailable' })
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_EXPORT/BODY~SENTINEL%')
    failed.resources.close()

    const cancelled = fixture('reliable', [registration('required')]), controller = new AbortController(); controller.abort('PRIVATE_ABORT')
    expect(await cancelled.port.checkpoint(event('cancelled'), controller.signal)).toMatchObject({ status: 'rejected', reason: 'exporter-unavailable' })
    cancelled.resources.close()
  })

  it('reports capacity and closed admission without calling staging', () => {
    const stage = vi.fn(), target = registration('best-effort', ack, stage)
    const { resources, port } = fixture('operational', [target], { maxEvents: 1 })
    const first = event('capacity', 1), second = event('capacity', 2)
    expect(port.capture(first).status).toBe('accepted')
    expect(port.capture(second)).toMatchObject({ status: 'rejected', reason: 'capacity' })
    expect(stage).toHaveBeenCalledTimes(1)
    port.seal(); port.seal()
    expect(port.capture(event('closed'))).toMatchObject({ status: 'rejected', reason: 'closed' })
    expect(stage).toHaveBeenCalledTimes(1)
    resources.close()
  })

  it('does not duplicate diagnostics or staging when checkpoint sees an already captured event', async () => {
    const stage = vi.fn(), target = registration('required', ack, stage)
    const { resources, port } = fixture('reliable', [target]), terminal = event('duplicate')
    port.capture(terminal)
    expect(await port.checkpoint(terminal)).toMatchObject({ status: 'accepted', durable: true })
    expect(port.diagnostics()).toMatchObject({ retainedEvents: 1 })
    expect(stage).toHaveBeenCalledTimes(1)
    resources.close()
  })

  it('keeps diagnostic and exporter queue capacities independent', () => {
    const { resources, port } = fixture('operational', [], { maxEvents: 2, diagnosticMaxEvents: 1 })
    const first = event('diagnostics', 1), second = event('diagnostics', 2)
    port.capture(first); port.capture(second)
    expect(port.diagnostics()).toMatchObject({ retainedEvents: 1, evictedEvents: 1 })
    expect(port.diagnostics().events.map(value => value.eventId)).toEqual([second.eventId])
    resources.close()
  })

  it('bounds contained staging failures independently from queue evidence', () => {
    const target = registration('best-effort', ack, () => { throw new Error('PRIVATE_STAGE/BODY~SENTINEL%') })
    const { resources, port } = fixture('operational', [target], { maxEvents: 100 })
    for (let index = 0; index < 70; index++) expect(port.capture(event('stage-errors', index + 1)).status).toBe('accepted')
    expect(port.stagingFailureSnapshot()).toHaveLength(64)
    expect(JSON.stringify(port.stagingFailureSnapshot())).not.toContain('PRIVATE_STAGE/BODY~SENTINEL%')
    expect(Object.isFrozen(port.stagingFailureSnapshot())).toBe(true)
    resources.close()
  })

  it('uses a core span with valid generated correlation', () => {
    const { resources, port } = fixture('operational', [])
    const span = port.openSpan({ name: 'sdk.agent.run', runId: 'run', startedAt: new Date().toISOString(), monotonicMs: 0 })
    expect(span.correlation).toMatchObject({ runId: 'run', parentSpanId: null })
    expect(span.correlation.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(span.correlation.spanId).toMatch(/^[0-9a-f]{16}$/)
    resources.close()
  })

  it('runs privacy-safe processors before admission and contains processor/span backend failures', () => {
    const processor = { id: 'annotate', transform: vi.fn((input: ReturnType<typeof event>) => ({
      ...input, data: { ...input.data, processed: true, prompt: 'PRIVATE_PROCESSOR_PROMPT_91af' },
    })) }
    const processed = fixture('operational', [], { processors: [processor] })
    const input = event('processed')
    expect(processed.port.capture(input)).toMatchObject({ status: 'accepted' })
    expect(processed.port.diagnostics().events[0]?.data).toEqual({ status: 'success', processed: true })
    expect(processor.transform).toHaveBeenCalledOnce()
    processed.resources.close()

    const failed = fixture('operational', [], { processors: [{ id: 'broken', transform() {
      throw new Error('PRIVATE_PROCESSOR_FAILURE/5d2c~SENTINEL%')
    } }], openSpan() { throw new Error('PRIVATE_SPAN_FAILURE/39aa~SENTINEL%') } })
    expect(failed.port.capture(event('processor-failed'))).toMatchObject({
      status: 'rejected', reason: 'processor-failed', durable: false, boundary: 'none',
    })
    const span = failed.port.openSpan({ name: 'sdk.agent.run', runId: 'fallback-run',
      startedAt: new Date().toISOString(), monotonicMs: 0 })
    expect(span.correlation.runId).toBe('fallback-run')
    expect(failed.port.health()).toMatchObject({ state: 'degraded', processorFailures: 2,
      lastFailure: { code: 'OBSERVATION_PROCESSOR_FAILED' } })
    expect(JSON.stringify(failed.port.health())).not.toContain('PRIVATE_PROCESSOR_FAILURE/5d2c~SENTINEL%')
    expect(JSON.stringify(failed.port.health())).not.toContain('PRIVATE_SPAN_FAILURE/39aa~SENTINEL%')
    failed.resources.close()
  })

  it('validates delivery mode topology before accepting runtime work', () => {
    expect(() => fixture('operational', [registration('required')])).toThrow('Operational observation exporters must be best-effort')
    expect(() => fixture('reliable', [])).toThrow('reliable observation requires a durable required exporter')
    expect(() => fixture('audit', [registration('best-effort')])).toThrow('audit observation requires a durable required exporter')
    expect(() => fixture('invalid' as DeliveryMode, [])).toThrow('Invalid observation delivery mode')
  })

  it('keeps terminal admission separate in operational mode', async () => {
    const { resources, port } = fixture('operational', [])
    const record = createRunTerminalRecord(await ledgerReport('local-terminal'))
    expect(await port.checkpointTerminal(record)).toEqual({ runId: 'local-terminal', status: 'accepted', durable: false, boundary: 'none' })
    expect(record).not.toHaveProperty('delivery')
    resources.close()
  })

  it('projects immutable queue/export health and the combined diagnostic snapshot', async () => {
    const target = registration('best-effort'), { resources, resource, port } = fixture('operational', [target])
    expect(port.health()).toMatchObject({ state: 'healthy', queuedEvents: 0, accepted: 0, exported: 0,
      integrationEvidence: { accepted: 0, filtered: 0, dropped: 0, rejected: 0 } })
    port.capture(event('health'))
    expect(port.health()).toMatchObject({ state: 'healthy', queuedEvents: 1, accepted: 1, exported: 0 })
    await port.flush()
    const health = port.health(), diagnostics = port.diagnostics()
    expect(health).toMatchObject({ state: 'healthy', queuedEvents: 0, accepted: 1, exported: 1 })
    expect(health.lastExportAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(diagnostics.resource).toBe(resource)
    expect(diagnostics.observationHealth).toEqual(health)
    expect(Object.isFrozen(health)).toBe(true)
    expect(Object.isFrozen(health.integrationEvidence)).toBe(true)
    resources.close()
  })

  it('classifies eviction/staging as degraded, critical rejection as failed and seal as closed', () => {
    const degradedTarget = registration('best-effort', ack, () => { throw new Error('PRIVATE_STAGE') })
    const degraded = fixture('operational', [degradedTarget], { maxEvents: 1 })
    degraded.port.capture({ ...event('degraded', 1), priority: 'normal' })
    degraded.port.capture({ ...event('degraded', 2), priority: 'normal' })
    expect(degraded.port.health()).toMatchObject({ state: 'degraded', droppedNormal: 1, exporterFailures: 2,
      lastFailure: { code: 'OBSERVABILITY_EXPORT_FAILED' } })
    degraded.port.seal()
    expect(degraded.port.health().state).toBe('closed')
    degraded.resources.close()

    const failed = fixture('operational', [], { maxEvents: 1 })
    failed.port.capture({ ...event('failed-health', 1), priority: 'critical' })
    failed.port.capture({ ...event('failed-health', 2), priority: 'critical' })
    expect(failed.port.health()).toMatchObject({ state: 'failed', criticalRejected: 1,
      lastFailure: { code: 'OBSERVABILITY_CAPTURE_REJECTED' } })
    failed.resources.close()
  })

  it('marks a required exporter failure as failed health without exposing its exception', async () => {
    const target = registration('required', () => { throw new Error('PRIVATE_EXPORT/BODY~SENTINEL%') })
    const { resources, port } = fixture('reliable', [target])
    await port.checkpoint(event('required-health'))
    const health = port.health()
    expect(health).toMatchObject({ state: 'failed', exporterFailures: 1,
      lastFailure: { code: 'OBSERVABILITY_EXPORT_FAILED' } })
    expect(JSON.stringify(health)).not.toContain('PRIVATE_EXPORT/BODY~SENTINEL%')
    resources.close()
  })
})
