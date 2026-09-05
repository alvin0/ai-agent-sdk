import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSharedDeclarationImport } from '../../../scripts/contracts/migration-api.mts'

const roots: string[] = []

function fixture(right = 'import { J as AgentMessageSource } from "./registry.js";') {
  const root = mkdtempSync(join(tmpdir(), 'sdk-shared-declaration-'))
  roots.push(root)
  const leftPath = join(root, 'index.d.ts')
  const rightPath = join(root, 'agent.d.ts')
  writeFileSync(leftPath, 'import { J as AgentMessageSource } from "./registry.js";')
  writeFileSync(rightPath, right)
  return { root, leftPath, rightPath }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('canonical shared declaration identity', () => {
  it('accepts two entrypoints importing the same renamed binding', () => {
    const { leftPath, rightPath } = fixture()
    expect(() => assertSharedDeclarationImport(leftPath, rightPath, 'AgentMessageSource')).not.toThrow()
  })

  it('rejects the same local name backed by a different emitted binding', () => {
    const { leftPath, rightPath } = fixture('import { K as AgentMessageSource } from "./registry.js";')
    expect(() => assertSharedDeclarationImport(leftPath, rightPath, 'AgentMessageSource'))
      .toThrow('different declaration owners')
  })

  it('rejects a copied declaration instead of an inward import', () => {
    const { leftPath, rightPath } = fixture('interface AgentMessageSource { kind: string }')
    expect(() => assertSharedDeclarationImport(leftPath, rightPath, 'AgentMessageSource'))
      .toThrow('must not be duplicated')
  })

  it('resolves relative imports against each entrypoint before comparing owners', () => {
    const { root, leftPath } = fixture()
    mkdirSync(join(root, 'nested'))
    const nested = join(root, 'nested/agent.d.ts')
    writeFileSync(nested, 'import type { J as AgentMessageSource } from "../registry.js";')
    expect(() => assertSharedDeclarationImport(leftPath, nested, 'AgentMessageSource')).not.toThrow()
    writeFileSync(nested, 'import type { J as AgentMessageSource } from "./registry.js";')
    expect(() => assertSharedDeclarationImport(leftPath, nested, 'AgentMessageSource'))
      .toThrow('different declaration owners')
  })

  it('rejects absent, ambiguous, and public-package imports', () => {
    for (const source of [
      'export {};',
      'import { J as AgentMessageSource, K as AgentMessageSource } from "./registry.js";',
      'import { AgentMessageSource } from "@ai-agent-sdk/core";',
    ]) {
      const { leftPath, rightPath } = fixture(source)
      expect(() => assertSharedDeclarationImport(leftPath, rightPath, 'AgentMessageSource')).toThrow()
    }
  })
})
