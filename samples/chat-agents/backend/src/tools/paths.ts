import { lstat, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage'])

/** Resolve a caller-supplied path inside `root`, refusing every escape. */
export function inRoot(root: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, absolute)
  if (rel.startsWith('..') || rel.split(sep).includes('..') || isAbsolute(rel)) {
    throw new Error(`path escapes the workspace root: ${path}`)
  }
  return absolute
}

/** Resolve the actual write target without creating parents; reject outward symlinks. */
export async function writableInRoot(root: string, path: string): Promise<{ absolute: string; relativePath: string }> {
  const target = inRoot(root, path)
  const canonicalRoot = await realpath(root)
  const existing = await closestExisting(target)
  const canonicalParent = inRoot(canonicalRoot, await realpath(existing))
  const absolute = inRoot(canonicalRoot, resolve(canonicalParent, relative(existing, target)))
  return { absolute, relativePath: relative(canonicalRoot, absolute) }
}

async function closestExisting(target: string): Promise<string> {
  let current = target
  while (true) {
    try {
      await lstat(current)
      return current
    } catch (error: unknown) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

export async function* walk(dir: string, depth: number): AsyncGenerator<string> {
  if (depth < 0) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(full, depth - 1)
    } else if (entry.isFile()) {
      yield full
    }
  }
}
