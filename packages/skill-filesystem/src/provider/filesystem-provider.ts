/** Node-only Agent Skills folder discovery. */

import type { Dirent } from 'node:fs'
import { access, open, opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'
import {
  MAX_SKILL_RESOURCE_CHARS,
  MAX_SKILL_INSTRUCTIONS_CHARS,
  defineSkill,
  defineSkillProvider,
  type SkillCandidate,
  type SkillDefinition,
  type SkillDefinitionInput,
  type SkillInvocationPolicy,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderListOptions,
  type SkillResourceSummary,
} from '@ai-agent-sdk/core/skills'
import {
  validateCandidate,
  validateSkillResourcePath,
} from '@ai-agent-sdk/core/skills'

const TEXT_RESOURCE_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.ts', '.tsx', '.js', '.mjs', '.cjs',
  '.py', '.sh', '.ps1',
])
const MAX_RESOURCES = 256
const DEFAULT_MAX_CANDIDATES = 1_024
const DEFAULT_MAX_ROOT_ENTRIES = 4_096
const MAX_MANIFEST_ENTRIES = 4_096
const MAX_MANIFEST_DEPTH = 16
const IGNORED_RESOURCE_DIRECTORIES = new Set(['.git', 'node_modules'])
const READ_CHUNK_BYTES = 8 * 1024
const MAX_FRONT_MATTER_BYTES = 64 * 1024
const MAX_OPENAI_METADATA_BYTES = 64 * 1024
const MAX_OPENAI_METADATA_DEPTH = 16
const MAX_OPENAI_METADATA_NODES = 4_096
const MAX_SKILL_FILE_BYTES = MAX_FRONT_MATTER_BYTES + MAX_SKILL_INSTRUCTIONS_CHARS * 4
const MAX_RESOURCE_FILE_BYTES = MAX_SKILL_RESOURCE_CHARS * 4

export interface FileSystemSkillRoot {
  readonly path: string
  readonly source?: string
}

export type FileSystemSkillIoPhase = 'discovery' | 'activation' | 'resource'

/** Optional byte-level telemetry for acceptance tests and host diagnostics. */
export interface FileSystemSkillIoEvent {
  readonly phase: FileSystemSkillIoPhase
  readonly operation: 'read' | 'scan'
  readonly path: string
  readonly skillId?: string
  readonly bytesRead: number
  readonly entriesScanned?: number
}

export interface FileSystemSkillsOptions {
  /** Provider identity used in catalogs and diagnostics. Defaults to filesystem. */
  readonly id?: string
  /** Exact ordered roots. Earlier roots win duplicate ids. */
  readonly roots?: readonly (string | FileSystemSkillRoot)[]
  /** Base for automatic project discovery. Defaults to lookup cwd, then process.cwd(). */
  readonly cwd?: string
  /** Scan `.agents/skills` from cwd through the git root. Defaults to true when roots are omitted. */
  readonly includeProjectAgents?: boolean
  /** Also scan `.dsh/skills` along the same project chain. Defaults to false. */
  readonly includeProjectDsh?: boolean
  /** Add `$HOME/.agents/skills` after project roots. Defaults to false for hermetic SDK usage. */
  readonly includeUserAgents?: boolean
  /** Hard cap for metadata candidates retained by one provider. Defaults to 1024. */
  readonly maxCandidates?: number
  /** Hard cap for directory entries scanned per discovery root. Defaults to 4,096. */
  readonly maxRootEntries?: number
  /** Observe bounded filesystem I/O without changing discovery semantics. */
  readonly onIo?: (event: FileSystemSkillIoEvent) => void
}

interface ResolvedRoot {
  readonly path: string
  readonly source: string
}

interface FileLocator {
  readonly skillFile: string
  readonly directory: string
}

interface ParsedSkillFile {
  readonly input: SkillDefinitionInput
}

/**
 * Create a lazy filesystem provider. Discovery runs before each agent turn, so
 * a CLI sees newly added or edited skill folders without rebuilding the agent.
 */
