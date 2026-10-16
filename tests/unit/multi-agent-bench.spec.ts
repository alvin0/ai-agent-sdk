import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@alvin0/ai-agent-sdk-core'
import { compare } from '../../test-human/multi-agent-bench/analyze.ts'
import { collaborationFactory, execute, type Result } from '../../test-human/multi-agent-bench/execute.ts'
import { Collector, evidenceFingerprint } from '../../test-human/multi-agent-bench/metrics.ts'
import { parseArgs } from '../../test-human/multi-agent-bench/run.ts'
import { tasks } from '../../test-human/multi-agent-bench/tasks.ts'
import { sandboxChecks, Workspace } from '../../test-human/multi-agent-bench/workspace.ts'

const exec = promisify(execFile)

describe('autonomous multi-agent benchmark', () => {
  it('runs the offline CLI on two tasks, both arms, all worker usage, and comparison end to end', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ma-bench-ci-'))
    const out = join(parent, 'results')
    try {
      await exec(process.execPath, ['--experimental-strip-types',
        'test-human/multi-agent-bench/run.ts', '--provider', 'fake', '--tasks', 'sequential,code-change',
        '--arms', 'single,team', '--reps', '1', '--concurrency', '2', '--out', out],
      { cwd: resolve('.'), timeout: 45000 })
      const names = (await readdir(out)).filter(name => /\.(single|team)\.1\.json$/.test(name))
      const results: Result[] = await Promise.all(names.map(async name =>
        JSON.parse(await readFile(join(out, name), 'utf8')) as Result))
      expect(results).toHaveLength(4)
      expect(results.every(result => result.pass && result.score === 1)).toBe(true)
      const team = results.find(result => result.task === 'code-change' && result.arm === 'team')!
      expect(team.metrics.spawns).toBe(1)
      expect(team.metrics.totalModelCalls).toBeGreaterThan(team.metrics.leadModelCalls)
      expect(team.metrics.totalTokens).toBe(team.metrics.totalModelCalls * 120)
      expect(results.filter(result => result.task === 'sequential').every(result => result.metrics.spawns === 0))
        .toBe(true)
      const audit = JSON.parse(await readFile(join(out, 'code-change.team.1.audit.json'), 'utf8'))
      expect(audit.tools).toContainEqual({ member: 'lead', name: 'spawn_agent' })
      expect(audit.tools).toContainEqual({ member: 'helper', name: 'write_file' })
      const summary = await compare(out, out)
      expect(summary.comparable).toBe(true)
      expect(summary.rows.find(row => row.task === 'ALL' && row.arm === 'team')?.a.passRate).toBe(1)
    } finally { await rm(parent, { recursive: true, force: true }) }
  }, 60000)

  it('rejects older live models, invalid tasks, repetition counts, and unrecognized providers', () => {
    const base = ['--out', '/tmp/unused-bench']
    expect(() => parseArgs([...base, '--model', 'gpt-5.4'])).toThrow('no fallback')
    expect(() => parseArgs([...base, '--tasks', 'missing'])).toThrow('Unknown task')
    expect(() => parseArgs([...base, '--reps', '0'])).toThrow('positive integer')
    expect(() => parseArgs([...base, '--provider', 'other'])).toThrow('Provider')
    expect(parseArgs(base).model).toBe('gpt-6-luna')
    expect(parseArgs([...base, '--model', 'gpt-7']).model).toBe('gpt-7')
    expect(collaborationFactory({})).toBeUndefined()
    expect(collaborationFactory({ createCollaborativeAgentTeam: () => {} })).toBeTypeOf('function')
  })

  it('does not treat synthetic hold messages or duplicate evidence as new information', () => {
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Task' }] })
    const hold = createUserMessage({ source: { kind: 'app', producer: 'managed-team' },
      content: [{ type: 'text', text: 'Outstanding managed workers: helper.' }] })
    expect(evidenceFingerprint([message, hold])).toBe(evidenceFingerprint([message]))
    expect(evidenceFingerprint([message, message])).toBe(evidenceFingerprint([message]))
    const news = createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'New worker result' }] })
    expect(evidenceFingerprint([message, news]))
      .not.toBe(evidenceFingerprint([message]))
    expect(new Collector().metrics(0).totalTokens).toBeNull()
  })

  it('rejects traversal and symlinks and fails unmodified code with deterministic graders', async () => {
    const workspace = await Workspace.create(tasks.find(task => task.id === 'code-change')!)
    try {
      await expect(workspace.read('../package.json')).rejects.toThrow('outside workspace')
      await symlink('/etc', join(workspace.root, 'escape'))
      await expect(workspace.read('escape/passwd')).rejects.toThrow('Symlinks')
      expect((await workspace.grade()).pass).toBe(false)
    } finally { await workspace.close() }
  })

  it('keeps process and dynamic code generation out of fixture evaluation', async () => {
    const checks = ['typeof process === "undefined"', 'typeof require === "undefined"',
      '(()=>{try{({}).constructor.constructor("return process")();return false}catch{return true}})()']
    expect(await sandboxChecks({}, checks)).toEqual([true, true, true])
    await expect(sandboxChecks({ 'loop.cjs': 'while(true){}' }, ['true'])).rejects.toThrow('timed out')
  })

  it('grades every artifact task as failed when the requested output is absent', async () => {
    for (const task of tasks.filter(task => task.checks.length === 0)) {
      const workspace = await Workspace.create(task)
      try { expect((await workspace.grade()).pass).toBe(false) } finally { await workspace.close() }
    }
  })

  it('exercises every scripted solution through the SDK without live credentials', async () => {
    for (const task of tasks) {
      const { result } = await execute({ arm: 'single', task: task.id, rep: 1,
        provider: 'fake', model: 'gpt-6-luna', timeoutMs: 15000 })
      expect(result.pass, task.id).toBe(true)
    }
  }, 30000)
})
