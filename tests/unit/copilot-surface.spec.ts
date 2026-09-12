/**
 * Structural surface of `provider-copilot`.
 *
 * Feature: github-copilot-provider — Requirements 2.1, 3.1, 5.1, 6.2, 6.4, 7.1,
 * 7.4, 7.5, 11.1, 11.5, 13.1.
 *
 * Everything pinned here is a claim about SHAPE rather than about behaviour, and
 * most of it is a claim about ABSENCE — no subclassing, no second credential
 * model, no vendor-CLI credential read. A claim about absence has no reachable
 * code path, so no behavioural test can find its violation and a reviewer reading
 * one diff cannot see what the next diff will add. The source scans below are the
 * enforcement; weakening one silently retires the requirement it stands for.
 *
 * Three of the checks are ordinary assertions instead:
 *
 *  - `COPILOT_BASE_URL` is asserted both as a literal AND as the origin a real
 *    request lands on with no `baseUrl` configured, because a constant nothing
 *    reads is not a default (Requirement 2.1).
 *  - The two in-memory store factories are exercised for their markers, since the
 *    marker is what `captureCopilotStore` dispatches on (Requirements 6.2, 6.4).
 *  - `COPILOT_ERROR_CODES` is snapshotted key-by-key: the values are routed on by
 *    consumers and travel through log lines, so each one is a published string
 *    (Requirement 13.1).
 *
 * Property 25 is generated from a seeded `mulberry32`, following
 * `tests/unit/copilot-router.spec.ts`; this repository carries no
 * property-testing dependency.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTextMessage, type StreamChunk } from '@alvin0/ai-agent-sdk-core'
import {
  CREDENTIAL_CAPABILITY_API_VERSION,
  type ModelTarget,
  type SdkLogger,
} from '@alvin0/ai-agent-sdk-core/provider'
import {
  COPILOT_BASE_URL,
  COPILOT_DISPLAY_NAME,
  COPILOT_ROUTE_ID,
  copilotAdapter,
  copilotPlugin,
} from '../../packages/provider-copilot/src/adapter.ts'
import {
  memoryCopilotAuthStore,
  memoryCopilotCredentialStore,
} from '../../packages/provider-copilot/src/auth.ts'
import {
  COPILOT_BASE_URL as LEAF_COPILOT_BASE_URL,
  COPILOT_EDITOR_PLUGIN_VERSION,
  COPILOT_EDITOR_VERSION,
} from '../../packages/provider-copilot/src/common/identity.ts'
import { COPILOT_ERROR_CODES } from '../../packages/provider-copilot/src/common/error-codes.ts'
import type {
  CopilotAuthFile,
  CopilotGitHubToken,
} from '../../packages/provider-copilot/src/common/store-types.ts'
import type { CopilotApiToken } from '../../packages/provider-copilot/src/exchange.ts'
import {
  COPILOT_OAUTH_CLIENT_ID,
  DEFAULT_COPILOT_OAUTH_ISSUER,
} from '../../packages/provider-copilot/src/oauth.ts'

// ---------------------------------------------------------------------------
// Source access
// ---------------------------------------------------------------------------

const PACKAGE_DIR = fileURLToPath(new URL('../../packages/provider-copilot/', import.meta.url))
const SRC_DIR = join(PACKAGE_DIR, 'src')
const AUTH_NODE_SRC = fileURLToPath(new URL('../../packages/auth-node/src/', import.meta.url))

/** Every file under `src/`, recursively, as `src/`-relative paths. */
function sourceFiles(): readonly string[] {
  const found: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const absolute = join(dir, entry)
      const relative = prefix === '' ? entry : `${prefix}/${entry}`
      if (statSync(absolute).isDirectory()) walk(absolute, relative)
      else found.push(relative)
    }
  }
  walk(SRC_DIR, '')
  return found
}

/** Never-aborting sink, for the one store read this file performs directly. */
const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
})

function source(relative: string): string {
  return readFileSync(join(SRC_DIR, relative), 'utf8')
}

/**
 * The same text with comments removed.
 *
 * Every absence check below has to run against code rather than prose, because
 * these modules DOCUMENT what they deliberately omit — `store-types.ts` explains
 * at length that there is no refresh token — and a naive grep would read the
 * explanation as the violation.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Every line of code, comments removed, tagged with its 1-based line number. */