export function fileSystemSkills(options: FileSystemSkillsOptions = {}): SkillProvider {
  const id = options.id ?? 'filesystem'
  const maxCandidates = boundedInteger(
    options.maxCandidates, DEFAULT_MAX_CANDIDATES, 1, 10_000, 'maxCandidates',
  )
  const maxRootEntries = boundedInteger(
    options.maxRootEntries, DEFAULT_MAX_ROOT_ENTRIES, 1, 100_000, 'maxRootEntries',
  )
  const issued = new WeakSet<object>()
  return defineSkillProvider({
    kind: 'skill-provider',
    id,
    async list(lookup) {
      const allowed = lookup.allowedSkillIds === undefined
        ? undefined
        : new Set(lookup.allowedSkillIds)
      if (allowed?.size === 0) return Object.freeze([])
      const roots = await resolveRoots(options, lookup)
      const candidates = new Map<string, SkillCandidate>()
      for (const root of roots) {
        for (const locator of await discoverRoot(root.path, maxRootEntries, lookup.signal, options.onIo)) {
          const candidate = await parseSkillMetadata(
            locator, root.source, id, lookup.signal, options.onIo,
          )
          if (allowed !== undefined && !allowed.has(candidate.id)) continue
          if (candidates.has(candidate.id)) continue
          if (candidates.size >= maxCandidates) {
            throw new RangeError(`skill provider '${id}' discovered more than ${maxCandidates} candidates`)
          }
          candidates.set(candidate.id, candidate)
          issued.add(candidate)
        }
      }
      return Object.freeze([...candidates.values()])
    },
    async load(candidate, lookup) {
      assertIssuedCandidate(issued, candidate, id)
      const locator = asLocator(candidate.locator, candidate.id)
      return (await parseSkillFile(
        locator, candidate.id, candidate.source, id, lookup.signal, options.onIo,
      )).input
    },
    async readResource(candidate, path, lookup) {
      assertIssuedCandidate(issued, candidate, id)
      const locator = asLocator(candidate.locator, candidate.id)
      return await readResource(locator, candidate.id, path, lookup.signal, options.onIo)
    },
  })
}

/** Eager convenience for CLIs that want definitions rather than a live provider. */
export async function discoverFileSystemSkills(
  options: FileSystemSkillsOptions & SkillProviderListOptions = {},
): Promise<readonly SkillDefinition[]> {
  const provider = fileSystemSkills(options)
  const lookup = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.allowedSkillIds === undefined ? {} : { allowedSkillIds: options.allowedSkillIds }),
  }
  const candidates = await provider.list(lookup)
  const definitions: SkillDefinition[] = []
  for (const candidate of candidates) {
    const input = await provider.load(candidate, lookup)
    if (input !== undefined) definitions.push(defineSkill(input))
  }
  return Object.freeze(definitions)
}

async function resolveRoots(
  options: FileSystemSkillsOptions,
  lookup: SkillLookupOptions,
): Promise<readonly ResolvedRoot[]> {
  if (options.roots !== undefined) {
    return Object.freeze(options.roots.map((root, index) => typeof root === 'string'
      ? { path: resolve(root), source: `custom-${index + 1}` }
      : { path: resolve(root.path), source: root.source ?? `custom-${index + 1}` }))
  }
  const cwd = resolve(lookup.cwd ?? options.cwd ?? process.cwd())
  const projectRoot = await findProjectRoot(cwd)
  const roots: ResolvedRoot[] = []
  if (options.includeProjectAgents ?? true) {
    roots.push(...ancestorSkillRoots(cwd, projectRoot, '.agents/skills', 'project-agents'))
  }
  if (options.includeProjectDsh ?? false) {
    roots.push(...ancestorSkillRoots(cwd, projectRoot, '.dsh/skills', 'project-dsh'))
  }
  if (options.includeUserAgents ?? false) {
    roots.push({ path: join(homedir(), '.agents', 'skills'), source: 'user-agents' })
  }
  return Object.freeze(roots)
}

