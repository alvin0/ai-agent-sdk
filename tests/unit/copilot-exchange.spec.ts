/**
 * Property tests for `Copilot_Token_Exchange`.
 *
 * Feature: github-copilot-provider — Properties 5, 6, 7, 8 and 15.
 *
 * The exchange is the one place where the long-lived `GitHub_User_Token` is
 * spent, so four of the five properties here are about what it must NOT do: not
 * write to the store, not misread a hostname, not send a byte before the origin
 * pin agrees, and not read an unbounded body. The fifth — Property 6 — is the
 * classification table, which is the whole contract of the function: a caller
 * decides between "run the login command" and "wait and try again" from `code`
 * and `kind` alone.
 *
 * Inputs come from a SEEDED generator rather than `Math.random`, so a failure
 * reproduces from the printed seed instead of vanishing on rerun. The repository
 * carries no property-testing library, so the generators live here, following
 * `tests/unit/copilot-auth-store.spec.ts` and
 * `tests/unit/chat-completions-serialize.spec.ts`.
 *
 * ## Two readings of the design that this file settles
 *
 * - **The personal-access-token sentence belongs to row 6 (403), not to every
 *   `CREDENTIAL_REJECTED`.** Property 6 phrases it over credential rejection in
 *   general, but the design is explicit that "bước 6 là nơi thông điệp về
 *   personal access token sống", the table gives row 401 the login command
 *   alone, and Requirement 13.2 is scoped to "bị từ chối vì LOẠI credential".
 *   So: every `CREDENTIAL_REJECTED` carries the login command; only the 403 row
 *   also names the PAT and the OAuth-App allowlist.
 * - **HTTP 429 is `transient`.** The nine-step order reads "4xx còn lại ⇒
 *   permanent", but the classification table lists 429 on its own row as
 *   transient, and Property 6 says "đúng `kind` theo BẢNG phân loại". 429 is
 *   also the one 4xx whose cause a later attempt can clear. `src/exchange.ts`
 *   was changed to match the table.
 *
 * ## What Property 15 asserts at the bound
 *
 * A bound violation surfaces as the reader's own `RangeError`, not as a Copilot
 * code: the nine classification rows do not cover an oversized body, and
 * `transportFailure` passes a `RangeError` through deliberately so the message
 * names the limit that was exceeded rather than blaming the network. Property 15
 * demands refusal, body release and a respected deadline — all three of which
 * the `RangeError` path provides — so it is asserted as-is rather than wrapped.
 */

import { readFile } from 'node:fs/promises'
import { AgentSdkError } from '@alvin0/ai-agent-sdk-core'
import type { SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import { describe, expect, it } from 'vitest'
import {
  copilotFetch,
  copilotUrl,
  issuerOf,
  readCopilotResponseText,
  type CopilotOriginField,
} from '../../packages/provider-copilot/src/common/http.ts'
import {
  COPILOT_ERROR_CODES,
  COPILOT_LOGIN_COMMAND,
  COPILOT_TOKEN_EXCHANGE_PATH,
  CopilotTokenExchangeError,
  DEFAULT_GITHUB_API_BASE_URL,
  exchangeCopilotToken,
  memoryCopilotCredentialStore,
  type CopilotApiToken,
  type CopilotAuthFile,
  type CopilotExchangeOptions,
} from '../../packages/provider-copilot/src/index.ts'

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
// Shared doubles
// ---------------------------------------------------------------------------

const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined, debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined, fatal: () => undefined,
})

const operation = (): { signal: AbortSignal; logger: SdkLogger } =>
  ({ signal: new AbortController().signal, logger: NULL_LOGGER })

/** The long-lived credential. Its value must never appear in an error message. */
const GITHUB_TOKEN = 'ghu_propertyTestLongLivedUserToken'

const githubToken = (token = GITHUB_TOKEN): { readonly token: string; readonly scope: string } =>
  ({ token, scope: 'read:user' })

const authFile = (token = GITHUB_TOKEN): CopilotAuthFile =>
  ({ version: 1, github: { token, scope: 'read:user' }, clientId: 'Iv1.property-test' })

/** A `fetch` double that records every dispatch, so "zero requests" is observable. */
interface FetchSpy {
  readonly impl: typeof globalThis.fetch
  readonly calls: { url: string; headers: Record<string, string> }[]
}

function fetchSpy(respond: (url: string) => Response | Promise<Response>): FetchSpy {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const impl = ((input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {})
    calls.push({ url: String(input), headers: Object.fromEntries(headers.entries()) })
    return Promise.resolve(respond(String(input)))
  }) as typeof globalThis.fetch
  return { impl, calls }
}

