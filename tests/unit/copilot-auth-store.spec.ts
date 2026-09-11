/**
 * Unit tests for the Universal half of `Copilot_Auth`: the two in-memory store
 * doubles, the missing-credential door, and the exchange decision.
 *
 * The example-level cover comes first: the clone in both directions, the single
 * code for three shapes of "no credential", and the rule that `refresh_in` may
 * only shorten the refresh moment. The properties this surface owns — Property
 * 20 (memory-store side), 24, and 49 — follow at the bottom of the file, over
 * SEEDED random input so a failure reproduces from the printed seed.
 */
import { AgentSdkError, MISSING_CREDENTIAL_CODE } from '@alvin0/ai-agent-sdk-core'
import { CREDENTIAL_CAPABILITY_API_VERSION } from '@alvin0/ai-agent-sdk-core/provider'
import type { SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import { describe, expect, it } from 'vitest'
import { captureCopilotStore } from '../../packages/provider-copilot/src/common/store-capture.ts'
import {
  COPILOT_ERROR_CODES,
  COPILOT_TOKEN_EXCHANGE_MARGIN_MS,
  memoryCopilotAuthStore,
  memoryCopilotCredentialStore,
  requireGitHubToken,
  shouldExchange,
  type CopilotAuthFile,
} from '../../packages/provider-copilot/src/index.ts'

const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined, debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined, fatal: () => undefined,
})

const operation = (): { signal: AbortSignal; logger: SdkLogger } =>
  ({ signal: new AbortController().signal, logger: NULL_LOGGER })

const file = (token = 'ghu_example'): CopilotAuthFile =>
  ({ version: 1, github: { token } })

describe('Copilot memory stores', () => {
  it('keeps the read/write double free of Node globals', async () => {
    const store = memoryCopilotAuthStore(file())
    expect(store.location).toBe('<memory>')
    expect((await store.read())?.github.token).toBe('ghu_example')
    await store.write(file('ghu_second'))
    expect((await store.read())?.github.token).toBe('ghu_second')
  })

  it('starts empty when no initial file is given', async () => {
    expect(await memoryCopilotAuthStore().read()).toBeUndefined()
    expect(await memoryCopilotCredentialStore().read(operation())).toBeUndefined()
  })

  it('clones in both directions so no caller shares state with the store', async () => {
    const initial = file()
    const store = memoryCopilotCredentialStore(initial)
    const first = await store.read(operation())
    expect(first?.revision).toBe('0')
    expect(first?.value).not.toBe(initial)
    expect(first?.value).toEqual(initial)

    const written = file('ghu_written')
    await store.commit({ value: written, expectedRevision: '0' }, operation())
    const second = await store.read(operation())
    expect(second?.revision).toBe('1')
    expect(second?.value).not.toBe(written)
    expect(second?.value.github.token).toBe('ghu_written')
  })

  it('lets exactly one of two commits at the same revision win', async () => {
    const store = memoryCopilotCredentialStore(file())
    const [first] = await Promise.allSettled([
      store.commit({ value: file('ghu_a'), expectedRevision: '0' }, operation()),
      store.commit({ value: file('ghu_b'), expectedRevision: '0' }, operation()),
    ])
    expect(first.status).toBe('fulfilled')
    const conflict = await store
      .commit({ value: file('ghu_c'), expectedRevision: '0' }, operation())
      .then(() => undefined, (error: unknown) => error)
    expect(conflict).toBeInstanceOf(AgentSdkError)
    expect((conflict as AgentSdkError).code)
      .toBe(COPILOT_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT)
  })

  it('expects a null revision when the store is empty', async () => {
    const store = memoryCopilotCredentialStore()
    await expect(store.commit({ value: file(), expectedRevision: '0' }, operation()))
      .rejects.toThrow(/revision changed/i)
    await expect(store.commit({ value: file(), expectedRevision: null }, operation()))
      .resolves.toEqual({ revision: '1' })
  })
})