function ancestorSkillRoots(
  cwd: string,
  projectRoot: string,
  suffix: string,
  source: string,
): ResolvedRoot[] {
  const roots: ResolvedRoot[] = []
  let current = cwd
  while (true) {
    roots.push({ path: join(current, suffix), source })
    if (samePath(current, projectRoot)) break
    const parent = dirname(current)
    if (parent === current || !isInside(projectRoot, parent)) break
    current = parent
  }
  return roots
}

async function findProjectRoot(cwd: string): Promise<string> {
  let current = cwd
  while (true) {
    try { await access(join(current, '.git')); return current }
    catch { /* keep walking */ }
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

async function discoverRoot(
  root: string,
  maxEntries: number,
  signal: AbortSignal | undefined,
  onIo: FileSystemSkillsOptions['onIo'],
): Promise<FileLocator[]> {
  throwIfAborted(signal)
  let canonicalRoot: string
  try { canonicalRoot = await realpath(root) }
  catch (error: unknown) {
    if (isMissing(error)) return []
    throw error
  }
  const entries = await readDirectoryBounded(canonicalRoot, maxEntries, signal, 'skill discovery root')
  emitIo(onIo, {
    phase: 'discovery', operation: 'scan', path: canonicalRoot,
    bytesRead: 0, entriesScanned: entries.length,
  })
  const locators: FileLocator[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    throwIfAborted(signal)
    const entryPath = join(canonicalRoot, entry.name)
    let directory: string
    try {
      const info = entry.isDirectory() ? undefined : await stat(entryPath)
      if (!entry.isDirectory() && info?.isDirectory() !== true) continue
      directory = await realpath(entryPath)
    } catch (error: unknown) {
      if (isMissing(error)) continue
      throw error
    }
    const skillFile = join(directory, 'SKILL.md')
    try { await access(skillFile) }
    catch { continue }
    locators.push({ skillFile, directory })
  }
  return locators
}

async function parseSkillFile(
  locator: FileLocator,
  skillId: string,
  source: string,
  provider: string,
  signal: AbortSignal | undefined,
  onIo: FileSystemSkillsOptions['onIo'],
): Promise<ParsedSkillFile> {
  throwIfAborted(signal)
  const contents = normalize(await readTextFileBounded(
    locator.skillFile, MAX_SKILL_FILE_BYTES, `skill '${locator.skillFile}'`, signal,
    onIo, { phase: 'activation', skillId },
  ))
  const { fields, body, metadata } = parseFrontMatter(contents, locator.skillFile)
  const id = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  const whenToUse = fields.get('metadata.when_to_use')
  const allowImplicit = await readImplicitPolicy(
    locator.directory, signal, 'activation', onIo, skillId,
  )
  const invocation: SkillInvocationPolicy = {
    modelInvocable: booleanField(fields, 'disable-model-invocation', false) !== true
      && allowImplicit !== false,
    userInvocable: booleanField(fields, 'user-invocable', true),
  }
  const resourceManifest = await discoverResourceManifest(locator, signal, onIo, skillId)
  return {
    input: {
      id,
      name: fields.get('display-name') ?? id,
      description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      instructions: body,
      resourceManifest,
      invocation,
      source,
      provider,
      resourceBase: { kind: 'directory', value: locator.directory },
      path: locator.skillFile,
      metadata,
    },
  }
}

async function parseSkillMetadata(
  locator: FileLocator,
  source: string,
  provider: string,
  signal: AbortSignal | undefined,
  onIo: FileSystemSkillsOptions['onIo'],
): Promise<SkillCandidate> {
  const frontMatter = await readFrontMatter(locator.skillFile, signal, onIo)
  const fileRevision = await stat(locator.skillFile)
  const { fields } = parseFrontMatter(frontMatter, locator.skillFile)
  const id = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  const whenToUse = fields.get('metadata.when_to_use')
  const allowImplicit = await readImplicitPolicy(
    locator.directory, signal, 'discovery', onIo, id,
  )
  const candidate: SkillCandidate = Object.freeze({
    id,
    name: fields.get('display-name') ?? id,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    invocation: Object.freeze({
      modelInvocable: booleanField(fields, 'disable-model-invocation', false) !== true
        && allowImplicit !== false,
      userInvocable: booleanField(fields, 'user-invocable', true),
    }),
    source,
    provider,
    resourceBase: Object.freeze({ kind: 'directory' as const, value: locator.directory }),
    locator: Object.freeze({
      ...locator,
      revision: Object.freeze({ sizeBytes: fileRevision.size, modifiedMs: fileRevision.mtimeMs }),
    }),
    path: locator.skillFile,
  })
  validateCandidate(candidate, provider)
  return candidate
}

function parseFrontMatter(
  contents: string,
  path: string,
): { fields: Map<string, string>; body: string; metadata: Readonly<Record<string, unknown>> } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(contents)
  if (match === null) throw new Error(`skill '${path}' must start with YAML front matter`)
  const fields = new Map<string, string>()
  let section = ''
  for (const line of (match[1] ?? '').split('\n')) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const indented = /^\s/.test(line)
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    if (!indented && raw.length === 0) { section = key; continue }
    fields.set(indented && section.length > 0 ? `${section}.${key}` : key, unquote(raw))
  }
  return {
    fields,
    body: contents.slice(match[0].length).trim(),
    metadata: Object.freeze(Object.fromEntries(fields)),
  }
}

