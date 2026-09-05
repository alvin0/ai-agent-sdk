#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync, Visitor } from 'rolldown/utils'
import { portableRelative, walkFiles } from './common/files.mts'

interface Topology { readonly packages: Readonly<Record<string, unknown>> }

const workspace = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const topology = JSON.parse(readFileSync(
  join(workspace, 'design-contracts/core-capability-v1/topology.json'), 'utf8',
)) as Topology
const findings: string[] = []
let sourceFiles = 0
let emittedFiles = 0

for (const name of Object.keys(topology.packages).sort()) {
  const packageRoot = join(workspace, 'packages', name.slice('@ai-agent-sdk/'.length))
  inspectTree(packageRoot, 'src', true)
  inspectTree(packageRoot, 'dist', false)
}

if (findings.length > 0) {
  throw new Error(`Runtime metadata isolation failed:\n${findings.map(row => `- ${row}`).join('\n')}`)
}
process.stdout.write(
  `Runtime metadata isolation passed: ${sourceFiles} source files, ${emittedFiles} emitted files, zero runtime manifest/metadata auto-loads.\n`,
)

function inspectTree(packageRoot: string, directory: string, source: boolean): void {
  const root = join(packageRoot, directory)
  if (!existsSync(root)) {
    findings.push(`${portableRelative(workspace, root)} is missing`)
    return
  }
  const extensions = source ? /\.(?:[cm]?ts|[cm]?js)$/u : /\.(?:[cm]?js)$/u
  for (const path of walkFiles(root, candidate => extensions.test(candidate))) {
    if (source) sourceFiles++
    else emittedFiles++
    inspectModule(path)
  }
}

function inspectModule(path: string): void {
  const relative = portableRelative(workspace, path)
  const code = readFileSync(path, 'utf8')
  if (/\baiAgentSdk\b/u.test(code)) findings.push(`${relative} references aiAgentSdk metadata`)
  const parsed = parseSync(relative, code)
  if (parsed.errors.length > 0) {
    findings.push(`${relative} could not be parsed: ${parsed.errors[0]?.message}`)
    return
  }
  const inspectSpecifier = (value: string, kind: string): void => {
    if (/(?:^|\/)package\.json(?:$|[?#])/u.test(value)) {
      findings.push(`${relative} ${kind} reads package metadata: ${value}`)
    }
  }
  new Visitor({
    ImportDeclaration(node) { inspectSpecifier(node.source.value, 'imports') },
    ExportAllDeclaration(node) { inspectSpecifier(node.source.value, 'exports') },
    ExportNamedDeclaration(node) {
      if (node.source !== null) inspectSpecifier(node.source.value, 'exports')
    },
    ImportExpression(node) {
      if (node.source.type !== 'Literal' || typeof node.source.value !== 'string') {
        findings.push(`${relative} contains a non-literal runtime import`)
      } else inspectSpecifier(node.source.value, 'dynamically imports')
    },
    CallExpression(node) {
      const first = node.arguments[0]
      if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return
      if (first?.type !== 'Literal' || typeof first.value !== 'string') {
        findings.push(`${relative} contains a non-literal runtime require`)
      } else inspectSpecifier(first.value, 'requires')
    },
  }).visit(parsed.program)
}
