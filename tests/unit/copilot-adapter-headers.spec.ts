/**
 * Property tests for the Copilot adapter's origin pinning, mandatory headers,
 * client identity, missing-editor-header diagnosis, per-operation header
 * resolution, and option plumbing.
 *
 * Feature: github-copilot-provider — Properties 1, 2, 3, 4, 23 and 26.
 *
 * **Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.6, 7.2, 7.6, 7.7, 8.7, 11.2**
 *
 * Everything here is asserted on the request the adapter ACTUALLY DISPATCHES,
 * through an injected `fetch`, rather than on the object `auth.resolve` returns.
 * That distinction is the whole point of Property 2: `content-type` cannot come
 * from the auth layer at all — `provider-http`'s `mergeHeaderLayers` marks that
 * name transport-owned and raises `HEADER_COLLISION` for a second owner — so the
 * adapter sends it through `baseHeaders`. The three mandatory headers therefore
 * only ever appear TOGETHER on the wire, and the wire is where they are checked.
 *
 * Four further readings of the design that this file settles:
 *
 * - **Property 1's origin set is read per SURFACE, not per process.** The Copilot
 *   surface (`/models`, `/responses`, `/chat/completions`) is pinned to
 *   `origin(baseUrl)`; the token exchange has its own pin, `githubApiBaseUrl`, and
 *   is a different origin by design. So the assertion is: every dispatch belongs
 *   to one of the two configured origins, and every Copilot-surface dispatch
 *   belongs to `origin(baseUrl)`. A third origin appearing anywhere fails.
 * - **The embedding surface is not part of this adapter yet.** Property 2 names
 *   `/embeddings`, and its dispatch lives with the embedding blocks
 *   (`copilot-embedding-request.spec.ts`); `copilotAdapter` exposes generation and
 *   catalog. Covered here: both generation endpoints and the catalog.
 * - **Property 23 counts STORE READS.** `auth.resolve` is not observable from
 *   outside, but it reads the credential store exactly once, so a counting store
 *   is a faithful proxy — and it counts the thing the requirement is about
 *   (per-operation credential resolution) rather than a call count of a closure.
 * - **Property 26 reads the connection snapshot.** `connect()` is `protected` on
 *   `HttpModelAdapter` and is where every forwarded option lands; it is invoked
 *   through a narrow structural cast, because the alternative — inferring the
 *   bounds from behaviour — cannot distinguish "not configured" from "configured
 *   to `undefined`", which is exactly what the property is about.
 *
 * Inputs come from a SEEDED mulberry32 generator rather than `Math.random`, so a
 * failure reproduces from the printed seed. The repository carries no
 * property-testing library, so the generators live here, following
 * `tests/unit/copilot-router.spec.ts` and `tests/unit/copilot-token-cache.spec.ts`.
 */

