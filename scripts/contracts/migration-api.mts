import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

interface DeclarationTransition {
  readonly originalSha256: string
  readonly declaration: string
  readonly exportDeclaration: string
}

interface ImplementationApiSnapshot {
  readonly schemaVersion: 1
  readonly slice: 'I1' | 'I2'
  readonly sourceStates: Readonly<Record<string, string>>
  readonly declarationDirectories: readonly string[]
  readonly declarations: Readonly<Record<string, string>>
  readonly transitions: Readonly<Record<string, DeclarationTransition>>
}

const IMPLEMENTATION_SLICES = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8'] as const

function sliceIndex(slice: string): number {
  const index = IMPLEMENTATION_SLICES.indexOf(slice as (typeof IMPLEMENTATION_SLICES)[number])
  if (index === -1) throw new Error(`unknown implementation slice '${slice}'`)
  return index
}

function assertHistoricalSnapshot(snapshot: ImplementationApiSnapshot): void {
  const directories = new Set(snapshot.declarationDirectories)
  if (directories.size !== snapshot.declarationDirectories.length) {
    throw new Error(`${snapshot.slice} declaration directories contain duplicates`)
  }
  for (const [file, hash] of Object.entries(snapshot.declarations)) {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`${snapshot.slice} declaration hash is invalid: ${file}`)
    }
    if (!snapshot.declarationDirectories.some(directory => file.startsWith(`${directory}/`))) {
      throw new Error(`${snapshot.slice} declaration is outside its frozen directories: ${file}`)
    }
  }
  for (const [packageName, transition] of Object.entries(snapshot.transitions)) {
    if (!/^[a-f0-9]{64}$/.test(transition.originalSha256)) {
      throw new Error(`${snapshot.slice} original hash is invalid for ${packageName}`)
    }
    if (!(transition.declaration in snapshot.declarations)
      || !(transition.exportDeclaration in snapshot.declarations)) {
      throw new Error(`${snapshot.slice} transition is outside its frozen closure for ${packageName}`)
    }
  }
}

function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Multi-entry emit may rename a shared declaration, but both routes must import the same binding. */
export function assertSharedDeclarationImport(left: string, right: string, symbol: string): void {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) throw new Error('invalid declaration symbol')
  const origin = (file: string): string => {
    const source = readFileSync(file, 'utf8')
    if (new RegExp(`^(?:declare\\s+)?(?:interface|class|type)\\s+${symbol}\\b`, 'm').test(source)) {
      throw new Error(`${symbol} must not be duplicated in ${file}`)
    }
    const bindings: string[] = []
    for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g)) {
      for (const entry of match[1]!.split(',')) {
        const names = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)
        if (names.at(-1) !== symbol) continue
        const specifier = match[2]!
        if (!specifier.startsWith('.')) throw new Error(`${symbol} must use an inward shared declaration`)
        bindings.push(`${resolve(dirname(file), specifier)}#${names[0]}`)
      }
    }
    if (bindings.length !== 1) throw new Error(`${symbol} must have exactly one canonical import in ${file}`)
    return bindings[0]!
  }
  if (origin(left) !== origin(right)) throw new Error(`${symbol} imports different declaration owners`)
}

/** Keep the pre-migration baseline intact and pin the reviewed output of an ownership move. */
export function migrationDeclarationView(
  workspace: string,
  packageName: string,
  declaration: string,
  originalSha256: string,
): string | undefined {
  const migrationFile = join(workspace, 'design-contracts/core-capability-v1/source-migration.json')
  if (!existsSync(migrationFile)) return undefined
  const migration = JSON.parse(readFileSync(migrationFile, 'utf8')) as {
    readonly policy: { readonly currentImplementationSlice?: string }
    readonly roots: Readonly<Record<string, { readonly state: string }>>
  }
  const slice = migration.roots.agent?.state === 'pending' ? 'I1' : 'I2'
  const snapshotFile = join(workspace, `design-contracts/core-capability-v1/implementation-api-${slice}.json`)
  if (slice === 'I2' && !existsSync(snapshotFile)) {
    throw new Error('I2 declaration snapshot is missing after agent ownership moved')
  }
  if (!existsSync(snapshotFile)) return undefined
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as ImplementationApiSnapshot
  assertHistoricalSnapshot(snapshot)
  const transition = snapshot.transitions[packageName]
  if (transition === undefined) return undefined
  if (snapshot.schemaVersion !== 1 || snapshot.slice !== slice
    || transition.originalSha256 !== originalSha256
    || transition.declaration !== relative(workspace, declaration).replaceAll('\\', '/')) {
    throw new Error(`invalid ${slice} declaration transition for ${packageName}`)
  }
  const currentSlice = migration.policy.currentImplementationSlice ?? slice
  const snapshotIndex = sliceIndex(snapshot.slice)
  const currentIndex = sliceIndex(currentSlice)
  if (currentIndex < snapshotIndex) {
    throw new Error(`${snapshot.slice} declaration snapshot is ahead of current slice ${currentSlice}`)
  }
  for (const [root, state] of Object.entries(snapshot.sourceStates)) {
    const currentState = migration.roots[root]?.state
    const deletedAfterBridge = currentState === 'deleted' && currentIndex >= sliceIndex('I7')
    if (currentState !== state && !deletedAfterBridge) {
      throw new Error(`${slice} declaration snapshot is stale for ${root}`)
    }
  }
  if (currentIndex === snapshotIndex) {
    const actualFiles = snapshot.declarationDirectories.flatMap(directory =>
      readdirSync(join(workspace, directory)).filter(file => file.endsWith('.d.ts'))
        .map(file => `${directory}/${file}`)).sort()
    if (JSON.stringify(actualFiles) !== JSON.stringify(Object.keys(snapshot.declarations).sort())) {
      throw new Error(`${slice} emitted declaration closure inventory drifted`)
    }
    for (const file of actualFiles) {
      if (digest(join(workspace, file)) !== snapshot.declarations[file]) {
        throw new Error(`${slice} emitted declaration changed: ${file}`)
      }
    }
  }
  const currentDeclaration = join(workspace, transition.exportDeclaration)
  if (!existsSync(currentDeclaration)) {
    throw new Error(`${slice} current export view is missing for ${packageName}`)
  }
  return currentDeclaration
}
