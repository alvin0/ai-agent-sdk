#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { discoverWorkspacePackages } from './package-policy.mts'

const workspaceRoot = resolve(process.cwd())
const emittedRoots = discoverWorkspacePackages(workspaceRoot)
  .filter((pkg) => pkg.root !== workspaceRoot && existsSync(join(pkg.root, 'dist')))
  .map((pkg) => relative(workspaceRoot, join(pkg.root, 'dist')))

if (emittedRoots.length === 0) {
  console.log('dependency-cruiser emitted-JS check skipped: no extracted package build exists; custom graph gate covers source and type-only edges.')
} else {
  const executable = join(workspaceRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'depcruise.cmd' : 'depcruise')
  if (!existsSync(executable)) throw new Error(`dependency-cruiser executable is missing: ${executable}`)
  const result = spawnSync(executable, ['--config', '.dependency-cruiser.cjs', '--output-type', 'err-long', ...emittedRoots], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (output.includes('missing-typescript-transpiler')) throw new Error('dependency-cruiser silently skipped TypeScript; emitted-JS mode must not request a TypeScript transpiler')
  if (result.status !== 0) process.exitCode = result.status ?? 1
}
