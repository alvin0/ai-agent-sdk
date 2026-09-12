/**
 * Property tests for Copilot redaction and the best-effort request logger.
 *
 * Feature: github-copilot-provider — Properties 50, 53 and 54.
 *
 * Three questions, each with one owner in `packages/provider-copilot`:
 *
 * - **Property 50** — can either token value reach a serialized error? The
 *   dangerous input is not a mistake in an SDK-authored message: it is the
 *   ENDPOINT'S OWN error body, which `provider-http` retains verbatim in `cause`,
 *   and which an endpoint has been known to fill with the `Authorization` header
 *   it just received. So every generated body here echoes the live token, on
 *   purpose, at every status the two paths classify.
 * - **Property 53** — at the DEFAULT configuration, does anything carrying a
 *   prompt, a credential or the client identity reach an observation record? And
 *   when the deprecated request logger is attached explicitly, is every
 *   auth-layer header redacted before the record is handed over?
 * - **Property 54** — a logger that returns, throws, rejects or never settles:
 *   the request goes out regardless, and the logger's failure stays out of the
 *   operation's result.
 *
 * ## Reading choices this file makes
 *
 * - **Inputs come from a seeded mulberry32 generator**, not `Math.random`: the
 *   repository carries no property-testing library and a failure has to reproduce
 *   from the printed seed. Same shape as `tests/unit/copilot-token-cache.spec.ts`
 *   and `tests/unit/copilot-exchange.spec.ts`.
 * - **Property 50 is asserted on a DEEP walk, not on `error.message`.** The token
 *   would not leak through the message — nothing interpolates it there — it would
 *   leak two hops down, in the `cause` of the `cause`. {@link collectStrings}
 *   therefore gathers `message`, `code`, `stack`, `name`, every own enumerable
 *   property and the whole `cause` chain, of errors and of the plain
 *   `SafeErrorRecord` objects `credentialFailure` produces.
 * - **The cache path is exercised with an entry already in place.** A
 *   `CopilotTokenCacheEntry` RETAINS `sourceToken` by design (DD-11), so "no
 *   token in a serialized error" has to hold at the moment the cache is holding
 *   one. The clock is injected so a second exchange comes due while the first
 *   entry is still there, and that second exchange is the one that fails.
 * - **Property 53's "no raw content in observation" is read at the default
 *   configuration**, which is what the design says. The explicitly attached
 *   `requestLogger` receives the exact wire body BY CONTRACT — it is the
 *   deprecated diagnostics bridge, and its record documents that it may carry
 *   prompts — so what is asserted for that path is the credential half:
 *   `Authorization` and every other auth-layer header arrive as `[REDACTED]`,
 *   and neither token value appears anywhere in the record's headers or url.
 *   With no logger configured there is nothing to leak into, and that is
 *   asserted too: zero records.
 * - **The embedding half of Property 53 is not reachable yet.** `/embeddings`
 *   belongs to `Copilot_Embedding_Adapter` (block 4, task 13), which does not
 *   exist in this package. Generation content stands in for it here; the input
 *   and vector clauses are covered when that adapter lands.
 * - **Transport errors are generated WITHOUT a token in their own message.** A
 *   `fetch` rejection is authored by the network stack, which never sees the
 *   request headers, and `credentialFailure` keeps a bounded `message` from a
 *   non-`ModelError` cause. Fabricating a network error that quotes the bearer
 *   token would test an adversary the design does not model; what is tested is
 *   that such a failure carries no body and no stack across.
 */

