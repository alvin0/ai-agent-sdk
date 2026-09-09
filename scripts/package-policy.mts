import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

export type RuntimeKind = 'universal' | 'browser' | 'node' | 'mixed'

export interface PackageRule {
  readonly runtime: RuntimeKind
  readonly workspaceDependencies: readonly string[]
  readonly externalRuntimeDependencies: readonly string[]
}

const scoped = (name: string): string => `@alvin0/ai-agent-sdk-${name}`

/** Normative package graph from docs/monorepo-implementation-design.md. */
export const PACKAGE_RULES: Readonly<Record<string, PackageRule>> = {
  [scoped('core')]: { runtime: 'universal', workspaceDependencies: [], externalRuntimeDependencies: [] },
  [scoped('testkit')]: { runtime: 'universal', workspaceDependencies: [scoped('core')], externalRuntimeDependencies: [] },
  [scoped('provider-http')]: { runtime: 'universal', workspaceDependencies: [scoped('core')], externalRuntimeDependencies: ['eventsource-parser'] },
  [scoped('protocol-anthropic-messages')]: { runtime: 'universal', workspaceDependencies: [scoped('core')], externalRuntimeDependencies: [] },
  [scoped('protocol-responses')]: { runtime: 'universal', workspaceDependencies: [scoped('core')], externalRuntimeDependencies: [] },
  [scoped('protocol-gemini-interactions')]: { runtime: 'universal', workspaceDependencies: [scoped('core')], externalRuntimeDependencies: [] },
  [scoped('provider-anthropic')]: {
    runtime: 'universal',
    workspaceDependencies: [scoped('core'), scoped('provider-http'), scoped('protocol-anthropic-messages')],
    externalRuntimeDependencies: [],
  },
  [scoped('provider-openai')]: {
    runtime: 'universal',
    workspaceDependencies: [scoped('core'), scoped('provider-http'), scoped('protocol-responses')],
    externalRuntimeDependencies: [],
  },
  [scoped('provider-codex')]: {
    runtime: 'universal',
    workspaceDependencies: [scoped('core'), scoped('provider-http'), scoped('protocol-responses')],
    externalRuntimeDependencies: [],
  },
  [scoped('provider-gemini')]: {
    runtime: 'universal',
    workspaceDependencies: [scoped('core'), scoped('provider-http'), scoped('protocol-gemini-interactions')],
    externalRuntimeDependencies: [],
  },
  [scoped('observability-fetch')]: {
    runtime: 'universal',
    workspaceDependencies: [scoped('core')],
    externalRuntimeDependencies: [],
  },
  [scoped('observability-browser')]: {
    runtime: 'browser',
    workspaceDependencies: [scoped('core')],
    externalRuntimeDependencies: [],
  },
  [scoped('observability-node')]: {
    runtime: 'node',
    workspaceDependencies: [scoped('core')],
    externalRuntimeDependencies: [],
  },
  [scoped('observability-otel')]: {
    runtime: 'universal',
    workspaceDependencies: [scoped('core')],
    externalRuntimeDependencies: ['@opentelemetry/api', '@opentelemetry/api-logs'],
  },
  [scoped('auth-node')]: {
    runtime: 'node',
    workspaceDependencies: [scoped('core'), scoped('provider-codex')],
    externalRuntimeDependencies: [],
  },
  [scoped('skill-filesystem')]: {
    runtime: 'node', workspaceDependencies: [scoped('core')], externalRuntimeDependencies: ['yaml'],
  },
  [scoped('instructions-node')]: {
    runtime: 'node', workspaceDependencies: [scoped('core')], externalRuntimeDependencies: [],
  },
  [scoped('mcp')]: {
    runtime: 'universal',
    workspaceDependencies: [scoped('core'), scoped('mcp-server')],
    externalRuntimeDependencies: ['@modelcontextprotocol/client'],
  },
  [scoped('mcp-server')]: {
    runtime: 'universal', workspaceDependencies: [scoped('core')],
    externalRuntimeDependencies: ['@modelcontextprotocol/server'],
  },
  [scoped('mcp-node')]: {
    runtime: 'node',
    workspaceDependencies: [scoped('core'), scoped('mcp')],
    externalRuntimeDependencies: ['@modelcontextprotocol/client'],
  },
  [scoped('mcp-node-server')]: {
    runtime: 'node', workspaceDependencies: [scoped('core'), scoped('mcp-server')],
    externalRuntimeDependencies: ['@modelcontextprotocol/node', '@modelcontextprotocol/server'],
  },
  [scoped('a2a')]: {
    runtime: 'node',
    workspaceDependencies: [scoped('core')],
    externalRuntimeDependencies: ['@a2a-js/sdk'],
  },
}

export interface PackageManifest {
  readonly name: string
  readonly version?: string
  readonly private?: boolean
  readonly exports?: unknown
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly aiAgentSdk?: { readonly runtime?: RuntimeKind }
}

