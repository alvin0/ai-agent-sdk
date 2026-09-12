import type { EmbeddingAdapter } from '../../embedding/adapter.ts'
import type { SdkLogger } from '../../logging/types.ts'
import type { AdapterRegistrationHandle } from '../../plugin/provider-plugin.ts'
import type { ComposableModelProviderPlugin, ModelTarget } from '../provider/types.ts'

/**
 * Contract version for the embedding plugin kind, independent of
 * `PROVIDER_PLUGIN_API_VERSION`: a new kind starts at 1 rather than forcing the
 * generation contract to move (Requirement 11.2).
 */
export const EMBEDDING_PROVIDER_PLUGIN_API_VERSION = 1 as const

/** Host-side registrar handed to an embedding plugin's `setup()`. */
export interface EmbeddingProviderRegistrar {
  registerEmbeddingAdapter(
    routes: readonly string[],
    adapter: EmbeddingAdapter,
    models?: readonly string[],
  ): AdapterRegistrationHandle
}

/**
 * An embedding provider plugin. Its `kind` is deliberately NOT
 * `'model-provider-plugin'`, so a generation host never mistakes one for the
 * other and existing generation plugins need no version bump
 * (Requirements 11.1, 11.2).
 */
export interface ComposableEmbeddingProviderPlugin {
  readonly kind: 'embedding-provider-plugin'
  readonly apiVersion: typeof EMBEDDING_PROVIDER_PLUGIN_API_VERSION
  readonly id: string
  readonly displayName: string
  readonly family?: string
  readonly routes: readonly string[]
  readonly defaultModel?: ModelTarget
  readonly setup: (registrar: EmbeddingProviderRegistrar) => void | (() => void)
}

/** Helper-only view whose registrations cannot escape predeclared route claims. */
export interface ComposableEmbeddingProviderRegistrar {
  readonly logger: SdkLogger
  registerEmbeddingAdapter(
    adapter: EmbeddingAdapter,
    options?: { readonly routes?: readonly string[]; readonly models?: readonly string[] },
  ): AdapterRegistrationHandle
}

export type EmbeddingProviderPluginCleanupDefinition = () => undefined
export type EmbeddingProviderPluginDefinition = Omit<
  ComposableEmbeddingProviderPlugin,
  'kind' | 'apiVersion' | 'setup'
> & {
  readonly setup: (
    registrar: ComposableEmbeddingProviderRegistrar,
  ) => undefined | EmbeddingProviderPluginCleanupDefinition
}

/** `RuntimeOwnerOptions.providers` accepts either kind (Requirement 11.4). */
export type ComposableRuntimeProviderPlugin =
  | ComposableModelProviderPlugin
  | ComposableEmbeddingProviderPlugin
