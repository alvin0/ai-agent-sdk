/**
 * The Codex provider: the Responses API behind the ChatGPT-backed Codex endpoint,
 * authenticated with this project's own credential store.
 *
 * Useful because it needs no API key and no billing setup — a ChatGPT subscription
 * plus `npm run provider:codex:login-device` is the whole setup, which makes it the
 * cheapest way to run real integration tests.
 *
 * This is also the proof that the configuration path scales: Codex has the most
 * demanding requirements of any provider here — OAuth with proactive token refresh,
 * account-scoped headers, endpoint-driven model discovery, and a reduced request
 * schema — and it still needs no adapter subclass. `auth: { kind: 'dynamic' }` is
 * what makes OAuth expressible as data.
 *
 * One thing to be deliberate about: this endpoint exists to serve the Codex CLI and
 * identifies its client with an `originator` header. Sending `codex_cli_rs` is what
 * makes the backend accept the request, so that is the default — but it IS
 * presenting as another client, so it is a named option rather than a hidden
 * constant. Use your own account, and prefer the `openai` provider for production.
 *
 * @module ai-agent-sdk/providers/codex/adapter
 */

import type { ModelProviderPlugin, ModelProviderRegistrar } from '@alvin0/ai-agent-sdk-core'
import {
  defineModelProviderPlugin,
  type ComposableModelProviderPlugin,
  type ModelTarget,

} from '@alvin0/ai-agent-sdk-core/provider'
import type {
  HttpModelAdapter,
} from '@alvin0/ai-agent-sdk-provider-http'
import { captureCodexStore, type CapturedCodexStore } from './common/store-capture.ts'
import type {
  CodexAdapterOptions,
  CodexRevisionedAdapterOptions,
  CodexPluginOptions,
  CodexProviderOptions,

} from './adapter-types.ts'
export { CODEX_BASE_URL, CODEX_ORIGINATOR, CODEX_CLIENT_VERSION } from './adapter-types.ts'
export type {
  CodexAdapterOptions,
  CodexRevisionedAdapterOptions,
  CodexPluginOptions,
  CodexProviderOptions,

} from './adapter-types.ts'
import { legacyCodexAdapter, runtimeCodexAdapter } from './adapter-build.ts'

export function codexAdapter(options: CodexRevisionedAdapterOptions): HttpModelAdapter
export function codexAdapter(options: CodexAdapterOptions): HttpModelAdapter
export function codexAdapter(
  options: CodexAdapterOptions | CodexRevisionedAdapterOptions,
): HttpModelAdapter {
  const captured = captureCodexStore(options?.authStore)
  return captured.kind === 'versioned'
    ? runtimeCodexAdapter(options as CodexRevisionedAdapterOptions, captured)
    : legacyCodexAdapter(options as CodexAdapterOptions, captured)
}

export function codexPlugin(
  options: CodexProviderOptions,
): ComposableModelProviderPlugin & { readonly family: 'codex' }
export function codexPlugin(options: CodexPluginOptions): ModelProviderPlugin
export function codexPlugin(
  options: CodexProviderOptions | CodexPluginOptions,
): ModelProviderPlugin | (ComposableModelProviderPlugin & { readonly family: 'codex' }) {
  if (isVersionedStoreInput(options.authStore)) {
    const id = 'id' in options && options.id !== undefined ? options.id : 'codex'
    const routes = Object.freeze([...options.routes ?? [id]])
    return defineModelProviderPlugin({
      id,
      family: 'codex',
      displayName: 'Codex',
      routes,
      ...runtimeDefaultModel(
        'defaultModel' in options ? options.defaultModel : undefined,
        routes,
      ),
      setup(registrar) {
        const adapter = runtimeCodexAdapter(options as CodexProviderOptions)
        const remove = registrar.registerAdapter(adapter)
        return () => { remove(); return undefined }
      },
    }) as ComposableModelProviderPlugin & { readonly family: 'codex' }
  }
  return legacyCodexPlugin(options as CodexPluginOptions)
}

/** Marker inspection only; full store capture stays deferred to preferred setup. */
function isVersionedStoreInput(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')
  return kind !== undefined && 'value' in kind && kind.value === 'credential-store'
}

function legacyCodexPlugin(
  options: CodexPluginOptions,
  captured?: CapturedCodexStore,
): ModelProviderPlugin {
  const routes = Object.freeze([...(options.routes ?? ['codex'])])
  const adapter = legacyCodexAdapter(options, captured)
  return Object.freeze({
    id: 'codex',
    displayName: 'Codex',
    setup(registrar: ModelProviderRegistrar) {
      registrar.registerAdapter(routes, adapter)
    },
  })
}

function runtimeDefaultModel(
  value: string | ModelTarget | undefined,
  routes: readonly string[],
): { readonly defaultModel?: ModelTarget } {
  if (value === undefined) return {}
  if (typeof value !== 'string') return { defaultModel: value }
  if (routes.length !== 1) throw new TypeError('A string defaultModel requires exactly one Codex route')
  return { defaultModel: Object.freeze({ provider: routes[0]!, id: value }) }
}
