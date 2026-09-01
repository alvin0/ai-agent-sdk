/** Reproducible, guarded seeding for the Signal Desk multi-skill workspace. */

import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

export const SIGNAL_DESK_WORKSPACE_OWNER =
  'ai-agent-sdk/test-human/agentcode/multi-skill'
export const SIGNAL_DESK_WORKSPACE_MARKER = '.signal-desk-fixture.json'

const SCHEMA_VERSION = 1 as const
const MAX_FIXTURE_FILES = 512
const MAX_FIXTURE_FILE_BYTES = 4 * 1024 * 1024
const MAX_FIXTURE_TOTAL_BYTES = 32 * 1024 * 1024
const IGNORED_FIXTURE_DIRECTORIES = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
])

export const DEFAULT_SIGNAL_DESK_FIXTURE_ROOT = resolve(
  process.cwd(), 'test-human', 'agentcode', 'multi-skill', 'fixture',
)

export interface SignalDeskFileFact {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface SignalDeskBaseline {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly digest: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly files: readonly SignalDeskFileFact[]
}

export interface SignalDeskWorkspaceMarker {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly owner: typeof SIGNAL_DESK_WORKSPACE_OWNER
  readonly seededAt: string
  readonly baseline: SignalDeskBaseline
}

export interface SeedSignalDeskWorkspaceOptions {
  /** An explicit disposable target. Project and filesystem roots are rejected. */
  readonly workspace: string
  readonly fixtureRoot?: string
  /** Replace only a workspace carrying our valid ownership marker. */
  readonly resetOwned?: boolean
}

export interface SeedSignalDeskWorkspaceResult {
  readonly workspace: string
  readonly fixtureRoot: string
  readonly markerPath: string
  readonly baseline: SignalDeskBaseline
}

export interface HashSignalDeskTreeOptions {
  /** Treat fixture template names such as `App.tsx.seed` as `App.tsx`. */
  readonly stripSeedSuffix?: boolean
}

/**
 * Copy the immutable fixture through a same-parent staging directory.
 *
 * A non-empty target is never removed unless `resetOwned` is true and its
 * ownership marker validates. This deliberately prevents a typo from turning a
 * human test into a broad recursive delete.
 */
export async function seedSignalDeskWorkspace(
  options: SeedSignalDeskWorkspaceOptions,
): Promise<SeedSignalDeskWorkspaceResult> {
  const workspace = resolveExplicitWorkspace(options.workspace)
  const fixtureRoot = resolve(options.fixtureRoot ?? DEFAULT_SIGNAL_DESK_FIXTURE_ROOT)
  assertSafeRelationship(workspace, fixtureRoot)
  await assertPlainDirectory(fixtureRoot, 'Signal Desk fixture')
  const baseline = await hashSignalDeskTree(fixtureRoot, { stripSeedSuffix: true })

  await mkdir(dirname(workspace), { recursive: true })
  const existing = await lstat(workspace).catch(error => {
    if (isMissing(error)) return undefined
    throw error
  })
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Signal Desk workspace must be a plain directory: ${workspace}`)
    }
    const entries = await readDirectoryNames(workspace)
    if (entries.length > 0) {
      if (options.resetOwned !== true) {
        throw new Error(
          `refusing to seed non-empty Signal Desk workspace without resetOwned: ${workspace}`,
        )
      }
      await readSignalDeskWorkspaceMarker(workspace)
    }
  }

  const staging = await mkdtemp(join(dirname(workspace), '.signal-desk-seed-'))
  assertSiblingStaging(workspace, staging)
  let published = false
  try {
    // `mkdtemp` intentionally gives us an already-existing, empty target.
    await cp(fixtureRoot, staging, {
      recursive: true,
      force: true,
      filter: source => !IGNORED_FIXTURE_DIRECTORIES.has(basename(source)),
    })
    await materializeSeedFiles(staging)
    const copied = await hashSignalDeskTree(staging)
    if (copied.digest !== baseline.digest || copied.fileCount !== baseline.fileCount) {
      throw new Error('Signal Desk fixture changed while it was being copied')
    }

    const marker: SignalDeskWorkspaceMarker = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      owner: SIGNAL_DESK_WORKSPACE_OWNER,
      seededAt: new Date().toISOString(),
      baseline,
    })
    await writeFile(
      join(staging, SIGNAL_DESK_WORKSPACE_MARKER),
      `${JSON.stringify(marker, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )

    if (existing !== undefined) {
      // The target is either empty or was authenticated immediately above.
      // Recheck ownership just before a recursive reset to narrow the race.
      const currentEntries = await readDirectoryNames(workspace)
      if (currentEntries.length > 0) await readSignalDeskWorkspaceMarker(workspace)
      await rm(workspace, { recursive: true, force: false })
    }
    await rename(staging, workspace)
    published = true
  } finally {
    if (!published) {
      assertSiblingStaging(workspace, staging)
      await rm(staging, { recursive: true, force: true })
    }
  }

  return Object.freeze({
    workspace,
    fixtureRoot,
    markerPath: join(workspace, SIGNAL_DESK_WORKSPACE_MARKER),
    baseline,
  })
}

export async function readSignalDeskWorkspaceMarker(
  workspace: string,
): Promise<SignalDeskWorkspaceMarker> {
  const root = resolveExplicitWorkspace(workspace)
  const markerPath = join(root, SIGNAL_DESK_WORKSPACE_MARKER)
  const markerInfo = await lstat(markerPath).catch(error => {
    if (isMissing(error)) return undefined
    throw error
  })
  if (markerInfo === undefined || markerInfo.isSymbolicLink() || !markerInfo.isFile()) {
    throw new Error(`workspace is not owned by the Signal Desk fixture: ${root}`)
  }

  const parsed: unknown = JSON.parse(await readFile(markerPath, 'utf8'))
  if (!isSignalDeskWorkspaceMarker(parsed)) {
    throw new Error(`invalid Signal Desk ownership marker: ${markerPath}`)
  }
  return freezeMarker(parsed)
}

export async function hashSignalDeskTree(
  root: string,
  options: HashSignalDeskTreeOptions = {},
): Promise<SignalDeskBaseline> {
  const absoluteRoot = resolve(root)
  const files: SignalDeskFileFact[] = []
  await collectFiles(absoluteRoot, absoluteRoot, files, options.stripSeedSuffix === true)
  files.sort((left, right) => ordinal(left.path, right.path))
  for (let index = 1; index < files.length; index += 1) {
    if (files[index]?.path === files[index - 1]?.path) {
      throw new Error(`Signal Desk fixture has colliding template paths: ${files[index]?.path}`)
    }
  }

  const treeHash = createHash('sha256')
  let totalBytes = 0
  for (const file of files) {
    totalBytes += file.bytes
    if (totalBytes > MAX_FIXTURE_TOTAL_BYTES) {
      throw new RangeError(
        `Signal Desk fixture exceeds ${MAX_FIXTURE_TOTAL_BYTES} total bytes`,
      )
    }
    treeHash.update(file.path)
    treeHash.update('\0')
    treeHash.update(String(file.bytes))
    treeHash.update('\0')
    treeHash.update(file.sha256)
    treeHash.update('\0')
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    digest: treeHash.digest('hex'),
    fileCount: files.length,
    totalBytes,
    files: Object.freeze(files.map(file => Object.freeze({ ...file }))),
  })
}

