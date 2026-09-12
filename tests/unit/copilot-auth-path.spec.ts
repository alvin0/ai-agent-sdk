/**
 * Property tests for Copilot credential path resolution.
 *
 * Feature: github-copilot-provider — Property 21.
 *
 * `resolveCopilotAuthPath` is three lines of code guarding a decision that is
 * easy to get subtly wrong: which of three candidate locations a secret gets
 * written to. The failure mode this file exists to catch is not "wrong path" but
 * "path that silently became the current directory" — a shell variable that was
 * never set expands to `''`, and a resolver that treats `''` as present would
 * resolve it to `cwd` and drop `auth.json` wherever the process happened to
 * start. So blank counts as ABSENT and falls through to the next source.
 *
 * Two details of the implementation shape the assertions:
 *
 *  1. **Precedence short-circuits before validation.** The environment candidate
 *     is only ever looked at when the explicit path is absent, so an environment
 *     value carrying a NUL is inert while an explicit path is supplied. This is
 *     asserted as the actual contract — a resolver that validated all three
 *     candidates up front would reject calls that have every right to succeed.
 *  2. **`cwd` and `env` are both injectable.** Nothing here mutates
 *     `process.env` or `process.chdir`, which is what lets 120 generated cases
 *     per property run in-process with no cleanup and no cross-test leakage.
 *
 * Inputs come from a SEEDED generator rather than `Math.random`, so a failure
 * reproduces from the printed seed. The repository carries no property-testing
 * library, so the generators live here, following
 * `tests/unit/copilot-router.spec.ts`.
 */

import { isAbsolute, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COPILOT_AUTH_PATH_ENV,
  DEFAULT_COPILOT_AUTH_PATH,
  resolveCopilotAuthPath,
} from '../../packages/auth-node/src/copilot-store.ts'

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

/**
 * Draws one member of `values`.
 *
 * Guards on LENGTH rather than on the drawn value, because `undefined` is a
 * first-class candidate here — it is how "no path was supplied" is spelled.
 */
function pick<T>(rng: Rng, values: readonly T[]): T {
  if (values.length === 0) throw new Error('empty choice list')
  return values[intBelow(rng, values.length)] as T
}

/**
 * How the resolver is required to classify one candidate.
 *
 * `absent` is the interesting class: it holds `undefined` AND every string that
 * is empty or all whitespace, because those are the shapes an unset shell
 * variable takes on its way through interpolation.
 */
type Slot = {
  readonly value: string | undefined
  readonly kind: 'absent' | 'relative' | 'absolute' | 'nul'
}

const FILE_NAMES = ['auth.json', 'creds.json', 'a.json', 'nested name.json'] as const

/** A relative candidate, including the `./` and `../` forms `resolve` normalizes. */
function relativePath(rng: Rng): string {
  const prefix = pick(rng, ['', './', '../', 'x/', './deep/dir/', 'a/../b/'])
  return `${prefix}${pick(rng, FILE_NAMES)}`
}

/** An absolute candidate, built through `resolve` so it is absolute on any platform. */
function absolutePath(rng: Rng): string {
  return resolve('/', pick(rng, ['etc', 'var/lib', 'tmp/deep/dir']), pick(rng, FILE_NAMES))
}

/**
 * A candidate carrying a NUL.
 *
 * Includes a value that is blank APART FROM the NUL: `trim` does not strip NUL,
 * so ` \0 ` is a non-blank candidate that must be rejected, not skipped.
 */
function nulPath(rng: Rng): string {
  return pick(rng, ['\0', 'a\0b.json', '/etc/auth\0.json', ' \0 ', 'auth.json\0'])
}

function slot(rng: Rng): Slot {
  const kind = pick(rng, [
    'absent', 'absent', 'relative', 'relative', 'absolute', 'absolute', 'nul',
  ] as const)
  if (kind === 'absent') {
    return { value: pick(rng, [undefined, '', ' ', '\t', '\n', '   \t\n ']), kind }
  }
  if (kind === 'relative') return { value: relativePath(rng), kind }
  if (kind === 'absolute') return { value: absolutePath(rng), kind }
  return { value: nulPath(rng), kind }
}

/** A `cwd`, relative as well as absolute — the resolver must absolutize it too. */
function cwdOf(rng: Rng): string {
  return pick(rng, [
    resolve('/', 'work'),
    resolve('/', 'a/b/c'),
    '.',
    './sub',
    'rel/base',
    '..',
  ])
}

/**
 * Environment noise the resolver must ignore.
 *
 * Includes the Codex variable: the two providers keep separate credential files,
 * so a Copilot resolver that read the Codex variable would write a Copilot token
 * over a Codex one.
 */
