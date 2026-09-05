import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Runtime = 'universal' | 'browser' | 'node'

interface PackageRule {
  readonly runtime: Runtime
  readonly manifestRoles: readonly string[]
  readonly corePeer: 'none' | 'required'
  readonly normalWorkspaceDependencies: readonly string[]
  readonly optionalWorkspacePeers: readonly string[]
  readonly externalRuntimeDependencies: readonly string[]
  readonly requiredExternalRuntimePeers?: readonly string[]
  readonly optionalExternalRuntimePeers?: readonly string[]
}

interface ManifestPolicy {
  readonly type: 'module'
  readonly sideEffects: false
  readonly privateUntilPublicationConfigured: true
  readonly basePackedFiles: readonly string[]
  readonly additionalPackedFiles: Readonly<Record<string, readonly string[]>>
  readonly binaryEntrypoints: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly corePeerRange: string
  readonly nodeEngine: string
  readonly capabilityMetadata: {
    readonly coreApi: number
  }
}

interface Topology {
  readonly manifestPolicy: ManifestPolicy
  readonly packages: Readonly<Record<string, PackageRule>>
}

interface ManifestBlueprint {
  readonly exports: Readonly<Record<string, unknown>>
}

interface ManifestBlueprints {
  readonly packages: Readonly<Record<string, ManifestBlueprint>>
}

interface PackageManifest {
  readonly name?: string
  readonly private?: boolean
  readonly type?: string
  readonly sideEffects?: boolean
  readonly files?: readonly string[]
  readonly main?: string
  readonly types?: string
  readonly exports?: unknown
  readonly bin?: Readonly<Record<string, string>>
  readonly engines?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly aiAgentSdk?: {
    readonly runtime?: Runtime
    readonly coreApi?: number
    readonly roles?: readonly string[]
  }
}

function fail(packageName: string, field: string, detail: string): never {
  throw new Error(`${packageName}: manifest ${field} ${detail}`)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function assertExact(packageName: string, field: string, actual: unknown, expected: unknown): void {
  if (canonical(actual) !== canonical(expected)) {
    fail(packageName, field, `differs; expected ${canonical(expected)}, received ${canonical(actual)}`)
  }
}

function packageDirectory(packageName: string): string {
  const prefix = '@ai-agent-sdk/'
  if (!packageName.startsWith(prefix) || packageName.length === prefix.length) {
    throw new Error(`unsupported target package name '${packageName}'`)
  }
  return packageName.slice(prefix.length)
}

function externalSelection(selection: string): readonly [name: string, version: string] {
  const separator = selection.lastIndexOf('@')
  if (separator < 1 || separator === selection.length - 1) {
    throw new Error(`invalid exact external selection '${selection}'`)
  }
  return [selection.slice(0, separator), selection.slice(separator + 1)]
}

function catalogVersions(workspace: string): ReadonlyMap<string, string> {
  const source = readFileSync(join(workspace, 'pnpm-workspace.yaml'), 'utf8')
  const output = new Map<string, string>()
  let inCatalog = false
  for (const line of source.split(/\r?\n/)) {
    if (line === 'catalog:') {
      inCatalog = true
      continue
    }
    if (!inCatalog) continue
    if (line.length > 0 && !/^\s/.test(line)) break
    const match = /^\s{2}(?:'([^']+)'|"([^"]+)"|([^:]+)):\s+(\S+)\s*$/.exec(line)
    const name = match?.[1] ?? match?.[2] ?? match?.[3]
    const version = match?.[4]
    if (name !== undefined && version !== undefined) output.set(name.trim(), version)
  }
  return output
}

function expectedDependencies(
  rule: PackageRule,
  catalog: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {}
  for (const dependency of rule.normalWorkspaceDependencies) output[dependency] = 'workspace:^'
  for (const selection of rule.externalRuntimeDependencies) {
    const [dependency, version] = externalSelection(selection)
    const catalogVersion = catalog.get(dependency)
    if (catalogVersion !== undefined && catalogVersion !== version) {
      throw new Error(`${dependency}: strict catalog version '${catalogVersion}' differs from topology '${version}'`)
    }
    output[dependency] = catalogVersion === undefined ? version : 'catalog:'
  }
  return output
}

function expectedPeers(
  packageName: string,
  rule: PackageRule,
  corePeerRange: string,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {}
  if (rule.corePeer === 'required') output['@ai-agent-sdk/core'] = corePeerRange
  for (const peer of rule.optionalWorkspacePeers) output[peer] = 'workspace:^'
  for (const selection of [
    ...(rule.requiredExternalRuntimePeers ?? []),
    ...(rule.optionalExternalRuntimePeers ?? []),
  ]) {
    const [peer, version] = externalSelection(selection)
    output[peer] = `^${version}`
  }
  if (packageName === '@ai-agent-sdk/core' && Object.keys(output).length !== 0) {
    throw new Error('core manifest expectation unexpectedly contains peers')
  }
  return output
}

