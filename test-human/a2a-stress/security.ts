import { realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import {
  createAgentCodeToolRegistry,
  type AgentCodeCommandRequest,
  type AgentCodeResolvedCommand,
} from '../agentcode/tools.ts'

export type A2AStressActor = 'coordinator' | 'delivery' | 'analytics' | 'collaboration'

const OWNED_PATHS: Readonly<Record<A2AStressActor, readonly string[]>> = Object.freeze({
  coordinator: Object.freeze(['src/app.js', 'src/styles.css', 'docs/mvp-report.md']),
  delivery: Object.freeze(['src/features/delivery.js', 'tests/delivery.test.mjs', 'docs/delivery.md']),
  analytics: Object.freeze(['src/features/analytics.js', 'tests/analytics.test.mjs', 'docs/analytics.md']),
  collaboration: Object.freeze([
    'src/features/collaboration.js',
    'tests/collaboration.test.mjs',
    'docs/collaboration.md',
  ]),
})

/** Least-privilege workspace tools for one stress-test agent identity. */
export function createA2AStressTools(workspace: string, actor: A2AStressActor) {
  const owned = new Set(OWNED_PATHS[actor])
  return createAgentCodeToolRegistry(workspace, {
    maxWriteBytes: 512 * 1024,
    canWrite: relativePath => owned.has(relativePath),
    resolveCommand: request => resolveA2AStressCommand(actor, request),
  })
}

/**
 * Translate the npm-shaped model tool into a fixed Node permission-model call.
 * No package scripts, network, subprocess, worker, addon, or arbitrary entrypoint
 * selected by the model is executed.
 */
export function resolveA2AStressCommand(
  actor: A2AStressActor,
  request: AgentCodeCommandRequest,
): AgentCodeResolvedCommand {
  const root = canonicalPath(request.workspaceRoot)
  if (canonicalPath(request.cwd) !== root) {
    throw new Error('A2A stress commands must run at workspace root')
  }
  const args = [...request.args]
  const base = [
    '--permission',
    `--allow-fs-read=${root}`,
    '--max-old-space-size=256',
  ]
  const env = minimalChildEnvironment()
  if (actor === 'coordinator' && equalArgs(args, ['test'])) {
    return { executable: process.execPath, args: [...base, 'scripts/run-tests.mjs'], env }
  }
  if (actor === 'coordinator' && equalArgs(args, ['run', 'build'])) {
    return {
      executable: process.execPath,
      args: [...base, `--allow-fs-write=${resolve(root, 'dist')}`, 'scripts/build.mjs'],
      env,
    }
  }
  if (actor !== 'coordinator'
    && equalArgs(args, ['test', '--', `tests/${actor}.test.mjs`])) {
    return {
      executable: process.execPath,
      args: [...base, 'scripts/run-tests.mjs', `tests/${actor}.test.mjs`],
      env,
    }
  }
  throw new Error(`A2A stress command is not allowlisted for ${actor}: npm ${args.join(' ')}`)
}

function canonicalPath(input: string): string {
  let existing = resolve(input)
  const missing: string[] = []
  while (true) {
    try {
      return resolve(realpathSync.native(existing), ...missing)
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
      if (code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      missing.unshift(basename(existing))
      existing = parent
    }
  }
}

export function a2aStressOwnedPaths(actor: A2AStressActor): readonly string[] {
  return OWNED_PATHS[actor]
}

function equalArgs(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function minimalChildEnvironment(): Readonly<Record<string, string>> {
  const env: Record<string, string> = { CI: '1', NO_COLOR: '1', TZ: 'UTC' }
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return Object.freeze(env)
}
