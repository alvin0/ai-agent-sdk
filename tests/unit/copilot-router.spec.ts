/**
 * Property tests for `Copilot_Endpoint_Router` and the composite protocol.
 *
 * Feature: github-copilot-provider — Properties 32, 33, 34, 35.
 *
 * The two modules under test answer one question — "which endpoint does this model
 * id go to" — and the whole value of the pair is that the answer is given ONCE.
 * That makes the interesting assertions temporal rather than structural: the same
 * model id asked twice, with a catalog refresh wedged in between, has to come back
 * with the same endpoint, the same protocol id and a body of the same shape
 * (Property 34). A router that recomputed would pass every single-call assertion
 * and still split one logical call across two wire protocols.
 *
 * Three details of the implementation shape how these tests are written:
 *
 *  1. **Methods are closures, never `this`.** `captureRuntimeProtocol` re-invokes
 *     each method as `Reflect.apply(method, source, args)`, so every invocation
 *     below goes through `Reflect.apply` with a FOREIGN receiver. A method that
 *     read `this` would fail here rather than in production.
 *  2. **`onDecision` fires from `endpointPath` only.** One logical call therefore
 *     produces exactly one record even though three methods route (Property 35),
 *     and `serialize` / `translate` must add none.
 *  3. **`protocolHeaders` is not a union.** The composite exposes a header set
 *     only when both branches produce an identical one, and neither shipped
 *     sub-protocol declares `protocolHeaders` at all — so today the composite has
 *     none. Asserted as the actual contract, including the divergent case, since
 *     a union would put a header of the branch NOT taken on the wire.
 *
 * Inputs come from a SEEDED generator rather than `Math.random`, so a failure
 * reproduces from the printed seed. The repository carries no property-testing
 * library, so the generators live here, following
 * `tests/unit/copilot-catalog.spec.ts` and `tests/unit/copilot-token-cache.spec.ts`.
 */

import { AgentSdkError, createUserMessage } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core'
import {
  OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID,
  openAiChatCompletionsProtocol,
} from '../../packages/protocol-openai-chat-completions/src/protocol.ts'
import type { ChatCompletionsDialect } from '../../packages/protocol-openai-chat-completions/src/wire.ts'
import {
  OPENAI_RESPONSES_PROTOCOL_ID,
  openAiResponsesProtocol,
} from '../../packages/protocol-responses/src/protocol.ts'
import type { ResponsesDialect } from '../../packages/protocol-responses/src/wire.ts'
import type {
  ProtocolRequest,
  ProtocolSseEvent,
  ProtocolStreamChunk,
} from '@alvin0/ai-agent-sdk-provider-http'
import { describe, expect, it } from 'vitest'
import type { CopilotEndpoint, CopilotGenerationModel } from '../../packages/provider-copilot/src/catalog.ts'
import { COPILOT_ERROR_CODES } from '../../packages/provider-copilot/src/common/error-codes.ts'
import {
  COPILOT_DEFAULT_DIALECT,
  COPILOT_DUAL_PROTOCOL_ID,
  copilotDualProtocol,
  toChatCompletionsDialect,
  toResponsesDialect,
  type ChatCompletionsProtocolLike,
  type CopilotDialect,
  type CopilotSubProtocol,
  type ResponsesProtocolLike,
} from '../../packages/provider-copilot/src/dual-protocol.ts'
import {
  COPILOT_RESPONSES_MODEL_PREFIXES,
  createCopilotEndpointRouter,
  type CopilotEndpointDecision,
  type CopilotEndpointRouter,
} from '../../packages/provider-copilot/src/router.ts'

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
  const value = values[intBelow(rng, values.length)]
  if (value === undefined) throw new Error('empty choice list')
  return value
}

function bool(rng: Rng): boolean {
  return rng() < 0.5
}

