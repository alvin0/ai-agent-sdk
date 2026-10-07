/**
 * The Copilot provider: the Copilot API surface, authenticated with a GitHub user
 * token this project's own credential store holds.
 *
 * ## Configured, not subclassed
 *
 * `copilotAdapter` is built with `createRuntimeHttpProvider` and extends nothing
 * (Requirement 7.1). Everything Copilot needs beyond a plain API-key provider —
 * a two-tier credential, a token exchange with its own cache, two wire protocols
 * on one route, endpoint-driven discovery — is expressed as DATA:
 * `auth: { kind: 'dynamic' }` for the credential path, a composite protocol for
 * the two endpoints, `discoverModels` for the catalog. That is the point of the
 * exercise: the configuration path is proven by the provider with the most
 * demanding requirements in this repository, not by the simplest one.
 *
 * ## Client identity
 *
 * `COPILOT_EDITOR_VERSION` and `COPILOT_EDITOR_PLUGIN_VERSION` are two of the
 * three `Client_Identity_Constants` in this package; the third is
 * `COPILOT_OAUTH_CLIENT_ID` in `./oauth.ts`. Their defaults make this SDK
 * identify itself AS AN EDITOR CLIENT on every request to the Copilot surface.
 *
 * They are EXPORTED, OVERRIDABLE constants — not hidden values — precisely
 * because of that: presenting as another client is something the caller should be
 * able to read off the source and change without forking, so each one is a named
 * option (`editorHeaders`) with a visible default. Same reason
 * `CODEX_CLIENT_VERSION` is an exported constant in `provider-codex`. All three
 * values will also go stale, which is a second reason to keep them where a caller
 * can reach them.
 *
 * Use your own account, and prefer a provider's official first-party surface for
 * production. The README and the "Client identity" section of the docs carry the
 * full tradeoff.
 *
 * @module ai-agent-sdk/providers/copilot/adapter
 */

import {
  defineModelProviderPlugin, type ComposableModelProviderPlugin, type ModelTarget,
} from '@alvin0/ai-agent-sdk-core/provider'
import { type HttpModelAdapter } from '@alvin0/ai-agent-sdk-provider-http'
import { captureCopilotStore } from './common/store-capture.ts'

/**
 * The Copilot API base (Requirement 2.1).
 *
 * Declared in `./common/identity.ts` and re-exported here; that module's note
 * explains why the value sits in the leaf layer while this module stays the door
 * a reader opens.
 */
export { COPILOT_BASE_URL } from './common/identity.ts'

/**
 * Default `Editor-Version`.
 *
 * NOT cosmetic: with either editor header missing the endpoint answers HTTP 400
 * and no request runs at all. This is also where the SDK identifies itself as an
 * editor client — see the module note for why it is a named option.
 *
 * ✔ CONFIRMED accepted on a live Copilot account on 2026-09-10 (`sku`
 * `free_educational_quota`). Sent as the only editor headers, together with
 * `COPILOT_EDITOR_PLUGIN_VERSION`, on all four live calls, and none answered
 * HTTP 400: `GET https://api.github.com/copilot_internal/v2/token` → 200,
 * `GET /models` → 200, a streaming `/chat/completions` on `gpt-4o-mini` → a
 * complete stream, `POST /embeddings` → 200.
 *
 * Confirmed, not permanent: this constant's first failure mode is going stale, so
 * re-run those four calls when the surface starts answering 400. The procedure is
 * exactly the one above — an editor header the endpoint rejects and one it never
 * received both surface as HTTP 400.
 */
export { COPILOT_EDITOR_VERSION } from './common/identity.ts'

/**
 * Default `Editor-Plugin-Version`.
 *
 * Same contract as `COPILOT_EDITOR_VERSION`: mandatory, and part of the client
 * identity this SDK presents.
 *
 * ✔ CONFIRMED accepted on a live Copilot account on 2026-09-10, in the same run
 * that confirmed `COPILOT_EDITOR_VERSION` — both headers travel on every request,
 * so the one run confirms the pair. See that constant for the four calls and
 * their statuses.
 */
export { COPILOT_EDITOR_PLUGIN_VERSION } from './common/identity.ts'

/** Overrides for the two editor headers; each field is independent. */
export type { CopilotEditorHeaders } from './common/identity.ts'

/**
 * The Copilot dialect and its two projections, declared in `./dual-protocol.ts`
 * and re-exported here.
 *
 * The design's file map puts them in this module and DD-2 puts ownership with the
 * composite; both hold, because `copilotAdapter` BUILDS the composite. The source
 * edge therefore already runs adapter → dual-protocol, and declaring the runtime
 * projections here would make it bidirectional, which the repo's
 * circular-dependency check forbids. Same shape as `./router.ts` re-exporting
 * `CopilotEndpoint` from `./catalog.ts`.
 */
export { COPILOT_DEFAULT_DIALECT, toChatCompletionsDialect, toResponsesDialect } from './dual-protocol.ts'
export type { CopilotDialect } from './dual-protocol.ts'