/** A `fetch` double that must never be reached. */
function forbiddenFetch(): FetchSpy {
  return fetchSpy((url) => {
    throw new Error(`unexpected request to ${url}`)
  })
}

/** A well-formed success body, so a run that should succeed does. */
function tokenBody(rng: Rng): { body: Record<string, unknown>; expiresAt: number } {
  const expiresAt = intBetween(rng, 1_700_000_000, 1_900_000_000)
  const body: Record<string, unknown> = {
    token: `tid=seeded${String(intBelow(rng, 1_000_000))};exp=${String(expiresAt)}:signature`,
    expires_at: expiresAt,
    ...bool(rng) ? { refresh_in: intBetween(rng, 60, 1_800) } : {},
    ...bool(rng) ? { endpoints: { api: 'https://copilot-proxy.githubusercontent.com' } } : {},
  }
  return { body, expiresAt }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function errorOf(value: unknown, trace: string): AgentSdkError {
  expect(value, trace).toBeInstanceOf(AgentSdkError)
  return value as AgentSdkError
}

function exchangeErrorOf(value: unknown, trace: string): CopilotTokenExchangeError {
  expect(value, trace).toBeInstanceOf(CopilotTokenExchangeError)
  return value as CopilotTokenExchangeError
}

/** Run the exchange and hand back whatever it produced, thrown or returned. */
async function attempt(
  options: CopilotExchangeOptions,
  token = GITHUB_TOKEN,
): Promise<{ ok: true; token: CopilotApiToken } | { ok: false; error: unknown }> {
  try {
    return { ok: true, token: await exchangeCopilotToken(githubToken(token), options) }
  } catch (error: unknown) {
    return { ok: false, error }
  }
}

// ---------------------------------------------------------------------------
// Property 5
// ---------------------------------------------------------------------------

/** The keys `CopilotAuthFile` is allowed to carry. A fifth key is a leak. */
const ALLOWED_FILE_KEYS = ['version', 'github', 'account', 'clientId', 'obtainedAt'] as const

describe('Feature: github-copilot-provider, Property 5: Store chỉ mang token dài hạn và không đổi qua mọi lần đổi token', () => {
  it('leaves the store byte-identical and unversioned across any number of exchanges, and derives expiresAtMs from expires_at', async () => {
    const fixture = JSON.parse(await readFile(
      new URL('../../packages/provider-copilot/fixtures/exchange-ok.json', import.meta.url),
      'utf8',
    )) as Record<string, { token: string; expires_at: number; refresh_in?: number }>
    const variants = ['minimal', 'withRefreshIn', 'withDivergentEndpoint'] as const

    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      // The store is wrapped so a write is not merely invisible but counted: the
      // property is that the exchange has no write path at all, and a wrapper
      // that throws would let a caught write pass as "unchanged".
      const inner = memoryCopilotCredentialStore(authFile())
      let commits = 0
      const store = {
        ...inner,
        commit: (input: Parameters<typeof inner.commit>[0], context: Parameters<typeof inner.commit>[1]) => {
          commits += 1
          return inner.commit(input, context)
        },
      }

      const before = await store.read(operation())
      const snapshot = JSON.stringify(before)

      // A sequence, not a single call: "không đổi qua MỌI lần đổi token".
      const exchanges = 1 + intBelow(rng, 5)
      const issued: string[] = []
      for (let index = 0; index < exchanges; index += 1) {
        const useFixture = bool(rng)
        const variant = pick(rng, variants)
        const generated = tokenBody(rng)
        const body = useFixture ? fixture[variant] : generated.body
        if (body === undefined) throw new Error(`missing fixture variant ${variant}`)
        const expiresAt = useFixture
          ? (fixture[variant]?.expires_at ?? 0)
          : generated.expiresAt
        const spy = fetchSpy(() => jsonResponse(body))

        const api = await exchangeCopilotToken(githubToken(), {
          fetch: spy.impl,
          requestTimeoutMs: 5_000,
        })
        const at = `${trace} exchange ${String(index)} ${useFixture ? variant : 'generated'}`

        // The expiry is read from the endpoint, converted seconds → milliseconds,
        // and nothing else: an invented TTL is the inference this SDK refuses.
        expect(api.expiresAtMs, at).toBe(expiresAt * 1_000)
        expect(spy.calls, at).toHaveLength(1)
        expect(spy.calls[0]?.headers['authorization'], at).toBe(`Bearer ${GITHUB_TOKEN}`)
        issued.push(api.token)
      }

      // Same revision, same bytes, and no commit was even attempted.
      const after = await store.read(operation())
      expect(commits, `${trace}: commits during exchange`).toBe(0)
      expect(after?.revision, `${trace}: revision`).toBe(before?.revision)
      expect(JSON.stringify(after), `${trace}: stored bytes`).toBe(snapshot)
      expect(after?.value.github.token, trace).toBe(GITHUB_TOKEN)

      // No short-lived token reached the store, and the store grew no new field
      // to hold one in. Both halves matter: the second is what stops a future
      // change from persisting the api token under a name this loop never named.
      const stored = JSON.stringify(after)
      for (const [index, token] of issued.entries()) {
        expect(stored, `${trace}: api token ${String(index)} persisted`).not.toContain(token)
      }
      expect(Object.keys(after?.value ?? {}).sort())
        .toEqual(Object.keys(authFile()).sort())
      for (const key of Object.keys(after?.value ?? {})) {
        expect(ALLOWED_FILE_KEYS, `${trace}: unexpected stored key ${key}`).toContain(key)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------

/** One row of the design's classification table, as an expectation. */
interface Classification {
  readonly code: string
  readonly kind: 'permanent' | 'transient'
}

/**
 * The table from the design, re-derived here rather than imported.
 *
 * Written as an independent statement of the contract on purpose: reusing the
 * implementation's own branch order would make the test agree with whatever the
 * code does.
 */
function classify(status: number): Classification {
  if (status === 404) return { code: COPILOT_ERROR_CODES.TENANT_UNSUPPORTED, kind: 'permanent' }
  if (status === 401 || status === 403) {
    return { code: COPILOT_ERROR_CODES.CREDENTIAL_REJECTED, kind: 'permanent' }
  }
  if (status === 429 || status >= 500) {
    return { code: COPILOT_ERROR_CODES.TOKEN_EXCHANGE_FAILED, kind: 'transient' }
  }
  return { code: COPILOT_ERROR_CODES.TOKEN_EXCHANGE_FAILED, kind: 'permanent' }
}

/** Statuses worth naming, plus a random draw so the range is not just the table. */
function generateStatus(rng: Rng): number {
  return bool(rng)
    ? pick(rng, [400, 401, 402, 403, 404, 409, 418, 422, 429, 451, 500, 502, 503, 504, 599] as const)
    : intBetween(rng, 400, 599)
}

/** The shapes a failure before the response takes. All of them are transient. */
function generateTransportError(rng: Rng): unknown {
  switch (pick(rng, ['fetch-failed', 'reset', 'dns', 'timeout'] as const)) {
    case 'fetch-failed': return new TypeError('fetch failed')
    case 'reset': return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    case 'dns': return Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    default: return new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  }
}

/** An error body, sometimes echoing the credential back so redaction is exercised. */
function generateErrorBody(rng: Rng, status: number): string {
  switch (pick(rng, ['json', 'echo', 'html', 'empty'] as const)) {
    case 'json': return JSON.stringify({ message: `failed with ${String(status)}` })
    case 'echo': return JSON.stringify({ message: 'bad credentials', authorization: `Bearer ${GITHUB_TOKEN}` })
    case 'html': return '<html><body>error</body></html>'
    default: return ''
  }
}

describe('Feature: github-copilot-provider, Property 6: Bảng phân loại thất bại của `Copilot_Token_Exchange`', () => {
  it('gives every status and every transport failure the code and kind the design table names', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 1_000)
      const transport = rng() < 0.25

      if (transport) {
        const cause = generateTransportError(rng)
        const spy = fetchSpy(() => { throw cause })
        const trace = `seed ${String(seed)} transport`
        const outcome = await attempt({ fetch: spy.impl, requestTimeoutMs: 5_000 })

        expect(outcome.ok, trace).toBe(false)
        if (outcome.ok) continue
        const error = exchangeErrorOf(outcome.error, trace)
        expect(error.code, trace).toBe(COPILOT_ERROR_CODES.TOKEN_EXCHANGE_FAILED)
        expect(error.kind, trace).toBe('transient')
        expect(error.message, trace).not.toContain(GITHUB_TOKEN)
        continue
      }

      const status = generateStatus(rng)
      const body = generateErrorBody(rng, status)
      const spy = fetchSpy(() => new Response(body.length === 0 ? null : body, { status }))
      const trace = `seed ${String(seed)} status ${String(status)}`
      const outcome = await attempt({ fetch: spy.impl, requestTimeoutMs: 5_000 })

      expect(outcome.ok, trace).toBe(false)
      if (outcome.ok) continue
      const error = exchangeErrorOf(outcome.error, trace)
      const expected = classify(status)
      expect(error.code, trace).toBe(expected.code)
      expect(error.kind, trace).toBe(expected.kind)
      // The credential value never travels, not in the message and not in the
      // cause the endpoint's own body became.
      expect(error.message, trace).not.toContain(GITHUB_TOKEN)
      expect(JSON.stringify(error.cause ?? null), trace).not.toContain(GITHUB_TOKEN)

      if (expected.code === COPILOT_ERROR_CODES.CREDENTIAL_REJECTED) {
        // Every credential rejection ends in the same instruction.
        expect(error.message, trace).toContain(COPILOT_LOGIN_COMMAND)
      }
      if (status === 403) {
        // Row 6 is the one that cannot tell a PAT from a non-allowlisted OAuth
        // App, so it names both possibilities (Requirements 3.5, 13.2).
        expect(error.message.toLowerCase(), trace).toContain('personal access token')
        expect(error.message.toLowerCase(), trace).toContain('allowlist')
      }
      if (status === 404) {
        expect(error.code, trace).toBe(COPILOT_ERROR_CODES.TENANT_UNSUPPORTED)
      }
    }
  })

  it('reports an unreadable expires_at as TOKEN_MALFORMED and never invents a lifetime', async () => {
    const noExpires = await readFile(
      new URL('../../packages/provider-copilot/fixtures/exchange-no-expires.json', import.meta.url),
      'utf8',
    )

    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 2_000)
      const shape = pick(rng, [
        'fixture', 'not-json', 'not-object', 'array', 'no-token', 'empty-token',
        'string-expiry', 'zero-expiry', 'negative-expiry', 'nan-expiry', 'null-expiry',
      ] as const)
      const raw = ((): string => {
        switch (shape) {
          case 'fixture': return noExpires
          case 'not-json': return '{"token": "t", "expires_at":'
          case 'not-object': return '"a bare string"'
          case 'array': return '[{"token":"t","expires_at":1741006800}]'
          case 'no-token': return JSON.stringify({ expires_at: 1_741_006_800 })
          case 'empty-token': return JSON.stringify({ token: '', expires_at: 1_741_006_800 })
          case 'string-expiry': return JSON.stringify({ token: 't', expires_at: '1741006800' })
          case 'zero-expiry': return JSON.stringify({ token: 't', expires_at: 0 })
          case 'negative-expiry': return JSON.stringify({ token: 't', expires_at: -1 })
          case 'nan-expiry': return '{"token":"t","expires_at":null}'
          default: return JSON.stringify({ token: 't', expires_at: null })
        }
      })()
      const spy = fetchSpy(() => new Response(raw, { status: 200 }))
      const trace = `seed ${String(seed)} ${shape}`
      const outcome = await attempt({ fetch: spy.impl, requestTimeoutMs: 5_000 })

      expect(outcome.ok, trace).toBe(false)
      if (outcome.ok) continue
      const error = exchangeErrorOf(outcome.error, trace)
      expect(error.code, trace).toBe(COPILOT_ERROR_CODES.TOKEN_MALFORMED)
      expect(error.kind, trace).toBe('permanent')
    }
  })

  it('keeps the redirect refusal and the origin refusal out of the transient bucket', async () => {
    // Rows 2 and 3 already carry their own codes; a wrapper that renamed them
    // `TOKEN_EXCHANGE_FAILED` transient would turn a misconfiguration into a
    // retry loop.
    const redirect = fetchSpy(() =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/hop' } }))
    const outcome = await attempt({ fetch: redirect.impl, requestTimeoutMs: 5_000 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    const error = errorOf(outcome.error, 'redirect')
    expect(error.code).toBe(COPILOT_ERROR_CODES.REDIRECT_REJECTED)
    expect(error).not.toBeInstanceOf(CopilotTokenExchangeError)
    expect(redirect.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Property 7
// ---------------------------------------------------------------------------

/** A hostname, and whether it is inside the `ghe.com` data-residency namespace. */
interface HostCase {
  readonly host: string
  readonly tenant: boolean
}

/**
 * The named hosts, split by the only rule that matters: DOMAIN LABELS.
 *
 * `ghe.com.evil.tld` and `notghe.com` are the two that a `includes('ghe.com')`
 * test would misread, and the first is attacker-chosen — which is why they are
 * pinned as literals here rather than left to the generator.
 */
const TENANT_HOSTS: readonly string[] = [
  'ghe.com',
  'api.ghe.com',
  'octocorp.ghe.com',
  'api.octocorp.ghe.com',
  'GHE.COM',
  'API.OCTOCORP.GHE.COM',
  'ghe.com.',
  'api.ghe.com.',
]

const NON_TENANT_HOSTS: readonly string[] = [
  'api.github.com',
  'github.com',
  'ghe.com.evil.tld',
  'api.ghe.com.evil.tld',
  'notghe.com',
  'api.notghe.com',
  'ghe.community',
  'myghe.com',
  'ghe.co',
  'api.githubcopilot.com',
  'ghe-com.example',
  'xn--ghe.com.example',
]

function generateHostCase(rng: Rng): HostCase {
  if (bool(rng)) return { host: pick(rng, TENANT_HOSTS), tenant: true }
  if (rng() < 0.7) return { host: pick(rng, NON_TENANT_HOSTS), tenant: false }
  // A synthetic host built from labels, so the property covers more than the
  // two lists: a `ghe.com` suffix is a tenant, a `ghe.com` INFIX is not.
  const prefix = pick(rng, ['api', 'octo', 'x1', 'ghe', 'notghe'] as const)
  const suffix = pick(rng, ['ghe.com', 'ghe.com.evil.tld', 'notghe.com', 'example.com'] as const)
  const host = `${prefix}.${suffix}`
  return { host, tenant: host === 'ghe.com' || host.endsWith('.ghe.com') }
}

describe('Feature: github-copilot-provider, Property 7: Phát hiện tenant data-residency chính xác theo nhãn tên miền', () => {
  it('raises TENANT_UNSUPPORTED for a ghe.com label suffix and only then, dispatching nothing', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 3_000)
      const { host, tenant } = generateHostCase(rng)
      const base = `https://${host}${bool(rng) ? '' : '/'}`
      const expectedHost = new URL(base).hostname
      const trace = `seed ${String(seed)} host ${host} tenant ${String(tenant)}`

      const generated = tokenBody(rng)
      const spy = tenant
        ? forbiddenFetch()
        : fetchSpy(() => jsonResponse(generated.body))
      const outcome = await attempt({
        githubApiBaseUrl: base,
        fetch: spy.impl,
        requestTimeoutMs: 5_000,
      })

      if (tenant) {
        expect(outcome.ok, trace).toBe(false)
        if (outcome.ok) continue
        const error = exchangeErrorOf(outcome.error, trace)
        expect(error.code, trace).toBe(COPILOT_ERROR_CODES.TENANT_UNSUPPORTED)
        expect(error.kind, trace).toBe('permanent')
        // The detected domain is in the message: an operator has to be able to see
        // WHICH host was classified this way (Requirement 13.3).
        expect(error.message, trace).toContain(expectedHost)
        // Row 1 runs before any I/O, so the credential was never offered to the
        // tenant host at all.
        expect(spy.calls, `${trace}: requests dispatched`).toHaveLength(0)
        continue
      }

      expect(outcome.ok, `${trace}: ${String(outcome.ok ? '' : outcome.error)}`).toBe(true)
      if (!outcome.ok) continue
      expect(outcome.token.expiresAtMs, trace).toBe(generated.expiresAt * 1_000)
      expect(spy.calls, trace).toHaveLength(1)
      expect(spy.calls[0]?.url, trace).toBe(`https://${expectedHost}${COPILOT_TOKEN_EXCHANGE_PATH}`)
    }
  })

  it('gives a 404 from a supported host the same code, naming the host that answered', async () => {
    const notFound = await readFile(
      new URL('../../packages/provider-copilot/fixtures/exchange-404.json', import.meta.url),
      'utf8',
    )

    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 4_000)
      const host = pick(rng, NON_TENANT_HOSTS)
      const base = `https://${host}`
      const spy = fetchSpy(() => new Response(notFound, { status: 404 }))
      const trace = `seed ${String(seed)} host ${host}`

      const outcome = await attempt({ githubApiBaseUrl: base, fetch: spy.impl, requestTimeoutMs: 5_000 })
      expect(outcome.ok, trace).toBe(false)
      if (outcome.ok) continue
      const error = exchangeErrorOf(outcome.error, trace)
      // Requirement 3.6 has two doors into one code; this is the second.
      expect(error.code, trace).toBe(COPILOT_ERROR_CODES.TENANT_UNSUPPORTED)
      expect(error.kind, trace).toBe('permanent')
      expect(error.message, trace).toContain(host)
      expect(spy.calls, trace).toHaveLength(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 8
// ---------------------------------------------------------------------------

/** The three independently pinned origins, with the default each falls back to. */
const ORIGIN_FIELDS: readonly { field: CopilotOriginField; fallback: string }[] = [
  { field: 'oauthIssuer', fallback: 'https://github.com' },
  { field: 'githubApiBaseUrl', fallback: DEFAULT_GITHUB_API_BASE_URL },
  { field: 'baseUrl', fallback: 'https://api.githubcopilot.com' },
]

const ORIGINS: readonly string[] = [
  'https://github.com',
  'https://api.github.com',
  'https://api.githubcopilot.com',
  'https://evil.example',
  'https://api.github.com.evil.example',
  'https://api.github.com:8443',
  'https://localhost:3000',
]

describe('Feature: github-copilot-provider, Property 8: Origin được pin và kiểm trước khi phát request', () => {
  it('dispatches only when the target is on the pinned origin, and dispatches nothing when it is not', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 5_000)
      for (const { field, fallback } of ORIGIN_FIELDS) {
        const configured = bool(rng) ? pick(rng, ORIGINS) : fallback
        const target = bool(rng) ? configured : pick(rng, ORIGINS)
        const pinned = issuerOf(field, configured, fallback)
        const path = pick(rng, ['/login/device/code', COPILOT_TOKEN_EXCHANGE_PATH, '/models'] as const)
        const url = `${new URL(target).origin}${path}`
        const sameOrigin = new URL(url).origin === pinned.origin
        const trace = `seed ${String(seed)} ${field} pin ${pinned.origin} → ${url}`

        const spy = fetchSpy(() => new Response('{}', { status: 200 }))
        let thrown: unknown
        try {
          await copilotFetch({
            pinned,
            url,
            operation: 'token exchange',
            init: { method: 'GET', headers: { authorization: `Bearer ${GITHUB_TOKEN}` } },
          }, { fetch: spy.impl, requestTimeoutMs: 5_000 })
        } catch (error: unknown) {
          thrown = error
        }

        if (sameOrigin) {
          expect(thrown, trace).toBeUndefined()
          expect(spy.calls.map(call => call.url), trace).toEqual([url])
          continue
        }
        const error = errorOf(thrown, trace)
        expect(error.code, trace).toBe(COPILOT_ERROR_CODES.ENDPOINT_ORIGIN_INVALID)
        // Zero requests is the property: a post-hoc check would already have
        // handed the `Authorization` header to whatever origin the URL named.
        expect(spy.calls, `${trace}: requests dispatched`).toHaveLength(0)
        // The message names the option to fix and both origins, because "origin
        // invalid" about one of three settings leaves an operator guessing.
        expect(error.message, trace).toContain(field)
        expect(error.message, trace).toContain(pinned.origin)
      }
    }
  })

  it('refuses userinfo, cleartext without the opt-in, and an unparsable value — before any I/O', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 6_000)
      const shape = pick(rng, [
        'userinfo', 'password-only', 'http', 'http-allowed', 'unparsable', 'relative', 'https',
      ] as const)
      const base = ((): string => {
        switch (shape) {
          case 'userinfo': return 'https://attacker@api.github.com'
          case 'password-only': return 'https://:secret@api.github.com'
          case 'http': return 'http://127.0.0.1:8080'
          case 'http-allowed': return 'http://127.0.0.1:8080'
          case 'unparsable': return pick(rng, ['not a url', '://api.github.com', ''] as const)
          case 'relative': return '/copilot_internal/v2/token'
          default: return 'https://api.github.com'
        }
      })()
      const allowed = shape === 'http-allowed'
      const shouldReject = shape !== 'https' && !allowed
      const trace = `seed ${String(seed)} ${shape} base ${base}`

      const generated = tokenBody(rng)
      const spy = shouldReject ? forbiddenFetch() : fetchSpy(() => jsonResponse(generated.body))
      const outcome = await attempt({
        githubApiBaseUrl: base,
        fetch: spy.impl,
        requestTimeoutMs: 5_000,
        ...allowed ? { allowInsecureIssuer: true } : {},
      })

      if (shouldReject) {
        expect(outcome.ok, trace).toBe(false)
        if (outcome.ok) continue
        expect(errorOf(outcome.error, trace).code, trace)
          .toBe(COPILOT_ERROR_CODES.ENDPOINT_ORIGIN_INVALID)
        expect(spy.calls, `${trace}: requests dispatched`).toHaveLength(0)
        continue
      }
      expect(outcome.ok, `${trace}: ${String(outcome.ok ? '' : outcome.error)}`).toBe(true)
      expect(spy.calls, trace).toHaveLength(1)
    }
  })

  it('refuses a path that could move the request off the pin', () => {
    const pinned = issuerOf('githubApiBaseUrl', undefined, DEFAULT_GITHUB_API_BASE_URL)
    for (const path of ['//evil.example/x', 'copilot_internal/v2/token', 'https://evil.example/x', '']) {
      let thrown: unknown
      try {
        copilotUrl(pinned, path)
      } catch (error: unknown) {
        thrown = error
      }
      expect(errorOf(thrown, `path ${path}`).code)
        .toBe(COPILOT_ERROR_CODES.ENDPOINT_ORIGIN_INVALID)
    }
    expect(copilotUrl(pinned, COPILOT_TOKEN_EXCHANGE_PATH))
      .toBe(`${DEFAULT_GITHUB_API_BASE_URL}${COPILOT_TOKEN_EXCHANGE_PATH}`)
  })
})

// ---------------------------------------------------------------------------
// Property 15
// ---------------------------------------------------------------------------

/** A body whose release and consumption are both observable. */
interface TrackedStream {
  readonly stream: ReadableStream<Uint8Array>
  readonly cancelled: () => boolean
  readonly pulls: () => number
}

/**
 * A stream that delivers `chunks` and then either ends or stalls forever.
 *
 * Stalling is how the deadline half of the property is exercised: a server that
 * accepts the connection and then says nothing must not hang a CLI.
 */
function trackedStream(chunks: readonly Uint8Array[], stall = false): TrackedStream {
  let cancelled = false
  let pulls = 0
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      const chunk = chunks[index]
      index += 1
      if (chunk !== undefined) {
        controller.enqueue(chunk)
        return undefined
      }
      if (stall) return new Promise<void>(() => undefined)
      controller.close()
      return undefined
    },
    cancel() {
      cancelled = true
    },
  })
  return { stream, cancelled: () => cancelled, pulls: () => pulls }
}

const ENCODER = new TextEncoder()

/** Split `text` into `count` chunks at arbitrary byte boundaries. */
function fragment(text: string, count: number): Uint8Array[] {
  const bytes = ENCODER.encode(text)
  if (count <= 1 || bytes.byteLength === 0) return [bytes]
  const size = Math.max(1, Math.ceil(bytes.byteLength / count))
  const chunks: Uint8Array[] = []
  for (let at = 0; at < bytes.byteLength; at += size) {
    chunks.push(bytes.subarray(at, Math.min(at + size, bytes.byteLength)))
  }
  return chunks
}

describe('Feature: github-copilot-provider, Property 15: Mọi lần đọc response của Copilot đều bị chặn trên', () => {
  it('refuses a declared content-length over the limit before pulling a single chunk', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 7_000)
      const maxResponseBytes = intBetween(rng, 8, 512)
      const declared = maxResponseBytes + intBetween(rng, 1, 10_000)
      const body = trackedStream(fragment('x'.repeat(maxResponseBytes), 4))
      const response = new Response(body.stream, {
        status: pick(rng, [200, 403, 500] as const),
        headers: { 'content-length': String(declared) },
      })
      const trace = `seed ${String(seed)} declared ${String(declared)} limit ${String(maxResponseBytes)}`

      await expect(readCopilotResponseText(response, { maxResponseBytes }), trace)
        .rejects.toThrow(RangeError)
      // Released, and released WITHOUT being read: the point of checking the
      // declaration is to spend nothing on a body already known to be too large.
      expect(body.cancelled(), `${trace}: cancelled`).toBe(true)
      expect(body.pulls(), `${trace}: pulled`).toBe(0)
    }
  })

  it('refuses a body that exceeds the byte limit or the chunk limit, however it is fragmented', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 8_000)
      const maxResponseBytes = intBetween(rng, 16, 256)
      const maxResponseChunks = intBetween(rng, 2, 12)
      // Three regimes: over on bytes, over on chunks, and inside both.
      const regime = pick(rng, ['bytes', 'chunks', 'within'] as const)
      const size = regime === 'bytes'
        ? maxResponseBytes + intBetween(rng, 1, 4 * maxResponseBytes)
        : intBetween(rng, 1, maxResponseBytes)
      const pieces = regime === 'chunks'
        ? maxResponseChunks + intBetween(rng, 1, 6)
        : intBetween(rng, 1, maxResponseChunks)
      const text = 'a'.repeat(size)
      const chunks = fragment(text, pieces)
      const overBytes = size > maxResponseBytes
      const overChunks = chunks.length > maxResponseChunks
      // An oversized body keeps arriving after the bound trips, so the stalling
      // variant is the realistic one — and it is the only one where "released the
      // body" is observable at all: a stream that has already closed itself has
      // nothing left to cancel, and cancelling it would be a no-op either way.
      const body = trackedStream(chunks, overBytes || overChunks)
      // No `content-length`: the running totals are what has to catch this, which
      // is also what catches a body that lies about its length.
      const response = new Response(body.stream, { status: 200 })
      const trace = `seed ${String(seed)} ${regime} size ${String(size)}/${String(maxResponseBytes)} `
        + `chunks ${String(chunks.length)}/${String(maxResponseChunks)}`

      const outcome = await readCopilotResponseText(response, { maxResponseBytes, maxResponseChunks })
        .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))

      if (overBytes || overChunks) {
        expect(outcome.ok, trace).toBe(false)
        if (outcome.ok) continue
        expect(outcome.error, trace).toBeInstanceOf(RangeError)
        expect(body.cancelled(), `${trace}: cancelled`).toBe(true)
        continue
      }
      expect(outcome.ok, `${trace}: ${String(outcome.ok ? '' : outcome.error)}`).toBe(true)
      if (!outcome.ok) continue
      // Inside the bounds the reader is transparent: same text, whatever the
      // fragmentation was.
      expect(outcome.value, trace).toBe(text)
    }
  })

  it('rejects a configured bound that cannot bound anything', async () => {
    for (const maxResponseBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(readCopilotResponseText(new Response('ok'), { maxResponseBytes }))
        .rejects.toThrow(RangeError)
    }
    for (const maxResponseChunks of [0, -1, 2.5, Number.NaN]) {
      await expect(readCopilotResponseText(new Response('ok'), { maxResponseChunks }))
        .rejects.toThrow(RangeError)
    }
  })

  it('honours the per-request deadline while the body is still open', async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const rng = rngOf(seed + 9_000)
      const body = trackedStream(fragment('partial', intBetween(rng, 1, 3)), true)
      const response = new Response(body.stream, { status: 200 })
      const trace = `seed ${String(seed)}`

      // A stream that never ends: without the deadline this read never settles.
      await expect(
        readCopilotResponseText(response, { requestTimeoutMs: intBetween(rng, 5, 25) }),
        trace,
      ).rejects.toThrow()
    }
  })

  it('lets a caller signal win over an open body', async () => {
    const body = trackedStream(fragment('partial', 2), true)
    const controller = new AbortController()
    const pending = readCopilotResponseText(new Response(body.stream, { status: 200 }), {
      signal: controller.signal,
      requestTimeoutMs: 30_000,
    })
    controller.abort()
    await expect(pending).rejects.toThrow()
  })

  it('bounds the exchange read too: an oversized success body fails as a RangeError, and an oversized error body does not hide the status', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 10_000)
      const maxResponseBytes = intBetween(rng, 16, 128)
      const oversized = JSON.stringify({
        token: 't'.repeat(maxResponseBytes * 2),
        expires_at: 1_741_006_800,
      })
      const status = pick(rng, [200, 401, 403, 404, 429, 500] as const)
      const spy = fetchSpy(() => new Response(oversized, { status }))
      const trace = `seed ${String(seed)} status ${String(status)} limit ${String(maxResponseBytes)}`

      const outcome = await attempt({ fetch: spy.impl, requestTimeoutMs: 5_000, maxResponseBytes })
      expect(outcome.ok, trace).toBe(false)
      if (outcome.ok) continue

      if (status === 200) {
        // The nine classification rows do not cover an oversized body, and
        // `transportFailure` passes a `RangeError` through on purpose: the message
        // names the limit that was exceeded rather than blaming the network.
        expect(outcome.error, trace).toBeInstanceOf(RangeError)
        expect((outcome.error as RangeError).message, trace).toMatch(/limit/iu)
        continue
      }
      // On the failure path the status has already decided the classification, so
      // a body that could not be read must not turn a precise 403 into a read
      // error. The bound still holds — the body simply does not reach `cause`.
      const error = exchangeErrorOf(outcome.error, trace)
      expect(error.code, trace).toBe(classify(status).code)
      expect(error.kind, trace).toBe(classify(status).kind)
      expect(error.cause, trace).toBeUndefined()
    }
  })
})
