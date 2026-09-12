import { checkPreflightAbort } from './common/errors.ts'
import {
  captureEmbeddingMethods, preflightRuntimeProviders,
  type CapturedEmbeddingProvider, type RuntimeProviderPlan,
} from './embedding/preflight.ts'
import { captureExporterMethods, preflightExporterIdentities } from './exporter/preflight.ts'
import type { RuntimeObservationExporterRegistration } from './exporter/types.ts'
import { captureProviderMethods } from './provider/preflight.ts'
import type { CapturedProvider, ProviderSelection } from './provider/types.ts'

export type { ProviderPreflightFailure, RuntimeProviderPlan } from './embedding/preflight.ts'

export interface RuntimeCapabilityPlan {
  readonly selection: ProviderSelection
  readonly providers: readonly CapturedProvider[]
  /** Embedding plugins, captured but not yet activated (Requirement 11.6). */
  readonly embeddingProviders: readonly CapturedEmbeddingProvider[]
  readonly exporters: readonly RuntimeObservationExporterRegistration[]
}

/**
 * The whole runtime identity pass must finish before the first executable property
 * is read.
 *
 * `providers` is swept as ONE list across both plugin kinds, so every identity
 * failure in it is reported together and no plugin method is read while any of
 * them stands (Requirement 11.6).
 */
export function preflightRuntimeCapabilities(
  providers: unknown, exporters: unknown, defaultProvider?: unknown, signal?: AbortSignal,
): RuntimeCapabilityPlan {
  checkPreflightAbort(signal)
  const providerPlan: RuntimeProviderPlan = preflightRuntimeProviders(providers, defaultProvider, signal)
  const exporterPlan = preflightExporterIdentities(exporters, signal)
  const capturedProviders = captureProviderMethods(providerPlan.generation, signal)
  const capturedEmbedding = captureEmbeddingMethods(providerPlan.embedding, signal)
  const capturedExporters = captureExporterMethods(exporterPlan, signal)
  return Object.freeze({
    selection: providerPlan.generation, providers: capturedProviders,
    embeddingProviders: capturedEmbedding, exporters: capturedExporters,
  })
}