function expectedOptionalPeerMetadata(rule: PackageRule): Readonly<Record<string, { readonly optional: true }>> {
  const output: Record<string, { readonly optional: true }> = {}
  for (const peer of rule.optionalWorkspacePeers) output[peer] = { optional: true }
  for (const selection of rule.optionalExternalRuntimePeers ?? []) {
    const [peer] = externalSelection(selection)
    output[peer] = { optional: true }
  }
  return output
}

function expectedDevelopmentRuntimeResolution(
  rule: PackageRule,
  catalog: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {}
  if (rule.corePeer === 'required') output['@ai-agent-sdk/core'] = 'workspace:^'
  for (const peer of rule.optionalWorkspacePeers) output[peer] = 'workspace:^'
  for (const selection of [
    ...(rule.requiredExternalRuntimePeers ?? []),
    ...(rule.optionalExternalRuntimePeers ?? []),
  ]) {
    const [peer, version] = externalSelection(selection)
    if (catalog.get(peer) !== version) {
      throw new Error(`${peer}: development catalog must resolve the topology peer version '${version}'`)
    }
    output[peer] = 'catalog:'
  }
  return output
}

function validateDevelopmentRuntimeResolution(
  packageName: string,
  manifest: PackageManifest,
  expected: Readonly<Record<string, string>>,
  runtimePackageNames: ReadonlySet<string>,
): void {
  const development = manifest.devDependencies ?? {}
  for (const [dependency, version] of Object.entries(expected)) {
    if (development[dependency] !== version) {
      fail(packageName, `devDependencies.${dependency}`, `must be '${version}'`)
    }
  }
  for (const dependency of Object.keys(development)) {
    if (runtimePackageNames.has(dependency) && expected[dependency] === undefined) {
      fail(packageName, 'devDependencies', `contains unclassified runtime resolution '${dependency}'`)
    }
  }
}

export function validateMigratedManifests(
  workspace: string,
  topology: Topology,
  blueprints: ManifestBlueprints,
): number {
  const policy = topology.manifestPolicy
  const catalog = catalogVersions(workspace)
  const runtimePackageNames = new Set<string>(Object.keys(topology.packages))
  for (const rule of Object.values(topology.packages)) {
    for (const selection of [
      ...rule.externalRuntimeDependencies,
      ...(rule.requiredExternalRuntimePeers ?? []),
      ...(rule.optionalExternalRuntimePeers ?? []),
    ]) runtimePackageNames.add(externalSelection(selection)[0])
  }

  let validated = 0
  for (const [packageName, rule] of Object.entries(topology.packages)) {
    const blueprint = blueprints.packages[packageName]
    if (blueprint === undefined) throw new Error(`${packageName}: missing manifest blueprint`)
    const path = join(workspace, 'packages', packageDirectory(packageName), 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
    if (manifest.name !== packageName) fail(packageName, 'name', `must equal '${packageName}'`)
    assertExact(packageName, 'private', manifest.private, policy.privateUntilPublicationConfigured)
    assertExact(packageName, 'type', manifest.type, policy.type)
    assertExact(packageName, 'sideEffects', manifest.sideEffects, policy.sideEffects)
    assertExact(packageName, 'exports', manifest.exports, blueprint.exports)

    const rootExport = blueprint.exports['.'] as Readonly<Record<string, string>> | undefined
    if (rootExport === undefined || typeof rootExport !== 'object') fail(packageName, 'exports[.]', 'is absent')
    assertExact(packageName, 'main', manifest.main, rootExport.import)
    assertExact(packageName, 'types', manifest.types, rootExport.types)
    assertExact(
      packageName,
      'files',
      [...(manifest.files ?? [])].sort(),
      [...policy.basePackedFiles, ...(policy.additionalPackedFiles[packageName] ?? [])].sort(),
    )
    assertExact(packageName, 'bin', manifest.bin ?? {}, policy.binaryEntrypoints[packageName] ?? {})
    assertExact(
      packageName,
      'engines',
      manifest.engines ?? {},
      rule.runtime === 'node' ? { node: policy.nodeEngine } : {},
    )

    assertExact(packageName, 'dependencies', manifest.dependencies ?? {}, expectedDependencies(rule, catalog))
    assertExact(
      packageName,
      'peerDependencies',
      manifest.peerDependencies ?? {},
      expectedPeers(packageName, rule, policy.corePeerRange),
    )
    assertExact(
      packageName,
      'peerDependenciesMeta',
      manifest.peerDependenciesMeta ?? {},
      expectedOptionalPeerMetadata(rule),
    )
    validateDevelopmentRuntimeResolution(
      packageName,
      manifest,
      expectedDevelopmentRuntimeResolution(rule, catalog),
      runtimePackageNames,
    )
    assertExact(packageName, 'aiAgentSdk', manifest.aiAgentSdk, {
      runtime: rule.runtime,
      coreApi: policy.capabilityMetadata.coreApi,
      roles: rule.manifestRoles,
    })
    validated += 1
  }
  return validated
}
