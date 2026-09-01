/** Isolated, reproducible acquisition of public skills for human stress tests. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  readSkillStressSourceLock,
  skillsCliAddArguments,
  type SkillStressSource,
  type SkillStressSourceLock,
} from './sources.ts'

const DEFAULT_PROJECT_ROOT = resolve(process.cwd())
const MAX_CAPTURED_OUTPUT_CHARS = 1_000_000
const MAX_CORPUS_FILES = 4_096
const MAX_CORPUS_FILE_BYTES = 16 * 1024 * 1024
const MAX_CORPUS_TOTAL_BYTES = 128 * 1024 * 1024

export interface SkillStressCommandRequest {
  readonly command: 'npx'
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
}

export interface SkillStressCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type SkillStressCommandRunner = (
  request: SkillStressCommandRequest,
) => Promise<SkillStressCommandResult>

export interface PrepareSkillStressOptions {
  readonly projectRoot?: string
  readonly workspaceRoot?: string
  readonly lock?: SkillStressSourceLock
  readonly lockPath?: string
  readonly runner?: SkillStressCommandRunner
  readonly signal?: AbortSignal
  readonly onProgress?: (message: string) => void
}

export interface PreparedSkillStressSource {
  readonly source: SkillStressSource
  readonly directory: string
  readonly computedHash: string
  readonly fileCount: number
  readonly command: string
}

export interface PreparedSkillStressFixtures {
  /** Undefined when the verified project-local fixture cache was reused. */
  readonly stagingRoot?: string
  readonly skillsRoot: string
  readonly npmCache: string
  readonly sources: readonly PreparedSkillStressSource[]
  readonly reused: boolean
  /** Removes only this invocation's staging directory, never the fixture cache. */
  cleanup(): Promise<void>
}

export interface SkillDirectoryDigest {
  readonly computedHash: string
  readonly fileCount: number
  readonly totalBytes: number
}

export class SkillStressCommandError extends Error {
  readonly request: SkillStressCommandRequest
  readonly result: SkillStressCommandResult

  constructor(request: SkillStressCommandRequest, result: SkillStressCommandResult) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
    super(`skills CLI failed: ${detail}`)
    this.name = 'SkillStressCommandError'
    this.request = request
    this.result = result
  }
}

export async function prepareSkillStressFixtures(
  options: PrepareSkillStressOptions = {},
): Promise<PreparedSkillStressFixtures> {
  const projectRoot = resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT)
  const workspaceRoot = resolve(
    options.workspaceRoot ?? join(projectRoot, 'test-human', 'skill-stress', '.cache'),
  )
  const lock = options.lock ?? await readSkillStressSourceLock(options.lockPath)
  const runner = options.runner ?? runSkillStressCommand
  const npmCache = join(workspaceRoot, 'npm')
  const skillsRoot = join(workspaceRoot, 'skills')
  const stagingParent = join(workspaceRoot, 'staging')

  await mkdir(npmCache, { recursive: true })
  await mkdir(stagingParent, { recursive: true })

  const cached = await verifySourceSet(skillsRoot, lock).catch(() => undefined)
  if (cached !== undefined) {
    options.onProgress?.(`reuse verified skills cache: ${skillsRoot}`)
    return Object.freeze({
      skillsRoot,
      npmCache,
      sources: cached,
      reused: true,
      cleanup: async () => {},
    })
  }

  const stagingRoot = await mkdtemp(join(stagingParent, 'run-'))
  assertInside(workspaceRoot, stagingRoot, 'staging root')
  await writeStagingPackage(stagingRoot)

  try {
    for (const source of lock.sources) {
      throwIfAborted(options.signal)
      const request = createSkillStressCommandRequest(
        lock,
        source,
        stagingRoot,
        npmCache,
        options.signal,
      )
      options.onProgress?.(`acquire ${source.id}`)
      const result = await runner(request)
      if (result.exitCode !== 0) throw new SkillStressCommandError(request, result)

      const directory = join(stagingRoot, '.agents', 'skills', source.id)
      const digest = await verifyPreparedSkill(directory, source)
      options.onProgress?.(`verified ${source.id} (${digest.fileCount} files)`)
    }
  } catch (error) {
    options.onProgress?.(`staging retained for diagnosis: ${stagingRoot}`)
    throw error
  }

  const stagedSkillsRoot = join(stagingRoot, '.agents', 'skills')
  const publishParent = await mkdtemp(join(workspaceRoot, 'publish-'))
  const publishRoot = join(publishParent, 'skills')
  await cp(stagedSkillsRoot, publishRoot, { recursive: true, force: true })
  await verifySourceSet(publishRoot, lock)
  assertInside(workspaceRoot, skillsRoot, 'skills cache target')
  await rm(skillsRoot, { recursive: true, force: true })
  await rename(publishRoot, skillsRoot)
  await rm(publishParent, { recursive: true, force: true })
  const prepared = await verifySourceSet(skillsRoot, lock)

  return Object.freeze({
    stagingRoot,
    skillsRoot,
    npmCache,
    sources: prepared,
    reused: false,
    cleanup: async () => {
      assertInside(workspaceRoot, stagingRoot, 'staging cleanup target')
      await rm(stagingRoot, { recursive: true, force: true })
    },
  })
}

