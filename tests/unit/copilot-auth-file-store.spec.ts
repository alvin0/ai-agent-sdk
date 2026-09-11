/**
 * Property tests for the Node FILE half of `Copilot_Credential_Store`.
 *
 * Feature: github-copilot-provider — Property 20 (file-store side) and Property 22.
 *
 * The memory-store side of Property 20 lives in `copilot-auth-store.spec.ts`; it
 * proves the compare-and-swap CONTRACT. This file proves the same statement over
 * a real filesystem, where the revision is a hash of bytes another writer can
 * change and the mutual exclusion comes from an on-disk lock rather than from the
 * single-threaded ordering of a Map.
 *
 * Property 22 asserts the mode with `fs.stat` rather than trusting that
 * `replaceCredentialText` still chmods. The 0o600 comes from a helper SHARED with
 * the Codex store, so the whole point of the assertion is that a future change
 * over there cannot silently widen the permissions of a Copilot credential
 * (Requirements 6.3, 6.8, 16.6).
 *
 * Inputs come from a SEEDED generator rather than `Math.random`, so a failure
 * reproduces from the printed seed. The repository carries no property-testing
 * library, so the generators live here, following `copilot-auth-store.spec.ts`.
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentSdkError } from '@alvin0/ai-agent-sdk-core'
import type { SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import { COPILOT_ERROR_CODES } from '../../packages/provider-copilot/src/common/error-codes.ts'
import type { CopilotAuthFile } from '../../packages/provider-copilot/src/index.ts'
import {
  fileCopilotAuthStore,
  fileCopilotCredentialStore,
} from '../../packages/auth-node/src/copilot-store.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined, debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined, fatal: () => undefined,
})

const operation = (): { signal: AbortSignal; logger: SdkLogger } =>
  ({ signal: new AbortController().signal, logger: NULL_LOGGER })

const file = (token = 'ghu_example'): CopilotAuthFile =>
  ({ version: 1, github: { token } })

/** The conflict code, read once so a rename cannot silently weaken the assertions. */
const CONFLICT_CODE = COPILOT_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT

/**
 * The exact bytes the store writes for one credential.
 *
 * Duplicated from the implementation on purpose: the revision is a hash of the
 * file contents, so the test needs its OWN model of those contents to check the
 * revision the store reports rather than echoing it back.
 */
function payloadOf(value: CopilotAuthFile): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function revisionOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/** Windows has no POSIX mode bits, so the permission half cannot be asserted there. */
const POSIX = process.platform !== 'win32'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'copilot-auth-file-store-'))
})

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

/** A fresh credential path per case; the parent directory may or may not exist yet. */
function pathFor(seed: number, nested: boolean): string {
  const base = join(root, `case-${String(seed)}`)
  return nested ? join(base, '.copilot', 'auth.json') : join(base, 'auth.json')
}

function errorOf(value: unknown): AgentSdkError {
  expect(value).toBeInstanceOf(AgentSdkError)
  return value as AgentSdkError
}

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

// ---------------------------------------------------------------------------
// Property 20 — file-store side
// ---------------------------------------------------------------------------

/** One generated step in an interleaving of reads and commits. */
type StoreStep =
  | { kind: 'read' }
  | { kind: 'commit-current' }
  | { kind: 'commit-stale' }
  /** An out-of-band edit by another writer, which must invalidate held revisions. */
  | { kind: 'foreign-edit' }
  /** `count` commits launched together against the same base revision. */
  | { kind: 'burst'; count: number }

/**
 * Between two and five steps per case.
 *
 * Kept short deliberately: every commit is a real lock acquisition plus an
 * `fsync`, and a burst makes its losers wait out the 10 ms lock retry. The
 * property is about interleavings, and two to five steps already generate every
 * adjacency that matters across 120 seeds.
 */
function generateSteps(rng: Rng): StoreStep[] {
  const count = 2 + intBelow(rng, 4)
  return Array.from({ length: count }, () => {
    switch (pick(rng, ['read', 'commit-current', 'commit-stale', 'foreign-edit', 'burst'] as const)) {
      case 'read': return { kind: 'read' as const }
      case 'commit-current': return { kind: 'commit-current' as const }
      case 'commit-stale': return { kind: 'commit-stale' as const }
      case 'foreign-edit': return { kind: 'foreign-edit' as const }
      default: return { kind: 'burst' as const, count: 2 + intBelow(rng, 2) }
    }
  })
}

/**
 * A revision guaranteed to disagree with `expected`, so the commit must lose.
 *
 * Every candidate is a WELL-FORMED revision — a 64-character hex digest or
 * `null` — because `validateExpectedRevision` rejects empty and over-long
 * strings with a different code, and a case that tripped that gate would not
 * exercise the compare-and-swap at all.
 */
function staleRevision(rng: Rng, expected: string | null): string | null {
  const digests = [
    revisionOf('some other credential file'),
    revisionOf(`{"version":1}\n`),
    revisionOf(String(rng())),
  ]
  const candidates: readonly (string | null)[] = expected === null
    ? digests
    : [null, ...digests]
  const candidate = pick(rng, candidates)
  expect(candidate).not.toBe(expected)
  return candidate
}