function codeLines(relative: string): readonly { readonly line: number; readonly text: string }[] {
  return stripComments(source(relative))
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(entry => entry.text.trim().length > 0)
}

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Generated cases per property; the spec floor is 100. */
const RUNS = 160

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

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)] as T
}

function intBetween(rng: () => number, low: number, high: number): number {
  return low + Math.floor(rng() * (high - low + 1))
}

// ---------------------------------------------------------------------------
// Requirement 7.1 — configured, not subclassed
// ---------------------------------------------------------------------------

describe('provider-copilot subclasses no adapter (Requirement 7.1)', () => {
  it('reads a non-empty source tree, so the scans cannot pass vacuously', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(0)
    // A superset check rather than equality: later blocks of this feature add
    // modules, and a new module must be SCANNED, not required to be absent.
    expect(files).toEqual(expect.arrayContaining([
      'adapter.ts',
      'auth.ts',
      'catalog.ts',
      'common/error-codes.ts',
      'common/http.ts',
      'common/identity.ts',
      'common/no-follow.ts',
      'common/store-capture.ts',
      'common/store-types.ts',
      'dual-protocol.ts',
      'errors.ts',
      'exchange.ts',
      'index.ts',
      'oauth.ts',
      'router.ts',
    ]))
  })

  it('contains no `extends HttpModelAdapter`, in any file', () => {
    const offences: string[] = []
    for (const file of sourceFiles()) {
      for (const { line, text } of codeLines(file)) {
        if (/extends\s+(?:Http\w*Adapter|Http\w*Provider|\w*ModelAdapter|\w*BaseAdapter)\b/.test(text)) {
          offences.push(`src/${file}:${String(line)}: ${text.trim()}`)
        }
      }
    }
    expect(offences, offences.join('\n')).toEqual([])
  })

  it('declares only error classes, and each one extends the SDK error', () => {
    // The general form of the same claim: inheritance is used for the one thing
    // the platform requires it for, and for nothing that could grow into an
    // adapter hierarchy.
    const declarations: string[] = []
    for (const file of sourceFiles()) {
      for (const { text } of codeLines(file)) {
        const match = /\bclass\s+(\w+)\s+extends\s+([\w.]+)/.exec(text)
        if (match !== null) declarations.push(`${String(match[1])} extends ${String(match[2])}`)
      }
    }
    expect(declarations).toEqual([
      'CopilotTokenExchangeError extends AgentSdkError',
      'CopilotDeviceLoginError extends AgentSdkError',
    ])
  })

  it('builds the adapter by configuring the runtime HTTP provider', () => {
    // The positive half: `HttpModelAdapter` appears in `adapter.ts` only as a
    // TYPE — an imported type and return annotations — while the value that
    // produces the adapter is `createRuntimeHttpProvider`.
    const adapterCode = stripComments(source('adapter.ts'))
    expect(adapterCode).toContain('createRuntimeHttpProvider')
    expect(adapterCode).toContain('type HttpModelAdapter')
    expect(adapterCode).not.toMatch(/new\s+HttpModelAdapter\b/)
    expect(adapterCode).not.toMatch(/\bsuper\s*\(/)
  })
})

// ---------------------------------------------------------------------------
// Requirement 2.1 — the endpoint base, as a constant and as the default
// ---------------------------------------------------------------------------

/**
 * A `fetch` double that answers the token exchange and then a chat stream,
 * recording every URL it is handed.
 */
