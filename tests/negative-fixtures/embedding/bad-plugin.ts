/**
 * Embedding provider plugins and handle configurations that must be REFUSED.
 *
 * Placement follows `./bad-mapping.ts` (Requirement 17.11).
 *
 * Two forward-compatibility notes, because this fixture is written before the
 * code it accuses:
 *
 * 1. `ComposableEmbeddingProviderPlugin`, `defineEmbeddingProviderPlugin` and the
 *    activation path live in `packages/core/src/composition/embedding/`, which
 *    later tasks create. So every malformed plugin here is typed `unknown` and
 *    described structurally: the payloads are exactly what an application would
 *    pass to `createAgentRuntime({ providers })`, and the consuming spec casts
 *    them at the call site once that entry point exists. Typing them against a
 *    module that does not exist yet would make this file uncompilable today, and
 *    typing them against the real interface later would make them un-writable —
 *    a well-typed plugin object cannot express these faults.
 * 2. The expected outcome of each case is recorded as a `reason` tag plus, where
 *    the taxonomy already names it, an {@link EmbeddingErrorCode}. Preflight
 *    collects ALL faults before committing anything, so `expectedReasons` on the
 *    batch case below is a set, not a first-failure.
 *
 * `EmbeddingAdapter` itself IS imported: a plugin whose adapter is a
 * generation-only object, or is missing entirely, can only be stated against the
 * real class.
 *
 * @module tests/negative-fixtures/embedding/bad-plugin
 */

import { EmbeddingAdapter } from '../../../packages/core/src/embedding/adapter.ts'
import { EMBEDDING_ERROR_CODES } from '../../../packages/core/src/embedding/errors.ts'
import type { EmbeddingErrorCode } from '../../../packages/core/src/embedding/errors.ts'
import type { EmbeddingBatchRequest } from '../../../packages/core/src/embedding/request.ts'
import type { EmbeddingBatchResult } from '../../../packages/core/src/embedding/result.ts'

/** Why a plugin or configuration is refused, as a stable tag for assertions. */
export type BadPluginReason =
  /** `kind` is not `'embedding-provider-plugin'`. */
  | 'plugin-kind-unrecognized'
  /** `apiVersion` is not the one this host supports. */
  | 'plugin-api-version-mismatch'
  /** A required identity or route field is missing or unusable. */
  | 'plugin-shape-invalid'
  /** `setup()` registered outside the routes the plugin declared. */
  | 'registration-out-of-scope'
  /** Two embedding plugins claim the same route: a route–operation duplicate. */
  | 'route-operation-duplicate'
  /** The registered object is not an `EmbeddingAdapter`. */
  | 'adapter-not-embedding'
  /** No embedding adapter resolves for the requested route/model. */
  | 'adapter-missing'
  /** The handle configuration itself is invalid. */
  | 'configuration-invalid'

/** One refusable plugin payload. */
export interface BadPluginCase {
  readonly name: string
  readonly why: string
  /** Exactly what the application would hand to `providers`. */
  readonly plugin: unknown
  readonly expectedReason: BadPluginReason
  /** The taxonomy code, where the failure surfaces as an `EmbeddingError`. */
  readonly expectedCode?: EmbeddingErrorCode
}

/** A minimal working adapter, so each case fails for ONE reason only. */
class MinimalEmbeddingAdapter extends EmbeddingAdapter {
  override embedBatch(batch: EmbeddingBatchRequest): Promise<EmbeddingBatchResult> {
    return Promise.resolve({
      vectors: batch.items.map(item => ({ index: item.index, values: [0, 0, 0, 1] })),
    })
  }
}

/** Shared instance: identity is never the thing under test here. */
export const MINIMAL_EMBEDDING_ADAPTER: EmbeddingAdapter = new MinimalEmbeddingAdapter()

/** A generation-shaped object that is NOT an `EmbeddingAdapter`. */
export const GENERATION_ONLY_ADAPTER: unknown = Object.freeze({
  stream: () => {
    throw new Error('generation adapter reached through the embedding path')
  },
})

/** The shape of a well-formed embedding plugin, as the design declares it. */
const WELL_FORMED = Object.freeze({
  kind: 'embedding-provider-plugin',
  apiVersion: 1,
  id: 'fake-embedding',
  displayName: 'Fake Embedding',
  routes: ['fake'],
  setup: () => undefined,
})