describe('requireGitHubToken', () => {
  it('returns the stored token when one is present', () => {
    expect(requireGitHubToken(file(), '<memory>').token).toBe('ghu_example')
  })

  it('gives three shapes of no-credential the same code and the login command', () => {
    const absent = undefined
    const noGithub = { version: 1 } as unknown as CopilotAuthFile
    const emptyToken = file('')
    for (const candidate of [absent, noGithub, emptyToken]) {
      let caught: unknown
      try {
        requireGitHubToken(candidate, '/tmp/copilot-auth.json')
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AgentSdkError)
      const error = caught as AgentSdkError
      expect(error.code).toBe(MISSING_CREDENTIAL_CODE)
      expect(error.message).toContain('/tmp/copilot-auth.json')
      expect(error.message).toContain('provider:copilot:login-device')
    }
  })

  it('never puts the token value in the message', () => {
    // The empty-token case is the only failing shape that has a `github` object to
    // read from, so it is the one that could have interpolated a value.
    try {
      requireGitHubToken({ version: 1, github: { token: '', scope: 'read:user' } }, '<memory>')
    } catch (error) {
      expect((error as AgentSdkError).message).not.toContain('read:user')
    }
  })
})

describe('shouldExchange', () => {
  const now = 1_700_000_000_000

  it('always exchanges when there is no token yet', () => {
    expect(shouldExchange(undefined, now)).toBe(true)
    expect(shouldExchange(undefined, now, 0)).toBe(true)
  })

  it('exchanges once now reaches expiry minus the margin, and not before', () => {
    const expiresAtMs = now + COPILOT_TOKEN_EXCHANGE_MARGIN_MS
    expect(shouldExchange({ expiresAtMs }, now)).toBe(true)
    expect(shouldExchange({ expiresAtMs: expiresAtMs + 1 }, now)).toBe(false)
  })

  it('reads no global clock: the answer follows the `now` it is handed', () => {
    const api = { expiresAtMs: now + COPILOT_TOKEN_EXCHANGE_MARGIN_MS + 60_000 }
    expect(shouldExchange(api, now)).toBe(false)
    expect(shouldExchange(api, now + 60_000)).toBe(true)
  })

  it('lets `refresh_in` shorten the refresh moment', () => {
    // Expiry is an hour out, so the margin alone says no; a 60-second refresh_in
    // hint pulls the moment to one minute before expiry, still in the future.
    const expiresAtMs = now + 60 * 60 * 1_000
    expect(shouldExchange({ expiresAtMs, refreshInSeconds: 60 }, now)).toBe(false)
    // A hint that reaches back past `now` brings the exchange forward.
    expect(shouldExchange({ expiresAtMs, refreshInSeconds: 60 * 60 }, now)).toBe(true)
  })

  it('never lets `refresh_in` extend past expiry minus the margin', () => {
    // A hint of zero seconds asks the SDK to hold the token until the exact expiry
    // instant. The margin still wins, so the answer matches the no-hint answer.
    const expiresAtMs = now + COPILOT_TOKEN_EXCHANGE_MARGIN_MS - 1
    expect(shouldExchange({ expiresAtMs, refreshInSeconds: 0 }, now)).toBe(true)
    expect(shouldExchange({ expiresAtMs }, now)).toBe(true)
  })

  it('honours an explicit margin over the default', () => {
    const expiresAtMs = now + 30_000
    expect(shouldExchange({ expiresAtMs }, now)).toBe(true)
    expect(shouldExchange({ expiresAtMs }, now, 10_000)).toBe(false)
  })
})
// ---------------------------------------------------------------------------
// Seeded generation
//
// The repository carries no property-testing library, so the generators live
// here, following `tests/unit/chat-completions-serialize.spec.ts`.
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

/** `pick` for lists that legitimately contain `undefined` or `null` as a case. */
function pickLoose<T>(rng: Rng, values: readonly T[]): T {
  if (values.length === 0) throw new Error('empty choice list')
  return values[intBelow(rng, values.length)] as T
}

/** The conflict code, read once so a rename cannot silently weaken the assertions. */
const CONFLICT_CODE = COPILOT_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT

function errorOf(value: unknown): AgentSdkError {
  expect(value).toBeInstanceOf(AgentSdkError)
  return value as AgentSdkError
}

// ---------------------------------------------------------------------------
// Property 20 (memory-store side)
// ---------------------------------------------------------------------------