async function readImplicitPolicy(
  directory: string,
  signal: AbortSignal | undefined,
  phase: Exclude<FileSystemSkillIoPhase, 'resource'>,
  onIo: FileSystemSkillsOptions['onIo'],
  skillId: string,
): Promise<boolean | undefined> {
  throwIfAborted(signal)
  try {
    const path = join(directory, 'agents', 'openai.yaml')
    const contents = normalize(await readTextFileBounded(
      path, MAX_OPENAI_METADATA_BYTES, `skill metadata '${path}'`, signal,
      onIo, { phase, skillId },
    ))
    const document = parseDocument(contents, { strict: true, uniqueKeys: true })
    if (document.errors.length > 0) {
      throw new TypeError(`skill metadata '${path}' is invalid YAML: ${document.errors[0]?.message ?? 'parse failed'}`)
    }
    let value: unknown
    try { value = document.toJS({ maxAliasCount: 0 }) }
    catch (error: unknown) {
      throw new TypeError(`skill metadata '${path}' contains unsupported YAML aliases`, { cause: error })
    }
    assertMetadataBounds(value, path)
    if (value === null || value === undefined) return undefined
    if (!isStringRecord(value)) throw new TypeError(`skill metadata '${path}' must be a YAML mapping`)
    const policy = value.policy
    if (policy === undefined) {
      if (containsImplicitPolicyKey(value)) {
        throw new TypeError(`skill metadata '${path}' must place allow_implicit_invocation under policy`)
      }
      return undefined
    }
    if (!isStringRecord(policy)) throw new TypeError(`skill metadata '${path}' policy must be a YAML mapping`)
    const allowImplicit = policy.allow_implicit_invocation
    if (allowImplicit === undefined) {
      if (containsImplicitPolicyKey(value)) {
        throw new TypeError(`skill metadata '${path}' has an invalid allow_implicit_invocation policy`)
      }
      return undefined
    }
    if (typeof allowImplicit !== 'boolean') {
      throw new TypeError(`skill metadata '${path}' policy.allow_implicit_invocation must be true or false`)
    }
    return allowImplicit
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function assertMetadataBounds(value: unknown, path: string): void {
  let nodes = 0
  const visit = (current: unknown, depth: number): void => {
    nodes++
    if (nodes > MAX_OPENAI_METADATA_NODES) {
      throw new RangeError(`skill metadata '${path}' exceeds ${MAX_OPENAI_METADATA_NODES} YAML nodes`)
    }
    if (depth > MAX_OPENAI_METADATA_DEPTH) {
      throw new RangeError(`skill metadata '${path}' exceeds YAML depth ${MAX_OPENAI_METADATA_DEPTH}`)
    }
    if (Array.isArray(current)) { for (const item of current) visit(item, depth + 1); return }
    if (isStringRecord(current)) { for (const item of Object.values(current)) visit(item, depth + 1) }
  }
  visit(value, 0)
}

function containsImplicitPolicyKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImplicitPolicyKey)
  if (!isStringRecord(value)) return false
  return Object.prototype.hasOwnProperty.call(value, 'allow_implicit_invocation')
    || Object.values(value).some(containsImplicitPolicyKey)
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function discoverResourceManifest(
  locator: FileLocator,
  signal: AbortSignal | undefined,
  onIo: FileSystemSkillsOptions['onIo'],
  skillId: string,
): Promise<readonly SkillResourceSummary[]> {
  const resources: SkillResourceSummary[] = []
  const pending = [{ directory: locator.directory, depth: 0 }]
  let scannedEntries = 0
  try {
    while (pending.length > 0) {
      throwIfAborted(signal)
      const current = pending.pop()
      if (current === undefined) break
      const { directory, depth } = current
      const entries = await readDirectoryBounded(
        directory,
        MAX_MANIFEST_ENTRIES - scannedEntries,
        signal,
        `skill '${basename(locator.directory)}' resource tree`,
      )
      for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
        throwIfAborted(signal)
        scannedEntries++
        if (scannedEntries > MAX_MANIFEST_ENTRIES) {
          throw new RangeError(
            `skill '${basename(locator.directory)}' resource tree exceeds ${MAX_MANIFEST_ENTRIES} entries`,
          )
        }
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (IGNORED_RESOURCE_DIRECTORIES.has(entry.name)) continue
          if (depth >= MAX_MANIFEST_DEPTH) {
            throw new RangeError(
              `skill '${basename(locator.directory)}' resource tree exceeds depth ${MAX_MANIFEST_DEPTH}`,
            )
          }
          pending.push({ directory: path, depth: depth + 1 })
          continue
        }
        if (!entry.isFile() || !TEXT_RESOURCE_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase())) continue
        const key = relative(locator.directory, path).split(sep).join('/')
        if (key === 'SKILL.md' || key === 'agents/openai.yaml') continue
        if (resources.length >= MAX_RESOURCES) {
          throw new RangeError(`skill '${basename(locator.directory)}' has more than ${MAX_RESOURCES} text resources`)
        }
        const info = await stat(path)
        resources.push(Object.freeze({ path: key, sizeBytes: info.size }))
      }
    }
  } finally {
    emitIo(onIo, {
      phase: 'activation', operation: 'scan', path: locator.directory,
      skillId, bytesRead: 0, entriesScanned: scannedEntries,
    })
  }
  return Object.freeze(resources.sort((left, right) => left.path.localeCompare(right.path)))
}

