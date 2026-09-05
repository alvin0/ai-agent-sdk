import type { ObservationBoundary } from './port.ts'

export const EXPORTER_BOUNDARIES: readonly ObservationBoundary[] = Object.freeze([
  'none', 'local-durable', 'remote-acknowledged',
])
