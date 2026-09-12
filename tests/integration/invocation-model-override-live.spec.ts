/**
 * Per-invocation model selection against the real endpoints.
 *
 * Excluded from `npm test`; run with `npm run test:integration`. Needs
 * `npm run provider:codex:login-device`, and for the retrieval scenario
 * `npm run provider:copilot:login-device`. Without a credential the affected
 * suite SKIPS rather than fails.
 *
 * ## What only a live run can settle
 *
 * A mock adapter proves the override reaches `GenerateOptions`. It cannot prove
 * the three things that actually break in production:
 *
 * 1. **That both targets are callable with the efforts asked for.** `gpt-5.6-luna`
 *    and `gpt-reserve` publish their own ladders, and an effort the account
 *    cannot use fails at dispatch, not at capture.
 * 2. **That switching model mid-conversation keeps the conversation.** History
 *    written by one model is replayed to the next one; a run that answers a
 *    question only the earlier turn could have supplied is the evidence.
 * 3. **That the embedding side did NOT move.** The generation override is
 *    per-call by design; embedding model selection deliberately is not
 *    (Requirement 6.6). A retrieval index built with `text-embedding-3-small`
 *    has to stay in that space no matter which model answers, and the only way
 *    to show that is to build one and query it across a model switch.
 *
 * Nothing here asserts answer quality. The claims are about routing, attribution
 * and vector space.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAgentRuntime, type AgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { codexNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/codex'
import { copilotNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/copilot'
import { fileCodexAuthStore } from '@alvin0/ai-agent-sdk-auth-node/codex'
import { openAiEmbeddingPlugin } from '../../packages/provider-openai/src/embedding.ts'
import { MODEL_BINDING_ERROR_CODES } from '../../packages/core/src/composition/common/config.ts'
import {
  COPILOT_BASE_URL, copilotLive, copilotLiveHeaders, liveCopilotApiToken,
} from '../helpers/copilot-live.ts'

const GENERATION_ROUTE = 'codex'
const PRIMARY_MODEL = 'gpt-5.6-luna'
const SECONDARY_MODEL = 'gpt-reserve'
const COPILOT_ROUTE = 'copilot'
/**
 * A Copilot chat model this account can actually call.
 *
 * Entitlement is per-account and the catalog is advisory — `GET /models` lists
 * models an account may not be entitled to — so this is overridable per run.
 */
const COPILOT_MODEL = process.env.COPILOT_CHAT_MODEL ?? 'gpt-4o-mini-2024-07-18'
const EMBEDDING_ROUTE = 'copilot-embedding'
const EMBEDDING_MODEL = 'text-embedding-3-small'
/** Dimensions this model returns when none is requested. */
const EMBEDDING_DIMENSIONS = 1_536

/** Skip rather than fail when nobody has logged in to Codex. */
const codexLive = await (async () => {
  const file = await fileCodexAuthStore(undefined, { cwd: process.cwd(), env: process.env }).read()
  return file?.tokens != null
})()

/**
 * The Copilot embeddings endpoint, reached through the OpenAI embedding adapter.
 *
 * Copilot serves an OpenAI-shaped `POST /embeddings`, so the compatible adapter
 * is pointed at that base with the editor headers the endpoint requires. The
 * compatibility claim is this configuration's, which is exactly the arrangement
 * `OpenAiEmbeddingProviderOptions.baseUrl` documents.
 */
async function copilotEmbeddingPlugin() {
  const apiToken = await liveCopilotApiToken()
  const headers = copilotLiveHeaders(apiToken)
  return openAiEmbeddingPlugin({
    id: EMBEDDING_ROUTE,
    routes: [EMBEDDING_ROUTE],
    apiKey: apiToken.token,
    baseUrl: COPILOT_BASE_URL,
    models: [{
      id: EMBEDDING_MODEL,
      defaultDimensions: EMBEDDING_DIMENSIONS,
      purposeHandling: 'unsupported',
      normalization: 'unit-l2',
      compatibilityIdentity: `copilot:${EMBEDDING_MODEL}`,
    }],
    fetch: (input, init) => globalThis.fetch(input, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers ?? {})), ...headers },
    }),
  })
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0, leftNorm = 0, rightNorm = 0
  for (const [index, value] of left.entries()) {
    const other = right[index] ?? 0
    dot += value * other
    leftNorm += value * value
    rightNorm += other * other
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1)
}

