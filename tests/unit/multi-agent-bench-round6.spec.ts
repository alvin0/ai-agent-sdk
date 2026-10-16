import { execFile, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter, ModelError } from '../../packages/core/dist/index.js'
import type { GenerateOptions, StreamChunk } from '../../packages/core/dist/index.js'
import { execute, type Job } from '../../test-human/multi-agent-bench/execute.ts'
import { FakeAdapter } from '../../test-human/multi-agent-bench/fake.ts'
import { Collector } from '../../test-human/multi-agent-bench/metrics.ts'
import { reliableAdapter, retryWaitMetrics, Semaphore } from '../../test-human/multi-agent-bench/reliability.ts'
import { attachPermits } from '../../test-human/multi-agent-bench/inflight.ts'
import { runCell } from '../../test-human/multi-agent-bench/cells.ts'
import { compare, summarize } from '../../test-human/multi-agent-bench/analyze.ts'
import { parseArgs } from '../../test-human/multi-agent-bench/run.ts'
import { Workspace } from '../../test-human/multi-agent-bench/workspace.ts'

const exec = promisify(execFile)
const job: Job = { provider: 'fake', model: 'gpt-6-luna', task: 'sequential', suite: 'smoke',
  arm: 'single', rep: 1, timeoutMs: 10000 }
function failureStatus(code: string) {
  const status = ({ AUTH: 401, SERVER: 503, RATE_LIMIT: 429 } as Record<string, number>)[code]
  return status ? { status } : {}
}
class FailingAdapter extends ModelAdapter {
  calls = 0
  readonly failures: number
  readonly inner: ModelAdapter
  readonly code: string
  constructor(inner: ModelAdapter, failures: number, code = 'RATE_LIMIT') {
    super(); this.inner = inner; this.failures = failures; this.code = code
  }
  override resolveModel(provider: string, model: string) { return this.inner.resolveModel(provider, model) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (++this.calls <= this.failures) {
      throw new ModelError('Rate limit exceeded', this.code, {
        ...failureStatus(this.code),
        providerRetryAfterMs: 1 })
    }
    yield* this.inner.stream(options)
  }
}

