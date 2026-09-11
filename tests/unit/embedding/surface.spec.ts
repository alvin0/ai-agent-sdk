/**
 * Structural gate for the embedding surface.
 *
 * Feature: embedding-support.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.5, 6.1, 8.5, 8.6, 8.8, 10.1, 10.2,
 * 11.2, 12.1, 19.4**
 *
 * Nothing here exercises embedding behaviour. Every assertion is about SHAPE —
 * what the embedding contract declares, and what the generation contract still
 * declares now that embedding exists beside it. Those are the claims a passing
 * behaviour suite cannot make: an `EmbeddingAdapter` that quietly grew a second
 * abstract method, a `ResolvedModelInfo` that gained an embedding field, or a
 * `ModelProviderRegistrar` that grew a third method would all keep the other
 * embedding specs green while breaking the promise this feature was accepted on.
 *
 * ## The two halves, and why both are needed
 *
 * Some claims are only checkable against the **emitted declarations**
 * (`packages/core/dist/**\/*.d.ts`): `abstract` is erased at runtime, and a
 * type-only interface has no runtime existence at all. Those read `dist`, which
 * means `pnpm build` (or at minimum a `packages/core` build) must have run — the
 * root `pretest` script does this, and a missing file is reported as such rather
 * than skipped.
 *
 * The rest are checkable **at runtime** and are asserted there in preference,
 * because a runtime assertion cannot be satisfied by a declaration that lies
 * about the code. Where a claim is available both ways, both are made: the
 * runtime one proves the behaviour, the declaration one proves the published
 * shape.
 *
 * ## Relationship to `tests/unit/copilot-architecture.spec.ts`
 *
 * That file already owns the byte-level API-surface freeze. It hashes each
 * emitted entry point of seven packages against
 * `tests/fixtures/public-api/untouched-packages.json`, and it is the guard that
 * fails when a published surface moves at all. This file does NOT re-hash
 * anything and does not touch that fixture. It asserts the *named, meaningful*
 * structural facts the requirements state, which a hash cannot express: a hash
 * says "something changed", not "`EmbeddingAdapter` has exactly one abstract
 * method". The two are complementary, and the surface freeze stays the single
 * authority on unintended drift.
 *
 * One consequence worth stating: `core`'s `./embedding` entry point is
 * deliberately absent from that freeze's `UNTOUCHED_PACKAGES` map, because this
 * feature creates it. So the freeze covers "generation did not move" and this
 * file covers "embedding is shaped as specified".
 *
 * ## Why the file lives here and not where the task named it
 *
 * The task names `packages/core/tests/unit/embedding/surface.spec.ts`. No runner
 * collects that directory: root `vitest.config.ts` includes `tests/**` and
 * `test-human/**`, and the package-level configs reach into the ROOT `tests/`
 * tree by relative path. A spec under `packages/core/tests/unit/` would never run
 * in CI — the one failure mode a structural guard must not have, since a guard
 * that does not run is indistinguishable from one that passes. It sits beside
 * `tests/unit/embedding/profile.spec.ts` and `tests/unit/embedding/validation.spec.ts`
 * instead, matching `tests/unit/embedding-catalog.spec.ts` and the rest of the
 * core unit tree.
 *
 * ## What is deliberately deferred
 *
 * Requirements 11.1, 11.3, 11.4 (a distinct `Embedding_Provider_Plugin` kind, an
 * `Embedding_Registrar`, and the `RuntimeOwnerOptions.providers` union) and
 * Requirement 12.1 (a new entry in `RUNTIME_OPERATION_KINDS`) describe things
 * tasks 8.x and 10.1 introduce. They do not exist yet, and asserting them now
 * would be asserting a wish. What IS asserted is the half of each that is
 * checkable today and is a real constraint on this feature: 11.2 in full — the
 * generation registrar and its api version must NOT move to make room for the
 * new kind — plus the recorded current state of the two absent pieces, following
 * the precedent set by the `./embedding` subpath test at the bottom of
 * `copilot-architecture.spec.ts`. Those expectations flip when the later tasks
 * land, and the comments say so.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EmbeddingAdapter } from '../../../packages/core/src/embedding/adapter.ts'
import type {
  PrepareEmbeddingOptions, PreparedEmbeddingCall,
} from '../../../packages/core/src/embedding/adapter.ts'
import { unknownEmbeddingModel } from '../../../packages/core/src/embedding/catalog.ts'
import type {
  EmbeddingCapability, EmbeddingInputType, ResolvedEmbeddingModelInfo,
} from '../../../packages/core/src/embedding/catalog.ts'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import { PROVIDER_PLUGIN_API_VERSION } from '../../../packages/core/src/composition/provider/types.ts'
import { RUNTIME_OPERATION_KINDS } from '../../../packages/core/src/composition/lifecycle/types.ts'
import type { EmbeddingBatchRequest } from '../../../packages/core/src/embedding/request.ts'
import type {
  EmbeddingBatchResult, EmbeddingVector,
} from '../../../packages/core/src/embedding/result.ts'
import type { EmbeddingProfile } from '../../../packages/core/src/embedding/profile.ts'
import type { ResolvedModelInfo } from '../../../packages/core/src/contract/model-info.ts'

const WORKSPACE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CORE_SRC = join(WORKSPACE_ROOT, 'packages', 'core', 'src')
const CORE_DIST = join(WORKSPACE_ROOT, 'packages', 'core', 'dist')

/** Read one emitted declaration file, reporting a missing build as such. */
function declarations(...segments: readonly string[]): string {
  const path = join(CORE_DIST, ...segments)
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing; run \`pnpm build\` (or build packages/core) before this spec`,
    )
  }
  return readFileSync(path, 'utf8')
}