async function verifySourceSet(
  skillsRoot: string,
  lock: SkillStressSourceLock,
): Promise<readonly PreparedSkillStressSource[]> {
  const expectedIds = new Set(lock.sources.map(source => source.id))
  const rootEntries = await readdir(skillsRoot, { withFileTypes: true })
  const unexpected = rootEntries.filter(entry => !entry.isDirectory() || !expectedIds.has(entry.name))
  if (unexpected.length > 0) {
    throw new Error(`skills cache contains unexpected entries: ${unexpected.map(entry => entry.name).join(', ')}`)
  }
  if (rootEntries.length !== expectedIds.size) {
    throw new Error(`skills cache contains ${rootEntries.length} entries; expected ${expectedIds.size}`)
  }

  const prepared = await Promise.all(lock.sources.map(async source => {
    const directory = join(skillsRoot, source.id)
    const digest = await verifyPreparedSkill(directory, source)
    return Object.freeze({
      source,
      directory,
      computedHash: digest.computedHash,
      fileCount: digest.fileCount,
      command: ['npx', ...skillsCliAddArguments(lock, source)].map(quoteCommandArgument).join(' '),
    })
  }))
  return Object.freeze(prepared)
}

export function createSkillStressCommandRequest(
  lock: SkillStressSourceLock,
  source: SkillStressSource,
  stagingRoot: string,
  npmCache: string,
  signal?: AbortSignal,
): SkillStressCommandRequest {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    npm_config_audit: 'false',
    npm_config_cache: resolve(npmCache),
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
  }

  return Object.freeze({
    command: 'npx',
    args: skillsCliAddArguments(lock, source),
    cwd: resolve(stagingRoot),
    env: Object.freeze(env),
    ...(signal === undefined ? {} : { signal }),
  })
}

export async function runSkillStressCommand(
  request: SkillStressCommandRequest,
): Promise<SkillStressCommandResult> {
  const executable = await resolveNpxExecutable()
  const command = executable.kind === 'node' ? process.execPath : executable.path
  const args = executable.kind === 'node'
    ? [executable.path, ...request.args]
    : [...request.args]

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout = appendBounded(stdout, chunk as string) })
    child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk as string) })
    child.once('error', reject)
    child.once('close', code => {
      resolvePromise(Object.freeze({ exitCode: code ?? 1, stdout, stderr }))
    })
  })
}

export async function verifyPreparedSkill(
  directory: string,
  source: SkillStressSource,
): Promise<SkillDirectoryDigest> {
  const skillFile = join(directory, 'SKILL.md')
  const skillStats = await stat(skillFile).catch(() => undefined)
  if (!skillStats?.isFile()) throw new Error(`prepared skill ${source.id} has no SKILL.md`)

  const digest = await hashSkillDirectory(directory)
  if (digest.computedHash !== source.computedHash) {
    throw new Error(
      `prepared skill ${source.id} hash mismatch: expected ${source.computedHash}, got ${digest.computedHash}`,
    )
  }
  if (digest.fileCount !== source.fileCount) {
    throw new Error(
      `prepared skill ${source.id} file count mismatch: expected ${source.fileCount}, got ${digest.fileCount}`,
    )
  }
  return digest
}

