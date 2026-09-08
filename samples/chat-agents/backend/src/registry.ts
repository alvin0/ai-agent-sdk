/**
 * Provider wiring.
 *
 * Credentials are host state, never SDK state: keys and endpoint overrides come
 * from the UI-managed store (`credentials.ts`), and Codex comes from the
 * device-code login store. Adapters receive a `CredentialSource` that reads the
 * key at call time, so an edit in the settings dialog takes effect on the next
 * request.
 */

import { ModelRegistry } from '@ai-agent-sdk/core'
import { MOCK_MODELS, MOCK_PROVIDER, mockAdapter, mockEnabled } from './mock-provider'
import type { CallConfig, ModelInfo, ResolvedModelInfo } from '@ai-agent-sdk/core'
import { codexNodeAdapter } from '@ai-agent-sdk/auth-node/codex'
import { geminiAdapter } from '@ai-agent-sdk/provider-gemini'
import { openAiAdapter } from '@ai-agent-sdk/provider-openai'
import { anthropicAdapter } from '@ai-agent-sdk/provider-anthropic'
import { codexSignedIn } from './auth'
import { apiKeyFor, baseUrlFor, credentialViews } from './credentials'

/** One selectable provider, as the model picker sees it. */
export interface ProviderInfoView {
  readonly id: string
  readonly label: string
  /** Whether a credential for this provider is present right now. */
  readonly ready: boolean
  /** Why it is not ready, for the picker's hint line. */
  readonly hint: string
  /** Model ids the host suggests; the picker also accepts a typed id. */
  readonly models: readonly string[]
  /** True when `listModels` can discover the catalogue from the account. */
  readonly discoverable: boolean
  /** How the provider is authenticated: an API key, or an OAuth sign-in. */
  readonly auth: 'api-key' | 'oauth'
  /** True when a key is stored (or seeded from the environment). */
  readonly hasKey: boolean
  /** Last four characters of the stored key. */
  readonly keyHint: string | undefined
  /** Endpoint override in effect, when one is set. */
  readonly baseUrl: string | undefined
  /** True when the key comes from an environment variable rather than the UI. */
  readonly fromEnv: boolean
}

const KEY_PROVIDERS = ['gemini', 'openai', 'anthropic'] as const

const SUGGESTED_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  gemini: ['gemini-3-flash', 'gemini-3-pro'],
  openai: ['gpt-5.4', 'gpt-5.6'],
  anthropic: ['claude-sonnet-5', 'claude-opus-5'],
}

const MODEL_ENV: Readonly<Record<string, string>> = {
  gemini: 'GEMINI_MODEL',
  openai: 'OPENAI_MODEL',
  anthropic: 'ANTHROPIC_MODEL',
}

/** Suggestions for the picker, with a host-configured default first. */
function suggestionsFor(provider: string): readonly string[] {
  const defaults = SUGGESTED_DEFAULTS[provider] ?? []
  const variable = MODEL_ENV[provider]
  const configured = variable === undefined ? undefined : process.env[variable]
  return configured === undefined || configured.length === 0
    ? defaults
    : [configured, ...defaults.filter(model => model !== configured)]
}

const LABELS: Readonly<Record<string, string>> = {
  codex: 'Codex (ChatGPT)',
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
}

/**
 * A credential resolver over the UI-managed store. Adapters accept a resolver
 * function, so the key is read per request and an edit in Settings applies to
 * the next call without rebuilding the registry.
 */
function storedCredential(provider: string): () => Promise<string> {
  return async () => {
    const key = await apiKeyFor(provider)
    if (key === undefined) throw new Error(`no API key stored for ${provider}`)
    return key
  }
}

/**
 * Describe every provider the picker can offer.
 * @returns One entry per provider, ready or not.
 */