/** One generated step in an interleaving of reads and commits. */
type StoreStep =
  | { kind: 'read' }
  | { kind: 'commit-current' }
  | { kind: 'commit-stale' }
  /** `count` commits launched together against the same base revision. */
  | { kind: 'burst'; count: number }

function generateSteps(rng: Rng): StoreStep[] {
  const count = 2 + intBelow(rng, 6)
  return Array.from({ length: count }, () => {
    switch (pick(rng, ['read', 'commit-current', 'commit-stale', 'burst', 'burst'] as const)) {
      case 'read': return { kind: 'read' as const }
      case 'commit-current': return { kind: 'commit-current' as const }
      case 'commit-stale': return { kind: 'commit-stale' as const }
      default: return { kind: 'burst' as const, count: 2 + intBelow(rng, 4) }
    }
  })
}

/** A revision guaranteed to disagree with `expected`, so the commit must lose. */
function staleRevision(rng: Rng, expected: string | null): string | null {
  const candidates = expected === null
    ? ['0', '1', '7', 'not-a-revision']
    : [null, `${expected}0`, String(Number(expected) + 1 + intBelow(rng, 5)), 'not-a-revision']
  const candidate = pick(rng, candidates)
  expect(candidate).not.toBe(expected)
  return candidate
}

describe('Feature: github-copilot-provider, Property 20: Commit đồng thời cho đúng một bên thắng', () => {
  it('lets exactly one commit per base revision win and fails the rest with the Copilot conflict code', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      // The model tracks what the store must hold, independently of the store.
      let exists = rng() < 0.5
      let revision = 0
      let token = 'ghu_initial'
      const store = exists
        ? memoryCopilotCredentialStore(file(token))
        : memoryCopilotCredentialStore()
      let wins = 0

      const base = (): string | null => (exists ? String(revision) : null)

      for (const [index, step] of generateSteps(rng).entries()) {
        const at = `${trace} step ${String(index)} ${step.kind}`
        switch (step.kind) {
          case 'read': {
            const record = await store.read(operation())
            if (!exists) {
              expect(record, at).toBeUndefined()
            } else {
              expect(record?.revision, at).toBe(String(revision))
              expect(record?.value.github?.token, at).toBe(token)
            }
            break
          }
          case 'commit-current': {
            const next = `ghu_${trace.replace(/\W/gu, '')}_${String(index)}`
            const result = await store.commit({ value: file(next), expectedRevision: base() }, operation())
            revision += 1
            exists = true
            token = next
            wins += 1
            expect(result.revision, at).toBe(String(revision))
            break
          }
          case 'commit-stale': {
            const expected = staleRevision(rng, base())
            const caught = await store
              .commit({ value: file('ghu_stale'), expectedRevision: expected }, operation())
              .then(() => undefined, (error: unknown) => error)
            // A losing commit changes nothing: same code, same stored value.
            expect(errorOf(caught).code, at).toBe(CONFLICT_CODE)
            break
          }
          default: {
            const expected = base()
            const values = Array.from(
              { length: step.count },
              (_unused, k) => `ghu_burst_${String(index)}_${String(k)}`,
            )
            const settled = await Promise.allSettled(values.map((value) =>
              store.commit({ value: file(value), expectedRevision: expected }, operation())))

            const winners = settled
              .map((outcome, k) => ({ outcome, k }))
              .filter(({ outcome }) => outcome.status === 'fulfilled')
            expect(winners.length, `${at}: exactly one commit per base revision`).toBe(1)
            revision += 1
            exists = true
            wins += 1

            const winner = winners[0]
            if (winner === undefined) throw new Error('unreachable: winner count asserted above')
            const fulfilled = winner.outcome as PromiseFulfilledResult<{ revision: string }>
            expect(fulfilled.value.revision, at).toBe(String(revision))
            token = values[winner.k] ?? ''

            for (const [k, outcome] of settled.entries()) {
              if (k === winner.k) continue
              expect(outcome.status, at).toBe('rejected')
              expect(errorOf((outcome as PromiseRejectedResult).reason).code, at).toBe(CONFLICT_CODE)
            }
            break
          }
        }
      }

      // The revision counter is the number of winning commits and nothing else,
      // which is the same statement as "one winner per base revision" seen from
      // the end of the sequence.
      const final = await store.read(operation())
      if (!exists) {
        expect(final, trace).toBeUndefined()
        expect(wins, trace).toBe(0)
      } else {
        expect(Number(final?.revision), trace).toBe(wins)
        expect(final?.value.github?.token, trace).toBe(token)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Property 24
// ---------------------------------------------------------------------------

/** Records every accessor the SDK could have invoked; it must stay empty. */
interface AccessorLog { readonly touched: string[] }

/**
 * Define `key` as a getter that BOTH records the call and throws.
 *
 * Throwing alone would be enough to fail the run, but the log names the key, so
 * a failure says which property was read rather than only that one was.
 */
function defineAccessor(target: object, key: string, log: AccessorLog): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get: () => {
      log.touched.push(key)
      throw new Error(`accessor ${key} was invoked`)
    },
  })
}

type StoreVariant = 'legacy' | 'versioned' | 'proto-marker' | 'bad-api-version' | 'accessor'

interface StoreCase {
  readonly variant: StoreVariant
  readonly value: object
  readonly log: AccessorLog
  /** Non-null when the capture must fail instead of choosing a variant. */
  readonly expected: 'legacy' | 'versioned' | 'invalid'
  readonly label: string
  /** Counts calls of the captured methods; capture must do no I/O. */
  readonly calls: { count: number }
}

function buildStoreCase(rng: Rng, seed: number): StoreCase {
  const log: AccessorLog = { touched: [] }
  const calls = { count: 0 }
  const spy = () => {
    calls.count += 1
    return Promise.resolve(undefined)
  }
  const location = `/tmp/copilot-${String(seed)}.json`
  const label = `store-${String(seed)}`
  const variant = pick(rng, [
    'legacy', 'versioned', 'proto-marker', 'bad-api-version', 'accessor',
  ] as const)

  switch (variant) {
    case 'legacy': {
      const value: Record<string, unknown> = { location, read: spy, write: spy }
      // Keys the versioned path reads and the legacy path must not: an accessor
      // here proves the chosen path never probed for the other variant.
      for (const key of ['apiVersion', 'id', 'commit']) defineAccessor(value, key, log)
      return { variant, value, log, expected: 'legacy', label: location, calls }
    }
    case 'versioned': {
      const value: Record<string, unknown> = {
        kind: 'credential-store',
        apiVersion: CREDENTIAL_CAPABILITY_API_VERSION,
        id: `id-${String(seed)}`,
        label,
        read: spy,
        commit: spy,
      }
      for (const key of ['location', 'write']) defineAccessor(value, key, log)
      return { variant, value, log, expected: 'versioned', label, calls }
    }
    case 'proto-marker': {
      // The marker and the methods live on the prototype chain; the capture walks
      // it with descriptors, so this is still the versioned variant.
      const proto = {
        kind: 'credential-store',
        apiVersion: CREDENTIAL_CAPABILITY_API_VERSION,
        id: `id-${String(seed)}`,
        label,
        read: spy,
        commit: spy,
      }
      const value = Object.create(proto) as Record<string, unknown>
      for (const key of ['location', 'write']) defineAccessor(value, key, log)
      return { variant, value, log, expected: 'versioned', label, calls }
    }
    case 'bad-api-version': {
      const value: Record<string, unknown> = {
        kind: 'credential-store',
        apiVersion: pickLoose(rng, [0, 2, 99, '1', null, undefined] as const),
        id: `id-${String(seed)}`,
        label,
        read: spy,
        commit: spy,
      }
      return { variant, value, log, expected: 'invalid', label, calls }
    }
    default: {
      // An accessor standing in for a data property the capture DOES read. It
      // must be rejected on the descriptor, never invoked.
      const versioned = rng() < 0.5
      const value: Record<string, unknown> = versioned
        ? {
            kind: 'credential-store',
            apiVersion: CREDENTIAL_CAPABILITY_API_VERSION,
            id: `id-${String(seed)}`,
            label,
            read: spy,
            commit: spy,
          }
        : { location, read: spy, write: spy }
      const key = versioned
        ? pick(rng, ['kind', 'apiVersion', 'id', 'label', 'read', 'commit'] as const)
        : pick(rng, ['location', 'read', 'write'] as const)
      defineAccessor(value, key, log)
      return { variant, value, log, expected: 'invalid', label, calls }
    }
  }
}

describe('Feature: github-copilot-provider, Property 24: Kiểm tra marker store không gọi accessor nào', () => {
  it('matches the adapter path to the real variant or fails store-invalid, invoking no accessor', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 2_000)
      const testCase = buildStoreCase(rng, seed)
      const trace = `seed ${String(seed)} variant ${testCase.variant}`

      const outcome = (() => {
        try {
          return { ok: true as const, captured: captureCopilotStore(testCase.value) }
        } catch (error) {
          return { ok: false as const, error }
        }
      })()

      if (testCase.expected === 'invalid') {
        expect(outcome.ok, trace).toBe(false)
        if (outcome.ok) continue
        expect(errorOf(outcome.error).code, trace).toBe('CREDENTIAL_STORE_INVALID')
      } else {
        expect(outcome.ok, `${trace}: ${String(outcome.ok ? '' : outcome.error)}`).toBe(true)
        if (!outcome.ok) continue
        expect(outcome.captured.kind, trace).toBe(testCase.expected)
        expect(outcome.captured.label, trace).toBe(testCase.label)
      }

      // The two lines this surface holds: no caller getter ran, and no captured
      // method ran either — telling the variants apart does no I/O.
      expect(testCase.log.touched, `${trace}: accessors invoked`).toEqual([])
      expect(testCase.calls.count, `${trace}: store methods invoked`).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 49
// ---------------------------------------------------------------------------

/**
 * The shapes of "there is no credential" this layer can produce.
 *
 * The wrong-version file is the fourth shape in the property statement; the
 * version gate belongs to the Node file store, so that shape is asserted where
 * the parser lives (`copilot-auth-file-store.spec.ts`). What reaches THIS layer
 * from a rejected version is an empty read, which is the `empty-store` shape.
 */
type MissingShape = 'empty-store' | 'no-github-field' | 'null-github' | 'empty-token' | 'non-string-token'

function missingCandidate(shape: MissingShape, rng: Rng): CopilotAuthFile | undefined {
  switch (shape) {
    case 'empty-store': return undefined
    case 'no-github-field': return { version: 1 } as unknown as CopilotAuthFile
    case 'null-github': return { version: 1, github: null } as unknown as CopilotAuthFile
    case 'empty-token': return file('')
    default: return {
      version: 1,
      github: { token: pickLoose(rng, [null, undefined, 0, {}, []] as const) },
    } as unknown as CopilotAuthFile
  }
}

describe('Feature: github-copilot-provider, Property 49: Thiếu credential cho một code duy nhất kèm câu lệnh khắc phục', () => {
  it('gives every missing-credential shape the SDK code, the login command, and zero requests', async () => {
    const realFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = ((input: unknown) => {
      requests += 1
      return Promise.reject(new Error(`unexpected request to ${String(input)}`))
    }) as typeof globalThis.fetch

    try {
      for (let seed = 1; seed <= RUNS; seed += 1) {
        const rng = rngOf(seed + 4_000)
        const shape = pick(rng, [
          'empty-store', 'no-github-field', 'null-github', 'empty-token', 'non-string-token',
        ] as const)
        const label = pick(rng, ['<memory>', `/tmp/copilot-${String(seed)}.json`] as const)
        const trace = `seed ${String(seed)} shape ${shape}`

        // The empty-store shape goes through a real store read, so the property
        // covers the path a runtime caller takes, not just the pure function.
        const candidate = shape === 'empty-store'
          ? (await memoryCopilotCredentialStore().read(operation()))?.value
          : missingCandidate(shape, rng)

        let caught: unknown
        try {
          requireGitHubToken(candidate, label)
        } catch (error) {
          caught = error
        }

        const error = errorOf(caught)
        expect(error.code, trace).toBe(MISSING_CREDENTIAL_CODE)
        expect(error.message, trace).toContain('provider:copilot:login-device')
        expect(error.message, trace).toContain(label)
        // No token value can be in the message, because none of these shapes has
        // a usable one — but the surrounding object may still carry secrets.
        expect(error.message, trace).not.toContain('ghu_')
        expect(requests, `${trace}: requests to the Copilot surface`).toBe(0)
      }
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