async function collectFiles(
  root: string,
  current: string,
  output: SignalDeskFileFact[],
  stripSeedSuffix: boolean,
): Promise<void> {
  const directory = await opendir(current)
  for await (const entry of directory) {
    if (entry.name === SIGNAL_DESK_WORKSPACE_MARKER) continue
    if (entry.isDirectory() && IGNORED_FIXTURE_DIRECTORIES.has(entry.name)) continue
    const absolute = join(current, entry.name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) {
      throw new Error(`Signal Desk fixture cannot contain links: ${absolute}`)
    }
    if (info.isDirectory()) {
      await collectFiles(root, absolute, output, stripSeedSuffix)
      continue
    }
    if (!info.isFile()) {
      throw new Error(`Signal Desk fixture contains an unsupported entry: ${absolute}`)
    }
    if (info.size > MAX_FIXTURE_FILE_BYTES) {
      throw new RangeError(
        `Signal Desk fixture file exceeds ${MAX_FIXTURE_FILE_BYTES} bytes: ${absolute}`,
      )
    }
    const content = await readFile(absolute)
    const path = relative(root, absolute).split(sep).join('/')
    output.push({
      path: stripSeedSuffix && path.endsWith('.seed') ? path.slice(0, -'.seed'.length) : path,
      bytes: info.size,
      sha256: createHash('sha256').update(content).digest('hex'),
    })
    if (output.length > MAX_FIXTURE_FILES) {
      throw new RangeError(`Signal Desk fixture exceeds ${MAX_FIXTURE_FILES} files`)
    }
  }
}

async function materializeSeedFiles(current: string): Promise<void> {
  const directory = await opendir(current)
  for await (const entry of directory) {
    const absolute = join(current, entry.name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) {
      throw new Error(`Signal Desk fixture cannot contain links: ${absolute}`)
    }
    if (info.isDirectory()) {
      await materializeSeedFiles(absolute)
      continue
    }
    if (!info.isFile() || !entry.name.endsWith('.seed')) continue
    const target = absolute.slice(0, -'.seed'.length)
    const collision = await lstat(target).catch(error => {
      if (isMissing(error)) return undefined
      throw error
    })
    if (collision !== undefined) {
      throw new Error(`Signal Desk template target already exists: ${target}`)
    }
    await rename(absolute, target)
  }
}