async function readDirectoryBounded(
  directory: string,
  maxEntries: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Dirent[]> {
  if (maxEntries < 1) throw new RangeError(`${label} exceeds its entry limit`)
  const handle = await opendir(directory)
  const entries: Dirent[] = []
  try {
    for await (const entry of handle) {
      throwIfAborted(signal)
      if (entries.length >= maxEntries) {
        throw new RangeError(`${label} exceeds ${maxEntries} entries`)
      }
      entries.push(entry)
    }
  } finally {
    // Async iteration closes the handle. Some runtimes also reject a second
    // explicit close, so only close when iteration was interrupted and ignore
    // the already-closed case.
    await handle.close().catch(() => undefined)
  }
  return entries
}

async function readResource(
  locator: FileLocator,
  skillId: string,
  resourcePath: string,
  signal: AbortSignal | undefined,
  onIo: FileSystemSkillsOptions['onIo'],
): Promise<string | undefined> {
  validateSkillResourcePath(resourcePath, skillId)
  if (!TEXT_RESOURCE_EXTENSIONS.has(extname(resourcePath).toLocaleLowerCase())) return undefined
  const requested = resolve(locator.directory, ...resourcePath.split('/'))
  if (!isInside(locator.directory, requested)) return undefined
  let canonical: string
  try { canonical = await realpath(requested) }
  catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
  if (!isInside(locator.directory, canonical)) return undefined
  const info = await stat(canonical)
  if (!info.isFile()) return undefined
  return normalize(await readTextFileBounded(
    canonical, MAX_RESOURCE_FILE_BYTES, `skill resource '${resourcePath}'`, signal,
    onIo, { phase: 'resource', skillId },
  )).trim()
}

async function readFrontMatter(
  path: string,
  signal: AbortSignal | undefined,
  onIo: FileSystemSkillsOptions['onIo'],
): Promise<string> {
  throwIfAborted(signal)
  const handle = await open(path, 'r')
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (total < MAX_FRONT_MATTER_BYTES) {
      throwIfAborted(signal)
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_FRONT_MATTER_BYTES - total))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
      const prefix = normalize(Buffer.concat(chunks, total).toString('utf8'))
      const match = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(prefix)
      if (match !== null) {
        emitIo(onIo, { phase: 'discovery', operation: 'read', path, bytesRead: total })
        return match[0]
      }
    }
  } finally {
    await handle.close()
  }
  emitIo(onIo, { phase: 'discovery', operation: 'read', path, bytesRead: total })
  throw new RangeError(
    `skill '${path}' front matter is missing its closing delimiter within ${MAX_FRONT_MATTER_BYTES} bytes`,
  )
}

