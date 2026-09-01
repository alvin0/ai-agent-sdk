import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runTurn } from '../../src/agent/loop/run-turn.ts'
import type { ToolRunContext } from '../../src/agent/tool/definition.ts'
import { ModelAdapter } from '@ai-agent-sdk/core'
import { createTextMessage } from '@ai-agent-sdk/core'
import type { ToolCallId } from '@ai-agent-sdk/core'
import { ModelRegistry } from '@ai-agent-sdk/core'
import type { StreamChunk } from '@ai-agent-sdk/core'
import {
  DEFAULT_AGENTCODE_PROMPT,
  parseAgentCodeCliArgs,
  resolveAgentCodeModel,
} from '../../test-human/agentcode/config.ts'
import { createAgentCodeAgent } from '../../test-human/agentcode/agent.ts'
import { createAgentCodeToolRegistry } from '../../test-human/agentcode/tools.ts'
import {
  createWindowsCommandProcessCleanup,
  forceTerminateWindowsProcessTree,
  selectAttributedWindowsProcesses,
} from '../../test-human/agentcode/process-cleanup.ts'
import { resolveAgentCodePath } from '../../test-human/agentcode/workspace.ts'
import { AgentCodeSteeringQueue } from '../../test-human/agentcode/steering.ts'
import { TerminalLineQueue } from '../../test-human/agentcode/line-queue.ts'
import { summarizeToolArguments, summarizeToolResult } from '../../test-human/terminal.ts'
import { History } from '../../src/agent/history/history.ts'
import { SkillCatalog } from '../../src/agent/skill/index.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })))
})

describe('agentcode CLI configuration', () => {
  it('defaults to the long Todo task, deep mode, Luna medium, and forced compaction budget', () => {
    const cwd = resolve('fixture-root')
    const config = parseAgentCodeCliArgs([], cwd)
    expect(config).toMatchObject({
      provider: 'codex', mode: 'deep', effort: 'medium',
      maxTurns: 32, prompt: DEFAULT_AGENTCODE_PROMPT, showReasoning: true,
      maxInputTokens: 12_000, retainTokens: 3_000,
      maxToolCalls: 64,
      once: false,
      skillRoots: [],
      workdir: resolve(cwd, 'test-human/workspaces/agentcode'),
    })
    expect(resolveAgentCodeModel(config, {})).toBe('gpt-5.6-luna')
  })

  it('accepts workspace and compaction overrides and rejects invalid retention', () => {
    const config = parseAgentCodeCliArgs([
      '--workdir', 'scratch/todo', '--max-turns=40',
      '--max-input-tokens', '20000', '--retain-tokens=5000', '--max-tool-calls=96',
      '--no-show-reasoning',
      '--', 'build', 'a', 'different', 'app',
    ], resolve('fixture-root'))
    expect(config).toMatchObject({
      maxTurns: 40, maxInputTokens: 20_000, retainTokens: 5_000, maxToolCalls: 96,
      showReasoning: false, prompt: 'build a different app',
    })
    expect(() => parseAgentCodeCliArgs([
      '--max-input-tokens', '4000', '--retain-tokens', '4000',
    ])).toThrow(/lower than/)
  })

  it('supports an explicit one-shot mode for automation', () => {
    expect(parseAgentCodeCliArgs(['--once']).once).toBe(true)
  })

  it('accepts repeatable prepared skill roots alongside project discovery', () => {
    const cwd = resolve('fixture-root')
    const config = parseAgentCodeCliArgs([
      '--skills-root', 'fixtures/skills-sh',
      '--skills-root=fixtures/extra-skills',
      '--skills-root', 'fixtures/skills-sh',
    ], cwd)
    expect(config.skillRoots).toEqual([
      resolve(cwd, 'fixtures/skills-sh'),
      resolve(cwd, 'fixtures/extra-skills'),
    ])

    const agent = createAgentCodeAgent(config, 'gpt-5.6-luna')
    expect(agent.skills).toHaveLength(2)
    expect(agent.skills.map(source => source.id)).toEqual([
      'filesystem', 'skills-sh-filesystem',
    ])
  })

  it('discovers project and prepared skills through the same lazy catalog', async () => {
    const root = await temporaryDirectory()
    const workdir = join(root, 'workspace')
    const prepared = join(root, 'prepared-skills')
    await mkdir(join(workdir, '.git'), { recursive: true })
    await writeSkillFixture(join(workdir, '.agents', 'skills'), 'project-workflow')
    await writeSkillFixture(prepared, 'prepared-workflow')
    const config = parseAgentCodeCliArgs([
      '--workdir', 'workspace', '--skills-root', 'prepared-skills',
    ], root)
    const agent = createAgentCodeAgent(config, 'gpt-5.6-luna')
    const catalog = new SkillCatalog(agent.skills)

    const discovered = await catalog.discover({ cwd: config.workdir })

    expect(discovered).toHaveLength(2)
    expect(discovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'project-workflow', provider: 'filesystem' }),
      expect.objectContaining({ id: 'prepared-workflow', provider: 'skills-sh-filesystem' }),
    ]))
  })

  it('attaches lazy project skill discovery to the coding agent', () => {
    const config = parseAgentCodeCliArgs([], resolve('fixture-root'))
    const agent = createAgentCodeAgent(config, 'gpt-5.6-luna')

    expect(agent.skills).toHaveLength(1)
    expect(agent.skills[0]).toMatchObject({ kind: 'skill-provider', id: 'filesystem' })
  })
})