export { COPILOT_ROUTE_ID, COPILOT_DISPLAY_NAME } from './adapter-types.ts'
export type {
  CopilotProviderOptions, CopilotLegacyProviderOptions, CopilotPluginOptions,
} from './adapter-types.ts'
import {
  COPILOT_ROUTE_ID, COPILOT_DISPLAY_NAME, type CopilotProviderOptions, type CopilotLegacyProviderOptions,
  type CopilotPluginOptions,
} from './adapter-types.ts'
import { buildCopilotAdapter } from './adapter-build.ts'

/**
 * Create a Copilot adapter.
 *
 * Both store variants are accepted, and the variant is chosen by INSPECTING THE
 * MARKER through `captureCopilotStore` — which reads data properties only and
 * performs no storage I/O, so building a provider cannot run a line of the
 * caller's code (Requirement 7.3).
 * @param options - credential store, endpoint, catalog, dialect and transport settings.
 * @returns the adapter, ready to register.
 * @throws AgentSdkError with `CREDENTIAL_STORE_INVALID` when `authStore` is
 *   neither store variant, or `COPILOT_ENDPOINT_OVERRIDE_INVALID` when
 *   `endpointOverrides` pins an endpoint that does not exist.
 */
export function copilotAdapter(options: CopilotProviderOptions): HttpModelAdapter
export function copilotAdapter(options: CopilotLegacyProviderOptions): HttpModelAdapter
export function copilotAdapter(
  options: CopilotProviderOptions | CopilotLegacyProviderOptions,
): HttpModelAdapter {
  return buildCopilotAdapter(options, captureCopilotStore(options?.authStore))
}


/**
 * The transactional plugin for installing the Copilot provider.
 *
 * Composition follows `codexPlugin`: `id` defaults to {@link COPILOT_ROUTE_ID},
 * `family` is `'copilot'`, `routes` defaults to `[id]`, and a string
 * `defaultModel` requires exactly one route so the model target's provider can be
 * inferred (Requirements 7.4, 7.5).
 *
 * One difference from Codex: there is no overload per store variant. The
 * compare-and-swap store is the main path here, the read/write variant exists for
 * symmetry, and {@link copilotAdapter} is where it is accepted (Requirement 6.2).
 * The marker is checked at construction rather than at setup so a wrong store is
 * reported while the runtime is being composed, not on the first generation.
 * @param options - the same options {@link copilotAdapter} takes, CAS store only.
 * @returns a composable plugin registering one Copilot adapter.
 * @throws TypeError when `authStore` is not the compare-and-swap variant, or when
 *   a string `defaultModel` is paired with anything but exactly one route.
 */
export function copilotPlugin(
  options: CopilotPluginOptions,
): ComposableModelProviderPlugin & { readonly family: 'copilot' } {
  if (!isCredentialStoreInput(options?.authStore)) {
    throw new TypeError('copilotPlugin requires a Copilot credential store (the CAS variant)')
  }
  const id = options.id ?? COPILOT_ROUTE_ID
  const routes = Object.freeze([...(options.routes ?? [id])])
  return defineModelProviderPlugin({
    id,
    family: 'copilot',
    displayName: COPILOT_DISPLAY_NAME,
    routes,
    ...runtimeDefaultModel(options.defaultModel, routes),
    setup(registrar) {
      const adapter = buildCopilotAdapter(options, captureCopilotStore(options.authStore))
      const remove = registrar.registerAdapter(adapter)
      return () => {
        remove()
        return undefined
      }
    },
  }) as ComposableModelProviderPlugin & { readonly family: 'copilot' }
}

/**
 * Marker inspection only: no accessor is invoked and no method is captured.
 *
 * Full capture stays deferred to {@link buildCopilotAdapter}, so this check
 * cannot be the thing that runs the caller's code.
 * @param value - the `authStore` as passed in.
 * @returns true when it carries the credential-store marker.
 */
function isCredentialStoreInput(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const marker = Object.getOwnPropertyDescriptor(value, 'kind')
  return marker !== undefined && 'value' in marker && marker.value === 'credential-store'
}

/**
 * Resolve `defaultModel`, demanding one route for the string form.
 *
 * A string names a model but not a provider, and the provider is inferred from
 * the route. With two routes there is no answer, and picking the first would
 * install a default nobody chose (Requirement 7.5).
 * @param value - the caller's default model, when they set one.
 * @param routes - the routes this plugin installs.
 * @returns a one-key spread carrying `defaultModel`, or an empty one.
 * @throws TypeError when a string is paired with anything but exactly one route.
 */
function runtimeDefaultModel(
  value: string | ModelTarget | undefined,
  routes: readonly string[],
): { readonly defaultModel?: ModelTarget } {
  if (value === undefined) return {}
  if (typeof value !== 'string') return { defaultModel: value }
  if (routes.length !== 1) {
    throw new TypeError('A string defaultModel requires exactly one Copilot route')
  }
  return { defaultModel: Object.freeze({ provider: routes[0] ?? COPILOT_ROUTE_ID, id: value }) }
}
