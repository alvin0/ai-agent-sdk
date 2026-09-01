#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { discoverWorkspacePackages, type PackageManifest } from './package-policy.mts'

const workspaceRoot = resolve(process.cwd())
const errors: string[] = []
const workspaceConfig = readFileSync(join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8')
const lockfile = readFileSync(join(workspaceRoot, 'pnpm-lock.yaml'), 'utf8')
const policy = readFileSync(join(workspaceRoot, 'docs', 'dependency-policy.md'), 'utf8')
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const exoticSpecifier = /^(?:git(?:\+[^:]+)?:|github:|https?:|file:|link:|portal:|patch:)/i

function yamlMap(section: string): ReadonlyMap<string, string> {
  const output = new Map<string, string>()
  const lines = workspaceConfig.split('\n')
  const start = lines.findIndex((line) => line === `${section}:`)
  if (start === -1) return output
  for (const line of lines.slice(start + 1)) {
    if (line.length > 0 && !line.startsWith(' ')) break
    const match = /^  (?:'([^']+)'|([^:]+)):\s*(.+)$/.exec(line)
    if (match) output.set((match[1] ?? match[2] ?? '').trim(), (match[3] ?? '').trim())
  }
  return output
}

const catalog = yamlMap('catalog')
const allowedBuilds = new Set([...yamlMap('allowBuilds')].filter(([, value]) => value === 'true').map(([name]) => name))

for (const [name, version] of catalog) {
  if (!exactVersion.test(version)) errors.push(`catalog ${name} must use an exact version, found ${version}`)
}

function inspectDependencyMap(pkg: PackageManifest, section: 'dependencies' | 'optionalDependencies', values: Readonly<Record<string, string>>): void {
  for (const [name, specifier] of Object.entries(values)) {
    if (exoticSpecifier.test(specifier)) errors.push(`${pkg.name} ${section}.${name} uses forbidden source ${specifier}`)
    if (specifier.startsWith('workspace:')) continue
    if (specifier === 'catalog:') {
      const selected = catalog.get(name)
      if (!selected || !exactVersion.test(selected)) errors.push(`${pkg.name} ${section}.${name} has no exact catalog pin`)
      continue
    }
    if (!exactVersion.test(specifier)) errors.push(`${pkg.name} ${section}.${name} must be exact or catalog-backed, found ${specifier}`)
  }
}

for (const pkg of discoverWorkspacePackages(workspaceRoot)) {
  inspectDependencyMap(pkg.manifest, 'dependencies', pkg.manifest.dependencies ?? {})
  inspectDependencyMap(pkg.manifest, 'optionalDependencies', pkg.manifest.optionalDependencies ?? {})
  for (const [name, specifier] of Object.entries(pkg.manifest.peerDependencies ?? {})) {
    if (exoticSpecifier.test(specifier)) errors.push(`${pkg.manifest.name} peerDependencies.${name} uses forbidden source ${specifier}`)
    if (specifier === 'catalog:' && !catalog.has(name)) errors.push(`${pkg.manifest.name} peerDependencies.${name} has no catalog pin`)
  }
}

interface LockPackage {
  readonly key: string
  integrity: string | undefined
  resolution: string | undefined
}

const lockPackages: LockPackage[] = []
let inPackages = false
let current: LockPackage | undefined
for (const line of lockfile.split('\n')) {
  if (line === 'packages:') {
    inPackages = true
    continue
  }
  if (inPackages && /^[a-zA-Z][^:]*:$/.test(line)) {
    if (current) lockPackages.push(current)
    current = undefined
    inPackages = false
  }
  if (!inPackages) continue
  const packageMatch = /^  (\S.*):$/.exec(line)
  if (packageMatch) {
    if (current) lockPackages.push(current)
    current = { key: packageMatch[1] ?? '', integrity: undefined, resolution: undefined }
    continue
  }
  const resolutionMatch = /^    resolution:\s*\{(.+)\}$/.exec(line)
  if (resolutionMatch && current) {
    current.resolution = resolutionMatch[1]
    current.integrity = /integrity:\s*([^,}]+)/.exec(resolutionMatch[1] ?? '')?.[1]
  }
}
if (current) lockPackages.push(current)

for (const pkg of lockPackages) {
  if (!pkg.integrity?.startsWith('sha512-')) errors.push(`lock package ${pkg.key} has no sha512 registry integrity`)
  const source = pkg.resolution ?? ''
  const urlMatch = /(https?:[^,}\s]+)/.exec(source)?.[1]
  if (urlMatch && !urlMatch.startsWith('https://registry.npmjs.org/')) errors.push(`lock package ${pkg.key} uses non-registry source ${urlMatch}`)
  if (/\b(?:repo|commit|path|directory):/.test(source)) errors.push(`lock package ${pkg.key} uses an exotic resolution`)
}