/**
 * A model id, drawn from every class the decision order distinguishes.
 *
 * Both allowlisted prefixes appear, in original and in mixed case — the router
 * matches case-insensitively — plus ids that only LOOK allowlisted (`gpt-4o` is
 * not `gpt-5`) and ids with no relation to any prefix.
 */
function modelId(rng: Rng): string {
  const stem = pick(rng, [
    'codex-mini-latest',
    'CODEX-Large',
    'gpt-5',
    'gpt-5-mini',
    'GPT-5.1-Codex',
    'gpt-4o',
    'gpt-4.1',
    'o3-mini',
    'claude-sonnet-4',
    'gemini-2.5-pro',
    'codex', // prefix is `codex-`, so this must NOT match
  ] as const)
  return `${stem}-${String(intBelow(rng, 1_000))}`
}

function endpoint(rng: Rng): CopilotEndpoint {
  return pick(rng, ['responses', 'chat-completions'] as const)
}

/** A Copilot dialect with every knob independently generated. */
function dialect(rng: Rng): CopilotDialect {
  return Object.freeze({
    sampling: bool(rng),
    maxOutputTokens: bool(rng),
    structuredOutputs: bool(rng),
    tools: bool(rng),
    store: bool(rng),
    include: bool(rng) ? Object.freeze([]) : Object.freeze(['reasoning.encrypted_content']),
    reasoningSummary: pick(rng, ['auto', 'concise', 'detailed', 'none'] as const),
    streamUsage: bool(rng),
    systemRole: pick(rng, ['system', 'developer'] as const),
    parallelToolCalls: bool(rng),
    ...(bool(rng) ? { promptCacheKey: `cache-${String(intBelow(rng, 100))}` } : {}),
  } satisfies CopilotDialect)
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

function resolvedModel(id: string): ResolvedModelInfo {
  return { provider: 'copilot', id, name: id, inputModalities: ['text'] }
}

/**
 * A `ProtocolRequest` carrying only what the two serializers read.
 *
 * `connection` is asserted rather than built out: neither sub-protocol nor the
 * composite reads a single field of it, so a full `HttpConnection` here would be
 * scenery. The routing key — `model.id` — is the part that matters.
 */
function protocolRequest(id: string, maxTokens = 4_096): ProtocolRequest {
  const model = resolvedModel(id)
  const options: GenerateOptions = {
    provider: 'copilot',
    model: id,
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'xin chào' }],
      source: { kind: 'user' },
    })],
  }
  return {
    options,
    model,
    maxTokens,
    connection: {
      baseUrl: 'https://api.githubcopilot.com',
      headers: Object.freeze({}),
    },
  } as ProtocolRequest
}

/** A catalog entry, as `discoverCopilotModels` would hand it to `learn`. */
function generationModel(
  id: string,
  declaredEndpoint: CopilotEndpoint | undefined,
): CopilotGenerationModel {
  return { model: { id, name: id }, declaredEndpoint }
}

// ---------------------------------------------------------------------------
// Instrumented sub-protocols
//
// The real protocols delegate through a recording wrapper rather than being
// replaced by stubs: the bodies below are the bodies the real serializers produce,
// which is what makes "path of one branch, body of the other" an assertable
// statement rather than a statement about a test double.
// ---------------------------------------------------------------------------

/** One delegated call, with the branch that took it and the dialect it saw. */
interface Delegation {
  readonly branch: 'responses' | 'chat'
  readonly method: 'endpointPath' | 'serialize' | 'translate'
  readonly dialect: unknown
}

interface Instrumented {
  readonly protocol: ReturnType<typeof copilotDualProtocol>
  readonly log: readonly Delegation[]
  readonly decisions: readonly CopilotEndpointDecision[]
}