import {
  createCoreSpan,
  createTextMessage,
  type CaptureReceipt,
  type ModelInvocationContext,
  type ObservationEvent,
  type ObservationPort,
  type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'
import type { ProviderRequestLogRecord } from '@alvin0/ai-agent-sdk-provider-http'
import { describe, expect, it } from 'vitest'
import {
  COPILOT_BASE_URL,
  copilotAdapter,
  type CopilotEditorHeaders,
} from '../../packages/provider-copilot/src/adapter.ts'
import {
  COPILOT_LOGIN_COMMAND,
  memoryCopilotCredentialStore,
  type CopilotAuthFile,
} from '../../packages/provider-copilot/src/auth.ts'
import {
  createCopilotTokenCache,
  exchangeCopilotToken,
  type CopilotTokenCache,
} from '../../packages/provider-copilot/src/exchange.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Generated cases per property; the spec floor is 100. */
const RUNS = 120

/** mulberry32 — small, fast, reproducible from a 32-bit seed. */
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

function intBetween(rng: Rng, low: number, highInclusive: number): number {
  return low + intBelow(rng, highInclusive - low + 1)
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  const value = values[intBelow(rng, values.length)]
  if (value === undefined) throw new Error('empty choice list')
  return value
}

function bool(rng: Rng): boolean {
  return rng() < 0.5
}

/** Characters a real token draws from, plus the ones that break naive escaping. */
const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'

/**
 * A random credential value.
 *
 * Long enough that it cannot occur by accident in SDK-authored text, which is
 * what makes `not.toContain` a meaningful assertion rather than a coincidence.
 * @param rng - the seeded generator.
 * @param prefix - `ghu_` for a user token, `tid=` for an API token.
 * @returns the generated value.
 */
function randomToken(rng: Rng, prefix: string): string {
  const length = intBetween(rng, 24, 44)
  let value = prefix
  for (let index = 0; index < length; index += 1) {
    value += TOKEN_ALPHABET[intBelow(rng, TOKEN_ALPHABET.length)] ?? 'x'
  }
  return value
}

/** A prompt marker, distinct from anything the SDK writes. */
function randomPrompt(rng: Rng): string {
  return `prompt-${randomToken(rng, 'p')}`
}

// ---------------------------------------------------------------------------
// Wire doubles
// ---------------------------------------------------------------------------

/** The model this file drives; no `/responses` prefix, so it routes to chat. */
const MODEL = 'gpt-4o'

/** One observed request. */
interface Dispatch {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

/** The `fetch` double, split by surface so each script stays readable. */
interface FetchDouble {
  readonly impl: typeof globalThis.fetch
  /** Token-exchange dispatches, in order. */
  readonly exchanges: Dispatch[]
  /** Copilot API-surface dispatches, in order. */
  readonly api: Dispatch[]
}

type Script = (index: number) => Response | Promise<Response>

function fetchDouble(script: {
  readonly exchange?: Script
  readonly api?: Script
}): FetchDouble {
  const exchanges: Dispatch[] = []
  const api: Dispatch[] = []
  const impl = ((input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries())
    const record: Dispatch = { url, headers }
    if (url.includes('/copilot_internal/v2/token')) {
      const index = exchanges.length
      exchanges.push(record)
      if (script.exchange === undefined) throw new Error(`unscripted exchange: ${url}`)
      return Promise.resolve(script.exchange(index))
    }
    const index = api.length
    api.push(record)
    if (script.api === undefined) throw new Error(`unscripted API request: ${url}`)
    return Promise.resolve(script.api(index))
  }) as typeof globalThis.fetch
  return { impl, exchanges, api }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A well-formed exchange body: a token, and the expiry the SDK refuses to invent. */
function exchangeBody(apiToken: string, expiresAtSeconds: number): Record<string, unknown> {
  return { token: apiToken, expires_at: expiresAtSeconds, endpoints: { api: COPILOT_BASE_URL } }
}

function sseResponse(frames: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A minimal complete Chat Completions stream: one delta, then a terminal finish. */
function chatStream(text: string): Response {
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-redaction',
      object: 'chat.completion.chunk',
      created: 1_718_203_040,
      model: MODEL,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    })}`
  return sseResponse([
    chunk({ role: 'assistant', content: '' }, null),
    chunk({ content: text }, null),
    chunk({}, 'stop'),
    'data: [DONE]',
  ])
}

/**
 * Error-body shapes an endpoint plausibly returns, every one of them echoing the
 * credential back.
 *
 * The echo is the whole point of Property 50: a body that does not contain the
 * token cannot demonstrate that anything was redacted.
 * @param rng - the seeded generator.
 * @param secrets - the live token values to plant in the body.
 * @returns the raw body text.
 */
function echoingBody(rng: Rng, secrets: readonly string[]): string {
  const joined = secrets.join(' and ')
  switch (pick(rng, ['json', 'header-echo', 'html', 'text', 'nested', 'padded'] as const)) {
    case 'json':
      return JSON.stringify({ error: { message: `bad credentials: ${joined}` } })
    case 'header-echo':
      return JSON.stringify({
        message: 'request rejected',
        request: { headers: secrets.map(secret => ({ authorization: `Bearer ${secret}` })) },
      })
    case 'html':
      return `<html><body><pre>Authorization: Bearer ${joined}</pre></body></html>`
    case 'text':
      return `token ${joined} is not authorized for this endpoint`
    case 'nested':
      return JSON.stringify({ error: { details: secrets.map(secret => ({ token: secret })) } })
    default:
      // The token late in a long body, so a small byte bound can cut around it.
      return `${'padding '.repeat(200)}${joined}`
  }
}

// ---------------------------------------------------------------------------
// Adapter harness
// ---------------------------------------------------------------------------

const authFile = (token: string): CopilotAuthFile =>
  ({ version: 1, github: { token, scope: 'read:user' }, clientId: 'Iv1.property-test' })

interface AdapterInput {
  readonly githubToken?: string
  readonly file?: CopilotAuthFile | undefined
  readonly fetch: typeof globalThis.fetch
  readonly tokenCache?: CopilotTokenCache
  readonly editorHeaders?: CopilotEditorHeaders
  readonly requestLogger?: (record: ProviderRequestLogRecord) => Promise<void> | void
  readonly requestLoggerTimeoutMs?: number
  readonly maxErrorBodyBytes?: number
}

/** Build a Copilot adapter over one `fetch` double, discovering nothing. */
function adapterOver(input: AdapterInput): ReturnType<typeof copilotAdapter> {
  const file = input.file === undefined && input.githubToken !== undefined
    ? authFile(input.githubToken)
    : input.file
  return copilotAdapter({
    authStore: memoryCopilotCredentialStore(file),
    // A configured catalog, so no `/models` request competes with the script.
    models: [{ id: MODEL }],
    fetch: input.fetch,
    ...input.tokenCache === undefined ? {} : { tokenCache: input.tokenCache },
    ...input.editorHeaders === undefined ? {} : { editorHeaders: input.editorHeaders },
    ...input.requestLogger === undefined ? {} : { requestLogger: input.requestLogger },
    ...input.requestLoggerTimeoutMs === undefined
      ? {}
      : { requestLoggerTimeoutMs: input.requestLoggerTimeoutMs },
    ...input.maxErrorBodyBytes === undefined
      ? {}
      : { maxErrorBodyBytes: input.maxErrorBodyBytes },
  })
}

type Run =
  | { readonly ok: true; readonly chunks: StreamChunk[] }
  | { readonly ok: false; readonly error: unknown }

/** Drive one generation and capture whatever it produced, thrown or yielded. */
async function run(
  adapter: ReturnType<typeof copilotAdapter>,
  prompt: string,
  context?: ModelInvocationContext,
): Promise<Run> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream({
      provider: 'copilot',
      model: MODEL,
      messages: [createTextMessage(prompt)],
    }, context)) {
      chunks.push(chunk)
    }
    return { ok: true, chunks }
  } catch (error: unknown) {
    return { ok: false, error }
  }
}

// ---------------------------------------------------------------------------
// Deep serialization
// ---------------------------------------------------------------------------

/**
 * Every string reachable from a thrown value.
 *
 * Written as a full walk rather than a `JSON.stringify`, because the fields that
 * matter here are exactly the ones `JSON.stringify` drops: `message`, `stack` and
 * `cause` are non-enumerable on an `Error`, and the leak Property 50 guards
 * against lives in `cause.cause.message`.
 * @param value - the thrown value.
 * @returns every string found, deduplicated by traversal rather than by value.
 */
function collectStrings(value: unknown): string[] {
  const found: string[] = []
  const seen = new Set<unknown>()
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || node === undefined) return
    if (typeof node === 'string') {
      found.push(node)
      return
    }
    if (typeof node === 'number' || typeof node === 'boolean' || typeof node === 'bigint') {
      found.push(String(node))
      return
    }
    if (typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (node instanceof Error) {
      found.push(node.name, node.message, String(node.stack ?? ''), String(node))
    }
    // Own enumerable AND the well-known non-enumerable names, since an Error
    // hides the three fields this test cares about most.
    for (const key of ['message', 'stack', 'code', 'name', 'cause', 'status', 'detail']) {
      if (key in node) visit((node as Record<string, unknown>)[key], depth + 1)
    }
    for (const key of Object.keys(node)) {
      visit((node as Record<string, unknown>)[key], depth + 1)
    }
  }
  visit(value, 0)
  return found
}

/** Assert no secret appears anywhere in a serialized error. */
function expectNoLeak(value: unknown, secrets: readonly string[], trace: string): void {
  const blob = collectStrings(value).join('\u0000')
  for (const secret of secrets) {
    expect(blob.includes(secret), `${trace}: leaked ${secret.slice(0, 8)}…`).toBe(false)
  }
}

/** Assert a secret does appear, so a negative assertion cannot pass vacuously. */
function expectPlanted(body: string, secrets: readonly string[], trace: string): void {
  for (const secret of secrets) {
    expect(body.includes(secret), `${trace}: body must echo the token`).toBe(true)
  }
}

// ---------------------------------------------------------------------------
// Observation doubles
// ---------------------------------------------------------------------------

function accepted(event: ObservationEvent): CaptureReceipt {
  return { eventId: event.eventId, status: 'accepted', durable: false, boundary: 'none' }
}

interface Observed {
  readonly events: ObservationEvent[]
  /** What the transport told the attempt ledger, start and end payloads alike. */
  readonly attempts: unknown[]
  readonly context: ModelInvocationContext
}

/** A context that retains every trace record, so records can be SEARCHED. */
function observedContext(): Observed {
  const events: ObservationEvent[] = []
  const attempts: unknown[] = []
  const port: ObservationPort = {
    mode: 'operational',
    openSpan: createCoreSpan,
    capture(event) {
      events.push(event)
      return accepted(event)
    },
  }
  const context = {
    observation: port,
    declareProviderAttemptAccounting: () => undefined,
    startProviderAttempt: (input: unknown) => {
      attempts.push(input)
      return Promise.resolve({
        attemptId: `attempt-${String(attempts.length)}`,
        attemptNumber: attempts.length,
        traceparent: '00-0-0-01',
        end: (end: unknown) => {
          attempts.push(end)
          return {}
        },
      })
    },
  } as unknown as ModelInvocationContext
  return { events, attempts, context }
}

// ---------------------------------------------------------------------------
// Property 50
// ---------------------------------------------------------------------------

/** The statuses the exchange classification table covers, one per row worth testing. */
const EXCHANGE_STATUSES: readonly number[] = [400, 401, 403, 404, 418, 429, 500, 502, 503]

/** The statuses the Copilot API surface answers with when a request fails. */
const API_STATUSES: readonly number[] = [400, 401, 403, 404, 422, 429, 500, 503]

describe('Feature: github-copilot-provider, Property 50: Không token nào rò rỉ vào error', () => {
  it('keeps both token values out of every field of an exchange failure, including a body that echoes them', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      const github = randomToken(rng, 'ghu_')
      const status = pick(rng, EXCHANGE_STATUSES)
      const body = echoingBody(rng, [github])
      const trace = `seed ${String(seed)} status ${String(status)}`
      expectPlanted(body, [github], trace)

      const double = fetchDouble({
        exchange: () => new Response(body, {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      })
      const outcome = await run(
        adapterOver({ githubToken: github, fetch: double.impl }),
        randomPrompt(rng),
      )

      expect(outcome.ok, `${trace}: exchange must have failed`).toBe(false)
      if (outcome.ok) continue
      expectNoLeak(outcome.error, [github], trace)
      // The credential reached the wire — the leak surface was real, and the
      // absence above is redaction rather than an exchange that never ran.
      expect(double.exchanges[0]?.headers['authorization'], trace).toBe(`Bearer ${github}`)
      expect(double.api, `${trace}: no API request after a failed exchange`).toHaveLength(0)
    }
  })

  it('keeps both token values out of an API-surface failure whose body echoes them', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 1_000)
      const github = randomToken(rng, 'ghu_')
      const apiToken = randomToken(rng, 'tid=')
      const status = pick(rng, API_STATUSES)
      const body = echoingBody(rng, [github, apiToken])
      // Sometimes bound the read tightly, so truncation and redaction interact.
      const maxErrorBodyBytes = bool(rng) ? intBetween(rng, 64, 512) : undefined
      const trace = `seed ${String(seed)} status ${String(status)} bound `
        + `${String(maxErrorBodyBytes)}`
      expectPlanted(body, [github, apiToken], trace)

      const double = fetchDouble({
        exchange: () => jsonResponse(exchangeBody(apiToken, 1_900_000_000)),
        api: () => new Response(body, {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      })
      const outcome = await run(
        adapterOver({
          githubToken: github,
          fetch: double.impl,
          ...maxErrorBodyBytes === undefined ? {} : { maxErrorBodyBytes },
        }),
        randomPrompt(rng),
      )

      expect(outcome.ok, `${trace}: the API request must have failed`).toBe(false)
      if (outcome.ok) continue
      expectNoLeak(outcome.error, [github, apiToken], trace)
      expect(double.api, `${trace}: one dispatch`).toHaveLength(1)
      expect(double.api[0]?.headers['authorization'], trace).toBe(`Bearer ${apiToken}`)
    }
  })

  it('keeps the token out of a failure raised while the cache is holding it', async () => {
    // A `CopilotTokenCacheEntry` retains `sourceToken` by design (DD-11), so the
    // interesting moment is the SECOND exchange: an entry exists, it holds the
    // credential value, and the exchange that would replace it fails.
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 2_000)
      const github = randomToken(rng, 'ghu_')
      const firstApiToken = randomToken(rng, 'tid=')
      const status = pick(rng, EXCHANGE_STATUSES)
      const failureBody = echoingBody(rng, [github, firstApiToken])
      const trace = `seed ${String(seed)} status ${String(status)}`
      expectPlanted(failureBody, [github, firstApiToken], trace)

      const expiresAtSeconds = 1_800_000_000
      const marginMs = 60_000
      let now = expiresAtSeconds * 1_000 - 3_600_000
      const double = fetchDouble({
        exchange: index => index === 0
          ? jsonResponse(exchangeBody(firstApiToken, expiresAtSeconds))
          : new Response(failureBody, { status }),
        api: () => chatStream('answer'),
      })
      const cache = createCopilotTokenCache({
        fetch: double.impl,
        now: () => now,
        marginMs,
      })
      const adapter = adapterOver({ githubToken: github, fetch: double.impl, tokenCache: cache })

      const first = await run(adapter, randomPrompt(rng))
      expect(first.ok, `${trace}: first generation`).toBe(true)
      expect(double.exchanges, `${trace}: one exchange so far`).toHaveLength(1)

      // Past the refresh moment: the entry is still there, and it still holds
      // `sourceToken`, while the replacement exchange fails.
      now = expiresAtSeconds * 1_000 - marginMs
      const second = await run(adapter, randomPrompt(rng))
      expect(second.ok, `${trace}: second generation must fail`).toBe(false)
      if (second.ok) continue
      expect(double.exchanges, `${trace}: a second exchange was dispatched`).toHaveLength(2)
      expectNoLeak(second.error, [github, firstApiToken], trace)
    }
  })

  it('keeps the token out of a malformed-body failure, where the body itself becomes the cause', async () => {
    // Row 9 of the classification table is the one place the SDK deliberately
    // retains the WHOLE body as evidence — so it is the one place a token in the
    // body would travel furthest.
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 3_000)
      const github = randomToken(rng, 'ghu_')
      const shape = pick(rng, ['no-expiry', 'not-json', 'not-object', 'no-token'] as const)
      const trace = `seed ${String(seed)} shape ${shape}`
      const body = ((): string => {
        switch (shape) {
          case 'no-expiry':
            return JSON.stringify({ token: randomToken(rng, 'tid='), echoed: github })
          case 'not-json':
            return `not json at all, and here is the credential: ${github}`
          case 'not-object':
            return JSON.stringify([github])
          default:
            return JSON.stringify({ expires_at: 1_900_000_000, echoed: github })
        }
      })()
      expectPlanted(body, [github], trace)

      const double = fetchDouble({
        exchange: () => new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      })
      let failure: unknown
      try {
        await exchangeCopilotToken({ token: github }, { fetch: double.impl })
      } catch (error: unknown) {
        failure = error
      }
      expect(failure, `${trace}: malformed body must fail`).toBeDefined()
      expectNoLeak(failure, [github], trace)
    }
  })

  it('reports a missing credential with the login command and no credential value', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 4_000)
      const github = randomToken(rng, 'ghu_')
      const shape = pick(rng, ['empty-store', 'no-github', 'empty-token'] as const)
      const trace = `seed ${String(seed)} shape ${shape}`
      const file = ((): CopilotAuthFile | undefined => {
        switch (shape) {
          case 'empty-store': return undefined
          case 'no-github': return { version: 1 } as CopilotAuthFile
          default: return authFile('')
        }
      })()

      const double = fetchDouble({})
      const outcome = await run(
        adapterOver({ file, fetch: double.impl }),
        randomPrompt(rng),
      )
      expect(outcome.ok, `${trace}: must fail`).toBe(false)
      if (outcome.ok) continue
      expect(collectStrings(outcome.error).join('\n'), trace).toContain(COPILOT_LOGIN_COMMAND)
      // Nothing left the process: no exchange, no API request.
      expect(double.exchanges, trace).toHaveLength(0)
      expect(double.api, trace).toHaveLength(0)
      // And the token that was never stored cannot appear either way.
      expectNoLeak(outcome.error, [github], trace)
    }
  })

  it('keeps the token out of a transport failure raised before any response', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 5_000)
      const github = randomToken(rng, 'ghu_')
      const trace = `seed ${String(seed)}`
      const double = fetchDouble({
        exchange: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:443')),
      })
      const outcome = await run(
        adapterOver({ githubToken: github, fetch: double.impl }),
        randomPrompt(rng),
      )
      expect(outcome.ok, `${trace}: must fail`).toBe(false)
      if (outcome.ok) continue
      expectNoLeak(outcome.error, [github], trace)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 53
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 53: Không credential, không danh tính, không nội dung thô trong quan sát', () => {
  it('puts no prompt, credential or client identity into any trace record at the default configuration', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 6_000)
      const github = randomToken(rng, 'ghu_')
      const apiToken = randomToken(rng, 'tid=')
      const prompt = randomPrompt(rng)
      const answer = `answer-${randomToken(rng, 'a')}`
      const editorHeaders: CopilotEditorHeaders = {
        editorVersion: `vscode/${randomToken(rng, 'v')}`,
        editorPluginVersion: `copilot/${randomToken(rng, 'c')}`,
      }
      const failing = bool(rng)
      const trace = `seed ${String(seed)} failing ${String(failing)}`

      const double = fetchDouble({
        exchange: () => jsonResponse(exchangeBody(apiToken, 1_900_000_000)),
        api: () => failing
          ? new Response(echoingBody(rng, [github, apiToken]), { status: 500 })
          : chatStream(answer),
      })
      const observed = observedContext()
      const outcome = await run(
        // No `requestLogger`: this IS the default configuration.
        adapterOver({ githubToken: github, fetch: double.impl, editorHeaders }),
        prompt,
        observed.context,
      )
      expect(outcome.ok, trace).toBe(!failing)
      // The attempt ledger ran, so the records exist and are not vacuously clean.
      expect(observed.attempts.length, `${trace}: attempt records`).toBeGreaterThan(0)

      const recorded = [
        ...observed.events.map(event => collectStrings(event).join('\u0000')),
        ...observed.attempts.map(entry => collectStrings(entry).join('\u0000')),
      ].join('\u0000')
      for (const secret of [
        github,
        apiToken,
        prompt,
        editorHeaders.editorVersion ?? '',
        editorHeaders.editorPluginVersion ?? '',
        ...failing ? [] : [answer],
      ]) {
        if (secret.length === 0) continue
        expect(recorded.includes(secret), `${trace}: trace carried ${secret.slice(0, 10)}…`)
          .toBe(false)
      }
      // What the ledger DOES carry is the safe half: the origin, and nothing under it.
      expect(recorded.includes(new URL(COPILOT_BASE_URL).origin), trace).toBe(true)
    }
  })

  it('hands the explicit request logger a record whose every auth-layer header is redacted', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 7_000)
      const github = randomToken(rng, 'ghu_')
      const apiToken = randomToken(rng, 'tid=')
      const prompt = randomPrompt(rng)
      const editorHeaders: CopilotEditorHeaders = {
        editorVersion: `vscode/${randomToken(rng, 'v')}`,
        editorPluginVersion: `copilot/${randomToken(rng, 'c')}`,
      }
      const trace = `seed ${String(seed)}`

      const records: ProviderRequestLogRecord[] = []
      const double = fetchDouble({
        exchange: () => jsonResponse(exchangeBody(apiToken, 1_900_000_000)),
        api: () => chatStream('answer'),
      })
      const outcome = await run(
        adapterOver({
          githubToken: github,
          fetch: double.impl,
          editorHeaders,
          requestLogger: record => { records.push(record) },
        }),
        prompt,
      )
      expect(outcome.ok, trace).toBe(true)
      expect(records, `${trace}: one record per dispatch`).toHaveLength(1)
      const record = records[0]
      if (record === undefined) continue

      // Every header the auth layer produced arrives redacted, by provenance
      // rather than by spelling: `editor-version` and `x-request-id` do not look
      // like credentials, and they are redacted anyway.
      for (const name of ['authorization', 'editor-version', 'editor-plugin-version', 'x-request-id']) {
        expect(record.headers[name], `${trace}: ${name}`).toBe('[REDACTED]')
      }
      // The transport's own headers are not credentials and stay readable.
      expect(record.headers['content-type'], trace).toBe('application/json')

      const headerBlob = collectStrings(record.headers).join('\u0000')
      for (const secret of [
        github,
        apiToken,
        editorHeaders.editorVersion ?? '',
        editorHeaders.editorPluginVersion ?? '',
      ]) {
        expect(headerBlob.includes(secret), `${trace}: header carried ${secret.slice(0, 10)}…`)
          .toBe(false)
      }
      expect(record.url.startsWith(COPILOT_BASE_URL), trace).toBe(true)
      expect(collectStrings(record.url).join('').includes(apiToken), trace).toBe(false)
      // The wire body IS in the record: this logger is the deprecated
      // diagnostics bridge, its record type says so, and it only exists because
      // the caller asked for it. The default configuration above has no record
      // at all, which is where "no raw content in observation" is decided.
      expect(JSON.stringify(record.body).includes(prompt), trace).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 54
// ---------------------------------------------------------------------------

/** How a logger can misbehave, plus the well-behaved case for contrast. */
type LoggerBehaviour = 'returns' | 'returns-async' | 'throws' | 'rejects' | 'hangs'

const LOGGER_BEHAVIOURS: readonly LoggerBehaviour[] = [
  'returns', 'returns-async', 'throws', 'rejects', 'hangs',
]

describe('Feature: github-copilot-provider, Property 54: Request logger là best-effort', () => {
  it('dispatches the request whatever the logger does, and keeps the logger failure out of the result', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 8_000)
      const behaviour = pick(rng, LOGGER_BEHAVIOURS)
      const github = randomToken(rng, 'ghu_')
      const apiToken = randomToken(rng, 'tid=')
      const answer = `answer-${randomToken(rng, 'a')}`
      // A distinctive failure marker, so "the logger's error is not in the
      // result" is checked against a value that could only have come from it.
      const marker = `logger-failure-${randomToken(rng, 'l')}`
      const trace = `seed ${String(seed)} behaviour ${behaviour}`

      let called = 0
      const logger = (): Promise<void> | void => {
        called += 1
        switch (behaviour) {
          case 'returns': return undefined
          case 'returns-async': return Promise.resolve()
          case 'throws': throw new Error(marker)
          case 'rejects': return Promise.reject(new Error(marker))
          default: return new Promise<void>(() => undefined)
        }
      }

      const double = fetchDouble({
        exchange: () => jsonResponse(exchangeBody(apiToken, 1_900_000_000)),
        api: () => chatStream(answer),
      })
      const outcome = await run(
        adapterOver({
          githubToken: github,
          fetch: double.impl,
          requestLogger: logger,
          // Small enough that a hanging logger is overtaken quickly; the deadline
          // is what makes "hangs" survivable rather than fatal.
          requestLoggerTimeoutMs: 20,
        }),
        randomPrompt(rng),
      )

      expect(called, `${trace}: logger was consulted`).toBe(1)
      expect(outcome.ok, `${trace}: ${String(outcome.ok ? '' : outcome.error)}`).toBe(true)
      if (!outcome.ok) continue
      // The request went out, and the answer came back intact.
      expect(double.api, `${trace}: dispatched`).toHaveLength(1)
      const text = outcome.chunks
        .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
          chunk.type === 'text-delta')
        .map(chunk => chunk.text)
        .join('')
      expect(text, trace).toBe(answer)
      expect(outcome.chunks.some(chunk => chunk.type === 'finish'), `${trace}: finished`).toBe(true)
      // Nothing the logger produced reached the operation's result.
      expect(collectStrings(outcome.chunks).join('\u0000').includes(marker), trace).toBe(false)
    }
  })

  it('still dispatches when the logger aborts nothing but takes longer than the deadline on every call', async () => {
    // One example beside the property: two operations in a row, both with a
    // logger that never settles, both of which still reach the endpoint. A
    // deadline that leaked into the request signal would fail the second call.
    const github = randomToken(rngOf(99), 'ghu_')
    const apiToken = randomToken(rngOf(98), 'tid=')
    const double = fetchDouble({
      exchange: () => jsonResponse(exchangeBody(apiToken, 1_900_000_000)),
      api: () => chatStream('ok'),
    })
    const adapter = adapterOver({
      githubToken: github,
      fetch: double.impl,
      requestLogger: () => new Promise<void>(() => undefined),
      requestLoggerTimeoutMs: 10,
    })
    for (const attempt of [1, 2]) {
      const outcome = await run(adapter, `prompt ${String(attempt)}`)
      expect(outcome.ok, `attempt ${String(attempt)}`).toBe(true)
    }
    expect(double.api).toHaveLength(2)
    // One exchange for two operations: the credential path was untouched by the
    // logger's misbehaviour.
    expect(double.exchanges).toHaveLength(1)
  })
})
