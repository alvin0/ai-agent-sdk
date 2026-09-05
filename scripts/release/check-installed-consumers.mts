#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSingleInstalledPackage } from '../contracts/installed-tree.mts'

type Runtime = 'universal' | 'browser' | 'node'
interface PackageRule { readonly runtime: Runtime; readonly specifiers: readonly string[]; readonly corePeer: 'none' | 'required' }
interface Topology { readonly packages: Readonly<Record<string, PackageRule>> }
interface Manifest {
  readonly name: string
  readonly exports: Readonly<Record<string, unknown>>
  readonly files: readonly string[]
  readonly main?: string
  readonly types?: string
  readonly bin?: Readonly<Record<string, string>>
  readonly private?: boolean
  readonly scripts?: Readonly<Record<string, string>>
  readonly aiAgentSdk?: unknown
}
interface PackRecord { readonly filename: string; readonly files: readonly { readonly path: string }[] }

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const topology = JSON.parse(readFileSync(
  join(workspace, 'design-contracts/core-capability-v1/topology.json'), 'utf8',
)) as Topology
const temporary = mkdtempSync(join(tmpdir(), 'ai-agent-sdk-installed-release-'))
const packed = join(temporary, 'packed')
const consumer = join(temporary, 'consumer')

try {
  const tarballs = Object.keys(topology.packages).sort().map(name => pack(name, packed))
  const nodeTypesVersion = (JSON.parse(readFileSync(
    join(workspace, 'node_modules/@types/node/package.json'), 'utf8',
  )) as { readonly version: string }).version
  writeJson(join(consumer, 'package.json'), { name: 'installed-release-consumer', private: true, type: 'module' })
  run('npm', [
    'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
    `@types/node@${nodeTypesVersion}`, ...tarballs,
  ], consumer)

  assertSingleInstalledPackage(consumer, '@ai-agent-sdk/core')
  verifyPackedManifests()
  verifyCoreResolution()
  compileInstalled('node', allSpecifiers(), ['node'])
  const webSpecifiers = allSpecifiers(rule => rule.runtime !== 'node')
  compileInstalled('browser', webSpecifiers, [])
  compileInstalled('workerd', webSpecifiers, [])
  verifyRouteValueIdentity()

  process.stdout.write(
    `Installed release consumer passed: ${tarballs.length} tarballs, ${allSpecifiers().length} NodeNext route(s), `
    + `${webSpecifiers.length} Browser/workerd route(s), one physical core.\n`,
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

function pack(name: string, destination: string): string {
  const root = packageRoot(name)
  const output = run('pnpm', ['pack', '--json', '--pack-destination', destination], root)
  const record = JSON.parse(output) as PackRecord
  verifyPackContents(root, record)
  return resolve(root, record.filename)
}

function verifyPackContents(root: string, record: PackRecord): void {
  const manifest = readManifest(join(root, 'package.json'))
  const files = new Set(record.files.map(row => row.path.replaceAll('\\', '/')))
  for (const required of ['package.json', 'README.md', 'LICENSE']) {
    assert(files.has(required), `${manifest.name} tarball is missing ${required}`)
  }
  for (const path of files) {
    assert(path === 'package.json' || allowedPackedPath(path, manifest.files),
      `${manifest.name} tarball contains undeclared path ${path}`)
    assert(!path.includes('node_modules/@ai-agent-sdk/core') && !path.includes('packages/core/src'),
      `${manifest.name} tarball embeds a core source tree at ${path}`)
  }
  for (const target of manifestTargets(manifest)) {
    assert(files.has(target), `${manifest.name} tarball export target is missing: ${target}`)
  }
}

function allowedPackedPath(path: string, declared: readonly string[]): boolean {
  return declared.some(item => path === item || path.startsWith(`${item.replace(/\/$/u, '')}/`))
}

function manifestTargets(manifest: Manifest): readonly string[] {
  const targets = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('./')) targets.add(value.slice(2))
    else if (value !== null && typeof value === 'object') for (const nested of Object.values(value)) visit(nested)
  }
  visit(manifest.exports)
  for (const target of [manifest.main, manifest.types, ...Object.values(manifest.bin ?? {})]) visit(target)
  return [...targets]
}

function verifyPackedManifests(): void {
  for (const name of Object.keys(topology.packages)) {
    const source = readManifest(join(packageRoot(name), 'package.json'))
    const installed = readManifest(join(installedRoot(name), 'package.json'))
    for (const field of ['exports', 'files', 'main', 'types', 'bin', 'private', 'aiAgentSdk'] as const) {
      assert(JSON.stringify(installed[field]) === JSON.stringify(source[field]),
        `${name} packed manifest changed ${field}`)
    }
    for (const lifecycle of ['publish', 'prepublish', 'prepublishOnly', 'postpublish']) {
      assert(source.scripts?.[lifecycle] === undefined, `${name} configures forbidden ${lifecycle} script`)
    }
  }
  const root = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as Manifest
  for (const lifecycle of ['publish', 'prepublish', 'prepublishOnly', 'postpublish']) {
    assert(root.scripts?.[lifecycle] === undefined, `workspace configures forbidden ${lifecycle} script`)
  }
}