export async function hashSkillDirectory(directory: string): Promise<SkillDirectoryDigest> {
  const root = resolve(directory)
  const files: string[] = []
  await collectSkillFiles(root, root, files)
  // Ordinal ordering keeps the digest independent of the host locale.
  files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)

  const hash = createHash('sha256')
  let totalBytes = 0
  for (const path of files) {
    const absolute = join(root, ...path.split('/'))
    const info = await stat(absolute)
    if (info.size > MAX_CORPUS_FILE_BYTES) {
      throw new RangeError(`prepared skill file '${path}' exceeds ${MAX_CORPUS_FILE_BYTES} bytes`)
    }
    totalBytes += info.size
    if (totalBytes > MAX_CORPUS_TOTAL_BYTES) {
      throw new RangeError(`prepared skill corpus exceeds ${MAX_CORPUS_TOTAL_BYTES} bytes`)
    }
    const content = await readFile(absolute)
    hash.update(path)
    hash.update(content)
  }
  return Object.freeze({
    computedHash: hash.digest('hex'),
    fileCount: files.length,
    totalBytes,
  })
}

export function formatSkillStressCommand(request: SkillStressCommandRequest): string {
  return [request.command, ...request.args].map(quoteCommandArgument).join(' ')
}

async function collectSkillFiles(
  root: string,
  current: string,
  files: string[],
): Promise<void> {
  const directory = await opendir(current)
  for await (const entry of directory) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) {
      await collectSkillFiles(root, absolute, files)
      continue
    }
    if (!entry.isFile()) continue
    const path = relative(root, absolute).split(sep).join('/')
    files.push(path)
    if (files.length > MAX_CORPUS_FILES) {
      throw new RangeError(`prepared skill corpus exceeds ${MAX_CORPUS_FILES} files`)
    }
  }
}

async function writeStagingPackage(stagingRoot: string): Promise<void> {
  const content = `${JSON.stringify({
    name: 'ai-agent-sdk-skill-stress-staging',
    private: true,
    type: 'module',
  }, null, 2)}\n`
  await writeFile(join(stagingRoot, 'package.json'), content, { encoding: 'utf8', flag: 'wx' })
}

async function resolveNpxExecutable(): Promise<
  { readonly kind: 'node'; readonly path: string } | { readonly kind: 'direct'; readonly path: string }
> {
  const npmExecPath = process.env.npm_execpath
  const candidates = [
    ...(npmExecPath === undefined ? [] : [join(dirname(npmExecPath), 'npx-cli.js')]),
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ]
  for (const candidate of candidates) {
    const candidateStats = await stat(candidate).catch(() => undefined)
    if (candidateStats?.isFile()) return { kind: 'node', path: candidate }
  }
  if (process.platform === 'win32') {
    throw new Error('Cannot locate npm/bin/npx-cli.js on Windows')
  }
  return { kind: 'direct', path: 'npx' }
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk
  return combined.length <= MAX_CAPTURED_OUTPUT_CHARS
    ? combined
    : combined.slice(combined.length - MAX_CAPTURED_OUTPUT_CHARS)
}

function assertInside(root: string, target: string, label: string): void {
  const relativePath = relative(resolve(root), resolve(target))
  if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} must be a child of the skill-stress workspace`)
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('skill acquisition aborted')
}

function quoteCommandArgument(value: string): string {
  return /^[A-Za-z0-9_./:@#=-]+$/.test(value) ? value : JSON.stringify(value)
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url
}

if (isMainModule()) {
  prepareSkillStressFixtures({
    onProgress: message => console.log(`[skill-stress/prepare] ${message}`),
  }).then(async result => {
    console.log(`[skill-stress/prepare] skills root: ${result.skillsRoot}`)
    console.log(`[skill-stress/prepare] npm cache: ${result.npmCache}`)
    console.log(`[skill-stress/prepare] reused: ${result.reused}`)
    await result.cleanup()
  }).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
