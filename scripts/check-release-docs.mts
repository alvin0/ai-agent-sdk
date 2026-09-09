import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Documentation hygiene gate.
 *
 * Deliberately checks only things that stay true as the SDK grows: every package
 * README describes its own runtime and install command, no README link points at
 * a missing file, no unresolved marker survives, and no documented root script
 * has been renamed away.
 *
 * The documentation site under `web-documents/` is gated by `pnpm docs:build`,
 * which fails on its own dead links.
 *
 * It intentionally does NOT freeze the package set, the dependency count, or any
 * migration-era ledger. Adding a package or a dependency must not require
 * editing this file.
 */

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

for (const { root, manifest } of manifests) {
  const readmePath = join(root, 'README.md')
  if (!existsSync(readmePath)) {
    errors.push(`${relative(workspaceRoot, root)} has no README.md`)
    continue
  }
  const readme = readFileSync(readmePath, 'utf8')
  const runtime = manifest.aiAgentSdk?.runtime
  const runtimeLabel = runtime === undefined
    ? undefined
    : `Runtime: **${runtime.charAt(0).toUpperCase()}${runtime.slice(1)}`
  if (runtimeLabel === undefined || !readme.includes(runtimeLabel)) {
    errors.push(`${relative(workspaceRoot, readmePath)} does not match manifest runtime ${String(runtime)}`)
  }
  if (!readme.includes('pnpm add') || !readme.includes(manifest.name)) {
    errors.push(`${relative(workspaceRoot, readmePath)} lacks an explicit install command for ${manifest.name}`)
  }
}

/**
 * README files only. The documentation site under `web-documents/` uses VitePress
 * route links rather than filesystem paths, and `pnpm docs:build` already fails on
 * a dead link there — a filesystem link checker would reject every valid route.
 */
const markdownFiles = [
  join(workspaceRoot, 'README.md'),
  ...manifests.map(entry => join(entry.root, 'README.md')),
].filter(path => existsSync(path))

for (const path of markdownFiles) {
  const text = readFileSync(path, 'utf8')
  if (/\b(?:TBD|FIXME)\b|TODO\s*\(/.test(text)) {
    errors.push(`${relative(workspaceRoot, path)} contains an unresolved implementation marker`)
  }
  for (const match of text.matchAll(/@alvin0\/ai-agent-sdk-[a-z0-9-]+/g)) {
    if (!packageNames.has(match[0])) {
      errors.push(`${relative(workspaceRoot, path)} names unknown package ${match[0]}`)
    }
  }
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]?.split('#', 1)[0]
    if (target === undefined || target === '' || /^[a-z]+:/i.test(target)) continue
    const resolved = resolve(dirname(path), decodeURIComponent(target))
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
    `Release docs passed: ${markdownFiles.length} Markdown files, `
    + `${manifests.length} package READMEs, zero findings.\n`,
  )
}

interface PackageManifest {
  name: string
  private?: boolean
  scripts?: Record<string, string>
  aiAgentSdk?: { runtime?: string }
}