describe.skipIf(!codexLive)('per-invocation model selection, live generation', () => {
  let runtime: AgentRuntime
  afterAll(async () => { await runtime?.close() })

  beforeAll(async () => {
    runtime = await createAgentRuntime({
      providers: [codexNodeProviderPlugin({ defaultModel: PRIMARY_MODEL })],
      defaultProvider: GENERATION_ROUTE,
    })
  })

  it('puts successive turns of one session on different models at different efforts', async () => {
    const agent = runtime.agent({
      id: 'override-live', model: { provider: GENERATION_ROUTE, id: PRIMARY_MODEL }, effort: 'low',
      instructions: 'Answer in at most eight words. No punctuation beyond a full stop.',
      compaction: false,
    })
    const session = agent.createSession()

    const bound = await session.run('Reply with the single word: alpha')
    const highEffort = await session.run('Reply with the single word: beta', { effort: 'high' })
    const switched = await session.run('Reply with the single word: gamma', {
      model: { provider: GENERATION_ROUTE, id: SECONDARY_MODEL }, effort: 'max',
    })
    const routeDefault = await session.run('Reply with the single word: delta', {
      model: { provider: GENERATION_ROUTE },
    })

    const called = (response: { report: { modelCalls: readonly { provider: string; model: string }[] } }) =>
      [...new Set(response.report.modelCalls.map(call => `${call.provider}/${call.model}`))]

    expect(called(bound)).toEqual([`${GENERATION_ROUTE}/${PRIMARY_MODEL}`])
    expect(called(highEffort)).toEqual([`${GENERATION_ROUTE}/${PRIMARY_MODEL}`])
    // The override, not the binding, decided this turn.
    expect(called(switched)).toEqual([`${GENERATION_ROUTE}/${SECONDARY_MODEL}`])
    // Route-only resolves the configured default, which is the primary model again.
    expect(called(routeDefault)).toEqual([`${GENERATION_ROUTE}/${PRIMARY_MODEL}`])
    // The agent's own target never moved.
    expect(agent.model).toEqual({ provider: GENERATION_ROUTE, id: PRIMARY_MODEL })

    for (const response of [bound, highEffort, switched, routeDefault]) {
      expect(response.report.status).toBe('success')
      expect(response.text.trim().length).toBeGreaterThan(0)
    }
  }, 300_000)

  it('carries the conversation across a model switch', async () => {
    const session = runtime.agent({
      id: 'continuity-live', model: { provider: GENERATION_ROUTE, id: PRIMARY_MODEL }, effort: 'low',
      instructions: 'Answer with one lowercase word and nothing else.', compaction: false,
    }).createSession()

    await session.run('Remember this codeword for later: pangolin. Reply with: ok')
    const recalled = await session.run('What was the codeword? Reply with the word only.', {
      model: { provider: GENERATION_ROUTE, id: SECONDARY_MODEL }, effort: 'medium',
    })

    expect(recalled.report.modelCalls.every(call => call.model === SECONDARY_MODEL)).toBe(true)
    // Only the history written by the earlier model can supply this answer.
    expect(recalled.text.toLowerCase()).toContain('pangolin')
  }, 300_000)

  it('refuses an effort the live catalog does not offer, and never lands on another one', async () => {
    const session = runtime.agent({
      id: 'no-failover-live', model: { provider: GENERATION_ROUTE, id: PRIMARY_MODEL },
      instructions: 'Answer in one word.', compaction: false,
    }).createSession()

    const failure = await session.run('Reply with: epsilon', { effort: 'ludicrous' })
      .then(() => undefined, (error: unknown) => error as { code?: string; report?: { errors: readonly { code: string }[] } })
    expect(failure).toBeDefined()
    expect(failure!.report?.errors.map(error => error.code)).toContain('UNSUPPORTED_REASONING_EFFORT')
    // The session is intact: the refusal is about that one invocation.
    const next = await session.run('Reply with: zeta')
    expect(next.report.status).toBe('success')
  }, 300_000)

  it('rejects an unroutable override before it costs a request', async () => {
    const session = runtime.agent({
      id: 'guard-live', model: { provider: GENERATION_ROUTE, id: PRIMARY_MODEL },
      instructions: 'Answer in one word.', compaction: false,
    }).createSession()
    await expect(session.run('Reply with: eta', { model: { provider: 'not-configured', id: 'x' } }))
      .rejects.toThrow(expect.objectContaining({ code: MODEL_BINDING_ERROR_CODES.UNKNOWN_ROUTE }))
  }, 120_000)
})

