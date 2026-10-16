import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, createAssistantMessage, createToolResultMessage, ToolCallId }
  from '../../packages/core/dist/index.js'
import { compare, percentDelta } from '../../test-human/multi-agent-bench/analyze.ts'
import { collaborationFactory, execute, type Result } from '../../test-human/multi-agent-bench/execute.ts'
import { Collector, evidenceFingerprint } from '../../test-human/multi-agent-bench/metrics.ts'
import { parseArgs } from '../../test-human/multi-agent-bench/run.ts'
import { tasks, selectTasks } from '../../test-human/multi-agent-bench/tasks.ts'
import { discoverTool, requiredArguments } from '../../test-human/multi-agent-bench/fake.ts'
import { sandboxChecks, Workspace } from '../../test-human/multi-agent-bench/workspace.ts'

const exec = promisify(execFile)

describe('autonomous multi-agent benchmark', () => {
  it('runs the offline CLI on two tasks, both arms, all worker usage, and comparison end to end', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ma-bench-ci-'))
    const out = join(parent, 'results')
    try {
      await exec(process.execPath, ['--experimental-strip-types',
        resolve('test-human/multi-agent-bench/run.ts'), '--provider', 'fake', '--tasks', 'sequential,code-change',
        '--arms', 'single,team', '--reps', '1', '--concurrency', '2', '--out', out],
      { cwd: tmpdir(), timeout: 45000 })
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
      expect(audit.tools.some((tool: { member: string; name: string }) =>
        tool.member !== 'lead' && tool.name === 'write_file')).toBe(true)
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
    expect(parseArgs(base)).toMatchObject({ suite: 'scaled', maxTotalTokens: 80000 })
    expect(parseArgs([...base, '--suite', 'smoke', '--label', 'round2', '--arms', 'collab',
      '--max-total-tokens', '1000', '--max-turns', '50', '--max-tool-calls', '70', '--codex-auth', '/tmp/auth.json']))
      .toMatchObject({ suite: 'smoke', label: 'round2', arms: ['collab'], maxTotalTokens: 1000,
        maxTurns: 50, maxToolCalls: 70, codexAuth: '/tmp/auth.json' })
    expect(() => parseArgs([...base, '--suite', 'missing'])).toThrow('Suite')
    expect(() => parseArgs([...base, '--max-total-tokens', '0'])).toThrow('positive integer')
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


  it('maps the collab-board public export to the managed collaboration option', () => {
    const createManagedAgentTeam = vi.fn(() => ({}))
    const factory = collaborationFactory({ CollaborationTaskBoard: class {}, createManagedAgentTeam })!
    factory({} as Parameters<typeof factory>[0])
    expect(createManagedAgentTeam).toHaveBeenCalledWith({ collaboration: true })
  })

  it('counts text and JSON managed worker reports as evidence but ignores pure coordination status', () => {
    const notice = (text: string) => createUserMessage({ source: { kind: 'app', producer: 'managed-team' },
      content: [{ type: 'text', text }] })
    const task = notice('User task')
    for (const text of [JSON.stringify(['worker result: p95=42']),
      "Worker 'helper' finished. Full result payload: p95=42", JSON.stringify({
      type: 'worker-settlement', worker: 'helper', status: 'completed', report: { text: 'p95=42' } })]) {
      expect(evidenceFingerprint([task, notice(text)])).not.toBe(evidenceFingerprint([task]))
    }
    const hold = notice(JSON.stringify({ type: 'hold', workers: [{ name: 'helper', status: 'running' }] }))
    expect(evidenceFingerprint([task, hold]))
      .toBe(evidenceFingerprint([task]))
    const id = ToolCallId('wait-1')
    const wait = createAssistantMessage({ source: { provider: 'fake', model: 'fixture' },
      content: [{ type: 'tool-call', id, name: 'join_workers', arguments: '{}' }] })
    const result = (content: unknown) => createToolResultMessage({ callId: id, isError: false,
      content: [{ type: 'text', text: JSON.stringify(content) }] })
    expect(evidenceFingerprint([task, wait, result([{ name: 'helper', status: 'running',
      protocol: 'in-process', role: 'worker', deliveries: ['quiet', 'wakeup'] }])]))
      .toBe(evidenceFingerprint([task]))
    expect(evidenceFingerprint([task, wait, result([{ name: 'helper', outcome: { text: 'p95=42' } }])]))
      .not.toBe(evidenceFingerprint([task]))
    expect(evidenceFingerprint([task, wait, result({ report: 'changed tool result' })]))
      .not.toBe(evidenceFingerprint([task]))
  })

  it('discovers renamed spawn/wait capabilities and fills only required schema fields', () => {
    const tools = [
      { name: 'dispatch_work', description: 'Create an independent worker for a task.', parameters: {
        type: 'object', properties: { prompt: { type: 'string' }, role: { type: 'string', enum: ['worker'] },
          optionalName: { type: 'string' } }, required: ['prompt', 'role'] } },
      { name: 'settle', description: 'Wait until workers finish their work.', parameters: {
        type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } },
          timeout: { type: 'integer' } }, required: ['ids'] } },
      { name: 'send_input', description: 'Send a message to an existing agent.', parameters: {} },
    ]
    const spawn = discoverTool({ tools }, 'spawn')!, wait = discoverTool({ tools }, 'wait')!
    expect(spawn.name).toBe('dispatch_work')
    expect(requiredArguments(spawn.parameters, 'Do the work', 'new-address'))
      .toEqual({ prompt: 'Do the work', role: 'worker' })
    expect(wait.name).toBe('settle')
    expect(requiredArguments(wait.parameters, 'Do the work', 'returned-address')).toEqual({ ids: ['returned-address'] })
  })

  it('cancels both arms at shared token, turn and tool caps and reports separate cap hits', async () => {
    for (const arm of ['single', 'team'] as const) for (const cap of [
      { maxTotalTokens: 360, expected: 'tokens' }, { maxTurns: 2, expected: 'turns' },
      { maxToolCalls: 2, expected: 'toolCalls' },
    ] as const) {
      const { result } = await execute({ arm, task: 'code-change', rep: 1,
        provider: 'fake', model: 'gpt-6-luna', timeoutMs: 10000, ...cap })
      expect(result.status, `${arm} ${cap.expected}`).toBe('cap-hit')
      expect(result.pass).toBe(false)
      expect(result.metrics.capHits[cap.expected]).toBe(true)
      if ('maxTurns' in cap) expect(result.metrics.totalModelCalls).toBeLessThanOrEqual(cap.maxTurns)
      if ('maxToolCalls' in cap) expect(result.metrics.toolCalls).toBeLessThanOrEqual(cap.maxToolCalls)
      if ('maxTotalTokens' in cap) expect(result.metrics.reportedTokens).toBeGreaterThanOrEqual(cap.maxTotalTokens)
    }
  }, 30000)

  it('generates reproducible scaled files, pages large inputs, and freezes the shared interface', async () => {
    const a = selectTasks('scaled', 123), b = selectTasks('scaled', 123), c = selectTasks('scaled', 124)
    expect(a).toEqual(b)
    expect(a[0]!.files).not.toEqual(c[0]!.files)
    const logs = Object.entries(a[0]!.files!).filter(([name]) => name.endsWith('.csv'))
    expect(logs).toHaveLength(48)
    expect(logs.every(([, text]) => Buffer.byteLength(text) >= 20000 && Buffer.byteLength(text) <= 40960)).toBe(true)
    expect(a.find(t => t.id === 'code-change')!.checks.length).toBeGreaterThanOrEqual(25)
    expect(Object.keys(a.find(t => t.id === 'bug-hunt')!.files!).filter(n => n.endsWith('.cjs'))).toHaveLength(30)
    const workspace = await Workspace.create(a[0]!)
    try {
      const first = await workspace.page(logs[0]![0]), second = await workspace.page(logs[0]![0], first.nextOffset!)
      expect(Buffer.byteLength(first.content)).toBe(16384)
      expect(first.content + second.content).toBe(logs[0]![1])
      await expect(workspace.page(logs[0]![0], 0, 16385)).rejects.toThrow('16384')
    } finally { await workspace.close() }
    const code = await Workspace.create(a.find(t => t.id === 'code-change')!)
    try { await expect(code.write('./src/interface.cjs', 'changed')).rejects.toThrow('Frozen') }
    finally { await code.close() }
  })

  it('executes review counterexamples against original code and safely rejects malformed findings', async () => {
    const task = tasks.find(t => t.id === 'review')!, workspace = await Workspace.create(task)
    try {
      for (const value of [null, 4, [], { findings: null }, { findings: [null, 1, {}] }]) {
        await workspace.write('findings.json', JSON.stringify(value))
        const grade = await workspace.grade()
        expect(grade.pass).toBe(false)
        expect(grade).not.toHaveProperty('error')
      }
      await workspace.write('findings.json', JSON.stringify({ findings: task.reviewCases }))
      expect((await workspace.grade()).pass).toBe(true)
      const findings = structuredClone(task.reviewCases!)
      // Invalid by policy, but the original buggy bounded-count handler rejects 101: no executed proof.
      findings.find(f => f.rule === 'bounded-count')!.example = 101
      await workspace.write('findings.json', JSON.stringify({ findings }))
      expect((await workspace.grade()).pass).toBe(false)
      // Overwriting the candidate handler cannot make an invented counterexample valid.
      await workspace.write('src/handler-10.cjs', 'exports.accepts = () => true;')
      expect((await workspace.grade()).checks[4]).toBe(false)
    } finally { await workspace.close() }
  })

  it('runs authored calculations with paged data and no process or dynamic-code access', async () => {
    const workspace = await Workspace.create(tasks.find(t => t.id === 'extraction')!)
    try {
      await workspace.write('probe.cjs', `module.exports.run=()=>{
        const path=list_files().find(p=>p.endsWith('.csv'));
        const first=read_file(path),second=read_file(path,first.nextOffset);
        let escaped=false;try{({}).constructor.constructor('return process')();escaped=true}catch{}
        return {first:first.content.length,second:second.content.length,
          process:typeof process,require:typeof require,escaped};
      }`)
      await workspace.run('probe.cjs', 'probe.json')
      expect(JSON.parse(await workspace.readAll('probe.json'))).toMatchObject({ first: 16384,
        process: 'undefined', require: 'undefined', escaped: false })
      await workspace.write('loop.cjs', 'module.exports.run=()=>{while(true){}};')
      await expect(workspace.run('loop.cjs', 'probe.json')).rejects.toThrow('timed out')
    } finally { await workspace.close() }
  })

  it('keeps all six tiny tasks runnable as the explicit smoke suite', async () => {
    for (const task of selectTasks('smoke')) {
      const { result } = await execute({ arm: 'single', suite: 'smoke', task: task.id, rep: 1,
        provider: 'fake', model: 'gpt-6-luna', timeoutMs: 10000 })
      expect(result.pass, task.id).toBe(true)
    }
  }, 30000)

  it('prints meaningful deltas, including zero-baseline and unknown cases', async () => {
    expect(percentDelta(100, 85)).toBe(-15)
    expect(percentDelta(0, 0)).toBe(0)
    expect(percentDelta(0, 1)).toBeNull()
    expect(percentDelta(null, 1)).toBeNull()
    const parent = await mkdtemp(join(tmpdir(), 'ma-compare-'))
    try {
      for (const [label, tokens] of [['a', 100], ['b', 80]] as const) {
        const dir = join(parent, label)
        const { mkdir } = await import('node:fs/promises')
        await mkdir(dir)
        await writeFile(join(dir, 'manifest.json'), JSON.stringify({ protocol: 'test', label }))
        await writeFile(join(dir, 'review.single.1.json'), JSON.stringify({ task: 'review', arm: 'single',
          pass: true, score: 1, status: 'completed',
          metrics: { ...new Collector().metrics(100), totalTokens: tokens } }))
      }
      const summary = await compare(join(parent, 'a'), join(parent, 'b'))
      expect(summary.rows.every(row => row.deltaPercent.tokens === -20)).toBe(true)
    } finally { await rm(parent, { recursive: true, force: true }) }
  })
})