export const BAD_PLUGIN_CASES: readonly BadPluginCase[] = Object.freeze([
  {
    name: 'generation plugin kind on the embedding path',
    why: 'a plugin belongs to exactly one kind; a generation plugin must never '
      + 'be adopted as an embedding provider, even though both have routes and setup',
    plugin: { ...WELL_FORMED, kind: 'model-provider-plugin' },
    expectedReason: 'plugin-kind-unrecognized',
  },
  {
    name: 'capabilities array instead of a kind',
    why: 'the design rejected `capabilities: ["embedding"]` on a generation plugin; '
      + 'a host that honours it would resurrect the API-version bump it avoided',
    plugin: { ...WELL_FORMED, kind: 'model-provider-plugin', capabilities: ['embedding'] },
    expectedReason: 'plugin-kind-unrecognized',
  },
  {
    name: 'missing kind marker',
    why: 'an unmarked object is not a plugin, however plausible its fields look',
    plugin: {
      apiVersion: 1, id: 'x', displayName: 'X', routes: ['fake'], setup: () => undefined,
    },
    expectedReason: 'plugin-kind-unrecognized',
  },
  {
    name: 'future apiVersion',
    why: 'a host cannot honour a contract it has not seen; silently accepting it '
      + 'trades a startup failure for an unpredictable call-time one',
    plugin: { ...WELL_FORMED, apiVersion: 2 },
    expectedReason: 'plugin-api-version-mismatch',
  },
  {
    name: 'apiVersion as a string',
    why: '"1" is not 1; a coercing host would accept any numeric-looking claim',
    plugin: { ...WELL_FORMED, apiVersion: '1' },
    expectedReason: 'plugin-api-version-mismatch',
  },
  {
    name: 'empty routes',
    why: 'a plugin that owns no route can register nothing, so it is a silent no-op',
    plugin: { ...WELL_FORMED, routes: [] },
    expectedReason: 'plugin-shape-invalid',
  },
  {
    name: 'empty route key',
    why: 'the empty string is not a route name; it would key an unreachable entry',
    plugin: { ...WELL_FORMED, routes: [''] },
    expectedReason: 'plugin-shape-invalid',
  },
  {
    name: 'missing id',
    why: 'preflight reports faults per plugin; an unnamed plugin cannot be reported',
    plugin: { ...WELL_FORMED, id: undefined },
    expectedReason: 'plugin-shape-invalid',
  },
  {
    name: 'setup is not callable',
    why: 'nothing can be registered, and the failure would surface at first use',
    plugin: { ...WELL_FORMED, setup: 'register everything' },
    expectedReason: 'plugin-shape-invalid',
  },
  {
    name: 'registers a route it never declared',
    why: 'the registrar view is scoped to declared routes; escaping that scope '
      + 'hides a route from preflight duplicate detection entirely',
    plugin: {
      ...WELL_FORMED,
      routes: ['fake'],
      setup: (registrar: {
        registerEmbeddingAdapter: (
          adapter: EmbeddingAdapter,
          options?: { readonly routes?: readonly string[] },
        ) => unknown
      }) => {
        registrar.registerEmbeddingAdapter(MINIMAL_EMBEDDING_ADAPTER, { routes: ['other'] })
      },
    },
    expectedReason: 'registration-out-of-scope',
  },
  {
    name: 'registers a generation-only object as the embedding adapter',
    why: 'a `ModelAdapter` has no `embedBatch`, so accepting it defers a type error '
      + 'to the first embedding call, past every honest failure point',
    plugin: {
      ...WELL_FORMED,
      setup: (registrar: { registerEmbeddingAdapter: (adapter: unknown) => unknown }) => {
        registrar.registerEmbeddingAdapter(GENERATION_ONLY_ADAPTER)
      },
    },
    expectedReason: 'adapter-not-embedding',
  },
  {
    name: 'registers nothing at all',
    why: 'a plugin that registers no adapter leaves its declared route resolving '
      + 'to nothing, which must be EMBEDDING_ADAPTER_MISSING at call time',
    plugin: WELL_FORMED,
    expectedReason: 'adapter-missing',
    expectedCode: EMBEDDING_ERROR_CODES.ADAPTER_MISSING,
  },
])

