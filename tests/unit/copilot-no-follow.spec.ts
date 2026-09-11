/**
 * Property tests for the Copilot redirect guard.
 *
 * Feature: github-copilot-provider — Property 9.
 *
 * `redirect: 'manual'` alone does not implement a no-follow policy: it only makes
 * the hop visible. The guard is what turns every shape that hop can take into a
 * structured failure, at every one of the seven Copilot call sites, before a
 * second request can leave with the credential headers attached.
 *
 * Inputs come from a SEEDED generator rather than `Math.random`, so a failure
 * reproduces from the printed seed instead of vanishing on rerun. The repository
 * carries no property-testing library, so the generators live here.
 */

import { describe, expect, it } from 'vitest'
import { AgentSdkError } from '@alvin0/ai-agent-sdk-core'
import { COPILOT_ERROR_CODES } from '../../packages/provider-copilot/src/common/error-codes.ts'
import {
  copilotFetch,
  copilotUrl,
  issuerOf,
  type CopilotOrigin,
  type CopilotOriginField,
} from '../../packages/provider-copilot/src/common/http.ts'
import {
  rejectCopilotRedirect,
  type CopilotHttpOperation,
} from '../../packages/provider-copilot/src/common/no-follow.ts'

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

// ---------------------------------------------------------------------------
// The seven call sites
// ---------------------------------------------------------------------------

/** One Copilot HTTP call site: the option its origin is pinned from, and its path. */
interface Endpoint {
  readonly operation: CopilotHttpOperation
  readonly field: CopilotOriginField
  readonly base: string
  readonly path: string
}

/**
 * All seven endpoints named by {@link CopilotHttpOperation}.
 *
 * Listed in full, and cross-checked below against the union itself, because the
 * property is "every endpoint" — a table that silently drifts one entry short
 * would still pass every assertion it makes (Requirements 3.8, 7.8).
 */
const ENDPOINTS: readonly Endpoint[] = [
  { operation: 'device code', field: 'oauthIssuer', base: 'https://github.com', path: '/login/device/code' },
  { operation: 'device token', field: 'oauthIssuer', base: 'https://github.com', path: '/login/oauth/access_token' },
  {
    operation: 'token exchange',
    field: 'githubApiBaseUrl',
    base: 'https://api.github.com',
    path: '/copilot_internal/v2/token',
  },
  { operation: 'model catalog', field: 'baseUrl', base: 'https://api.githubcopilot.com', path: '/models' },
  { operation: 'responses', field: 'baseUrl', base: 'https://api.githubcopilot.com', path: '/responses' },
  { operation: 'chat completions', field: 'baseUrl', base: 'https://api.githubcopilot.com', path: '/chat/completions' },
  { operation: 'embeddings', field: 'baseUrl', base: 'https://api.githubcopilot.com', path: '/embeddings' },
]

const pinOf = (endpoint: Endpoint): CopilotOrigin =>
  issuerOf(endpoint.field, endpoint.base, endpoint.base)

const urlOf = (endpoint: Endpoint): string => copilotUrl(pinOf(endpoint), endpoint.path)

// ---------------------------------------------------------------------------
// Response doubles
// ---------------------------------------------------------------------------

/** A body whose release is observable, since releasing it is half the property. */
interface TrackedBody {
  readonly stream: ReadableStream<Uint8Array>
  readonly cancelled: () => boolean
  readonly bytesPulled: () => number
}

function trackedBody(): TrackedBody {
  let cancelled = false
  let bytesPulled = 0
  const chunk = new TextEncoder().encode('{"redirect":"do not follow"}')
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      bytesPulled += chunk.byteLength
      controller.enqueue(chunk)
    },
    cancel() {
      cancelled = true
    },
  })
  return { stream, cancelled: () => cancelled, bytesPulled: () => bytesPulled }
}

/** The four shapes a redirect wears, plus the shape that is not one. */
type Shape = 'status-3xx' | 'opaqueredirect' | 'redirected-flag' | 'url-changed' | 'not-a-redirect'

const REDIRECT_SHAPES: readonly Shape[] = [
  'status-3xx',
  'opaqueredirect',
  'redirected-flag',
  'url-changed',
]

/**
 * Build the response a `redirect: 'manual'` fetch would hand back for one shape.
 *
 * A literal rather than a real `Response`: `type`, `redirected` and `url` are all
 * read-only on the platform class, and those three fields ARE the property. The
 * body is a real `ReadableStream` so its cancellation is real too.
 */
function responseOf(
  shape: Shape,
  requestedUrl: string,
  rng: Rng,
  body: TrackedBody | null,
): Response {
  const base = {
    body: body === null ? null : body.stream,
    headers: new Headers({ location: 'https://evil.example/hop' }),
    ok: false,
    statusText: '',
    type: 'default',
    redirected: false,
    status: 200,
    url: requestedUrl,
  }
  const shaped = (() => {
    switch (shape) {
      case 'status-3xx':
        // The ordinary case: 301/302/303/307/308, and the unassigned edges of the range.
        return { status: pick(rng, [300, 301, 302, 303, 304, 307, 308, 399] as const) }
      case 'opaqueredirect':
        // What a browser substitutes for the 3xx: status flattened, URL stripped.
        return { type: 'opaqueredirect', status: 0, url: '' }
      case 'redirected-flag':
        // A hop already followed by a runtime that ignored `redirect: 'manual'`.
        return { redirected: true, status: pick(rng, [200, 201, 400, 500] as const) }
      case 'url-changed':
        // Neither flag set, but the response came from somewhere else.
        return { status: 200, url: `${requestedUrl}${pick(rng, ['/hop', '?next=1', '#x'] as const)}` }
      default:
        return { status: pick(rng, [200, 201, 400, 401, 404, 429, 500] as const) }
    }
  })()
  return { ...base, ...shaped } as unknown as Response
}