const lifecycleNames = ['preinstall', 'install', 'postinstall'] as const
const reviewedLifecycle = new Map<string, Set<string>>()
const virtualStore = join(workspaceRoot, 'node_modules', '.pnpm')
const inspectInstalledManifest = (path: string): void => {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest & { readonly scripts?: Readonly<Record<string, string>> }
  const scripts = lifecycleNames.filter((name) => manifest.scripts?.[name] !== undefined)
  if (scripts.length === 0 || !manifest.name || !manifest.version) return
  const key = `${manifest.name}@${manifest.version}`
  if (!allowedBuilds.has(manifest.name)) errors.push(`${key} declares unreviewed lifecycle script(s): ${scripts.join(', ')}`)
  else {
    const versions = reviewedLifecycle.get(manifest.name) ?? new Set<string>()
    versions.add(manifest.version)
    reviewedLifecycle.set(manifest.name, versions)
  }
}
const inspectVirtualStore = (): void => {
  for (const storeEntry of readdirSync(virtualStore, { withFileTypes: true })) {
    if (!storeEntry.isDirectory()) continue
    const modules = join(virtualStore, storeEntry.name, 'node_modules')
    if (!existsSync(modules)) continue
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (entry.name.startsWith('@')) {
        const scope = join(modules, entry.name)
        for (const scopedEntry of readdirSync(scope, { withFileTypes: true })) {
          const manifest = join(scope, scopedEntry.name, 'package.json')
          if (scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink() && existsSync(manifest)) inspectInstalledManifest(manifest)
        }
      } else {
        const manifest = join(modules, entry.name, 'package.json')
        if (existsSync(manifest)) inspectInstalledManifest(manifest)
      }
    }
  }
}
if (existsSync(virtualStore)) inspectVirtualStore()
else errors.push('node_modules/.pnpm is missing; run the frozen install before the supply-chain check')

for (const name of allowedBuilds) {
  const versions = reviewedLifecycle.get(name)
  if (!versions || versions.size === 0) errors.push(`allowBuilds entry ${name} does not match an installed lifecycle script`)
  for (const version of versions ?? []) {
    if (!policy.includes(`| \`${name}\` | \`${version}\``)) errors.push(`${name}@${version} lifecycle approval is missing package/version evidence in docs/dependency-policy.md`)
  }
}

const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
function pnpmJson(command: readonly string[], allowNonzero = false): unknown {
  const result = spawnSync(pnpmExecutable, [...command], { cwd: workspaceRoot, encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  if (!result.stdout.trim()) throw new Error(`pnpm ${command.join(' ')} returned no JSON: ${result.stderr}`)
  if (!allowNonzero && result.status !== 0) throw new Error(`pnpm ${command.join(' ')} failed: ${result.stderr || result.stdout}`)
  try {
    return JSON.parse(result.stdout) as unknown
  } catch {
    throw new Error(`pnpm ${command.join(' ')} returned invalid JSON: ${result.stdout}`)
  }
}

const allowedLicenses = new Set(['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense'])
const licenses = pnpmJson(['licenses', 'list', '--prod', '--json']) as Readonly<Record<string, unknown>>
for (const expression of Object.keys(licenses)) {
  const identifiers = expression.replace(/[()]/g, ' ').split(/\s+(?:AND|OR|WITH)\s+|\s+/).filter(Boolean)
  for (const identifier of identifiers) if (!allowedLicenses.has(identifier)) errors.push(`production license is not reviewed: ${expression}`)
}

if (!process.argv.includes('--skip-audit')) {
  const audit = pnpmJson(['audit', '--prod', '--json'], true) as {
    readonly metadata?: { readonly vulnerabilities?: { readonly high?: number; readonly critical?: number } }
  }
  if (!audit.metadata?.vulnerabilities) throw new Error('pnpm audit did not return vulnerability metadata; advisory status is unknown')
  const high = audit.metadata?.vulnerabilities?.high ?? 0
  const critical = audit.metadata?.vulnerabilities?.critical ?? 0
  if (high > 0 || critical > 0) errors.push(`production audit has ${high} high and ${critical} critical advisories`)
}

if (errors.length > 0) {
  console.error(`Supply-chain check failed with ${errors.length} finding(s):`)
  for (const error of [...new Set(errors)]) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`Supply-chain check passed: ${lockPackages.length} integrity records, ${Object.keys(licenses).length} production license expression(s), zero findings.`)
}
