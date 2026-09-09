/**
 * Normalized discovery configuration for filesystem instruction files.
 *
 * @module @ai-agent-sdk/instructions-node/config
 */

export const DEFAULT_FILE_NAMES = Object.freeze(['AGENTS.override.md', 'AGENTS.md'])
export const DEFAULT_PROJECT_ROOT_MARKERS = Object.freeze(['.git'])
export const DEFAULT_MAX_BYTES = 65_536
export const DEFAULT_SECTION_ID = 'project-instructions'
/** Descendant directories retained for re-probing before every model round. */
export const DEFAULT_MAX_NESTED_DIRS = 256
/** Conversations whose nested scope one section instance remembers at once. */
export const DEFAULT_MAX_TRACKED_SCOPES = 64

const RESERVED_SEGMENTS = new Set(['', '.', '..'])

/** One tool call the loop committed, as seen by the path extractor. */
export interface InstructionToolTouch {
  readonly toolName: string
  readonly rawArguments: string
  readonly failed: boolean
}

export interface ProjectInstructionsOptions {
  /** Section id on the model surface. Defaults to `project-instructions`. */
  readonly id?: string
  /** Session working directory. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /**
   * One absolute file read before any project file — the user's own standing
   * instructions. No default: a package does not guess where a host keeps them.
   */
  readonly globalFile?: string
  /** Directory entries that stop the upward walk. Defaults to `['.git']`. */
  readonly projectRootMarkers?: readonly string[]
  /** Same-directory candidates in precedence order. Defaults to override-then-`AGENTS.md`. */
  readonly fileNames?: readonly string[]
  /**
   * `first` loads the first candidate present in a directory (Codex semantics);
   * `all` loads every present candidate (deepseek-harness semantics).
   * Defaults to `first`.
   */
  readonly perDirectory?: 'first' | 'all'
  /** Total UTF-8 ceiling for the rendered section. Defaults to 64 KiB. */
  readonly maxBytes?: number
  /** Per-file UTF-8 ceiling. Defaults to {@link ProjectInstructionsOptions.maxBytes}. */
  readonly maxFileBytes?: number
  /**
   * Also scan directories below `cwd` once a tool touches a file inside them.
   *
   * A model that opens `packages/api/handler.ts` gets `packages/api/AGENTS.md`
   * without the host having predicted the path. Defaults to true.
   */
  readonly nested?: boolean
  /**
   * Which committed tool call touched which path.
   *
   * Defaults to reading a `file_path` or `path` string from JSON arguments of a
   * call that succeeded. Replace it when your tools name the argument otherwise.
   */
  readonly filePathFromTouch?: (touch: InstructionToolTouch) => string | undefined
  /**
   * Most descendant directories kept in scope at once. Defaults to 256.
   *
   * Each retained directory is re-probed before every model round, so this
   * bounds the per-step filesystem cost of an agent that walks a large tree.
   */
  readonly maxNestedDirs?: number
  /** Called once per conversation when {@link ProjectInstructionsOptions.maxNestedDirs} is reached. */
  readonly onNestedLimit?: (limit: number) => void
  /**
   * Conversations whose accumulated subtrees this section instance remembers.
   *
   * One section object is normally mounted on a definition that many sessions
   * instantiate, so its per-conversation state is kept in a bounded map and the
   * least recently used conversation is dropped first. Defaults to 64.
   */
  readonly maxTrackedScopes?: number
  /** Leading paragraph placed above the files. A default is supplied. */
  readonly intro?: string
  /** Replaces the live node when every instruction file disappears. */
  readonly retractionText?: string
}

export interface ResolvedInstructionsConfig {
  readonly id: string
  readonly cwd: string
  readonly globalFile: string | undefined
  readonly projectRootMarkers: readonly string[]
  readonly fileNames: readonly string[]
  readonly perDirectory: 'first' | 'all'
  readonly maxBytes: number
  readonly maxFileBytes: number
  readonly nested: boolean
  readonly maxNestedDirs: number
  readonly onNestedLimit: ((limit: number) => void) | undefined
  readonly maxTrackedScopes: number
  readonly filePathFromTouch: (touch: InstructionToolTouch) => string | undefined
  readonly intro: string
  readonly retractionText: string
}

export const DEFAULT_INTRO = 'The following workspace instructions may be relevant to your work. '
  + 'Use them as guidance when applicable. More specific instructions take precedence over broader '
  + 'ones. They do not override system, developer, or direct user instructions.'

export const DEFAULT_RETRACTION = 'The workspace instructions provided earlier no longer apply. '
  + 'No instruction files are currently in scope.'

/**
 * Read a filesystem path out of one committed tool call.
 *
 * Only successful calls are considered: a failed read did not enter a
 * directory, so it must not pull that directory's instructions into context.
 * @param touch - the committed call.
 * @returns the touched path, when the arguments carry a recognizable one.
 */
export function defaultFilePathFromTouch(touch: InstructionToolTouch): string | undefined {
  if (touch.failed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(touch.rawArguments)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  // A `path` beside a `skillId` addresses a resource inside that skill's
  // bundle, not a place in the workspace. `read_skill_resource({skillId, path})`
  // would otherwise resolve `references/patterns.md` against the cwd and pull a
  // wholly unrelated directory's instructions into context.
  if (typeof record.skillId === 'string') return undefined
  for (const key of ['file_path', 'filePath', 'path']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function positiveBytes(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`)
  }
  return Math.floor(value)
}

/**
 * Apply defaults and drop candidates that are not plain file names.
 * @param options - user-facing options.
 * @param cwd - fallback working directory when none was supplied.
 * @returns the normalized configuration.
 */
export function resolveInstructionsConfig(
  options: ProjectInstructionsOptions,
  cwd: string,
): ResolvedInstructionsConfig {
  const maxBytes = positiveBytes(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes')
  const fileNames = (options.fileNames ?? DEFAULT_FILE_NAMES).filter(name => (
    !RESERVED_SEGMENTS.has(name) && !/[\\/]/.test(name)
  ))
  if (fileNames.length === 0) throw new TypeError('fileNames must contain at least one plain file name')
  return Object.freeze({
    id: options.id ?? DEFAULT_SECTION_ID,
    cwd: options.cwd ?? cwd,
    globalFile: options.globalFile,
    projectRootMarkers: Object.freeze([...options.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS]),
    fileNames: Object.freeze(fileNames),
    perDirectory: options.perDirectory ?? 'first',
    maxBytes,
    maxFileBytes: positiveBytes(options.maxFileBytes, maxBytes, 'maxFileBytes'),
    nested: options.nested ?? true,
    maxNestedDirs: positiveBytes(options.maxNestedDirs, DEFAULT_MAX_NESTED_DIRS, 'maxNestedDirs'),
    onNestedLimit: options.onNestedLimit,
    maxTrackedScopes: positiveBytes(
      options.maxTrackedScopes, DEFAULT_MAX_TRACKED_SCOPES, 'maxTrackedScopes',
    ),
    filePathFromTouch: options.filePathFromTouch ?? defaultFilePathFromTouch,
    intro: options.intro ?? DEFAULT_INTRO,
    retractionText: options.retractionText ?? DEFAULT_RETRACTION,
  })
}
