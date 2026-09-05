import type { ObservationBoundary } from '../../observation/index.ts'
import type { ObservationDeliveryAck, ObservationDeliveryBatch, ObservationExportItem } from './delivery-types.ts'

export const OBSERVATION_EXPORTER_API_VERSION = 1 as const

/** Distinct from the preserved marker-free advanced-bus ObservationExporter. */
export interface ObservationExporterPlugin {
  readonly kind: 'observation-exporter'
  readonly apiVersion: typeof OBSERVATION_EXPORTER_API_VERSION
  readonly id: string
  readonly supportedBoundaries: readonly ObservationBoundary[]
  readonly ready?: (signal: AbortSignal) => Promise<void>
  readonly stage?: (item: ObservationExportItem) => void | Promise<void>
  readonly export: (batch: ObservationDeliveryBatch, signal: AbortSignal) => Promise<ObservationDeliveryAck>
  readonly shutdown?: (signal: AbortSignal) => Promise<void>
}

export type ObservationExporterPluginDefinition = Omit<ObservationExporterPlugin, 'kind' | 'apiVersion'>

export interface RuntimeObservationExporterRegistration {
  readonly exporter: ObservationExporterPlugin
  readonly ownership: 'borrowed' | 'owned'
  readonly requirement: 'required' | 'best-effort'
  readonly boundary: ObservationBoundary
}

export interface ExporterMetadata {
  readonly id: string
  readonly supportedBoundaries: readonly ObservationBoundary[]
}

export interface ExporterRegistrationMetadata extends Omit<RuntimeObservationExporterRegistration, 'exporter'> {
  readonly exporter: ExporterMetadata
}
