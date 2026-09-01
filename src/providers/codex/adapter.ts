/** Node compatibility wrapper over the injected-store Universal Codex provider. */

import type { ModelProviderPlugin, ModelProviderRegistrar } from '@ai-agent-sdk/core'
import {
  CODEX_BASE_URL,
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  codexAdapter as universalCodexAdapter,
  type CodexAdapterOptions as UniversalCodexAdapterOptions,
  type CodexAuthStore,
} from '@ai-agent-sdk/provider-codex'
import type { HttpModelAdapter } from '@ai-agent-sdk/provider-http'
import { fileCodexAuthStore } from './auth-file.ts'

export { CODEX_BASE_URL, CODEX_CLIENT_VERSION, CODEX_ORIGINATOR }

export interface CodexAdapterOptions extends Omit<UniversalCodexAdapterOptions, 'authStore'> {
  /** Omit only in the Node compatibility wrapper to use the project-local file store. */
  readonly authStore?: CodexAuthStore
}

export interface CodexPluginOptions extends CodexAdapterOptions {
  readonly routes?: readonly string[]
}

export function codexAdapter(options: CodexAdapterOptions = {}): HttpModelAdapter {
  return universalCodexAdapter({
    ...options,
    authStore: options.authStore ?? fileCodexAuthStore(),
  })
}

export function codexPlugin(options: CodexPluginOptions = {}): ModelProviderPlugin {
  const routes = Object.freeze([...(options.routes ?? ['codex'])])
  const adapter = codexAdapter(options)
  return Object.freeze({
    id: 'codex', displayName: 'Codex',
    setup: (registrar: ModelProviderRegistrar) => { registrar.registerAdapter(routes, adapter) },
  })
}