async function readTextFileBounded(
  path: string,
  maxBytes: number,
  label: string,
  signal: AbortSignal | undefined,
  onIo?: FileSystemSkillsOptions['onIo'],
  context?: { readonly phase: FileSystemSkillIoPhase; readonly skillId?: string },
): Promise<string> {
  throwIfAborted(signal)
  const handle = await open(path, 'r')
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      throwIfAborted(signal)
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) throw new RangeError(`${label} exceeds ${maxBytes} bytes`)
      chunks.push(buffer.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, total).toString('utf8')
  } finally {
    await handle.close()
    if (context !== undefined) {
      emitIo(onIo, {
        phase: context.phase, operation: 'read', path,
        ...(context.skillId === undefined ? {} : { skillId: context.skillId }),
        bytesRead: total,
      })
    }
  }
}

function emitIo(
  listener: FileSystemSkillsOptions['onIo'],
  event: FileSystemSkillIoEvent,
): void {
  try { listener?.(Object.freeze(event)) }
  catch { /* Diagnostics must not change skill-loading behavior. */ }
}

function asLocator(value: unknown, skillId: string): FileLocator {
  if (typeof value !== 'object' || value === null
    || typeof (value as FileLocator).skillFile !== 'string'
    || typeof (value as FileLocator).directory !== 'string') {
    throw new TypeError(`filesystem skill '${skillId}' has an invalid locator`)
  }
  return value as FileLocator
}

function assertIssuedCandidate(
  issued: WeakSet<object>, candidate: SkillCandidate, providerId: string,
): void {
  if (!issued.has(candidate)) {
    throw new TypeError(`skill provider '${providerId}' received a candidate it did not issue`)
  }
}

function booleanField(fields: ReadonlyMap<string, string>, key: string, fallback: boolean): boolean {
  const value = fields.get(key)
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new TypeError(`skill front matter '${key}' must be true or false`)
}

function normalize(value: string): string { return value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') }
function unquote(value: string): string {
  const match = /^(["'])([\s\S]*)\1$/.exec(value)
  return match?.[2] ?? value
}
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right
}
function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path.length === 0 || (!path.startsWith('..') && !isAbsolute(path))
}
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason ?? new Error('skill discovery aborted')
}

function boundedInteger(
  value: number | undefined, fallback: number, min: number, max: number, name: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`)
  }
  return resolved
}
