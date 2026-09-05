// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'

export function prepareContractIndex(ctx: ContractContext): void {
  const { workspace, contractRoot, configPath, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics, expectedManifestRoles } = ctx
  const { relative, fail, runtimeRank, assertSameSet, parseImports, importsOf, assertParser, targetDeclarationExportsOf,
    listFiles, listCodeFiles, externalPackageName, externalImportOwner, workspaceClosure } =
    makeHelpers(workspace, topology)
  const { readFileSync } = fs
  const { join, resolve } = path
  void [workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics, expectedManifestRoles, relative, fail,
    runtimeRank, assertSameSet, parseImports, importsOf, assertParser, targetDeclarationExportsOf, listFiles, listCodeFiles,
    externalPackageName, externalImportOwner, workspaceClosure, readFileSync, join, resolve]
const tsconfig = JSON.parse(readFileSync(configPath, 'utf8')) as {
  readonly compilerOptions?: { readonly paths?: Readonly<Record<string, readonly string[]>> }
}

assertParser()

packageBySpecifier.clear()
const declarationDirs = new Set<string>()
for (const [packageName, rule] of Object.entries(topology.packages)) {
  if (declarationDirs.has(rule.declarationDir)) fail(`duplicate declarationDir '${rule.declarationDir}'`)
  declarationDirs.add(rule.declarationDir)
  for (const specifier of rule.specifiers) {
    if (packageBySpecifier.has(specifier)) fail(`duplicate package specifier '${specifier}'`)
    packageBySpecifier.set(specifier, packageName)
  }
}

const allConfiguredPaths = new Set(Object.keys(tsconfig.compilerOptions?.paths ?? {}))
assertSameSet(
  'compile-only compatibility path aliases',
  new Set([...allConfiguredPaths].filter(specifier => (
    specifier.startsWith('@current/') || specifier.startsWith('@compat/')
  ))),
  new Set([
    '@current/observability',
    '@compat/auth-root',
    '@compat/auth-env',
    '@compat/auth-codex',
    '@compat/provider-codex',
    '@compat/a2a-root',
    '@compat/a2a-client',
    '@compat/a2a-server',
    '@compat/skill-filesystem',
    '@compat/skill-validation',
    '@compat/provider-http',
    '@compat/provider-openai',
    '@compat/provider-anthropic',
    '@compat/provider-codex-signatures',
    '@compat/mcp-client',
    '@compat/mcp-server',
    '@compat/mcp-node-client',
    '@compat/mcp-node-server',
  ]),
)
const configuredPaths = new Set(
  [...allConfiguredPaths].filter(specifier => (
    !specifier.startsWith('@current/') && !specifier.startsWith('@compat/')
  )),
)
assertSameSet('tsconfig paths vs topology specifiers', configuredPaths, new Set(packageBySpecifier.keys()))

}
export function validateAuthRoutes(ctx: ContractContext): void {
  const { workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics } = ctx
  const { relative, fail, runtimeRank, assertSameSet, importsOf, targetDeclarationExportsOf,
    listFiles, listCodeFiles, externalPackageName, externalImportOwner, workspaceClosure } =
    makeHelpers(workspace, topology)
  const { readFileSync } = fs
  const { join, resolve } = path
  void [workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics, relative, fail,
    runtimeRank, assertSameSet, importsOf, targetDeclarationExportsOf, listFiles, listCodeFiles,
    externalPackageName, externalImportOwner, workspaceClosure, readFileSync, join, resolve]
  const tsconfig = JSON.parse(readFileSync(ctx.configPath, 'utf8')) as {
    readonly compilerOptions?: { readonly paths?: Readonly<Record<string, readonly string[]>> }
  }
const authRootPath = tsconfig.compilerOptions?.paths?.['@ai-agent-sdk/auth-node']?.[0]
const authEnvPath = tsconfig.compilerOptions?.paths?.['@ai-agent-sdk/auth-node/env']?.[0]
if (authRootPath === undefined || authEnvPath === undefined) {
  fail('auth-node root and /env must both have target declaration routes')
}
const authRootFile = resolve(contractRoot, authRootPath)
const authEnvFile = resolve(contractRoot, authEnvPath)
assertSameSet(
  'auth-node root and /env public identities',
  targetDeclarationExportsOf(authRootFile),
  targetDeclarationExportsOf(authEnvFile),
)
assertSameSet(
  'auth-node /env canonical source',
  new Set(importsOf(authEnvFile)),
  new Set(['./index.js']),
)
const authEnvSource = readFileSync(authEnvFile, 'utf8')
if (/export\s+(?:declare\s+)?(?:class|interface|type|const|function)\s+[A-Za-z_$]/.test(authEnvSource)) {
  fail('auth-node /env must be an identity-preserving re-export, not a second declaration owner')

}
}
// @ts-nocheck