import {
  createTextMessage,
  MODEL_ERROR_CODES,
  ModelError,
  withRetry,
  type ModelInvocationContext,
  type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'
import {
  DEFAULT_MAX_ERROR_BODY_BYTES,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_RESPONSE_CHUNKS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  type HttpConnection,
  type HttpModelAdapter,
} from '@alvin0/ai-agent-sdk-provider-http'
import { describe, expect, it } from 'vitest'
import {
  COPILOT_BASE_URL,
  COPILOT_EDITOR_PLUGIN_VERSION,
  COPILOT_EDITOR_VERSION,
  COPILOT_ERROR_CODES,
  COPILOT_ROUTE_ID,
  copilotAdapter,
  copilotCatalogCacheOptions,
  DEFAULT_GITHUB_API_BASE_URL,
  memoryCopilotAuthStore,
  memoryCopilotCredentialStore,
  type CopilotAuthFile,
  type CopilotCredentialStore,
  type CopilotEditorHeaders,
  type CopilotProviderOptions,
} from '../../packages/provider-copilot/src/index.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Number of generated cases per property; the spec floor is 100. */
const RUNS = 100

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

// ---------------------------------------------------------------------------
// The credential, and a store that counts its reads
// ---------------------------------------------------------------------------

/** The long-lived credential. Nothing in this file needs its value on the wire. */
const GITHUB_TOKEN = 'ghu_headerPropertyTestLongLivedUserToken'

const authFile = (): CopilotAuthFile => ({
  version: 1,
  github: { token: GITHUB_TOKEN, scope: 'read:user' },
  clientId: 'Iv1.header-property-test',
})

/** A credential store that records how many times it was read. */
interface CountingStore {
  readonly store: CopilotCredentialStore
  readonly reads: () => number
}

function countingStore(): CountingStore {
  const inner = memoryCopilotCredentialStore(authFile())
  let reads = 0
  const store = {
    ...inner,
    read: (options: Parameters<CopilotCredentialStore['read']>[0]) => {
      reads += 1
      return inner.read(options)
    },
  } as CopilotCredentialStore
  return { store, reads: () => reads }
}

// ---------------------------------------------------------------------------
// The endpoint doubles
// ---------------------------------------------------------------------------

/** Both generation endpoints, keyed by the model id that routes to each. */
const RESPONSES_MODEL = 'codex-mini-latest'
const CHAT_MODEL = 'gpt-4o-copilot'

/** SSE frames of a complete `/responses` generation. */
const RESPONSES_FRAMES: readonly string[] = [
  'data: {"type":"response.created","response":{"id":"r1"}}',
  'data: {"type":"response.output_item.added","item":{"id":"i1","type":"message"}}',
  'data: {"type":"response.output_text.delta","item_id":"i1","delta":"ok"}',
  'data: {"type":"response.output_item.done","item":{"id":"i1","type":"message",'
  + '"content":[{"type":"output_text","text":"ok"}]}}',
  'data: {"type":"response.completed","response":{"id":"r1","usage":'
  + '{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
]

/** SSE frames of a complete `/chat/completions` generation. */
const CHAT_FRAMES: readonly string[] = [
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,'
  + '"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,'
  + '"delta":{},"finish_reason":"stop"}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[],"usage":'
  + '{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
  'data: [DONE]',
]

/** The catalog body `/models` answers, covering both capability partitions. */
const CATALOG_BODY = {
  data: [
    { id: CHAT_MODEL, name: 'GPT-4o (Copilot)', capabilities: { type: 'chat' } },
    { id: RESPONSES_MODEL, name: 'Codex mini', capabilities: { type: 'chat' } },
    { id: 'copilot-text-embedding-3-small', capabilities: { type: 'embeddings' } },
  ],
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** One dispatched request, reduced to what these properties assert on. */
interface Dispatch {
  readonly url: string
  readonly origin: string
  readonly path: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
}

/** Which Copilot surface a path belongs to; `exchange` is the GitHub API one. */
type Surface = 'exchange' | 'catalog' | 'responses' | 'chat'

function surfaceOf(path: string): Surface | undefined {
  if (path.endsWith('/copilot_internal/v2/token')) return 'exchange'
  if (path.endsWith('/models')) return 'catalog'
  if (path.endsWith('/responses')) return 'responses'
  if (path.endsWith('/chat/completions')) return 'chat'
  return undefined
}

/**
 * A `fetch` double standing in for the whole Copilot deployment.
 *
 * `generation` is the one scripted hook: it receives the surface and a 0-based
 * attempt index and may substitute a response, which is how a 400 or a retryable
 * 500 is placed on a specific attempt without teaching the double about either.
 */
interface Deployment {
  readonly impl: typeof globalThis.fetch
  readonly dispatches: readonly Dispatch[]
  readonly of: (surface: Surface) => readonly Dispatch[]
}

function deployment(
  generation?: (surface: 'responses' | 'chat', attempt: number) => Response | undefined,
): Deployment {
  const dispatches: Dispatch[] = []
  const attempts = { responses: 0, chat: 0 }
  const impl = ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers ?? {})
    dispatches.push({
      url: url.href,
      origin: url.origin,
      path: url.pathname,
      method: init?.method ?? 'GET',
      headers: Object.freeze(Object.fromEntries(headers.entries())),
    })
    const surface = surfaceOf(url.pathname)
    if (surface === 'exchange') {
      return Promise.resolve(jsonResponse({
        token: 'tid=headerprop;exp=1;sig=deadbeef',
        expires_at: Math.floor(Date.now() / 1_000) + 1_500,
      }))
    }
    if (surface === 'catalog') return Promise.resolve(jsonResponse(CATALOG_BODY))
    if (surface === undefined) return Promise.resolve(jsonResponse({ error: 'unknown path' }, 404))
    const attempt = attempts[surface]
    attempts[surface] += 1
    const scripted = generation?.(surface, attempt)
    if (scripted !== undefined) return Promise.resolve(scripted)
    return Promise.resolve(sseResponse(surface === 'responses' ? RESPONSES_FRAMES : CHAT_FRAMES))
  }) as typeof globalThis.fetch
  return {
    impl,
    dispatches,
    of: (surface) => dispatches.filter(entry => surfaceOf(entry.path) === surface),
  }
}

