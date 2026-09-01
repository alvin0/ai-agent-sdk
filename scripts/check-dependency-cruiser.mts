#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { discoverWorkspacePackages } from './package-policy.mts'

const workspaceRoot = resolve(process.cwd())
const sourceRoots = discoverWorkspacePackages(workspaceRoot)
  .filter((pkg) => pkg.root !== workspaceRoot && pkg.sourceRoot !== undefined)
  .map((pkg) => relative(workspaceRoot, pkg.sourceRoot as string))

if (sourceRoots.length === 0) {
  console.log('dependency-cruiser check skipped: package extraction has not started; custom graph gate covers the baseline.')
} else {
  const executable = join(workspaceRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'depcruise.cmd' : 'depcruise')
  if (!existsSync(executable)) throw new Error(`dependency-cruiser executable is missing: ${executable}`)
  const result = spawnSync(executable, ['--config', '.dependency-cruiser.cjs', '--output-type', 'err-long', ...sourceRoots], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
}