function resolveExplicitWorkspace(value: string): string {
  if (value.trim().length === 0) throw new Error('Signal Desk workspace must be explicit')
  const absolute = resolve(value)
  const root = parse(absolute).root
  if (absolute === root || dirname(absolute) === absolute) {
    throw new Error(`refusing to use a filesystem root as Signal Desk workspace: ${absolute}`)
  }
  const cwd = resolve(process.cwd())
  if (absolute === cwd) {
    throw new Error(`refusing to use the project root as Signal Desk workspace: ${absolute}`)
  }
  return absolute
}

function assertSafeRelationship(workspace: string, fixtureRoot: string): void {
  if (containsPath(workspace, fixtureRoot) || containsPath(fixtureRoot, workspace)) {
    throw new Error('Signal Desk workspace and fixture must not contain one another')
  }
}

function containsPath(parent: string, candidate: string): boolean {
  const fromParent = relative(resolve(parent), resolve(candidate))
  return fromParent.length === 0
    || (!isAbsolute(fromParent) && fromParent !== '..' && !fromParent.startsWith(`..${sep}`))
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path).catch(error => {
    if (isMissing(error)) return undefined
    throw error
  })
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} is not a plain directory: ${path}`)
  }
}

async function readDirectoryNames(directory: string): Promise<readonly string[]> {
  const names: string[] = []
  const handle = await opendir(directory)
  for await (const entry of handle) names.push(entry.name)
  return names
}

function assertSiblingStaging(workspace: string, staging: string): void {
  if (dirname(resolve(staging)) !== dirname(resolve(workspace))) {
    throw new Error('Signal Desk staging directory must be a workspace sibling')
  }
  if (!resolve(staging).startsWith(`${dirname(resolve(workspace))}${sep}.signal-desk-seed-`)) {
    throw new Error('invalid Signal Desk staging directory')
  }
}

function isSignalDeskWorkspaceMarker(value: unknown): value is SignalDeskWorkspaceMarker {
  if (typeof value !== 'object' || value === null) return false
  const marker = value as Partial<SignalDeskWorkspaceMarker>
  return marker.schemaVersion === SCHEMA_VERSION
    && marker.owner === SIGNAL_DESK_WORKSPACE_OWNER
    && typeof marker.seededAt === 'string'
    && Number.isFinite(Date.parse(marker.seededAt))
    && isSignalDeskBaseline(marker.baseline)
}

function isSignalDeskBaseline(value: unknown): value is SignalDeskBaseline {
  if (typeof value !== 'object' || value === null) return false
  const baseline = value as Partial<SignalDeskBaseline>
  if (baseline.schemaVersion !== SCHEMA_VERSION
    || typeof baseline.digest !== 'string'
    || !/^[a-f0-9]{64}$/.test(baseline.digest)
    || !Number.isSafeInteger(baseline.fileCount)
    || (baseline.fileCount ?? -1) < 0
    || !Number.isSafeInteger(baseline.totalBytes)
    || (baseline.totalBytes ?? -1) < 0
    || !Array.isArray(baseline.files)) return false
  if (baseline.fileCount !== baseline.files.length) return false
  const paths = new Set<string>()
  let totalBytes = 0
  const valid = baseline.files.every(file => {
    if (typeof file !== 'object' || file === null) return false
    const candidate = file as Partial<SignalDeskFileFact>
    const bytes = candidate.bytes
    if (typeof candidate.path !== 'string'
      || !safeManifestPath(candidate.path)
      || paths.has(candidate.path)
      || typeof candidate.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(candidate.sha256)
      || typeof bytes !== 'number'
      || !Number.isSafeInteger(bytes)
      || bytes < 0) return false
    paths.add(candidate.path)
    totalBytes += bytes
    return Number.isSafeInteger(totalBytes)
  })
  return valid && totalBytes === baseline.totalBytes
}

function freezeMarker(marker: SignalDeskWorkspaceMarker): SignalDeskWorkspaceMarker {
  const baseline: SignalDeskBaseline = Object.freeze({
    ...marker.baseline,
    files: Object.freeze(marker.baseline.files.map(file => Object.freeze({ ...file }))),
  })
  return Object.freeze({ ...marker, baseline })
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function safeManifestPath(path: string): boolean {
  if (path.length === 0 || path.includes('\\') || path.startsWith('/')) return false
  return path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}