function record<Dialect extends object>(
  branch: 'responses' | 'chat',
  inner: CopilotSubProtocol<Dialect>,
  log: Delegation[],
): CopilotSubProtocol<Dialect> {
  return {
    id: inner.id,
    defaultDialect: inner.defaultDialect,
    ...(inner.protocolHeaders === undefined ? {} : { protocolHeaders: inner.protocolHeaders }),
    endpointPath: (request: ProtocolRequest, sub: Dialect): string => {
      log.push({ branch, method: 'endpointPath', dialect: sub })
      return inner.endpointPath(request, sub)
    },
    serialize: (request: ProtocolRequest, sub: Dialect): Readonly<Record<string, unknown>> => {
      log.push({ branch, method: 'serialize', dialect: sub })
      return inner.serialize(request, sub)
    },
    translate: (
      events: AsyncIterable<ProtocolSseEvent>,
      request: ProtocolRequest,
      displayName: string,
    ): AsyncGenerator<ProtocolStreamChunk> => {
      log.push({ branch, method: 'translate', dialect: undefined })
      return inner.translate(events, request, displayName)
    },
  }
}

/** Build the composite over the two real protocols, with everything observable. */
function instrument(router: CopilotEndpointRouter, throwing = false): Instrumented {
  const log: Delegation[] = []
  const decisions: CopilotEndpointDecision[] = []
  const protocol = copilotDualProtocol({
    router,
    responses: record<ResponsesDialect>(
      'responses',
      openAiResponsesProtocol as unknown as ResponsesProtocolLike,
      log,
    ) as ResponsesProtocolLike,
    chat: record<ChatCompletionsDialect>(
      'chat',
      openAiChatCompletionsProtocol as unknown as ChatCompletionsProtocolLike,
      log,
    ) as ChatCompletionsProtocolLike,
    onDecision: (decision: CopilotEndpointDecision): void => {
      decisions.push(decision)
      if (throwing) throw new Error('observer is broken')
    },
  })
  return { protocol, log, decisions }
}

/**
 * One logical call, with every method invoked through a FOREIGN receiver.
 *
 * `Reflect.apply(method, {}, args)` is how `captureRuntimeProtocol` calls these,
 * so a composite reading `this` fails here instead of in production.
 */
function invoke(
  protocol: ReturnType<typeof copilotDualProtocol>,
  request: ProtocolRequest,
  copilot: CopilotDialect,
): { readonly path: string; readonly body: Readonly<Record<string, unknown>> } {
  const path = Reflect.apply(protocol.endpointPath, {}, [request, copilot]) as string
  const body = Reflect.apply(protocol.serialize, {}, [request, copilot]) as
    Readonly<Record<string, unknown>>
  const stream = Reflect.apply(protocol.translate, {}, [
    emptyEvents(),
    request,
    request.model.id,
  ]) as AsyncGenerator<ProtocolStreamChunk>
  void stream.return(undefined)
  return { path, body }
}

async function* emptyEvents(): AsyncGenerator<ProtocolSseEvent> {
  // Never iterated: `translate` is called for the branch it picks, and the branch
  // is what is under test here. Draining a real stream is the sub-protocols' own
  // test's job.
  return
}

/** Which branch a serialized body came from, read off the body alone. */
function branchOfBody(body: Readonly<Record<string, unknown>>): 'responses' | 'chat' {
  const hasInput = Object.hasOwn(body, 'input')
  const hasMessages = Object.hasOwn(body, 'messages')
  expect([hasInput, hasMessages], `ambiguous body: ${JSON.stringify(Object.keys(body))}`)
    .toEqual(hasInput ? [true, false] : [false, true])
  return hasInput ? 'responses' : 'chat'
}

function methodsOf(log: readonly Delegation[]): readonly Delegation['method'][] {
  return log.map(entry => entry.method)
}

// ---------------------------------------------------------------------------
// Router contract cover
//
// The examples come first: they state the decision order and the one construction
// error, and the generated properties below state what must hold for every input.
// ---------------------------------------------------------------------------