describe('Feature: github-copilot-provider, Property 20: Commit đồng thời cho đúng một bên thắng', () => {
  it('lets exactly one commit per base revision win over a real file and fails the rest with the Copilot conflict code', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`
      const location = pathFor(seed, rng() < 0.5)
      const store = fileCopilotCredentialStore(location)

      // The model of what the file must hold, tracked independently of the store.
      let raw: string | undefined
      if (rng() < 0.5) {
        raw = payloadOf(file('ghu_initial'))
        await fileCopilotAuthStore(location).write(file('ghu_initial'))
      }
      let wins = 0

      const base = (): string | null => (raw === undefined ? null : revisionOf(raw))

      for (const [index, step] of generateSteps(rng).entries()) {
        const at = `${trace} step ${String(index)} ${step.kind}`
        switch (step.kind) {
          case 'read': {
            const record = await store.read(operation())
            if (raw === undefined) {
              expect(record, at).toBeUndefined()
            } else {
              // The revision is a hash of the bytes on disk, computed here from
              // the model rather than read back from the store.
              expect(record?.revision, at).toBe(revisionOf(raw))
              expect(record?.value, at).toEqual(JSON.parse(raw))
            }
            break
          }
          case 'commit-current': {
            const next = file(`ghu_${trace.replace(/\W/gu, '')}_${String(index)}`)
            const result = await store.commit(
              { value: next, expectedRevision: base() },
              operation(),
            )
            raw = payloadOf(next)
            wins += 1
            expect(result.revision, at).toBe(revisionOf(raw))
            break
          }
          case 'commit-stale': {
            const before = raw
            const caught = await store
              .commit({ value: file('ghu_stale'), expectedRevision: staleRevision(rng, base()) }, operation())
              .then(() => undefined, (error: unknown) => error)
            expect(errorOf(caught).code, at).toBe(CONFLICT_CODE)
            // A losing commit leaves the file exactly as it was — that is the
            // half of the statement a revision counter alone cannot show.
            if (before === undefined) {
              expect(await store.read(operation()), at).toBeUndefined()
            } else {
              expect(await readFile(location, 'utf8'), at).toBe(before)
            }
            break
          }
          case 'foreign-edit': {
            // Another writer touches the file. Nothing about the store changes,
            // but every revision a reader is holding is now stale, which is the
            // reason the revision hashes bytes instead of counting commits.
            const held = base()
            const edited = payloadOf(file(`ghu_foreign_${String(index)}`))
            await mkdir(dirname(location), { recursive: true, mode: 0o700 })
            await writeFile(location, edited, { encoding: 'utf8', mode: 0o600 })
            raw = edited
            const caught = await store
              .commit({ value: file('ghu_after_foreign'), expectedRevision: held }, operation())
              .then(() => undefined, (error: unknown) => error)
            expect(errorOf(caught).code, at).toBe(CONFLICT_CODE)
            expect(await readFile(location, 'utf8'), at).toBe(edited)
            break
          }
          default: {
            const expected = base()
            const values = Array.from(
              { length: step.count },
              (_unused, k) => file(`ghu_burst_${String(index)}_${String(k)}`),
            )
            const settled = await Promise.allSettled(values.map(value =>
              store.commit({ value, expectedRevision: expected }, operation())))

            const winners = settled
              .map((outcome, k) => ({ outcome, k }))
              .filter(({ outcome }) => outcome.status === 'fulfilled')
            expect(winners.length, `${at}: exactly one commit per base revision`).toBe(1)
            wins += 1

            const winner = winners[0]
            if (winner === undefined) throw new Error('unreachable: winner count asserted above')
            const won = values[winner.k]
            if (won === undefined) throw new Error('unreachable: index came from the same array')
            raw = payloadOf(won)
            const fulfilled = winner.outcome as PromiseFulfilledResult<{ revision: string }>
            expect(fulfilled.value.revision, at).toBe(revisionOf(raw))

            for (const [k, outcome] of settled.entries()) {
              if (k === winner.k) continue
              expect(outcome.status, at).toBe('rejected')
              expect(errorOf((outcome as PromiseRejectedResult).reason).code, at).toBe(CONFLICT_CODE)
            }
            break
          }
        }
      }

      // Seen from the end: the bytes on disk are the winner's bytes, and the
      // revision the store reports is the hash of exactly those bytes.
      const final = await store.read(operation())
      if (raw === undefined) {
        expect(final, trace).toBeUndefined()
        expect(wins, trace).toBe(0)
      } else {
        expect(await readFile(location, 'utf8'), trace).toBe(raw)
        expect(final?.revision, trace).toBe(revisionOf(raw))
      }

      // The lock is a sidecar file, and it must not survive the operation that
      // took it — a leaked lock would stall the next writer for 30 seconds.
      await expect(stat(`${location}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    // Explicit timeout: 120 seeds of real lock acquisitions and `fsync` calls run
    // past the 5 s default, and a burst makes its losers wait out the 10 ms lock
    // retry. The budget is generous so a slow disk cannot turn a passing property
    // into a red build.
  }, 120_000)

  it('rejects a malformed revision before it reaches the file', async () => {
    // A different code from the conflict, on purpose: an over-long or empty
    // revision is a caller bug, not a lost race.
    const store = fileCopilotCredentialStore(join(root, 'malformed', 'auth.json'))
    for (const expectedRevision of ['', 'x'.repeat(257)]) {
      const caught = await store
        .commit({ value: file(), expectedRevision }, operation())
        .then(() => undefined, (error: unknown) => error)
      expect(errorOf(caught).code).toBe('INVALID_CREDENTIAL')
      expect(errorOf(caught).code).not.toBe(CONFLICT_CODE)
    }
  })

  it('reports unreadable file contents as an invalid credential, not as a conflict', async () => {
    // Requirement 16.6 asks for the wrong-content door on this layer. What
    // `copilot-store.ts` gates today is JSON well-formedness; it does NOT gate
    // `CopilotAuthFile.version`, so no version assertion is made here.
    const location = join(root, 'not-json', 'auth.json')
    await fileCopilotAuthStore(location).write(file())
    await writeFile(location, '{ not json', { encoding: 'utf8', mode: 0o600 })
    const store = fileCopilotCredentialStore(location)
    const caught = await store.read(operation()).then(() => undefined, (error: unknown) => error)
    expect(errorOf(caught).code).toBe('INVALID_CREDENTIAL')
    expect(errorOf(caught).message).toMatch(/log in again/iu)
  })
})

