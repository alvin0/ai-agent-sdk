import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseA2AStressArgs } from '../../test-human/a2a-stress/config.ts'
import {
  prepareA2AStressFixture,
  verifyA2AStressFixtureIntegrity,
} from '../../test-human/a2a-stress/fixture.ts'
import {
  DEFINED_STRESS_PROMPT,
  EXPECTED_SIGNALS,
  EXPECTED_WORKERS,
  MANAGED_STRESS_PROMPT,
  specialistInstructions,
} from '../../test-human/a2a-stress/prompts.ts'
import {
  createA2AStressTools,
  resolveA2AStressCommand,
} from '../../test-human/a2a-stress/security.ts'
import type { ToolRunContext } from '../../src/agent/tool/definition.ts'
import type { ToolCallId } from '../../src/core/primitives/brand.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('A2A human stress harness', () => {
  it('parses bounded live defaults and requires models for non-Codex providers', () => {
    expect(parseA2AStressArgs('managed', [], {})).toMatchObject({
      mode: 'managed', provider: 'codex', model: 'gpt-5.6-luna',
      maxTurns: 18, maxToolCalls: 64, maxInputTokens: 3500, retainTokens: 700,
      logs: false,
    })
    expect(() => parseA2AStressArgs('defined', ['--provider', 'anthropic'], {}))
      .toThrow(/--model or AI_AGENT_MODEL/)
    expect(() => parseA2AStressArgs('managed', [
      '--max-input-tokens', '500', '--retain-tokens', '500',
    ], {})).toThrow(/must be lower/)
  })

  it('keeps both prompts deep, explicit, and mechanically verifiable', () => {
    expect(MANAGED_STRESS_PROMPT).toContain('exactly three workers')
    expect(MANAGED_STRESS_PROMPT).toContain('same model step')
    expect(MANAGED_STRESS_PROMPT).toMatch(/automatic\s+token compaction/)
    expect(MANAGED_STRESS_PROMPT).toContain('npm run build')
    expect(MANAGED_STRESS_PROMPT).toContain('data-app="launchpad-ops"')
    expect(DEFINED_STRESS_PROMPT).toContain('wait_agents')
    expect(DEFINED_STRESS_PROMPT).toContain('send_message back to')
    expect(DEFINED_STRESS_PROMPT).toContain('built dist/ path')
    for (const signal of EXPECTED_SIGNALS) {
      expect(MANAGED_STRESS_PROMPT).toContain(signal)
      expect(DEFINED_STRESS_PROMPT).toContain(signal)
    }
    for (const worker of EXPECTED_WORKERS) {
      const instructions = specialistInstructions(worker)
      for (const tool of ['list_files', 'grep_files', 'read_file', 'write_file', 'run_command']) {
        expect(instructions).toContain(tool)
      }
      expect(instructions).toContain('send_message')
    }
  })

  it('generates a runnable website skeleton and enough pressure to force compaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'a2a-human-stress-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const results = join(root, 'results')
    await prepareA2AStressFixture({ workspace, results })

    const index = await readFile(join(workspace, 'index.html'), 'utf8')
    const store = await readFile(join(workspace, 'src', 'core', 'store.js'), 'utf8')
    const build = await readFile(join(workspace, 'scripts', 'build.mjs'), 'utf8')
    expect(index).toContain('LaunchPad Ops')
    expect(store).toContain('localStorage')
    expect(build).toContain("await cp('src'")
    execFileSync(process.execPath, ['--check', join(workspace, 'scripts', 'build.mjs')])
    execFileSync(process.execPath, ['--check', join(workspace, 'scripts', 'serve.mjs')])
    const isolatedGate = resolveA2AStressCommand('coordinator', {
      command: 'npm', args: ['test'], cwd: workspace, workspaceRoot: workspace, timeoutMs: 120_000,
    })
    execFileSync(isolatedGate.executable, [...isolatedGate.args], {
      cwd: workspace, env: isolatedGate.env,
    })
    const contractsModule = await import(pathToFileURL(
      join(workspace, 'src', 'core', 'contracts.js'),
    ).href)
    const storeModule = await import(pathToFileURL(
      join(workspace, 'src', 'core', 'store.js'),
    ).href)
    expect(contractsModule.escapeHtml('<launch>')).toBe('&lt;launch&gt;')
    expect(storeModule.createLaunchStore(undefined).getState().tasks).toHaveLength(5)
    await expect(verifyA2AStressFixtureIntegrity({ workspace, results }))
      .resolves.toMatchObject({ passed: true })
    await expect(stat(join(workspace, 'src', 'features', 'delivery.js'))).rejects.toThrow()
    for (const worker of EXPECTED_WORKERS) {
      const info = await stat(join(workspace, 'pressure', `${worker}.txt`))
      expect(info.size).toBeGreaterThan(20_000)
    }
  })

  it('enforces agent file ownership and immutable host acceptance inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'a2a-human-security-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const results = join(root, 'results')
    await prepareA2AStressFixture({ workspace, results })
    const tools = createA2AStressTools(workspace, 'delivery')

    await expect(callStressTool(tools, 'write_file', {
      path: 'src/app.js', content: 'unauthorized',
    })).rejects.toThrow(/not permitted/)
    await callStressTool(tools, 'write_file', {
      path: 'src/features/delivery.js', content: 'export const safe = true',
    })
    await expect(callStressTool(tools, 'run_command', {
      command: 'npm', args: ['run', 'build'],
    })).rejects.toThrow(/not allowlisted/)

    await writeFile(join(workspace, 'package.json'), '{}', 'utf8')
    await expect(verifyA2AStressFixtureIntegrity({ workspace, results }))
      .resolves.toMatchObject({ passed: false, detail: expect.stringContaining('package.json') })
  })

  it('maps model-requested gates to the Node permission model', () => {
    const root = resolve(tmpdir(), 'launchpad-permission-contract')
    const test = resolveA2AStressCommand('coordinator', {
      command: 'npm', args: ['test'], cwd: root, workspaceRoot: root, timeoutMs: 120_000,
    })
    const build = resolveA2AStressCommand('coordinator', {
      command: 'npm', args: ['run', 'build'], cwd: root, workspaceRoot: root, timeoutMs: 120_000,
    })
    expect(test.executable).toBe(process.execPath)
    expect(test.args).toContain('--permission')
    expect(test.args.some(arg => arg.startsWith('--allow-fs-read='))).toBe(true)
    expect(test.args).not.toContain('--allow-child-process')
    expect(test.args).not.toContain('--allow-net')
    expect(test.env).not.toHaveProperty('OPENAI_API_KEY')
    expect(test.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(test.env).not.toHaveProperty('CODEX_HOME')
    expect(build.args.some(arg => arg.startsWith('--allow-fs-write='))).toBe(true)
  })
})

async function callStressTool(
  registry: ReturnType<typeof createA2AStressTools>,
  name: string,
  raw: unknown,
): Promise<unknown> {
  const tool = registry.get(name)
  if (tool === undefined) throw new Error(`missing stress tool ${name}`)
  return tool.execute(tool.parse?.(raw) ?? raw, stressToolContext(name))
}

function stressToolContext(toolName: string): ToolRunContext {
  return {
    callId: 'stress-test-call' as ToolCallId,
    toolName,
    signal: new AbortController().signal,
    turn: 1,
    step: 1,
    concludeTurn() {},
    addContext() {},
  }
}
