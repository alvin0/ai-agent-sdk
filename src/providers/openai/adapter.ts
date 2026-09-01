/** Node compatibility wrapper over @ai-agent-sdk/provider-openai. */

import type { ModelProviderPlugin, ModelProviderRegistrar } from '@ai-agent-sdk/core'
import {
  OPENAI_BASE_URL,
  openAiAdapter as universalOpenAiAdapter,
  type OpenAiAdapterOptions as UniversalOpenAiAdapterOptions,
  type OpenAiCredential,
} from '@ai-agent-sdk/provider-openai'
import type { HttpModelAdapter } from '@ai-agent-sdk/provider-http'
import { apiKeyFromEnv } from '../env-credential.ts'

export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY'
export { OPENAI_BASE_URL }
export type { OpenAiCredential }

export interface OpenAiAdapterOptions extends Omit<UniversalOpenAiAdapterOptions, 'apiKey'> {
  /** Omit only in the Node compatibility wrapper to read `OPENAI_API_KEY`. */
  readonly apiKey?: OpenAiCredential
}

export interface OpenAiPluginOptions extends OpenAiAdapterOptions {
  readonly routes?: readonly string[]
}

export function openAiAdapter(options: OpenAiAdapterOptions = {}): HttpModelAdapter {
  return universalOpenAiAdapter({
    ...options,
    apiKey: options.apiKey ?? apiKeyFromEnv(OPENAI_API_KEY_ENV),
  })
}

export function openAiPlugin(options: OpenAiPluginOptions = {}): ModelProviderPlugin {
  const routes = Object.freeze([...(options.routes ?? ['openai'])])
  const adapter = openAiAdapter(options)
  return Object.freeze({
    id: 'openai', displayName: 'OpenAI',
    setup: (registrar: ModelProviderRegistrar) => { registrar.registerAdapter(routes, adapter) },
  })
}