// ---------------------------------------------------------------------------
// Property 22
// ---------------------------------------------------------------------------

/**
 * Modes a target file may already carry, every one of them wider than 0o600.
 *
 * All are owner-readable, because the store has to READ the file to compute the
 * revision it compares against; a mode that denied the owner a read would fail
 * on access rather than on permissions and would test nothing about this property.
 */
const WIDER_MODES = [0o601, 0o604, 0o606, 0o640, 0o644, 0o660, 0o664, 0o666, 0o755, 0o777] as const

/** Which writer performs the write; both go through the shared replace helper. */
type Writer = 'credential-store' | 'legacy-auth-store'

async function modeOf(location: string): Promise<number> {
  return (await stat(location)).mode & 0o777
}

describe('Feature: github-copilot-provider, Property 22: File credential luôn chỉ chủ sở hữu đọc và ghi', () => {
  it.skipIf(!POSIX)('leaves the file owner-read/write only after every write, including over a file that already had wider permissions', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 1_000)
      const trace = `seed ${String(seed)}`
      const nested = rng() < 0.5
      const location = pathFor(seed + 10_000, nested)
      const legacy = fileCopilotAuthStore(location)
      const store = fileCopilotCredentialStore(location)

      // Some cases start from a file that already exists with a wide mode; the
      // rest start from nothing, so the create path is covered too.
      const preexisting = rng() < 0.7
      let raw: string | undefined
      if (preexisting) {
        const initial = payloadOf(file('ghu_preexisting'))
        // Written by hand at a wide mode, the way a careless earlier version of
        // the SDK — or a user with a permissive umask — would have left it.
        await legacy.write(file('ghu_preexisting'))
        const wide = pick(rng, WIDER_MODES)
        await chmod(location, wide)
        expect(await modeOf(location), `${trace}: fixture mode`).toBe(wide)
        raw = initial
      }

      const writes = 1 + intBelow(rng, 3)
      for (let index = 0; index < writes; index += 1) {
        const at = `${trace} write ${String(index)}`
        const value = file(`ghu_${String(seed)}_${String(index)}`)
        const writer: Writer = pick(rng, ['credential-store', 'legacy-auth-store'] as const)

        if (writer === 'legacy-auth-store') {
          await legacy.write(value)
        } else {
          await store.commit(
            { value, expectedRevision: raw === undefined ? null : revisionOf(raw) },
            operation(),
          )
        }
        raw = payloadOf(value)

        // The assertion this property exists for: the real mode on disk, read
        // back from the filesystem, not the mode the helper claims to set.
        expect(await modeOf(location), `${at}: ${writer}`).toBe(0o600)
        expect(await readFile(location, 'utf8'), at).toBe(raw)

        // And re-widening between writes must not survive the next one.
        if (index + 1 < writes) await chmod(location, pick(rng, WIDER_MODES))
      }

      if (nested) {
        // The directory the store creates holds the file, so a world-readable
        // directory would undo the point of a 0o600 file. Only checked for the
        // nested paths, because those are the ones the store created itself.
        expect(await modeOf(join(location, '..')), `${trace}: directory mode`).toBe(0o700)
      }

      // No temporary file is left behind at a wider mode either: the replace
      // path writes through a sidecar, and a leaked sidecar would carry the
      // same secret.
      const entries = await readdir(join(location, '..'))
      expect(entries.filter(entry => entry.startsWith('.auth-')), `${trace}: leaked sidecars`).toEqual([])
    }
    // Same reason as Property 20 above: up to three real writes per seed across
    // 120 seeds, each one an `fsync` plus a `chmod` plus a `stat` read back.
  }, 120_000)
})
