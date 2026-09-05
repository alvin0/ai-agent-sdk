// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validatePhase0Decisions(ctx: ContractContext): void {
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

  if (phase0.targetPackageCount !== Object.keys(topology.packages).length) {
    fail(`Phase 0 targetPackageCount ${phase0.targetPackageCount} does not match topology`)
  }
  if (phase0.targetSpecifierCount !== packageBySpecifier.size) {
    fail(`Phase 0 targetSpecifierCount ${phase0.targetSpecifierCount} does not match topology`)
  }
  if (phase0.coreRootExportCount !== topology.coreRootFacadePolicy.expectedRootExportCount) {
    fail(`Phase 0 coreRootExportCount ${phase0.coreRootExportCount} does not match root policy`)
  }
  const ids = new Set<string>()
  const topics = new Set<string>()
  for (let index = 0; index < phase0.decisions.length; index++) {
    const decision = phase0.decisions[index]
    if (decision === undefined) fail(`missing Phase 0 decision at index ${index}`)
    const expectedId = `P0-${String(index + 1).padStart(2, '0')}`
    if (decision.id !== expectedId) fail(`expected Phase 0 id '${expectedId}', received '${decision.id}'`)
    if (ids.has(decision.id)) fail(`duplicate Phase 0 id '${decision.id}'`)
    if (topics.has(decision.topic)) fail(`duplicate Phase 0 topic '${decision.topic}'`)
    ids.add(decision.id)
    topics.add(decision.topic)
    if (decision.recommendation.trim().length === 0) fail(`Phase 0 '${decision.id}' has no recommendation`)
    if (decision.status === 'approved') {
      if (decision.approvedBy?.trim().length === 0) fail(`approved '${decision.id}' has no approvedBy`)
      if (decision.approvedAt === undefined || Number.isNaN(Date.parse(decision.approvedAt))) {
        fail(`approved '${decision.id}' has no valid approvedAt`)
      }
    } else if (decision.approvedBy !== undefined || decision.approvedAt !== undefined) {
      fail(`pending '${decision.id}' must not carry approval attribution`)
    }
  }
  const pending = phase0.decisions.some(decision => decision.status !== 'approved')
  const expectedOverall = pending ? 'pending-owner-approval' : 'approved'
  if (phase0.overallStatus !== expectedOverall) {
    fail(`Phase 0 overallStatus must be '${expectedOverall}'`)
  }
  const proposal = phase0.diagnosticsProposal
  for (const [name, value] of Object.entries(proposal)) {
    if (!Number.isSafeInteger(value) || value < 1) fail(`diagnosticsProposal.${name} must be positive`)
  }
  if (proposal.existingPerEventHardMaxBytes > proposal.maxBytes) {
    fail('diagnostics retained-byte proposal must fit at least one maximum-size event')
  }
  const coreDeclaration = readFileSync(join(contractRoot, 'packages/core/index.d.ts'), 'utf8')
  for (const field of [
    'diagnosticMaxEvents',
    'diagnosticMaxBytes',
    'retainedEvents',
    'retainedBytes',
    'evictedEvents',
    'evictedBytes',
  ]) {
    if (!coreDeclaration.includes(field)) fail(`core contract does not expose '${field}' from P0-09`)
  }
  const approvalMarkdown = readFileSync(
    join(workspace, 'docs/core-capability-phase0-approval.md'),
    'utf8',
  )
  const documentedIds = new Set(approvalMarkdown.match(/\bP0-\d{2}\b/g) ?? [])
  for (const id of ids) {
    if (!documentedIds.has(id)) fail(`approval Markdown does not document '${id}'`)
  }
  for (const id of documentedIds) {
    if (!ids.has(id)) fail(`approval Markdown names unknown decision '${id}'`)
  }
}
// @ts-nocheck
