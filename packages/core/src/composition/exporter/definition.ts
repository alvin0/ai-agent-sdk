import { objectValue } from '../common/data.ts'
import { invalidPreflight } from '../common/errors.ts'
import { captureExporter, exporterMetadata } from './preflight.ts'
import type { ObservationExporterPlugin, ObservationExporterPluginDefinition } from './types.ts'

/** A new frozen execution view, not a resource acquisition or mutation of the caller. */
export function defineObservationExporter(definition: ObservationExporterPluginDefinition): ObservationExporterPlugin {
  try {
    const source = objectValue(definition)
    return captureExporter(source, exporterMetadata(source))
  } catch { throw invalidPreflight() }
}
