import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/** Fail when a packed consumer installs a package at zero or multiple tree locations. */
export function assertSingleInstalledPackage(consumerRoot: string, packageName: string): void {
  const locations: string[] = []
  const visited = new Set<string>()

  const visitNodeModules = (nodeModules: string): void => {
    if (!existsSync(nodeModules)) return
    let canonical: string
    try { canonical = realpathSync(nodeModules) } catch { return }
    if (visited.has(canonical)) return
    visited.add(canonical)
    for (const row of packageDirectories(nodeModules)) {
      if (row.name === packageName) locations.push(row.root)
      visitNodeModules(join(row.root, 'node_modules'))
    }
  }

  visitNodeModules(join(consumerRoot, 'node_modules'))
  if (locations.length !== 1) {
    throw new Error(
      `expected one installed ${packageName} location; found ${locations.length}: ${locations.join(', ')}`,
    )
  }
}

function packageDirectories(nodeModules: string): Array<{ readonly name: string; readonly root: string }> {
  const result: Array<{ name: string; root: string }> = []
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const root = join(nodeModules, entry.name)
    if (entry.name.startsWith('@')) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      for (const child of readdirSync(root, { withFileTypes: true })) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue
        result.push({ name: `${entry.name}/${child.name}`, root: join(root, child.name) })
      }
      continue
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) result.push({ name: entry.name, root })
  }
  return result
}
