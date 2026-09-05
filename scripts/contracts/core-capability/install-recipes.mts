// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validateDocumentedInstallRecipes(ctx: ContractContext): void {
  const {
    workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics,
  } = ctx
  const {
    relative, fail, runtimeRank, assertSameSet, parseImports, importsOf,
    parseTargetDeclarationExports, targetDeclarationExportsOf, publicExportsOf,
    listFiles, listCodeFiles, markdownExampleSpecifiers, externalPackageName,
    packageNameOf, externalImportOwner, externalClosure, workspaceClosure,
  } = makeHelpers(workspace, topology)
  const { readFileSync, existsSync, readdirSync } = fs
  const { join, resolve, dirname } = path
  const { createHash } = crypto
  void [
    workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics,
    relative, fail, runtimeRank, assertSameSet, parseImports, importsOf,
    parseTargetDeclarationExports, targetDeclarationExportsOf, publicExportsOf,
    listFiles, listCodeFiles, markdownExampleSpecifiers, externalPackageName,
    packageNameOf, externalImportOwner, externalClosure, workspaceClosure,
    readFileSync, existsSync, readdirSync, join, resolve, dirname, createHash,
    analyzeSourceOwnershipGraph,
  ]

  const packagePlan = readFileSync(join(workspace, 'docs/core-capability-package-plan.md'), 'utf8')
  const recipes = new Map([
    ['### 6.1 Edge Worker chat agent', 'edge-minimal'],
    ['### 6.2 Edge agent with remote telemetry and remote MCP', 'edge-capabilities'],
    ['### 6.3 Direct-browser BYOK agent with durable local observations (opt-in)', 'browser-durable-minimal'],
    ['### 6.4 Coding harness on Node', 'node-harness'],
    ['### 6.5 Minimal Node HTTP service', 'anthropic-minimal'],
    ['### 6.6 Responses-compatible third-party provider', 'provider-author'],
    ['### 6.7 Custom HTTP protocol provider', 'provider-extension-author'],
    ['### 6.8 Direct non-HTTP provider', 'adapter-author'],
    ['### 6.9 Browser observations with OpenTelemetry', 'browser-observability'],
    ['### 6.10 Node MCP server host', 'node-mcp-server-host'],
    ['### 6.11 Anthropic Messages-compatible third-party provider', 'anthropic-provider-author'],
    ['### 6.12 Link a remote A2A agent into a runtime team', 'node-a2a-runtime-team'],
    ['### 6.13 Edge MCP server host', 'edge-mcp-server-host'],
  ])
  for (const [heading, journeyId] of recipes) {
    const sectionStart = packagePlan.indexOf(heading)
    if (sectionStart < 0) fail(`package plan lacks documented install recipe '${heading}'`)
    const nextSection = packagePlan.indexOf('\n### ', sectionStart + heading.length)
    const section = packagePlan.slice(
      sectionStart,
      nextSection < 0 ? packagePlan.length : nextSection,
    )
    const commandBody = section.match(/```sh\s*\n(?<body>[\s\S]*?)\n```/)?.groups?.body
    if (commandBody === undefined) fail(`install recipe '${heading}' lacks a shell command`)
    const command = commandBody.replace(/\\\s*\n/g, ' ').replace(/\s+/g, ' ').trim()
    const tokens = command.split(' ')
    if (tokens[0] !== 'pnpm' || tokens[1] !== 'add') {
      fail(`install recipe '${heading}' must use one explicit 'pnpm add' command`)
    }
    const journey = topology.journeys.find(candidate => candidate.id === journeyId)
    if (journey === undefined) fail(`install recipe '${heading}' names unknown journey '${journeyId}'`)
    assertSameSet(
      `documented install recipe '${heading}'`,
      new Set(tokens.slice(2)),
      new Set([...journey.packages, ...(journey.directExternalPackages ?? [])]),
    )
  }
}
// @ts-nocheck
