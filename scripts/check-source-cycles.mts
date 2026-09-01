#!/usr/bin/env node
import { relative, resolve } from 'node:path'
import { analyzeSourceOwnershipGraph } from './source-graph.mts'

const workspaceRoot = resolve(process.cwd())
const targets = process.argv.slice(2)
if (targets.length === 0) throw new Error('usage: node scripts/check-source-cycles.mts <source-root> [...]')

let failed = false
for (const target of targets) {
  const sourceRoot = resolve(workspaceRoot, target)
  const result = analyzeSourceOwnershipGraph(sourceRoot)
  const display = relative(workspaceRoot, sourceRoot)
  if (result.cycles.length > 0) {
    failed = true
    console.error(`${display}: ${result.cycles.length} ownership cycle(s):`)
    for (const cycle of result.cycles) console.error(`- ${cycle}`)
  } else {
    console.log(`${display}: acyclic ownership graph (${result.groups} groups, ${result.edges} edges).`)
  }
}
if (failed) process.exitCode = 1
