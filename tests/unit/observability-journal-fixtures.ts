import { createCoreSpan, createOperationId, type ObservationEvent } from '@alvin0/ai-agent-sdk-core'
import type { FileHandle } from 'node:fs/promises'
import { vi } from 'vitest'

export function event(sequence: number): ObservationEvent {
  return { schemaVersion: 1, eventId: createOperationId(), sequence, name: 'sdk.model.call',
    phase: 'point', occurredAt: new Date().toISOString(), monotonicMs: 0, priority: 'normal',
    resource: { sdkName: 'ai-agent-sdk', sdkVersion: 'test', runtime: 'node' },
    correlation: createCoreSpan({ name: 'sdk.model.call', runId: 'retention',
      startedAt: new Date().toISOString(), monotonicMs: 0 }).correlation, data: {} }
}

export function batch(batchId: string, events: readonly ObservationEvent[]) {
  return { schemaVersion: 1 as const, batchId, createdAt: new Date().toISOString(), events }
}

export function holdJournalSync(handle: FileHandle, failure?: Error) {
  let release!: () => void
  let start!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { start = resolve })
  const datasync = handle.datasync.bind(handle)
  vi.spyOn(handle, 'datasync').mockImplementation(async () => {
    start()
    await gate
    if (failure !== undefined) throw failure
    await datasync()
  })
  return { started, release }
}