describe('agentcode live steering', () => {
  it('applies queued lines as chronological user messages at a safe step', async () => {
    const history = new History()
    const applied: string[] = []
    const steering = new AgentCodeSteeringQueue({
      onApplied: items => applied.push(...items.map(item => item.text)),
    })
    steering.enqueue('Use a blue theme.')
    steering.enqueue('Keep the existing store.')
    const decision = await steering.hooks(() => history).beforeStep?.({
      turn: 1, step: 2, messages: [], snapshot: history.snapshot(),
      signal: new AbortController().signal, async emit() {},
    })
    expect(decision).toEqual({ kind: 'proceed' })
    expect(applied).toEqual(['Use a blue theme.', 'Keep the existing store.'])
    expect(history.entries().map(entry => entry.event.kind)).toEqual(['user', 'user'])
    expect(history.entries().map(entry => entry.event.kind === 'user'
      ? entry.event.message.source
      : undefined)).toEqual([
      { kind: 'app', producer: 'agentcode-steering' },
      { kind: 'app', producer: 'agentcode-steering' },
    ])
    expect(steering.pendingCount()).toBe(0)
  })

  it.each([
    { label: 'completed at maxSteps', reason: { kind: 'completed' } as const },
    {
      label: 'budget exhaustion',
      reason: { kind: 'budget-exhausted', budget: 'steps', forcedFinalAnswer: true } as const,
    },
    {
      label: 'provider error',
      reason: { kind: 'error', failure: { code: 'PROVIDER_DOWN', message: 'offline' } } as const,
    },
    { label: 'abort', reason: { kind: 'aborted' } as const },
    { label: 'max tokens', reason: { kind: 'max-tokens' } as const },
  ])('keeps late steering pending after terminal $label', async ({ reason }) => {
    const history = new History()
    const applied: string[] = []
    const steering = new AgentCodeSteeringQueue({
      onApplied: items => applied.push(...items.map(item => item.text)),
    })
    steering.enqueue('Late correction.')

    await steering.hooks(() => history).onTurnEnd?.({
      outcome: {
        reason, text: '', steps: 1, toolCalls: 0, traceId: 'trace',
        usage: { inputTokens: 0, outputTokens: 0 },
        usageReport: {
          reported: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          coverage: { logicalCalls: 0, attempts: 0, complete: 0, partial: 0, estimated: 0, missing: 0, notApplicable: 0, possiblyBilledAttemptsWithoutUsage: 0 },
          authoritative: true,
        },
      },
      snapshot: history.snapshot(),
      canContinue: false,
    })

    expect(applied).toEqual([])
    expect(history.entries()).toEqual([])
    expect(steering.pendingCount()).toBe(1)
    expect(steering.takePendingInput()).toBe('Late correction.')
  })

  it('applies late steering at turn-end only when another model step can consume it', async () => {
    const history = new History()
    const boundaries: string[] = []
    const steering = new AgentCodeSteeringQueue({
      onApplied: (_items, boundary) => boundaries.push(boundary.kind),
    })
    steering.enqueue('Revise the final answer.')

    await steering.hooks(() => history).onTurnEnd?.({
      outcome: {
        reason: { kind: 'completed' }, text: 'stale', steps: 1, toolCalls: 0,
        traceId: 'trace', usage: { inputTokens: 0, outputTokens: 0 },
        usageReport: {
          reported: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          coverage: { logicalCalls: 0, attempts: 0, complete: 0, partial: 0, estimated: 0, missing: 0, notApplicable: 0, possiblyBilledAttemptsWithoutUsage: 0 },
          authoritative: true,
        },
      },
      snapshot: history.snapshot(),
      canContinue: true,
    })

    expect(boundaries).toEqual(['turn-end'])
    expect(steering.pendingCount()).toBe(0)
    expect(history.entries()[0]?.event).toMatchObject({
      kind: 'user',
      message: { role: 'user', source: { kind: 'app', producer: 'agentcode-steering' } },
    })
  })

  it('keeps invocation turn identity stable across in-turn steering', async () => {
    const adapter = new TextAdapter()
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const history = new History()
    const steering = new AgentCodeSteeringQueue()
    const turns: number[] = []
    history.append({ kind: 'user', message: createTextMessage('First request.') })
    steering.enqueue('Steer A.')
    steering.enqueue('Steer B.')

    for await (const event of runTurn({
      registry, config: { provider: 'test', model: 'm' }, history,
      hooks: steering.hooks(() => history),
    })) if (event.type === 'turn-start') turns.push(event.turn)

    history.append({ kind: 'user', message: createTextMessage('Second request.') })
    for await (const event of runTurn({
      registry, config: { provider: 'test', model: 'm' }, history,
    })) if (event.type === 'turn-start') turns.push(event.turn)

    expect(turns).toEqual([1, 2])
  })

  it('carries steering that missed the final boundary into the next turn', () => {
    const steering = new AgentCodeSteeringQueue()
    steering.enqueue('Now add tests.')
    steering.enqueue('Do not rewrite the UI.')
    expect(steering.takePendingInput()).toBe('Now add tests.\n\nDo not rewrite the UI.')
    expect(steering.takePendingInput()).toBeUndefined()
  })

  it('delivers terminal lines whether the consumer waits before or after input', async () => {
    const lines = new TerminalLineQueue()
    const waiting = lines.take()
    lines.push('first')
    expect(await waiting).toBe('first')
    lines.push('second')
    expect(await lines.take()).toBe('second')
    lines.close()
    expect(await lines.take()).toBeUndefined()
  })
})

