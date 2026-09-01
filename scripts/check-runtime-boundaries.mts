#!/usr/bin/env node
import { builtinModules } from 'node:module'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { PACKAGE_RULES, discoverWorkspacePackages, importsInFile, listCodeFiles, maskNonCode } from './package-policy.mts'

const args = process.argv.slice(2)
const rootIndex = args.indexOf('--root')
const workspaceRoot = resolve(rootIndex === -1 ? process.cwd() : (args[rootIndex + 1] ?? ''))
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])
const forbiddenGlobals = new Set(['Buffer', 'process', '__dirname', '__filename'])
const errors: string[] = []

function checkFile(path: string): void {
  const display = relative(workspaceRoot, path)
  for (const imported of importsInFile(path)) {
    if (builtins.has(imported.specifier) || imported.specifier.startsWith('node:')) {
      errors.push(`${display}:${imported.line}: Node builtin import ${imported.specifier}`)
    }
  }

  const sourceText = readFileSync(path, 'utf8')
  const code = maskNonCode(sourceText)
  const identifierPattern = /\b(Buffer|process|__dirname|__filename)\b/g
  for (const match of code.matchAll(identifierPattern)) {
    if (match.index === undefined || match[1] === undefined || !forbiddenGlobals.has(match[1])) continue
    const line = code.slice(0, match.index).split('\n').length
    errors.push(`${display}:${line}: forbidden Node global ${match[1]}`)
  }
}

let checkedPackages = 0
let checkedFiles = 0
for (const pkg of discoverWorkspacePackages(workspaceRoot)) {
  const runtime = PACKAGE_RULES[pkg.manifest.name]?.runtime ?? pkg.manifest.aiAgentSdk?.runtime
  if (runtime !== 'universal' && runtime !== 'browser') continue
  checkedPackages += 1
  const roots = [pkg.sourceRoot, resolve(pkg.root, 'dist')].filter((value): value is string => value !== undefined)
  const seen = new Set<string>()
  for (const root of roots) {
    for (const file of listCodeFiles(root)) {
      if (seen.has(file)) continue
      seen.add(file)
      checkedFiles += 1
      checkFile(file)
    }
  }
}

if (errors.length > 0) {
  console.error(`Runtime-boundary check failed with ${errors.length} finding(s):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`Runtime-boundary check passed: ${checkedPackages} Universal/Browser package(s), ${checkedFiles} source/emitted file(s), zero findings.`)
}
