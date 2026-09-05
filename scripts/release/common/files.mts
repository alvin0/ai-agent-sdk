import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

export function walkFiles(
  root: string,
  include: (path: string) => boolean,
): readonly string[] {
  const found: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && include(path)) found.push(path)
    }
  }
  visit(root)
  return Object.freeze(found.sort())
}

export function portableRelative(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/')
}
