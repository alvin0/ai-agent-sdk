/**
 * Whole-input startup preflight across both provider plugin kinds.
 *
 * The generation-only preflight fails fast on the first bad entry. Requirement
 * 11.6 asks for the opposite shape: scan the ENTIRE `providers` list, collect
 * every marker, apiVersion and route–operation failure, and only then decide.
 * That is what this module adds, and it is deliberately additive —
 * `preflightProviderIdentities()` keeps its fail-fast contract for callers that
 * validate one kind on its own.
 *
 * Two properties this file has to preserve:
 *
 * - Nothing executable is read. Every value comes from
 *   {@link ownData}/{@link readProviderMetadata}, so a plugin's `setup` is never
 *   touched here. Method capture happens later, and only when the sweep found
 *   nothing, which is what makes "plugins already `setup()` on failure = 0" a
 *   structural fact rather than a test result.
 * - The thrown error keeps `failureCode` equal to the FIRST failure's code, so
 *   assertions written against fail-fast behaviour keep their meaning. The full
 *   list travels in `aggregate` (DD-3).
 *
 * Duplicate detection is on the route–OPERATION pair. A generation plugin and an
 * embedding plugin may share a route (that is the whole point of resolution by
 * route + operation + model id), while two plugins of the same operation may not.
 *
 * @module ai-agent-sdk/core/composition/embedding/preflight
 */

import { COMPOSITION_LIMITS } from '../common/config.ts'
import { arrayData, boundedText, capturedMethod, objectValue, ownData } from '../common/data.ts'
import {
  AgentRuntimeConstructionError, checkPreflightAbort, invalidPreflight,
  type RuntimeConstructionAggregateEntry, type RuntimeConstructionFailureCode,
} from '../common/errors.ts'
import { capabilityIdentityConflict } from '../identity/error.ts'
import {
  createProviderIdentityPlan, readProviderMetadata, type ProviderIdentityPlan,
} from '../provider/preflight.ts'
import { PROVIDER_PLUGIN_API_VERSION, type ProviderMetadata } from '../provider/types.ts'
import {
  EMBEDDING_PROVIDER_PLUGIN_API_VERSION, type ComposableEmbeddingProviderPlugin,
  type EmbeddingProviderRegistrar,
} from './plugin-types.ts'

/** One failure found by the sweep, positioned in the caller's input list. */
export interface ProviderPreflightFailure extends RuntimeConstructionAggregateEntry {
  readonly index: number
  readonly code: Extract<
    RuntimeConstructionFailureCode,
    'CAPABILITY_KIND_MISMATCH' | 'CAPABILITY_API_UNSUPPORTED' | 'PROVIDER_ROUTE_CONFLICT'
    | 'PROVIDER_OPERATION_CONFLICT' | 'CAPABILITY_ID_CONFLICT'
    // A malformed identity is not one of the five collectable classes, but the
    // sweep must not stop on it either; it keeps the generic code the fail-fast
    // path already reports for the same input.
    | 'CAPABILITY_STARTUP_FAILED'
  >
  /** Only when the id was readable as inert, bounded data. */
  readonly pluginId?: string
  readonly conflictsWithIndex?: number
}

/** Internal phase token for the embedding half, mirroring `ProviderIdentityPlan`. */
export interface EmbeddingIdentityPlan {
  readonly providers: readonly ProviderMetadata[]
}

/** An embedding plugin whose `setup` has been captured exactly once. */
export interface CapturedEmbeddingProvider extends ProviderMetadata {
  readonly setup: ComposableEmbeddingProviderPlugin['setup']
}

/** Both halves of one validated `providers` list. */
export interface RuntimeProviderPlan {
  readonly generation: ProviderIdentityPlan
  readonly embedding: EmbeddingIdentityPlan
}

const sourcesByPlan = new WeakMap<EmbeddingIdentityPlan, readonly object[]>()
const methodsByPlan = new WeakMap<EmbeddingIdentityPlan, readonly CapturedEmbeddingProvider[]>()

/** Which operation a plugin kind answers; route claims are namespaced by it. */
type Operation = 'generation' | 'embedding'

