import {
  defineObservationExporter,
  type ObservationExporterPlugin,
  type ObservationExportItem,
  type ObservationDeliveryBatch,
} from '@ai-agent-sdk/core/observability'
import type { JsonlObservationJournalOptions } from './types.ts'
import { join } from 'node:path'
import { ensureSafeRoot } from '../common/safe-filesystem.ts'
import { JOURNAL_FILES } from './config.ts'
import { journalFailure } from './errors.ts'
import { captureRuntimeJournalOptions } from './runtime-options.ts'
import {
  RuntimeJsonlJournal,
  recoverRuntimeJournal,
  type RuntimeJournalRecoveryResult,
} from './runtime-store.ts'

export type { RuntimeJournalRecoveryResult } from './runtime-store.ts'
export type { RuntimeJournalRecord as RuntimeJournalRecoveryRecord } from './runtime-frame.ts'

/** Recommended runtime adapter. The advanced marker-free journal remains independent. */
export function jsonlObservationExporter(
  options: JsonlObservationJournalOptions,
): ObservationExporterPlugin {
  const captured = captureRuntimeJournalOptions(options)
  let journal: RuntimeJsonlJournal | undefined
  let readiness: Promise<void> | undefined

  const ready = (signal: AbortSignal): Promise<void> => {
    if (readiness !== undefined) return readiness
    const created = new RuntimeJsonlJournal(captured)
    journal = created
    readiness = created.ready(signal)
    void readiness.catch(() => undefined)
    return readiness
  }

  const requiredJournal = (): RuntimeJsonlJournal => {
    if (journal === undefined) throw journalFailure('io', 'runtime observation exporter is not ready')
    return journal
  }

  return defineObservationExporter({
    id: captured.id,
    supportedBoundaries: captured.supportedBoundaries,
    ready,
    stage(item: ObservationExportItem) { return requiredJournal().stage(item) },
    export(batch: ObservationDeliveryBatch, signal: AbortSignal) {
      return requiredJournal().export(batch, signal)
    },
    async shutdown(signal: AbortSignal) {
      if (journal === undefined) return
      await readiness?.catch(() => undefined)
      await journal.shutdown(signal)
    },
  })
}

/** Verify and recover records written by the recommended runtime exporter. */
export async function recoverRuntimeObservationJournal(
  rootDir: string,
): Promise<RuntimeJournalRecoveryResult> {
  const parent = await ensureSafeRoot(rootDir)
  const root = await ensureSafeRoot(join(parent, JOURNAL_FILES.runtimeDirectory))
  return recoverRuntimeJournal(root)
}