function recordingFetch(): { readonly urls: string[]; readonly fetch: typeof globalThis.fetch } {
  const urls: string[] = []
  const fetch = ((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    urls.push(url)
    if (url.includes('/copilot_internal/v2/token')) {
      return Promise.resolve(new Response(
        JSON.stringify({
          token: 'copilot-api-token',
          expires_at: Math.floor(Date.now() / 1_000) + 1_800,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ))
    }
    const frames = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`))
        controller.close()
      },
    })
    return Promise.resolve(new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
  }) as typeof globalThis.fetch

  return { urls, fetch }
}

const CREDENTIAL_FILE: CopilotAuthFile = Object.freeze({
  version: 1,
  github: Object.freeze({ token: 'ghu_surface_test_token' }),
})

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) { /* consumed for its side effects only */ }
}

describe('the Copilot endpoint base is the default, not just a constant (Requirement 2.1)', () => {
  it('publishes one value for the API base, from the leaf module', () => {
    expect(COPILOT_BASE_URL).toBe('https://api.githubcopilot.com')
    // Re-exported rather than copied: two spellings of a base URL are two base
    // URLs that can disagree.
    expect(LEAF_COPILOT_BASE_URL).toBe(COPILOT_BASE_URL)
    expect(new URL(COPILOT_BASE_URL).protocol).toBe('https:')
  })

  it('sends the request to that base when no `baseUrl` is configured', async () => {
    const { urls, fetch } = recordingFetch()
    const adapter = copilotAdapter({
      authStore: memoryCopilotCredentialStore(CREDENTIAL_FILE),
      models: [],
      fetch,
    })

    await drain(adapter.stream({
      provider: COPILOT_ROUTE_ID,
      model: 'gpt-4o',
      messages: [createTextMessage('hello')],
    }))

    // Two origins, each one pinned by configuration: the exchange goes to the
    // GitHub API and the generation goes to the Copilot base. The order matters
    // only in that the exchange must come first — the request cannot carry a
    // bearer token it has not obtained yet.
    expect(urls[0]).toBe('https://api.github.com/copilot_internal/v2/token')
    const generation = urls.filter(url => !url.includes('/copilot_internal/'))
    expect(generation).toEqual([`${COPILOT_BASE_URL}/chat/completions`])
  })

  it('honours a configured `baseUrl` instead, so the default is a default', async () => {
    const { urls, fetch } = recordingFetch()
    const adapter = copilotAdapter({
      authStore: memoryCopilotCredentialStore(CREDENTIAL_FILE),
      baseUrl: 'https://copilot.proxy.invalid/v1',
      models: [],
      fetch,
    })

    await drain(adapter.stream({
      provider: COPILOT_ROUTE_ID,
      model: 'gpt-4o',
      messages: [createTextMessage('hello')],
    }))

    const generation = urls.filter(url => !url.includes('/copilot_internal/'))
    expect(generation).toEqual(['https://copilot.proxy.invalid/v1/chat/completions'])
  })
})

// ---------------------------------------------------------------------------
// Requirements 3.1, 5.1 — two token tiers, two independent types
// ---------------------------------------------------------------------------

/** True only when `A` and `B` are the same type; used for the non-alias check. */
type Identical<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true
  : false

describe('the two token tiers are separate types (Requirements 3.1, 5.1)', () => {
  it('keeps `CopilotGitHubToken` and `CopilotApiToken` from being the same type', () => {
    // Checked by the type checker, asserted here so the claim is visible in the
    // test that owns the requirement rather than only in a build step.
    const gitHubTokenIsNotApiToken: Identical<CopilotGitHubToken, CopilotApiToken> = false
    const apiTokenIsNotGitHubToken: Identical<CopilotApiToken, CopilotGitHubToken> = false
    expect(gitHubTokenIsNotApiToken).toBe(false)
    expect(apiTokenIsNotGitHubToken).toBe(false)
  })

  it('declares each tier where its lifetime lives, neither as an alias of the other', () => {
    const storeTypes = stripComments(source('common/store-types.ts'))
    const exchange = stripComments(source('exchange.ts'))
    // Declarations, not `type X = Y` aliases pointing at the other tier.
    expect(storeTypes).toMatch(/export interface CopilotGitHubToken\s*\{/)
    expect(exchange).toMatch(/export interface CopilotApiToken\s*\{/)
    expect(storeTypes).not.toContain('CopilotApiToken')
    expect(exchange).not.toMatch(/type\s+CopilotApiToken\s*=/)
  })

  it('gives the persisted tier no refresh-token field', () => {
    // The structural difference from Codex: nothing rotates, so there is nothing
    // to persist for a rotation. Comments are stripped first — this module
    // explains the omission at length, and the prose must not read as the field.
    for (const { line, text } of codeLines('common/store-types.ts')) {
      expect(text, `common/store-types.ts:${String(line)}`).not.toMatch(/refresh/i)
    }
  })

  it('derives nothing in the credential contract from the Codex one', () => {
    // Comments stripped again: this module states the non-derivation in prose,
    // naming `CodexAuthFile` in order to say it is NOT imported.
    const storeTypes = stripComments(source('common/store-types.ts'))
    expect(storeTypes).not.toContain('CodexAuthFile')
    expect(storeTypes).not.toContain('provider-codex')
    // The whole package: an alias reached through any other module would make the
    // same false claim.
    const offences: string[] = []
    for (const file of sourceFiles()) {
      for (const { line, text } of codeLines(file)) {
        if (/\bCodex\w*/.test(text)) offences.push(`src/${file}:${String(line)}: ${text.trim()}`)
      }
    }
    expect(offences, offences.join('\n')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Requirements 6.2, 6.4 — the store factories and the CAS marker
// ---------------------------------------------------------------------------

describe('the credential store factories (Requirements 6.2, 6.4)', () => {
  it('builds a read/write store with no credential-store marker', () => {
    const store = memoryCopilotAuthStore(CREDENTIAL_FILE)
    expect(store.location).toBe('<memory>')
    expect(typeof store.read).toBe('function')
    expect(typeof store.write).toBe('function')
    // The absence of the marker is what routes this variant to the legacy
    // capture path, so it is the thing worth asserting.
    expect(Object.getOwnPropertyDescriptor(store, 'kind')).toBeUndefined()
    expect((store as { readonly kind?: unknown }).kind).toBeUndefined()
  })

  it('builds a compare-and-swap store carrying the marker as a data property', async () => {
    const store = memoryCopilotCredentialStore(CREDENTIAL_FILE)
    expect(store.kind).toBe('credential-store')
    expect(store.apiVersion).toBe(CREDENTIAL_CAPABILITY_API_VERSION)
    expect(store.label).toBe('<memory>')
    expect(typeof store.read).toBe('function')
    expect(typeof store.commit).toBe('function')

    // A data property, not an accessor: `captureCopilotStore` refuses an accessor
    // rather than invoking it, so a store whose own marker were a getter could
    // never be used at all.
    for (const key of ['kind', 'apiVersion'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(store, key)
      expect(descriptor, key).toBeDefined()
      expect(descriptor === undefined ? false : 'value' in descriptor, key).toBe(true)
    }

    const record = await store.read({ signal: AbortSignal.timeout(1_000), logger: NULL_LOGGER })
    expect(record?.value).toEqual(CREDENTIAL_FILE)
    expect(typeof record?.revision).toBe('string')
  })

  it('ships the two in-memory factories here, and leaves the two file ones to auth-node', () => {
    expect(typeof memoryCopilotAuthStore).toBe('function')
    expect(typeof memoryCopilotCredentialStore).toBe('function')

    // `fileCopilotAuthStore` / `fileCopilotCredentialStore` belong to
    // `packages/auth-node` because they need paths, a filesystem and the
    // environment, none of which a Universal package may reach (Requirement 6.1).
    // They are task 11.1 and do not exist yet; this branch turns into the real
    // assertion the moment the module lands, so the pair is never left unchecked.
    const fileStore = join(AUTH_NODE_SRC, 'copilot-store.ts')
    if (!existsSync(fileStore)) {
      expect(readdirSync(AUTH_NODE_SRC)).not.toContain('copilot-store.ts')
      return
    }
    const text = stripComments(readFileSync(fileStore, 'utf8'))
    for (const name of [
      'DEFAULT_COPILOT_AUTH_PATH',
      'COPILOT_AUTH_PATH_ENV',
      'resolveCopilotAuthPath',
      'fileCopilotAuthStore',
      'fileCopilotCredentialStore',
    ]) {
      expect(text, name).toMatch(new RegExp(`export\\s+(?:const|function)\\s+${name}\\b`))
    }
  })
})

// ---------------------------------------------------------------------------
// Requirement 7.4 — plugin identity defaults
// ---------------------------------------------------------------------------

describe('plugin identity defaults (Requirement 7.4)', () => {
  it('defaults `id`, `family` and `routes` to the one Copilot route', () => {
    const plugin = copilotPlugin({ authStore: memoryCopilotCredentialStore(), models: [] })
    expect(COPILOT_ROUTE_ID).toBe('copilot')
    expect(COPILOT_DISPLAY_NAME).toBe('GitHub Copilot')
    expect(plugin.id).toBe(COPILOT_ROUTE_ID)
    expect(plugin.family).toBe('copilot')
    expect(plugin.displayName).toBe(COPILOT_DISPLAY_NAME)
    expect(plugin.routes).toEqual([COPILOT_ROUTE_ID])
    expect(plugin.defaultModel).toBeUndefined()
  })

  it('takes an explicit `id` as the route default, and an explicit `routes` over both', () => {
    const derived = copilotPlugin({
      authStore: memoryCopilotCredentialStore(),
      models: [],
      id: 'work-copilot',
    })
    expect(derived.id).toBe('work-copilot')
    expect(derived.family).toBe('copilot')
    expect(derived.routes).toEqual(['work-copilot'])

    const explicit = copilotPlugin({
      authStore: memoryCopilotCredentialStore(),
      models: [],
      id: 'work-copilot',
      routes: ['work-copilot', 'work-copilot-alt'],
    })
    expect(explicit.routes).toEqual(['work-copilot', 'work-copilot-alt'])
  })

  it('reports the provider identity from the adapter as well', () => {
    const adapter = copilotAdapter({
      authStore: memoryCopilotCredentialStore(),
      models: [],
    })
    expect(adapter.providerInfo(COPILOT_ROUTE_ID))
      .toEqual({ id: COPILOT_ROUTE_ID, name: COPILOT_DISPLAY_NAME })
  })
})

// ---------------------------------------------------------------------------
// Property 25 — Requirement 7.5
// ---------------------------------------------------------------------------

/** The three shapes `defaultModel` can arrive in. */
type DefaultModelShape = 'absent' | 'string' | 'target'

interface DefaultModelCase {
  readonly routes: readonly string[]
  readonly shape: DefaultModelShape
  readonly defaultModel: string | ModelTarget | undefined
}

function defaultModelCase(rng: () => number): DefaultModelCase {
  // Route lists of length 0 through 4, including a duplicate-bearing one: both
  // are rejected by the composition layer regardless of `defaultModel`, and the
  // property has to hold across them rather than only where routes are already
  // valid.
  const count = intBetween(rng, 0, 4)
  const names = ['copilot', 'copilot-work', 'copilot-personal', 'copilot-alt']
  const routes: string[] = []
  for (let index = 0; index < count; index++) {
    routes.push(rng() < 0.1 && routes.length > 0
      ? pick(rng, routes)
      : (names[index] as string))
  }
  const shape = pick<DefaultModelShape>(rng, ['absent', 'string', 'target'])
  const modelId = pick(rng, ['gpt-4o', 'gpt-5-codex', 'claude-sonnet-4'])
  if (shape === 'absent') return { routes, shape, defaultModel: undefined }
  if (shape === 'string') return { routes, shape, defaultModel: modelId }
  // A `ModelTarget` names its own provider, which is why it needs no route count
  // to be resolvable. It still has to name a route this plugin claims, which the
  // composition layer checks separately.
  const provider = routes.length === 0 ? 'copilot' : pick(rng, routes)
  return { routes, shape, defaultModel: { provider, id: modelId } }
}

/** Whether the route list itself is admissible, independent of `defaultModel`. */
function routesValid(routes: readonly string[]): boolean {
  return routes.length > 0 && new Set(routes).size === routes.length
}

describe('Feature: github-copilot-provider, Property 25: `defaultModel` dạng string đòi đúng một route', () => {
  it('accepts a configuration exactly when `defaultModel` is a ModelTarget, is absent, or is a string on a single-route configuration', () => {
    const seed = 0x0025_c019
    const rng = rngOf(seed)

    for (let run = 0; run < RUNS; run++) {
      const testCase = defaultModelCase(rng)
      const context = `seed=${String(seed)} run=${String(run)} ${JSON.stringify(testCase)}`
      const options = {
        authStore: memoryCopilotCredentialStore(),
        models: [],
        ...(testCase.routes.length === 0 ? {} : { routes: testCase.routes }),
        ...(testCase.defaultModel === undefined ? {} : { defaultModel: testCase.defaultModel }),
      }
      // An omitted `routes` falls back to `[id]`, which is one valid route.
      const effectiveRoutes = testCase.routes.length === 0 ? [COPILOT_ROUTE_ID] : testCase.routes
      const shouldBeAccepted = routesValid(effectiveRoutes)
        && (testCase.shape !== 'string' || effectiveRoutes.length === 1)

      let failure: unknown
      let plugin: ReturnType<typeof copilotPlugin> | undefined
      try {
        plugin = copilotPlugin(options)
      } catch (error) {
        failure = error
      }

      expect(failure === undefined, context).toBe(shouldBeAccepted)
      if (!shouldBeAccepted) {
        expect(failure, context).toBeInstanceOf(TypeError)
        continue
      }
      expect(plugin?.routes, context).toEqual(effectiveRoutes)
      if (testCase.shape === 'absent') {
        expect(plugin?.defaultModel, context).toBeUndefined()
        continue
      }
      // The accepted forms both land as a resolved `ModelTarget`: a string is
      // completed with the single route, and a target keeps the provider it named.
      const expected = testCase.shape === 'string'
        ? { provider: effectiveRoutes[0], id: testCase.defaultModel as string }
        : testCase.defaultModel as ModelTarget
      expect(plugin?.defaultModel, context).toMatchObject(expected)
    }
  })

  it('names the constraint when a string default meets more than one route', () => {
    expect(() => copilotPlugin({
      authStore: memoryCopilotCredentialStore(),
      models: [],
      routes: ['copilot-a', 'copilot-b'],
      defaultModel: 'gpt-4o',
    })).toThrow(/string defaultModel requires exactly one/i)
  })
})

// ---------------------------------------------------------------------------
// Requirements 11.1, 11.5 — client identity is published, and OAuth is the only surface
// ---------------------------------------------------------------------------

describe('client identity and the single authentication surface (Requirements 11.1, 11.5)', () => {
  it('exports all three `Client_Identity_Constants` from the barrel', () => {
    const barrel = stripComments(source('index.ts'))
    for (const name of [
      'COPILOT_OAUTH_CLIENT_ID',
      'COPILOT_EDITOR_VERSION',
      'COPILOT_EDITOR_PLUGIN_VERSION',
    ]) {
      expect(barrel, name).toContain(name)
    }
    // Descriptive names carrying real, overridable values — the point of
    // Requirement 11.1 is that a caller can READ the identity this SDK presents.
    expect(COPILOT_OAUTH_CLIENT_ID).toBe('Iv1.b507a08c87ecfe98')
    expect(COPILOT_EDITOR_VERSION).toBe('vscode/1.99.0')
    expect(COPILOT_EDITOR_PLUGIN_VERSION).toBe('copilot-chat/0.26.0')
    for (const value of [
      COPILOT_OAUTH_CLIENT_ID,
      COPILOT_EDITOR_VERSION,
      COPILOT_EDITOR_PLUGIN_VERSION,
    ]) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it('documents in the module comment that these defaults present an editor client', () => {
    // Requirement 11.3's disclosure, kept next to 11.1 because the constants are
    // only honest if the note explaining them cannot be deleted unnoticed.
    const adapterDoc = source('adapter.ts')
    expect(adapterDoc.toLowerCase()).toContain('editor client')
    expect(adapterDoc).toMatch(/named option|option có tên|overridable/i)
  })

  it('offers exactly one authentication surface, the OAuth device flow', () => {
    const oauth = stripComments(source('oauth.ts'))
    expect(oauth).toMatch(/export (?:async )?function requestCopilotDeviceCode\b/)
    expect(oauth).toMatch(/export (?:async )?function runCopilotDeviceLogin\b/)
    expect(DEFAULT_COPILOT_OAUTH_ISSUER).toBe('https://github.com')
    // No second grant type: an authorization-code or password grant here would
    // be a second surface with its own redirect handling.
    expect(oauth).not.toMatch(/authorization_code|client_secret|password/)
  })

  it('reads a credential from no vendor CLI, anywhere in the package', () => {
    // The application injects credentials through `Copilot_Credential_Store`.
    // Reaching into another program's files or shelling out to its CLI would take
    // a credential the SDK was never granted, and would do it invisibly.
    const forbidden: readonly RegExp[] = [
      /\bgh\s+auth\b/i,
      /hosts\.ya?ml/i,
      /apps\.json/i,
      /github-copilot\//i,
      /\bchild_process\b/,
      /\bexecFile\b|\bexecSync\b|\bspawnSync\b|\bspawn\s*\(/,
      /\bkeychain\b/i,
      /\bcredential[-_ ]?manager\b/i,
      /GITHUB_TOKEN|GH_TOKEN|COPILOT_API_KEY/,
    ]
    const offences: string[] = []
    for (const file of sourceFiles()) {
      for (const { line, text } of codeLines(file)) {
        for (const pattern of forbidden) {
          if (pattern.test(text)) {
            offences.push(`src/${file}:${String(line)} matches ${String(pattern)}: ${text.trim()}`)
          }
        }
      }
    }
    expect(offences, offences.join('\n')).toEqual([])
  })

  it('reads no environment and no filesystem at all, which is the stronger claim', () => {
    // A Universal package cannot reach either, so the CLI-credential path is
    // closed structurally rather than by inspection of individual call sites.
    const offences: string[] = []
    for (const file of sourceFiles()) {
      for (const { line, text } of codeLines(file)) {
        if (/from\s+'node:|require\(\s*'node:|process\.env|\breadFileSync\b|\bhomedir\b/.test(text)) {
          offences.push(`src/${file}:${String(line)}: ${text.trim()}`)
        }
      }
    }
    expect(offences, offences.join('\n')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Requirement 13.1 — the error taxonomy
// ---------------------------------------------------------------------------

describe('COPILOT_ERROR_CODES (Requirement 13.1)', () => {
  it('publishes exactly this taxonomy', () => {
    // A snapshot rather than a spot check: consumers route on these values and
    // they travel through serialized log lines, so both the key set and every
    // value are part of the published surface.
    expect({ ...COPILOT_ERROR_CODES }).toEqual({
      CREDENTIAL_REJECTED: 'COPILOT_CREDENTIAL_REJECTED',
      TOKEN_EXCHANGE_FAILED: 'COPILOT_TOKEN_EXCHANGE_FAILED',
      TOKEN_MALFORMED: 'COPILOT_TOKEN_MALFORMED',
      TENANT_UNSUPPORTED: 'COPILOT_TENANT_UNSUPPORTED',
      EDITOR_HEADERS_MISSING: 'COPILOT_EDITOR_HEADERS_MISSING',
      ENDPOINT_ORIGIN_INVALID: 'COPILOT_ENDPOINT_ORIGIN_INVALID',
      REDIRECT_REJECTED: 'COPILOT_REDIRECT_REJECTED',
      DEVICE_LOGIN_DENIED: 'COPILOT_DEVICE_LOGIN_DENIED',
      DEVICE_LOGIN_EXPIRED: 'COPILOT_DEVICE_LOGIN_EXPIRED',
      DEVICE_LOGIN_TIMEOUT: 'COPILOT_DEVICE_LOGIN_TIMEOUT',
      DEVICE_LOGIN_FAILED: 'COPILOT_DEVICE_LOGIN_FAILED',
      CREDENTIAL_REVISION_CONFLICT: 'COPILOT_CREDENTIAL_REVISION_CONFLICT',
      CATALOG_MALFORMED: 'COPILOT_CATALOG_MALFORMED',
      ENDPOINT_OVERRIDE_INVALID: 'COPILOT_ENDPOINT_OVERRIDE_INVALID',
    })
  })

  it('freezes the table and namespaces every value', () => {
    expect(Object.isFrozen(COPILOT_ERROR_CODES)).toBe(true)
    const values = Object.values(COPILOT_ERROR_CODES)
    for (const value of values) expect(value).toMatch(/^COPILOT_[A-Z0-9_]+$/)
    // Distinct values, so a consumer routing on the code cannot conflate two
    // failures that need different handling.
    expect(new Set(values).size).toBe(values.length)
  })
})
