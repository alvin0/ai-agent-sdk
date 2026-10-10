import { nonEmpty } from './managed-validation.ts'

export function normalizeWriteScope(value: unknown): string {
  const text = nonEmpty(value, 'worker write scope').trim().split('\\').join('/')
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) {
    throw new TypeError('a worker write scope must be workspace-relative')
  }
  const parts: string[] = []
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) throw new TypeError('a worker write scope must not escape the workspace')
      parts.pop()
    } else parts.push(part)
  }
  if (parts.length === 0) {
    throw new TypeError('a worker write scope must name a file or directory, not the whole workspace')
  }
  return parts.join('/')
}

/** Whether two normalized scopes cover any of the same files. */
export function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}
