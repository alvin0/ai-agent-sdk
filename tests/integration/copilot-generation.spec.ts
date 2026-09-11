/**
 * The Copilot generation surface against the real endpoint.
 *
 * Excluded from `npm test` — `vitest.config.ts` excludes `tests/integration/**`,
 * and `vitest.integration.config.ts` includes nothing else — so this file runs only
 * under `npm run test:integration` (Requirement 16.4). It needs a credential from
 * `npm run provider:copilot:login-device`; without one the whole suite SKIPS rather
 * than fails, which is what lets public CI stay green with no secret
 * (Requirement 16.5). The guard is `copilotLive`, resolved in
 * `tests/helpers/copilot-live.ts` from the Node default `Copilot_Credential_Store`.
 *
 * ## The three things only a live call can settle
 *
 * 1. **What `GET /models` returns for this account.** A mock returns whatever a
 *    fixture says, so it can never tell you that the classification table behind
 *    Property 28 still matches reality. Only the endpoint can.
 * 2. **That both endpoint decisions are actually dispatchable.** A router unit test
 *    proves the decision is made; it cannot prove `/chat/completions` and
 *    `/responses` both answer for this account with this editor identity. A live run
 *    showed the two endpoints are not symmetric here — see the `/responses` test for
 *    what an account may legitimately refuse and why that is still a pass.
 * 3. **That the exchange body still carries a readable `expires_at`.** The whole
 *    refresh policy rests on that one field, and this SDK refuses to invent a
 *    lifetime when it is missing — so a silent removal upstream has to be
 *    detectable somewhere.
 *
 * ## What is deliberately NOT asserted
 *
 * No test here pins the exact model list. The catalog is per-account and it drifts;
 * a hard-coded list would fail for a reason that has nothing to do with this SDK.
 * The claim asserted instead is STRUCTURAL: every entry the endpoint returns
 * classifies into one of the two recognized `capabilities.type` values, which is
 * precisely what Property 28 depends on. A third value appearing is a real finding
 * and should fail this test.
 *
 * No scenario runs 100 iterations either. Quota cost is real, the responses are not
 * deterministic, and varying the input buys no additional information about a wire
 * contract.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { BlockAssembler, ModelRegistry, createTextMessage } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { copilotAdapter } from '../../packages/provider-copilot/src/adapter.ts'
import {
  COPILOT_DEFAULT_MAX_CATALOG_MODELS,
  partitionCopilotCatalog,
  type CopilotCatalogSnapshot,
  type CopilotEndpoint,
} from '../../packages/provider-copilot/src/catalog.ts'
import {
  COPILOT_RESPONSES_MODEL_PREFIXES,
  type CopilotEndpointDecision,
} from '../../packages/provider-copilot/src/router.ts'
import { fileCopilotCredentialStore } from '../../packages/auth-node/src/copilot-store.ts'
import {
  COPILOT_BASE_URL,
  copilotLive,
  fetchCopilotCatalogBody,
  liveCopilotApiToken,
} from '../helpers/copilot-live.ts'

const PROVIDER = 'copilot'
const PROMPT = 'Reply with exactly one lowercase word: ping'
/** Short on purpose: this checks a wire contract, not model quality. */
const MAX_TOKENS = 64
const REQUEST_TIMEOUT_MS = 60_000

/**
 * Model ids preferred for each endpoint, most-likely-callable first.
 *
 * A live run showed why a preference list is needed at all: `GET /models` lists
 * ~50 chat models for a Copilot Individual account, and MANY OF THEM ARE NOT
 * CALLABLE — `claude-fable-5.1`, `gpt-5-mini` and `gpt-5.6-luna` each answer HTTP
 * 400 `The requested model is not supported.` The catalog is advisory
 * (Requirement 8.6), so "listed" and "entitled" are different facts and only the
 * second one can carry a stream. Taking the first catalog id would therefore pick a
 * model this account cannot call and fail for a reason that is not about this SDK.
 *
 * Overridable per run with `COPILOT_RESPONSES_MODEL` / `COPILOT_CHAT_MODEL`, since
 * entitlement differs per account and per plan.
 */
