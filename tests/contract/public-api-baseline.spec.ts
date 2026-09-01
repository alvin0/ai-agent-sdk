import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

interface BaselineEntry {
  readonly exports: readonly string[]
  readonly typesSha256: string
}

interface Baseline {
  readonly schemaVersion: 1
  readonly entries: Readonly<Record<string, BaselineEntry>>
}

const root = resolve(import.meta.dirname, '../..')
const baseline = JSON.parse(await readFile(
  resolve(root, 'tests/fixtures/public-api/baseline.json'), 'utf8',
)) as Baseline
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
  readonly exports: Readonly<Record<string, { readonly types: string; readonly default: string } | string>>
}

describe('pre-monorepo public API baseline', () => {
  for (const [subpath, expected] of Object.entries(baseline.entries)) {
    it(`preserves runtime exports and declarations for ${subpath}`, async () => {
      const target = manifest.exports[subpath]
      expect(typeof target).toBe('object')
      if (typeof target !== 'object') return
      const runtime = await import(pathToFileURL(resolve(root, target.default)).href)
      const types = await readFile(resolve(root, target.types))
      expect(Object.keys(runtime).sort()).toEqual(expected.exports)
      expect(createHash('sha256').update(types).digest('hex')).toBe(expected.typesSha256)
    })
  }
})
