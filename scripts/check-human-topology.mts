#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

interface Journey {
  readonly id: string
  readonly sourceRoots: readonly string[]
  readonly excludeRoots?: readonly string[]
  readonly currentDirectPackages: readonly string[]
  readonly targetDirectPackages: readonly string[]
  readonly liveCompanionPackages: readonly string[]
  readonly researchEvidence?: {
    readonly kind: string
    readonly oracle: string
    readonly verifiedClaims: readonly string[]
    readonly unverifiedClaims: readonly string[]
    readonly liveAcceptance: string
  }
  readonly status: 'migration-pending' | 'target-achieved'
}

interface TopologyManifest {
  readonly schemaVersion: 1
  readonly journeys: readonly Journey[]
  readonly targetForbiddenPackages: readonly string[]
}

const workspace = process.cwd()
const manifest = JSON.parse(readFileSync(
  resolve(workspace, 'test-human/package-topology.json'),
  'utf8',
)) as TopologyManifest
const findings: string[] = []
let pending = 0

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.journeys)) {
  findings.push('unsupported human package-topology manifest')
}

for (const journey of manifest.journeys) {
  if (journey.id === 'edge-chat') {
    // Freeze the current evidence scope independently of package migration.
    // Updating this classification requires new reviewed evidence, not an
    // offline provider replay or a successful target import graph.
    const expectedEvidence = {
      kind: 'scripted-offline',
      oracle: 'fixture-url-topic-matching',
      verifiedClaims: ['sdk-tool-loop', 'ui-progress-projection'],
      unverifiedClaims: ['agent-autonomy', 'internet-page-reading', 'semantic-sufficiency', 'contradiction-resolution'],
      liveAcceptance: 'manual-pending',
    }
    if (JSON.stringify(journey.researchEvidence) !== JSON.stringify(expectedEvidence)) {
      findings.push('edge-chat research evidence classification changed; review new evidence before claiming agent autonomy or research quality')
    }
  }
  if (journey.id === 'edge-chat-live') {
    const expectedEvidence = {
      kind: 'authenticated-live',
      oracle: 'host-owned-read-receipts-and-independent-review',
      verifiedClaims: ['agent-autonomy', 'internet-page-reading', 'read-provenance',
        'coverage-floors', 'contradiction-resolution', 'independent-review',
        'model-fallback-recovery'],
      unverifiedClaims: ['direct-workerd-codex-upstream-transport',
        'cross-provider-semantic-equivalence'],
      liveAcceptance: 'reviewed-pass-via-bounded-test-relay',
    }
    if (JSON.stringify(journey.researchEvidence) !== JSON.stringify(expectedEvidence)) {
      findings.push('edge-chat-live research classification does not match reviewed acceptance evidence')
    }
  }
  const actual = scopedImports(journey.sourceRoots, journey.excludeRoots ?? []).sort()
  const current = [...journey.currentDirectPackages].sort()
  const target = [...journey.targetDirectPackages].sort()
  if (JSON.stringify(actual) !== JSON.stringify(current)) {
    findings.push(`${journey.id} current imports ${JSON.stringify(actual)} do not match recorded ${JSON.stringify(current)}`)
  }
  if (!target.includes('@ai-agent-sdk/core')) findings.push(`${journey.id} target does not install core`)
  for (const forbidden of manifest.targetForbiddenPackages) {
    if (target.includes(forbidden)) findings.push(`${journey.id} target retains forbidden facade/layer ${forbidden}`)
  }
  if (journey.status === 'target-achieved') {
    if (JSON.stringify(actual) !== JSON.stringify(target)) {
      findings.push(`${journey.id} claims target-achieved but current imports differ from target`)
    }
  } else {
    pending++
  }
  if (!Array.isArray(journey.liveCompanionPackages) || journey.liveCompanionPackages.length === 0) {
    findings.push(`${journey.id} has no authenticated/live companion package selection`)
  }
}

if (findings.length > 0) {
  console.error(`Human package-topology audit failed with ${findings.length} finding(s):`)
  for (const finding of findings) console.error(`- ${finding}`)
  process.exitCode = 1
} else {
  console.log(`Human package-topology audit passed: ${manifest.journeys.length} graph(s) accounted for, ${pending} target migration(s) pending.`)
  console.log('Offline Edge evidence remains scripted SDK/UI-only. Authenticated live Edge research passed via the bounded test relay with independent semantic review; direct workerd-to-Codex transport remains unverified.')
}

function scopedImports(roots: readonly string[], excludes: readonly string[]): string[] {
  const packages = new Set<string>()
  const excluded = excludes.map(root => resolve(workspace, root))
  for (const root of roots) {
    for (const path of codeFiles(resolve(workspace, root))) {
      if (excluded.some(candidate => path === candidate || path.startsWith(`${candidate}/`))) continue
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/(?:from\s+|import\s*\()['"](@ai-agent-sdk\/[^/'"]+)(?:\/[^'"]*)?['"]/gu)) {
        if (match[1] !== undefined) packages.add(match[1])
      }
    }
  }
  return [...packages]
}

function codeFiles(directory: string): string[] {
  const output: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) output.push(...codeFiles(path))
    else if (entry.isFile() && path.endsWith('.ts')) output.push(path)
  }
  return output
}
