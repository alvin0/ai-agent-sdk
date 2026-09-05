import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSingleInstalledPackage } from '../../../scripts/contracts/installed-tree.mts'

const roots: string[] = []

function temporaryConsumer(): string {
  const root = mkdtempSync(join(tmpdir(), 'installed-tree-contract-'))
  roots.push(root)
  return root
}

function installDirectory(root: string, path: readonly string[]): void {
  mkdirSync(join(root, 'node_modules', ...path), { recursive: true })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('packed installed-tree contract', () => {
  it('accepts exactly one scoped package location', () => {
    const root = temporaryConsumer()
    installDirectory(root, ['@ai-agent-sdk', 'core'])
    expect(() => assertSingleInstalledPackage(root, '@ai-agent-sdk/core')).not.toThrow()
  })

  it('recursively rejects a nested normal copy', () => {
    const root = temporaryConsumer()
    installDirectory(root, ['@ai-agent-sdk', 'core'])
    installDirectory(root, ['@ai-agent-sdk', 'provider-http', 'node_modules', '@ai-agent-sdk', 'core'])
    expect(() => assertSingleInstalledPackage(root, '@ai-agent-sdk/core'))
      .toThrow(/expected one installed @ai-agent-sdk\/core location; found 2/u)
  })

  it('rejects a missing peer installation', () => {
    expect(() => assertSingleInstalledPackage(temporaryConsumer(), '@ai-agent-sdk/core'))
      .toThrow(/found 0/u)
  })
})
