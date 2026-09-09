#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { importsInFile, listCodeFiles } from './package-policy.mts'
import { analyzeSourceOwnershipGraph } from './source-graph.mts'

const args = process.argv.slice(2)
const rootIndex = args.indexOf('--root')
const workspaceRoot = resolve(rootIndex === -1 ? process.cwd() : required(args[rootIndex + 1], '--root'))
const agentRoot = join(workspaceRoot, 'packages', 'core', 'src', 'agent')
if (!existsSync(join(agentRoot, 'define')) || !existsSync(join(agentRoot, 'team'))) {
  throw new Error('canonical core agent source root with define/ and team/ was not found')
}

const findings: string[] = []
const defineRoot = join(agentRoot, 'define')
for (const file of listCodeFiles(defineRoot)) {
  for (const imported of importsInFile(file)) {
    if (/(?:^|\/)team\/(?:team|composed|managed|index|types)(?:\.[cm]?tsx?)?$/.test(imported.specifier)) {
      findings.push(`${relative(agentRoot, file)}:${imported.line}: define/session imports team implementation ${JSON.stringify(imported.specifier)}`)
    }
  }
}

for (const name of ['contracts.ts', 'team.ts']) {
  const file = join(agentRoot, 'team', name)
  if (!existsSync(file)) {
    findings.push(`team/${name}: required inward team module is missing`)
    continue
  }
  for (const imported of importsInFile(file)) {
    if (/(?:^|\/)define\//.test(imported.specifier)) {
      findings.push(`team/${name}:${imported.line}: core team control plane imports concrete define/session code`)
    }
  }
}

const graph = analyzeSourceOwnershipGraph(agentRoot)
for (const cycle of graph.cycles) {
  const groups = new Set(cycle.split(' -> '))
  if (groups.has('define') && groups.has('team')) findings.push(`agent ownership cycle remains: ${cycle}`)
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`- ${finding}`)
  process.exitCode = 1
} else {
  console.log(`Agent team boundary passed: define/session has no concrete team edge and no define↔team ownership cycle (${graph.groups} groups, ${graph.edges} edges).`)
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${label} requires a path`)
  return value
}