const PREFERRED_MODELS: Readonly<Record<CopilotEndpoint, readonly string[]>> = Object.freeze({
  responses: Object.freeze(['gpt-5-mini', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-5']),
  'chat-completions': Object.freeze(['gpt-4o-mini', 'gpt-4.1', 'gpt-4o']),
})

/** The code the Copilot surface returns when a model is not callable on an endpoint. */
const MODEL_NOT_SUPPORTED_CODE = 'INVALID_REQUEST'

/** The two recognized `capabilities.type` values — the table Property 28 partitions on. */
const RECOGNIZED_CAPABILITY_TYPES: ReadonlySet<string> = new Set(['chat', 'embeddings'])

/** One live catalog read, shared by every test that needs a model id. */
let snapshot: CopilotCatalogSnapshot
/** The raw entries, kept so the type census can be taken from the endpoint's own bytes. */
let entries: readonly Record<string, unknown>[]

/** What one live stream produced: the text, the terminal reason, and the routing. */
interface LiveStream {
  readonly text: string
  readonly finish: StreamChunk | undefined
  readonly decisions: readonly CopilotEndpointDecision[]
}

/**
 * Dispatch one short stream with the endpoint for `model` PINNED, and report what
 * came back.
 *
 * The override is the point of the live run: the router's decision order is
 * unit-tested already, and what only a real call adds is that a request forced onto
 * each endpoint is actually dispatchable. The decisions are captured rather than
 * assumed, so the test can confirm the pin — not a prefix guess — chose the endpoint.
 * @param model - the model id to send.
 * @param endpoint - the endpoint to pin it to.
 * @returns the assembled text, the terminal chunk, and every recorded decision.
 */
async function liveStream(model: string, endpoint: CopilotEndpoint): Promise<LiveStream> {
  const decisions: CopilotEndpointDecision[] = []
  const registry = new ModelRegistry()
  registry.registerAdapter([PROVIDER], copilotAdapter({
    authStore: fileCopilotCredentialStore(undefined, { cwd: process.cwd(), env: process.env }),
    endpointOverrides: { [model]: endpoint },
    onEndpointDecision: decision => { decisions.push(decision) },
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  }))
  const assembler = new BlockAssembler()
  let finish: StreamChunk | undefined
  for await (const chunk of registry.stream({
    provider: PROVIDER,
    model,
    messages: [createTextMessage(PROMPT)],
    maxTokens: MAX_TOKENS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })) {
    assembler.push(chunk)
    if (chunk.type === 'finish') finish = chunk
  }
  const message = assembler.message({ kind: 'model', provider: PROVIDER, model })
  const text = message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return { text, finish, decisions }
}

/**
 * Whether a terminal chunk is the surface saying "this model cannot serve this
 * endpoint", as opposed to any other failure.
 *
 * Both wordings observed live are the same class of answer, and both arrive as HTTP
 * 400 with a provider request id: `model gpt-4o-mini is not supported via Responses
 * API.` for a model outside the Responses surface, and `The requested model is not
 * supported.` for a catalog entry this account is not entitled to.
 * @param finish - the terminal chunk, when there was one.
 * @returns true when the endpoint refused the model itself.
 */
function refusedTheModel(finish: StreamChunk | undefined): boolean {
  if (finish?.type !== 'finish' || finish.reason.kind !== 'error') return false
  const failure = finish.reason.failure as { code?: unknown; status?: unknown; requestId?: unknown }
  return failure.code === MODEL_NOT_SUPPORTED_CODE
    && failure.status === 400
    && typeof failure.requestId === 'string'
}

/**
 * Pick a live model id for an endpoint.
 *
 * Preference list first, INTERSECTED with the account's catalog — a preferred id
 * this account cannot see is no use — and the catalog's own ordering after, so an
 * account with an entirely different model line-up still has something to send.
 * `/responses` draws only from the responses allowlist: forcing a `gpt-4`-era model
 * onto that endpoint tests the endpoint's model policy, not a dispatch.
 * @param endpoint - the endpoint the model has to serve.
 * @returns a model id to try, or `undefined` when this account's catalog offers none.
 */
function modelFor(endpoint: CopilotEndpoint): string | undefined {
  const override = process.env[endpoint === 'responses' ? 'COPILOT_RESPONSES_MODEL' : 'COPILOT_CHAT_MODEL']
  if (override !== undefined && override.length > 0) return override
  const allowlisted = (id: string): boolean =>
    COPILOT_RESPONSES_MODEL_PREFIXES.some(prefix => id.startsWith(prefix))
  const available = new Set(snapshot.generation
    .map(entry => entry.model.id)
    .filter(id => endpoint === 'responses' ? allowlisted(id) : !allowlisted(id)))
  return PREFERRED_MODELS[endpoint].find(id => available.has(id)) ?? [...available][0]
}

beforeAll(async () => {
  if (!copilotLive) return
  const apiToken = await liveCopilotApiToken(AbortSignal.timeout(REQUEST_TIMEOUT_MS))
  const body = await fetchCopilotCatalogBody(apiToken, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
  entries = (Array.isArray(body.data) ? body.data : []).filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  )
  snapshot = partitionCopilotCatalog(body, COPILOT_DEFAULT_MAX_CATALOG_MODELS)
})

describe.skipIf(!copilotLive)('copilot generation (live)', () => {
  it('classifies every catalog entry the account can see into one of the two recognized types', () => {
    expect(entries.length).toBeGreaterThan(0)

    // The census is taken from the endpoint's own bytes, not from the partition, so
    // a NEW `capabilities.type` shows up as a named value rather than as a silent
    // omission. If this set ever grows, Property 28's table has drifted from
    // reality and the classification code needs a decision, not a passing test.
    const seen = new Set<string>()
    for (const entry of entries) {
      const capabilities = entry.capabilities
      const type = typeof capabilities === 'object' && capabilities !== null
        ? (capabilities as Record<string, unknown>).type
        : undefined
      if (typeof type === 'string') seen.add(type)
    }
    expect([...seen].filter(type => !RECOGNIZED_CAPABILITY_TYPES.has(type))).toEqual([])

    // The structural claim Property 28 rests on: partitioned, exhaustive, disjoint.
    expect(snapshot.generation.length + snapshot.embedding.length).toBe(entries.length)
    expect(snapshot.omitted).toEqual([])
    const generationIds = new Set(snapshot.generation.map(entry => entry.model.id))
    expect(snapshot.embedding.filter(entry => generationIds.has(entry.id))).toEqual([])

    // An account with no chat model cannot generate at all, so this one is safe to
    // require; the embedding half is left to `copilot-embedding.spec.ts`, which
    // skips itself when the account has none.
    expect(snapshot.generation.length).toBeGreaterThan(0)
  })

  it('streams real text from a model pinned to /chat/completions', async () => {
    const model = modelFor('chat-completions')
    // An account with no chat-completions model has nothing to dispatch; the catalog
    // test above already fails if the account has no generation model at all.
    if (model === undefined) return
    const { text, finish, decisions } = await liveStream(model, 'chat-completions')

    expect(decisions).toContainEqual(expect.objectContaining({
      model, endpoint: 'chat-completions', source: 'override',
    }))
    // The endpoint that must work for this provider to be usable at all: a real
    // stream, assembled into real text. `gpt-4o-mini` answered `pong` on a live run.
    expect(finish?.type).toBe('finish')
    expect(text.length).toBeGreaterThan(0)
  }, REQUEST_TIMEOUT_MS + 30_000)

  it('dispatches to /responses and gets either a stream or the endpoint own model refusal', async () => {
    const model = modelFor('responses')
    if (model === undefined) return
    const { text, finish, decisions } = await liveStream(model, 'responses')

    // The pin, not a prefix guess, chose the endpoint — this is the half of the
    // scenario that holds regardless of what the account is entitled to.
    expect(decisions).toContainEqual(expect.objectContaining({
      model, endpoint: 'responses', source: 'override',
    }))
    expect(finish?.type).toBe('finish')

    // Two outcomes are both correct, and which one appears is a property of the
    // ACCOUNT rather than of this SDK. A live Copilot Individual account served
    // neither: every responses-allowlisted id it lists — `gpt-5-mini`, `gpt-5.4`,
    // `gpt-5.6-luna`, `gpt-6-astra` — answered HTTP 400 `The requested model is not
    // supported.`, and every `gpt-4`-era id answered `not supported via Responses
    // API.` Requiring text here would therefore fail on entitlement, not on a
    // defect. What the refusal DOES prove is worth keeping: the request reached the
    // Responses surface, and the rejection came back as a model error with a stable
    // code and a provider request id rather than as an SDK-invented failure
    // (Requirement 8.6 — the catalog is advisory, so an uncatalogued or
    // unentitled model is dispatched and the endpoint's own answer is passed
    // through).
    expect(text.length > 0 || refusedTheModel(finish)).toBe(true)
  }, REQUEST_TIMEOUT_MS + 30_000)

  it('reads expires_at from a real token exchange, and works despite a divergent declared endpoint', async () => {
    const api = await liveCopilotApiToken(AbortSignal.timeout(REQUEST_TIMEOUT_MS))

    // The one field the refresh policy cannot do without. `shouldExchange` has no
    // fallback branch by design — this SDK does not invent a token lifetime — so an
    // upstream removal of `expires_at` has to fail somewhere, and this is where.
    expect(Number.isFinite(api.expiresAtMs)).toBe(true)
    expect(api.expiresAtMs).toBeGreaterThan(Date.now())

    // DD-6, checked rather than assumed: the exchange may declare an
    // `endpoints.api` that differs from the base URL this SDK requests against
    // (an individual-plan account declares `api.individual.githubcopilot.com`).
    // The adapter still works, because a server-designated base URL is a redirect
    // under another name and this SDK does not follow one. `declaredApiEndpoint` is
    // diagnostics only — and the tests above just dispatched successfully against
    // `COPILOT_BASE_URL`, which is the proof that the divergence is harmless.
    if (api.declaredApiEndpoint !== undefined) {
      expect(api.declaredApiEndpoint.startsWith('https://')).toBe(true)
      expect(COPILOT_BASE_URL).toBe('https://api.githubcopilot.com')
    }
  }, REQUEST_TIMEOUT_MS + 30_000)
})