describe('Copilot endpoint router', () => {
  it('walks the decision order: override, catalog, allowlist, default', () => {
    const router = createCopilotEndpointRouter({ overrides: { 'gpt-4o': 'responses' } })
    router.learn([
      generationModel('claude-sonnet-4', 'chat-completions'),
      generationModel('mystery-model', undefined),
      generationModel('gpt-4o', 'chat-completions'),
    ])

    expect(router.decide('gpt-4o')).toEqual({
      model: 'gpt-4o',
      endpoint: 'responses',
      protocolId: OPENAI_RESPONSES_PROTOCOL_ID,
      source: 'override',
    })
    expect(router.decide('claude-sonnet-4').source).toBe('catalog')
    expect(router.decide('mystery-model')).toEqual({
      model: 'mystery-model',
      endpoint: 'chat-completions',
      protocolId: OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID,
      source: 'default',
    })
    expect(router.decide('codex-mini-latest')).toEqual({
      model: 'codex-mini-latest',
      endpoint: 'responses',
      protocolId: OPENAI_RESPONSES_PROTOCOL_ID,
      source: 'allowlist',
    })
    // Insertion order, one entry per model id, nothing rewritten.
    expect(router.snapshot().map(entry => entry.model)).toEqual([
      'claude-sonnet-4', 'mystery-model', 'gpt-4o', 'codex-mini-latest',
    ])
  })

  it('adds caller prefixes to the shipped list instead of replacing it', () => {
    const router = createCopilotEndpointRouter({
      prefixes: [...COPILOT_RESPONSES_MODEL_PREFIXES, 'house-'],
    })
    expect(router.decide('house-model').source).toBe('allowlist')
    expect(router.decide('codex-mini').source).toBe('allowlist')
    // An empty prefix would route the whole catalog to `/responses`, the direction
    // where guessing wrong costs the request, so it is dropped rather than honoured.
    const permissive = createCopilotEndpointRouter({ prefixes: [''] })
    expect(permissive.decide('claude-sonnet-4').source).toBe('default')
  })

  it('rejects an override naming an endpoint that does not exist, at construction', () => {
    let caught: unknown
    try {
      createCopilotEndpointRouter({
        overrides: { 'gpt-4o': 'responses', 'o3-mini': 'compleitons' as CopilotEndpoint },
      })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AgentSdkError)
    expect((caught as AgentSdkError).code).toBe(COPILOT_ERROR_CODES.ENDPOINT_OVERRIDE_INVALID)
    expect((caught as AgentSdkError).message).toContain('o3-mini')
  })

  it('is unaffected by a later mutation of the overrides object it was handed', () => {
    const overrides: Record<string, CopilotEndpoint> = { 'gpt-4o': 'responses' }
    const router = createCopilotEndpointRouter({ overrides })
    overrides['claude-sonnet-4'] = 'nonsense' as CopilotEndpoint
    expect(router.decide('claude-sonnet-4').source).toBe('default')
  })
})