describe.skipIf(!codexLive || !copilotLive)('per-invocation model selection across providers', () => {
  let runtime: AgentRuntime
  afterAll(async () => { await runtime?.close() })

  beforeAll(async () => {
    runtime = await createAgentRuntime({
      providers: [
        codexNodeProviderPlugin({ defaultModel: PRIMARY_MODEL }),
        copilotNodeProviderPlugin({ id: COPILOT_ROUTE, defaultModel: COPILOT_MODEL }),
      ],
      // Two routes now publish a default, so the runtime must be told which one
      // an agent with no explicit target means. Without this the binding fails
      // with MODEL_DEFAULT_AMBIGUOUS, by design.
      defaultProvider: GENERATION_ROUTE,
    })
  }, 120_000)

  it('crosses provider AND wire protocol mid-conversation, then returns to the binding', async () => {
    // Codex answers on /responses and Copilot on /chat/completions, so this
    // override changes the request shape, the credential and the endpoint — not
    // just a model id. History written by one has to replay to the other.
    const agent = runtime.agent({
      id: 'cross-provider-live', model: { provider: GENERATION_ROUTE, id: PRIMARY_MODEL }, effort: 'low',
      instructions: 'Answer with one lowercase word and nothing else.', compaction: false,
    })
    const session = agent.createSession()

    const bound = await session.run('Remember this codeword for later: quokka. Reply with: ok')
    const crossed = await session.run('What was the codeword? Reply with the word only.', {
      model: { provider: COPILOT_ROUTE, id: COPILOT_MODEL },
    })
    const returned = await session.run('Reply with: done')

    expect(bound.report.modelCalls.every(call => call.provider === GENERATION_ROUTE)).toBe(true)
    expect(crossed.report.modelCalls.map(call => `${call.provider}/${call.model}`))
      .toEqual([`${COPILOT_ROUTE}/${COPILOT_MODEL}`])
    // Only the earlier turn, answered by the other provider, can supply this.
    expect(crossed.text.toLowerCase()).toContain('quokka')
    expect(agent.model).toEqual({ provider: GENERATION_ROUTE, id: PRIMARY_MODEL })
    expect(returned.report.modelCalls.map(call => `${call.provider}/${call.model}`))
      .toEqual([`${GENERATION_ROUTE}/${PRIMARY_MODEL}`])
  }, 420_000)

  it('raises the failing model\'s error instead of retrying somewhere else', async () => {
    const session = runtime.agent({
      id: 'cross-provider-no-failover', model: { provider: GENERATION_ROUTE, id: PRIMARY_MODEL },
      instructions: 'Answer in one word.', compaction: false,
    }).createSession()

    const unknown = 'model-this-account-cannot-call'
    const failure = await session.run('Reply with: theta', { model: { provider: COPILOT_ROUTE, id: unknown } })
      .then(() => undefined, (error: unknown) => error as { report?: { modelCalls: readonly { provider: string; model: string }[] } })
    expect(failure).toBeDefined()
    // Whatever was attempted was THAT model on THAT route; nothing fell back to
    // the agent's binding or to the other configured route.
    for (const call of failure!.report?.modelCalls ?? []) {
      expect(`${call.provider}/${call.model}`).toBe(`${COPILOT_ROUTE}/${unknown}`)
    }
    const next = await session.run('Reply with: iota')
    expect(next.report.modelCalls.every(call => call.model === PRIMARY_MODEL)).toBe(true)
  }, 300_000)
})

