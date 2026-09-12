/**
 * The two REAL embedding providers, expressed as one conformance fixture each.
 *
 * Task 14.2 asks a question that only a fixture can answer honestly: do
 * `openAiEmbeddingPlugin` and `geminiEmbeddingPlugin` — whose wire formats have
 * nothing in common — satisfy the SAME sixteen checks and surface the SAME error
 * codes for the same faults? So everything provider-specific is isolated in one
 * {@link EmbeddingWireProvider} record, and everything scenario-specific is shared
 * by both. If a claim below held for only one of them, it would be because that
 * provider behaves differently, never because its fixture was scripted differently.
 *
 * Four decisions shape this module, and each has a plausible-looking wrong answer:
 *
 * - **The plugins are the real factories, driven by an injected `fetch`.** Nothing
 *   here re-implements an adapter or subclasses one. What the harness exercises is
 *   the exact code path a caller gets, down to the wire body, so a mapping rule
 *   that exists only in a test double cannot pass.
 * - **The response width is read off the REQUEST.** The stub answers with vectors
 *   as wide as the `dimensions` / `outputDimensionality` the adapter actually put
 *   on the wire, and falls back to the model's native width when the adapter sent
 *   no width at all. A stub with a hard-coded width would turn Property 40 ("a
 *   width travels only when the route declares it") into an untested assumption.
 * - **`providerVectors()` records what the stub returned, keyed by item index.**
 *   That is the only reference against which a permutation is detectable;
 *   comparing the SDK's output with the SDK's output always agrees.
 * - **The credential IS the private sentinel.** The harness asserts that value
 *   never reaches a trace or an error message, which makes the privacy check a
 *   real claim about a credential rather than a claim about a made-up string.
 *
 * Two asymmetries are deliberate and are the providers' own, not the fixture's:
 * OpenAI's response carries an `index` per entry so its mapping fault is a broken
 * permutation (`EMBEDDING_VECTOR_INDEX_INVALID`), while Gemini's
 * `batchEmbedContents` carries no index at all, so the only mapping fault its wire
 * can express is a wrong vector count (`EMBEDDING_VECTOR_COUNT_MISMATCH`). Both
 * codes live in the harness's mapping taxonomy, and every fault BOTH wires can
 * express is compared for code equality by {@link probeEmbeddingFault}.
 *
 * @module tests/contract/embedding/provider-conformance-fixture
 */

