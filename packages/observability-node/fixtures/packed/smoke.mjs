import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreSpan, createObservationRunScope, createOperationId } from '@alvin0/ai-agent-sdk-core'
import { createObservability } from '@alvin0/ai-agent-sdk-core/observability'
import {
  JsonlObservationJournalExporter,
  jsonlObservationExporter,
} from '@alvin0/ai-agent-sdk-observability-node/journal'
import {
  createDiagnosticWireLogger,
} from '@alvin0/ai-agent-sdk-observability-node/diagnostic'

const root = await mkdtemp(join(tmpdir(), 'ai-agent-sdk-node-packed-'))
try {
  const journal = new JsonlObservationJournalExporter({ rootDir: join(root, 'journal'), mode: 'audit' })
  await journal.ready()
  const observation = createObservability({
    mode: 'audit',
    exporters: [{ exporter: journal, requirement: 'required', boundary: 'local-durable' }],
  })
  const scope = createObservationRunScope()
  const event = {
    schemaVersion: 1,
    eventId: createOperationId(),
    sequence: scope.nextSequence(),
    name: 'sdk.model.call',
    phase: 'end',
    occurredAt: new Date().toISOString(),
    monotonicMs: scope.monotonicMs(),
    priority: 'critical',
    resource: { sdkName: 'ai-agent-sdk', sdkVersion: '0.1.0', runtime: 'node' },
    correlation: createCoreSpan({
      name: 'sdk.model.call', runId: 'packed-node-run',
      startedAt: new Date().toISOString(), monotonicMs: 0,
    }).correlation,
    data: { status: 'success', prompt: 'removed-before-node-journal' },
  }
  const receipt = await observation.checkpoint(event)
  const recovered = await journal.recover()
  assert.equal(receipt.durable, true)
  assert.equal(receipt.boundary, 'local-durable')
  assert.equal(recovered.records.length, 1)
  assert.equal(JSON.stringify(recovered.records).includes('removed-before-node-journal'), false)
  const [segment] = (await readdir(join(root, 'journal'))).filter(name => name.endsWith('.jsonl'))
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(root, 'journal'))).mode & 0o777, 0o700)
    assert.equal((await stat(join(root, 'journal', segment))).mode & 0o777, 0o600)
  }
  assert.throws(() => createDiagnosticWireLogger({
    rootDir: join(root, 'wire'), content: 'metadata', allowWireBodies: true,
  }), /content: 'full'/i)
  await observation.shutdown()

  const runtimeRoot = join(root, 'runtime-journal')
  const runtimeExporter = jsonlObservationExporter({
    rootDir: runtimeRoot,
    mode: 'reliable',
    segmentId: () => 'runtime001',
  })
  assert.equal(runtimeExporter.kind, 'observation-exporter')
  assert.equal(runtimeExporter.apiVersion, 1)
  await assert.rejects(access(runtimeRoot))
  const signal = new AbortController().signal
  await runtimeExporter.ready(signal)
  const terminal = {
    kind: 'run-terminal-record',
    runId: 'packed-node-run',
    traceId: event.correlation.traceId,
    startedAt: event.occurredAt,
    endedAt: event.occurredAt,
    durationMs: 0,
    status: 'success',
    usage: { reported: {}, coverage: { complete: true, missingModelCallIds: [] }, authoritative: true },
    modelCalls: [],
    toolSourceSnapshots: [],
    operationCounts: {},
    errors: [],
  }
  const delivery = {
    id: 'packed-runtime-batch',
    resource: event.resource,
    events: [event],
    runRecords: [terminal],
  }
  await runtimeExporter.stage(event)
  await runtimeExporter.stage(terminal)
  assert.deepEqual(await runtimeExporter.export(delivery, signal), {
    batchId: delivery.id,
    acceptedEventIds: [event.eventId],
    acceptedRunIds: [terminal.runId],
  })
  await runtimeExporter.shutdown(signal)
  const deliveryRoot = join(runtimeRoot, 'runtime-delivery')
  const [deliverySegment] = (await readdir(deliveryRoot)).filter(name => name.endsWith('.jsonl'))
  const deliveryFrames = (await readFile(join(deliveryRoot, deliverySegment), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(deliveryFrames.map(frame => frame.itemKind), ['event', 'run-terminal-record'])
  assert.equal(deliveryFrames.some(frame => frame.payloadJson.includes('delivery')), false)
  if (process.platform !== 'win32') {
    assert.equal((await stat(deliveryRoot)).mode & 0o777, 0o700)
    assert.equal((await stat(join(deliveryRoot, deliverySegment))).mode & 0o777, 0o600)
  }

  const reopened = jsonlObservationExporter({
    rootDir: runtimeRoot,
    mode: 'reliable',
    segmentId: () => 'runtime002',
  })
  await reopened.ready(signal)
  assert.deepEqual(await reopened.export(delivery, signal), {
    batchId: delivery.id,
    acceptedEventIds: [event.eventId],
    acceptedRunIds: [terminal.runId],
  })
  await reopened.shutdown(signal)
  console.log('node-packed:pass')
} finally {
  await rm(root, { recursive: true, force: true })
}