// ---------------------------------------------------------------------------
// Assertions shared by both halves
// ---------------------------------------------------------------------------

function expectRejection(thrown: unknown, operation: CopilotHttpOperation, trace: string): void {
  expect(thrown, trace).toBeInstanceOf(AgentSdkError)
  const error = thrown as AgentSdkError
  expect(error.code, trace).toBe(COPILOT_ERROR_CODES.REDIRECT_REJECTED)
  // The message has to name the call site; "redirect rejected" with no endpoint
  // leaves an operator guessing which of seven surfaces has a proxy in front of it.
  expect(error.message, trace).toContain(operation)
}

const TEARDOWN_MS = 1_000

// ---------------------------------------------------------------------------
// Property 9
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 9: Redirect bị từ chối ở mọi endpoint, trước hop thứ hai', () => {
  it('names every endpoint the operation union enumerates, so the table cannot drift', () => {
    // A compile-time exhaustiveness check paired with a runtime count: the record
    // below fails to typecheck if the union grows, and the length pins the table.
    const covered: Record<CopilotHttpOperation, true> = {
      'device code': true,
      'device token': true,
      'token exchange': true,
      'model catalog': true,
      responses: true,
      'chat completions': true,
      embeddings: true,
    }
    expect(ENDPOINTS.map(endpoint => endpoint.operation).sort()).toEqual(Object.keys(covered).sort())
    expect(ENDPOINTS).toHaveLength(7)
  })

  it('rejects every redirect shape at every endpoint, releasing the body first', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      // Every endpoint on every run: the property is universal over the set, so
      // sampling one per seed would leave six untested at any given shape.
      for (const endpoint of ENDPOINTS) {
        const shape = pick(rng, REDIRECT_SHAPES)
        const url = urlOf(endpoint)
        // `opaqueredirect` legitimately carries no body; both cases must reject.
        const withBody = shape === 'opaqueredirect' ? bool(rng) : true
        const body = withBody ? trackedBody() : null
        const response = responseOf(shape, url, rng, body)
        const trace = `seed ${String(seed)} ${endpoint.operation} ${shape}`

        let thrown: unknown
        try {
          await rejectCopilotRedirect(response, url, endpoint.operation, TEARDOWN_MS)
        } catch (error: unknown) {
          thrown = error
        }

        expectRejection(thrown, endpoint.operation, trace)
        if (body !== null) {
          // Released, not merely abandoned: an uncancelled body holds the socket
          // open for as long as the runtime keeps the stream alive.
          expect(body.cancelled(), `${trace} cancelled`).toBe(true)
          // And released without being drained — the guard reads no payload from a
          // response it is refusing.
          expect(body.bytesPulled(), `${trace} drained`).toBe(0)
        }
      }
    }
  })

  it('passes a plain response through untouched, at every endpoint', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 1_000)
      for (const endpoint of ENDPOINTS) {
        const url = urlOf(endpoint)
        const body = trackedBody()
        const response = responseOf('not-a-redirect', url, rng, body)
        const trace = `seed ${String(seed)} ${endpoint.operation} status ${String(response.status)}`

        await expect(
          rejectCopilotRedirect(response, url, endpoint.operation, TEARDOWN_MS),
          trace,
        ).resolves.toBeUndefined()
        // The guard is not an error handler for 4xx/5xx: those responses belong to
        // the caller, body intact.
        expect(body.cancelled(), `${trace} cancelled`).toBe(false)
      }
    }
  })

  it('dispatches exactly one request per endpoint and never a second hop', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 2_000)
      for (const endpoint of ENDPOINTS) {
        const shape = pick(rng, REDIRECT_SHAPES)
        const url = urlOf(endpoint)
        const body = trackedBody()
        const targets: string[] = []
        const redirects: (RequestInit['redirect'])[] = []
        const fetchImpl = ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          targets.push(String(input))
          redirects.push(init?.redirect)
          return Promise.resolve(responseOf(shape, url, rng, body))
        }) as typeof globalThis.fetch
        const trace = `seed ${String(seed)} ${endpoint.operation} ${shape}`

        let thrown: unknown
        try {
          await copilotFetch({
            pinned: pinOf(endpoint),
            url,
            operation: endpoint.operation,
            init: { method: 'POST', headers: { authorization: 'Bearer secret' } },
          }, { fetch: fetchImpl, requestTimeoutMs: 5_000 })
        } catch (error: unknown) {
          thrown = error
        }

        expectRejection(thrown, endpoint.operation, trace)
        // One request, to the requested URL, and nothing to the redirect target —
        // a followed hop would re-send that `Authorization` header.
        expect(targets, `${trace} dispatched`).toEqual([url])
        expect(redirects, `${trace} manual`).toEqual(['manual'])
        expect(body.cancelled(), `${trace} cancelled`).toBe(true)
      }
    }
  })
})