export interface WorkspacePackage {
  readonly root: string
  readonly manifestPath: string
  readonly manifest: PackageManifest
  readonly sourceRoot?: string
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

export function discoverWorkspacePackages(workspaceRoot: string): readonly WorkspacePackage[] {
  const roots: string[] = []
  const packagesRoot = join(workspaceRoot, 'packages')
  if (existsSync(packagesRoot)) {
    for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(packagesRoot, entry.name, 'package.json'))) roots.push(join(packagesRoot, entry.name))
    }
  }
  return roots.map((root) => {
    const manifestPath = join(root, 'package.json')
    const manifest = readManifest(manifestPath)
    if (!manifest.name) throw new Error(`${relative(workspaceRoot, manifestPath)}: package name is required`)
    const sourceRoot = existsSync(join(root, 'src')) ? join(root, 'src') : undefined
    return { root, manifestPath, manifest, ...(sourceRoot === undefined ? {} : { sourceRoot }) }
  })
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

export function listCodeFiles(root: string): readonly string[] {
  if (!existsSync(root)) return []
  const output: string[] = []
  const visit = (path: string): void => {
    const stat = statSync(path)
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name))
    } else if (SOURCE_EXTENSIONS.has(extname(path))) output.push(path)
  }
  visit(root)
  return output.sort()
}

export interface ImportReference {
  readonly specifier: string
  readonly line: number
}

export function importsInFile(path: string): readonly ImportReference[] {
  const sourceText = readFileSync(path, 'utf8')
  const searchableText = maskCommentsAndTemplates(sourceText)
  const imports: ImportReference[] = []
  const seen = new Set<number>()
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of searchableText.matchAll(pattern)) {
      if (match.index === undefined || match[1] === undefined || seen.has(match.index)) continue
      seen.add(match.index)
      imports.push({
        specifier: match[1],
        line: sourceText.slice(0, match.index).split('\n').length,
      })
    }
  }
  return imports.sort((left, right) => left.line - right.line)
}

function maskCommentsAndTemplates(source: string): string {
  let output = ''
  let index = 0
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' = 'code'
  while (index < source.length) {
    const char = source[index] ?? ''
    const next = source[index + 1] ?? ''
    if (state === 'code') {
      if (char === '/' && next === '/') {
        output += '  '
        index += 2
        state = 'line-comment'
        continue
      }
      if (char === '/' && next === '*') {
        output += '  '
        index += 2
        state = 'block-comment'
        continue
      }
      if (char === "'") state = 'single'
      else if (char === '"') state = 'double'
      else if (char === '`') state = 'template'
      output += state === 'template' ? ' ' : char
      index += 1
      continue
    }
    if (char === '\n') {
      output += '\n'
      index += 1
      if (state === 'line-comment') state = 'code'
      continue
    }
    if (state === 'block-comment' && char === '*' && next === '/') {
      output += '  '
      index += 2
      state = 'code'
      continue
    }
    if (state === 'single' || state === 'double') {
      output += char
      index += 1
      if (char === '\\') {
        output += source[index] ?? ''
        index += 1
      } else if ((state === 'single' && char === "'") || (state === 'double' && char === '"')) {
        state = 'code'
      }
      continue
    }
    if (state === 'template' && char === '`') state = 'code'
    output += ' '
    index += 1
  }
  return output
}

/** Masks comments and quoted text while preserving line breaks and character offsets. */
export function maskNonCode(source: string): string {
  let output = ''
  let index = 0
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' = 'code'
  while (index < source.length) {
    const char = source[index] ?? ''
    const next = source[index + 1] ?? ''
    if (state === 'code') {
      if (char === '/' && next === '/') {
        output += '  '
        index += 2
        state = 'line-comment'
        continue
      }
      if (char === '/' && next === '*') {
        output += '  '
        index += 2
        state = 'block-comment'
        continue
      }
      if (char === "'") state = 'single'
      else if (char === '"') state = 'double'
      else if (char === '`') state = 'template'
      output += state === 'code' ? char : ' '
      index += 1
      continue
    }
    if (char === '\n') {
      output += '\n'
      index += 1
      if (state === 'line-comment') state = 'code'
      continue
    }
    if (state === 'block-comment' && char === '*' && next === '/') {
      output += '  '
      index += 2
      state = 'code'
      continue
    }
    const closing = (state === 'single' && char === "'") || (state === 'double' && char === '"') || (state === 'template' && char === '`')
    if ((state === 'single' || state === 'double' || state === 'template') && char === '\\') {
      output += '  '
      index += 2
      continue
    }
    output += ' '
    index += 1
    if (closing) state = 'code'
  }
  return output
}

export function externalPackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || /^[a-z]+:/i.test(specifier)) return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

export function declaredRuntimeDependencies(manifest: PackageManifest): ReadonlySet<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
}

export function isWithin(candidate: string, root: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep))
}

export function resolveRelativeImport(importer: string, specifier: string): string {
  return resolve(dirname(importer), specifier)
}

export function isExportedWorkspaceSubpath(target: WorkspacePackage, specifier: string): boolean {
  if (specifier === target.manifest.name) return true
  const suffix = specifier.slice(target.manifest.name.length + 1)
  if (!suffix || target.manifest.exports === undefined) return false
  if (typeof target.manifest.exports !== 'object' || target.manifest.exports === null || Array.isArray(target.manifest.exports)) return false
  return Object.prototype.hasOwnProperty.call(target.manifest.exports, `./${suffix}`)
}