import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import {
  EMBEDDING_ERROR_CODES,
  deriveSpaceId,
  type EmbeddingSpaceId,
} from '@alvin0/ai-agent-sdk-core/embedding'
import type { ComposableRuntimeProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import type { EmbeddingCatalogModel } from '@alvin0/ai-agent-sdk-provider-http'
import {
  GEMINI_EMBEDDING_MODELS,
  geminiEmbeddingPlugin,
  geminiPlugin,
} from '@alvin0/ai-agent-sdk-provider-gemini'
import { openAiEmbeddingPlugin, openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'
import type {
  EmbeddingConformanceCase,
  EmbeddingConformanceCaseInput,
  EmbeddingConformanceControlSnapshot,
  EmbeddingConformanceDispatch,
  EmbeddingConformanceFixture,
  EmbeddingConformanceScenario,
} from '@alvin0/ai-agent-sdk-testkit'

const ENCODER = new TextEncoder()

/**
 * Retry budget every case runs under.
 *
 * Explicit and tiny: the retry scenario has to spend a real second attempt, and
 * the SDK default of five retries at 500 ms would make that a slow test rather
 * than a different one.
 */
const RETRY_POLICY = Object.freeze({
  mode: 'normal' as const,
  maxRetries: 2,
  backoff: Object.freeze({ initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }),
})

/**
 * Batch bounds the batching, abort and retry scenarios declare.
 *
 * `maxItems` is deliberately far below the twelve-input corpus, and `maxTokens`
 * is set just under three items' worth (~23 estimated tokens each) so two bounds
 * agree on the same split instead of one being decorative.
 */
const BATCH_LIMITS = Object.freeze({ maxItems: 2, maxTokens: 60, maxBytes: 8_192 })

/** Request timeout of the retry scenario; short, because one attempt must hit it. */
const RETRY_TIMEOUT_MS = 60

/** Delay the batching scenario answers with, so two batches are in flight at once. */
const OVERLAP_DELAY_MS = 5

// ---------------------------------------------------------------------------
// Faults a scenario can script
// ---------------------------------------------------------------------------

/**
 * What the stub does with one dispatch.
 *
 * `mapping` and `vector-value` are the two response faults; each provider spells
 * `mapping` in the only way its own wire can.
 */
type ResponseFault = 'none' | 'mapping' | 'vector-value' | 'count-mismatch' | 'wrong-width' | 'shape'

/** How a whole case behaves, independent of provider. */
interface ScenarioPlan {
  readonly fault: ResponseFault
  /** Answer in reverse wire order, where the wire can express an order at all. */
  readonly reorder: boolean
  readonly includeUsage: boolean
  /** Hang until the caller (or `close()`) aborts the request. */
  readonly hang: boolean
  /** Hang on the FIRST dispatch only, so it times out and is retried. */
  readonly timeoutFirst: boolean
  readonly slow: boolean
  /** Native model width instead of the narrow one; keeps post-processing absent. */
  readonly nativeWidth: boolean
  readonly barrier: boolean
  readonly declareLimits: boolean
  readonly concurrency?: number
  readonly expectedAttempts?: number
  readonly requestTimeoutMs?: number
  readonly failure?: 'mapping' | 'vector-value'
  /** Declare an incompatible `Space_Id` and, where one exists, a foreign model. */
  readonly compatibility: boolean
  readonly alternateWidth: boolean
  /** Install the provider's GENERATION plugin instead of its embedding plugin. */
  readonly generationOnly: boolean
}

const BASE_PLAN: ScenarioPlan = Object.freeze({
  fault: 'none',
  reorder: false,
  includeUsage: true,
  hang: false,
  timeoutFirst: false,
  slow: false,
  nativeWidth: false,
  barrier: false,
  declareLimits: false,
  compatibility: false,
  alternateWidth: false,
  generationOnly: false,
})

/** The twelve scenarios as plans; provider-independent by construction. */
function planOf(scenario: EmbeddingConformanceScenario): ScenarioPlan {
  switch (scenario) {
    case 'embedding-success':
      return BASE_PLAN
    case 'embedding-reordered-response':
      // Native width so no post-processing is recorded: vector fidelity is only
      // observable when the profile declares no transform.
      return Object.freeze({ ...BASE_PLAN, reorder: true, nativeWidth: true })
    case 'embedding-invalid-index':
      return Object.freeze({ ...BASE_PLAN, fault: 'mapping', failure: 'mapping' as const })
    case 'embedding-invalid-vector':
      return Object.freeze({ ...BASE_PLAN, fault: 'vector-value', failure: 'vector-value' as const })
    case 'embedding-batch-limits':
      return Object.freeze({ ...BASE_PLAN, declareLimits: true, concurrency: 2, slow: true })
    case 'embedding-abort-in-flight':
      // Concurrency one, so the batches after the aborted one are provably unsent
      // rather than merely unlikely to have been sent.
      return Object.freeze({ ...BASE_PLAN, declareLimits: true, concurrency: 1, hang: true, barrier: true })
    case 'embedding-retry-cost':
      return Object.freeze({
        ...BASE_PLAN,
        declareLimits: true,
        concurrency: 1,
        timeoutFirst: true,
        requestTimeoutMs: RETRY_TIMEOUT_MS,
        // Two batches, the first of which times out once: 1 + 1 + 1.
        expectedAttempts: 3,
      })
    case 'embedding-missing-usage':
      return Object.freeze({ ...BASE_PLAN, includeUsage: false })
    case 'embedding-cache-key':
      return Object.freeze({ ...BASE_PLAN, alternateWidth: true })
    case 'embedding-space-mismatch':
      return Object.freeze({ ...BASE_PLAN, compatibility: true })
    case 'embedding-only-runtime':
      return BASE_PLAN
    case 'generation-only-plugin':
      return Object.freeze({ ...BASE_PLAN, generationOnly: true })
  }
}

// ---------------------------------------------------------------------------
// One provider's wire shape
// ---------------------------------------------------------------------------

/** What the stub read out of one outbound request. */
interface WireRequest {
  /** Model id the request went out under, without any resource-name prefix. */
  readonly model: string
  /** Effective text per wire input, in wire order. */
  readonly texts: readonly string[]
  /** Width the adapter asked for, or `undefined` when it asked for none. */
  readonly width: number | undefined
}

/** One vector the stub is about to publish, at its position in the batch. */
interface WireEntry {
  readonly position: number
  readonly values: readonly number[]
}

interface RenderOptions {
  readonly fault: ResponseFault
  readonly reorder: boolean
  readonly includeUsage: boolean
  readonly tokens: number
}

interface PluginConfig {
  readonly id: string
  readonly route: string
  readonly credential: string
  readonly fetch: typeof globalThis.fetch
  readonly requestTimeoutMs?: number
}

/**
 * Everything that differs between the two providers, and nothing that does not.
 *
 * Adding a third provider means adding one of these; it does not mean touching a
 * scenario.
 */
interface EmbeddingWireProvider {
  readonly name: 'openai' | 'gemini'
  readonly model: string
  /** A second model id on the same route whose declared space differs, if any. */
  readonly foreignModel?: string
  /** Width used by most scenarios. */
  readonly standardWidth: number
  /** The model's native width; requesting it records no post-processing. */
  readonly nativeWidth: number
  /** A second declared width, for the cache scenario. */
  readonly alternateWidth: number
  /** An identity from a genuinely different model generation. */
  readonly foreignIdentity: string
  /** The one code this provider's wire uses for a mapping fault. */
  readonly mappingFailureCode: string
  readRequest(rawBody: string): WireRequest
  render(entries: readonly WireEntry[], options: RenderOptions): string
  embeddingPlugin(config: PluginConfig): ComposableRuntimeProviderPlugin
  generationPlugin(config: PluginConfig): ComposableRuntimeProviderPlugin
}

/**
 * OpenAI's declared embedding catalog for these cases.
 *
 * Declared rather than borrowed: `openAiEmbeddingPlugin` ships an EMPTY catalog on
 * purpose, and a declared entry is what makes `dimensions` reachable on the wire
 * and what states the embedding space. Two model lines with two different
 * identities are declared so "no fallback across spaces" has something to compare.
 */
const OPENAI_MODELS: readonly EmbeddingCatalogModel[] = Object.freeze([
  Object.freeze({
    id: 'text-embedding-3-small',
    dimensions: Object.freeze([8, 16]),
    defaultDimensions: 8,
    maxInputTokens: 8_191,
    purposeHandling: 'unsupported' as const,
    compatibilityIdentity: 'openai:text-embedding-3-small',
  }),
  Object.freeze({
    id: 'text-embedding-3-large',
    dimensions: Object.freeze([8, 16]),
    defaultDimensions: 8,
    maxInputTokens: 8_191,
    purposeHandling: 'unsupported' as const,
    compatibilityIdentity: 'openai:text-embedding-3-large',
  }),
])

const OPENAI_WIRE: EmbeddingWireProvider = Object.freeze({
  name: 'openai' as const,
  model: 'text-embedding-3-small',
  foreignModel: 'text-embedding-3-large',
  standardWidth: 8,
  nativeWidth: 8,
  alternateWidth: 16,
  foreignIdentity: 'openai:text-embedding-legacy',
  mappingFailureCode: EMBEDDING_ERROR_CODES.VECTOR_INDEX_INVALID,

  readRequest(rawBody: string): WireRequest {
    const body = parseObject(rawBody)
    const inputs = body['input']
    if (!Array.isArray(inputs)) throw new Error('OpenAI embedding request carries no input array')
    const width = body['dimensions']
    return {
      model: String(body['model'] ?? ''),
      texts: inputs.map(value => String(value)),
      width: typeof width === 'number' ? width : undefined,
    }
  },

  render(entries: readonly WireEntry[], options: RenderOptions): string {
    if (options.fault === 'shape') return '{"object":"list"}'
    // `index` is the entry's position in the batch, which is what the adapter maps
    // back through `items[index].index`.
    let rows = entries.map(entry => ({ index: entry.position, values: entry.values }))
    if (options.reorder) rows = [...rows].reverse()
    if (options.fault === 'mapping') rows = duplicateFirstIndex(rows)
    if (options.fault === 'count-mismatch') rows = rows.slice(0, -1)
    if (options.fault === 'wrong-width') rows = rows.map(row => ({ ...row, values: row.values.slice(1) }))
    if (options.fault === 'vector-value') rows = rows.map(withNonFiniteHead)
    const data = rows.map(row =>
      `{"object":"embedding","index":${row.index},"embedding":[${renderValues(row.values)}]}`)
    const usage = options.includeUsage
      ? `,"usage":{"prompt_tokens":${options.tokens},"total_tokens":${options.tokens}}`
      : ''
    return `{"object":"list","model":"text-embedding-3-small","data":[${data.join(',')}]${usage}}`
  },

  embeddingPlugin(config: PluginConfig): ComposableRuntimeProviderPlugin {
    return openAiEmbeddingPlugin({
      apiKey: config.credential,
      id: config.id,
      routes: [config.route],
      models: OPENAI_MODELS,
      retryPolicy: RETRY_POLICY,
      fetch: config.fetch,
      ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
    })
  },

  generationPlugin(config: PluginConfig): ComposableRuntimeProviderPlugin {
    return openAiPlugin({
      apiKey: config.credential,
      id: config.id,
      routes: [config.route],
      fetch: config.fetch,
    })
  },
})

/**
 * Gemini's catalog is the SHIPPED one.
 *
 * `GEMINI_EMBEDDING_MODELS` is what a caller gets by default, and it is where the
 * `taskType` wire parameter, the selectable widths and the generation-scoped
 * compatibility identity are declared. Substituting a convenient catalog would
 * test the fixture's declarations instead of the provider's.
 */
const GEMINI_WIRE: EmbeddingWireProvider = Object.freeze({
  name: 'gemini' as const,
  model: 'gemini-embedding-001',
  standardWidth: 768,
  nativeWidth: 3_072,
  alternateWidth: 1_536,
  foreignIdentity: 'google:gemini-embedding-2',
  // `batchEmbedContents` returns no index, so a broken permutation is not
  // expressible on this wire; a wrong count is the mapping fault it has.
  mappingFailureCode: EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH,

  readRequest(rawBody: string): WireRequest {
    const body = parseObject(rawBody)
    const requests = body['requests']
    if (!Array.isArray(requests)) throw new Error('Gemini embedding request carries no requests array')
    const rows = requests.map(value => asObject(value))
    const first = rows[0]
    const width = first?.['outputDimensionality']
    const model = String(first?.['model'] ?? '')
    return {
      model: model.startsWith('models/') ? model.slice('models/'.length) : model,
      // Several content parts are components of ONE object, so they concatenate
      // into one wire input exactly as the adapter's recipe revision records.
      texts: rows.map(row => {
        const parts = asObject(row['content'])['parts']
        if (!Array.isArray(parts)) throw new Error('Gemini embedding request carries no content parts')
        return parts.map(part => String(asObject(part)['text'] ?? '')).join('')
      }),
      width: typeof width === 'number' ? width : undefined,
    }
  },

  render(entries: readonly WireEntry[], options: RenderOptions): string {
    if (options.fault === 'shape') return '{"predictions":[]}'
    // `reorder` is ignored on purpose: this wire has no index to permute, so the
    // mapping claim it can answer is positional fidelity, not permutation repair.
    let rows = entries.map(entry => ({ values: entry.values }))
    if (options.fault === 'mapping' || options.fault === 'count-mismatch') rows = rows.slice(0, -1)
    if (options.fault === 'wrong-width') rows = rows.map(row => ({ values: row.values.slice(1) }))
    if (options.fault === 'vector-value') rows = rows.map(withNonFiniteHead)
    const embeddings = rows.map(row => `{"values":[${renderValues(row.values)}]}`)
    // No usage member at all: `batchEmbedContents` reports none, and inventing one
    // would hide the very absence the usage-honesty check is about.
    return `{"embeddings":[${embeddings.join(',')}]}`
  },

  embeddingPlugin(config: PluginConfig): ComposableRuntimeProviderPlugin {
    return geminiEmbeddingPlugin({
      apiKey: config.credential,
      id: config.id,
      routes: [config.route],
      models: GEMINI_EMBEDDING_MODELS,
      retryPolicy: RETRY_POLICY,
      fetch: config.fetch,
      ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
    })
  },

  generationPlugin(config: PluginConfig): ComposableRuntimeProviderPlugin {
    return geminiPlugin({
      apiKey: config.credential,
      id: config.id,
      routes: [config.route],
      fetch: config.fetch,
    })
  },
})

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

/** Drive `openAiEmbeddingPlugin` through the embedding conformance contract. */
export function openAiEmbeddingConformanceFixture(): EmbeddingConformanceFixture {
  return fixtureFor(OPENAI_WIRE)
}

/** Drive `geminiEmbeddingPlugin` through the embedding conformance contract. */
export function geminiEmbeddingConformanceFixture(): EmbeddingConformanceFixture {
  return fixtureFor(GEMINI_WIRE)
}

function fixtureFor(wire: EmbeddingWireProvider): EmbeddingConformanceFixture {
  return Object.freeze({
    create: (input: EmbeddingConformanceCaseInput): EmbeddingConformanceCase =>
      buildCase(wire, input),
  })
}

/** Mutable evidence one case accumulates; read through `snapshot()`. */
interface CaseState {
  setupCalls: number
  cleanupCalls: number
  dispatchCount: number
  inFlight: number
  peakInFlight: number
  inFlightBytes: number
  peakInFlightBytes: number
  readonly dispatches: EmbeddingConformanceDispatch[]
}

function buildCase(
  wire: EmbeddingWireProvider,
  input: EmbeddingConformanceCaseInput,
): EmbeddingConformanceCase {
  const plan = planOf(input.scenario)
  const state: CaseState = {
    setupCalls: 0,
    cleanupCalls: 0,
    dispatchCount: 0,
    inFlight: 0,
    peakInFlight: 0,
    inFlightBytes: 0,
    peakInFlightBytes: 0,
    dispatches: [],
  }
  /** Values the provider returned, per item index, BEFORE any post-processing. */
  const produced = new Map<number, readonly number[]>()
  const indexer = textIndexer(input.inputs)
  let enterDispatch = (): void => {}
  const entered = new Promise<void>((resolve) => { enterDispatch = resolve })

  const scriptedFetch: typeof globalThis.fetch = async (_url, init) => {
    const rawBody = typeof init?.body === 'string' ? init.body : ''
    const request = wire.readRequest(rawBody)
    const byteCount = ENCODER.encode(rawBody).byteLength
    const ordinal = state.dispatchCount + 1
    state.dispatchCount = ordinal
    // Hanging is scripted, so whether this attempt fails is known before it does.
    const hangs = plan.hang || (plan.timeoutFirst && ordinal === 1)
    const failed = hangs || plan.fault !== 'none'
    const itemIndexes = Object.freeze(request.texts.map(text => indexer.of(text)))
    state.dispatches.push(Object.freeze({
      model: request.model,
      itemIndexes,
      byteCount,
      failed,
    }))
    state.inFlight += 1
    state.inFlightBytes += byteCount
    state.peakInFlight = Math.max(state.peakInFlight, state.inFlight)
    state.peakInFlightBytes = Math.max(state.peakInFlightBytes, state.inFlightBytes)
    enterDispatch()
    try {
      if (hangs) {
        // Resolves only when the caller's abort or the request timeout fires, so
        // "abort while a batch is on the wire" is a fact rather than a race.
        await untilAborted(init?.signal ?? undefined)
        throw new DOMException('embedding request aborted', 'AbortError')
      }
      if (plan.slow) await sleep(OVERLAP_DELAY_MS)
      const width = request.width ?? wire.nativeWidth
      const entries = request.texts.map((text, position) => {
        const values = vectorFor(text, width)
        produced.set(itemIndexes[position]!, values)
        return { position, values }
      })
      const body = wire.render(entries, {
        fault: plan.fault,
        reorder: plan.reorder,
        includeUsage: plan.includeUsage,
        tokens: estimatedTokensOf(request.texts),
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    } finally {
      state.inFlight -= 1
      state.inFlightBytes -= byteCount
    }
  }

  const config: PluginConfig = {
    id: input.id,
    route: input.route,
    // The credential is the private value, so the privacy check is a claim about
    // a real secret rather than about a decorative string.
    credential: input.privateSentinel,
    fetch: scriptedFetch,
    ...(plan.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: plan.requestTimeoutMs }),
  }
  const plugin = counted(
    plan.generationOnly ? wire.generationPlugin(config) : wire.embeddingPlugin(config),
    state,
  )
  const dimensions = plan.nativeWidth ? wire.nativeWidth : wire.standardWidth

  return Object.freeze<EmbeddingConformanceCase>({
    plugin,
    route: input.route,
    model: wire.model,
    dimensions,
    ...(plan.concurrency === undefined ? {} : { concurrency: plan.concurrency }),
    ...(plan.declareLimits ? { batchLimits: BATCH_LIMITS } : {}),
    ...(plan.expectedAttempts === undefined ? {} : { expectedAttempts: plan.expectedAttempts }),
    ...(plan.failure === undefined
      ? {}
      : {
        expectedFailureCode: plan.failure === 'mapping'
          ? wire.mappingFailureCode
          : EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID,
      }),
    ...(plan.compatibility
      ? {
        incompatibleSpace: foreignSpace(wire, input.route, dimensions),
        ...(wire.foreignModel === undefined ? {} : { foreignModel: wire.foreignModel }),
      }
      : {}),
    ...(plan.alternateWidth ? { alternateDimensions: wire.alternateWidth } : {}),
    control: Object.freeze({
      snapshot: (): EmbeddingConformanceControlSnapshot => Object.freeze({
        setupCalls: state.setupCalls,
        cleanupCalls: state.cleanupCalls,
        dispatches: Object.freeze([...state.dispatches]),
        peakInFlight: state.peakInFlight,
        peakInFlightBytes: state.peakInFlightBytes,
      }),
      ...(plan.barrier ? { waitForDispatch: () => entered } : {}),
      providerVectors: (): ReadonlyMap<number, readonly number[]> => new Map(produced),
    }),
  })
}

/**
 * A `Space_Id` from a genuinely different model generation.
 *
 * Derived rather than edited: the only component that moves is the declared
 * compatibility identity, which is exactly what decides space compatibility.
 */
function foreignSpace(
  wire: EmbeddingWireProvider,
  route: string,
  dimensions: number,
): EmbeddingSpaceId {
  return deriveSpaceId({
    modelIdentity: `${route}:${wire.model}`,
    dimensions,
    representation: 'dense-float32',
    normalization: 'unknown',
    documentRecipeRevision: '1',
    queryRecipeRevision: '1',
    compatibilityIdentity: wire.foreignIdentity,
    profileRevision: '1',
  })
}

/**
 * Wrap a plugin so its setup and cleanup are counted.
 *
 * A wrapper rather than a hand-built plugin, because the plugin under test must
 * be the one `openAiEmbeddingPlugin` / `geminiEmbeddingPlugin` produce — markers,
 * api version, route capture and all. The cast is the price of counting across
 * two plugin KINDS whose `setup` takes two different registrars; nothing about
 * the wrapped value's shape changes.
 */
function counted(
  plugin: ComposableRuntimeProviderPlugin,
  state: CaseState,
): ComposableRuntimeProviderPlugin {
  const inner = plugin.setup as (registrar: unknown) => undefined | (() => void)
  return Object.freeze({
    ...plugin,
    setup: (registrar: unknown) => {
      state.setupCalls += 1
      const cleanup = inner.call(plugin, registrar)
      return () => {
        state.cleanupCalls += 1
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }) as unknown as ComposableRuntimeProviderPlugin
}

// ---------------------------------------------------------------------------
// Cross-provider fault probe
// ---------------------------------------------------------------------------

/**
 * A fault BOTH wires can express, so both providers must answer it identically.
 *
 * A broken index permutation is absent by necessity, not by omission: Gemini's
 * `batchEmbedContents` carries no index, so there is no such response to send it.
 */
export const EMBEDDING_FAULTS = Object.freeze([
  'vector-count',
  'vector-value',
  'vector-width',
  'response-shape',
  'truncation-unsupported',
  'dimensions-unsupported',
] as const)

export type EmbeddingFault = typeof EMBEDDING_FAULTS[number]

/** The code every provider must report for one fault. */
export const EMBEDDING_FAULT_CODES: Readonly<Record<EmbeddingFault, string>> = Object.freeze({
  'vector-count': EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH,
  'vector-value': EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID,
  'vector-width': EMBEDDING_ERROR_CODES.VECTOR_DIMENSIONS_MISMATCH,
  'response-shape': EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  'truncation-unsupported': EMBEDDING_ERROR_CODES.TRUNCATION_UNSUPPORTED,
  'dimensions-unsupported': EMBEDDING_ERROR_CODES.DIMENSIONS_UNSUPPORTED,
})

/** The two providers, by name, for a parameterised comparison. */
export const EMBEDDING_WIRE_PROVIDERS = Object.freeze(['openai', 'gemini'] as const)

export type EmbeddingWireProviderName = typeof EMBEDDING_WIRE_PROVIDERS[number]

function wireOf(name: EmbeddingWireProviderName): EmbeddingWireProvider {
  return name === 'openai' ? OPENAI_WIRE : GEMINI_WIRE
}

/**
 * Run one fault through the real runtime and report the code that surfaced.
 *
 * Through the runtime rather than the adapter, because two of these faults are
 * pre-dispatch rejections the runtime owns, and a comparison that took a
 * different path for different faults would compare two different things.
 *
 * @param name - which provider to drive.
 * @param fault - the fault to script.
 * @returns the stable code the call failed with, or `'RESOLVED'` if it succeeded.
 */
export async function probeEmbeddingFault(
  name: EmbeddingWireProviderName,
  fault: EmbeddingFault,
): Promise<string> {
  const wire = wireOf(name)
  const route = `embedding-fault-${name}`
  const inputs = Object.freeze(['first probe document', 'second probe document'])
  let dispatches = 0
  const scriptedFetch: typeof globalThis.fetch = (_url, init) => {
    dispatches += 1
    const request = wire.readRequest(typeof init?.body === 'string' ? init.body : '')
    const width = request.width ?? wire.nativeWidth
    const entries = request.texts.map((text, position) => ({
      position,
      values: vectorFor(text, width),
    }))
    return Promise.resolve(new Response(
      wire.render(entries, {
        fault: responseFaultOf(fault),
        reorder: false,
        includeUsage: true,
        tokens: estimatedTokensOf(request.texts),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
  }
  const runtime = await createAgentRuntime({
    providers: [wire.embeddingPlugin({
      id: route,
      route,
      credential: 'embedding-fault-probe-key',
      fetch: scriptedFetch,
    })],
  })
  try {
    const handle = runtime.embeddingModel({
      provider: route,
      model: wire.model,
      // An undeclared width is the pre-dispatch dimensions fault; every other
      // fault runs at the provider's standard width.
      dimensions: fault === 'dimensions-unsupported' ? undeclaredWidth(wire) : wire.standardWidth,
      ...(fault === 'truncation-unsupported' ? { truncation: 'allow' as const } : {}),
    })
    await handle.embedMany({ values: inputs, purpose: 'retrieval-document' })
    return dispatches === 0 ? 'RESOLVED_WITHOUT_DISPATCH' : 'RESOLVED'
  } catch (error: unknown) {
    return codeOf(error)
  } finally {
    await runtime.close()
  }
}

/** A width no route in these fixtures declares, so it is refused before dispatch. */
function undeclaredWidth(wire: EmbeddingWireProvider): number {
  return wire.standardWidth + 1
}

function responseFaultOf(fault: EmbeddingFault): ResponseFault {
  switch (fault) {
    case 'vector-count': return 'count-mismatch'
    case 'vector-value': return 'vector-value'
    case 'vector-width': return 'wrong-width'
    case 'response-shape': return 'shape'
    default: return 'none'
  }
}

/** The stable code of a rejection, without trusting the value's shape. */
function codeOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = Reflect.get(error, 'code')
    if (typeof code === 'string' && code.length > 0) return code
  }
  return 'UNKNOWN'
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Maps a wire text back to the item index it belongs to.
 *
 * Item indexes come from the harness's own corpus, so a mapping fault would show
 * up here as a foreign index rather than being silently renumbered. A text the
 * corpus never contained — the cache scenario deliberately sends revised copies —
 * gets a fresh index beyond the corpus, so two different texts never collide.
 */
function textIndexer(inputs: readonly string[]): { of(text: string): number } {
  const known = new Map<string, number>(inputs.map((text, index) => [text, index]))
  let next = inputs.length
  return {
    of(text: string): number {
      const existing = known.get(text)
      if (existing !== undefined) return existing
      const assigned = next
      next += 1
      known.set(text, assigned)
      return assigned
    },
  }
}

/**
 * A deterministic, decidedly non-unit vector for one text.
 *
 * Full double precision, because the privacy check only searches for renderings
 * of eight characters or more, and a rounded value would make that search
 * vacuous. Deterministic in the text, so the same input always yields the same
 * vector and a cache comparison is meaningful.
 */
function vectorFor(text: string, width: number): readonly number[] {
  const random = mulberry32(hashOf(text) ^ (width * 0x9e37_79b9))
  return Object.freeze(Array.from({ length: width }, () => (random() - 0.5) * 3.7))
}

function hashOf(text: string): number {
  let hash = 0x811c_9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x0100_0193) >>> 0
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Serialises vector values as JSON text.
 *
 * Text rather than `JSON.stringify`, because `Infinity` has no JSON literal and
 * the serialiser would quietly turn it into `null` — a malformed SHAPE instead of
 * the non-finite VALUE the fault is about. `1e999` parses back to `Infinity`.
 */
function renderValues(values: readonly number[]): string {
  return values.map(value => (Number.isFinite(value) ? String(value) : '1e999')).join(',')
}

function withNonFiniteHead<T extends { readonly values: readonly number[] }>(row: T, at: number): T {
  if (at !== 0) return row
  return { ...row, values: [Number.POSITIVE_INFINITY, ...row.values.slice(1)] }
}

/** Duplicate the first entry's index onto the last, breaking the permutation. */
function duplicateFirstIndex(
  rows: readonly { readonly index: number; readonly values: readonly number[] }[],
): { readonly index: number; readonly values: readonly number[] }[] {
  const first = rows[0]
  if (first === undefined || rows.length < 2) return [...rows]
  return rows.map((row, at) => (at === rows.length - 1 ? { ...row, index: first.index } : row))
}

/** The same `ceil(utf8Bytes / 4)` estimate the SDK batches with. */
function estimatedTokensOf(texts: readonly string[]): number {
  return texts.reduce((sum, text) => sum + Math.ceil(ENCODER.encode(text).byteLength / 4), 0)
}

function parseObject(rawBody: string): Readonly<Record<string, unknown>> {
  return asObject(JSON.parse(rawBody))
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('embedding wire value is not an object')
  }
  return value as Readonly<Record<string, unknown>>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise(() => {})
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}