export async function listProviders(): Promise<readonly ProviderInfoView[]> {
  const views = await credentialViews(KEY_PROVIDERS)
  const codex = await codexSignedIn()
  const keyed = views.map((view): ProviderInfoView => ({
    id: view.provider,
    label: LABELS[view.provider] ?? view.provider,
    ready: view.hasKey,
    hint: view.hasKey
      ? view.fromEnv ? `Key from the environment ${view.keyHint ?? ''}`.trim() : `Key stored ${view.keyHint ?? ''}`.trim()
      : 'Add an API key',
    models: suggestionsFor(view.provider),
    discoverable: false,
    auth: 'api-key',
    hasKey: view.hasKey,
    keyHint: view.keyHint,
    baseUrl: view.baseUrl,
    fromEnv: view.fromEnv,
  }))
  return [
    ...mockEnabled() ? [{
      id: MOCK_PROVIDER,
      label: 'Offline (no model)',
      ready: true,
      hint: 'Answers from a script; nothing leaves this machine',
      models: MOCK_MODELS,
      discoverable: false,
      auth: 'api-key' as const,
      hasKey: true,
      keyHint: undefined,
      baseUrl: undefined,
      fromEnv: true,
    }] : [],
    {
      id: 'codex',
      label: LABELS.codex ?? 'Codex',
      ready: codex,
      hint: codex ? 'Signed in' : 'Sign in with the ChatGPT device-code flow',
      models: [],
      discoverable: true,
      auth: 'oauth',
      hasKey: codex,
      keyHint: undefined,
      baseUrl: undefined,
      fromEnv: false,
    },
    ...keyed,
  ]
}

/**
 * Build a registry carrying every provider whose credential is present.
 * @returns The registry plus the provider ids it can route.
 */
export async function buildRegistry(): Promise<{ registry: ModelRegistry; routed: readonly string[] }> {
  const registry = new ModelRegistry()
  const routed: string[] = []

  // Offline first, and only when asked for: a deployment with real credentials
  // must never find a conversation answered by a machine that makes things up.
  if (mockEnabled()) {
    registry.registerAdapter([MOCK_PROVIDER], mockAdapter())
    routed.push(MOCK_PROVIDER)
  }

  if (await apiKeyFor('gemini') !== undefined) {
    const baseUrl = await baseUrlFor('gemini')
    registry.registerAdapter(['gemini'], geminiAdapter({
      apiKey: storedCredential('gemini'),
      ...baseUrl === undefined ? {} : { baseUrl },
    }))
    routed.push('gemini')
  }
  if (await apiKeyFor('openai') !== undefined) {
    const baseUrl = await baseUrlFor('openai')
    registry.registerAdapter(['openai'], openAiAdapter({
      apiKey: storedCredential('openai'),
      ...baseUrl === undefined ? {} : { baseUrl },
    }))
    routed.push('openai')
  }
  if (await apiKeyFor('anthropic') !== undefined) {
    const baseUrl = await baseUrlFor('anthropic')
    registry.registerAdapter(['anthropic'], anthropicAdapter({
      apiKey: storedCredential('anthropic'),
      ...baseUrl === undefined ? {} : { baseUrl },
    }))
    routed.push('anthropic')
  }
  if (await codexSignedIn()) {
    registry.registerAdapter(['codex'], codexNodeAdapter())
    routed.push('codex')
  }
  return { registry, routed }
}

/**
 * The effort a run may actually send, given the model it ended up on.
 *
 * A conversation remembers its effort, and the model it runs on can change
 * underneath that memory — pick `high` on a Codex route, switch the
 * conversation to Gemini, and the next prompt fails outright with "does not
 * offer reasoning effort high". The stored value is a preference, not a
 * promise: a model that cannot honour it should be sent none rather than sent
 * something it rejects.
 * @param registry - The registry the run will use.
 * @param config - The provider and model the run resolved to.
 * @param effort - What the conversation remembers, if anything.
 * @returns The effort to send, or undefined when this model has no such level.
 */