describe('Copilot composite protocol surface', () => {
  it('is a runtime wire protocol with the composite id and the flat Copilot dialect', () => {
    const { protocol } = instrument(createCopilotEndpointRouter())
    expect(protocol.kind).toBe('http-wire-protocol')
    expect(protocol.apiVersion).toBe(1)
    expect(protocol.id).toBe(COPILOT_DUAL_PROTOCOL_ID)
    expect(protocol.id).toBe('copilot-dual')
    expect(protocol.defaultDialect).toEqual(COPILOT_DEFAULT_DIALECT)
    // Flat: every value is a primitive or an array of primitives (DD-2).
    for (const value of Object.values(protocol.defaultDialect)) {
      if (Array.isArray(value)) {
        expect(value.every(item => typeof item === 'string')).toBe(true)
        continue
      }
      expect(typeof value).not.toBe('object')
    }
  })

  it('exposes no protocolHeaders, because neither sub-protocol declares any', () => {
    // Not an oversight and not a union: `protocolHeaders` receives no
    // `ProtocolRequest`, so the routing key is absent and a union would put a
    // header of the branch NOT taken on the wire.
    expect(openAiResponsesProtocol.protocolHeaders).toBeUndefined()
    expect(openAiChatCompletionsProtocol.protocolHeaders).toBeUndefined()
    const { protocol } = instrument(createCopilotEndpointRouter())
    expect(protocol.protocolHeaders).toBeUndefined()
    expect(Object.hasOwn(protocol, 'protocolHeaders')).toBe(false)
  })

  it('passes headers through only when both branches agree, and never unions them', () => {
    const headed = (
      headers: Readonly<Record<string, string>>,
    ): Pick<CopilotSubProtocol<never>, 'protocolHeaders'> => ({
      protocolHeaders: () => headers,
    })
    const build = (
      left: Readonly<Record<string, string>>,
      right: Readonly<Record<string, string>>,
    ): Readonly<Record<string, string>> | undefined => {
      const protocol = copilotDualProtocol({
        router: createCopilotEndpointRouter(),
        responses: {
          ...(openAiResponsesProtocol as unknown as ResponsesProtocolLike),
          ...headed(left),
        } as ResponsesProtocolLike,
        chat: {
          ...(openAiChatCompletionsProtocol as unknown as ChatCompletionsProtocolLike),
          ...headed(right),
        } as ChatCompletionsProtocolLike,
      })
      const method = protocol.protocolHeaders
      expect(method).toBeTypeOf('function')
      return method === undefined
        ? undefined
        : Reflect.apply(method, {}, [COPILOT_DEFAULT_DIALECT]) as Readonly<Record<string, string>>
    }

    expect(build({ 'x-shared': '1' }, { 'x-shared': '1' })).toEqual({ 'x-shared': '1' })
    // Divergent ⇒ none. The union `{ x-a, x-b }` would be the bug.
    expect(build({ 'x-a': '1' }, { 'x-b': '2' })).toEqual({})
    expect(build({ 'x-shared': '1' }, { 'x-shared': '2' })).toEqual({})
    expect(build({ 'x-shared': '1' }, {})).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Property 32
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 32: Composite protocol nhất quán trên cả ba mặt', () => {
  it('routes path, body and translator down the same branch for every model and catalog state', () => {
    // Both branches and all four decision sources have to actually occur, or the
    // property would be passing on a generator that only ever produces one case.
    const branches = new Set<string>()
    const sources = new Set<string>()
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x32_00_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const id = modelId(rng)
      // Every catalog state: silent, disclosing either endpoint, disclosing for a
      // different model, and pinned by an override.
      const overrides = bool(rng) ? { [id]: endpoint(rng) } : {}
      const learned: CopilotGenerationModel[] = []
      if (bool(rng)) learned.push(generationModel(id, bool(rng) ? endpoint(rng) : undefined))
      if (bool(rng)) learned.push(generationModel(`other-${id}`, endpoint(rng)))

      const router = createCopilotEndpointRouter({ overrides })
      router.learn(learned)
      const { protocol, log } = instrument(router)
      const copilot = dialect(rng)
      const { path, body } = invoke(protocol, protocolRequest(id), copilot)

      const decision = router.decide(id)
      const wanted = decision.endpoint === 'responses' ? 'responses' : 'chat'

      expect(path, trace).toBe(decision.endpoint === 'responses' ? '/responses' : '/chat/completions')
      expect(branchOfBody(body), trace).toBe(wanted)
      expect(decision.protocolId, trace).toBe(
        wanted === 'responses' ? OPENAI_RESPONSES_PROTOCOL_ID : OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID,
      )
      // All three faces delegated, all three to the same branch, nothing to the other.
      expect(methodsOf(log), trace).toEqual(['endpointPath', 'serialize', 'translate'])
      expect(log.map(entry => entry.branch), trace)
        .toEqual([wanted, wanted, wanted])
      branches.add(wanted)
      sources.add(decision.source)
    }
    expect(branches).toEqual(new Set(['responses', 'chat']))
    expect(sources).toEqual(new Set(['override', 'catalog', 'allowlist', 'default']))
  })

  it('hands each branch its own dialect, merged over that branch sub-protocol defaults', () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x32_10_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const id = modelId(rng)
      const forced = endpoint(rng)
      const router = createCopilotEndpointRouter({ overrides: { [id]: forced } })
      const { protocol, log } = instrument(router)
      const copilot = dialect(rng)
      invoke(protocol, protocolRequest(id), copilot)

      const seen = log.find(entry => entry.method === 'serialize')?.dialect
      if (forced === 'responses') {
        const sub = seen as ResponsesDialect
        expect(sub, trace).toMatchObject(toResponsesDialect(copilot))
        // `reasoningSummary: 'none'` is spelled by ABSENCE, and the sub-protocol's
        // own default must not creep back in to contradict it.
        expect(Object.hasOwn(sub, 'reasoningSummary'), trace)
          .toBe(copilot.reasoningSummary !== 'none')
        // Chat-only knobs never cross.
        for (const alien of ['systemRole', 'streamUsage', 'parallelToolCalls', 'maxTokensField', 'path']) {
          expect(Object.hasOwn(sub, alien), `${trace} ${alien}`).toBe(false)
        }
      } else {
        const sub = seen as ChatCompletionsDialect
        expect(sub, trace).toMatchObject(toChatCompletionsDialect(copilot))
        expect(sub.maxTokensField, trace).toBe(copilot.maxOutputTokens ? 'max_tokens' : false)
        expect(sub.structuredOutputs, trace)
          .toBe(copilot.structuredOutputs ? 'json-schema' : false)
        // Knobs the Copilot dialect does not expose come from the SUB-protocol.
        expect(sub.path, trace).toBe(openAiChatCompletionsProtocol.defaultDialect.path)
        expect(sub.stop, trace).toBe(openAiChatCompletionsProtocol.defaultDialect.stop)
        expect(sub.seed, trace).toBe(openAiChatCompletionsProtocol.defaultDialect.seed)
        expect(sub.reasoningEffort, trace)
          .toBe(openAiChatCompletionsProtocol.defaultDialect.reasoningEffort)
        for (const alien of ['store', 'include', 'reasoningSummary']) {
          expect(Object.hasOwn(sub, alien), `${trace} ${alien}`).toBe(false)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Property 33
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 33: Override endpoint luôn thắng mọi nguồn khác', () => {
  it('uses the override endpoint and reports source override, whatever the catalog says', () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x33_00_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const id = modelId(rng)
      const pinned = endpoint(rng)
      // The contradicting metadata: the opposite endpoint, or none at all.
      const declared = bool(rng)
        ? (pinned === 'responses' ? 'chat-completions' : 'responses')
        : undefined
      const learnFirst = bool(rng)

      const router = createCopilotEndpointRouter({ overrides: { [id]: pinned } })
      if (learnFirst) router.learn([generationModel(id, declared)])
      const { protocol, decisions } = instrument(router)
      const { path, body } = invoke(protocol, protocolRequest(id), dialect(rng))
      // A refresh after the fact changes nothing either.
      router.learn([generationModel(id, declared)])

      const decision = router.decide(id)
      expect(decision.endpoint, trace).toBe(pinned)
      expect(decision.source, trace).toBe('override')
      expect(decisions.at(0), trace).toEqual(decision)
      expect(path, trace).toBe(pinned === 'responses' ? '/responses' : '/chat/completions')
      expect(branchOfBody(body), trace).toBe(pinned === 'responses' ? 'responses' : 'chat')
    }
  })
})

// ---------------------------------------------------------------------------
// Property 34
//
// The one property the append-only rule exists for. Each case runs a retry chain
// and refreshes the catalog BETWEEN attempts with metadata that contradicts the
// decision already taken — the exact sequence a TTL expiry produces in production.
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 34: Quyết định endpoint bất biến trong một lần gọi', () => {
  it('sends every attempt of one logical call to the same endpoint across catalog refreshes', () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x34_00_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const id = modelId(rng)
      const overrides = bool(rng) ? { [id]: endpoint(rng) } : {}
      const router = createCopilotEndpointRouter({ overrides })
      if (bool(rng)) router.learn([generationModel(id, bool(rng) ? endpoint(rng) : undefined)])

      const { protocol, decisions } = instrument(router)
      const request = protocolRequest(id)
      const copilot = dialect(rng)
      const attempts = 2 + intBelow(rng, 3)
      const seenPaths: string[] = []
      const seenBranches: ('responses' | 'chat')[] = []

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const { path, body } = invoke(protocol, request, copilot)
        seenPaths.push(path)
        seenBranches.push(branchOfBody(body))
        // Between two attempts the catalog refreshes and changes its mind.
        router.learn([
          generationModel(id, endpoint(rng)),
          generationModel(`fresh-${String(attempt)}-${id}`, endpoint(rng)),
        ])
      }

      expect(new Set(seenPaths), trace).toEqual(new Set([seenPaths[0]]))
      expect(new Set(seenBranches), trace).toEqual(new Set([seenBranches[0]]))
      // One decision per attempt, and all of them identical — including `source`,
      // so a later catalog disclosure cannot even relabel who decided.
      expect(decisions).toHaveLength(attempts)
      expect(new Set(decisions.map(entry => JSON.stringify(entry))), trace)
        .toEqual(new Set([JSON.stringify(decisions[0])]))
      // The snapshot holds exactly one entry for this id, never a rewrite.
      expect(router.snapshot().filter(entry => entry.model === id), trace)
        .toEqual([decisions[0]])
    }
  })
})

