/** Node compatibility wrapper over @ai-agent-sdk/provider-anthropic. */

import type { ModelProviderPlugin, ModelProviderRegistrar } from '@ai-agent-sdk/core'
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_VERSION,
  DEFAULT_THINKING_BUDGETS,
  anthropicAdapter as universalAnthropicAdapter,
  type AnthropicAdapterOptions as UniversalAnthropicAdapterOptions,
  type AnthropicCredential,
} from '@ai-agent-sdk/provider-anthropic'
import type { HttpModelAdapter } from '@ai-agent-sdk/provider-http'
import { apiKeyFromEnv } from '../env-credential.ts'

export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY'
export { ANTHROPIC_BASE_URL, ANTHROPIC_VERSION, DEFAULT_THINKING_BUDGETS }
export type { AnthropicCredential }

export interface AnthropicAdapterOptions extends Omit<UniversalAnthropicAdapterOptions, 'apiKey'> {
  /** Omit only in the Node compatibility wrapper to read `ANTHROPIC_API_KEY`. */
  readonly apiKey?: AnthropicCredential
}

export interface AnthropicPluginOptions extends AnthropicAdapterOptions {
  readonly routes?: readonly string[]
}

export function anthropicAdapter(options: AnthropicAdapterOptions = {}): HttpModelAdapter {
  return universalAnthropicAdapter({
    ...options,
    apiKey: options.apiKey ?? apiKeyFromEnv(ANTHROPIC_API_KEY_ENV),
  })
}

export function anthropicPlugin(options: AnthropicPluginOptions = {}): ModelProviderPlugin {
  const routes = Object.freeze([...(options.routes ?? ['anthropic'])])
  const adapter = anthropicAdapter(options)
  return Object.freeze({
    id: 'anthropic', displayName: 'Anthropic',
    setup: (registrar: ModelProviderRegistrar) => { registrar.registerAdapter(routes, adapter) },
  })
}
