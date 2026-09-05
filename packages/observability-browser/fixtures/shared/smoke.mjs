import { trace } from '@opentelemetry/api'
import {
  ModelAdapter, createAgentRuntime, createCoreSpan, createObservationRunScope, createOperationId,
} from '@ai-agent-sdk/core'
import { createObservability } from '@ai-agent-sdk/core/observability'
import {
  BROWSER_OBSERVATION_ERROR_CODES,
  IndexedDbObservationExporter,
  indexedDbObservationExporter,
  installBrowserObservabilityLifecycle,
} from '@ai-agent-sdk/observability-browser'
import { createOpenTelemetryBridge } from '@ai-agent-sdk/observability-otel'

class RuntimeAdapter extends ModelAdapter {
  async * stream() {
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function otelFixture() {
  const spans = []
  const tracer = {
    startSpan(_name, _options, parentContext) {
      const parent = trace.getSpanContext(parentContext)
      const context = { traceId: parent?.traceId ?? 'a'.repeat(32),
        spanId: (spans.length + 1).toString(16).padStart(16, '0'), traceFlags: 0 }
      const span = { spanContext: () => context, setAttribute: () => span,
        setAttributes: () => span, addEvent: () => span, addLink: () => span,
        addLinks: () => span, setStatus: () => span, updateName: () => span,
        end: () => undefined, isRecording: () => true, recordException: () => undefined }
      spans.push(span)
      return span
    },
  }
  const instrument = { add: () => undefined, record: () => undefined }
  const meter = { createCounter: () => instrument, createHistogram: () => instrument }
  return { spans, bridge: createOpenTelemetryBridge({ tracer, meter }) }
}

async function runtimeComposition(databaseName) {
  let opens = 0
  const factory = { open(...args) { opens++; return indexedDB.open(...args) } }
  const exporter = indexedDbObservationExporter({ databaseName, indexedDB: factory })
  const runtimeInert = opens === 0
  const { spans, bridge } = otelFixture()
  const adapter = new RuntimeAdapter()
  const runtime = await createAgentRuntime({
    providers: [{ kind: 'model-provider-plugin', apiVersion: 1, id: 'browser-fixture',
      displayName: 'Browser fixture', family: 'fixture', routes: ['browser-fixture'],
      defaultModel: { provider: 'browser-fixture', id: 'fixture-model' },
      setup(registrar) { registrar.registerAdapter(['browser-fixture'], adapter) } }],
    observability: { mode: 'reliable', openSpan: bridge.openSpan,
      processors: [bridge.processor], exporters: [{ exporter, ownership: 'owned',
        requirement: 'required', boundary: 'local-durable' }] },
  })
  const response = await runtime.agent({ id: 'browser-agent', instructions: 'Reply.',
    compaction: false }).generate('browser runtime fixture')
  const inspector = new IndexedDbObservationExporter({ databaseName })
  await inspector.ready()
  const stats = await inspector.stats()
  const visibleEvents = await inspector.recoverEvents()
  const batches = await inspector.pendingBatchIds()
  let acknowledged = 0
  for (const batch of batches) acknowledged += await inspector.acknowledgeBatch(batch)
  await runtime.close()
  await inspector.shutdown(new AbortController().signal)
  return { runtimeInert, runtimeDurable: response.report.delivery.complete,
    runtimeTerminalStored: stats.eventCount > visibleEvents.length,
    runtimeAcknowledged: acknowledged === stats.eventCount && acknowledged > 0,
    runtimeSpans: spans.length > 0 }
}

function event(sequence, priority = 'critical', runId = 'browser-run', data = { status: 'success' }) {
  const scope = createObservationRunScope()
  return {
    schemaVersion: 1,
    eventId: createOperationId(),
    sequence,
    name: 'sdk.model.call',
    phase: 'end',
    occurredAt: new Date().toISOString(),
    monotonicMs: scope.monotonicMs(),
    priority,
    resource: { sdkName: 'ai-agent-sdk', sdkVersion: '0.1.0', runtime: 'browser' },
    correlation: createCoreSpan({
      name: 'sdk.model.call', runId, startedAt: new Date().toISOString(), monotonicMs: 0,
    }).correlation,
    data,
  }
}

export async function runCrashPhase(databaseName) {
  const queue = new IndexedDbObservationExporter({ databaseName })
  await queue.ready()
  const crashEvent = {
    ...event(1, 'critical', 'crash-run', { marker: 'committed-before-page-close' }),
    eventId: '11111111111111111111111111111111',
  }
  await queue.stage(crashEvent)
  return { staged: true }
}

export async function runVerifyPhase(databaseName) {
  const queue = new IndexedDbObservationExporter({ databaseName })
  await queue.ready()
  const recovered = await queue.recoverEvents()
  if (recovered.length !== 1 || recovered[0]?.data.marker !== 'committed-before-page-close') {
    throw new Error(`crash recovery mismatch: ${JSON.stringify(recovered)}`)
  }

  let duplicateRejected = false
  try {
    await queue.stage({
      ...event(9, 'critical', 'different-run', { marker: 'different' }),
      eventId: '11111111111111111111111111111111',
    })
  } catch { duplicateRejected = true }

  const observation = createObservability({
    mode: 'reliable',
    exporters: [{ exporter: queue, requirement: 'required', boundary: 'local-durable' }],
  })
  const terminal = event(2, 'critical', 'browser-run')
  const receipt = await observation.checkpoint(terminal)
  const batchIds = await queue.pendingBatchIds()
  const removed = await queue.acknowledgeBatch(batchIds[0])

  const capacity = new IndexedDbObservationExporter({
    databaseName: `${databaseName}-capacity`, maxEvents: 2, maxBytes: 1024 * 1024,
  })
  await capacity.ready()
  const verbose = event(1, 'verbose', 'capacity-run')
  const normal = event(2, 'normal', 'capacity-run')
  await capacity.stage(verbose)
  await capacity.stage(normal)
  const capacityBatchId = createOperationId()
  await capacity.export({
    schemaVersion: 1, batchId: capacityBatchId, createdAt: new Date().toISOString(),
    events: [verbose, normal],
  }, new AbortController().signal)
  await capacity.stage(event(3, 'critical', 'capacity-run'))
  await capacity.stage(event(4, 'critical', 'capacity-run'))
  let quotaCode
  try { await capacity.stage(event(5, 'critical', 'capacity-run')) }
  catch (error) { quotaCode = error?.code }
  const retainedPriorities = (await capacity.recoverEvents()).map(item => item.priority)
  const capacityBatches = (await capacity.stats()).batchCount

  const auditQueue = new IndexedDbObservationExporter({ databaseName: `${databaseName}-audit` })
  await auditQueue.ready()
  const audit = createObservability({
    mode: 'audit',
    exporters: [{ exporter: auditQueue, requirement: 'required', boundary: 'local-durable' }],
  })
  const auditReceipt = await audit.checkpoint(event(1, 'critical', 'audit-run'))

  const blockedRequest = {}
  const blockedFactory = {
    open() {
      queueMicrotask(() => blockedRequest.onblocked?.(new Event('blocked')))
      return blockedRequest
    },
  }
  const blocked = new IndexedDbObservationExporter({
    databaseName: `${databaseName}-blocked`, indexedDB: blockedFactory, openTimeoutMs: 50,
  })
  let blockedRejected = false
  try { await blocked.ready() } catch { blockedRejected = true }

  class Target extends EventTarget { visibilityState = 'visible' }
  const documentTarget = new Target()
  const pageTarget = new Target()
  let flushes = 0
  const dispose = installBrowserObservabilityLifecycle({
    flush: async () => {
      flushes++
      return { complete: true, exportedEvents: 0, pendingEvents: 0, rejectedCritical: 0, timedOut: false }
    },
  }, { document: documentTarget, page: pageTarget })
  documentTarget.visibilityState = 'hidden'
  documentTarget.dispatchEvent(new Event('visibilitychange'))
  await Promise.resolve()
  await Promise.resolve()
  pageTarget.dispatchEvent(new Event('pagehide'))
  await Promise.resolve()
  dispose()
  pageTarget.dispatchEvent(new Event('pagehide'))

  const stats = await queue.stats()
  const runtime = await runtimeComposition(`${databaseName}-runtime`)
  await observation.shutdown()
  await capacity.shutdown(new AbortController().signal)
  await audit.shutdown()
  return {
    recoveredAfterPageClose: recovered.length,
    duplicateRejected,
    durable: receipt.durable,
    boundary: receipt.boundary,
    acknowledgedEvents: removed,
    remainingEvents: stats.eventCount,
    retainedPriorities,
    capacityBatches,
    quotaCode,
    expectedQuotaCode: BROWSER_OBSERVATION_ERROR_CODES.quota,
    auditDurable: auditReceipt.durable,
    blockedRejected,
    lifecycleFlushes: flushes,
    ...runtime,
    optionalLogsAbsent: true,
    buffer: typeof globalThis.Buffer,
    process: typeof globalThis.process,
  }
}
