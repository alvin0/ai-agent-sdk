/**
 * Internal barrel of `composition/embedding/`.
 *
 * Names the surface the rest of `packages/core` composes against — the plugin
 * kind, startup preflight and activation, the registry, and the runtime manager
 * that hands out handles. The batching, concurrency, retry, cache and usage
 * modules stay behind `manager.ts` and `handle.ts`: they are mechanisms of one
 * `Logical_Call`, not composition surface, so they are imported directly by the
 * few modules that own them rather than re-exported here.
 *
 * @module ai-agent-sdk/core/composition/embedding
 */

export {
  activateEmbeddingProviders,
  activateRuntimeProviders,
  type RuntimeEmbeddingProviderRegistrar,
  type RuntimeProviderActivationInput,
} from './activation.ts'
export { defineEmbeddingProviderPlugin } from './definition.ts'
export {
  createEmbeddingModelHandle,
  type EmbeddingFallbackDeclaration,
  type EmbeddingHandleDependencies,
  type EmbeddingHandleOptions,
  type EmbeddingOperationScheduler,
} from './handle.ts'
export {
  RuntimeEmbedding,
  type EmbeddingAdapterResolver,
  type EmbeddingOperationAdmission,
  type RuntimeEmbeddingDependencies,
  type RuntimeEmbeddingOptions,
} from './manager.ts'
export {
  EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
  type ComposableEmbeddingProviderPlugin,
  type ComposableEmbeddingProviderRegistrar,
  type ComposableRuntimeProviderPlugin,
  type EmbeddingProviderPluginCleanupDefinition,
  type EmbeddingProviderPluginDefinition,
  type EmbeddingProviderRegistrar,
} from './plugin-types.ts'
export {
  captureEmbeddingMethods,
  createEmbeddingIdentityPlan,
  preflightRuntimeProviders,
  type CapturedEmbeddingProvider,
  type EmbeddingIdentityPlan,
  type ProviderPreflightFailure,
  type RuntimeProviderPlan,
} from './preflight.ts'
export { EmbeddingRegistry, type EmbeddingRegistration } from './registry.ts'
