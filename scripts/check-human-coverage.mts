#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const manifest = JSON.parse(readFileSync(resolve(root, 'test-human/coverage.json'), 'utf8')) as {
  schemaVersion: number
  commands: Array<{ script: string; journey: string; runtime: string; network: string; artifact: string; readme: string }>
}
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>
}
const findings: string[] = []
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.commands)) findings.push('unsupported coverage manifest')
const humanScripts = Object.keys(pkg.scripts ?? {}).filter(name => name === 'human' || name.startsWith('human:')).sort()
const declared = manifest.commands.map(item => item.script).sort()
const duplicates = declared.filter((value, index) => declared.indexOf(value) !== index)
for (const duplicate of new Set(duplicates)) findings.push(`duplicate manifest command '${duplicate}'`)
for (const script of humanScripts) {
  if (!declared.includes(script)) findings.push(`human script '${script}' has no coverage/artifact declaration`)
}
for (const item of manifest.commands) {
  if (!humanScripts.includes(item.script)) findings.push(`manifest command '${item.script}' does not exist in package.json`)
  if ([item.journey, item.runtime, item.network, item.artifact].some(value => value.trim().length === 0)) {
    findings.push(`manifest command '${item.script}' has an empty coverage field`)
  }
  if (!existsSync(resolve(root, item.readme))) findings.push(`manifest command '${item.script}' has no README at ${item.readme}`)
}
for (const path of codeFiles(resolve(root, 'test-human'))) {
  const source = readFileSync(path, 'utf8')
  if (/import\.meta\.dirname|fileURLToPath\(import\.meta\.url\)/u.test(source)) {
    findings.push(`${path.slice(root.length + 1)} derives data paths from module location; bundled CLIs must use the workspace root`)
  }
}
if (findings.length > 0) {
  console.error(`Human coverage check failed with ${findings.length} finding(s):`)
  for (const finding of findings) console.error(`- ${finding}`)
  process.exitCode = 1
} else {
  console.log(`Human coverage check passed: ${humanScripts.length} command(s), zero missing artifact declarations.`)
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