describe.skipIf(!codexLive || !copilotLive)('retrieval across a generation model switch', () => {
  let runtime: AgentRuntime
  afterAll(async () => { await runtime?.close() })

  const documents = Object.freeze([
    'The Meridian battery pack shipped on 2026-08-31 at twelve thousand US dollars per one hundred kilowatt hours.',
    'The Halden sodium pack was observed on 2026-07-01 at one hundred and fifty US dollars per kilowatt hour.',
    'Office coffee consumption rose by four percent in the second quarter of 2026.',
  ])

  beforeAll(async () => {
    runtime = await createAgentRuntime({
      providers: [codexNodeProviderPlugin({ defaultModel: PRIMARY_MODEL }), await copilotEmbeddingPlugin()],
      defaultProvider: GENERATION_ROUTE,
    })
  }, 120_000)

  it('keeps one embedding space while the answering model changes per call', async () => {
    const embeddings = runtime.embeddingModel({ provider: EMBEDDING_ROUTE, model: EMBEDDING_MODEL })
    const index = await embeddings.embedMany({ values: [...documents], purpose: 'retrieval-document' })
    expect(index.embeddings).toHaveLength(documents.length)
    expect(index.embeddings[0]).toHaveLength(EMBEDDING_DIMENSIONS)

    const query = await embeddings.embed({
      value: 'What did the sodium pack cost per kilowatt hour?', purpose: 'retrieval-query',
    })
    // Same handle, same space: a query vector is only comparable because nothing
    // in the generation overrides below can move the embedding model.
    expect(query.space).toBe(index.space)

    const ranked = index.embeddings
      .map((vector, position) => ({ position, score: cosine(vector, query.embedding) }))
      .sort((left, right) => right.score - left.score)
    expect(ranked[0]!.position).toBe(1)
    const context = documents[ranked[0]!.position]!

    const session = runtime.agent({
      id: 'rag-live', model: { provider: GENERATION_ROUTE, id: PRIMARY_MODEL }, effort: 'low',
      instructions: 'Answer only from the supplied context. Reply with the figure and its unit, nothing else.',
      compaction: false,
    }).createSession()

    const primary = await session.run(`Context: ${context}\n\nQuestion: what did the sodium pack cost per kilowatt hour?`)
    const secondary = await session.run('Repeat that figure exactly.', {
      model: { provider: GENERATION_ROUTE, id: SECONDARY_MODEL }, effort: 'medium',
    })

    expect(primary.report.modelCalls.every(call => call.model === PRIMARY_MODEL)).toBe(true)
    expect(secondary.report.modelCalls.every(call => call.model === SECONDARY_MODEL)).toBe(true)
    expect(primary.text).toMatch(/150|one hundred and fifty/i)
    expect(secondary.text).toMatch(/150|one hundred and fifty/i)

    // The index is still queryable in the same space after the switch, which is
    // the property a per-call embedding override would have destroyed.
    const second = await embeddings.embed({
      value: 'What did the sodium pack cost per kilowatt hour?', purpose: 'retrieval-query',
    })
    expect(second.space).toBe(index.space)
    expect(cosine(second.embedding, query.embedding)).toBeGreaterThan(0.99)
  }, 420_000)
})