// ---------------------------------------------------------------------------
// Property 35
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 35: Endpoint và protocol đã chọn được báo cáo', () => {
  it('reports exactly one decision per call, matching the path actually requested', () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x35_00_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const ids = Array.from({ length: 1 + intBelow(rng, 4) }, () => modelId(rng))
      const router = createCopilotEndpointRouter({
        ...(bool(rng) ? { overrides: { [pick(rng, ids)]: endpoint(rng) } } : {}),
      })
      if (bool(rng)) router.learn(ids.map(id => generationModel(id, endpoint(rng))))
      const { protocol, decisions } = instrument(router)

      const calls = ids.map(id => ({ id, ...invoke(protocol, protocolRequest(id), dialect(rng)) }))

      expect(decisions, trace).toHaveLength(calls.length)
      for (const [index, call] of calls.entries()) {
        const decision = decisions[index]
        expect(decision?.model, trace).toBe(call.id)
        expect(decision?.endpoint, trace).toBe(call.path === '/responses' ? 'responses' : 'chat-completions')
        expect(decision?.protocolId, trace).toBe(
          call.path === '/responses'
            ? OPENAI_RESPONSES_PROTOCOL_ID
            : OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID,
        )
        expect(decision?.source, trace)
          .toBeOneOf(['override', 'catalog', 'allowlist', 'default'])
        // A diagnostic channel carries diagnostics and nothing else: no prompt,
        // no credential, no dialect.
        expect(Object.keys(decision ?? {}).sort(), trace)
          .toEqual(['endpoint', 'model', 'protocolId', 'source'])
      }
    }
  })

  it('keeps the request alive when the observer throws, and reports once not three times', () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x35_10_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const id = modelId(rng)
      const router = createCopilotEndpointRouter({
        ...(bool(rng) ? { overrides: { [id]: endpoint(rng) } } : {}),
      })
      const { protocol, log, decisions } = instrument(router, true)
      const { path, body } = invoke(protocol, protocolRequest(id), dialect(rng))

      expect(decisions, trace).toHaveLength(1)
      expect(methodsOf(log), trace).toEqual(['endpointPath', 'serialize', 'translate'])
      expect(branchOfBody(body), trace).toBe(path === '/responses' ? 'responses' : 'chat')
    }
  })
})
