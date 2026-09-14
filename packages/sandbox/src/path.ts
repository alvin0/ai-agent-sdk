/**
 * Pure, dependency-free path algebra shared by every sandbox backend.
 *
 * This package is Universal: it must never import `node:path`, so the lexical
 * rules both POSIX and Win32 backends rely on live here as string operations.
 * Filesystem-dependent resolution (realpath, existence) is injected through
 * {@link PathResolver} by the Node-elevated provider instead.
 */

/** Which lexical dialect a path is written in. */
export type PathFlavor = 'posix' | 'win32'

const WIN32_DRIVE = /^[A-Za-z]:[\\/]/
const WIN32_UNC = /^\\\\[^\\/]+[\\/][^\\/]+/

/** Detect the dialect of an absolute path from its own shape. */
export function detectFlavor(path: string): PathFlavor {
  return WIN32_DRIVE.test(path) || WIN32_UNC.test(path) ? 'win32' : 'posix'
}

/** Whether the path is absolute in either dialect. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || WIN32_DRIVE.test(path) || WIN32_UNC.test(path)
}

/**
 * Collapse separators and resolve `.` / `..` lexically, without touching the
 * filesystem. A `..` that would escape the root is dropped, matching how both
 * bwrap and Seatbelt treat an over-popped absolute path.
 */
export function normalizePath(path: string): string {
  if (path === '') return path
  const flavor = detectFlavor(path)
  const unified = flavor === 'win32' ? path.replaceAll('\\', '/') : path
  const prefix = rootPrefix(unified, flavor)
  const body = unified.slice(prefix.length)
  const resolved: string[] = []
  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (resolved.length > 0) resolved.pop()
      else if (prefix === '') resolved.push('..')
      continue
    }
    resolved.push(segment)
  }
  const joined = resolved.join('/')
  if (prefix === '') return joined === '' ? '.' : joined
  return joined === '' ? prefix : `${prefix}${joined}`
}

/** The absolute-root prefix of a path (`/`, `C:/`, `//server/share/`), or `''`. */
function rootPrefix(unified: string, flavor: PathFlavor): string {
  if (flavor === 'win32') {
    if (WIN32_DRIVE.test(unified)) return `${unified.slice(0, 2).toUpperCase()}/`
    const unc = /^\/\/[^/]+\/[^/]+/.exec(unified)
    if (unc?.[0] !== undefined) return `${unc[0]}/`
  }
  return unified.startsWith('/') ? '/' : ''
}

/** Normalized segments below the root prefix; the root itself has none. */
export function pathSegments(path: string): readonly string[] {
  const normalized = normalizePath(path)
  const prefix = rootPrefix(normalized, detectFlavor(normalized))
  const body = normalized.slice(prefix.length)
  return body === '' ? [] : body.split('/')
}

/**
 * Specificity rank used to order overlapping policy entries. A deeper path is
 * more specific, so it is applied later and wins over a broader ancestor.
 */
export function pathDepth(path: string): number {
  return pathSegments(path).length
}

/** Case-fold a normalized path for comparison under its own dialect. */
function foldCase(path: string): string {
  return detectFlavor(path) === 'win32' ? path.toLowerCase() : path
}

/** Whether two paths identify the same location lexically. */
export function samePath(left: string, right: string): boolean {
  return foldCase(normalizePath(left)) === foldCase(normalizePath(right))
}

/**
 * Whether `candidate` is `root` itself or lies beneath it. Comparison is
 * segment-wise, so `/repo-secrets` is never treated as inside `/repo`.
 */
export function containsPath(root: string, candidate: string): boolean {
  const base = foldCase(normalizePath(root))
  const target = foldCase(normalizePath(candidate))
  if (base === target) return true
  const prefix = base.endsWith('/') ? base : `${base}/`
  return target.startsWith(prefix)
}

/** Append relative segments to an absolute base, normalizing the result. */
export function joinPath(base: string, ...parts: readonly string[]): string {
  const separator = base.endsWith('/') ? '' : '/'
  return normalizePath(parts.length === 0 ? base : `${base}${separator}${parts.join('/')}`)
}

/** The parent of a normalized path, or `undefined` at a filesystem root. */
export function parentPath(path: string): string | undefined {
  const normalized = normalizePath(path)
  const prefix = rootPrefix(normalized, detectFlavor(normalized))
  if (normalized === prefix) return undefined
  const cut = normalized.lastIndexOf('/')
  if (cut < 0) return undefined
  const parent = normalized.slice(0, cut)
  return parent.length < prefix.length ? prefix : parent === '' ? prefix : parent
}

/** Every ancestor of `path` from the filesystem root down to `path` itself. */
export function ancestorPaths(path: string): readonly string[] {
  const chain: string[] = []
  let current: string | undefined = normalizePath(path)
  while (current !== undefined) {
    chain.unshift(current)
    current = parentPath(current)
  }
  return chain
}

/** Drop paths already covered by a broader entry in the same list. */
export function dedupeRoots(roots: readonly string[]): readonly string[] {
  const normalized = [...new Set(roots.map(root => normalizePath(root)))]
  normalized.sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right))
  const kept: string[] = []
  for (const root of normalized) {
    if (!kept.some(existing => containsPath(existing, root))) kept.push(root)
  }
  return Object.freeze(kept)
}