describe.skipIf(!codexLive || !copilotLive || process.env.SDK_LIVE_SOAK !== '1')('long session package composition', () => {
  it('cycles every advertised effort with retrieval, rejected calls, abort and reuse', async () => {
    const advertised = new Map<string, string[]>()
    const runtime = await createAgentRuntime({
      providers: [codexNodeProviderPlugin({ defaultModel: PRIMARY_MODEL, fetch: async (input, init) => {
        const response = await globalThis.fetch(input, init)
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (new URL(url).pathname.endsWith('/models') && response.ok) {
          const body = await response.clone().json() as { models?: { slug?: string; supported_reasoning_levels?: { effort?: string }[] }[] }
          for (const row of body.models ?? []) {
            if (row.slug !== undefined) advertised.set(row.slug,
              (row.supported_reasoning_levels ?? []).flatMap(level => level.effort === undefined ? [] : [level.effort]))
          }
        }
        return response
      } }), await copilotEmbeddingPlugin()],
      defaultProvider: GENERATION_ROUTE,
    })
    try {
      const catalog = await runtime.modelCatalog(GENERATION_ROUTE)
      const targets = [PRIMARY_MODEL, SECONDARY_MODEL].flatMap(model => {
        const entry = catalog.models.find(candidate => candidate.id === model)
        expect(entry, `catalog must expose ${model}`).toBeDefined()
        const efforts = advertised.get(model) ?? []
        expect(efforts.length).toBeGreaterThan(0)
        return efforts.map(effort => ({ model, effort }))
      })
      console.log('soak targets', targets)
      const embeddings = runtime.embeddingModel({ provider: EMBEDDING_ROUTE, model: EMBEDDING_MODEL })
      const indexed = await embeddings.embedMany({
        values: ['The project codeword is pangolin.', 'The office coffee is decaf.'], purpose: 'retrieval-document',
      })
      const session = runtime.agent({
        id: 'long-session-live', model: { provider: GENERATION_ROUTE, id: PRIMARY_MODEL }, effort: 'low',
        instructions: 'Remember the supplied project codeword. Answer with that one word only.', compaction: false,
      }).createSession()
      const count = Math.max(24, targets.length * 2)
      for (let turn = 0; turn < count; turn++) {
        const target = targets[turn % targets.length]!
        if (turn % 6 === 3) {
          await expect(session.run('This request must fail preflight.', { effort: 'ludicrous' })).rejects.toBeDefined()
          expect(session.isRunning).toBe(false)
        }
        if (turn % 4 === 0) {
          const query = await embeddings.embed({ value: 'What is the project codeword?', purpose: 'retrieval-query' })
          expect(query.space).toBe(indexed.space)
          expect(cosine(query.embedding, indexed.embeddings[0]!))
            .toBeGreaterThan(cosine(query.embedding, indexed.embeddings[1]!))
        }
        const response = await session.run(turn === 0
          ? 'The project codeword is pangolin. What is the codeword?'
          : 'What is the project codeword from earlier in this conversation?', {
          model: { provider: GENERATION_ROUTE, id: target.model }, effort: target.effort,
        })
        expect(response.report.status).toBe('success')
        expect(response.text.toLowerCase()).toContain('pangolin')
        expect(response.report.modelCalls.length).toBeGreaterThan(0)
        expect(response.report.modelCalls.every(call => call.provider === GENERATION_ROUTE && call.model === target.model)).toBe(true)
        expect(response.report.usage.authoritative).toBe(true)
        expect(session.isRunning).toBe(false)
        console.log(`soak turn ${turn + 1}/${count}: ${target.model}/${target.effort} passed`)
      }
      const handle = session.stream('Repeat the project codeword.', { effort: 'low' })
      for await (const event of handle) {
        if (event.type === 'assistant-delta') handle.abort()
      }
      expect((await handle.report).status).toBe('aborted')
      expect((await session.run('What is the codeword?')).text.toLowerCase()).toContain('pangolin')
    } finally {
      expect(await runtime.close()).toMatchObject({ state: 'closed', unsettledRuns: 0 })
    }
  }, 1_200_000)
})
