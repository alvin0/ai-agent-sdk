import { checkPreflightAbort } from './common/errors.ts'
import { captureExporterMethods, preflightExporterIdentities } from './exporter/preflight.ts'
import type { RuntimeObservationExporterRegistration } from './exporter/types.ts'
import { captureProviderMethods, preflightProviderIdentities } from './provider/preflight.ts'
import type { CapturedProvider, ProviderSelection } from './provider/types.ts'

export interface RuntimeCapabilityPlan {
  readonly selection: ProviderSelection
  readonly providers: readonly CapturedProvider[]
  readonly exporters: readonly RuntimeObservationExporterRegistration[]
}

/** The whole runtime identity pass must finish before the first executable property is read. */
export function preflightRuntimeCapabilities(
  providers: unknown, exporters: unknown, defaultProvider?: unknown, signal?: AbortSignal,
): RuntimeCapabilityPlan {
  checkPreflightAbort(signal)
  const providerPlan = preflightProviderIdentities(providers, defaultProvider, signal)
  const exporterPlan = preflightExporterIdentities(exporters, signal)
  const capturedProviders = captureProviderMethods(providerPlan, signal)
  const capturedExporters = captureExporterMethods(exporterPlan, signal)
  return Object.freeze({ selection: providerPlan, providers: capturedProviders, exporters: capturedExporters })
}