function source(...segments: readonly string[]): string {
  return readFileSync(join(CORE_SRC, ...segments), 'utf8')
}

/**
 * The body of one named declaration, from `{` to the first column-0 `}`.
 *
 * Column-0 is what terminates it rather than brace balancing: the bundler emits
 * one declaration per top-level block at zero indentation, so the first
 * unindented `}` is the end, and nested object types inside the body do not
 * terminate it early.
 */
function declarationBody(text: string, header: RegExp): string {
  const start = header.exec(text)
  if (start === null) throw new Error(`no declaration matching ${String(header)}`)
  const rest = text.slice(start.index)
  const end = /\n\}/.exec(rest)
  if (end === null) throw new Error(`declaration ${String(header)} is unterminated`)
  return rest.slice(0, end.index + 2)
}

/** Comments removed, so a doc comment mentioning a name is not read as a member. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '\n')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
}

/**
 * Member names declared directly in one interface or class body.
 *
 * Only lines at the body's own indentation are considered, which keeps the fields
 * of an inline object type out of the result.
 */
function memberNames(body: string): readonly string[] {
  return withoutComments(body)
    .split('\n')
    .map(line => /^\s{2,4}(?:readonly\s+|abstract\s+|static\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*[(?:<]/
      .exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort()
}

/** Members marked `abstract` in one class body. */
function abstractMemberNames(body: string): readonly string[] {
  return withoutComments(body)
    .split('\n')
    .map(line => /^\s+abstract\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort()
}

/** The names one emitted entry point publishes, read off its last export clause. */
function exportedNames(entry: string): readonly string[] {
  const text = declarations(entry)
  const clause = [...text.matchAll(/export\s*\{([^}]*)\}/g)].at(-1)
  if (clause?.[1] === undefined) throw new Error(`${entry} carries no export clause`)
  return clause[1]
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => part.replace(/^type\s+/, ''))
    .map(part => (part.split(/\s+as\s+/).at(-1) ?? part).trim())
    .sort()
}

const EMBEDDING_ADAPTER_DECL = declarationBody(
  declarations('embedding', 'adapter.d.ts'),
  /(?:declare\s+)?abstract class EmbeddingAdapter/,
)
const MODEL_ADAPTER_DECL = declarationBody(
  declarations('contract', 'adapter.d.ts'),
  /(?:declare\s+)?abstract class ModelAdapter/,
)

/**
 * A minimal conforming adapter: `embedBatch` and nothing else.
 *
 * This class IS the Requirement 1.2 assertion in its strongest form — if a second
 * abstract member ever appears, this file stops compiling, and `pnpm typecheck`
 * fails before any test runs. It returns a real vector per item so the same
 * instance can be driven through `prepareEmbeddingCall()` below rather than only
 * being constructed.
 */
class MinimalEmbeddingAdapter extends EmbeddingAdapter {
  embedBatch(batch: EmbeddingBatchRequest): Promise<EmbeddingBatchResult> {
    const vectors: readonly EmbeddingVector[] = batch.items.map(item => ({
      index: item.index,
      values: [item.index + 1, 0, 0, 0],
    }))
    return Promise.resolve({ vectors })
  }
}

// ---------------------------------------------------------------------------
// Requirement 1.1
// ---------------------------------------------------------------------------

describe('`EmbeddingAdapter` is an independent abstract class (Requirement 1.1)', () => {
  it('does not extend `ModelAdapter`, at runtime or in the declaration', () => {
    // The prototype chain, which is what `extends` actually produces. A class with
    // no `extends` clause has `Function.prototype` as its own prototype.
    expect(Object.getPrototypeOf(EmbeddingAdapter)).toBe(Function.prototype)
    expect(Object.getPrototypeOf(EmbeddingAdapter.prototype)).toBe(Object.prototype)
    expect(EmbeddingAdapter.prototype instanceof ModelAdapter).toBe(false)
    expect(new MinimalEmbeddingAdapter() instanceof ModelAdapter).toBe(false)
    // And the emitted declaration, so the published type is independent too — a
    // consumer must not be able to pass one where the other is required.
    expect(/abstract class EmbeddingAdapter\s+extends/.test(
      declarations('embedding', 'adapter.d.ts'),
    )).toBe(false)
  })

  it('reaches no generation adapter from the embedding module at all', () => {
    // Requirement 1.6's structural half, and the reason the claim above cannot be
    // reintroduced by a helper: the module does not import `contract/adapter.ts`.
    // Comments are stripped first — the doc comment deliberately explains the
    // relationship to `ModelAdapter`, and prose is not a dependency.
    const adapterSource = withoutComments(source('embedding', 'adapter.ts'))
    expect(adapterSource).not.toMatch(/from '\.\.\/contract\/adapter\.ts'/)
    expect(adapterSource).not.toMatch(/\bModelAdapter\b/)
    expect(adapterSource).not.toMatch(/\bPreparedAdapterCall\b/)
  })

  it('adds no abstract member to `ModelAdapter`, which keeps exactly `stream`', () => {
    // The second half of 1.1, and the one that would break every existing adapter
    // in the workspace if it were violated.
    expect(abstractMemberNames(MODEL_ADAPTER_DECL)).toEqual(['stream'])
    // Nothing embedding-shaped appeared on the generation adapter either.
    expect(withoutComments(MODEL_ADAPTER_DECL)).not.toMatch(/embed/i)
  })
})

// ---------------------------------------------------------------------------
// Requirement 1.2
// ---------------------------------------------------------------------------

describe('`EmbeddingAdapter` requires exactly one abstract method (Requirement 1.2)', () => {
  it('marks `embedBatch`, and only `embedBatch`, as abstract', () => {
    expect(abstractMemberNames(EMBEDDING_ADAPTER_DECL)).toEqual(['embedBatch'])
    // Not a vacuous count: the class declares seven members, six of them concrete.
    const members = memberNames(EMBEDDING_ADAPTER_DECL)
    expect(members).toEqual([
      'embedBatch', 'embeddingProfile', 'listEmbeddingModels', 'prepareEmbeddingCall',
      'providerInfo', 'providerRetryPolicy', 'resolveEmbeddingModel',
    ])
  })

  it('gives `embeddingProfile` a working default, so it does not count', () => {
    // The distinction the requirement turns on. A concrete method exists on the
    // prototype; an abstract one exists nowhere at runtime.
    const prototypeMembers = Object.getOwnPropertyNames(EmbeddingAdapter.prototype)
    expect(prototypeMembers).toContain('embeddingProfile')
    expect(prototypeMembers).not.toContain('embedBatch')
    // And the default is usable, not a throwing placeholder: it produces a profile
    // for an id the catalog knows nothing about.
    const model = unknownEmbeddingModel('route', 'model-x')
    const profile = new MinimalEmbeddingAdapter().embeddingProfile(model, { dimensions: 4 })
    expect(profile.modelIdentity).toBe('route:model-x')
    expect(profile.dimensions).toBe(4)
  })

  it('lets an adapter that implements only `embedBatch` serve a prepared call', () => {
    // `MinimalEmbeddingAdapter` overrides nothing else, so every other member here
    // is the base default. If any of them were abstract in practice this fails.
    const adapter = new MinimalEmbeddingAdapter()
    const options: PrepareEmbeddingOptions = { dimensions: 4 }
    return adapter.prepareEmbeddingCall('route', 'model-x', options).then(async prepared => {
      const call: PreparedEmbeddingCall = prepared
      expect(call.model.id).toBe('model-x')
      expect(call.spaceId.length).toBeGreaterThan(0)
      expect(call.limits.maxItems).toBeGreaterThan(0)
      const result = await call.embedBatch({
        provider: 'route',
        model: 'model-x',
        purpose: 'retrieval-document',
        items: [{ index: 0, contentParts: [{ type: 'text', text: 'a' }] }],
        truncation: 'reject',
      })
      // The abstract method's contract: a Promise of vectors carrying the input
      // index — not a stream, not a chunk.
      expect(result.vectors.map(vector => vector.index)).toEqual([0])
    })
  })

  it('declares the one abstract method as returning a `Promise`', () => {
    expect(EMBEDDING_ADAPTER_DECL).toMatch(
      /abstract embedBatch\([^)]*\): Promise<EmbeddingBatchResult>/,
    )
  })
})

// ---------------------------------------------------------------------------
// Requirement 1.3
// ---------------------------------------------------------------------------

describe('the embedding result vocabulary excludes generation shapes (Requirement 1.3)', () => {
  const FORBIDDEN = [
    'StreamChunk', 'AssistantMessage', 'ModelMessage', 'ToolCall', 'text-delta',
    'AsyncIterable', 'AsyncGenerator',
  ] as const

  /** Every module reachable from the `./embedding` entry point. */
  const MODULES = [
    'adapter', 'catalog', 'errors', 'handle', 'limits', 'profile', 'purpose',
    'request', 'result', 'usage', 'validation',
  ] as const

  for (const forbidden of FORBIDDEN) {
    it(`mentions no \`${forbidden}\` anywhere in the embedding contract`, () => {
      for (const module of MODULES) {
        expect(
          withoutComments(declarations('embedding', `${module}.d.ts`)),
          `embedding/${module} references ${forbidden}`,
        ).not.toContain(forbidden)
      }
    })
  }

  it('publishes no generation name from the `./embedding` entry point', () => {
    const published = exportedNames('embedding.d.ts')
    expect(published.length).toBeGreaterThan(40)
    for (const name of published) {
      expect(FORBIDDEN as readonly string[], `./embedding publishes ${name}`)
        .not.toContain(name)
    }
    // Every published name is either embedding-named or one of the few that belong
    // to the vocabulary without carrying the word. The list is enumerated rather
    // than pattern-matched, so a new off-vocabulary export has to be added here
    // deliberately.
    const WITHOUT_THE_WORD = [
      'PreDispatchRequest', 'deriveSpaceId', 'estimateTokens', 'isSpaceCompatible',
      'resolveBatchLimits', 'validateBatchResult', 'validatePreDispatch',
    ] as readonly string[]
    // The list is exhaustive, not a floor: every other published name carries the
    // word, so an addition lands in one bucket or the other and neither is silent.
    expect(published.filter(name => !/embed/i.test(name)).sort()).toEqual([...WITHOUT_THE_WORD])
    for (const name of published) {
      expect(
        /embed/i.test(name) || WITHOUT_THE_WORD.includes(name),
        `./embedding publishes an off-vocabulary name: ${name}`,
      ).toBe(true)
    }
  })

  it('types the result as resolved values rather than anything iterable', () => {
    const body = declarationBody(
      declarations('embedding', 'result.d.ts'),
      /interface EmbeddingBatchResult/,
    )
    expect(memberNames(body)).toEqual(['providerRequestId', 'usage', 'vectors', 'warnings'])
    // `readonly number[]` is the vector, and it is an array — not a stream of
    // deltas that a consumer has to assemble.
    const vector = declarationBody(
      declarations('embedding', 'result.d.ts'),
      /interface EmbeddingVector/,
    )
    expect(vector).toMatch(/values: readonly number\[\]/)
  })
})

// ---------------------------------------------------------------------------
// Requirements 8.5, 8.6, 8.8
// ---------------------------------------------------------------------------

describe('the request separates the two input layers (Requirement 8.5)', () => {
  it('declares `items[]` on the batch and `contentParts[]` on the item', () => {
    const request = declarations('embedding', 'request.d.ts')
    const batch = declarationBody(request, /interface EmbeddingBatchRequest/)
    const item = declarationBody(request, /interface EmbeddingItem/)
    expect(memberNames(batch)).toContain('items')
    expect(batch).toMatch(/items: readonly EmbeddingItem\[\]/)
    // The inner layer is on the ITEM, not on the batch: this is the distinction
    // that keeps N objects mapping to N vectors while one object may have parts.
    expect(memberNames(batch)).not.toContain('contentParts')
    expect(item).toMatch(/contentParts: readonly EmbeddingContentPart\[\]/)
    expect(memberNames(item)).toEqual(['contentParts', 'index'])
  })
})

describe('v1 scope is declared as a capability, not assumed (Requirements 8.6, 8.8)', () => {
  it('admits exactly one input type and one representation', () => {
    const catalog = declarations('embedding', 'catalog.d.ts')
    expect(catalog).toMatch(/type EmbeddingInputType = 'text'/)
    // Read off the type rather than from prose: there is no image or audio member
    // to construct, so the scope is enforced by the compiler.
    const inputType: EmbeddingInputType = 'text'
    expect(inputType).toBe('text')
    expect(declarations('embedding', 'profile.d.ts'))
      .toMatch(/type EmbeddingRepresentation = 'dense-float32'/)
  })

  it('states representation through `EmbeddingCapability`, so `unknown` is expressible', () => {
    // Requirement 8.8: the output shape is a declared capability. `number[]` is
    // therefore never presented as covering every sparse or multi-vector case —
    // an undeclared route says `unknown` instead of implying dense.
    expect(declarations('embedding', 'catalog.d.ts'))
      .toMatch(/representation: EmbeddingCapability<EmbeddingRepresentation>/)
    const capability: EmbeddingCapability<never> =
      unknownEmbeddingModel('route', 'model-x').representation as EmbeddingCapability<never>
    expect(capability.state).toBe('unknown')
    // All three states exist; collapsing `unsupported` into `unknown` would make
    // the claim above meaningless.
    expect(declarations('embedding', 'catalog.d.ts')).toMatch(/state: 'supported'/)
    expect(declarations('embedding', 'catalog.d.ts')).toMatch(/state: 'unsupported'/)
    expect(declarations('embedding', 'catalog.d.ts')).toMatch(/state: 'unknown'/)
  })
})

// ---------------------------------------------------------------------------
// Requirements 10.1, 10.2
// ---------------------------------------------------------------------------

describe('the generation catalog gains no embedding field (Requirement 10.1)', () => {
  /** The generation catalog's published fields, as of this feature. */
  const MODEL_INFO_FIELDS = [
    'description', 'id', 'inputModalities', 'name', 'nativeTools', 'outputModalities', 'provider',
  ] as const
  const RESOLVED_EXTRA_FIELDS = [
    'context', 'defaultMaxTokens', 'maxOutputTokens', 'reasoning',
  ] as const

  it('keeps `ResolvedModelInfo` and `ModelInfo` at the fields they had', () => {
    const modelInfo = declarations('contract', 'model-info.d.ts')
    expect(memberNames(declarationBody(modelInfo, /interface ModelInfo/)))
      .toEqual([...MODEL_INFO_FIELDS])
    const resolved = declarationBody(modelInfo, /interface ResolvedModelInfo extends ModelInfo/)
    expect(memberNames(resolved)).toEqual([...RESOLVED_EXTRA_FIELDS])
    // The enumeration above is the assertion; this is the failure message that
    // names the cause when someone adds `embeddingDimensions` or similar.
    expect(withoutComments(resolved), '`ResolvedModelInfo` gained an embedding field')
      .not.toMatch(/embed/i)
    expect(withoutComments(declarationBody(modelInfo, /interface ModelInfo/)))
      .not.toMatch(/embed/i)
  })

  it('holds at the type level too, so the field list is not merely textual', () => {
    // A declaration-merging `interface ModelInfo` elsewhere in the workspace would
    // not show up in the file above. This does: an object carrying every allowed
    // key and no other satisfies the type exactly.
    const info: Required<ResolvedModelInfo> = {
      provider: 'route',
      id: 'model-x',
      name: 'Model X',
      description: 'a model',
      inputModalities: ['text'],
      outputModalities: ['text'],
      nativeTools: [],
      context: { contextWindow: 1 },
      defaultMaxTokens: 1,
      maxOutputTokens: 1,
      reasoning: { efforts: [] },
    }
    expect(Object.keys(info).sort())
      .toEqual([...MODEL_INFO_FIELDS, ...RESOLVED_EXTRA_FIELDS].sort())
  })
})

describe('the embedding catalog describes the metadata it must (Requirement 10.2)', () => {
  /** The eleven capabilities the requirement enumerates, plus identity. */
  const REQUIRED = [
    'inputTypes', 'representation', 'dimensions', 'defaultDimensions', 'maxInputTokens',
    'maxBatchItems', 'maxBatchTokens', 'maxBatchBytes', 'purposeHandling', 'normalization',
    'compatibilityIdentity',
  ] as const

  it('declares every named capability on `EmbeddingModelInfo`', () => {
    const body = declarationBody(
      declarations('embedding', 'catalog.d.ts'),
      /interface EmbeddingModelInfo/,
    )
    const members = memberNames(body)
    for (const field of REQUIRED) expect(members, `catalog omits ${field}`).toContain(field)
    expect(members).toEqual([...REQUIRED, 'description', 'id', 'name', 'provider'].sort())
  })

  it('materializes all of them as `unknown` for an unlisted id', () => {
    // Requirements 10.3 and 10.4's structural half: an id outside the catalog is
    // describable, and every capability it does not declare reads `unknown`.
    const resolved: ResolvedEmbeddingModelInfo = unknownEmbeddingModel('route', 'model-x')
    for (const field of REQUIRED) {
      expect(
        (resolved[field] as EmbeddingCapability<unknown>).state,
        `${field} is not \`unknown\` for an unlisted id`,
      ).toBe('unknown')
    }
    expect(resolved.provider).toBe('route')
    expect(resolved.id).toBe('model-x')
  })
})

// ---------------------------------------------------------------------------
// Requirement 6.1
// ---------------------------------------------------------------------------

describe('`EmbeddingProfile` carries the identity fields it must (Requirement 6.1)', () => {
  it('declares model identity, revision, dimensions, representation and both recipes', () => {
    // The behaviour of `Space_Id` derivation is `tests/unit/embedding/profile.spec.ts`;
    // what is asserted here is only that the fields the requirement names exist and
    // that none of them went missing.
    const body = declarationBody(
      declarations('embedding', 'profile.d.ts'),
      /interface EmbeddingProfile/,
    )
    expect(memberNames(body)).toEqual([
      'compatibilityIdentity', 'dimensions', 'documentRecipeRevision', 'modelIdentity',
      'modelRevision', 'normalization', 'postProcessing', 'profileRevision',
      'queryRecipeRevision', 'representation',
    ])
    // Compatibility identity is a declared string, distinct from model identity and
    // from the dimension count — the whole point of Requirements 6.3 and 6.4.
    const profile: EmbeddingProfile = new MinimalEmbeddingAdapter()
      .embeddingProfile(unknownEmbeddingModel('route', 'model-x'), { dimensions: 4 })
    expect(profile.compatibilityIdentity).not.toBe(String(profile.dimensions))
    expect(typeof profile.compatibilityIdentity).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Requirement 11.2 (and the recorded state of 11.1, 11.3, 11.4, 12.1)
// ---------------------------------------------------------------------------

describe('the generation plugin contract does not move (Requirement 11.2)', () => {
  it('keeps `ModelProviderRegistrar` at exactly `registerAdapter` and `use`', () => {
    const body = declarationBody(
      declarations('plugin', 'provider-plugin.d.ts'),
      /interface ModelProviderRegistrar/,
    )
    expect(memberNames(body)).toEqual(['registerAdapter', 'use'])
    // Specifically: no `registerEmbeddingAdapter`. The new capability gets its own
    // registrar rather than widening this one, which is why existing plugins need
    // no contract version bump.
    expect(withoutComments(body)).not.toMatch(/embed/i)
    // The signatures, not just the names: `registerAdapter` still takes a
    // `ModelAdapter`, so an embedding adapter cannot be smuggled through it.
    expect(body).toMatch(/registerAdapter\(routes: readonly string\[\], adapter: ModelAdapter\)/)
  })

  it('keeps `PROVIDER_PLUGIN_API_VERSION` at 1', () => {
    expect(PROVIDER_PLUGIN_API_VERSION).toBe(1)
    // The literal type as well as the value: preflight compares against it, and a
    // widened `number` would let a mismatched plugin through the type system.
    expect(declarations('composition', 'provider', 'types.d.ts'))
      .toMatch(/PROVIDER_PLUGIN_API_VERSION\s*(?::|=)\s*1/)
  })

  it('carries the distinct embedding plugin kind beside the generation one', () => {
    // Requirements 11.1 and 11.3, landed in task 8.1: the new `kind` value and the
    // `Embedding_Registrar` view ship from the same `./provider` entry point that
    // already publishes `defineModelProviderPlugin`, so a provider package needs no
    // second dependency to author both. The assertions above stand unchanged — the
    // generation registrar and its api version did not move to make room.
    expect(exportedNames('provider.d.ts')).toContain('defineEmbeddingProviderPlugin')
    // The `kind` marker lives in its OWN declaration, which is the substance of
    // 11.1: `plugin/provider-plugin.d.ts` — the generation contract — still says
    // nothing about embedding, and the new value is declared beside it instead.
    expect(withoutComments(declarations('plugin', 'provider-plugin.d.ts')))
      .not.toMatch(/'embedding-provider-plugin'/)
    expect(withoutComments(declarations('composition', 'embedding', 'plugin-types.d.ts')))
      .toMatch(/kind: 'embedding-provider-plugin'/)
  })

  it('carries the embedding operation kind appended at the end of the list', () => {
    // Requirement 12.1, landed in task 10.1. The order is part of the claim, not
    // incidental: `beginClose()` reads `operations[0]` as the source of
    // `activeRunsAtClose`/`abortedRuns`/`unsettledRuns`, so `'agent-run'` stays
    // first and the new kind goes last (DD-4). Because `beginClose()` maps over
    // this whole list, `RuntimeCloseReport.operations` gains an embedding summary
    // with no new code at the report layer (Requirement 12.2).
    expect([...RUNTIME_OPERATION_KINDS]).toEqual([
      'agent-run', 'model-catalog', 'manual-compaction', 'team-operation', 'embedding-call',
    ])
    expect(RUNTIME_OPERATION_KINDS[0]).toBe('agent-run')
    expect(RUNTIME_OPERATION_KINDS.filter(kind => /embed/i.test(kind))).toEqual(['embedding-call'])
  })
})

// ---------------------------------------------------------------------------
// Requirements 1.5, 19.4 — the smoke test
// ---------------------------------------------------------------------------

describe('both entry points resolve, and generation is unchanged (Requirements 1.5, 19.4)', () => {
  it('resolves `@alvin0/ai-agent-sdk-core/embedding` through the package `exports`', async () => {
    // Requirement 19.5's mechanism: the import goes through the export map, by
    // package specifier, not by a deep relative path into `dist`.
    const entry = await import('@alvin0/ai-agent-sdk-core/embedding')
    // NOT an identity check against the imported source class: the bundle is a
    // separate module instance, so `===` would be asserting a build detail. What
    // matters is that the published class is the same SHAPE and is subclassable
    // with only `embedBatch`, which is the whole contract.
    expect(typeof entry.EmbeddingAdapter).toBe('function')
    expect(Object.getOwnPropertyNames(entry.EmbeddingAdapter.prototype).sort())
      .toEqual(Object.getOwnPropertyNames(EmbeddingAdapter.prototype).sort())
    class Published extends entry.EmbeddingAdapter {
      embedBatch(batch: EmbeddingBatchRequest): Promise<EmbeddingBatchResult> {
        return Promise.resolve({ vectors: batch.items.map(item => ({ index: item.index, values: [1] })) })
      }
    }
    const prepared = await new Published().prepareEmbeddingCall('route', 'model-x', {})
    expect(prepared.spaceId.length).toBeGreaterThan(0)
    // The runtime half of the contract, present as real values rather than types.
    for (const name of [
      'EmbeddingError', 'EMBEDDING_ERROR_CODES', 'EMBEDDING_BATCH_DEFAULTS',
      'DEFAULT_EMBEDDING_TRUNCATION', 'defaultEmbeddingProfile', 'deriveSpaceId',
      'isSpaceCompatible', 'resolveBatchLimits', 'estimateTokens', 'unknownEmbeddingModel',
      'validatePreDispatch', 'validateBatchResult',
    ]) {
      expect(Object.keys(entry), `./embedding does not publish ${name}`).toContain(name)
    }
  }, 30_000)

  it('declares the subpath in both `package.json#exports` and `tsdown.config.ts`', () => {
    // Requirement 1.4's structural half. Either one alone is a broken install: an
    // export subpath with no entry points at a bundle that was never emitted.
    const manifest = JSON.parse(
      readFileSync(join(WORKSPACE_ROOT, 'packages', 'core', 'package.json'), 'utf8'),
    ) as { readonly exports?: Readonly<Record<string, { readonly types?: string }>> }
    expect(manifest.exports?.['./embedding']?.types).toBe('./dist/embedding.d.ts')
    expect(readFileSync(join(WORKSPACE_ROOT, 'packages', 'core', 'tsdown.config.ts'), 'utf8'))
      .toMatch(/embedding:/)
  })

  it('adds only the six documented type names to the root entry point', () => {
    // Requirements 1.5 and 19.4: an application that uses generation only sees the
    // same surface it saw before. The root entry declares
    // `AgentRuntime.embeddingModel()`, so its return and option types have to be
    // reachable from `.` — and that is ALL that may be.
    const published = exportedNames('index.d.ts')
    const embeddingNames = published.filter(name => /embed/i.test(name))
    expect(embeddingNames).toEqual([
      'EmbeddingManyResult', 'EmbeddingModelHandle', 'EmbeddingModelOptions', 'EmbeddingResult',
      'EmbeddingUsageReport',
    ])
    // Byte-level drift on this entry point is `copilot-architecture.spec.ts`'s job
    // via the recorded surface snapshot; this asserts the meaning, namely that the
    // additions are type-only and confined to the handle's own vocabulary.
    for (const name of embeddingNames) {
      expect(declarations('index.d.ts'), `${name} is published as a value from \`.\``)
        .toMatch(new RegExp(`type ${name}\\b`))
    }
  })

  it('keeps the generation surface of `.` intact and usable', async () => {
    const root = await import('@alvin0/ai-agent-sdk-core')
    // Anchors, not a full list — the full list is the recorded snapshot. These are
    // what a generation-only application actually imports.
    for (const name of ['createAgentRuntime', 'defineAgent', 'defineTool']) {
      expect(Object.keys(root), `\`.\` no longer publishes ${name}`).toContain(name)
    }
    // And no embedding VALUE leaked into the root barrel: the five names above are
    // types, which do not exist at runtime.
    expect(Object.keys(root).filter(name => /^Embedding/.test(name))).toEqual([])
    // The generation entry point of `.` is a large bundle, hence the raised
    // timeout: loading it is the point of the test, not incidental to it.
  }, 30_000)

  it('requires no embedding configuration to build a generation-only runtime', () => {
    // Requirement 19.4's other half. `createAgentRuntime` is not called here —
    // `tests/unit` has runtime specs for that — but its published options type must
    // not have grown a required embedding field, which is checkable structurally.
    const options = declarationBody(
      declarations('composition', 'runtime', 'types.d.ts'),
      /interface RuntimeOwnerOptions/,
    )
    for (const line of withoutComments(options).split('\n')) {
      if (!/embed/i.test(line)) continue
      // Any embedding member that exists must be optional.
      expect(line, `RuntimeOwnerOptions has a required embedding member: ${line.trim()}`)
        .toMatch(/\?\s*:/)
    }
  })
})