function envNoise(rng: Rng): Record<string, string | undefined> {
  const noise: Record<string, string | undefined> = {
    AI_AGENT_SDK_CODEX_AUTH: resolve('/', 'codex', 'auth.json'),
    HOME: resolve('/', 'home', 'someone'),
    PATH: '/usr/bin',
  }
  if (rng() < 0.5) noise['COPILOT_AUTH'] = resolve('/', 'decoy', 'auth.json')
  if (rng() < 0.5) noise[`${COPILOT_AUTH_PATH_ENV}_EXTRA`] = resolve('/', 'decoy2.json')
  return noise
}

// ---------------------------------------------------------------------------
// The oracle: the spec statement, written as a decision table
// ---------------------------------------------------------------------------

type Expected =
  | { readonly outcome: 'throws' }
  | { readonly outcome: 'path'; readonly selected: string }

/**
 * What the spec says the answer is, derived from the candidate CLASSES only.
 *
 * Deliberately written as an ordered decision table rather than as a chain of
 * `??`, so it can disagree with the implementation instead of reproducing it.
 */
function expectedFor(explicit: Slot, env: Slot): Expected {
  if (explicit.kind === 'nul') return { outcome: 'throws' }
  if (explicit.kind !== 'absent') return { outcome: 'path', selected: explicit.value as string }
  if (env.kind === 'nul') return { outcome: 'throws' }
  if (env.kind !== 'absent') return { outcome: 'path', selected: env.value as string }
  return { outcome: 'path', selected: DEFAULT_COPILOT_AUTH_PATH }
}

