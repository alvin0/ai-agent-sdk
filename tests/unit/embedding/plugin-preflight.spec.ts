/**
 * Property tests for the embedding plugin registrar, the whole-input startup
 * preflight, and adapter resolution by route + operation + model id.
 *
 * Feature: embedding-support, Property 26: Registrar không cho đăng ký ra ngoài
 * route đã khai báo.
 * Feature: embedding-support, Property 27: Preflight thu mọi lỗi và không commit
 * plugin nào.
 * Feature: embedding-support, Property 28: Phân giải adapter theo bộ ba route,
 * operation và model id.
 *
 * **Validates: Requirements 11.5, 11.6, 11.7, 11.10**
 *
 * ## What each property is actually pinned against
 *
 * Property 26 has TWO enforcement points, and asserting only one would leave a
 * real escape open. `defineEmbeddingProviderPlugin` narrows a helper-only view
 * before the host ever sees the call, and `activateEmbeddingProviders` re-checks
 * the claim on the raw registrar a plugin object receives when it was built by
 * hand rather than through the helper. A plugin that skips the helper must not
 * skip the check, so the generated route selection is driven through both.
 *
 * Property 27 is a conjunction of three separate claims:
 * 1. the sweep reports EVERY fault, not the first one — asserted against an
 *    independently folded expectation list, entry by entry, including the index
 *    each conflict collides with;
 * 2. `failureCode` still equals the FIRST fault's code (DD-3), so assertions
 *    written against the older fail-fast behaviour keep their meaning;
 * 3. the number of plugins whose `setup()` ran is 0. That is asserted with a spy
 *    per plugin rather than by inspecting registries, because "no side effect
 *    survived" and "no side effect happened" are different statements and the
 *    requirement asks for the second.
 *
 * The rollback half of Requirement 11.7 is generated too: a failure inside the
 * i-th `setup()` must unwind every plugin already installed, across BOTH kinds.
 *
 * Property 28 walks the full query grid rather than sampled pairs, because the
 * interesting cases are the absences: a route that only carries a `ModelAdapter`
 * must fail embedding resolution with `EMBEDDING_ADAPTER_MISSING` instead of
 * reaching for the adapter it does have.
 *
 * ## Why the file lives here and not where the task named it
 *
 * The task names `packages/core/tests/unit/embedding/plugin-preflight.spec.ts`.
 * No runner collects that directory — root `vitest.config.ts` includes `tests/**`
 * and the package configs reach into the ROOT `tests/` tree by relative path. A
 * property spec there would silently never run. It sits beside its siblings in
 * `tests/unit/embedding/` instead, as `usage.spec.ts` and `validation.spec.ts`
 * already do.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency. The established
 * convention (see `tests/unit/embedding/profile.spec.ts`) is a seeded mulberry32
 * generator: a failure reproduces from the printed seed and nothing enters the
 * dependency graph for test-only reasons. Each property runs `RUNS` cases, above
 * the spec floor of 100.
 *
 * @module tests/unit/embedding/plugin-preflight.spec
 */

import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { ProviderInfo } from '../../../packages/core/src/contract/model-info.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import { createObservability } from '../../../packages/core/src/observability/bus.ts'
import { ModelRegistry } from '../../../packages/core/src/runtime/registry.ts'
import { activateRuntimeProviders } from '../../../packages/core/src/composition/embedding/activation.ts'
import { defineEmbeddingProviderPlugin } from '../../../packages/core/src/composition/embedding/definition.ts'
import { EmbeddingRegistry } from '../../../packages/core/src/composition/embedding/registry.ts'
import type {
  ComposableEmbeddingProviderPlugin, ComposableRuntimeProviderPlugin,
  EmbeddingProviderRegistrar,
} from '../../../packages/core/src/composition/embedding/plugin-types.ts'
import type { ProviderPreflightFailure } from '../../../packages/core/src/composition/embedding/preflight.ts'
import { preflightRuntimeCapabilities } from '../../../packages/core/src/composition/preflight.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import { EmbeddingAdapter } from '../../../packages/core/src/embedding/adapter.ts'
import { EMBEDDING_ERROR_CODES } from '../../../packages/core/src/embedding/errors.ts'
import type { EmbeddingBatchRequest } from '../../../packages/core/src/embedding/request.ts'
import type { EmbeddingBatchResult } from '../../../packages/core/src/embedding/result.ts'
import {
  BAD_PLUGIN_CASES, DUPLICATE_ROUTE_PLUGINS, GENERATION_ONLY_ADAPTER, PREFLIGHT_BATCH_CASE,
} from '../../negative-fixtures/embedding/bad-plugin.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Number of generated cases per property; the spec floor is 100. */
const RUNS = 120