export async function supportedEffort(
  registry: ModelRegistry,
  config: CallConfig,
  effort: string | undefined,
): Promise<string | undefined> {
  if (effort === undefined || effort === '') return undefined
  try {
    const info = await registry.resolveModelInfo(config.provider, config.model)
    const efforts = info.reasoning?.efforts.map(entry => String(entry.id)) ?? []
    // A model that discloses no ladder is not the same as one that refuses
    // every value: adapters that never resolve efforts still accept them.
    if (efforts.length === 0) return info.reasoning === undefined ? undefined : effort
    return efforts.includes(effort) ? effort : undefined
  } catch {
    // A route that cannot be resolved is not a reason to lose the prompt.
    return undefined
  }
}

/** A provider/model pair chosen in the UI. */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
}

export interface ResolvedModel {
  readonly registry: ModelRegistry
  readonly config: CallConfig
}

/**
 * Resolve the call config for a run.
 * @param selection - The conversation's chosen pair, when the user picked one.
 * @returns The registry and the config to run with.
 * @throws When the selection has no credential, or nothing is configured at all.
 */
export async function resolveModel(selection: ModelSelection | undefined): Promise<ResolvedModel> {
  const { registry, routed } = await buildRegistry()
  if (routed.length === 0) {
    throw new Error('no provider is configured: add an API key or sign in with Codex in Settings')
  }
  if (selection !== undefined) {
    if (!routed.includes(selection.provider)) {
      throw new Error(`provider "${selection.provider}" has no credential configured`)
    }
    return { registry, config: { provider: selection.provider, model: selection.model } }
  }

  const providers = await listProviders()
  const first = providers.find(provider => routed.includes(provider.id) && provider.models.length > 0)
  if (first === undefined) throw new Error('pick a model before sending a message')
  const model = first.models[0]
  if (model === undefined) throw new Error('pick a model before sending a message')
  return { registry, config: { provider: first.id, model } }
}

/** One selectable model, with the reasoning efforts its route actually offers. */
export interface ModelOption {
  readonly id: string
  readonly name?: string
  /**
   * Effort ids this exact model accepts, in adapter order. Empty when the
   * adapter discloses none — the UI then falls back to the generic ladder.
   */
  readonly efforts: readonly string[]
  readonly defaultEffort?: string
}

/**
 * Discover a provider's catalogue when its adapter supports it.
 *
 * Effort levels are per model, not per provider: a Codex route can offer
 * `max` while another offers only `low`/`medium`/`high`, so they travel with
 * the model rather than being hard-coded in the UI.
 * @param provider - Provider id.
 * @returns The selectable models.
 */
export async function listModels(provider: string): Promise<readonly ModelOption[]> {
  const views = await listProviders()
  const view = views.find(entry => entry.id === provider)
  if (view === undefined) throw new Error(`unknown provider "${provider}"`)
  const fallback = view.models.map((id): ModelOption => ({ id, efforts: [] }))
  if (!view.discoverable || !view.ready) return fallback
  const { registry, routed } = await buildRegistry()
  if (!routed.includes(provider)) return fallback
  const models: ModelInfo[] = await registry.listModels(provider)
  // `listModels` returns ModelInfo, which carries no reasoning metadata; the
  // efforts live on ResolvedModelInfo. The HTTP adapters resolve from the same
  // cached catalogue connection, so this costs no extra request.
  const resolved = await Promise.all(models.map(async (model): Promise<ModelOption> => {
    let info: ResolvedModelInfo | undefined
    try {
      info = await registry.resolveModelInfo(provider, model.id)
    } catch {
      // A route the adapter cannot resolve still belongs in the picker.
      info = undefined
    }
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      efforts: info?.reasoning?.efforts.map(effort => effort.id) ?? [],
      ...info?.reasoning?.defaultEffort === undefined
        ? {}
        : { defaultEffort: info.reasoning.defaultEffort },
    }
  }))
  return resolved
}