/** Where a selected candidate lands: absolute untouched, relative against `cwd`. */
function placedAt(selected: string, cwd: string): string {
  return isAbsolute(selected) ? resolve(selected) : resolve(resolve(cwd), selected)
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

describe('resolveCopilotAuthPath examples', () => {
  const CWD = resolve('/', 'work')

  it('lands on the SDK-owned default when nothing is supplied', () => {
    expect(resolveCopilotAuthPath(undefined, { cwd: CWD, env: {} }))
      .toBe(resolve(CWD, '.providers/.copilot/auth.json'))
    expect(DEFAULT_COPILOT_AUTH_PATH).toBe('.providers/.copilot/auth.json')
  })

  it('reads the documented environment variable name', () => {
    expect(COPILOT_AUTH_PATH_ENV).toBe('AI_AGENT_SDK_COPILOT_AUTH')
    const env = { [COPILOT_AUTH_PATH_ENV]: 'from-env.json' }
    expect(resolveCopilotAuthPath(undefined, { cwd: CWD, env }))
      .toBe(resolve(CWD, 'from-env.json'))
  })

  it('lets an explicit path beat the environment', () => {
    const env = { [COPILOT_AUTH_PATH_ENV]: 'from-env.json' }
    expect(resolveCopilotAuthPath('explicit.json', { cwd: CWD, env }))
      .toBe(resolve(CWD, 'explicit.json'))
  })

  it('treats an empty or all-whitespace value as unset rather than as cwd', () => {
    const env = { [COPILOT_AUTH_PATH_ENV]: '   ' }
    expect(resolveCopilotAuthPath('', { cwd: CWD, env }))
      .toBe(resolve(CWD, DEFAULT_COPILOT_AUTH_PATH))
    expect(resolveCopilotAuthPath('  \t ', { cwd: CWD, env: { [COPILOT_AUTH_PATH_ENV]: 'e.json' } }))
      .toBe(resolve(CWD, 'e.json'))
  })

  it('rejects a NUL in either candidate with TypeError', () => {
    expect(() => resolveCopilotAuthPath('a\0b', { cwd: CWD, env: {} })).toThrow(TypeError)
    expect(() => resolveCopilotAuthPath(undefined, { cwd: CWD, env: { [COPILOT_AUTH_PATH_ENV]: 'a\0b' } }))
      .toThrow(TypeError)
  })

  it('keeps an absolute candidate absolute, whatever cwd is', () => {
    const target = resolve('/', 'etc', 'auth.json')
    expect(resolveCopilotAuthPath(target, { cwd: CWD, env: {} })).toBe(target)
    expect(resolveCopilotAuthPath(target, { cwd: resolve('/', 'other'), env: {} })).toBe(target)
  })
})

// ---------------------------------------------------------------------------
// Property 21
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 21: Phân giải path credential đúng precedence', () => {
  /**
   * **Feature: github-copilot-provider, Property 21: Phân giải path credential
   * đúng precedence** — *For any* bộ ba (path tường minh, biến môi trường, cwd),
   * path được phân giải phải bằng path tường minh khi nó không rỗng, bằng biến
   * môi trường khi path tường minh vắng và biến môi trường không rỗng, và bằng
   * path mặc định trong các trường hợp còn lại; path tương đối phải được resolve
   * theo cwd, path tuyệt đối giữ nguyên, và path chứa NUL phải bị từ chối.
   *
   * **Validates: Requirements 6.5**
   */
  it('picks explicit, then environment, then the default, and places it against cwd', () => {
    const seen = new Set<string>()
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x21_00_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const explicit = slot(rng)
      const envSlot = slot(rng)
      const cwd = cwdOf(rng)
      const env: Record<string, string | undefined> = envNoise(rng)
      if (envSlot.value !== undefined) env[COPILOT_AUTH_PATH_ENV] = envSlot.value

      const expected = expectedFor(explicit, envSlot)
      seen.add(`${explicit.kind}/${envSlot.kind}`)

      if (expected.outcome === 'throws') {
        expect(() => resolveCopilotAuthPath(explicit.value, { cwd, env }), trace)
          .toThrow(TypeError)
        continue
      }

      const actual = resolveCopilotAuthPath(explicit.value, { cwd, env })
      expect(actual, trace).toBe(placedAt(expected.selected, cwd))
      expect(isAbsolute(actual), `${trace} — result must be absolute`).toBe(true)
      expect(actual.includes('\0'), `${trace} — result must carry no NUL`).toBe(false)
    }

    // The table above is only meaningful if the generator actually reached every
    // precedence branch, including both ways of throwing.
    expect(seen.has('absent/absent'), 'default branch unreached').toBe(true)
    expect(seen.has('absent/relative') || seen.has('absent/absolute'), 'env branch unreached')
      .toBe(true)
    expect(seen.has('relative/absent') || seen.has('absolute/nul'), 'explicit branch unreached')
      .toBe(true)
    expect(seen.has('nul/absent') || seen.has('nul/relative'), 'explicit NUL unreached').toBe(true)
    expect(seen.has('absent/nul'), 'environment NUL unreached').toBe(true)
  })

  /**
   * The same property from the other side: a non-blank explicit path makes the
   * whole environment irrelevant, including an environment value that would have
   * been rejected on its own.
   *
   * **Feature: github-copilot-provider, Property 21: Phân giải path credential
   * đúng precedence**
   *
   * **Validates: Requirements 6.5**
   */
  it('ignores the environment entirely once an explicit path is supplied', () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x21_10_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const explicit = rng() < 0.5 ? relativePath(rng) : absolutePath(rng)
      const cwd = cwdOf(rng)
      const decoy = pick(rng, [
        undefined, '', '   ', relativePath(rng), absolutePath(rng), nulPath(rng),
      ])

      const withDecoy: Record<string, string | undefined> = envNoise(rng)
      if (decoy !== undefined) withDecoy[COPILOT_AUTH_PATH_ENV] = decoy

      expect(resolveCopilotAuthPath(explicit, { cwd, env: withDecoy }), trace)
        .toBe(resolveCopilotAuthPath(explicit, { cwd, env: {} }))
      expect(resolveCopilotAuthPath(explicit, { cwd, env: withDecoy }), trace)
        .toBe(placedAt(explicit, cwd))
    }
  })

  /**
   * A blank candidate at any level must never be allowed to become `cwd` itself:
   * the resolved path always ends in the file name of whichever candidate won.
   *
   * **Feature: github-copilot-provider, Property 21: Phân giải path credential
   * đúng precedence**
   *
   * **Validates: Requirements 6.5**
   */
  it('never resolves a blank candidate to the working directory', () => {
    const BLANKS = [undefined, '', ' ', '\t', '\n', '\r\n', '  \t  '] as const
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x21_20_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const cwd = cwdOf(rng)
      const absoluteCwd = resolve(cwd)
      const explicit = pick(rng, BLANKS)
      const envValue = pick(rng, BLANKS)
      const env: Record<string, string | undefined> = envNoise(rng)
      if (envValue !== undefined) env[COPILOT_AUTH_PATH_ENV] = envValue

      const actual = resolveCopilotAuthPath(explicit, { cwd, env })
      expect(actual, trace).toBe(resolve(absoluteCwd, DEFAULT_COPILOT_AUTH_PATH))
      expect(actual, trace).not.toBe(absoluteCwd)
      expect(actual.endsWith('auth.json'), trace).toBe(true)
    }
  })

  /**
   * `cwd` defaults to `process.cwd()`, and injecting that same value must give
   * the same answer — otherwise the injectable form and the production form
   * disagree and the tests above would be proving nothing about real use.
   *
   * **Feature: github-copilot-provider, Property 21: Phân giải path credential
   * đúng precedence**
   *
   * **Validates: Requirements 6.5**
   */
  it('defaults cwd to process.cwd() without reading the ambient environment', () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x21_30_00 + run
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`

      const candidate = pick(rng, [undefined, relativePath(rng), absolutePath(rng)])
      const env = {} as const

      expect(resolveCopilotAuthPath(candidate, { env }), trace)
        .toBe(resolveCopilotAuthPath(candidate, { cwd: process.cwd(), env }))
    }
  })
})
