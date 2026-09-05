import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrationDeclarationView } from '../../../scripts/contracts/migration-api.mts'

const roots: string[] = []
const declarationPath = 'packages/core/dist/index.d.ts'
const snapshotPath = 'design-contracts/core-capability-v1/implementation-api-I1.json'
const originalHash = 'a'.repeat(64)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sdk-i1-api-test-'))
  roots.push(root)
  mkdirSync(join(root, 'packages/core/dist'), { recursive: true })
  mkdirSync(join(root, 'design-contracts/core-capability-v1'), { recursive: true })
  const declaration = 'export declare const retained: number;\n'
  writeFileSync(join(root, declarationPath), declaration)
  writeFileSync(join(root, 'design-contracts/core-capability-v1/source-migration.json'),
    JSON.stringify({
      policy: { currentImplementationSlice: 'I1' },
      roots: { observability: { state: 'moved' }, agent: { state: 'pending' } },
    }))
  const snapshot = {
    schemaVersion: 1, slice: 'I1', sourceStates: { observability: 'moved', agent: 'pending' },
    declarationDirectories: ['packages/core/dist'],
    declarations: { [declarationPath]: createHash('sha256').update(declaration).digest('hex') },
    transitions: { '@ai-agent-sdk/core': {
      originalSha256: originalHash, declaration: declarationPath, exportDeclaration: declarationPath,
    } },
  }
  writeFileSync(join(root, snapshotPath), JSON.stringify(snapshot))
  return root
}

function verify(root: string, hash = originalHash) {
  return migrationDeclarationView(root, '@ai-agent-sdk/core', join(root, declarationPath), hash)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('phase-scoped declaration migration evidence', () => {
  it('accepts the exact reviewed closure without replacing its original baseline', () => {
    const root = fixture()
    expect(verify(root)).toBe(join(root, declarationPath))
    expect(readFileSync(join(root, snapshotPath), 'utf8')).toContain(originalHash)
  })

  it('rejects a changed original baseline', () => {
    expect(() => verify(fixture(), 'b'.repeat(64))).toThrow('invalid I1 declaration transition')
  })

  it('rejects edited declaration content', () => {
    const root = fixture()
    writeFileSync(join(root, declarationPath), 'export declare const retained: string;\n')
    expect(() => verify(root)).toThrow('emitted declaration changed')
  })

  it('rejects an added declaration sidecar', () => {
    const root = fixture()
    writeFileSync(join(root, 'packages/core/dist/unreviewed.d.ts'), 'export {};')
    expect(() => verify(root)).toThrow('closure inventory drifted')
  })

  it('rejects using an I1 snapshot after another ownership state transition', () => {
    const root = fixture()
    writeFileSync(join(root, 'design-contracts/core-capability-v1/source-migration.json'),
      JSON.stringify({
        policy: { currentImplementationSlice: 'I1' },
        roots: { observability: { state: 'moved' }, agent: { state: 'moved' } },
      }))
    expect(() => verify(root)).toThrow('I2 declaration snapshot is missing')
  })

  it('selects I2 explicitly and retains the original I1 evidence', () => {
    const root = fixture()
    const original = readFileSync(join(root, snapshotPath), 'utf8')
    const snapshot = JSON.parse(original)
    snapshot.slice = 'I2'
    snapshot.sourceStates.agent = 'moved'
    writeFileSync(join(root, snapshotPath.replace('I1', 'I2')), JSON.stringify(snapshot))
    writeFileSync(join(root, 'design-contracts/core-capability-v1/source-migration.json'),
      JSON.stringify({
        policy: { currentImplementationSlice: 'I2' },
        roots: { observability: { state: 'moved' }, agent: { state: 'moved' } },
      }))
    expect(verify(root)).toBe(join(root, declarationPath))
    expect(readFileSync(join(root, snapshotPath), 'utf8')).toBe(original)

    snapshot.sourceStates.observability = 'pending'
    writeFileSync(join(root, snapshotPath.replace('I1', 'I2')), JSON.stringify(snapshot))
    expect(() => verify(root)).toThrow('I2 declaration snapshot is stale for observability')
  })

  it('keeps a historical phase closure immutable while allowing later additive declarations', () => {
    const root = fixture()
    const snapshot = JSON.parse(readFileSync(join(root, snapshotPath), 'utf8'))
    snapshot.slice = 'I2'
    snapshot.sourceStates.agent = 'moved'
    writeFileSync(join(root, snapshotPath.replace('I1', 'I2')), JSON.stringify(snapshot))
    writeFileSync(join(root, 'design-contracts/core-capability-v1/source-migration.json'),
      JSON.stringify({
        policy: { currentImplementationSlice: 'I3' },
        roots: { observability: { state: 'moved' }, agent: { state: 'moved' } },
      }))
    writeFileSync(join(root, 'packages/core/dist/additive.d.ts'), 'export declare const additive: number;\n')

    expect(verify(root)).toBe(join(root, declarationPath))
  })

  it('rejects an invalid historical closure even after a later phase begins', () => {
    const root = fixture()
    const snapshot = JSON.parse(readFileSync(join(root, snapshotPath), 'utf8'))
    snapshot.declarations[declarationPath] = 'not-a-sha256'
    writeFileSync(join(root, snapshotPath), JSON.stringify(snapshot))
    writeFileSync(join(root, 'design-contracts/core-capability-v1/source-migration.json'),
      JSON.stringify({
        policy: { currentImplementationSlice: 'I3' },
        roots: { observability: { state: 'moved' }, agent: { state: 'pending' } },
      }))

    expect(() => verify(root)).toThrow('I1 declaration hash is invalid')
  })
})
