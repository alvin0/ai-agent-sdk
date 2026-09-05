import { MemoryObservationExporter, TestObservationExporter, createObservability } from '@ai-agent-sdk/core/observability'
import type { SdkStressContext, SdkStressScenarioResult } from '../types.ts'
import { StressChecks } from './shared.ts'

export async function observabilityPressure(context: SdkStressContext): Promise<SdkStressScenarioResult> {
  const checks = new StressChecks()
  const memory = new MemoryObservationExporter('sdk-stress-memory')
  const observation = createObservability({
    content: 'none', minimumLogLevel: 'trace',
    maxQueueEvents: 512, maxQueueBytes: 4 * 1024 * 1024,
    maxBatchEvents: 64, maxBatchBytes: 256 * 1024,
    exporters: [{ exporter: memory, requirement: 'best-effort', boundary: 'none' }],
    onHealthChange: () => { if (context.random() < 0.00001) throw new Error('contained health callback') },
  })
  const logger = observation.logger({ fields: { harness: 'sdk-stress' } })
  const emitted = context.iterations * 32
  for (let index = 0; index < emitted; index++) {
    context.signal.throwIfAborted()
    if (index % 41 === 0) logger.info('pressure checkpoint', { index, prompt: 'private-prompt-probe' })
    else logger.debug('pressure verbose event', {
      index, authorization: 'Bearer private-token-probe', nested: { apiKey: 'private-key-probe' },
    })
  }
  logger.error('terminal pressure signal', { code: 'PRESSURE_COMPLETE' })
  const before = observation.health()
  const flush = await observation.flush(context.signal)
  const after = observation.health()
  const serialized = JSON.stringify(memory.events())

  const broken = new TestObservationExporter({ id: 'sdk-stress-broken', failExports: 1, retryable: false })
  const degraded = createObservability({
    exporters: [{ exporter: broken, requirement: 'best-effort', boundary: 'none' }],
  })
  degraded.logger().info('force contained exporter failure')
  const failedFlush = await degraded.flush(context.signal)
  const degradedHealth = degraded.health()
  await degraded.shutdown().catch(() => undefined)
  await observation.shutdown(context.signal)

  checks.check('queue pressure evicts verbose events before critical events',
    before.droppedVerbose > 0 && before.criticalRejected === 0,
    `droppedVerbose=${before.droppedVerbose} criticalRejected=${before.criticalRejected}`)
  checks.check('accepted observation batches flush completely', flush.complete && after.queuedEvents === 0,
    `complete=${flush.complete} queued=${after.queuedEvents}`)
  checks.check('privacy runs before exporter fan-out',
    !serialized.includes('private-prompt-probe')
      && !serialized.includes('private-token-probe')
      && !serialized.includes('private-key-probe'))
  checks.check('best-effort exporter failure is contained and visible',
    !failedFlush.complete && degradedHealth.exporterFailures === 1 && degradedHealth.state === 'degraded',
    `complete=${failedFlush.complete} failures=${degradedHealth.exporterFailures} state=${degradedHealth.state}`)
  context.artifact.record('observation-health', { before, after, degraded: degradedHealth, flush, failedFlush })
  return Object.freeze({
    invariants: checks.items(),
    metrics: Object.freeze({
      emitted, exported: memory.events().length, droppedVerbose: before.droppedVerbose,
      droppedNormal: before.droppedNormal, criticalRejected: before.criticalRejected,
      exporterFailures: degradedHealth.exporterFailures,
    }),
  })
}
