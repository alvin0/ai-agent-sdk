// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'

export function validateCompatibilityPolicies(ctx: ContractContext): void {
  const { workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics,
  } = ctx
  const {
    relative, fail, runtimeRank, assertSameSet, parseImports, importsOf,
    parseTargetDeclarationExports, targetDeclarationExportsOf, publicExportsOf,
    listFiles, listCodeFiles, markdownExampleSpecifiers, externalPackageName,
    packageNameOf, externalImportOwner, externalClosure, workspaceClosure,
  } = makeHelpers(workspace, topology)
  const { readFileSync, existsSync } = fs
  const { join, resolve } = path
  void [workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics,
    relative, fail, runtimeRank, assertSameSet, parseImports, importsOf,
    parseTargetDeclarationExports, targetDeclarationExportsOf, publicExportsOf,
    listFiles, listCodeFiles, markdownExampleSpecifiers, externalPackageName,
    packageNameOf, externalImportOwner, externalClosure, workspaceClosure,
    readFileSync, existsSync, join, resolve]
const coreMessageCompatibilityPolicy = topology.coreMessageCompatibilityPolicy
if (coreMessageCompatibilityPolicy.source !== 'consumers/core-message-api-compatibility.ts'
  || coreMessageCompatibilityPolicy.currentConfig !== 'tsconfig.current-core-message.json'
  || coreMessageCompatibilityPolicy.targetConfig !== 'tsconfig.json'
  || coreMessageCompatibilityPolicy.evidence !== 'same-source-dual-current-target-compile') {
  fail('core message/content compatibility policy drifted')
}
if (coreMessageCompatibilityPolicy.coveredSymbols.length !== 45
  || new Set(coreMessageCompatibilityPolicy.coveredSymbols).size !== 45) {
  fail('core message/content compatibility inventory must contain 45 unique symbols')
}
const coreMessageCompatibilitySource = readFileSync(
  join(contractRoot, coreMessageCompatibilityPolicy.source),
  'utf8',
)
for (const symbol of coreMessageCompatibilityPolicy.coveredSymbols) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`\\b${escaped}\\b`).test(coreMessageCompatibilitySource)) {
    fail(`core message/content compatibility fixture does not cover '${symbol}'`)
  }
}
const coreProviderCompatibilityPolicy = topology.coreProviderCompatibilityPolicy
if (coreProviderCompatibilityPolicy.source !== 'consumers/core-provider-api-compatibility.ts'
  || coreProviderCompatibilityPolicy.currentConfig !== 'tsconfig.current-core-provider.json'
  || coreProviderCompatibilityPolicy.targetConfig !== 'tsconfig.json'
  || coreProviderCompatibilityPolicy.evidence !== 'same-source-dual-current-target-compile') {
  fail('core provider/retry/utility compatibility policy drifted')
}
if (coreProviderCompatibilityPolicy.coveredSymbols.length !== 67
  || new Set(coreProviderCompatibilityPolicy.coveredSymbols).size !== 67) {
  fail('core provider/retry/utility compatibility inventory must contain 67 unique restored symbols')
}
if (coreProviderCompatibilityPolicy.signatureSensitiveExistingSymbols.length !== 15
  || new Set(coreProviderCompatibilityPolicy.signatureSensitiveExistingSymbols).size !== 15) {
  fail('core provider/retry/utility compatibility inventory must contain 15 signature-sensitive existing symbols')
}
const coreProviderCompatibilitySource = readFileSync(
  join(contractRoot, coreProviderCompatibilityPolicy.source),
  'utf8',
)
for (const symbol of [
  ...coreProviderCompatibilityPolicy.coveredSymbols,
  ...coreProviderCompatibilityPolicy.signatureSensitiveExistingSymbols,
]) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`\\b${escaped}\\b`).test(coreProviderCompatibilitySource)) {
    fail(`core provider/retry/utility compatibility fixture does not cover '${symbol}'`)
  }
}
const protocolCompatibilityPolicy = topology.protocolCompatibilityPolicy
if (protocolCompatibilityPolicy.advancedProtocol !== 'preserve-marker-free-protocol-definition'
  || protocolCompatibilityPolicy.runtimeProtocol !== 'add-marker-based-intersection-view-on-same-value'
  || protocolCompatibilityPolicy.sameNameSemanticRepurpose !== false
  || protocolCompatibilityPolicy.evidence !== 'same-source-dual-current-target-compile') {
  fail('wire protocol advanced/runtime compatibility policy drifted')
}
assertSameSet(
  'wire protocol compatibility packages',
  new Set(Object.keys(protocolCompatibilityPolicy.packages)),
  new Set([
    '@ai-agent-sdk/protocol-responses',
    '@ai-agent-sdk/protocol-anthropic-messages',
  ]),
)
for (const [packageName, policy] of Object.entries(protocolCompatibilityPolicy.packages)) {
  if (policy.targetConfig !== 'tsconfig.json') {
    fail(`wire protocol compatibility target config drifted for '${packageName}'`)
  }
  const baseline = retainedPackageApiBaseline.sources[packageName]
  if (baseline === undefined) fail(`wire protocol compatibility lacks baseline '${packageName}'`)
  const source = readFileSync(join(contractRoot, policy.source), 'utf8')
  for (const symbol of baseline.exports) {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`\\b${escaped}\\b`).test(source)) {
      fail(`wire protocol compatibility fixture '${packageName}' does not cover '${symbol}'`)
    }
  }
}
const mcpCompatibilityPolicy = topology.mcpCompatibilityPolicy
if (mcpCompatibilityPolicy.universalClientOwner !== '@ai-agent-sdk/mcp'
  || mcpCompatibilityPolicy.universalServerOwner !== '@ai-agent-sdk/mcp-server'
  || mcpCompatibilityPolicy.nodeClientOwner !== '@ai-agent-sdk/mcp-node'
  || mcpCompatibilityPolicy.nodeServerOwner !== '@ai-agent-sdk/mcp-node-server'
  || mcpCompatibilityPolicy.legacyServerRoute !== '@ai-agent-sdk/mcp/server'
  || mcpCompatibilityPolicy.legacyServerRouteKind !== 'optional-peer-reexport-view'
  || mcpCompatibilityPolicy.rootMovesRequireDecision !== 'P0-14'
  || mcpCompatibilityPolicy.advancedClose !== 'close-returns-promise-void'
  || mcpCompatibilityPolicy.reportedClose !== 'distinct-closeWithReport-method'
  || mcpCompatibilityPolicy.internalErrorField !== 'error'
  || mcpCompatibilityPolicy.supportSafeErrorField !== 'supportError'
  || mcpCompatibilityPolicy.sameNameSemanticRepurpose !== false
  || mcpCompatibilityPolicy.source !== 'consumers/mcp-api-compatibility.ts'
  || mcpCompatibilityPolicy.currentConfig !== 'tsconfig.current-mcp-compatibility.json'
  || mcpCompatibilityPolicy.targetConfig !== 'tsconfig.json'
  || mcpCompatibilityPolicy.evidence !== 'same-source-dual-current-target-route-compile') {
  fail('MCP compatibility and split-route policy drifted')
}
assertSameSet(
  'MCP compatibility entrypoints',
  new Set(mcpCompatibilityPolicy.entrypoints),
  new Set([
    '@ai-agent-sdk/mcp',
    '@ai-agent-sdk/mcp/client',
    '@ai-agent-sdk/mcp/server',
    '@ai-agent-sdk/mcp-node',
  ]),
)
const mcpCompatibilitySource = readFileSync(
  join(contractRoot, mcpCompatibilityPolicy.source),
  'utf8',
)
for (const proof of [
  'const closing: Promise<void> = connection.close()',
  "from '@compat/mcp-client'",
  "from '@compat/mcp-server'",
  "from '@compat/mcp-node-client'",
  "from '@compat/mcp-node-server'",
]) {
  if (!mcpCompatibilitySource.includes(proof)) {
    fail(`MCP compatibility fixture lacks '${proof}'`)
  }
}
for (const entrypoint of mcpCompatibilityPolicy.entrypoints) {
  const baseline = retainedPackageApiBaseline.sources[entrypoint]
  if (baseline === undefined) fail(`MCP compatibility lacks baseline '${entrypoint}'`)
  for (const symbol of baseline.exports) {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`\\b${escaped}\\b`).test(mcpCompatibilitySource)) {
      fail(`MCP compatibility fixture does not cover '${entrypoint}:${symbol}'`)
    }
  }
}
const targetMcpConfig = JSON.parse(
  readFileSync(join(contractRoot, 'tsconfig.json'), 'utf8'),
) as { readonly compilerOptions?: { readonly paths?: Readonly<Record<string, readonly string[]>> } }
assertSameSet(
  'MCP target compatibility aliases',
  new Set(Object.entries(targetMcpConfig.compilerOptions?.paths ?? {})
    .filter(([specifier]) => specifier.startsWith('@compat/mcp-'))
    .map(([specifier, paths]) => `${specifier}=${paths[0] ?? ''}`)),
  new Set([
    '@compat/mcp-client=./packages/mcp/client.d.ts',
    '@compat/mcp-server=./packages/mcp/server.d.ts',
    '@compat/mcp-node-client=./packages/mcp-node/index.d.ts',
    '@compat/mcp-node-server=./packages/mcp-node-server/index.d.ts',
  ]),
)
const currentMcpConfig = JSON.parse(
  readFileSync(join(contractRoot, mcpCompatibilityPolicy.currentConfig), 'utf8'),
) as { readonly compilerOptions?: { readonly paths?: Readonly<Record<string, readonly string[]>> } }
assertSameSet(
  'MCP current compatibility aliases',
  new Set(Object.entries(currentMcpConfig.compilerOptions?.paths ?? {})
    .filter(([specifier]) => specifier.startsWith('@compat/mcp-'))
    .map(([specifier, paths]) => `${specifier}=${paths[0] ?? ''}`)),
  new Set([
    '@compat/mcp-client=../../packages/mcp/dist/client.d.ts',
    '@compat/mcp-server=../../packages/mcp/dist/server.d.ts',
    '@compat/mcp-node-client=../../packages/mcp-node/dist/index.d.mts',
    '@compat/mcp-node-server=../../packages/mcp-node-server/dist/index.d.mts',
  ]),
)
const mcpDeclaration = readFileSync(join(contractRoot, 'packages/mcp/index.d.ts'), 'utf8')
for (const proof of [
  'readonly error?: Error',
  'readonly supportError?: SupportSafeError',
  'close(): Promise<void>',
  'closeWithReport(',
]) {
  if (!mcpDeclaration.includes(proof)) fail(`MCP compatibility declaration lacks '${proof}'`)
}
assertSameSet(
  'MCP client root closure imports',
  new Set(importsOf(join(contractRoot, 'packages/mcp/index.d.ts'))),
  new Set([
    '@ai-agent-sdk/core/agent',
    '@ai-agent-sdk/core/tools',
  ]),
)
assertSameSet(
  'MCP /client identity imports',
  new Set(importsOf(join(contractRoot, 'packages/mcp/client.d.ts'))),
  new Set(['./index.js']),
)
assertSameSet(
  'MCP /server optional peer imports',
  new Set(importsOf(join(contractRoot, 'packages/mcp/server.d.ts'))),
  new Set(['@ai-agent-sdk/mcp-server']),
)
if (importsOf(join(contractRoot, 'packages/mcp-node/index.d.ts'))
  .some(specifier => specifier.includes('server'))) {
  fail('MCP Node client declaration must not import a server package or server SDK subpath')
}
const authCompatibilityPolicy = topology.authCompatibilityPolicy
if (authCompatibilityPolicy.envRootClosure !== 'core-plus-auth-node-only'
  || authCompatibilityPolicy.codexRoute !== 'optional-provider-codex-peer'
  || authCompatibilityPolicy.legacyEnvResult !== 'callable-zero-argument-string-resolver'
  || authCompatibilityPolicy.runtimeEnvResult
    !== 'credential-source-intersection-on-same-callable-value'
  || authCompatibilityPolicy.legacyCodexStore !== 'preserve-read-write-contract'
  || authCompatibilityPolicy.runtimeCodexStore
    !== 'distinct-codex-credential-store-with-revisioned-read-commit'
  || authCompatibilityPolicy.legacyNodeFactory
    !== 'preserve-codex-node-adapter-and-plugin'
  || authCompatibilityPolicy.runtimeNodeFactory !== 'distinct-codex-node-provider-plugin'
  || authCompatibilityPolicy.sameNameSemanticRepurpose !== false
  || authCompatibilityPolicy.source !== 'consumers/auth-api-compatibility.ts'
  || authCompatibilityPolicy.currentConfig !== 'tsconfig.current-auth-compatibility.json'
  || authCompatibilityPolicy.targetConfig !== 'tsconfig.json'
  || authCompatibilityPolicy.evidence !== 'same-source-dual-current-target-route-compile') {
  fail('Auth/Codex compatibility and closure policy drifted')
}
assertSameSet(
  'Auth/Codex compatibility entrypoints',
  new Set(authCompatibilityPolicy.entrypoints),
  new Set([
    '@ai-agent-sdk/auth-node',
    '@ai-agent-sdk/auth-node/env',
    '@ai-agent-sdk/auth-node/codex',
    '@ai-agent-sdk/provider-codex',
  ]),
)
const authCompatibilitySource = readFileSync(
  join(contractRoot, authCompatibilityPolicy.source),
  'utf8',
)
for (const entrypoint of authCompatibilityPolicy.entrypoints) {
  const baseline = retainedPackageApiBaseline.sources[entrypoint]
    ?? providerApiBaseline.sources[entrypoint]
  if (baseline === undefined) fail(`Auth/Codex compatibility lacks baseline '${entrypoint}'`)
  for (const symbol of baseline.exports) {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`\\b${escaped}\\b`).test(authCompatibilitySource)) {
      fail(`Auth/Codex compatibility fixture does not cover '${entrypoint}:${symbol}'`)
    }
  }
}
for (const proof of [
  'const callableRootCredential: () => string',
  'const callablePathCredential: () => string',
  'mutableFile.auth_mode =',
  'const legacyStore: CodexAuthStore',
  'async read()',
  'async write(file)',
  'fileCodexAuthStore(undefined, { cwd:',
]) {
  if (!authCompatibilitySource.includes(proof)) {
    fail(`Auth/Codex compatibility fixture lacks '${proof}'`)
  }
}
const targetAuthConfig = JSON.parse(
  readFileSync(join(contractRoot, 'tsconfig.json'), 'utf8'),
) as { readonly compilerOptions?: { readonly paths?: Readonly<Record<string, readonly string[]>> } }
assertSameSet(
  'Auth/Codex target compatibility aliases',
  new Set(Object.entries(targetAuthConfig.compilerOptions?.paths ?? {})
    .filter(([specifier]) => specifier.startsWith('@compat/auth-')
      || specifier === '@compat/provider-codex')
    .map(([specifier, paths]) => `${specifier}=${paths[0] ?? ''}`)),
  new Set([
    '@compat/auth-root=./packages/auth-node/index.d.ts',
    '@compat/auth-env=./packages/auth-node/env.d.ts',
    '@compat/auth-codex=./packages/auth-node/codex.d.ts',
    '@compat/provider-codex=./packages/provider-codex/index.d.ts',
  ]),
)
const currentAuthConfig = JSON.parse(
  readFileSync(join(contractRoot, authCompatibilityPolicy.currentConfig), 'utf8'),
) as { readonly compilerOptions?: { readonly paths?: Readonly<Record<string, readonly string[]>> } }
assertSameSet(
  'Auth/Codex current compatibility aliases',
  new Set(Object.entries(currentAuthConfig.compilerOptions?.paths ?? {})
    .filter(([specifier]) => specifier.startsWith('@compat/auth-')
      || specifier === '@compat/provider-codex')
    .map(([specifier, paths]) => `${specifier}=${paths[0] ?? ''}`)),
  new Set([
    '@compat/auth-root=../../packages/auth-node/dist/index.d.mts',
    '@compat/auth-env=../../packages/auth-node/dist/env.d.mts',
    '@compat/auth-codex=../../packages/auth-node/dist/codex.d.mts',
    '@compat/provider-codex=../../packages/provider-codex/dist/index.d.ts',
  ]),
)
const targetAuthRootDeclaration = readFileSync(
  join(contractRoot, 'packages/auth-node/index.d.ts'),
  'utf8',
)
for (const proof of [
  'CredentialSource & (() => string)',
  'apiKeyFromEnv: typeof envCredential',
]) {
  if (!targetAuthRootDeclaration.includes(proof)) {
    fail(`auth-node env compatibility declaration lacks '${proof}'`)
  }
}
const targetCodexDeclaration = readFileSync(
  join(contractRoot, 'packages/provider-codex/index.d.ts'),
  'utf8',
)
for (const proof of [
  'export interface CodexAuthStore',
  'read(): Promise<CodexAuthFile | undefined>',
  'write(file: CodexAuthFile): Promise<void>',
  'export type CodexCredentialStore = CredentialStore<CodexAuthFile>',
  'export interface CodexRevisionedAdapterOptions',
]) {
  if (!targetCodexDeclaration.includes(proof)) {
    fail(`provider-codex compatibility declaration lacks '${proof}'`)
  }
}
const a2aCompatibilityPolicy = topology.a2aCompatibilityPolicy
if (a2aCompatibilityPolicy.root !== 'combined-client-server-compatibility-view'
  || a2aCompatibilityPolicy.client !== 'same-specifier-client-owner'
  || a2aCompatibilityPolicy.server !== 'same-specifier-server-owner'
  || a2aCompatibilityPolicy.sameNameSemanticRepurpose !== false
  || a2aCompatibilityPolicy.source !== 'consumers/a2a-api-compatibility.ts'
  || a2aCompatibilityPolicy.currentConfig !== 'tsconfig.current-a2a-compatibility.json'
  || a2aCompatibilityPolicy.targetConfig !== 'tsconfig.json'
  || a2aCompatibilityPolicy.evidence !== 'same-source-dual-current-target-route-compile') {
  fail('A2A compatibility and route policy drifted')
}
assertSameSet(
  'A2A compatibility entrypoints',
  new Set(a2aCompatibilityPolicy.entrypoints),
  new Set(['@ai-agent-sdk/a2a', '@ai-agent-sdk/a2a/client', '@ai-agent-sdk/a2a/server']),
)
const a2aCompatibilitySource = readFileSync(
  join(contractRoot, a2aCompatibilityPolicy.source),
  'utf8',
)
for (const proof of [
  "from '@compat/a2a-client'",
  "from '@compat/a2a-server'",
  "from '@compat/a2a-root'",
  'const clientOptions: A2AAgentLinkOptions',
  "await executor.dispose('compatibility')",
]) {
  if (!a2aCompatibilitySource.includes(proof)) {
    fail(`A2A compatibility fixture lacks '${proof}'`)
  }
}
const targetA2aConfig = JSON.parse(
  readFileSync(join(contractRoot, 'tsconfig.json'), 'utf8'),
) as { readonly compilerOptions?: { readonly paths?: Readonly<Record<string, readonly string[]>> } }
assertSameSet(
  'A2A target compatibility aliases',
  new Set(Object.entries(targetA2aConfig.compilerOptions?.paths ?? {})
    .filter(([specifier]) => specifier.startsWith('@compat/a2a-'))
    .map(([specifier, paths]) => `${specifier}=${paths[0] ?? ''}`)),
  new Set([
    '@compat/a2a-root=./packages/a2a/index.d.ts',
    '@compat/a2a-client=./packages/a2a/client.d.ts',
    '@compat/a2a-server=./packages/a2a/server.d.ts',
  ]),
)
const currentA2aConfig = JSON.parse(
  readFileSync(join(contractRoot, a2aCompatibilityPolicy.currentConfig), 'utf8'),
) as { readonly compilerOptions?: { readonly paths?: Readonly<Record<string, readonly string[]>> } }
assertSameSet(
  'A2A current compatibility aliases',
  new Set(Object.entries(currentA2aConfig.compilerOptions?.paths ?? {})
    .filter(([specifier]) => specifier.startsWith('@compat/a2a-'))
    .map(([specifier, paths]) => `${specifier}=${paths[0] ?? ''}`)),
  new Set([
    '@compat/a2a-root=../../packages/a2a/dist/index.d.mts',
    '@compat/a2a-client=../../packages/a2a/dist/client.d.mts',
    '@compat/a2a-server=../../packages/a2a/dist/server.d.mts',
  ]),
)
assertSameSet(
  'A2A combined root declaration views',
  new Set(importsOf(join(contractRoot, 'packages/a2a/index.d.ts'))),
  new Set(['./client.js', './server.js']),
)
assertSameSet(
  'A2A client declaration closure',
  new Set(importsOf(join(contractRoot, 'packages/a2a/client.d.ts'))),
  new Set(['@a2a-js/sdk', '@a2a-js/sdk/client', '@ai-agent-sdk/core/agent']),
)
assertSameSet(
  'A2A server declaration closure',
  new Set(importsOf(join(contractRoot, 'packages/a2a/server.d.ts'))),
  new Set([
    '@a2a-js/sdk',
    '@a2a-js/sdk/server',
    '@ai-agent-sdk/core/agent',
    '@ai-agent-sdk/core/provider',
  ]),
)
const runtimeTeamRemoteLinkPolicy = topology.runtimeTeamRemoteLinkPolicy
if (runtimeTeamRemoteLinkPolicy.bridge !== 'structural-linkAgent-contract'
  || runtimeTeamRemoteLinkPolicy.transportOwnership !== 'borrowed-caller-owned'
  || runtimeTeamRemoteLinkPolicy.teamClose !== 'unlink-only-never-close-transport'
  || runtimeTeamRemoteLinkPolicy.unlink !== 'synchronous-idempotent'
  || runtimeTeamRemoteLinkPolicy.messageAdmission !== 'team-operation-lease-with-bounds-and-support-safe-errors'
  || runtimeTeamRemoteLinkPolicy.remoteRun !== 'sendMessage-not-session-or-run'
  || runtimeTeamRemoteLinkPolicy.a2aCompatibility !== 'legacy-and-runtime-team-structural-acceptance') {
  fail('runtime-team remote-link ownership policy drifted')
}
const agentToolCompatibilityPolicy = topology.agentToolCompatibilityPolicy
if (agentToolCompatibilityPolicy.source !== 'consumers/agent-tool-api-compatibility.ts'
  || agentToolCompatibilityPolicy.currentConfig !== 'tsconfig.current-agent-tool.json'
  || agentToolCompatibilityPolicy.targetConfig !== 'tsconfig.json'
  || agentToolCompatibilityPolicy.evidence !== 'same-source-dual-current-target-compile') {
  fail('agent tool compatibility policy drifted')
}
if (agentToolCompatibilityPolicy.coveredSymbols.length !== 25
  || new Set(agentToolCompatibilityPolicy.coveredSymbols).size !== 25) {
  fail('agent tool compatibility inventory must contain 25 unique restored symbols')
}
if (agentToolCompatibilityPolicy.signatureSensitiveExistingSymbols.length !== 14
  || new Set(agentToolCompatibilityPolicy.signatureSensitiveExistingSymbols).size !== 14) {
  fail('agent tool compatibility inventory must contain 14 signature-sensitive existing symbols')
}
const agentToolCompatibilitySource = readFileSync(
  join(contractRoot, agentToolCompatibilityPolicy.source),
  'utf8',
)
for (const symbol of [
  ...agentToolCompatibilityPolicy.coveredSymbols,
  ...agentToolCompatibilityPolicy.signatureSensitiveExistingSymbols,
]) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`\\b${escaped}\\b`).test(agentToolCompatibilitySource)) {
    fail(`agent tool compatibility fixture does not cover '${symbol}'`)
  }
}
const agentSkillCompatibilityPolicy = topology.agentSkillCompatibilityPolicy
if (agentSkillCompatibilityPolicy.source !== 'consumers/agent-skill-api-compatibility.ts'
  || agentSkillCompatibilityPolicy.currentConfig !== 'tsconfig.current-agent-skill.json'
  || agentSkillCompatibilityPolicy.targetConfig !== 'tsconfig.json'
  || agentSkillCompatibilityPolicy.evidence !== 'same-source-dual-current-target-compile'
  || agentSkillCompatibilityPolicy.legacyProvider !== 'preserve-current-candidate-list-load-resource-contract'
  || agentSkillCompatibilityPolicy.runtimeProvider !== 'distinct-versioned-skill-provider-plugin-with-revision-reference'
  || agentSkillCompatibilityPolicy.sameNameSemanticRepurpose !== false) {
  fail('agent skill compatibility/versioned-plugin policy drifted')
}
if (agentSkillCompatibilityPolicy.coveredSymbols.length !== 21
  || new Set(agentSkillCompatibilityPolicy.coveredSymbols).size !== 21) {
  fail('agent skill compatibility inventory must contain 21 unique restored symbols')
}
if (agentSkillCompatibilityPolicy.signatureSensitiveExistingSymbols.length !== 9
  || new Set(agentSkillCompatibilityPolicy.signatureSensitiveExistingSymbols).size !== 9) {
  fail('agent skill compatibility inventory must contain 9 signature-sensitive existing symbols')
}
const agentSkillCompatibilitySource = readFileSync(
  join(contractRoot, agentSkillCompatibilityPolicy.source),
  'utf8',
)
for (const symbol of [
  ...agentSkillCompatibilityPolicy.coveredSymbols,
  ...agentSkillCompatibilityPolicy.signatureSensitiveExistingSymbols,
]) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`\\b${escaped}\\b`).test(agentSkillCompatibilitySource)) {
    fail(`agent skill compatibility fixture does not cover '${symbol}'`)
  }
}
const agentMemoryHistoryCompatibilityPolicy = topology.agentMemoryHistoryCompatibilityPolicy
if (agentMemoryHistoryCompatibilityPolicy.source !== 'consumers/agent-memory-history-api-compatibility.ts'
  || agentMemoryHistoryCompatibilityPolicy.currentConfig !== 'tsconfig.current-agent-memory-history.json'
  || agentMemoryHistoryCompatibilityPolicy.targetConfig !== 'tsconfig.json'
  || agentMemoryHistoryCompatibilityPolicy.evidence !== 'same-source-dual-current-target-compile') {
  fail('agent memory/history compatibility policy drifted')
}
if (agentMemoryHistoryCompatibilityPolicy.coveredSymbols.length !== 28
  || new Set(agentMemoryHistoryCompatibilityPolicy.coveredSymbols).size !== 28) {
  fail('agent memory/history compatibility inventory must contain 28 unique restored symbols')
}
if (agentMemoryHistoryCompatibilityPolicy.signatureSensitiveExistingSymbols.length !== 7
  || new Set(agentMemoryHistoryCompatibilityPolicy.signatureSensitiveExistingSymbols).size !== 7) {
  fail('agent memory/history compatibility inventory must contain 7 signature-sensitive existing symbols')
}
const agentMemoryHistoryCompatibilitySource = readFileSync(
  join(contractRoot, agentMemoryHistoryCompatibilityPolicy.source),
  'utf8',
)
for (const symbol of [
  ...agentMemoryHistoryCompatibilityPolicy.coveredSymbols,
  ...agentMemoryHistoryCompatibilityPolicy.signatureSensitiveExistingSymbols,
]) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`\\b${escaped}\\b`).test(agentMemoryHistoryCompatibilitySource)) {
    fail(`agent memory/history compatibility fixture does not cover '${symbol}'`)
  }
}
const agentAccountingTraceCompatibilityPolicy = topology.agentAccountingTraceCompatibilityPolicy
if (agentAccountingTraceCompatibilityPolicy.source !== 'consumers/agent-accounting-trace-api-compatibility.ts'
  || agentAccountingTraceCompatibilityPolicy.currentConfig !== 'tsconfig.current-agent-accounting-trace.json'
  || agentAccountingTraceCompatibilityPolicy.targetConfig !== 'tsconfig.json'
  || agentAccountingTraceCompatibilityPolicy.evidence !== 'same-source-dual-current-target-compile') {
  fail('agent accounting/trace compatibility policy drifted')
}
if (agentAccountingTraceCompatibilityPolicy.coveredSymbols.length !== 16
  || new Set(agentAccountingTraceCompatibilityPolicy.coveredSymbols).size !== 16) {
  fail('agent accounting/trace compatibility inventory must contain 16 unique restored symbols')
}
if (agentAccountingTraceCompatibilityPolicy.signatureSensitiveExistingSymbols.length !== 8
  || new Set(agentAccountingTraceCompatibilityPolicy.signatureSensitiveExistingSymbols).size !== 8) {
  fail('agent accounting/trace compatibility inventory must contain 8 signature-sensitive existing symbols')
}
const agentAccountingTraceCompatibilitySource = readFileSync(
  join(contractRoot, agentAccountingTraceCompatibilityPolicy.source),
  'utf8',
)
for (const symbol of [
  ...agentAccountingTraceCompatibilityPolicy.coveredSymbols,
  ...agentAccountingTraceCompatibilityPolicy.signatureSensitiveExistingSymbols,
]) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`\\b${escaped}\\b`).test(agentAccountingTraceCompatibilitySource)) {
    fail(`agent accounting/trace compatibility fixture does not cover '${symbol}'`)
  }
}
const agentLoopDefinitionCompatibilityPolicy = topology.agentLoopDefinitionCompatibilityPolicy
if (agentLoopDefinitionCompatibilityPolicy.source !== 'consumers/agent-loop-definition-api-compatibility.ts'
  || agentLoopDefinitionCompatibilityPolicy.currentConfig !== 'tsconfig.current-agent-loop-definition.json'
  || agentLoopDefinitionCompatibilityPolicy.targetConfig !== 'tsconfig.json'
  || agentLoopDefinitionCompatibilityPolicy.evidence !== 'same-source-dual-current-target-compile'
  || agentLoopDefinitionCompatibilityPolicy.legacyEventProtocol !== 'preserve-current-agent-and-agent-run-events'
  || agentLoopDefinitionCompatibilityPolicy.runtimeEventProtocol !== 'distinct-runtime-agent-run-event'
  || agentLoopDefinitionCompatibilityPolicy.legacyDefinitionProtocol !== 'preserve-current-defined-agent-and-session'
  || agentLoopDefinitionCompatibilityPolicy.runtimeDefinitionProtocol !== 'distinct-runtime-agent-definition-and-session'
  || agentLoopDefinitionCompatibilityPolicy.runtimeDefinitionDiscriminant !== 'required-model-target-object'
  || agentLoopDefinitionCompatibilityPolicy.legacyDefinitionDiscriminant !== 'model-string-or-omitted'
  || agentLoopDefinitionCompatibilityPolicy.normalRuntimeEntry !== 'runtime-agent-accepts-runtime-definition-input-directly'
  || agentLoopDefinitionCompatibilityPolicy.factorySideEffects !== 'none'
  || agentLoopDefinitionCompatibilityPolicy.sameNameSemanticRepurpose !== false) {
  fail('agent loop/definition compatibility split policy drifted')
}
if (agentLoopDefinitionCompatibilityPolicy.coveredSymbols.length !== 27
  || new Set(agentLoopDefinitionCompatibilityPolicy.coveredSymbols).size !== 27) {
  fail('agent loop/definition compatibility inventory must contain 27 unique restored symbols')
}
if (agentLoopDefinitionCompatibilityPolicy.signatureSensitiveExistingSymbols.length !== 15
  || new Set(agentLoopDefinitionCompatibilityPolicy.signatureSensitiveExistingSymbols).size !== 15) {
  fail('agent loop/definition compatibility inventory must contain 15 signature-sensitive existing symbols')
}
const agentLoopDefinitionCompatibilitySource = readFileSync(
  join(contractRoot, agentLoopDefinitionCompatibilityPolicy.source),
  'utf8',
)
for (const symbol of [
  ...agentLoopDefinitionCompatibilityPolicy.coveredSymbols,
  ...agentLoopDefinitionCompatibilityPolicy.signatureSensitiveExistingSymbols,
]) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`\\b${escaped}\\b`).test(agentLoopDefinitionCompatibilitySource)) {
    fail(`agent loop/definition compatibility fixture does not cover '${symbol}'`)
  }
}
const agentTeamCompatibilityPolicy = topology.agentTeamCompatibilityPolicy
if (agentTeamCompatibilityPolicy.source !== 'consumers/agent-team-api-compatibility.ts'
  || agentTeamCompatibilityPolicy.currentConfig !== 'tsconfig.current-agent-team.json'
  || agentTeamCompatibilityPolicy.targetConfig !== 'tsconfig.json'
  || agentTeamCompatibilityPolicy.evidence !== 'same-source-dual-current-target-compile'
  || agentTeamCompatibilityPolicy.legacyTeamProtocol !== 'preserve-current-local-remote-control-plane'
  || agentTeamCompatibilityPolicy.runtimeTeamProtocol !== 'distinct-runtime-agent-team'
  || agentTeamCompatibilityPolicy.sameNameSemanticRepurpose !== false) {
  fail('agent team compatibility split policy drifted')
}
if (agentTeamCompatibilityPolicy.coveredSymbols.length !== 25
  || new Set(agentTeamCompatibilityPolicy.coveredSymbols).size !== 25) {
  fail('agent team compatibility inventory must contain 25 unique restored symbols')
}
if (agentTeamCompatibilityPolicy.signatureSensitiveExistingSymbols.length !== 2
  || new Set(agentTeamCompatibilityPolicy.signatureSensitiveExistingSymbols).size !== 2) {
  fail('agent team compatibility inventory must contain two signature-sensitive existing symbols')
}
const agentTeamCompatibilitySource = readFileSync(
  join(contractRoot, agentTeamCompatibilityPolicy.source),
  'utf8',
)
for (const symbol of [
  ...agentTeamCompatibilityPolicy.coveredSymbols,
  ...agentTeamCompatibilityPolicy.signatureSensitiveExistingSymbols,
]) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`\\b${escaped}\\b`).test(agentTeamCompatibilitySource)) {
    fail(`agent team compatibility fixture does not cover '${symbol}'`)
  }
}
const localExecutableLeafPolicy = topology.localExecutableLeafPolicy
if (localExecutableLeafPolicy.marker !== 'none-core-owned-leaf-contracts'
  || localExecutableLeafPolicy.captureAt !== 'agent-session-binding-before-run'
  || localExecutableLeafPolicy.capturedConfiguration !== 'detached-bounded-readonly'
  || localExecutableLeafPolicy.capturedMethods !== 'runtime-used-function-references-once'
  || localExecutableLeafPolicy.methodReceiver !== 'original-leaf-object'
  || localExecutableLeafPolicy.operationalStateMayMutate !== true
  || localExecutableLeafPolicy.callerObjectMutationOrFreeze !== false
  || localExecutableLeafPolicy.rereadRuntimeMethodsAfterCapture !== false
  || localExecutableLeafPolicy.postCaptureReplacement !== 'no-effect-on-bound-session'
  || localExecutableLeafPolicy.requiredCancellation !== 'broker-and-hook-context-signals') {
  fail('local executable leaf capture policy drifted')
}
assertSameSet(
  'local executable leaf families',
  new Set(localExecutableLeafPolicy.families),
  new Set([
    'approval-broker',
    'user-input-broker',
    'tool-interceptor',
    'turn-hooks',
    'usage-estimator',
  ]),
)
const deterministicTestEvidencePolicy = topology.deterministicTestEvidencePolicy
if (deterministicTestEvidencePolicy.privacyAssertion !== 'structural-field-absence-or-unique-non-id-sentinel'
  || deterministicTestEvidencePolicy.randomIdentifierFields !== 'never-global-substring-asserted-with-short-sentinel'
  || deterministicTestEvidencePolicy.rerunAfterRandomCollision !== 'classify-flake-and-retain-initial-failure'
  || deterministicTestEvidencePolicy.focusedPass !== 'diagnostic-evidence-not-erasure-of-suite-failure'
  || deterministicTestEvidencePolicy.liveNetworkProviderEvidence !== 'owner-authorized-targeted') {
  fail('deterministic test evidence policy drifted')
}
const memoryBindingPolicy = topology.memoryBindingPolicy
if (memoryBindingPolicy.compositionPrecedence !== 'session-false-or-binding-then-agent-binding-then-none'
  || memoryBindingPolicy.ownership !== 'always-borrowed-caller-owned-store'
  || memoryBindingPolicy.conversationKey !== 'versioned-collision-free-tuple-of-namespace-agent-id-conversation-id'
  || memoryBindingPolicy.fixedSharing !== 'requires-shared-across-sessions-true'
  || memoryBindingPolicy.snapshotIdentity !== 'support-safe-binding-id-only'
  || memoryBindingPolicy.resumeBinding !== 'exact-binding-id-match-required'
  || memoryBindingPolicy.keyAndNamespaceInDiagnostics !== false
  || memoryBindingPolicy.keyAndNamespaceInSnapshot !== false) {
  fail('memory binding isolation/resume policy drifted')
}
assertSameSet(
  'memory binding scope kinds',
  new Set(memoryBindingPolicy.scopeKinds),
  new Set(['conversation', 'fixed']),
)
const runtimeOperationPolicy = topology.runtimeOperationPolicy
if (runtimeOperationPolicy.admissionVsClose !== 'one-atomic-state-transition'
  || runtimeOperationPolicy.operationSignal !== 'caller-plus-runtime-root-plus-operation-deadline'
  || runtimeOperationPolicy.closeOrder !== 'reject-abort-quiesce-seal-dispose-flush'
  || runtimeOperationPolicy.providerCleanupAfterOperationQuiescence !== true
  || runtimeOperationPolicy.lateResultPublication !== 'discard-after-generation-seal'
  || runtimeOperationPolicy.loggerAfterClose !== 'closed-noop-never-reopens-observation'
  || runtimeOperationPolicy.closeReportPerKind !== true
  || runtimeOperationPolicy.closeReportRows !== 'fixed-order-including-zero'
  || runtimeOperationPolicy.closeReportInvariant !== 'active-equals-settled-plus-unsettled'
  || runtimeOperationPolicy.legacyRunCounters !== 'projection-of-agent-run-row'
  || runtimeOperationPolicy.concurrentClose !== 'first-call-starts-one-shared-terminal-task'
  || runtimeOperationPolicy.closeCallerSignal !== 'accelerates-quiescence-never-cancels-cleanup-or-rejects-close'
  || runtimeOperationPolicy.deadlineReached !== 'projection-of-quiescence-end-timeout') {
  fail('runtime operation admission/quiescence policy drifted')
}
assertSameSet(
  'runtime-tracked operation kinds',
  new Set(runtimeOperationPolicy.trackedKinds),
  new Set(['agent-run', 'model-catalog', 'manual-compaction', 'team-operation']),
)
assertSameSet(
  'runtime read-only surfaces after close',
  new Set(runtimeOperationPolicy.readOnlyAfterClose),
  new Set(['providers', 'diagnostics', 'close-report']),
)
assertSameSet(
  'runtime rejected surfaces after close',
  new Set(runtimeOperationPolicy.rejectAfterClose),
  new Set(['agent', 'team', 'modelCatalog', 'run', 'compact']),
)


}
// @ts-nocheck
