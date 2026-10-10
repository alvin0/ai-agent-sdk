import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage'])

/** Resolve a caller-supplied path inside `root`, refusing every escape. */
export function inRoot(root: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, absolute)
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error(`path escapes the workspace root: ${path}`)
  }
  return absolute
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
