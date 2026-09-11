/**
 * Post-refactor equivalence check for the generation (SSE) pipeline.
 *
 * Feature: embedding-support — Property 37.
 *
 * **Validates: Requirements 13.7, 13.9**
 *
 * Task 1.1 froze the observable behaviour of the pre-refactor
 * `packages/provider-http/src/base/http-adapter.ts` into
 * `packages/provider-http/tests/fixtures/generation-oracle/`. Task 2.1 then rewrote
 * `run()` on top of `transportStream`. This file is the gate between the two: it
 * replays every recorded case through the CURRENT pipeline and compares the
 * normalized record byte for byte against the stored oracle. A single differing
 * byte means the refactor changed something a caller can observe — the chunk
 * sequence, an error code, a `dispatchState`, the number of `attempt.end` calls, or
 * the redacted header set — and is a regression rather than a stale fixture.
 *
 * ## Why the file lives here and not where the task named it
 *
 * The task names `packages/provider-http/tests/contract/sse-equivalence.spec.ts`.
 * No runner covers that directory: `packages/provider-http/tests/` holds fixtures
 * only, and `packages/provider-http/vitest.config.ts` reaches into the ROOT `tests/`
 * tree by relative path. Root `vitest.config.ts` includes `tests/**` and the
 * `test:contract` script targets `tests/contract`, so the spec sits there beside
 * the other contract suite. Placing it under the package would give it the one
 * failure mode an equivalence gate must not have: never running.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency; the established
 * convention (see `tests/unit/provider-http/transport-session-properties.spec.ts`)
 * is a seeded mulberry32 generator, so a failure reproduces from the printed seed
 * and no test-only dependency enters the graph.
 *
 * ## What is generated
 *
 * Equivalence is not one comparison per case. The generated dimension is the SHAPE
 * OF THE REPLAY: a case replayed alone, replayed twice in a row, or replayed
 * concurrently with an unrelated case. The pipeline now shares a transport layer
 * and keeps a prepared-body cache, so "the same case in isolation" is the weakest
 * possible reading of equivalence. Repetition catches per-call state that survives
 * a stream, and interleaving catches state shared between two live streams. Every
 * run of every shape must still land on the exact stored bytes.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  generationOracleCases,
  oracleFileName,
  recordGenerationOracleCase,
  serializeOracleRecord,
  type OracleCase,
} from '../fixtures/generation-oracle.ts'

/** Number of generated replays; the spec floor is 100. */
const RUNS = 128

const ORACLE_DIR = fileURLToPath(
  new URL('../../packages/provider-http/tests/fixtures/generation-oracle/', import.meta.url),
)

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

/**
 * Walk a case list in a shuffled order so no assertion depends on enumeration
 * order, while still covering every case at least once across `runs`.
 */
function coverEvenly<T>(rng: Rng, cases: readonly T[], runs: number): T[] {
  const plan: T[] = []
  while (plan.length < runs) {
    const round = [...cases]
    for (let index = round.length - 1; index > 0; index -= 1) {
      const swap = intBelow(rng, index + 1)
      const left = round[index]
      const right = round[swap]
      if (left === undefined || right === undefined) throw new Error('shuffle out of range')
      round[index] = right
      round[swap] = left
    }
    plan.push(...round)
  }
  return plan.slice(0, runs)
}

/** The shapes a replay can take; each stresses a different kind of leaked state. */
type ReplayShape = 'alone' | 'repeated' | 'interleaved'

const REPLAY_SHAPES: readonly ReplayShape[] = ['alone', 'repeated', 'interleaved']

/**
 * Bytes of one stored oracle record, with the checkout's line endings undone.
 *
 * The recorder writes `\n`; the repository stores `\n`. On a Windows checkout with
 * `core.autocrlf=true` git hands the working tree `\r\n`, so a literal byte compare
 * would fail on every case for a reason that has nothing to do with the pipeline.
 * Undoing that one substitution is what makes the comparison a statement about
 * behaviour: every other byte, including key order and indentation, still has to
 * match exactly.
 */
function storedBytes(entry: OracleCase): Buffer {
  return Buffer.from(storedText(entry), 'utf8')
}

function storedText(entry: OracleCase): string {
  return readFileSync(join(ORACLE_DIR, oracleFileName(entry)), 'utf8').replaceAll('\r\n', '\n')
}

/** Replay one case through the current pipeline and serialize it like the recorder. */
async function replay(entry: OracleCase): Promise<string> {
  return serializeOracleRecord(await recordGenerationOracleCase(entry))
}

/**
 * Assert one replayed record against its oracle.
 *
 * The string comparison runs first purely so a failure prints a readable diff of
 * the normalized record; the byte comparison right after is the actual contract,
 * since the oracle is stored bytes and not a JavaScript value.
 */
function expectEquivalent(entry: OracleCase, replayed: string, context: string): void {
  expect(replayed, `${context}: normalized record drifted from the oracle`)
    .toBe(storedText(entry))
  expect(
    Buffer.from(replayed, 'utf8').equals(storedBytes(entry)),
    `${context}: record differs from the stored oracle bytes`,
  ).toBe(true)
}

describe('Feature: embedding-support, Property 37: Sse_Pipeline sau refactor tương đương pipeline trước refactor', () => {
  const cases = generationOracleCases()

  it(`matches the golden oracle byte for byte across ${RUNS} generated replays`, async () => {
    const rng = rngOf(0x53_53_45_37)
    const plan = coverEvenly(rng, cases, RUNS)
    const shapes = coverEvenly(rng, REPLAY_SHAPES, RUNS)
    const coveredCases = new Set<string>()
    const coveredShapes = new Set<ReplayShape>()

    for (const [run, entry] of plan.entries()) {
      const shape = shapes[run] ?? 'alone'
      const context = `${entry.provider}/${entry.scenario} replayed ${shape} (run ${run})`
      coveredCases.add(oracleFileName(entry))
      coveredShapes.add(shape)

      if (shape === 'alone') {
        expectEquivalent(entry, await replay(entry), context)
        continue
      }
      if (shape === 'repeated') {
        // A second pass over the same adapter surface must not observe anything the
        // first pass left behind: same bytes, twice.
        const first = await replay(entry)
        const second = await replay(entry)
        expectEquivalent(entry, first, `${context} pass 1`)
        expectEquivalent(entry, second, `${context} pass 2`)
        continue
      }
      // Two live streams at once, from independently built adapters. Anything shared
      // between them — a body cache, a transport session, an attempt ledger — would
      // show up as one of the two records drifting.
      const other = pick(rng, cases)
      const [mine, theirs] = await Promise.all([replay(entry), replay(other)])
      expectEquivalent(entry, mine, `${context}, interleaved with ${other.provider}/${other.scenario}`)
      expectEquivalent(other, theirs, `${other.provider}/${other.scenario} interleaved (run ${run})`)
    }

    // The generated plan is only meaningful if it actually reached every recorded
    // case and every replay shape.
    expect(coveredShapes.size).toBe(REPLAY_SHAPES.length)
    expect(coveredCases.size).toBe(cases.length)
  }, 180_000)
})
