import { existsSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { importsInFile, isWithin, listCodeFiles } from './package-policy.mts'

export interface SourceGraphResult {
  readonly groups: number
  readonly edges: number
  readonly cycles: readonly string[]
  readonly dependencyFirstGroups: readonly string[]
  readonly dependenciesByGroup: Readonly<Record<string, readonly string[]>>
}

function resolveSourceTarget(importer: string, specifier: string): string | undefined {
  const direct = resolve(dirname(importer), specifier)
  const candidates = extname(direct)
    ? [direct]
    : [direct, `${direct}.ts`, `${direct}.tsx`, `${direct}.mts`, join(direct, 'index.ts'), join(direct, 'index.tsx')]
  return candidates.find((candidate) => existsSync(candidate))
}

function ownerGroup(sourceRoot: string, path: string): string {
  const pathParts = relative(sourceRoot, path).split(sep)
  return pathParts.length > 1 ? (pathParts[0] ?? '(root)') : '(root)'
}

/** Builds a first-level ownership graph and includes `import type`/`export type` edges. */
export function analyzeSourceOwnershipGraph(sourceRoot: string): SourceGraphResult {
  const root = resolve(sourceRoot)
  const graph = new Map<string, Set<string>>()
  for (const file of listCodeFiles(root)) {
    const from = ownerGroup(root, file)
    if (!graph.has(from)) graph.set(from, new Set())
    for (const imported of importsInFile(file)) {
      if (!imported.specifier.startsWith('.')) continue
      const target = resolveSourceTarget(file, imported.specifier)
      if (!target || !isWithin(target, root)) continue
      const to = ownerGroup(root, target)
      if (!graph.has(to)) graph.set(to, new Set())
      if (from !== to) graph.get(from)?.add(to)
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const path: string[] = []
  const cycles = new Set<string>()
  const dependencyFirstGroups: string[] = []
  const visit = (group: string): void => {
    if (visiting.has(group)) {
      const start = path.indexOf(group)
      cycles.add([...path.slice(start), group].join(' -> '))
      return
    }
    if (visited.has(group)) return
    visiting.add(group)
    path.push(group)
    for (const target of graph.get(group) ?? []) visit(target)
    path.pop()
    visiting.delete(group)
    visited.add(group)
    dependencyFirstGroups.push(group)
  }
  for (const group of graph.keys()) visit(group)
  return {
    groups: graph.size,
    edges: [...graph.values()].reduce((total, targets) => total + targets.size, 0),
    cycles: [...cycles].sort(),
    dependencyFirstGroups,
    dependenciesByGroup: Object.fromEntries(
      [...graph.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([group, dependencies]) => [group, [...dependencies].sort()]),
    ),
  }
}
