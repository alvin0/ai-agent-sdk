import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GENERATION_ORACLE_VERSION,
  generationOracleCases,
  oracleFileName,
  recordGenerationOracleCase,
  serializeOracleRecord,
  type OracleRecord,
} from '../../fixtures/generation-oracle.ts'

const ORACLE_DIR = join(
  process.cwd(), 'packages', 'provider-http', 'tests', 'fixtures', 'generation-oracle',
)

interface OracleManifest {
  readonly schemaVersion: number
  readonly cases: readonly { readonly provider: string; readonly scenario: string; readonly file: string }[]
}

function storedFiles(): readonly string[] {
  return readdirSync(ORACLE_DIR).filter(name => name.endsWith('.json')).sort()
}

function readRecord(file: string): OracleRecord {
  return JSON.parse(readFileSync(join(ORACLE_DIR, file), 'utf8')) as OracleRecord
}

describe('Generation golden oracle', () => {
  const cases = generationOracleCases()

  it('stores exactly one record per replayable case plus a manifest', () => {
    const expected = [...cases.map(entry => oracleFileName(entry)), 'index.json'].sort()
    expect(storedFiles()).toEqual(expected)
    const manifest = JSON.parse(readFileSync(join(ORACLE_DIR, 'index.json'), 'utf8')) as OracleManifest
    expect(manifest.cases.map(entry => entry.file))
      .toEqual(cases.map(entry => oracleFileName(entry)))
  })

  it('records every fact the post-refactor equivalence check needs', () => {
    for (const entry of cases) {
      const record = readRecord(oracleFileName(entry))
      expect(record).toMatchObject({
        schemaVersion: GENERATION_ORACLE_VERSION,
        provider: entry.provider,
        scenario: entry.scenario,
        model: entry.model,
      })
      expect(Array.isArray(record.chunks)).toBe(true)
      expect(Array.isArray(record.errorCodes)).toBe(true)
      expect([...record.errorCodes].sort()).toEqual([...record.errorCodes])
      // One `attempt.end` per opened attempt, on every exit path.
      expect(record.attemptEndCalls).toBe(record.attempts.length)
      for (const attempt of record.attempts) {
        expect(['not-sent', 'sent', 'unknown']).toContain(attempt.dispatchState)
      }
      expect(record.requestHeaderNames.length).toBeGreaterThan(0)
      expect(record.redactedHeaderNames.length).toBeGreaterThan(0)
      for (const name of record.redactedHeaderNames) {
        expect(record.requestHeaderNames).toContain(name)
      }
    }
  })

  it('covers a dispatch state the wire never confirmed', () => {
    const states = new Set(cases
      .map(entry => readRecord(oracleFileName(entry)))
      .flatMap(record => record.attempts.map(attempt => attempt.dispatchState)))
    expect(states).toContain('sent')
    expect(states).toContain('unknown')
  })

  it('replays deterministically, so the stored bytes are reproducible', async () => {
    const entry = cases[0]
    if (entry === undefined) throw new Error('the oracle case list is empty')
    const first = serializeOracleRecord(await recordGenerationOracleCase(entry))
    const second = serializeOracleRecord(await recordGenerationOracleCase(entry))
    expect(first).toBe(second)
  })
})