/**
 * Two embedding plugins claiming one route.
 *
 * Deliberately a PAIR, because the fault is a relation: each object is valid
 * alone. Preflight treats duplication as duplication on the route–operation pair,
 * so a generation plugin and an embedding plugin on `'fake'` do NOT conflict,
 * while these two do.
 */
export const DUPLICATE_ROUTE_PLUGINS: {
  readonly why: string
  readonly plugins: readonly unknown[]
  readonly expectedReason: BadPluginReason
} = Object.freeze({
  why: 'two embedding adapters on one route make resolution ambiguous, and the '
    + 'ambiguity would be settled by registration order rather than by intent',
  plugins: Object.freeze([
    { ...WELL_FORMED, id: 'first' },
    { ...WELL_FORMED, id: 'second' },
  ]),
  expectedReason: 'route-operation-duplicate',
})

/**
 * A batch of faults handed over together.
 *
 * Startup preflight collects EVERY fault before committing anything, so a spec
 * asserts the whole set — one fault per plugin, none masked by an earlier one —
 * and asserts that no plugin's `setup()` side effects survived.
 */
export const PREFLIGHT_BATCH_CASE: {
  readonly plugins: readonly unknown[]
  readonly expectedReasons: readonly BadPluginReason[]
} = Object.freeze({
  plugins: Object.freeze([
    { ...WELL_FORMED, kind: 'model-provider-plugin' },
    { ...WELL_FORMED, apiVersion: 2 },
    { ...WELL_FORMED, routes: [] },
  ]),
  expectedReasons: Object.freeze([
    'plugin-kind-unrecognized',
    'plugin-api-version-mismatch',
    'plugin-shape-invalid',
  ] as const),
})

/** One refusable `embeddingModel()` configuration. */
export interface BadHandleConfigCase {
  readonly name: string
  readonly why: string
  /** Exactly what the caller would pass to `runtime.embeddingModel()`. */
  readonly options: unknown
  readonly expectedReason: BadPluginReason
  readonly expectedCode: EmbeddingErrorCode
}

export const BAD_HANDLE_CONFIG_CASES: readonly BadHandleConfigCase[] = Object.freeze([
  {
    name: 'cache without a scope',
    why: 'scope is the first component of every cache key, so a missing scope is '
      + 'the question "may two tenants share this entry" answered by accident',
    options: {
      provider: 'fake',
      model: 'fake-embed',
      cache: { store: { get: () => undefined, set: () => undefined } },
    },
    expectedReason: 'configuration-invalid',
    expectedCode: EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
  },
  {
    name: 'cache with an empty scope',
    why: 'an empty string is not a tenant boundary, it just looks like one',
    options: {
      provider: 'fake',
      model: 'fake-embed',
      cache: { store: { get: () => undefined, set: () => undefined }, scope: '' },
    },
    expectedReason: 'configuration-invalid',
    expectedCode: EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
  },
  {
    name: 'cache without a store',
    why: 'cache enabled with nothing behind it would silently never hit',
    options: { provider: 'fake', model: 'fake-embed', cache: { scope: 'tenant-a' } },
    expectedReason: 'configuration-invalid',
    expectedCode: EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
  },
  {
    name: 'no provider route',
    why: 'without a route there is nothing to resolve an adapter from',
    options: { model: 'fake-embed' },
    expectedReason: 'adapter-missing',
    expectedCode: EMBEDDING_ERROR_CODES.ADAPTER_MISSING,
  },
  {
    name: 'route with no embedding plugin',
    why: 'a route that only has a generation plugin cannot serve embedding, and '
      + 'must say so instead of reaching for the ModelAdapter it does have',
    options: { provider: 'generation-only', model: 'fake-embed' },
    expectedReason: 'adapter-missing',
    expectedCode: EMBEDDING_ERROR_CODES.ADAPTER_MISSING,
  },
  {
    name: 'zero concurrency',
    why: 'a concurrency of 0 admits no batch, so the call could never progress',
    options: { provider: 'fake', model: 'fake-embed', concurrency: 0 },
    expectedReason: 'configuration-invalid',
    expectedCode: EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
  },
])
