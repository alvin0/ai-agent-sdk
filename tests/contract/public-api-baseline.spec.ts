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
  readonly schemaVersion: 3
  readonly entries: Readonly<Record<string, BaselineEntry>>
}

/** K0 declaration changes approved by docs/public-api-baseline.md. */
const K0_TYPE_HASHES: Readonly<Record<string, string>> = Object.freeze({
  '.': '18b5a649b13194636160880a010f210bbfeda51bcf9f8a03ac8df4256616aaac',
  './anthropic': 'c5fe0edd0b09bb25b53fbebbdc1fb826886aedeb48c6905b40b8a070f7d6e445',
  './openai': '2a55631d92a3e700171bd7a6325630ec444e8af90467590be8175253054c375e',
  './request-logger': '5930926691838405fd3d148afe5741fcd69c78f0d27045a0159a096ec0bb2e53',
})

const root = resolve(import.meta.dirname, '../..')
const packageRoot = resolve(root, 'packages/sdk')
const baseline = JSON.parse(await readFile(
  resolve(root, 'tests/fixtures/public-api/baseline.json'), 'utf8',
)) as Baseline
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
  readonly exports: Readonly<Record<string, { readonly types: string; readonly default: string } | string>>
}

describe('pre-monorepo public API baseline', () => {
  for (const [subpath, expected] of Object.entries(baseline.entries)) {
    it(`preserves runtime exports and declarations for ${subpath}`, async () => {
      const target = manifest.exports[subpath]
      expect(typeof target).toBe('object')
      if (typeof target !== 'object') return
      const runtime = await import(pathToFileURL(resolve(packageRoot, target.default)).href)
      const types = await readFile(resolve(packageRoot, target.types))
      const expectedExports = subpath === '.'
        ? expected.exports.filter(name => name !== 'apiKeyFromEnv')
        : expected.exports
      expect(Object.keys(runtime).sort()).toEqual(expectedExports)
      expect(createHash('sha256').update(types).digest('hex')).toBe(
        K0_TYPE_HASHES[subpath] ?? expected.typesSha256,
      )
    })
  }

  it('adds only the documented full Node facade subpath', () => {
    expect(Object.keys(manifest.exports).filter(path => !(path in baseline.entries)).sort())
      .toEqual(['./node', './package.json'])
  })
})