// ---------------------------------------------------------------------------
// Driving the adapter
// ---------------------------------------------------------------------------

const generateOptions = (model: string) => ({
  provider: COPILOT_ROUTE_ID,
  model,
  messages: [createTextMessage('xin chào')],
})

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Run one generation, returning whatever it produced — chunks or a failure. */
async function generate(
  adapter: HttpModelAdapter,
  model: string,
): Promise<{ readonly ok: true; readonly chunks: readonly StreamChunk[] }
  | { readonly ok: false; readonly error: unknown }> {
  try {
    return { ok: true, chunks: await drain(adapter.stream(generateOptions(model))) }
  } catch (error: unknown) {
    return { ok: false, error }
  }
}

/**
 * The connection snapshot for one route.
 *
 * `connect` is `protected`; see the module note for why this file reaches it
 * rather than inferring the bounds from behaviour.
 */
type ConnectableAdapter = {
  connect(
    provider: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<HttpConnection>
}

function connectionOf(adapter: HttpModelAdapter): Promise<HttpConnection> {
  return (adapter as unknown as ConnectableAdapter).connect(COPILOT_ROUTE_ID)
}

/** The three names Requirement 2.3 makes mandatory, plus the transport pair. */
function expectMandatoryHeaders(dispatch: Dispatch, trace: string): void {
  expect(dispatch.headers['authorization'], `${trace} authorization`)
    .toMatch(/^Bearer \S+$/)
  expect(dispatch.headers['editor-version'], `${trace} editor-version`)
    .toBeTypeOf('string')
  expect(dispatch.headers['editor-plugin-version'], `${trace} editor-plugin-version`)
    .toBeTypeOf('string')
  expect(dispatch.headers['content-type'], `${trace} content-type`)
    .toBe('application/json')
}

// ---------------------------------------------------------------------------
// Smoke: the harness reaches every surface the properties below assert on
// ---------------------------------------------------------------------------

describe('Copilot adapter request surfaces', () => {
  it('exchanges once, discovers the catalog once, and routes each model to its endpoint', async () => {
    const deployed = deployment()
    const counted = countingStore()
    const adapter = copilotAdapter({ authStore: counted.store, fetch: deployed.impl })

    const chat = await generate(adapter, CHAT_MODEL)
    const responses = await generate(adapter, RESPONSES_MODEL)

    expect(chat.ok, chat.ok ? '' : String(chat.error)).toBe(true)
    expect(responses.ok, responses.ok ? '' : String(responses.error)).toBe(true)
    expect(deployed.of('exchange')).toHaveLength(1)
    expect(deployed.of('catalog')).toHaveLength(1)
    expect(deployed.of('chat')).toHaveLength(1)
    expect(deployed.of('responses')).toHaveLength(1)
    expect(counted.reads()).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------

/** HTTPS bases the adapter must stay inside, including one carrying a path. */
const HTTPS_BASES: readonly string[] = [
  COPILOT_BASE_URL,
  'https://api.githubcopilot.com',
  'https://copilot-proxy.enterprise.example',
  'https://copilot.enterprise.example:8443',
  'https://copilot.enterprise.example/api/v1',
]

/** GitHub API bases the token exchange must stay inside. */
const GITHUB_API_BASES: readonly string[] = [
  DEFAULT_GITHUB_API_BASE_URL,
  'https://api.github.enterprise.example',
  'https://github.enterprise.example:8443',
]

describe('Feature: github-copilot-provider, Property 1: Mọi request nằm trên origin đã cấu hình, cleartext HTTP cần bật tường minh', () => {
  it('keeps every Copilot request on the configured origin across generation and catalog calls', async () => {
    // Both endpoints and the catalog have to be exercised in the same run, since
    // the property is about the SET of origins a sequence of calls produces.
    const surfaces = new Set<Surface>()
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x01_00_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const baseUrl = pick(rng, HTTPS_BASES)
      const githubApiBaseUrl = pick(rng, GITHUB_API_BASES)
      const deployed = deployment()
      const adapter = copilotAdapter({
        authStore: memoryCopilotCredentialStore(authFile()),
        baseUrl,
        githubApiBaseUrl,
        fetch: deployed.impl,
      })

      // A chain of calls, in a generated order, so the origin set is the set of a
      // whole session rather than of one request.
      const models = bool(rng) ? [CHAT_MODEL, RESPONSES_MODEL] : [RESPONSES_MODEL, CHAT_MODEL]
      for (const model of models) {
        const outcome = await generate(adapter, model)
        expect(outcome.ok, `${trace} ${model} ${outcome.ok ? '' : String(outcome.error)}`).toBe(true)
      }
      await adapter.listModels(COPILOT_ROUTE_ID)

      const copilotOrigin = new URL(baseUrl).origin
      const exchangeOrigin = new URL(githubApiBaseUrl).origin
      expect(new Set(deployed.dispatches.map(entry => entry.origin)), trace)
        .toEqual(new Set([copilotOrigin, exchangeOrigin]))
      for (const entry of deployed.dispatches) {
        const surface = surfaceOf(entry.path)
        expect(surface, `${trace} ${entry.path}`).toBeDefined()
        if (surface === undefined) continue
        surfaces.add(surface)
        // The exchange has its own pin; every other surface belongs to `baseUrl`.
        expect(entry.origin, `${trace} ${surface}`)
          .toBe(surface === 'exchange' ? exchangeOrigin : copilotOrigin)
      }
    }
    expect(surfaces).toEqual(new Set<Surface>(['exchange', 'catalog', 'responses', 'chat']))
  })

  it('refuses a cleartext base URL until the opt-in is set, and dispatches nothing while refusing', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x01_10_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const host = pick(rng, ['localhost', '127.0.0.1', 'copilot.internal.example'] as const)
      const port = pick(rng, ['', ':8080', ':3000'] as const)
      const baseUrl = `http://${host}${port}`
      const model = bool(rng) ? CHAT_MODEL : RESPONSES_MODEL

      const refused = deployment()
      const strict = copilotAdapter({
        authStore: memoryCopilotCredentialStore(authFile()),
        baseUrl,
        fetch: refused.impl,
      })
      const outcome = await generate(strict, model)
      expect(outcome.ok, trace).toBe(false)
      expect((outcome.ok ? undefined : outcome.error) as ModelError, trace)
        .toBeInstanceOf(ModelError)
      expect((outcome.ok ? '' : (outcome.error as ModelError).message), trace)
        .toMatch(/https/i)
      // NOT ZERO REQUESTS, and the difference is worth stating precisely: the
      // token exchange runs first, on its own HTTPS pin (`githubApiBaseUrl`), and
      // it is refusing to reach the CLEARTEXT origin that the property is about.
      // So the assertion is that nothing was ever sent in the clear — the count
      // of dispatches to `origin(baseUrl)` is zero — rather than that no request
      // happened at all.
      expect(
        refused.dispatches.filter(entry => entry.origin === new URL(baseUrl).origin),
        trace,
      ).toEqual([])
      for (const entry of refused.dispatches) {
        expect(new URL(entry.url).protocol, `${trace} ${entry.path}`).toBe('https:')
      }

      // The same configuration, explicitly opted in, works.
      const allowed = deployment()
      const lenient = copilotAdapter({
        authStore: memoryCopilotCredentialStore(authFile()),
        baseUrl,
        allowInsecureHttp: true,
        fetch: allowed.impl,
      })
      const permitted = await generate(lenient, model)
      expect(permitted.ok, `${trace} ${permitted.ok ? '' : String(permitted.error)}`).toBe(true)
      expect(allowed.dispatches.length, trace).toBeGreaterThan(0)
      for (const entry of allowed.dispatches) {
        if (surfaceOf(entry.path) === 'exchange') continue
        expect(entry.origin, trace).toBe(new URL(baseUrl).origin)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Property 2
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 2: Ba header bắt buộc trên mọi request tới bề mặt Copilot', () => {
  it('carries authorization, both editor headers and content-type on every Copilot request', async () => {
    const covered = new Set<Surface>()
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x02_00_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const editorHeaders: CopilotEditorHeaders = {
        ...(bool(rng) ? { editorVersion: `neovim/0.${String(intBelow(rng, 20))}.0` } : {}),
        ...(bool(rng) ? { editorPluginVersion: `house-plugin/${String(intBelow(rng, 9))}.1` } : {}),
      }
      const deployed = deployment()
      const adapter = copilotAdapter({
        authStore: bool(rng)
          ? memoryCopilotCredentialStore(authFile())
          : memoryCopilotAuthStore(authFile()),
        ...(Object.keys(editorHeaders).length === 0 ? {} : { editorHeaders }),
        fetch: deployed.impl,
      } as CopilotProviderOptions)

      for (const model of [CHAT_MODEL, RESPONSES_MODEL]) {
        const outcome = await generate(adapter, model)
        expect(outcome.ok, `${trace} ${model} ${outcome.ok ? '' : String(outcome.error)}`).toBe(true)
      }

      const copilotSurfaces: readonly Surface[] = ['catalog', 'responses', 'chat']
      for (const surface of copilotSurfaces) {
        const requests = deployed.of(surface)
        expect(requests.length, `${trace} ${surface} dispatched`).toBeGreaterThan(0)
        for (const request of requests) {
          expectMandatoryHeaders(request, `${trace} ${surface}`)
          covered.add(surface)
        }
      }
      // The exchange is a different surface with a different pin, but the editor
      // identity travels there too — the endpoint rejects it without them.
      for (const request of deployed.of('exchange')) {
        expect(request.headers['authorization'], trace).toMatch(/^Bearer \S+$/)
        expect(request.headers['editor-version'], trace).toBeTypeOf('string')
        expect(request.headers['editor-plugin-version'], trace).toBeTypeOf('string')
        covered.add('exchange')
      }
    }
    expect(covered).toEqual(new Set<Surface>(['exchange', 'catalog', 'responses', 'chat']))
  })
})

// ---------------------------------------------------------------------------
// Property 3
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 3: Precedence của `Client_Identity_Constants`', () => {
  it('sends the override when set and the exported constant when not, per header', async () => {
    // All four subsets have to occur, or the property would be passing on a
    // generator that never exercises the one-overridden case — the case where a
    // per-object resolution would drop the other header entirely.
    const subsets = new Set<string>()
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x03_00_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const withVersion = bool(rng)
      const withPluginVersion = bool(rng)
      const editorVersion = `emacs/${String(intBetween(rng, 1, 30))}.2`
      const editorPluginVersion = `copilot.el/${String(intBetween(rng, 1, 9))}.0`
      const editorHeaders: CopilotEditorHeaders = {
        ...(withVersion ? { editorVersion } : {}),
        ...(withPluginVersion ? { editorPluginVersion } : {}),
      }
      subsets.add(`${String(withVersion)}:${String(withPluginVersion)}`)

      const deployed = deployment()
      const adapter = copilotAdapter({
        authStore: memoryCopilotCredentialStore(authFile()),
        ...(Object.keys(editorHeaders).length === 0 ? {} : { editorHeaders }),
        fetch: deployed.impl,
      })
      const model = bool(rng) ? CHAT_MODEL : RESPONSES_MODEL
      const outcome = await generate(adapter, model)
      expect(outcome.ok, `${trace} ${outcome.ok ? '' : String(outcome.error)}`).toBe(true)

      const expected = {
        'editor-version': withVersion ? editorVersion : COPILOT_EDITOR_VERSION,
        'editor-plugin-version': withPluginVersion
          ? editorPluginVersion
          : COPILOT_EDITOR_PLUGIN_VERSION,
      }
      // Every surface, including the token exchange: one identity, resolved once,
      // and the same on both origins.
      expect(deployed.dispatches.length, trace).toBeGreaterThan(0)
      for (const request of deployed.dispatches) {
        expect(request.headers['editor-version'], `${trace} ${request.path}`)
          .toBe(expected['editor-version'])
        expect(request.headers['editor-plugin-version'], `${trace} ${request.path}`)
          .toBe(expected['editor-plugin-version'])
      }
    }
    expect(subsets).toEqual(new Set(['false:false', 'false:true', 'true:false', 'true:true']))
  })
})

// ---------------------------------------------------------------------------
// Property 4
// ---------------------------------------------------------------------------

/** 400 bodies that carry the missing-editor-header signature, in several spellings. */
const EDITOR_HEADER_SIGNATURES: readonly string[] = [
  'missing required header Editor-Version',
  'Editor-Plugin-Version is required',
  'editor_version header not recognized',
  'editor plugin version must be supplied',
  'the editor header is absent',
  'unsupported editor: header rejected',
]

/** 400 bodies that say nothing about editors and must keep the generic code. */
const PLAIN_BAD_REQUESTS: readonly string[] = [
  'the request body is not valid JSON',
  'tool schema is not a valid JSON schema',
  'temperature must be between 0 and 2',
  'unknown field: reasoning_effort',
]

describe('Feature: github-copilot-provider, Property 4: HTTP 400 thiếu editor header cho chẩn đoán nêu tên cả hai header', () => {
  it('names both headers and the option for a signature 400, and leaves any other 400 generic', async () => {
    // Both halves of the property are generated, so both have to occur: a run of
    // only signature bodies would never test that a plain 400 keeps its code.
    const halves = new Set<'signature' | 'plain'>()
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x04_00_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const signature = bool(rng)
      const endpointText = signature
        ? pick(rng, EDITOR_HEADER_SIGNATURES)
        : pick(rng, PLAIN_BAD_REQUESTS)
      const code = pick(rng, ['invalid_request', 'bad_request', 'client_error'] as const)
      const model = bool(rng) ? CHAT_MODEL : RESPONSES_MODEL

      const deployed = deployment(() => jsonResponse({
        error: { message: endpointText, code },
      }, 400))
      const adapter = copilotAdapter({
        authStore: memoryCopilotCredentialStore(authFile()),
        fetch: deployed.impl,
      })
      const outcome = await generate(adapter, model)

      halves.add(signature ? 'signature' : 'plain')
      expect(outcome.ok, trace).toBe(false)
      if (outcome.ok) continue
      const error = outcome.error
      expect(error, trace).toBeInstanceOf(ModelError)
      const failure = error as ModelError
      if (signature) {
        expect(failure.code, `${trace} ${endpointText}`)
          .toBe(COPILOT_ERROR_CODES.EDITOR_HEADERS_MISSING)
        // Both names, whatever the endpoint chose to mention, plus the option that
        // fixes it — a diagnosis naming one header sends the reader to one fix.
        expect(failure.message, trace).toContain('Editor-Version')
        expect(failure.message, trace).toContain('Editor-Plugin-Version')
        expect(failure.message, trace).toContain('editorHeaders')
        // The endpoint's own words are kept as evidence, not replaced.
        expect(failure.message, trace).toContain(endpointText)
      } else {
        // A 400 that says nothing about editors keeps the shared classification;
        // relabelling it would send the reader to a configuration that is fine.
        expect(failure.code, `${trace} ${endpointText}`).toBe(MODEL_ERROR_CODES.INVALID_REQUEST)
        expect(failure.message, trace).not.toContain('editorHeaders')
        expect(failure.message, trace).not.toContain('Editor-Plugin-Version')
      }
    }
    expect(halves).toEqual(new Set(['signature', 'plain']))
  })
})

// ---------------------------------------------------------------------------
// Property 23
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 23: Header được giải quyết một lần cho mỗi operation', () => {
  it('resolves the credential once per operation, not once per provider attempt', async () => {
    // A run where no attempt ever failed would satisfy the assertion trivially,
    // so both shapes are required to occur across the generated cases.
    const shapes = new Set<'retried' | 'first-try'>()
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x17_00_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const operations = intBetween(rng, 1, 3)
      // Retries per operation, generated independently: the property is that the
      // resolve count tracks operations even when the attempt counts differ.
      const retries = Array.from({ length: operations }, () => intBelow(rng, 3))
      let failuresLeft = 0
      const deployed = deployment(() => {
        if (failuresLeft <= 0) return undefined
        failuresLeft -= 1
        // A retryable status, so the attempt count of one operation can exceed 1
        // while the operation itself still succeeds.
        return jsonResponse({ error: { message: 'upstream is busy' } }, 503)
      })
      const counted = countingStore()
      const adapter = copilotAdapter({ authStore: counted.store, fetch: deployed.impl })
      const retrying = withRetry(adapter, {
        policy: {
          mode: 'normal',
          maxRetries: 3,
          backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
        },
        random: () => 0,
      })

      for (const [index, count] of retries.entries()) {
        failuresLeft = count
        const model = bool(rng) ? CHAT_MODEL : RESPONSES_MODEL
        const prepared = await retrying.prepareCall(COPILOT_ROUTE_ID, model)
        const chunks = await drain(prepared.stream(generateOptions(model)))
        expect(chunks.at(-1)?.type, `${trace} operation ${String(index)}`).toBe('finish')
      }

      const attempts = deployed.of('responses').length + deployed.of('chat').length
      const expectedAttempts = retries.reduce((total, count) => total + count + 1, 0)
      // The two numbers differ whenever a retry happened, which is the whole
      // content of the property — one is per operation, the other per attempt.
      expect(attempts, `${trace} attempts`).toBe(expectedAttempts)
      expect(counted.reads(), `${trace} resolves`).toBe(operations)
      // And the exchange is not re-run per attempt either: the cached token is
      // what every attempt of every operation carries.
      expect(deployed.of('exchange').length, `${trace} exchanges`).toBe(1)
      shapes.add(attempts > operations ? 'retried' : 'first-try')
    }
    expect(shapes).toEqual(new Set(['retried', 'first-try']))
  })
})