interface ScannedProvider {
  readonly index: number
  readonly operation: Operation
  readonly source: object
  readonly metadata: ProviderMetadata
}

/**
 * Validate an entire `providers` list without committing anything.
 *
 * @param input - the caller's `providers` value, of any shape.
 * @param defaultProvider - optional selected default route.
 * @param signal - startup signal; an abort wins over collected failures.
 * @throws AgentRuntimeConstructionError with `failureCode` of the first failure and
 *   `aggregate` listing all of them.
 */
export function preflightRuntimeProviders(
  input: unknown,
  defaultProvider?: unknown,
  signal?: AbortSignal,
): RuntimeProviderPlan {
  checkPreflightAbort(signal)
  const sources = readSources(input, signal)
  const failures: ProviderPreflightFailure[] = []
  const scanned: ScannedProvider[] = []
  const ids = new Map<string, number>()
  // Keyed by operation + route: the pair IS the namespace (Requirement 11.10).
  const routes = new Map<string, number>()

  for (const [index, source] of sources.entries()) {
    checkPreflightAbort(signal)
    const operation = operationOf(source)
    if (operation === undefined) {
      failures.push(failure(index, 'CAPABILITY_KIND_MISMATCH', source))
      continue
    }
    if (!supportedApiVersion(source, operation)) {
      failures.push(failure(index, 'CAPABILITY_API_UNSUPPORTED', source))
      continue
    }
    let metadata: ProviderMetadata
    try {
      metadata = readProviderMetadata(source)
    } catch {
      if (signal?.aborted === true) checkPreflightAbort(signal)
      failures.push(failure(index, 'CAPABILITY_STARTUP_FAILED', source))
      continue
    }
    const duplicateId = ids.get(metadata.id)
    if (duplicateId !== undefined) {
      failures.push(failure(index, 'CAPABILITY_ID_CONFLICT', source, metadata.id, duplicateId))
      continue
    }
    ids.set(metadata.id, index)
    let conflicted = false
    for (const route of metadata.routes) {
      const key = `${operation}\u0000${route}`
      const first = routes.get(key)
      if (first !== undefined) {
        // A generation collision keeps its historical code; an embedding
        // collision is the new route–operation class.
        failures.push(failure(index,
          operation === 'generation' ? 'PROVIDER_ROUTE_CONFLICT' : 'PROVIDER_OPERATION_CONFLICT',
          source, metadata.id, first))
        conflicted = true
        break
      }
      routes.set(key, index)
    }
    if (conflicted) continue
    scanned.push({ index, operation, source, metadata })
  }

  checkPreflightAbort(signal)
  if (failures.length > 0) throw aggregateFailure(failures)

  const selected = defaultProvider === undefined ? undefined
    : boundedTextOrInvalid(defaultProvider)
  if (selected !== undefined
    && !scanned.some(entry => entry.metadata.defaultModel?.provider === selected)) {
    throw invalidPreflight()
  }
  checkPreflightAbort(signal)
  const generation = scanned.filter(entry => entry.operation === 'generation')
  const embedding = scanned.filter(entry => entry.operation === 'embedding')
  return Object.freeze({
    generation: createProviderIdentityPlan(
      generation.map(entry => entry.metadata), generation.map(entry => entry.source), selected,
    ),
    embedding: createEmbeddingIdentityPlan(
      embedding.map(entry => entry.metadata), embedding.map(entry => entry.source),
    ),
  })
}

/** Freeze an embedding plan from already validated metadata and retain its sources. */
export function createEmbeddingIdentityPlan(
  providers: readonly ProviderMetadata[],
  sources: readonly object[],
): EmbeddingIdentityPlan {
  const plan: EmbeddingIdentityPlan = Object.freeze({ providers: Object.freeze([...providers]) })
  sourcesByPlan.set(plan, Object.freeze([...sources]))
  return plan
}

/**
 * Capture each embedding plugin's `setup` exactly once.
 *
 * Call only after the WHOLE input passed the sweep: reading a method is the first
 * observable interaction with a plugin object, so it must not happen while any
 * identity failure is still outstanding.
 */