describe('agentcode workspace tools', () => {
  it('confines paths and supports write, read, exact replacement, listing, and grep', async () => {
    const root = await temporaryDirectory()
    expect(() => resolveAgentCodePath(root, '../outside.txt')).toThrow(/escapes agentcode workspace/)
    const tools = createAgentCodeToolRegistry(root)

    await callTool(tools, 'write_file', {
      path: 'src/store.ts', content: 'export const title = "todo"\nexport const count = 1\n',
    })
    const read = resultObject(await callTool(tools, 'read_file', { path: 'src/store.ts' }))
    expect(read.text).toContain('1: export const title = "todo"')

    await callTool(tools, 'replace_in_file', {
      path: 'src/store.ts', oldText: 'count = 1', newText: 'count = 2',
    })
    expect(await readFile(join(root, 'src/store.ts'), 'utf8')).toContain('count = 2')

    const listed = resultObject(await callTool(tools, 'list_files', { path: '.' }))
    expect(listed.entries).toContain('src/store.ts')
    const grep = resultObject(await callTool(tools, 'grep_files', { pattern: 'count = 2' }))
    expect(grep.matches).toEqual(expect.arrayContaining([expect.stringContaining('store.ts')]))
  })

  it('rejects ambiguous replacements and arbitrary command executables', async () => {
    const root = await temporaryDirectory()
    const tools = createAgentCodeToolRegistry(root)
    await callTool(tools, 'write_file', { path: 'repeat.txt', content: 'same same' })
    await expect(callTool(tools, 'replace_in_file', {
      path: 'repeat.txt', oldText: 'same', newText: 'changed',
    })).rejects.toThrow(/occurs 2 times/)
    await expect(callTool(tools, 'run_command', {
      command: 'powershell', args: ['-Command', 'Get-ChildItem'],
    })).rejects.toThrow(/command must be npm/)
  })

  it('runs npm without a shell and returns structured evidence', async () => {
    const root = await temporaryDirectory()
    const tools = createAgentCodeToolRegistry(root)
    const result = resultObject(await callTool(tools, 'run_command', {
      command: 'npm', args: ['--version'], timeoutMs: 20_000,
    }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^\d+\./)
    expect(result.timedOut).toBe(false)
  })

  it('runs injected post-exit cleanup after a successful npm command', async () => {
    const root = await temporaryDirectory()
    const cleanupInputs: Array<{
      readonly rootPid: number
      readonly workspaceRoot: string
      readonly startedAtMs: number
    }> = []
    const tools = createAgentCodeToolRegistry(root, {
      commandProcessCleanup: {
        async cleanupAfterExit(input) {
          cleanupInputs.push(input)
          return { attempted: true, matchedProcesses: 2, terminatedProcessTrees: 1 }
        },
      },
    })

    const result = resultObject(await callTool(tools, 'run_command', {
      command: 'npm', args: ['--version'], timeoutMs: 20_000,
    }))

    expect(result.exitCode).toBe(0)
    expect(result.processCleanup).toEqual({
      attempted: true, matchedProcesses: 2, terminatedProcessTrees: 1,
    })
    expect(cleanupInputs).toHaveLength(1)
    expect(cleanupInputs[0]).toMatchObject({ workspaceRoot: resolve(root) })
    expect(cleanupInputs[0]?.rootPid).toBeGreaterThan(0)
    expect(cleanupInputs[0]?.startedAtMs).toBeLessThanOrEqual(Date.now())
  })

  it('enables live lineage tracking only for long-lived dev or e2e npm invocations', async () => {
    const root = await temporaryDirectory()
    await writeNpmScript(root, 'test:e2e', 'node -e "process.exit(0)"')
    const trackingFlags: Array<boolean | undefined> = []
    const tools = createAgentCodeToolRegistry(root, {
      commandProcessCleanup: {
        async beginInvocation(input) {
          trackingFlags.push(input.trackDetachedDescendants)
          return {
            attachRoot() {},
            async cleanupAfterExit() {
              return { attempted: false, matchedProcesses: 0, terminatedProcessTrees: 0 }
            },
            async cancel() {},
          }
        },
        async cleanupAfterExit() { throw new Error('legacy cleanup should not run') },
      },
    })

    await callTool(tools, 'run_command', {
      command: 'npm', args: ['--version'], timeoutMs: 20_000,
    })
    await callTool(tools, 'run_command', {
      command: 'npm', args: ['run', 'test:e2e'], timeoutMs: 20_000,
    })

    expect(trackingFlags).toEqual([false, true])
  })

  it('aborts post-exit cleanup when its independent deadline expires', async () => {
    const root = await temporaryDirectory()
    await writeNpmScript(root, 'e2e', 'node -e "process.exit(0)"')
    let cleanupWasAborted = false
    const tools = createAgentCodeToolRegistry(root, {
      commandProcessCleanup: {
        async beginInvocation() {
          return {
            attachRoot() {},
            cleanupAfterExit(signal) {
              return new Promise(resolveCleanup => {
                const abort = (): void => {
                  cleanupWasAborted = true
                  resolveCleanup({ attempted: true, matchedProcesses: 0, terminatedProcessTrees: 0 })
                }
                signal?.addEventListener('abort', abort, { once: true })
                if (signal?.aborted === true) abort()
              })
            },
            async cancel() {},
          }
        },
        async cleanupAfterExit() { throw new Error('legacy cleanup should not run') },
      },
    })

    const result = resultObject(await callTool(tools, 'run_command', {
      command: 'npm', args: ['run', 'e2e'], timeoutMs: 20_000,
    }))

    expect(cleanupWasAborted).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.processCleanup).toMatchObject({
      attempted: true, matchedProcesses: 0, terminatedProcessTrees: 0,
    })
    expect(resultObject(result.processCleanup).warning).toContain('exceeded 5000ms')
  }, 10_000)

  it('keeps cleanup outside the command timeout lifecycle after process close', async () => {
    const root = await temporaryDirectory()
    const tools = createAgentCodeToolRegistry(root, {
      commandProcessCleanup: {
        async cleanupAfterExit() {
          await delay(4_500)
          return { attempted: true, matchedProcesses: 0, terminatedProcessTrees: 0 }
        },
      },
    })

    const result = resultObject(await callTool(tools, 'run_command', {
      command: 'npm', args: ['--version'], timeoutMs: 4_000,
    }))

    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.processCleanup).toEqual({
      attempted: true, matchedProcesses: 0, terminatedProcessTrees: 0,
    })
  }, 10_000)

  it('selects only live or previously observed descendants', () => {
    const input = {
      rootPid: 500,
      workspaceRoot: String.raw`C:\work\agentcode`,
      startedAtMs: 1_000,
      baselineProcesses: [{ pid: 30, createdAtMs: 1_003 }],
      observedDescendants: [
        { pid: 40, createdAtMs: 1_004 },
        { pid: 42, createdAtMs: 1_005 },
      ],
    }
    const selected = selectAttributedWindowsProcesses([
      { pid: 10, parentPid: 500, createdAtMs: 1_001, commandLine: 'node child.js' },
      { pid: 11, parentPid: 10, createdAtMs: 1_002, commandLine: 'chrome.exe' },
      {
        pid: 20, parentPid: 777, createdAtMs: 1_003,
        commandLine: String.raw`node C:\work\agentcode\node_modules\vite\bin\vite.js`,
      },
      { pid: 21, parentPid: 20, createdAtMs: 1_004, commandLine: 'helper.exe' },
      {
        pid: 30, parentPid: 888, createdAtMs: 1_003,
        commandLine: String.raw`node C:\work\agentcode\node_modules\vite\bin\vite.js`,
      },
      { pid: 40, parentPid: 4, createdAtMs: 1_004, commandLine: 'node observed-orphan.js' },
      { pid: 41, parentPid: 40, createdAtMs: 1_005, commandLine: 'chrome.exe' },
      { pid: 42, parentPid: 4, createdAtMs: 1_006, commandLine: 'node recycled-pid.js' },
      {
        pid: 900, parentPid: 888, createdAtMs: 1_007,
        commandLine: String.raw`node C:\work\agentcode\self.js`,
      },
    ], input, 900)

    expect(selected.matchedPids).toEqual([10, 11, 40, 41])
    expect(selected.rootPids).toEqual([10, 40])
  })

  it('does not poll Windows processes when detached-descendant tracking is disabled', async () => {
    let snapshots = 0
    const cleanup = createWindowsCommandProcessCleanup({
      async snapshot() { snapshots++; return [] },
    })

    const invocation = await cleanup.beginInvocation?.({
      workspaceRoot: String.raw`C:\work\agentcode`,
      startedAtMs: 1_000,
      trackDetachedDescendants: false,
    })
    if (invocation === undefined) throw new Error('expected invocation lifecycle')
    invocation.attachRoot(500)
    const result = await invocation.cleanupAfterExit()

    expect(snapshots).toBe(0)
    expect(result.attempted).toBe(false)
  })

  it('injects Windows enumeration and terminates only selected process-tree roots', async () => {
    const terminated: number[] = []
    const cleanup = createWindowsCommandProcessCleanup({
      currentPid: 900,
      async snapshot() {
        return [
          { pid: 10, parentPid: 500, createdAtMs: 1_001, commandLine: 'node child.js' },
          { pid: 11, parentPid: 10, createdAtMs: 1_002, commandLine: 'chrome.exe' },
          {
            pid: 20, parentPid: 777, createdAtMs: 1_003,
            commandLine: String.raw`node C:\work\agentcode\node_modules\vite\bin\vite.js`,
          },
          { pid: 30, parentPid: 888, createdAtMs: 900, commandLine: 'node old.js' },
        ]
      },
      async terminateTree(pid) { terminated.push(pid) },
    })

    const result = await cleanup.cleanupAfterExit({
      rootPid: 500, workspaceRoot: String.raw`C:\work\agentcode`, startedAtMs: 1_000,
    })

    expect(terminated).toEqual([10])
    expect(result).toEqual({
      attempted: true, matchedProcesses: 2, terminatedProcessTrees: 1,
    })
  })

  it('tracks an invocation descendant before reparenting and ignores a concurrent workspace process', async () => {
    const terminated: number[] = []
    let snapshotCall = 0
    const oldProcess = {
      pid: 70, parentPid: 4, createdAtMs: 900, commandLine: 'node existing.js',
    }
    const concurrent = {
      pid: 30, parentPid: 777, createdAtMs: 1_003,
      commandLine: String.raw`node C:\work\agentcode\node_modules\vite\bin\vite.js`,
    }
    const cleanup = createWindowsCommandProcessCleanup({
      currentPid: 900,
      trackingIntervalMs: 60_000,
      async snapshot() {
        snapshotCall++
        if (snapshotCall === 1) return [oldProcess]
        if (snapshotCall === 2) {
          return [
            oldProcess,
            { pid: 20, parentPid: 500, createdAtMs: 1_001, commandLine: 'node vite.js' },
            { pid: 21, parentPid: 20, createdAtMs: 1_002, commandLine: 'chrome.exe' },
            concurrent,
          ]
        }
        return [
          oldProcess,
          { pid: 20, parentPid: 4, createdAtMs: 1_001, commandLine: 'node vite.js' },
          { pid: 21, parentPid: 20, createdAtMs: 1_002, commandLine: 'chrome.exe' },
          concurrent,
        ]
      },
      async terminateTree(pid) { terminated.push(pid) },
    })
    const invocation = await cleanup.beginInvocation?.({
      workspaceRoot: String.raw`C:\work\agentcode`, startedAtMs: 1_000,
    })
    if (invocation === undefined) throw new Error('expected invocation tracking')
    invocation.attachRoot(500)

    const result = await invocation.cleanupAfterExit()

    expect(terminated).toEqual([20])
    expect(snapshotCall).toBe(4)
    expect(result).toEqual({
      attempted: true, matchedProcesses: 2, terminatedProcessTrees: 1,
    })
  })

  it('does not report a failed process-tree termination as successful', async () => {
    const cleanup = createWindowsCommandProcessCleanup({
      currentPid: 900,
      async snapshot() {
        return [{ pid: 10, parentPid: 500, createdAtMs: 1_001, commandLine: 'node child.js' }]
      },
      async terminateTree() { throw new Error('access denied') },
    })

    const result = await cleanup.cleanupAfterExit({
      rootPid: 500, workspaceRoot: String.raw`C:\work\agentcode`, startedAtMs: 1_000,
    })

    expect(result.matchedProcesses).toBe(1)
    expect(result.terminatedProcessTrees).toBe(0)
    expect(result.warning).toContain('access denied')
  })

  it('always runs the forced-stop root fallback when taskkill fails', async () => {
    let fallbackCalls = 0
    const warning = await forceTerminateWindowsProcessTree(
      500,
      () => { fallbackCalls++ },
      async () => { throw new Error('taskkill unavailable') },
    )

    expect(fallbackCalls).toBe(1)
    expect(warning).toContain('taskkill unavailable')
  })

  it('skips termination when PID creation time changes during revalidation', async () => {
    let snapshotCall = 0
    const terminated: number[] = []
    const cleanup = createWindowsCommandProcessCleanup({
      currentPid: 900,
      async snapshot() {
        snapshotCall++
        return [{
          pid: 10,
          parentPid: snapshotCall === 1 ? 500 : 4,
          createdAtMs: snapshotCall === 1 ? 1_001 : 2_000,
          commandLine: 'node child.js',
        }]
      },
      async terminateTree(pid) { terminated.push(pid) },
    })

    const result = await cleanup.cleanupAfterExit({
      rootPid: 500, workspaceRoot: String.raw`C:\work\agentcode`, startedAtMs: 1_000,
    })

    expect(terminated).toEqual([])
    expect(result.matchedProcesses).toBe(1)
    expect(result.terminatedProcessTrees).toBe(0)
    expect(result.warning).toContain('process identity changed')
  })

  it('keeps cleanup discovery failures as diagnostics without changing command success', async () => {
    const root = await temporaryDirectory()
    const tools = createAgentCodeToolRegistry(root, {
      commandProcessCleanup: {
        async cleanupAfterExit() { throw new Error('CIM unavailable') },
      },
    })

    const result = resultObject(await callTool(tools, 'run_command', {
      command: 'npm', args: ['--version'], timeoutMs: 20_000,
    }))

    expect(result.exitCode).toBe(0)
    expect(result.processCleanup).toEqual({
      attempted: true,
      matchedProcesses: 0,
      terminatedProcessTrees: 0,
      warning: 'CIM unavailable',
    })
  })

  it('excludes dependency metadata and caps grep output', async () => {
    const root = await temporaryDirectory()
    const tools = createAgentCodeToolRegistry(root)
    await writeFile(join(root, 'package-lock.json'), `https://registry.example/package\n${'noise '.repeat(20_000)}`)
    await callTool(tools, 'write_file', {
      path: 'src/app.ts',
      content: Array.from({ length: 100 }, (_, index) =>
        `export const match${index} = "needle-${'x'.repeat(300)}"`).join('\n'),
    })

    const dependencySearch = resultObject(await callTool(tools, 'grep_files', {
      pattern: 'https://', path: '.', maxResults: 200,
    }))
    expect(dependencySearch.matches).toEqual([])

    const bounded = resultObject(await callTool(tools, 'grep_files', {
      pattern: 'needle-', path: '.', maxResults: 200,
    }))
    expect(JSON.stringify(bounded.matches).length).toBeLessThan(13_000)
    expect(bounded.truncated).toBe(true)
  })

  it('canonicalizes grep targets before ripgrep can follow a junction or symlink', async () => {
    const root = await temporaryDirectory()
    const outside = await temporaryDirectory()
    await writeFile(join(outside, 'secret.txt'), 'TOP_SECRET_NEEDLE')
    await symlink(outside, join(root, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir')
    const tools = createAgentCodeToolRegistry(root)

    await expect(callTool(tools, 'grep_files', {
      pattern: 'TOP_SECRET_NEEDLE', path: 'linked-outside/secret.txt',
    })).rejects.toThrow(/escapes agentcode workspace/)

    const listed = resultObject(await callTool(tools, 'list_files', { path: '.' }))
    expect(listed.entries).toEqual([])
  })

  it('streams large read ranges and exposes an exact long-line continuation cursor', async () => {
    const root = await temporaryDirectory()
    const lines = Array.from({ length: 25_000 }, (_, index) =>
      `line-${String(index + 1).padStart(5, '0')}-${'x'.repeat(80)}`)
    await writeFile(join(root, 'large.txt'), lines.join('\n'))
    const longLine = Array.from({ length: 60_000 }, (_, index) => String(index % 10)).join('')
    await writeFile(join(root, 'long-line.txt'), longLine)
    const tools = createAgentCodeToolRegistry(root)

    const lateRange = resultObject(await callTool(tools, 'read_file', {
      path: 'large.txt', startLine: 24_990, endLine: 24_992,
    }))
    expect(lateRange.totalLines).toBe(25_000)
    expect(lateRange.endLine).toBe(24_992)
    expect(lateRange.text).toContain('24990: line-24990-')

    const first = resultObject(await callTool(tools, 'read_file', { path: 'long-line.txt' }))
    const nextColumn = Number(first.nextStartColumn)
    expect(first.endLine).toBe(1)
    expect(first.totalLines).toBe(1)
    expect(first.truncated).toBe(true)
    expect(first.nextStartLine).toBe(1)
    expect(nextColumn).toBeGreaterThan(1)
    expect(String(first.text).length).toBeLessThanOrEqual(20_000)

    const continued = resultObject(await callTool(tools, 'read_file', {
      path: 'long-line.txt', startLine: 1, startColumn: nextColumn, endLine: 1,
    }))
    expect(String(continued.text).startsWith(`1: ${longLine.slice(nextColumn - 1, nextColumn + 30)}`)).toBe(true)
  })

  it('bounds empty-directory traversal and reports the limiting budget', async () => {
    const root = await temporaryDirectory()
    await Promise.all(Array.from({ length: 50 }, (_, index) =>
      mkdir(join(root, `empty-${String(index).padStart(3, '0')}`))))
    const tools = createAgentCodeToolRegistry(root)

    const listed = resultObject(await callTool(tools, 'list_files', {
      path: '.', maxEntries: 100, maxDirectories: 10,
    }))
    expect(listed.entries).toEqual([])
    expect(listed.truncated).toBe(true)
    expect(listed.truncatedReason).toBe('max-directories')
    expect(listed.visitedDirectories).toBe(10)
  })

  it('deduplicates canonical directory cycles and observes cancellation during setup', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'visible.txt'), 'visible')
    const loop = join(root, 'loop')
    await symlink(root, loop, process.platform === 'win32' ? 'junction' : 'dir')
    const tools = createAgentCodeToolRegistry(root)
    try {
      const listed = resultObject(await callTool(tools, 'list_files', {
        path: '.', maxEntries: 100, maxDirectories: 10,
      }))
      expect(listed.entries).toEqual(['visible.txt'])
      expect(listed.truncated).toBe(false)
      expect(listed.visitedDirectories).toBe(1)

      const tool = tools.get('list_files')
      if (tool === undefined) throw new Error('missing list_files')
      const raw = { path: '.', maxEntries: 100, maxDirectories: 10 }
      const controller = new AbortController()
      const pending = tool.execute(tool.parse?.(raw) ?? raw, toolContext('list_files', controller.signal))
      controller.abort(new Error('stop traversal'))
      await expect(pending).rejects.toThrow(/stop traversal/)
    } finally {
      await rm(loop, { recursive: true, force: true })
    }
  })

  it('shares one bounded stdout and stderr budget', async () => {
    const root = await temporaryDirectory()
    await writeNpmScript(root, 'flood', 'node flood.cjs')
    await writeFile(join(root, 'flood.cjs'), [
      "process.stdout.write('o'.repeat(30_000))",
      "process.stderr.write('e'.repeat(30_000))",
    ].join('\n'))
    const tools = createAgentCodeToolRegistry(root)

    const result = resultObject(await callTool(tools, 'run_command', {
      command: 'npm', args: ['run', 'flood'], timeoutMs: 10_000,
    }))
    const stdout = String(result.stdout)
    const stderr = String(result.stderr)
    expect(stdout.length + stderr.length).toBeLessThanOrEqual(20_000)
    expect(result.outputTruncated).toBe(true)
    expect(result.omittedOutputChars).toBeGreaterThan(30_000)
  })

  it('kills the complete npm process tree before a timed-out call settles', async () => {
    const root = await temporaryDirectory()
    await writeNpmScript(root, 'linger', 'node parent.cjs')
    await writeFile(join(root, 'parent.cjs'), [
      "const { spawn } = require('node:child_process')",
      "spawn(process.execPath, ['child.cjs'], { stdio: 'ignore' })",
      'setTimeout(() => {}, 3_000)',
    ].join('\n'))
    await writeFile(join(root, 'child.cjs'), [
      "const { writeFileSync } = require('node:fs')",
      "setTimeout(() => writeFileSync('orphan-marker.txt', 'alive'), 1_500)",
    ].join('\n'))
    const tools = createAgentCodeToolRegistry(root)
    const started = Date.now()

    const result = resultObject(await callTool(tools, 'run_command', {
      command: 'npm', args: ['run', 'linger'], timeoutMs: 1_000,
    }))
    const elapsedMs = Date.now() - started
    expect(result.timedOut).toBe(true)
    expect(elapsedMs).toBeLessThan(2_500)
    await delay(Math.max(0, 1_800 - elapsedMs))
    await expect(readFile(join(root, 'orphan-marker.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 10_000)

  it('runs tracked orphan cleanup after forced timeout instead of only cancelling it', async () => {
    const root = await temporaryDirectory()
    await writeNpmScript(root, 'dev', 'node -e "setTimeout(() => {}, 30000)"')
    let cleanupCalls = 0
    let cancelCalls = 0
    const tools = createAgentCodeToolRegistry(root, {
      commandProcessCleanup: {
        async beginInvocation(input) {
          expect(input.trackDetachedDescendants).toBe(true)
          return {
            attachRoot() {},
            async cleanupAfterExit(signal) {
              expect(signal?.aborted).toBe(false)
              cleanupCalls++
              return { attempted: true, matchedProcesses: 1, terminatedProcessTrees: 1 }
            },
            async cancel() { cancelCalls++ },
          }
        },
        async cleanupAfterExit() { throw new Error('legacy cleanup should not run') },
      },
    })

    const result = resultObject(await callTool(tools, 'run_command', {
      command: 'npm', args: ['run', 'dev'], timeoutMs: 1_000,
    }))

    expect(result.timedOut).toBe(true)
    expect(cleanupCalls).toBe(1)
    expect(cancelCalls).toBe(0)
    expect(result.processCleanup).toEqual({
      attempted: true, matchedProcesses: 1, terminatedProcessTrees: 1,
    })
  }, 10_000)

  it('does not spawn npm when cancellation wins during async setup', async () => {
    const root = await temporaryDirectory()
    await writeNpmScript(root, 'mutate', 'node mutate.cjs')
    await writeFile(join(root, 'mutate.cjs'),
      "require('node:fs').writeFileSync('abort-marker.txt', 'ran')")
    const tools = createAgentCodeToolRegistry(root)
    const tool = tools.get('run_command')
    if (tool === undefined) throw new Error('missing run_command')
    const raw = { command: 'npm', args: ['run', 'mutate'], timeoutMs: 10_000 }
    const controller = new AbortController()

    const pending = tool.execute(tool.parse?.(raw) ?? raw, toolContext('run_command', controller.signal))
    controller.abort(new Error('probe abort'))
    await expect(pending).rejects.toThrow(/probe abort/)
    await delay(300)
    await expect(readFile(join(root, 'abort-marker.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enforces host-provided write ownership and write byte budgets', async () => {
    const root = await temporaryDirectory()
    const tools = createAgentCodeToolRegistry(root, {
      maxWriteBytes: 8,
      canWrite: path => path === 'owned.txt',
    })

    await expect(callTool(tools, 'write_file', {
      path: 'other.txt', content: 'no',
    })).rejects.toThrow(/not permitted/)
    await expect(callTool(tools, 'write_file', {
      path: 'owned.txt', content: '123456789',
    })).rejects.toThrow(/8-byte limit/)
    await callTool(tools, 'write_file', { path: 'owned.txt', content: 'safe' })
    expect(await readFile(join(root, 'owned.txt'), 'utf8')).toBe('safe')
  })

  it('lets the host replace npm execution with an allowlisted shell-free invocation', async () => {
    const root = await temporaryDirectory()
    const requests: readonly string[][] = []
    const observed: string[][] = requests as string[][]
    const tools = createAgentCodeToolRegistry(root, {
      resolveCommand(request) {
        observed.push([...request.args])
        if (request.args[0] !== 'test') throw new Error('command denied by host policy')
        return { executable: process.execPath, args: ['-e', "console.log('policy-ok')"] }
      },
    })

    const result = resultObject(await callTool(tools, 'run_command', {
      command: 'npm', args: ['test'], timeoutMs: 5_000,
    }))
    expect(result.stdout).toContain('policy-ok')
    expect(observed).toEqual([['test']])
    await expect(callTool(tools, 'run_command', {
      command: 'npm', args: ['install'], timeoutMs: 5_000,
    })).rejects.toThrow(/denied by host policy/)
  })

  it('renders concise tool diagnostics without duplicating large payloads', () => {
    const argumentsText = summarizeToolArguments(JSON.stringify({
      path: 'src/App.tsx', content: 'x'.repeat(5_000),
    }))
    const resultText = summarizeToolResult({
      isError: false,
      value: { path: 'src/App.tsx', text: 'source'.repeat(2_000), totalLines: 200 },
      content: [{ type: 'text', text: 'source'.repeat(2_000) }],
    })

    expect(argumentsText).toContain('<5000 chars>')
    expect(argumentsText.length).toBeLessThan(200)
    expect(resultText).toContain('chars of file text')
    expect(resultText.length).toBeLessThan(300)

    const errorText = summarizeToolResult({
      isError: true,
      error: { code: 'FAILED', message: 'failure'.repeat(2_000) },
      content: [{ type: 'text', text: 'failure'.repeat(2_000) }],
    })
    expect(errorText.length).toBeLessThan(1_200)
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ai-agent-sdk-agentcode-'))
  temporaryDirectories.push(directory)
  return directory
}

async function callTool(
  registry: ReturnType<typeof createAgentCodeToolRegistry>,
  name: string,
  raw: unknown,
): Promise<unknown> {
  const tool = registry.get(name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  const args = tool.parse?.(raw) ?? raw
  return tool.execute(args, toolContext(name))
}

function toolContext(toolName: string, signal = new AbortController().signal): ToolRunContext {
  return {
    callId: 'test-call' as ToolCallId,
    toolName, signal,
    turn: 1,
    step: 1,
    concludeTurn() {},
    addContext() {},
  }
}

async function writeNpmScript(root: string, name: string, script: string): Promise<void> {
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { [name]: script } }))
}

async function writeSkillFixture(root: string, id: string): Promise<void> {
  const directory = join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---', `name: ${id}`, `description: Exercise ${id}.`, '---',
    `# ${id}`, 'Follow this workflow only after activation.', '',
  ].join('\n'))
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

function resultObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected object result')
  }
  return value as Record<string, unknown>
}

class TextAdapter extends ModelAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