// ---------------------------------------------------------------------------
// Property 26
// ---------------------------------------------------------------------------

/** Options that land on the connection with a runtime default when unset. */
const DEFAULTED_LIMITS = {
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  maxResponseChunks: DEFAULT_MAX_RESPONSE_CHUNKS,
  maxErrorBodyBytes: DEFAULT_MAX_ERROR_BODY_BYTES,
  defaultMaxTokens: 8_192,
  defaultContextWindow: 128_000,
} as const

/** Options that must be ABSENT from the connection when unset, never `undefined`. */
const PASSTHROUGH_LIMITS = [
  'maxSseEvents',
  'maxSseEventChars',
  'requestLoggerTimeoutMs',
  'allowInsecureHttp',
] as const

/** The three catalog cache options, which never reach the connection snapshot. */
const CACHE_OPTIONS = ['catalogTtlMs', 'catalogStaleTtlMs', 'catalogFailureBackoffMs'] as const

describe('Feature: github-copilot-provider, Property 26: Option đi tới đích, option vắng mặt không ghi đè default', () => {
  it('forwards every option that was set and leaves no key carrying undefined for one that was not', async () => {
    // Each option has to be seen both set and unset across the cases, or half of
    // the property would never be exercised for that option.
    const set = new Set<string>()
    const unset = new Set<string>()
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x1a_00_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      // A generated subset, with values far from every default so a value that
      // silently fell back is visible rather than coincidentally equal.
      const chosen: Record<string, number> = {}
      for (const key of Object.keys(DEFAULTED_LIMITS)) {
        if (!bool(rng)) continue
        chosen[key] = key.endsWith('Ms')
          ? intBetween(rng, 60_000, 600_000)
          : intBetween(rng, 4_096, 1_048_576)
      }
      for (const key of ['maxSseEvents', 'maxSseEventChars', 'requestLoggerTimeoutMs']) {
        if (bool(rng)) chosen[key] = intBetween(rng, 1_000, 90_000)
      }
      const cache: Record<string, number> = {}
      for (const key of CACHE_OPTIONS) {
        if (bool(rng)) cache[key] = intBetween(rng, 1_000, 600_000)
      }
      const maxRetries = bool(rng) ? intBelow(rng, 4) : undefined

      const deployed = deployment()
      const adapter = copilotAdapter({
        authStore: memoryCopilotCredentialStore(authFile()),
        fetch: deployed.impl,
        ...chosen,
        ...cache,
        ...(maxRetries === undefined
          ? {}
          : { retryPolicy: { mode: 'normal' as const, maxRetries } }),
      } as CopilotProviderOptions)
      const connection = await connectionOf(adapter)

      for (const [key, fallback] of Object.entries(DEFAULTED_LIMITS)) {
        const record = connection as unknown as Record<string, unknown>
        const wanted = chosen[key] ?? fallback
        expect(record[key], `${trace} ${key}`).toBe(wanted)
      }
      for (const key of PASSTHROUGH_LIMITS) {
        const record = connection as unknown as Record<string, unknown>
        // An absent option must not appear at all: a key holding `undefined`
        // still overrides the runtime's own default downstream.
        expect(Object.hasOwn(connection, key), `${trace} ${key} present`)
          .toBe(Object.hasOwn(chosen, key))
        if (Object.hasOwn(chosen, key)) expect(record[key], `${trace} ${key}`).toBe(chosen[key])
      }
      // Nothing anywhere on the snapshot carries `undefined`.
      for (const [key, value] of Object.entries(connection)) {
        expect(value, `${trace} ${key} undefined`).not.toBeUndefined()
      }
      // The retry policy this route owns, resolved once and reported identically
      // by the snapshot and by the adapter's own accessor.
      expect(connection.retryPolicy.mode, trace).toBe('normal')
      if (maxRetries !== undefined && connection.retryPolicy.mode === 'normal') {
        expect(connection.retryPolicy.maxRetries, trace).toBe(maxRetries)
      }
      expect(adapter.providerRetryPolicy(COPILOT_ROUTE_ID), trace).toEqual(connection.retryPolicy)

      // The catalog cache options take the other route — straight to the runtime's
      // caching layer — so they are asserted where they are observable: exactly
      // the keys the caller set, and not one key more.
      expect(Object.keys(copilotCatalogCacheOptions(cache)).sort(), `${trace} cache`)
        .toEqual(Object.keys(cache).sort())

      for (const key of [...Object.keys(DEFAULTED_LIMITS), ...PASSTHROUGH_LIMITS, ...CACHE_OPTIONS]) {
        const provided = Object.hasOwn(chosen, key) || Object.hasOwn(cache, key)
        ;(provided ? set : unset).add(key)
      }
    }
    const everyOption = [...Object.keys(DEFAULTED_LIMITS), ...CACHE_OPTIONS, 'maxSseEvents',
      'maxSseEventChars', 'requestLoggerTimeoutMs']
    for (const key of everyOption) {
      expect(set, `${key} never set`).toContain(key)
      expect(unset, `${key} never unset`).toContain(key)
    }
    // `allowInsecureHttp` is covered by Property 1 rather than generated here; it
    // changes what the transport permits, not a numeric bound.
    expect(unset).toContain('allowInsecureHttp')
  })
})
