import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const errors: string[] = []
const packageRoots = readdirSync(join(workspaceRoot, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(workspaceRoot, 'packages', entry.name, 'package.json')))
  .map(entry => join(workspaceRoot, 'packages', entry.name))
  .sort()
const manifests = packageRoots.map(root => ({
  root,
  manifest: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageManifest,
}))
const packageNames = new Set(manifests.map(entry => entry.manifest.name))

if (manifests.length !== 20) errors.push(`expected 20 publishable package manifests, found ${manifests.length}`)

for (const { root, manifest } of manifests) {
  const readmePath = join(root, 'README.md')
  if (!existsSync(readmePath)) {
    errors.push(`${relative(workspaceRoot, root)} has no README.md`)
    continue
  }
  const readme = readFileSync(readmePath, 'utf8')
  const runtime = manifest.aiAgentSdk?.runtime
  const runtimeLabel = runtime === 'universal'
    ? 'Runtime: **Universal'
    : runtime === 'browser'
      ? 'Runtime: **Browser'
      : runtime === 'node'
        ? 'Runtime: **Node'
        : runtime === 'mixed'
          ? 'Runtime: **Mixed'
          : undefined
  if (runtimeLabel === undefined || !readme.includes(runtimeLabel)) {
    errors.push(`${relative(workspaceRoot, readmePath)} does not match manifest runtime ${String(runtime)}`)
  }
  if (!readme.includes('pnpm add') || !readme.includes(manifest.name)) {
    errors.push(`${relative(workspaceRoot, readmePath)} lacks an explicit install command for ${manifest.name}`)
  }
}

const externalNames = new Set<string>()
const parserOwners: string[] = []
for (const { manifest } of manifests) {
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (!name.startsWith('@ai-agent-sdk/')) externalNames.add(name)
      if (name === 'eventsource-parser') parserOwners.push(`${manifest.name}:${section}:${version}`)
    }
  }
}
if (externalNames.size !== 7) {
  errors.push(`expected 7 unique external runtime/peer names, found ${externalNames.size}`)
}
if (parserOwners.join(',') !== '@ai-agent-sdk/provider-http:dependencies:4.1.0') {
  errors.push(`unexpected direct eventsource-parser owners: ${parserOwners.join(',')}`)
}

const markdownFiles = [
  join(workspaceRoot, 'README.md'),
  join(workspaceRoot, '.changeset', 'README.md'),
  ...walkMarkdown(join(workspaceRoot, 'docs')),
  ...manifests.map(entry => join(entry.root, 'README.md')),
]
const implementationLedger = join(workspaceRoot, 'docs', 'implementation-todo.md')
const stalePatterns = [
  /production split not yet implemented/i,
  /production observability not yet implemented/i,
  /committed npm lockfile currently/i,
  /current lockfile has 156/i,
  /current package\.json contains/i,
  /runtime-unverified/i,
  /decision pending/i,
]

for (const path of markdownFiles) {
  const text = readFileSync(path, 'utf8')
  for (const pattern of stalePatterns) {
    if (pattern.test(text)) errors.push(`${relative(workspaceRoot, path)} contains stale text ${pattern}`)
  }
  if (path !== implementationLedger && /\b(?:TBD|FIXME)\b|TODO\s*\(/.test(text)) {
    errors.push(`${relative(workspaceRoot, path)} contains an unresolved implementation marker`)
  }
  for (const match of text.matchAll(/@ai-agent-sdk\/[a-z0-9-]+/g)) {
    if (!packageNames.has(match[0])) {
      errors.push(`${relative(workspaceRoot, path)} names unknown package ${match[0]}`)
    }
  }
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]?.split('#', 1)[0]
    if (target === undefined || target === '' || /^[a-z]+:/i.test(target)) continue
    const decoded = decodeURIComponent(target)
    const resolved = resolve(dirname(path), decoded)
    if (!existsSync(resolved)) {
      errors.push(`${relative(workspaceRoot, path)} links to missing ${target}`)
    }
  }
}

const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as PackageManifest
for (const script of [
  'workspace:build', 'workspace:typecheck', 'build:cli', 'lint', 'test:unit', 'test:contract',
  'test:packages', 'test:pack', 'test:edge', 'test:browser', 'test:node', 'test:recovery',
  'check:graph', 'check:runtime-boundaries', 'check:supply-chain', 'check:docs',
]) {
  if (rootManifest.scripts?.[script] === undefined) errors.push(`documented root script is missing: ${script}`)
}

if (existsSync(join(workspaceRoot, 'package-lock.json'))) errors.push('obsolete package-lock.json is present')

if (errors.length > 0) {
  process.stderr.write(`${errors.map(error => `- ${error}`).join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `Release docs passed: ${markdownFiles.length} Markdown files, ${manifests.length} package READMEs, `
    + `${externalNames.size} external names, zero findings.\n`,
  )
}

function walkMarkdown(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...walkMarkdown(path))
    else if (extname(entry.name) === '.md') files.push(path)
  }
  return files.sort()
}

interface PackageManifest {
  name: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  aiAgentSdk?: { runtime?: string }
}