function verifyCoreResolution(): void {
  const canonical = realpathSync(installedRoot('@ai-agent-sdk/core'))
  for (const [name, rule] of Object.entries(topology.packages)) {
    if (rule.corePeer !== 'required') continue
    const require = createRequire(join(installedRoot(name), 'package.json'))
    const resolved = realpathSync(dirname(require.resolve('@ai-agent-sdk/core/package.json')))
    assert(resolved === canonical, `${name} resolves a non-canonical core at ${resolved}`)
  }
}

function compileInstalled(mode: 'node' | 'browser' | 'workerd', specifiers: readonly string[], types: readonly string[]): void {
  const root = join(consumer, mode)
  mkdirSync(root, { recursive: true })
  const source = join(root, 'consumer.mts')
  writeFileSync(source, `${specifierImports(specifiers)}\n`, 'utf8')
  writeJson(join(root, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2023', module: mode === 'node' ? 'NodeNext' : 'ESNext',
      moduleResolution: mode === 'node' ? 'NodeNext' : 'Bundler', strict: true,
      noEmit: true, skipLibCheck: false, types,
      lib: mode === 'node' ? ['ES2023'] : ['ES2023', 'DOM', 'DOM.Iterable'],
      resolveJsonModule: true,
      ...(mode === 'node' ? {} : { customConditions: [mode] }),
    },
    files: ['consumer.mts'],
  })
  const output = run(process.execPath, [
    join(workspace, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json',
    '--traceResolution', '--listFilesOnly', '--pretty', 'false',
  ], root)
  const listed = output.split(/\r?\n/u).filter(Boolean).map(path => resolve(root, path))
  const installedPrefix = `${resolve(consumer, 'node_modules')}${sep}`
  for (const specifier of specifiers) {
    const marker = `Module name '${specifier}' was successfully resolved to '`
    const line = output.split(/\r?\n/u).find(candidate => candidate.includes(marker))
    const resolved = line?.slice((line.indexOf(marker) + marker.length), line.indexOf("'", line.indexOf(marker) + marker.length))
    assert(resolved !== undefined && resolve(resolved).startsWith(installedPrefix),
      `${mode} did not resolve ${specifier} inside the installed closure`)
  }
  if (mode !== 'node') {
    assert(!listed.some(path => path.includes(`${sep}@types${sep}node${sep}`)),
      `${mode} compile loaded ambient Node types`)
  }
  assert(listed.some(path => path.startsWith(installedPrefix)), `${mode} compile did not load installed declarations`)
}

function specifierImports(specifiers: readonly string[]): string {
  return specifiers.map((specifier, index) => specifier.endsWith('/package.json')
    ? `import manifest${index} from ${JSON.stringify(specifier)} with { type: 'json' }; void manifest${index}`
    : `import * as route${index} from ${JSON.stringify(specifier)}; void route${index}`).join('\n')
}

function verifyRouteValueIdentity(): void {
  const script = join(consumer, 'identity.mjs')
  const groups = Object.entries(topology.packages).map(([name, rule]) => ({
    name, specifiers: rule.specifiers.filter(specifier => !specifier.endsWith('/package.json')),
  })).filter(group => group.specifiers.length > 1)
  writeFileSync(script, `const groups=${JSON.stringify(groups)};\n`
    + `for(const group of groups){const routes=await Promise.all(group.specifiers.map(s=>import(s)));`
    + `for(let i=0;i<routes.length;i++)for(let j=i+1;j<routes.length;j++){`
    + `for(const key of Object.keys(routes[i]).filter(k=>Object.hasOwn(routes[j],k))){`
    + `if(routes[i][key]!==routes[j][key])throw new Error(group.name+' route identity drift: '+key)}}}\n`, 'utf8')
  run(process.execPath, [script], consumer)
}

function allSpecifiers(include: (rule: PackageRule) => boolean = () => true): readonly string[] {
  return Object.values(topology.packages).filter(include).flatMap(rule => rule.specifiers).sort()
}

function packageRoot(name: string): string { return join(workspace, 'packages', name.slice('@ai-agent-sdk/'.length)) }
function installedRoot(name: string): string { return join(consumer, 'node_modules', ...name.split('/')) }
function readManifest(path: string): Manifest { return JSON.parse(readFileSync(path, 'utf8')) as Manifest }
function writeJson(path: string, value: unknown): void {
  const parent = dirname(path)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env, maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