describe('Round 6 infrastructure robustness', () => {
  it.each(['single', 'team'] as const)('recovers 429 in %s with retry metrics and a passing grade', async arm => {
    const { result } = await execute({ ...job, arm, task: 'code-change' }, undefined, { adapterFactory: (_job, task) =>
      new FailingAdapter(new FakeAdapter(task), 1) })
    expect(result).toMatchObject({ status: 'completed', pass: true,
      metrics: { modelRetries: 1, retryScheduledWaitMs: 1 } })
    expect(result.metrics.retryWaitMs).toBeGreaterThan(0)
    expect(result.metrics.wallActiveMs).toBeCloseTo(result.metrics.wallMs - result.metrics.retryWallWaitMs!, 6)
    expect(result.infraFailures).toEqual([])
  })

  it('marks a team run contaminated when only a worker exhausts provider retries', async () => {
    class WorkerFailure extends FakeAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (!options.system?.includes('Bench session: lead')) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT',
            message: 'Rate limit exceeded', providerRetryAfterMs: 1 } } }
        } else yield* super.stream(options)
      }
    }
    const { result } = await execute({ ...job, arm: 'team', task: 'code-change' }, undefined, {
      adapterFactory: (_job, task) => new WorkerFailure(task),
    })
    expect(result).toMatchObject({ status: 'infra-failed', pass: false, metrics: { spawns: 1, modelRetries: 5 } })
    expect(result.infraFailures?.[0]?.code).toBe('RATE_LIMIT')
  })

  it('exhausts six model attempts and two fresh-workspace reruns, preserving all evidence', async () => {
    const out = await mkdtemp(join(tmpdir(), 'ma-r6-retry-'))
    const create = vi.spyOn(Workspace, 'create')
    const adapters: FailingAdapter[] = []
    try {
      const { result } = await runCell(job, out, item => execute(item, undefined, {
        adapterFactory: (_job, task) => {
          const adapter = new FailingAdapter(new FakeAdapter(task), Infinity)
          adapters.push(adapter); return adapter
        },
      }))
      expect(result).toMatchObject({ status: 'infra-failed', pass: false, metrics: { modelRetries: 5 } })
      expect(result.attempts?.map(attempt => attempt.status)).toEqual(Array(3).fill('infra-failed'))
      expect(adapters.map(adapter => adapter.calls)).toEqual([6, 6, 6])
      const roots = await Promise.all(create.mock.results.map(entry => entry.value as Promise<Workspace>))
      expect(new Set(roots.map(workspace => workspace.root)).size).toBe(3)
      expect((await readdir(out)).filter(name => /attempt-\d+\.json$/.test(name))).toHaveLength(3)
      expect(summarize([result])).toMatchObject({ n: 0, infraFailedRuns: 1, infraFailedAttempts: 3,
        allAttemptsRetries: 15, score: { mean: null }, tokens: { mean: null } })
    } finally { create.mockRestore(); await rm(out, { recursive: true, force: true }) }
  })

  it('does not retry AUTH within a call but recovers a later fresh run and retains infra attempt counts', async () => {
    const out = await mkdtemp(join(tmpdir(), 'ma-r6-auth-'))
    let attempt = 0
    try {
      const { result } = await runCell(job, out, item => execute(item, undefined, {
        adapterFactory: (_job, task) => ++attempt === 1
          ? new FailingAdapter(new FakeAdapter(task), Infinity, 'AUTH') : new FakeAdapter(task),
      }))
      expect(result.status).toBe('completed')
      expect(result.attempts?.map(entry => entry.status)).toEqual(['infra-failed', 'completed'])
      expect(result.attempts?.[0]?.metrics?.modelRetries).toBe(0)
      expect(summarize([result])).toMatchObject({ n: 1, passRate: 1, infraFailedRuns: 0, infraFailedAttempts: 1 })
      const skipped = vi.fn()
      expect((await runCell(job, out, skipped, true)).skipped).toBe(true)
      expect(skipped).not.toHaveBeenCalled()
    } finally { await rm(out, { recursive: true, force: true }) }
  })

  it('honors the observed 4000ms provider delay', async () => {
    vi.useFakeTimers()
    let calls = 0
    class Adapter extends ModelAdapter {
      override async *stream(): AsyncIterable<StreamChunk> {
        if (++calls === 1) yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'RATE_LIMIT', message: 'Rate limit exceeded', providerRetryAfterMs: 4000,
        } } }
        else yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    try {
      const collector = new Collector(), adapter = reliableAdapter(new Adapter(), collector)
      const options = { provider: 'fake', model: 'gpt-6-luna', messages: [] }
      const consume = async () => { for await (const _chunk of adapter.stream(options)) { /* drain */ } }
      const pending = consume()
      await vi.advanceTimersByTimeAsync(3999)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1); await pending
      expect(calls).toBe(2)
      expect(collector.retryScheduledWaitMs).toBe(4000)
    } finally { vi.useRealTimers() }
  })

  it('uses union retry wait for active wall time and total wait for provider pressure', () => {
    expect(retryWaitMetrics([[10, 30], [20, 50], [70, 80]])).toEqual({ total: 60, union: 50 })
  })

  it('limits concurrent model attempts across sessions and releases permits after failures', async () => {
    const semaphore = new Semaphore(2)
    const first = await semaphore.acquire(), second = await semaphore.acquire()
    const controller = new AbortController()
    const cancelled = semaphore.acquire(controller.signal)
    const rejected = expect(cancelled).rejects.toThrow('cancelled')
    controller.abort(new Error('cancelled')); await rejected
    let granted = false
    const pending = semaphore.acquire().then(release => { granted = true; return release })
    await Promise.resolve(); expect(granted).toBe(false)
    first(); const third = await pending
    expect(granted).toBe(true)
    first(); second(); third()
    const release = await semaphore.acquire(); release()
  })

  it('resumes completed/graded cells, reruns missing and infra-failed cells, and warns on incomplete N', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ma-r6-resume-')), out = join(parent, 'results')
    const script = resolve('test-human/multi-agent-bench/run.ts')
    try {
      await exec(process.execPath, ['--experimental-strip-types', script, '--provider', 'fake', '--suite', 'smoke',
        '--tasks', 'sequential,code-change', '--arms', 'single,team', '--reps', '1', '--concurrency', '4',
        '--max-inflight-model-calls', '1', '--out', out], { timeout: 30000 })
      const keepPath = join(out, 'sequential.single.1.json'), keep = await readFile(keepPath, 'utf8')
      const infraPath = join(out, 'sequential.team.1.json')
      const infra = JSON.parse(await readFile(infraPath, 'utf8'))
      infra.status = 'infra-failed'; infra.pass = false; infra.score = 0
      await writeFile(infraPath, JSON.stringify(infra))
      await rm(join(out, 'code-change.single.1.json'))
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        const summary = await compare(out, out)
        expect(summary.insufficientCells)
          .toContainEqual({ side: 'a', task: 'sequential', arm: 'team', n: 0, requested: 1 })
        expect(summary.insufficientCells)
          .toContainEqual({ side: 'a', task: 'code-change', arm: 'single', n: 0, requested: 1 })
        expect(warn.mock.calls.flat().join(' ')).toContain('N=0 < requested reps=1')
      } finally { warn.mockRestore(); log.mockRestore() }
      const { stdout } = await exec(process.execPath, ['--experimental-strip-types', script, '--resume', out],
        { timeout: 30000 })
      expect(stdout.match(/resumed\/skipped/g)).toHaveLength(2)
      expect(await readFile(keepPath, 'utf8')).toBe(keep)
      expect(JSON.parse(await readFile(infraPath, 'utf8')).attempts).toHaveLength(2)
      const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'))
      expect(manifest).toMatchObject({ maxInflightModelCalls: 1, maxRunAttempts: 3,
        retryPolicy: { maxRetries: 5, backoff: { maxDelayMs: 60000 } } })
    } finally { await rm(parent, { recursive: true, force: true }) }
  }, 60000)


  it.each(['SERVER', 'TRANSPORT', 'TIMEOUT', 'STREAM_CLOSED'])(
    'retries SDK-classified %s failures with the same policy', async code => {
      const { result } = await execute(job, undefined, { adapterFactory: (_job, task) =>
        new FailingAdapter(new FakeAdapter(task), 1, code) })
      expect(result).toMatchObject({ status: 'completed', pass: true, metrics: { modelRetries: 1 } })
    })

  it('classifies provider authentication failures during model preparation as infrastructure', async () => {
    class AuthFailure extends FakeAdapter {
      override async resolveModel(): Promise<never> { throw new ModelError('Credentials rejected', 'AUTH') }
    }
    const { result } = await execute(job, undefined, { adapterFactory: (_job, task) => new AuthFailure(task) })
    expect(result).toMatchObject({ status: 'infra-failed', pass: false, metrics: { modelRetries: 0 } })
    expect(result.infraFailures?.[0]?.code).toBe('AUTH')
  })

  it('keeps a model failure in the scored cohort without automatic run retries', async () => {
    const out = await mkdtemp(join(tmpdir(), 'ma-r6-model-'))
    try {
      const { result } = await runCell(job, out, item => execute(item, undefined, {
        adapterFactory: (_job, task) => new FailingAdapter(new FakeAdapter(task), Infinity, 'INVALID_REQUEST'),
      }))
      expect(result).toMatchObject({ status: 'failed', metrics: { modelRetries: 0 } })
      expect(result.attempts).toHaveLength(1)
      expect(summarize([result])).toMatchObject({ n: 1, score: { mean: 0 }, infraFailedRuns: 0 })
      const run = vi.fn()
      expect((await runCell(job, out, run, true)).skipped).toBe(true)
      expect(run).not.toHaveBeenCalled()
    } finally { await rm(out, { recursive: true, force: true }) }
  })

  it('does not under-wait a provider hint above 60s or retry already-emitted answer content', async () => {
    class Adapter extends ModelAdapter {
      readonly content: boolean
      constructor(content: boolean) { super(); this.content = content }
      override async *stream(): AsyncIterable<StreamChunk> {
        if (this.content) yield { type: 'text-delta', index: 0, text: 'partial' }
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'RATE_LIMIT', message: 'Rate limit exceeded', providerRetryAfterMs: this.content ? 1 : 60001,
        } } }
      }
    }
    for (const content of [false, true]) {
      const collector = new Collector(), chunks = []
      for await (const chunk of reliableAdapter(new Adapter(content), collector).stream({
        provider: 'fake', model: 'gpt-6-luna', messages: [],
      })) chunks.push(chunk)
      expect(collector.modelRetries).toBe(0)
      expect(collector.infraFailures).toHaveLength(1)
      expect(chunks.filter(chunk => chunk.type === 'text-delta')).toHaveLength(Number(content))
    }
  })

  it('classifies a deadline during retry backoff as infrastructure and measures only elapsed wait', async () => {
    vi.useFakeTimers()
    const controller = new AbortController(), collector = new Collector()
    class Adapter extends ModelAdapter {
      override async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'RATE_LIMIT', message: 'Rate limit exceeded', providerRetryAfterMs: 4000,
        } } }
      }
    }
    try {
      const consume = async () => {
        for await (const _chunk of reliableAdapter(new Adapter(), collector).stream({
          provider: 'fake', model: 'gpt-6-luna', messages: [], signal: controller.signal,
        })) { /* drain */ }
      }
      const pending = consume()
      await vi.advanceTimersByTimeAsync(1000)
      controller.abort(); await pending
      expect(collector.infraFailures[0]?.code).toBe('RATE_LIMIT')
      expect(collector.retryScheduledWaitMs).toBe(4000)
      expect(collector.metrics(1000).retryWaitMs).toBe(1000)
    } finally { vi.useRealTimers() }
  })

  it('shares parent permits across child processes and recovers queued/held permits on exit', async () => {
    class Child extends EventEmitter {
      connected = true
      grants: number[] = []
      send(message: { id: number }, callback: (error: Error | null) => void) {
        this.grants.push(message.id); callback(null)
      }
    }
    const a = new Child(), b = new Child(), c = new Child(), semaphore = new Semaphore(2)
    for (const child of [a, b, c]) attachPermits(child as unknown as ChildProcess, semaphore)
    a.emit('message', { permit: 'acquire', id: 1 })
    b.emit('message', { permit: 'acquire', id: 1 })
    c.emit('message', { permit: 'acquire', id: 1 })
    await Promise.resolve(); await Promise.resolve()
    expect([a.grants.length, b.grants.length, c.grants.length]).toEqual([1, 1, 0])
    a.emit('exit')
    await Promise.resolve(); await Promise.resolve()
    expect(c.grants).toEqual([1])
    a.emit('message', { permit: 'acquire', id: 2 })
    a.emit('disconnect')
    b.emit('message', { permit: 'release', id: 1 })
    c.emit('exit')
    await Promise.resolve(); await Promise.resolve()
    expect(a.grants).toEqual([1])
    const release = await semaphore.acquire(); release()
  })

  it('defaults to four global calls and requires resume to reuse the saved experiment', () => {
    expect(parseArgs(['--out', '/tmp/r6']).maxInflightModelCalls).toBe(4)
    expect(() => parseArgs(['--out', '/tmp/r6', '--max-inflight-model-calls', '0'])).toThrow('positive')
    expect(() => parseArgs(['--resume', '/tmp/r6', '--model', 'gpt-6-sol'])).toThrow('saved manifest')
    expect(() => parseArgs(['--resume', '/tmp/r6', '--out', '/tmp/r6'])).toThrow('Use --out')
  })
})
