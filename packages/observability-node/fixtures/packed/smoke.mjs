import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreSpan, createObservationRunScope, createOperationId } from '@ai-agent-sdk/core'
import { createObservability } from '@ai-agent-sdk/observability'
import {
  JsonlObservationJournalExporter,
} from '@ai-agent-sdk/observability-node/journal'
import {
  createDiagnosticWireLogger,
} from '@ai-agent-sdk/observability-node/diagnostic'

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
  console.log('node-packed:pass')
} finally {
  await rm(root, { recursive: true, force: true })
}
