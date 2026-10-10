import { type ObservationBoundary  } from '@alvin0/ai-agent-sdk-core'
import type {
  ExportAck,
  ObservationBatch,
  ObservationExporter,
} from '@alvin0/ai-agent-sdk-core/observability'
import {
  defineObservationExporter,
  type ObservationDeliveryBatch,
  type ObservationExporterPlugin,
} from '@alvin0/ai-agent-sdk-core/observability'

import { resolveOptions, type ResolvedOptions, type FetchObservationExporterOptions  } from './fetch-options.ts'
export type { FetchObservationExporterOptions } from './fetch-options.ts'
import { sendBatch  } from './fetch-send.ts'

/** A remote-acknowledged exporter using only Fetch and Web streams. */
export class FetchObservationExporter implements ObservationExporter {
  readonly id: string
  readonly supportedBoundaries: readonly ObservationBoundary[] = Object.freeze(['remote-acknowledged'])
  private readonly options: ResolvedOptions

  constructor(options: FetchObservationExporterOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('Fetch observation exporter options are required')
    }
    this.id = options.id ?? 'fetch'
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/.test(this.id)) {
      throw new TypeError('Fetch observation exporter id must be a safe 1-64 character identifier')
    }
    this.options = resolveOptions(options)
  }

  async export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck> {
    const result = await sendBatch(this.options,
      { id: batch.batchId, count: batch.events.length, value: batch }, signal)
    return Object.freeze({ batchId: batch.batchId, ...result })
  }
}

/** Recommended inert runtime exporter; transport begins only when core exports a batch. */
export function fetchObservationExporter(
  options: FetchObservationExporterOptions,
): ObservationExporterPlugin {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Fetch observation exporter options are required')
  }
  const id = options.id ?? 'fetch'
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/.test(id)) {
    throw new TypeError('Fetch observation exporter id must be a safe 1-64 character identifier')
  }
  const captured = resolveOptions(options)
  return defineObservationExporter({
    id,
    supportedBoundaries: ['remote-acknowledged'],
    async export(batch: ObservationDeliveryBatch, signal: AbortSignal) {
      const result = await sendBatch(
        captured,
        { id: batch.id, count: batch.events.length + batch.runRecords.length, value: batch },
        signal,
      )
      return Object.freeze({
        batchId: batch.id,
        acceptedEventIds: result.accepted ? batch.events.map(event => event.eventId) : [],
        acceptedRunIds: result.accepted ? batch.runRecords.map(record => record.runId) : [],
      })
    },
  })
}
