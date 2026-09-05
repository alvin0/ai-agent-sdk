// @ts-nocheck
import * as fs from 'node:fs'
import * as childProcess from 'node:child_process'
import * as path from 'node:path'
import type { ContractContext } from './context.mts'
import { makeHelpers } from './helpers.mts'

export function validateCompileContracts(ctx: ContractContext): void {
  const { workspace, contractRoot, topology } = ctx
  const { fail, assertSameSet } = makeHelpers(workspace, topology)
  const { readFileSync } = fs
  const { spawnSync } = childProcess
  const { join } = path
  void [workspace, contractRoot, topology, fail, assertSameSet, readFileSync, spawnSync, join]
const configPath = join(contractRoot, 'tsconfig.json')
const expectedModelDefaultsPolicy = {
  "agentOverride": "full-target-wins-per-agent",
  "providerDefault": "explicit-model-target-owned-by-claimed-route",
  "officialFactoryShorthand": "string-only-with-one-route-otherwise-explicit-target",
  "selection": "agent-route-then-runtime-defaultProvider-then-unique-configured-default",
  "missingOrAmbiguous": "reject-before-dispatch-no-registration-order-or-catalog-first",
  "invalidExplicitTarget": "reject-never-substitute-default",
  "capture": "detached-provider-defaults-at-preflight-resolved-agent-target-at-binding",
  "failover": "none-retries-keep-resolved-target",
  "reusableDefinitions": "preserve-model-object-versus-legacy-discriminant",
  "evidence": "resolved-agent-model-and-provider-attempt-target"
}
if (JSON.stringify(topology.modelDefaultsPolicy) !== JSON.stringify(expectedModelDefaultsPolicy)) {
  fail('model default selection policy drifted from the owner-approved per-agent override contract')
}
for (const field of ['readonly defaultModel?: ModelTarget', 'readonly defaultProvider?: string',
  'agent(definition: RuntimeAgentBindingInput): RuntimeAgent', 'readonly model: ModelTarget']) {
  if (!readFileSync(join(contractRoot, 'packages/core/index.d.ts'), 'utf8').includes(field)) {
    fail(`model default contract is missing '${field}'`)
  }
}
const compile = spawnSync('tsc', ['-p', configPath], {
  cwd: workspace,
  encoding: 'utf8',
  stdio: 'pipe',
})
if (compile.error !== undefined) fail(`could not start TypeScript compiler: ${compile.error.message}`)
if (compile.status !== 0) fail(`${compile.stdout}${compile.stderr}`.trim())
// Consumer-only compilation skips declaration bodies. Check mixed Node and
// Web-only surfaces separately; never use Node ambient types as Web evidence.
const strictWebConsumers = [
  'edge-minimal', 'capability-author', 'provider-author', 'provider-extension-author',
  'anthropic-provider-author', 'adapter-author', 'browser-observability', 'browser-durable-minimal',
].map(name => `consumers/${name}.ts`)
const webDeclarationPackages = Object.values(topology.packages)
  .filter(rule => rule.runtime !== 'node')
const webTypeDebtPackages = new Set(['mcp', 'mcp-server'])
const strictDeclarationConfigs = {
  'tsconfig.declarations-node.json': {
    extends: './tsconfig.json',
    compilerOptions: {
      skipLibCheck: false, module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'],
    },
  },
  'tsconfig.declarations-web-base.json': {
    extends: './tsconfig.json',
    compilerOptions: { skipLibCheck: false, types: [] },
    include: [
      ...webDeclarationPackages.filter(rule => !webTypeDebtPackages.has(rule.declarationDir))
        .map(rule => `packages/${rule.declarationDir}/**/*.d.ts`),
      ...strictWebConsumers,
    ],
  },
  'tsconfig.declarations-web-full.json': {
    extends: './tsconfig.declarations-web-base.json',
    include: [
      ...webDeclarationPackages.map(rule => `packages/${rule.declarationDir}/**/*.d.ts`),
      ...strictWebConsumers,
    ],
  },
}
for (const [name, expected] of Object.entries(strictDeclarationConfigs)) {
  const strictPath = join(contractRoot, name)
  const actual = JSON.parse(readFileSync(strictPath, 'utf8')) as Record<string, unknown>
  assertSameSet(`strict declaration config ${name} keys`, new Set(Object.keys(actual)), new Set(Object.keys(expected)))
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(value)) {
      fail(`strict declaration config '${name}' drifted at '${key}'`)
    }
  }
  if (name !== 'tsconfig.declarations-node.json') {
    const files = spawnSync('tsc', ['-p', strictPath, '--listFilesOnly', '--pretty', 'false'], {
      cwd: workspace, encoding: 'utf8', stdio: 'pipe',
    })
    if (files.error !== undefined || files.status !== 0) {
      fail(`could not inspect strict Web declaration closure: ${files.error?.message ?? files.stderr}`)
    }
    // types: [] does not prevent a dependency's triple-slash types reference
    // from importing Node globals. Inspect the actual compiler file closure too.
    if (/\/node_modules\/@types\/node\//.test(files.stdout.replaceAll('\\', '/'))) {
      fail(`${name} imported ambient Node types; Web portability cannot use that closure`)
    }
  }
  const result = spawnSync('tsc', ['-p', strictPath, '--pretty', 'false'], {
    cwd: workspace, encoding: 'utf8', stdio: 'pipe',
  })
  if (result.error !== undefined) fail(`could not start strict declaration compiler: ${result.error.message}`)
  if (result.status !== 0) fail(`${name}: ${result.stdout}${result.stderr}`.trim())
}
console.log('Strict declaration checks: NodeNext PASS; Web/Browser Bundler base PASS; full Web PASS without ambient Node types.')
const currentObservabilityCapabilityCompile = spawnSync(
  'tsc',
  ['-p', join(contractRoot, topology.observabilityCapabilityCompatibilityPolicy.currentConfig)],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' },
)
if (currentObservabilityCapabilityCompile.error !== undefined) {
  fail(`could not start current observability capability compatibility compiler: ${currentObservabilityCapabilityCompile.error.message}`)
}
if (currentObservabilityCapabilityCompile.status !== 0) {
  fail(`${currentObservabilityCapabilityCompile.stdout}${currentObservabilityCapabilityCompile.stderr}`.trim())
}
const currentMcpCompatibilityCompile = spawnSync(
  'tsc',
  ['-p', join(contractRoot, topology.mcpCompatibilityPolicy.currentConfig)],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' },
)
if (currentMcpCompatibilityCompile.error !== undefined) {
  fail(`could not start current MCP compatibility compiler: ${currentMcpCompatibilityCompile.error.message}`)
}
if (currentMcpCompatibilityCompile.status !== 0) {
  fail(`${currentMcpCompatibilityCompile.stdout}${currentMcpCompatibilityCompile.stderr}`.trim())
}
const currentAuthCompatibilityCompile = spawnSync(
  'tsc',
  ['-p', join(contractRoot, topology.authCompatibilityPolicy.currentConfig)],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' },
)
if (currentAuthCompatibilityCompile.error !== undefined) {
  fail(`could not start current Auth/Codex compatibility compiler: ${currentAuthCompatibilityCompile.error.message}`)
}
if (currentAuthCompatibilityCompile.status !== 0) {
  fail(`${currentAuthCompatibilityCompile.stdout}${currentAuthCompatibilityCompile.stderr}`.trim())
}
const currentA2aCompatibilityCompile = spawnSync(
  'tsc',
  ['-p', join(contractRoot, topology.a2aCompatibilityPolicy.currentConfig)],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' },
)
if (currentA2aCompatibilityCompile.error !== undefined) {
  fail(`could not start current A2A compatibility compiler: ${currentA2aCompatibilityCompile.error.message}`)
}
if (currentA2aCompatibilityCompile.status !== 0) {
  fail(`${currentA2aCompatibilityCompile.stdout}${currentA2aCompatibilityCompile.stderr}`.trim())
}
const currentSkillFilesystemCompile = spawnSync(
  'tsc',
  ['-p', join(contractRoot, 'tsconfig.current-skill-filesystem.json')],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' },
)
if (currentSkillFilesystemCompile.error !== undefined) {
  fail(`could not start current filesystem-skill compatibility compiler: ${currentSkillFilesystemCompile.error.message}`)
}
if (currentSkillFilesystemCompile.status !== 0) {
  fail(`${currentSkillFilesystemCompile.stdout}${currentSkillFilesystemCompile.stderr}`.trim())
}
const currentSkillValidationCompile = spawnSync(
  'tsc',
  ['-p', join(contractRoot, 'tsconfig.current-skill-validation.json')],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' },
)
if (currentSkillValidationCompile.error !== undefined) {
  fail(`could not start current skill-validation compatibility compiler: ${currentSkillValidationCompile.error.message}`)
}
if (currentSkillValidationCompile.status !== 0) {
  fail(`${currentSkillValidationCompile.stdout}${currentSkillValidationCompile.stderr}`.trim())
}
const currentProviderSignatureCompile = spawnSync(
  'tsc',
  ['-p', join(contractRoot, 'tsconfig.current-provider-signatures.json')],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' },
)
if (currentProviderSignatureCompile.error !== undefined) {
  fail(`could not start current provider signature compatibility compiler: ${currentProviderSignatureCompile.error.message}`)
}
if (currentProviderSignatureCompile.status !== 0) {
  fail(`${currentProviderSignatureCompile.stdout}${currentProviderSignatureCompile.stderr}`.trim())
}
const currentProviderExtensionAuthorCompile = spawnSync(
  'tsc',
  ['-p', join(contractRoot, 'tsconfig.current-provider-extension-author.json')],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' },
)
if (currentProviderExtensionAuthorCompile.error !== undefined) {
  fail(`could not start current provider extension author compiler: ${currentProviderExtensionAuthorCompile.error.message}`)
}
if (currentProviderExtensionAuthorCompile.status !== 0) {
  fail(`${currentProviderExtensionAuthorCompile.stdout}${currentProviderExtensionAuthorCompile.stderr}`.trim())
}
const currentOfficialProviderFactoriesCompile = spawnSync(
  'tsc',
  ['-p', join(contractRoot, 'tsconfig.current-official-provider-factories.json')],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' },
)
if (currentOfficialProviderFactoriesCompile.error !== undefined) {
  fail(`could not start current official provider factory compiler: ${currentOfficialProviderFactoriesCompile.error.message}`)
}
if (currentOfficialProviderFactoriesCompile.status !== 0) {
  fail(`${currentOfficialProviderFactoriesCompile.stdout}${currentOfficialProviderFactoriesCompile.stderr}`.trim())
}
const currentAdditiveCapabilitiesCompile = spawnSync(
  'tsc',
  ['-p', join(contractRoot, 'tsconfig.current-additive-capabilities.json')],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' },
)
if (currentAdditiveCapabilitiesCompile.error !== undefined) {
  fail(`could not start current additive capability compiler: ${currentAdditiveCapabilitiesCompile.error.message}`)
}
if (currentAdditiveCapabilitiesCompile.status !== 0) {
  fail(`${currentAdditiveCapabilitiesCompile.stdout}${currentAdditiveCapabilitiesCompile.stderr}`.trim())
}
const currentNodeAuthCapabilitiesCompile = spawnSync(
  'tsc',
  ['-p', join(contractRoot, 'tsconfig.current-node-auth-capabilities.json')],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' },
)
if (currentNodeAuthCapabilitiesCompile.error !== undefined) {
  fail(`could not start current Node auth capability compiler: ${currentNodeAuthCapabilitiesCompile.error.message}`)
}
if (currentNodeAuthCapabilitiesCompile.status !== 0) {
  fail(`${currentNodeAuthCapabilitiesCompile.stdout}${currentNodeAuthCapabilitiesCompile.stderr}`.trim())
}
for (const [packageName, policy] of Object.entries(topology.protocolCompatibilityPolicy.packages)) {
  const currentProtocolCompile = spawnSync('tsc', ['-p', join(contractRoot, policy.currentConfig)], {
    cwd: workspace,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  if (currentProtocolCompile.error !== undefined) {
    fail(`could not start current compatibility compiler for '${packageName}': ${currentProtocolCompile.error.message}`)
  }
  if (currentProtocolCompile.status !== 0) {
    fail(`${currentProtocolCompile.stdout}${currentProtocolCompile.stderr}`.trim())
  }
}
const currentCoreMessageConfigPath = join(
  contractRoot,
  topology.coreMessageCompatibilityPolicy.currentConfig,
)
const currentCoreMessageCompile = spawnSync('tsc', ['-p', currentCoreMessageConfigPath], {
  cwd: workspace,
  encoding: 'utf8',
  stdio: 'pipe',
})
if (currentCoreMessageCompile.error !== undefined) {
  fail(`could not start current core message compatibility compiler: ${currentCoreMessageCompile.error.message}`)
}
if (currentCoreMessageCompile.status !== 0) {
  fail(`${currentCoreMessageCompile.stdout}${currentCoreMessageCompile.stderr}`.trim())
}
const currentCoreProviderConfigPath = join(
  contractRoot,
  topology.coreProviderCompatibilityPolicy.currentConfig,
)
const currentCoreProviderCompile = spawnSync('tsc', ['-p', currentCoreProviderConfigPath], {
  cwd: workspace,
  encoding: 'utf8',
  stdio: 'pipe',
})
if (currentCoreProviderCompile.error !== undefined) {
  fail(`could not start current core provider compatibility compiler: ${currentCoreProviderCompile.error.message}`)
}
if (currentCoreProviderCompile.status !== 0) {
  fail(`${currentCoreProviderCompile.stdout}${currentCoreProviderCompile.stderr}`.trim())
}
const currentAgentToolConfigPath = join(
  contractRoot,
  topology.agentToolCompatibilityPolicy.currentConfig,
)
const currentAgentToolCompile = spawnSync('tsc', ['-p', currentAgentToolConfigPath], {
  cwd: workspace,
  encoding: 'utf8',
  stdio: 'pipe',
})
if (currentAgentToolCompile.error !== undefined) {
  fail(`could not start current agent tool compatibility compiler: ${currentAgentToolCompile.error.message}`)
}
if (currentAgentToolCompile.status !== 0) {
  fail(`${currentAgentToolCompile.stdout}${currentAgentToolCompile.stderr}`.trim())
}
const currentAgentSkillConfigPath = join(
  contractRoot,
  topology.agentSkillCompatibilityPolicy.currentConfig,
)
const currentAgentSkillCompile = spawnSync('tsc', ['-p', currentAgentSkillConfigPath], {
  cwd: workspace,
  encoding: 'utf8',
  stdio: 'pipe',
})
if (currentAgentSkillCompile.error !== undefined) {
  fail(`could not start current agent skill compatibility compiler: ${currentAgentSkillCompile.error.message}`)
}
if (currentAgentSkillCompile.status !== 0) {
  fail(`${currentAgentSkillCompile.stdout}${currentAgentSkillCompile.stderr}`.trim())
}
const currentAgentMemoryHistoryConfigPath = join(
  contractRoot,
  topology.agentMemoryHistoryCompatibilityPolicy.currentConfig,
)
const currentAgentMemoryHistoryCompile = spawnSync('tsc', ['-p', currentAgentMemoryHistoryConfigPath], {
  cwd: workspace,
  encoding: 'utf8',
  stdio: 'pipe',
})
if (currentAgentMemoryHistoryCompile.error !== undefined) {
  fail(`could not start current agent memory/history compatibility compiler: ${currentAgentMemoryHistoryCompile.error.message}`)
}
if (currentAgentMemoryHistoryCompile.status !== 0) {
  fail(`${currentAgentMemoryHistoryCompile.stdout}${currentAgentMemoryHistoryCompile.stderr}`.trim())
}
const currentAgentAccountingTraceConfigPath = join(
  contractRoot,
  topology.agentAccountingTraceCompatibilityPolicy.currentConfig,
)
const currentAgentAccountingTraceCompile = spawnSync('tsc', ['-p', currentAgentAccountingTraceConfigPath], {
  cwd: workspace,
  encoding: 'utf8',
  stdio: 'pipe',
})
if (currentAgentAccountingTraceCompile.error !== undefined) {
  fail(`could not start current agent accounting/trace compatibility compiler: ${currentAgentAccountingTraceCompile.error.message}`)
}
if (currentAgentAccountingTraceCompile.status !== 0) {
  fail(`${currentAgentAccountingTraceCompile.stdout}${currentAgentAccountingTraceCompile.stderr}`.trim())
}
const currentAgentLoopDefinitionConfigPath = join(
  contractRoot,
  topology.agentLoopDefinitionCompatibilityPolicy.currentConfig,
)
const currentAgentLoopDefinitionCompile = spawnSync('tsc', ['-p', currentAgentLoopDefinitionConfigPath], {
  cwd: workspace,
  encoding: 'utf8',
  stdio: 'pipe',
})
if (currentAgentLoopDefinitionCompile.error !== undefined) {
  fail(`could not start current agent loop/definition compatibility compiler: ${currentAgentLoopDefinitionCompile.error.message}`)
}
if (currentAgentLoopDefinitionCompile.status !== 0) {
  fail(`${currentAgentLoopDefinitionCompile.stdout}${currentAgentLoopDefinitionCompile.stderr}`.trim())
}
const currentAgentTeamConfigPath = join(
  contractRoot,
  topology.agentTeamCompatibilityPolicy.currentConfig,
)
const currentAgentTeamCompile = spawnSync('tsc', ['-p', currentAgentTeamConfigPath], {
  cwd: workspace,
  encoding: 'utf8',
  stdio: 'pipe',
})
if (currentAgentTeamCompile.error !== undefined) {
  fail(`could not start current agent team compatibility compiler: ${currentAgentTeamCompile.error.message}`)
}
if (currentAgentTeamCompile.status !== 0) {
  fail(`${currentAgentTeamCompile.stdout}${currentAgentTeamCompile.stderr}`.trim())
}
}
// @ts-nocheck
