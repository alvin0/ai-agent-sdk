#!/usr/bin/env node
/**
 * Write the generation golden oracle for the four official SSE providers.
 *
 * Run this BEFORE `packages/provider-http/src/base/http-adapter.ts` is refactored
 * onto the shared transport layer. The records it emits are the reference the
 * post-refactor equivalence suite compares against, so they must be produced by
 * the untouched pipeline.
 *
 * Usage:
 *   node scripts/record-generation-oracle.mts           # write records
 *   node scripts/record-generation-oracle.mts --check   # fail if records drifted
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  generationOracleCases,
  oracleFileName,
  recordGenerationOracleCase,
  serializeOracleRecord,
} from '../tests/fixtures/generation-oracle.ts'

const workspaceRoot = resolve(process.cwd())
const outputDir = join(
  workspaceRoot, 'packages', 'provider-http', 'tests', 'fixtures', 'generation-oracle',
)
const check = process.argv.slice(2).includes('--check')

const cases = generationOracleCases()
const written = new Map<string, string>()
for (const entry of cases) {
  const record = await recordGenerationOracleCase(entry)
  written.set(oracleFileName(entry), serializeOracleRecord(record))
}

const manifest = `${JSON.stringify({
  schemaVersion: 1,
  purpose: 'Pre-refactor generation (SSE) behaviour oracle for provider-http.',
  recordedBy: 'scripts/record-generation-oracle.mts',
  cases: cases.map(entry => ({
    provider: entry.provider,
    scenario: entry.scenario,
    file: oracleFileName(entry),
  })),
}, undefined, 2)}\n`
written.set('index.json', manifest)

if (check) {
  const failures: string[] = []
  let existing: readonly string[] = []
  try {
    existing = readdirSync(outputDir).filter(name => name.endsWith('.json')).sort()
  } catch {
    failures.push(`${relative(workspaceRoot, outputDir)}: oracle directory is missing`)
  }
  for (const name of [...written.keys()].sort()) {
    if (!existing.includes(name)) {
      failures.push(`${name}: recorded case has no stored oracle`)
      continue
    }
    const stored = readFileSync(join(outputDir, name), 'utf8')
    if (stored !== written.get(name)) failures.push(`${name}: stored oracle differs from replay`)
  }
  for (const name of existing) {
    if (!written.has(name)) failures.push(`${name}: stored oracle has no recorded case`)
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure)
    process.exitCode = 1
  } else {
    console.log(`generation oracle: ${cases.length} cases match the stored records`)
  }
} else {
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })
  for (const [name, contents] of written) writeFileSync(join(outputDir, name), contents)
  console.log(
    `generation oracle: wrote ${cases.length} records to ${relative(workspaceRoot, outputDir)}`,
  )
}