/** mulberry32 — small, fast, and reproducible from a 32-bit seed. */
function rngOf(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Rng = () => number

function intBelow(rng: Rng, bound: number): number {
  return Math.floor(rng() * bound)
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[intBelow(rng, values.length)] as T
}

// ---------------------------------------------------------------------------
// Tagged adapters, so "which adapter answered" is observable
// ---------------------------------------------------------------------------

/** A generation adapter whose route metadata carries its own tag. */
class TaggedModelAdapter extends ModelAdapter {
  constructor(readonly tag: string) {
    super()
  }

  override providerInfo(provider: string): ProviderInfo {
    return { id: provider, name: this.tag }
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** An embedding adapter identified by reference; `tag` only aids failure output. */
class TaggedEmbeddingAdapter extends EmbeddingAdapter {
  constructor(readonly tag: string) {
    super()
  }

  override embedBatch(batch: EmbeddingBatchRequest): Promise<EmbeddingBatchResult> {
    return Promise.resolve({
      vectors: batch.items.map(item => ({ index: item.index, values: [1, 0, 0, 0] })),
    })
  }
}

// ---------------------------------------------------------------------------
// Plugin builders
// ---------------------------------------------------------------------------

function generationPlugin(
  id: string, routes: readonly string[], setup: ComposableModelProviderPlugin['setup'],
): ComposableModelProviderPlugin {
  return { kind: 'model-provider-plugin', apiVersion: 1, id, displayName: id, routes, setup }
}

function embeddingPlugin(
  id: string, routes: readonly string[], setup: ComposableEmbeddingProviderPlugin['setup'],
): ComposableEmbeddingProviderPlugin {
  return { kind: 'embedding-provider-plugin', apiVersion: 1, id, displayName: id, routes, setup }
}

/** One runtime fixture: two registries, one logger, one preflight-then-activate. */
function activationFixture(sources: readonly unknown[]) {
  const registry = new ModelRegistry()
  const embeddingRegistry = new EmbeddingRegistry()
  const logger = createObservability().logger()
  return {
    registry,
    embeddingRegistry,
    /** Preflight the whole list exactly as the runtime does, then activate both kinds. */
    start: () => {
      const plan = preflightRuntimeCapabilities(sources, [])
      return activateRuntimeProviders({
        registry, embeddingRegistry, providers: plan.providers,
        embeddingProviders: plan.embeddingProviders, logger,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Property 26
// ---------------------------------------------------------------------------

const ROUTE_POOL = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'] as const
const OUTSIDE_POOL = ['omega', 'psi', 'chi'] as const

interface Property26Case {
  readonly claims: readonly string[]
  readonly selection: readonly string[]
  /** True only when the selection is non-empty, unique, and wholly inside the claims. */
  readonly inScope: boolean
}

function property26Case(rng: Rng): Property26Case {
  const claimCount = 1 + intBelow(rng, 4)
  const claims: string[] = []
  while (claims.length < claimCount) {
    const route = pick(rng, ROUTE_POOL)
    if (!claims.includes(route)) claims.push(route)
  }
  // Selection is drawn from claims AND from routes no plugin declared, so the
  // generator produces in-scope, out-of-scope, duplicated and empty selections.
  const candidates = [...claims, ...OUTSIDE_POOL]
  const selection: string[] = []
  const selectionSize = intBelow(rng, 4)
  for (let index = 0; index < selectionSize; index += 1) selection.push(pick(rng, candidates))
  const inScope = selection.length > 0
    && new Set(selection).size === selection.length
    && selection.every(route => claims.includes(route))
  return { claims, selection, inScope }
}

describe('Property 26: the registrar refuses registration outside the declared routes', () => {
  it(`holds at the helper view for ${RUNS} generated claim/selection pairs`, () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x26_0000 + run
      const rng = rngOf(seed)
      const { claims, selection, inScope } = property26Case(rng)
      const context = { seed, claims, selection }

      const reached: string[][] = []
      const host: EmbeddingProviderRegistrar & { readonly logger: unknown } = {
        logger: createObservability().logger(),
        registerEmbeddingAdapter(routes) {
          reached.push([...routes])
          const handle = (() => undefined) as never
          return handle
        },
      }
      const adapter = new TaggedEmbeddingAdapter('helper')
      const plugin = defineEmbeddingProviderPlugin({
        id: 'helper', displayName: 'Helper', routes: claims,
        setup(registrar) {
          registrar.registerEmbeddingAdapter(adapter, { routes: selection })
          return undefined
        },
      })

      if (inScope) {
        plugin.setup(host)
        // Exactly the selection reaches the host: the view narrows, never widens.
        expect({ ...context, reached }).toEqual({ ...context, reached: [[...selection]] })
      } else {
        expect(() => plugin.setup(host)).toThrow(TypeError)
        // The refusal happens BEFORE the host is touched, so an out-of-scope route
        // can never enter the registry and hide from duplicate detection.
        expect({ ...context, reached }).toEqual({ ...context, reached: [] })
      }
    }
  })

  it(`holds at the activation registrar for ${RUNS} generated claim/selection pairs`, () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x26_1000 + run
      const rng = rngOf(seed)
      const { claims, selection, inScope } = property26Case(rng)
      const context = { seed, claims, selection }
      const adapter = new TaggedEmbeddingAdapter('activated')
      const rest = claims.filter(route => !selection.includes(route))

      // A hand-built plugin object bypasses the helper view entirely, so this
      // exercises the check activation owns rather than the one the helper owns.
      const fixture = activationFixture([embeddingPlugin('raw', claims, registrar => {
        registrar.registerEmbeddingAdapter(selection, adapter)
        // Declared coverage must be complete for the accept case to be about the
        // claim check alone; the remainder is disjoint from `selection`.
        if (rest.length > 0) registrar.registerEmbeddingAdapter(rest, new TaggedEmbeddingAdapter('rest'))
      })])

      if (inScope) {
        const installed = fixture.start()
        expect(installed).toHaveLength(1)
        for (const route of selection) {
          expect({ ...context, route, resolved: fixture.embeddingRegistry.resolve(route, 'm').adapter })
            .toEqual({ ...context, route, resolved: adapter })
        }
        installed[0]!.close()
      } else {
        expect(fixture.start).toThrow(expect.objectContaining({
          failureCode: 'CAPABILITY_STARTUP_FAILED', stage: 'provider-setup',
        }))
        expect({ ...context, routes: fixture.embeddingRegistry.listRoutes() })
          .toEqual({ ...context, routes: [] })
      }
    }
  })

  it('refuses the out-of-scope registration the shared negative fixture declares', () => {
    const outOfScope = BAD_PLUGIN_CASES.find(row => row.expectedReason === 'registration-out-of-scope')
    expect(outOfScope).toBeDefined()
    const fixture = activationFixture([outOfScope!.plugin])
    expect(fixture.start).toThrow(expect.objectContaining({ failureCode: 'CAPABILITY_STARTUP_FAILED' }))
    expect(fixture.embeddingRegistry.listRoutes()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Property 27
// ---------------------------------------------------------------------------

/** The fault classes the sweep is required to collect (Requirement 11.6). */
type FaultClass = 'kind' | 'api-version' | 'duplicate'

type EntryClass = 'valid-generation' | 'valid-embedding' | FaultClass

interface GeneratedEntry {
  readonly index: number
  readonly id: string
  readonly plugin: unknown
  readonly setup: ReturnType<typeof vi.fn>
  /** Absent for a well-formed entry. */
  readonly expected?: {
    readonly code: ProviderPreflightFailure['code']
    readonly conflictsWithIndex?: number
  }
}

/** Kind markers that name no operation this host knows. */
const UNRECOGNIZED_KINDS = ['embedding-plugin', 'provider', 'model-provider', undefined] as const
/** apiVersion values that are not the supported `1`. */
const BAD_API_VERSIONS = [2, 0, '1', null] as const

/**
 * Build one `providers` list with a generated mixture of valid entries and faults.
 *
 * Ids are unique by construction so no unintended `CAPABILITY_ID_CONFLICT` enters
 * the expectation, and a duplicate fault is only emitted once some entry of the
 * same operation has actually COMMITTED the route it collides with — a plugin
 * rejected for its marker never reaches route bookkeeping.
 */
function property27List(rng: Rng): readonly GeneratedEntry[] {
  const entries: GeneratedEntry[] = []
  const committed: Record<'generation' | 'embedding', Map<string, number>> = {
    generation: new Map(), embedding: new Map(),
  }
  let nextRoute = 0
  const freshRoute = (): string => `route-${nextRoute++}`
  const size = 2 + intBelow(rng, 5)

  for (let index = 0; index < size; index += 1) {
    const id = `plugin-${index}`
    const setup = vi.fn()
    const duplicable = [...committed.generation.keys()].length + [...committed.embedding.keys()].length > 0
    const classes: readonly EntryClass[] = duplicable
      ? ['valid-generation', 'valid-embedding', 'kind', 'api-version', 'duplicate']
      : ['valid-generation', 'valid-embedding', 'kind', 'api-version']
    const entryClass = pick(rng, classes)

    if (entryClass === 'valid-generation' || entryClass === 'valid-embedding') {
      const operation = entryClass === 'valid-generation' ? 'generation' : 'embedding'
      // Deliberately reuse a route the OTHER operation already committed some of
      // the time: sharing a route across operations is legal by design (11.10).
      const other = operation === 'generation' ? committed.embedding : committed.generation
      const shareable = [...other.keys()].filter(route => !committed[operation].has(route))
      const route = shareable.length > 0 && rng() < 0.4 ? pick(rng, shareable) : freshRoute()
      committed[operation].set(route, index)
      entries.push({
        index, id, setup,
        plugin: operation === 'generation'
          ? generationPlugin(id, [route], setup as never)
          : embeddingPlugin(id, [route], setup as never),
      })
      continue
    }

    if (entryClass === 'kind') {
      const kind = pick(rng, UNRECOGNIZED_KINDS)
      entries.push({
        index, id, setup,
        plugin: {
          ...(kind === undefined ? {} : { kind }),
          apiVersion: 1, id, displayName: id, routes: [freshRoute()], setup,
        },
        expected: { code: 'CAPABILITY_KIND_MISMATCH' },
      })
      continue
    }

    if (entryClass === 'api-version') {
      const operation = rng() < 0.5 ? 'model-provider-plugin' : 'embedding-provider-plugin'
      entries.push({
        index, id, setup,
        plugin: {
          kind: operation, apiVersion: pick(rng, BAD_API_VERSIONS),
          id, displayName: id, routes: [freshRoute()], setup,
        },
        expected: { code: 'CAPABILITY_API_UNSUPPORTED' },
      })
      continue
    }

    // A route–operation duplicate. Which operation collides decides the code:
    // generation keeps its historical `PROVIDER_ROUTE_CONFLICT`, embedding gets
    // the route–operation class the requirement added.
    const operations = (['generation', 'embedding'] as const)
      .filter(operation => committed[operation].size > 0)
    const operation = pick(rng, operations)
    const route = pick(rng, [...committed[operation].keys()])
    entries.push({
      index, id, setup,
      plugin: operation === 'generation'
        ? generationPlugin(id, [route], setup as never)
        : embeddingPlugin(id, [route], setup as never),
      expected: {
        code: operation === 'generation' ? 'PROVIDER_ROUTE_CONFLICT' : 'PROVIDER_OPERATION_CONFLICT',
        conflictsWithIndex: committed[operation].get(route)!,
      },
    })
  }
  return entries
}

describe('Property 27: preflight collects every fault and commits no plugin', () => {
  it(`holds for ${RUNS} generated providers lists`, () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x27_0000 + run
      const rng = rngOf(seed)
      const entries = property27List(rng)
      const expected = entries.filter(entry => entry.expected !== undefined)
      const context = {
        seed,
        list: entries.map(entry => ({ id: entry.id, expected: entry.expected?.code ?? 'ok' })),
      }

      let thrown: unknown
      try {
        preflightRuntimeCapabilities(entries.map(entry => entry.plugin), [])
      } catch (error) {
        thrown = error
      }

      // Claim 3, and the strongest one: preflight is a data-only pass, so the
      // count of plugins whose setup() ran is 0 whether it succeeded or failed.
      for (const entry of entries) {
        expect({ ...context, id: entry.id, calls: entry.setup.mock.calls.length })
          .toEqual({ ...context, id: entry.id, calls: 0 })
      }

      if (expected.length === 0) {
        expect({ ...context, thrown }).toEqual({ ...context, thrown: undefined })
        continue
      }

      expect({ ...context, threw: thrown !== undefined }).toEqual({ ...context, threw: true })
      const error = thrown as {
        readonly failureCode: string
        readonly stage: string
        readonly aggregate: readonly ProviderPreflightFailure[]
      }
      expect(error.stage).toBe('preflight')
      // Claim 2: the reported code is the FIRST fault's, not an invented summary.
      expect({ ...context, failureCode: error.failureCode })
        .toEqual({ ...context, failureCode: expected[0]!.expected!.code })
      // Claim 1: all k faults are listed, in input order, each naming its plugin.
      expect({ ...context, aggregate: error.aggregate.map(row => ({ ...row })) }).toEqual({
        ...context,
        aggregate: expected.map(entry => ({
          index: entry.index,
          code: entry.expected!.code,
          pluginId: entry.id,
          ...(entry.expected!.conflictsWithIndex === undefined
            ? {}
            : { conflictsWithIndex: entry.expected!.conflictsWithIndex }),
        })),
      })
    }
  })

  it('collects every fault of the shared negative fixture batch in one report', () => {
    let thrown: unknown
    try {
      preflightRuntimeCapabilities(PREFLIGHT_BATCH_CASE.plugins, [])
    } catch (error) {
      thrown = error
    }
    const error = thrown as { readonly aggregate: readonly ProviderPreflightFailure[] }
    // Two of the fixture's three reasons are whole-input faults. The first entry
    // (`kind: 'model-provider-plugin'` on an otherwise embedding-shaped object)
    // is NOT one: on a combined sweep it is simply a well-formed generation
    // plugin. Its `plugin-kind-unrecognized` reason belongs to the embedding
    // adoption path, which is asserted in the surface spec, not here. The
    // `routes: []` entry is a shape fault, which keeps the generic startup code.
    expect(error.aggregate.map(row => row.code))
      .toEqual(['CAPABILITY_API_UNSUPPORTED', 'CAPABILITY_STARTUP_FAILED'])
    expect(error.aggregate.map(row => row.index)).toEqual([1, 2])
  })

  it('reports two embedding plugins on one route as a route–operation conflict', () => {
    let thrown: unknown
    try {
      preflightRuntimeCapabilities(DUPLICATE_ROUTE_PLUGINS.plugins, [])
    } catch (error) {
      thrown = error
    }
    const error = thrown as {
      readonly failureCode: string
      readonly aggregate: readonly ProviderPreflightFailure[]
    }
    expect(error.failureCode).toBe('PROVIDER_OPERATION_CONFLICT')
    expect(error.aggregate).toEqual([
      { index: 1, code: 'PROVIDER_OPERATION_CONFLICT', pluginId: 'second', conflictsWithIndex: 0 },
    ])
  })

  it('accepts a generation plugin and an embedding plugin sharing one route', () => {
    const plan = preflightRuntimeCapabilities([
      generationPlugin('gen', ['shared'], () => undefined),
      embeddingPlugin('emb', ['shared'], () => undefined),
    ], [])
    expect(plan.providers.map(row => row.id)).toEqual(['gen'])
    expect(plan.embeddingProviders.map(row => row.id)).toEqual(['emb'])
  })
})

// ---------------------------------------------------------------------------
// Property 27, rollback half (Requirement 11.7)
// ---------------------------------------------------------------------------

interface RollbackEntry {
  readonly id: string
  readonly operation: 'generation' | 'embedding'
  readonly fails: boolean
}

/**
 * Generation plugins are listed before embedding ones because
 * `activateRuntimeProviders` installs in that order, and the positional
 * `provider-N` report ids follow installation order. Keeping input order equal to
 * installation order is what lets the expectation name the failing id exactly.
 */
function rollbackList(rng: Rng): readonly RollbackEntry[] {
  const generationCount = intBelow(rng, 3)
  const embeddingCount = 1 + intBelow(rng, 3)
  const total = generationCount + embeddingCount
  const failIndex = intBelow(rng, total)
  const entries: RollbackEntry[] = []
  for (let index = 0; index < total; index += 1) {
    entries.push({
      id: `p${index}`,
      operation: index < generationCount ? 'generation' : 'embedding',
      fails: index === failIndex,
    })
  }
  return entries
}

describe('Property 27: a failing setup rolls back every plugin already installed', () => {
  it(`holds for ${RUNS} generated mixed-kind activations`, () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x27_1000 + run
      const rng = rngOf(seed)
      const entries = rollbackList(rng)
      const failIndex = entries.findIndex(entry => entry.fails)
      const disposed: string[] = []
      const setupsRun: string[] = []
      const context = { seed, list: entries.map(entry => `${entry.operation}:${entry.id}`), failIndex }

      const sources: ComposableRuntimeProviderPlugin[] = entries.map((entry, index) => {
        const route = `r${index}`
        const body = (register: () => void): (() => void) | undefined => {
          setupsRun.push(entry.id)
          register()
          if (entry.fails) throw new Error('setup failed')
          return () => { disposed.push(entry.id) }
        }
        return entry.operation === 'generation'
          ? generationPlugin(entry.id, [route], registrar => body(() => {
            registrar.registerAdapter([route], new TaggedModelAdapter(entry.id))
          }))
          : embeddingPlugin(entry.id, [route], registrar => body(() => {
            registrar.registerEmbeddingAdapter([route], new TaggedEmbeddingAdapter(entry.id))
          }))
      })

      const fixture = activationFixture(sources)
      let thrown: unknown
      try {
        fixture.start()
      } catch (error) {
        thrown = error
      }
      const error = thrown as {
        readonly failureCode: string
        readonly stage: string
        readonly component?: { readonly id: string }
        readonly cleanup: readonly { readonly id: string; readonly status: string }[]
      }
      expect({ ...context, threw: thrown !== undefined }).toEqual({ ...context, threw: true })
      expect({ ...context, failureCode: error.failureCode, stage: error.stage })
        .toEqual({ ...context, failureCode: 'CAPABILITY_STARTUP_FAILED', stage: 'provider-setup' })
      expect({ ...context, component: error.component?.id })
        .toEqual({ ...context, component: `provider-${failIndex}` })

      // Every plugin installed BEFORE the failure unwinds, in reverse order,
      // across both kinds. The failing plugin returned no disposer.
      const before = entries.slice(0, failIndex).map(entry => entry.id).reverse()
      expect({ ...context, disposed }).toEqual({ ...context, disposed: before })
      // Nothing after the failure was ever set up.
      expect({ ...context, setupsRun })
        .toEqual({ ...context, setupsRun: entries.slice(0, failIndex + 1).map(entry => entry.id) })
      // Both registries end empty: the runtime owns everything or nothing.
      expect({ ...context, routes: fixture.embeddingRegistry.listRoutes() })
        .toEqual({ ...context, routes: [] })
      expect({ ...context, providers: fixture.registry.listProviders() })
        .toEqual({ ...context, providers: [] })
      // The cleanup ledger records the unwind, newest first. Whether the FAILING
      // plugin also contributes a row differs by kind, and legitimately so: the
      // generation path withdraws a throwing setup's routes through the registry
      // install transaction and only reports a row when the plugin returned a
      // disposer, while the embedding path owns the route handles itself and so
      // always reports the withdrawal. Either way the registries end empty, which
      // is asserted above and is the part the requirement actually constrains.
      const unwind = before.map((_, offset) => `provider-${failIndex - 1 - offset}`)
      expect({ ...context, cleanup: error.cleanup.map(row => row.id) }).toEqual({
        ...context,
        cleanup: entries[failIndex]!.operation === 'embedding'
          ? [`provider-${failIndex}`, ...unwind]
          : unwind,
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Property 28
// ---------------------------------------------------------------------------

const TOPOLOGY_ROUTES = ['r0', 'r1', 'r2', 'r3'] as const
const TOPOLOGY_MODELS = ['m0', 'm1', 'm2', 'm3'] as const

interface RouteTopology {
  readonly generation?: TaggedModelAdapter
  readonly wide?: TaggedEmbeddingAdapter
  /** Model id to the adapter that claimed exactly that id on this route. */
  readonly scoped: ReadonlyMap<string, TaggedEmbeddingAdapter>
}

function topologyOf(rng: Rng): ReadonlyMap<string, RouteTopology> {
  const topology = new Map<string, RouteTopology>()
  for (const route of TOPOLOGY_ROUTES) {
    if (rng() < 0.2) continue
    const scoped = new Map<string, TaggedEmbeddingAdapter>()
    const scopedCount = intBelow(rng, 3)
    for (let index = 0; index < scopedCount; index += 1) {
      const model = pick(rng, TOPOLOGY_MODELS)
      // One claim per (route, model) tier: a second same-tier claim is a
      // conflict, which is a different property's subject.
      if (!scoped.has(model)) scoped.set(model, new TaggedEmbeddingAdapter(`emb:${route}:${model}`))
    }
    const generation = rng() < 0.6 ? new TaggedModelAdapter(`gen:${route}`) : undefined
    const wide = rng() < 0.6 ? new TaggedEmbeddingAdapter(`emb:${route}:*`) : undefined
    topology.set(route, {
      ...(generation === undefined ? {} : { generation }),
      ...(wide === undefined ? {} : { wide }),
      scoped,
    })
  }
  return topology
}

describe('Property 28: adapters resolve by route, operation and model id', () => {
  it(`holds for ${RUNS} generated topologies`, () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x28_0000 + run
      const rng = rngOf(seed)
      const topology = topologyOf(rng)
      const registry = new ModelRegistry()
      const embeddingRegistry = new EmbeddingRegistry()

      for (const [route, entry] of topology) {
        if (entry.generation !== undefined) registry.registerAdapter([route], entry.generation)
        if (entry.wide !== undefined) embeddingRegistry.registerEmbeddingAdapter([route], entry.wide)
        for (const [model, adapter] of entry.scoped) {
          embeddingRegistry.registerEmbeddingAdapter([route], adapter, [model])
        }
      }

      const context = {
        seed,
        topology: [...topology].map(([route, entry]) => ({
          route,
          generation: entry.generation?.tag,
          wide: entry.wide?.tag,
          scoped: [...entry.scoped.keys()],
        })),
      }

      // The whole query grid, absences included.
      for (const route of TOPOLOGY_ROUTES) {
        const entry = topology.get(route)
        for (const model of TOPOLOGY_MODELS) {
          // Model-scoped beats route-wide: naming ids is the narrower claim.
          const expected = entry?.scoped.get(model) ?? entry?.wide
          const where = { ...context, route, model }
          if (expected === undefined) {
            // Includes the case that matters most: a route carrying ONLY a
            // ModelAdapter must fail here rather than hand it an embedding call.
            let thrown: unknown
            try {
              embeddingRegistry.resolve(route, model)
            } catch (error) {
              thrown = error
            }
            expect({ ...where, code: (thrown as { code?: string } | undefined)?.code })
              .toEqual({ ...where, code: EMBEDDING_ERROR_CODES.ADAPTER_MISSING })
          } else {
            const resolved = embeddingRegistry.resolve(route, model)
            expect({ ...where, tag: (resolved.adapter as TaggedEmbeddingAdapter).tag })
              .toEqual({ ...where, tag: expected.tag })
            expect({ ...where, resolvedRoute: resolved.route }).toEqual({ ...where, resolvedRoute: route })
          }
        }
        // Operation membership is independent per route.
        expect({ ...context, route, has: embeddingRegistry.hasRoute(route) })
          .toEqual({ ...context, route, has: entry !== undefined && (entry.wide !== undefined || entry.scoped.size > 0) })
      }

      // Generation resolution answers with the generation adapter and only with
      // generation adapters: every name in the list is a `gen:` tag.
      const expectedGeneration = [...topology]
        .filter(([, entry]) => entry.generation !== undefined)
        .map(([route, entry]) => ({ id: route, name: entry.generation!.tag }))
      expect({ ...context, providers: registry.listProviders() })
        .toEqual({ ...context, providers: expectedGeneration })
    }
  })

  it('refuses an object without embedBatch as an embedding adapter', () => {
    const embeddingRegistry = new EmbeddingRegistry()
    expect(() => embeddingRegistry.registerEmbeddingAdapter(
      ['r0'], GENERATION_ONLY_ADAPTER as never,
    )).toThrow(expect.objectContaining({ code: 'EMBEDDING_REGISTRATION_INVALID' }))
    expect(embeddingRegistry.listRoutes()).toEqual([])
  })

  it('keeps a route that only serves embedding invisible to generation resolution', async () => {
    const registry = new ModelRegistry()
    const embeddingRegistry = new EmbeddingRegistry()
    const adapter = new TaggedEmbeddingAdapter('emb-only')
    embeddingRegistry.registerEmbeddingAdapter(['embed-only'], adapter)
    expect(embeddingRegistry.resolve('embed-only', 'anything').adapter).toBe(adapter)
    await expect(registry.listModels('embed-only'))
      .rejects.toThrow(expect.objectContaining({ code: 'NO_ADAPTER' }))
  })

  it('reports EMBEDDING_ADAPTER_MISSING for a plugin that registered nothing', () => {
    const missing = BAD_PLUGIN_CASES.find(row => row.expectedReason === 'adapter-missing')
    expect(missing?.expectedCode).toBe(EMBEDDING_ERROR_CODES.ADAPTER_MISSING)
    const embeddingRegistry = new EmbeddingRegistry()
    expect(() => embeddingRegistry.resolve('fake', 'fake-embed'))
      .toThrow(expect.objectContaining({ code: EMBEDDING_ERROR_CODES.ADAPTER_MISSING }))
  })
})
