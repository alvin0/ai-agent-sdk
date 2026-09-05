import type { ObservationBoundary } from '../../observation/index.ts'
import { COMPOSITION_LIMITS } from '../common/config.ts'
import { arrayData, boundedText, capturedMethod, capturedOptionalMethod, objectValue, ownData } from '../common/data.ts'
import { checkPreflightAbort, invalidPreflight } from '../common/errors.ts'
import { EXPORTER_BOUNDARIES } from './config.ts'
import { capabilityIdentityConflict } from '../identity/error.ts'
import type { ObservationDeliveryAck, ObservationDeliveryBatch, ObservationExportItem } from './delivery-types.ts'
import {
  OBSERVATION_EXPORTER_API_VERSION, type ExporterMetadata, type ExporterRegistrationMetadata,
  type ObservationExporterPlugin, type RuntimeObservationExporterRegistration,
} from './types.ts'

export interface ExporterIdentityPlan {
  readonly registrations: readonly ExporterRegistrationMetadata[]
}
const sourcesByPlan = new WeakMap<ExporterIdentityPlan, readonly object[]>()
const methodsByPlan = new WeakMap<ExporterIdentityPlan, readonly RuntimeObservationExporterRegistration[]>()

function boundary(value: unknown): ObservationBoundary {
  if (!EXPORTER_BOUNDARIES.includes(value as ObservationBoundary)) throw new TypeError('Invalid observation boundary')
  return value as ObservationBoundary
}

export function exporterMetadata(source: object): ExporterMetadata {
  const id = boundedText(ownData(source, 'id'), COMPOSITION_LIMITS.identityBytes)
  const supportedBoundaries = arrayData(ownData(source, 'supportedBoundaries'), EXPORTER_BOUNDARIES.length).map(boundary)
  if (supportedBoundaries.length === 0 || new Set(supportedBoundaries).size !== supportedBoundaries.length) {
    throw new TypeError('Exporter boundaries must be non-empty and unique')
  }
  return Object.freeze({ id, supportedBoundaries: Object.freeze(supportedBoundaries) })
}

export function captureExporter(source: object, metadata: ExporterMetadata, signal?: AbortSignal): ObservationExporterPlugin {
  checkPreflightAbort(signal)
  const ready = capturedOptionalMethod<[AbortSignal], Promise<void>>(source, 'ready')
  checkPreflightAbort(signal)
  const stage = capturedOptionalMethod<[ObservationExportItem], void | Promise<void>>(source, 'stage')
  checkPreflightAbort(signal)
  const send = capturedMethod<[ObservationDeliveryBatch, AbortSignal], Promise<ObservationDeliveryAck>>(source, 'export')
  checkPreflightAbort(signal)
  const shutdown = capturedOptionalMethod<[AbortSignal], Promise<void>>(source, 'shutdown')
  checkPreflightAbort(signal)
  return Object.freeze({
    kind: 'observation-exporter', apiVersion: OBSERVATION_EXPORTER_API_VERSION, ...metadata,
    ...(ready === undefined ? {} : { ready }), ...(stage === undefined ? {} : { stage }),
    export: send, ...(shutdown === undefined ? {} : { shutdown }),
  })
}

/** Entire metadata pass is inert: no lifecycle method lookup and no ownership transfer. */
export function preflightExporterIdentities(input: unknown, signal?: AbortSignal): ExporterIdentityPlan {
  checkPreflightAbort(signal)
  const failures = new Set<unknown>()
  const fail = (error: Error): never => { failures.add(error); throw error }
  try {
    const sources: object[] = []
    const ids = new Map<string, number>()
    const registrations = arrayData(input, COMPOSITION_LIMITS.exporters).map((input, index) => {
      checkPreflightAbort(signal)
      const registration = objectValue(input)
      const source = objectValue(ownData(registration, 'exporter'))
      if (ownData(source, 'kind', false) !== 'observation-exporter') fail(invalidPreflight('CAPABILITY_KIND_MISMATCH'))
      if (ownData(source, 'apiVersion', false) !== OBSERVATION_EXPORTER_API_VERSION) fail(invalidPreflight('CAPABILITY_API_UNSUPPORTED'))
      const exporter = exporterMetadata(source)
      const first = ids.get(exporter.id)
      if (first !== undefined) fail(invalidPreflight('CAPABILITY_ID_CONFLICT',
        capabilityIdentityConflict('observation-exporter-id', first, index)))
      ids.set(exporter.id, index)
      const ownership = ownData(registration, 'ownership')
      const requirement = ownData(registration, 'requirement')
      const selected = boundary(ownData(registration, 'boundary'))
      if (ownership !== 'owned' && ownership !== 'borrowed') throw new TypeError('Explicit exporter ownership is required')
      if (requirement !== 'required' && requirement !== 'best-effort') throw new TypeError('Invalid exporter requirement')
      if (!exporter.supportedBoundaries.includes(selected)) fail(invalidPreflight('OBSERVATION_BOUNDARY_UNSUPPORTED'))
      sources.push(source)
      return Object.freeze({ exporter, ownership, requirement, boundary: selected })
    })
    checkPreflightAbort(signal)
    const plan = Object.freeze({ registrations: Object.freeze(registrations) })
    sourcesByPlan.set(plan, Object.freeze(sources))
    return plan
  } catch (error) {
    checkPreflightAbort(signal)
    if (failures.has(error)) throw error
    throw invalidPreflight()
  }
}

/** Only after all runtime provider/exporter identities have passed. A failed capture cannot be retried. */
export function captureExporterMethods(plan: ExporterIdentityPlan, signal?: AbortSignal): readonly RuntimeObservationExporterRegistration[] {
  checkPreflightAbort(signal)
  const previous = methodsByPlan.get(plan)
  if (previous !== undefined) return previous
  const sources = sourcesByPlan.get(plan)
  if (sources === undefined) throw invalidPreflight()
  sourcesByPlan.delete(plan)
  try {
    const registrations = Object.freeze(plan.registrations.map((registration, index) => {
      checkPreflightAbort(signal)
      return Object.freeze({ ...registration, exporter: captureExporter(sources[index]!, registration.exporter, signal) })
    }))
    checkPreflightAbort(signal)
    methodsByPlan.set(plan, registrations)
    return registrations
  } catch {
    checkPreflightAbort(signal)
    throw invalidPreflight()
  }
}
