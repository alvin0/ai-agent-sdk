import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseNodeCodexArgs } from './config.ts'
import { runNodeCodexAcceptance } from './runtime.ts'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('human full Node SDK Codex harness', () => {
  it('validates bounded pressure options', () => {
    const config = parseNodeCodexArgs(['--', '--run-id', 'fixture', '--repeat', '3', '--parallel', '2', '--dry-run'])
    expect(config).toMatchObject({ runId: 'fixture', repeat: 3, parallel: 2, dryRun: true })
    expect(() => parseNodeCodexArgs(['--parallel', '17'])).toThrow(/1 to 16/u)
  })

  it('runs the full facade with skills, files, MCP, usage, journal, and resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-codex-human-'))
    temporary.push(root)
    const result = await runNodeCodexAcceptance({
      runId: 'vitest',
      resultsRoot: join(root, 'results'),
      workspaceRoot: join(root, 'workspace'),
      mcpServerPath: resolve('dist-cli/node-codex-mcp-server.mjs'),
    })
    expect(result.status).toBe('passed')
    expect(result.text).toContain('437')
    expect(result.invariants.every(invariant => invariant.passed)).toBe(true)
    expect(result.metrics.toolCalls).toBeGreaterThanOrEqual(7)
  }, 30_000)
})
