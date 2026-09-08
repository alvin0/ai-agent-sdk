/**
 * The search `grep_files` falls back to when ripgrep is not installed.
 *
 * The tool prefers `rg`: it is faster than anything reachable from Node and it
 * already knows how to skip binaries. But `rg` is not part of Node, and on a
 * machine without it every search died with `spawn rg ENOENT` — a message that
 * tells the model nothing it can act on, and turns a missing optional binary
 * into a broken agent. This walks the workspace instead: slower, same output
 * shape, same exclusions, and always available.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { IGNORED_DIRECTORIES } from './types.ts'
import { abortReason } from './process.ts'
import { portableRelative } from './filesystem.ts'

/** Files above this are skipped, matching the `--max-filesize 1M` passed to rg. */
const MAX_FILE_BYTES = 1024 * 1024

/** Directories never descended into, whatever the excludes say. */
const SKIPPED_DIRECTORIES = new Set([...IGNORED_DIRECTORIES, '.git'])

export interface FallbackSearchOptions {
  /** Absolute workspace root; every reported path is relative to it. */
  readonly root: string
  /** Absolute file or directory the search starts from. */
  readonly target: string
  /** Regular expression source, in the syntax the model wrote for rg. */
  readonly pattern: string
  /** rg-style exclusion globs, applied to relative paths. */
  readonly excludes: readonly string[]
  /** Optional rg-style inclusion glob. */
  readonly glob?: string
  /** Stop once this many matching lines are collected. */
  readonly maxMatches: number
  readonly signal: AbortSignal
}

/**
 * Search a workspace without ripgrep.
 * @param options - Where to look, what for, and what to skip.
 * @returns Matches as `path:line:column:text`, in the shape rg would print.
 */
export async function fallbackSearch(options: FallbackSearchOptions): Promise<string[]> {
  const expression = compile(options.pattern)
  const excluded = options.excludes
    .filter(entry => entry.startsWith('!'))
    .map(entry => globToRegExp(entry.slice(1)))
  const only = options.glob === undefined ? undefined : globToRegExp(options.glob)
  const matches: string[] = []

  for await (const file of files(options)) {
    if (matches.length >= options.maxMatches) break
    const path = portableRelative(options.root, file)
    if (excluded.some(rule => rule.test(path))) continue
    if (only !== undefined && !only.test(path)) continue
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      // Unreadable is not a failed search: rg skips what it cannot open.
      continue
    }
    // A NUL byte is how every grep decides a file is binary, and printing one
    // would put raw bytes in the model's context.
    if (text.includes('\u0000')) continue
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length && matches.length < options.maxMatches; index++) {
      if (options.signal.aborted) throw abortReason(options.signal)
      const line = lines[index] ?? ''
      expression.lastIndex = 0
      const found = expression.exec(line)
      if (found === null) continue
      matches.push(`${path}:${String(index + 1)}:${String(found.index + 1)}:${line}`)
    }
  }
  return matches
}

/**
 * Every candidate file under the target, skipping the usual noise.
 * @param options - The search options.
 * @yields Absolute file paths.
 */
async function* files(options: FallbackSearchOptions): AsyncGenerator<string> {
  const stats = await stat(options.target)
  if (stats.isFile()) {
    if (stats.size <= MAX_FILE_BYTES) yield options.target
    return
  }
  const pending = [options.target]
  while (pending.length > 0) {
    if (options.signal.aborted) throw abortReason(options.signal)
    const directory = pending.pop()
    if (directory === undefined) break
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      // A symlink is never followed: the tool's own path check confines the
      // search to the workspace, and following one would walk straight out.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path)
        continue
      }
      if (!entry.isFile()) continue
      if (relative(options.root, resolve(path)).startsWith('..')) continue
      try {
        if ((await stat(path)).size > MAX_FILE_BYTES) continue
      } catch {
        continue
      }
      yield path
    }
  }
}

/**
 * Compile the model's pattern, falling back to a literal search.
 *
 * The pattern is written for ripgrep, whose syntax is close to but not the same
 * as JavaScript's. A pattern JavaScript cannot compile is searched for
 * literally rather than reported as an error, because finding the text is more
 * useful to the model than a lecture about regex dialects.
 * @param pattern - The model's pattern.
 * @returns A global regular expression.
 */
function compile(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'g')
  } catch {
    return new RegExp(escapeRegExp(pattern), 'g')
  }
}

/**
 * Translate an rg glob into a regular expression over a relative path.
 * @param glob - The glob, without its leading `!`.
 * @returns A regular expression anchored to the whole path.
 */
function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] as string
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // A `**` segment matches any number of directories INCLUDING none, so
        // an exclusion like `dist/**` also excludes `dist/a.js`, and a leading
        // `**/` still matches a file at the root.
        index += glob[index + 2] === '/' ? 2 : 1
        source += '.*'
        continue
      }
      source += '[^/]*'
      continue
    }
    if (char === '?') { source += '[^/]'; continue }
    source += escapeRegExp(char)
  }
  return new RegExp(`^${source}$`)
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}
