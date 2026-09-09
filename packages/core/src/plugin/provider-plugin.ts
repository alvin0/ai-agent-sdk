import type { ModelAdapter } from '../contract/adapter.ts'
import type { GenerateOptions } from '../contract/generate-options.ts'
import { AgentSdkError } from '../errors/agent-sdk-error.ts'
import type { ModelInvocationContext } from '../observation/report.ts'
import type { StreamChunk } from '../stream/chunk.ts'

export type StreamMiddleware = (
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
  context: ModelInvocationContext,
) => AsyncIterable<StreamChunk>

export interface AdapterRegistrationHandle {
  (): void
  replace(providers: readonly string[]): void
}

export interface ModelProviderRegistrar {
  registerAdapter(routes: readonly string[], adapter: ModelAdapter): AdapterRegistrationHandle
  use(middleware: StreamMiddleware): () => void
}

export interface ModelProviderPlugin {
  readonly id: string
  readonly displayName: string
  /** Stable provider family; legacy plugins default to their plugin id. */
  readonly family?: string
  setup(registrar: ModelProviderRegistrar): void | (() => void)
}

export interface PluginRegistrationHandle {
  (): void
  readonly pluginId: string
}

export const PLUGIN_ERROR_CODES = Object.freeze({
  INSTALL_FAILED: 'PLUGIN_INSTALL_FAILED',
  CLEANUP_FAILED: 'PLUGIN_CLEANUP_FAILED',
} as const)

export class PluginError extends AgentSdkError {
  readonly pluginId: string

  constructor(message: string, code: string, pluginId: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'PluginError'
    this.pluginId = pluginId
  }
}
