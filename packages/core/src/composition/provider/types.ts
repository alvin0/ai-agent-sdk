import type { ModelAdapter } from '../../contract/adapter.ts'
import type { SdkLogger } from '../../logging/types.ts'
import type {
  AdapterRegistrationHandle, ModelProviderPlugin, ModelProviderRegistrar, StreamMiddleware,
} from '../../plugin/provider-plugin.ts'

export const PROVIDER_PLUGIN_API_VERSION = 1 as const

export interface ModelTarget {
  readonly provider: string
  readonly id: string
}

export interface RuntimeProviderInfo {
  readonly id: string
  readonly name: string
  readonly route: string
  readonly pluginId: string
  readonly family: string
  readonly defaultModel?: ModelTarget
}

export interface ComposableModelProviderPlugin extends ModelProviderPlugin {
  readonly kind: 'model-provider-plugin'
  readonly apiVersion: typeof PROVIDER_PLUGIN_API_VERSION
  readonly family?: string
  readonly routes: readonly string[]
  readonly defaultModel?: ModelTarget
  readonly setup: (registrar: ModelProviderRegistrar) => void | (() => void)
}

/** Helper-only view whose adapter registrations cannot escape predeclared route claims. */
export interface ComposableModelProviderRegistrar {
  readonly logger: SdkLogger
  registerAdapter(adapter: ModelAdapter, routes?: readonly string[]): AdapterRegistrationHandle
  use(middleware: StreamMiddleware): () => void
}

export type ProviderPluginCleanupDefinition = () => undefined
export type ModelProviderPluginDefinition = Omit<
  ComposableModelProviderPlugin,
  'kind' | 'apiVersion' | 'setup'
> & {
  readonly setup: (
    registrar: ComposableModelProviderRegistrar,
  ) => undefined | ProviderPluginCleanupDefinition
}

export interface ProviderMetadata {
  readonly id: string
  readonly displayName: string
  readonly family: string
  readonly routes: readonly string[]
  readonly defaultModel?: ModelTarget
}

export interface CapturedProvider extends ProviderMetadata {
  readonly setup: ComposableModelProviderPlugin['setup']
}

export interface ProviderSelection {
  readonly providers: readonly ProviderMetadata[]
  readonly defaultProvider?: string
}