export function captureEmbeddingMethods(
  plan: EmbeddingIdentityPlan,
  signal?: AbortSignal,
): readonly CapturedEmbeddingProvider[] {
  checkPreflightAbort(signal)
  const captured = methodsByPlan.get(plan)
  if (captured !== undefined) return captured
  const sources = sourcesByPlan.get(plan)
  if (sources === undefined) throw invalidPreflight()
  // A failed capture is terminal too: never reread a partially observed table.
  sourcesByPlan.delete(plan)
  try {
    const result = plan.providers.map((provider, index) => {
      checkPreflightAbort(signal)
      const setup = capturedMethod<[EmbeddingProviderRegistrar], void | (() => void)>(
        sources[index]!, 'setup',
      )
      return Object.freeze({ ...provider, setup })
    })
    checkPreflightAbort(signal)
    const frozen = Object.freeze(result)
    methodsByPlan.set(plan, frozen)
    return frozen
  } catch {
    checkPreflightAbort(signal)
    throw invalidPreflight()
  }
}

/** The list itself is validated fail-fast: a malformed list has no per-entry failures to collect. */
function readSources(input: unknown, signal?: AbortSignal): readonly object[] {
  try {
    return arrayData(input, COMPOSITION_LIMITS.providers).map(objectValue)
  } catch {
    if (signal?.aborted === true) checkPreflightAbort(signal)
    throw invalidPreflight()
  }
}

/** Marker comparison stays here so a foreign property-access throw is never rethrown. */
function operationOf(source: object): Operation | undefined {
  let kind: unknown
  try {
    kind = ownData(source, 'kind', false)
  } catch {
    return undefined
  }
  if (kind === 'model-provider-plugin') return 'generation'
  if (kind === 'embedding-provider-plugin') return 'embedding'
  return undefined
}

function supportedApiVersion(source: object, operation: Operation): boolean {
  let apiVersion: unknown
  try {
    apiVersion = ownData(source, 'apiVersion', false)
  } catch {
    return false
  }
  return apiVersion === (operation === 'generation'
    ? PROVIDER_PLUGIN_API_VERSION
    : EMBEDDING_PROVIDER_PLUGIN_API_VERSION)
}

/**
 * Build one failure row.
 *
 * `pluginId` is best-effort by design: an entry that failed its marker check may
 * still expose a readable id, and support needs it, but a plugin object that
 * throws on reflection must not turn a collected failure into a thrown one.
 */
function failure(
  index: number,
  code: ProviderPreflightFailure['code'],
  source: object,
  knownId?: string,
  conflictsWithIndex?: number,
): ProviderPreflightFailure {
  const pluginId = knownId ?? readableId(source)
  return Object.freeze({
    index, code,
    ...(pluginId === undefined ? {} : { pluginId }),
    ...(conflictsWithIndex === undefined ? {} : { conflictsWithIndex }),
  })
}

function readableId(source: object): string | undefined {
  try {
    return boundedText(ownData(source, 'id', false), COMPOSITION_LIMITS.identityBytes)
  } catch {
    return undefined
  }
}

function boundedTextOrInvalid(value: unknown): string {
  try {
    return boundedText(value, COMPOSITION_LIMITS.identityBytes)
  } catch {
    throw invalidPreflight()
  }
}

/** `failureCode` is the first failure's code; every failure travels in `aggregate` (DD-3). */
function aggregateFailure(
  failures: readonly ProviderPreflightFailure[],
): AgentRuntimeConstructionError {
  const first = failures[0]!
  const namespace = conflictNamespace(first.code)
  return new AgentRuntimeConstructionError({
    failureCode: first.code, stage: 'preflight', reason: 'invalid',
    ...(namespace === undefined || first.conflictsWithIndex === undefined ? {} : {
      conflict: capabilityIdentityConflict(namespace, first.conflictsWithIndex, first.index),
    }),
    aggregate: failures,
  })
}

function conflictNamespace(
  code: ProviderPreflightFailure['code'],
): 'provider-plugin-id' | 'provider-route' | undefined {
  if (code === 'CAPABILITY_ID_CONFLICT') return 'provider-plugin-id'
  if (code === 'PROVIDER_ROUTE_CONFLICT' || code === 'PROVIDER_OPERATION_CONFLICT') return 'provider-route'
  return undefined
}
