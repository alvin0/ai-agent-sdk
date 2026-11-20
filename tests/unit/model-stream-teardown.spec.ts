import { afterEach, expect, it, vi } from 'vitest'
import { ModelAdapter, ModelRegistry, createTextMessage, type StreamChunk } from '../../packages/core/src/index.ts'
import type { GenerateOptions, ModelInvocationContext } from '../../packages/core/src/index.ts'
import { History, runTurn, type AgentEvent } from '../../packages/core/src/agent-public.ts'
import { RunLedger } from '../../packages/core/src/agent/accounting/ledger.ts'

afterEach(() => { vi.useRealTimers() })

interface Scenario { deadline: string; attempt: boolean; reported: boolean; closed?: boolean }
type Report = Awaited<ReturnType<RunLedger['finalize']>>

function blockedRegistry(scenario: Scenario) {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let attemptId: string | undefined
  class BlockedAdapter extends ModelAdapter {
    async * stream(options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
      if (scenario.attempt) {
        context?.declareProviderAttemptAccounting?.()
        const attempt = await context?.startProviderAttempt?.({
          provider: 'test', model: 'm', method: 'POST', origin: 'https://example.test',
        }, options.signal)
        attemptId = attempt?.attemptId
        if (scenario.reported) {
          if (scenario.closed) attempt?.end({ status: 'success', dispatchState: 'sent',
            reported: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, usageFinal: true })
          yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }
        }
      }
      await blocked
    }
  }
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], new BlockedAdapter())
  return { registry, release, attemptId: () => attemptId }
}

function assertIncompleteUsage(report: Report | undefined, scenario: Scenario, attemptId: string | undefined) {
  if (report === undefined) throw new Error('expected a bounded terminal accounting report')
  const coverage = scenario.reported ? 'partial' : 'missing'
  expect(report.usage.coverage).toMatchObject({ logicalCalls: 1, [coverage]: 1 })
  expect(report.usage.authoritative).toBe(false)
  expect(report.modelCalls).toHaveLength(1)
  expect(report.modelCalls[0]).toMatchObject({
    coverage, authoritative: false, provider: 'test', model: 'm',
  })
  if (scenario.attempt) {
    expect(attemptId).toBeDefined()
    expect(report.modelCalls[0]!.attempts[0]).toMatchObject({
      attemptId, origin: 'https://example.test', spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
    })
  }
  if (scenario.reported) expect(report.usage.reported.totalTokens).toBe(5)
  else {
    expect(report.modelCalls[0]!.possiblyBilledAttemptsWithoutUsage).toBe(1)
    expect(report.usage.reported.totalTokens).toBeUndefined()
  }
}

it.each([
  { deadline: 'total', attempt: false, reported: false },
  { deadline: 'idle', attempt: false, reported: false },
  { deadline: 'total', attempt: true, reported: false },
  { deadline: 'total', attempt: true, reported: true, closed: true },
  { deadline: 'total', attempt: true, reported: true, closed: false },
])('bounds reports after timeout $deadline, attempt $attempt, usage $reported, closed $closed', async scenario => {
  vi.useFakeTimers()
  const fixture = blockedRegistry(scenario)
  const accounting = new RunLedger({ agentId: 'timeout-test', mode: 'basic', maxTurns: 1 })
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage('bounded model timeout') })
  let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
  let completed = false
  const run = (async () => {
    for await (const event of runTurn({
      registry: fixture.registry, config: { provider: 'test', model: 'm' }, history, accounting,
      ...(scenario.deadline === 'total' ? { modelTimeoutMs: 10 } : { modelIdleTimeoutMs: 10 }),
      teardownTimeoutMs: 10,
    })) if (event.type === 'turn-end') terminal = event
    completed = true
  })()
  let completedBeforeRelease: boolean
  let report: Awaited<ReturnType<RunLedger['finalize']>> | undefined
  try {
    await vi.advanceTimersByTimeAsync(100)
    completedBeforeRelease = completed
    if (completed) report = await accounting.finalize('error', false)
  } finally {
    fixture.release()
    await run
  }
  expect(completedBeforeRelease).toBe(true)
  expect(terminal?.outcome.reason).toMatchObject({
    kind: 'error', failure: { code: 'MODEL_TEARDOWN_TIMEOUT' },
  })
  assertIncompleteUsage(report, scenario, fixture.attemptId())
  expect(vi.getTimerCount()).toBe(0)
})

function usageEvidenceRegistry(retry: boolean, blocked: boolean, invalidTotal = false) {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  class UsageAdapter extends ModelAdapter {
    override async *stream(_options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
      context!.declareProviderAttemptAccounting!()
      const first = await context!.startProviderAttempt!({
        provider: 'test', model: 'm', method: 'POST', origin: 'https://example.test',
      })
      first.end({ status: 'success', dispatchState: 'sent', reported: { inputTokens: 3 }, usageFinal: false })
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: invalidTotal ? 4 : 5 } }
      if (retry) {
        const second = await context!.startProviderAttempt!({
          provider: 'test', model: 'm', method: 'POST', origin: 'https://example.test',
        })
        yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 } }
        if (blocked) await pending
        second.end({ status: 'success', dispatchState: 'sent', reported: { inputTokens: 7 }, usageFinal: false })
      } else if (blocked) await pending
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], new UsageAdapter())
  return { registry, release }
}

it.each([false, true])('supplements partial attempt usage on normal completion, retry %s', async retry => {
  const fixture = usageEvidenceRegistry(retry, false)
  const handle = fixture.registry.stream({ provider: 'test', model: 'm', messages: [] })
  for await (const _chunk of handle) { /* Consume the model call through its public entry point. */ }
  const report = await handle.report
  expect(report.reported).toEqual(retry
    ? { inputTokens: 10, outputTokens: 6, totalTokens: 16 }
    : { inputTokens: 3, outputTokens: 2, totalTokens: 5 })
  expect(report.attempts[0]!.reported).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
  expect(report.coverage).toBe('partial')
})

it('preserves invalid stream usage evidence without deriving a replacement total', async () => {
  const fixture = usageEvidenceRegistry(false, false, true)
  const handle = fixture.registry.stream({ provider: 'test', model: 'm', messages: [] })
  for await (const _chunk of handle) { /* Consume the malformed usage report. */ }
  const report = await handle.report
  expect(report.reported).toEqual({ inputTokens: 3, outputTokens: 2 })
  expect(report.attempts[0]).toMatchObject({
    coverage: 'partial', reported: { inputTokens: 3, outputTokens: 2 }, error: { code: 'USAGE_INVALID' },
  })
  expect(report.error?.code).toBe('USAGE_INVALID')
  expect(report.authoritative).toBe(false)
})

function ambiguousUsageRegistry(blocked: boolean, invalidTotal: boolean) {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  class AmbiguousAdapter extends ModelAdapter {
    override async *stream(_options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
      context!.declareProviderAttemptAccounting!()
      const start = () => context!.startProviderAttempt!({
        provider: 'test', model: 'm', method: 'POST', origin: 'https://example.test',
      })
      const first = await start()
      first.end({ status: 'error', dispatchState: 'sent', reported: { inputTokens: 3 }, usageFinal: false })
      const second = await start()
      const third = await start()
      yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 4, totalTokens: invalidTotal ? 10 : 11 } }
      if (blocked) await pending
      second.end({ status: 'success', dispatchState: 'sent' })
      third.end({ status: 'success', dispatchState: 'sent' })
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], new AmbiguousAdapter())
  return { registry, release }
}

it.each([
  { blocked: false, invalidTotal: false },
  { blocked: true, invalidTotal: false },
  { blocked: false, invalidTotal: true },
  { blocked: true, invalidTotal: true },
])('keeps unassigned usage as lower bounds with multiple open attempts, %j', async scenario => {
  vi.useFakeTimers()
  const fixture = ambiguousUsageRegistry(scenario.blocked, scenario.invalidTotal)
  const accounting = new RunLedger({ agentId: 'ambiguous-test', mode: 'basic', maxTurns: 1,
    cumulativeTokenBudget: true })
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage('preserve unassigned usage') })
  const run = (async () => {
    for await (const _event of runTurn({
      registry: fixture.registry, config: { provider: 'test', model: 'm' }, history, accounting,
      modelTimeoutMs: 10, teardownTimeoutMs: 10,
    })) { /* Drain normal and timed-out model calls through the agent ledger. */ }
  })()
  try {
    await vi.advanceTimersByTimeAsync(100)
    await run
    const report = await accounting.finalize('error', false)
    expect(report.usage.reported).toEqual(scenario.invalidTotal
      ? { inputTokens: 7, outputTokens: 4 }
      : { inputTokens: 7, outputTokens: 4, totalTokens: 11 })
    expect(report.usage.budgetTokens).toBe(11)
    expect(report.modelCalls[0]!.attempts.map(attempt => attempt.reported)).toEqual([{ inputTokens: 3 }, {}, {}])
    expect(report.modelCalls[0]!.possiblyBilledAttemptsWithoutUsage).toBe(2)
    expect(accounting.usageStop?.usageUnavailable).toBe(true)
  } finally {
    fixture.release()
    await vi.advanceTimersByTimeAsync(1)
    await run
  }
  expect(vi.getTimerCount()).toBe(0)
})

it.each([false, true])('keeps known usage in timeout reports without counting overlap twice, retry %s', async retry => {
  vi.useFakeTimers()
  const fixture = usageEvidenceRegistry(retry, true)
  const accounting = new RunLedger({ agentId: 'timeout-test', mode: 'basic', maxTurns: 1,
    cumulativeTokenBudget: true })
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage('bounded usage evidence') })
  const run = (async () => {
    for await (const _event of runTurn({
      registry: fixture.registry, config: { provider: 'test', model: 'm' }, history, accounting,
      modelTimeoutMs: 10, teardownTimeoutMs: 10,
    })) { /* Drain the bounded agent turn. */ }
  })()
  try {
    await vi.advanceTimersByTimeAsync(100)
    await run
    const report = await accounting.finalize('error', false)
    expect(report.usage.reported).toEqual(retry
      ? { inputTokens: 10, outputTokens: 6, totalTokens: 16 }
      : { inputTokens: 3, outputTokens: 2, totalTokens: 5 })
    expect(report.usage.budgetTokens).toBe(retry ? 16 : 5)
    expect(report.modelCalls[0]!.coverage).toBe('partial')
    expect(accounting.usageStop).toBeUndefined()
  } finally {
    fixture.release()
    await vi.advanceTimersByTimeAsync(1)
    await run
  }
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps a timed-out preparation from dispatching after the turn has finished', async () => {
  vi.useFakeTimers()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const dispatch = vi.fn()
  class PreparingAdapter extends ModelAdapter {
    override async prepareCall(...args: Parameters<ModelAdapter['prepareCall']>) {
      await pending
      return super.prepareCall(...args)
    }
    override async *stream(): AsyncIterable<StreamChunk> {
      dispatch()
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], new PreparingAdapter())
  const accounting = new RunLedger({ agentId: 'timeout-test', mode: 'basic', maxTurns: 1,
    cumulativeTokenBudget: true })
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage('cancel model preparation') })
  const run = (async () => {
    for await (const _event of runTurn({
      registry, config: { provider: 'test', model: 'm' }, history, accounting,
      modelTimeoutMs: 10, teardownTimeoutMs: 10,
    })) { /* Drain the bounded agent turn. */ }
  })()
  try {
    await vi.advanceTimersByTimeAsync(100)
    await run
    const report = await accounting.finalize('error', false)
    expect(report.modelCalls[0]).toMatchObject({
      dispatchState: 'not-sent', coverage: 'not-applicable', possiblyBilledAttemptsWithoutUsage: 0,
    })
    expect(accounting.usageStop).toBeUndefined()
  } finally {
    release()
    await vi.advanceTimersByTimeAsync(1)
    await run
  }
  expect(dispatch).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not prepare or dispatch a registry call whose signal was already aborted', async () => {
  const prepare = vi.fn()
  const dispatch = vi.fn()
  class PreparingAdapter extends ModelAdapter {
    override async prepareCall(...args: Parameters<ModelAdapter['prepareCall']>) {
      prepare()
      return super.prepareCall(...args)
    }
    override async *stream(): AsyncIterable<StreamChunk> {
      dispatch()
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], new PreparingAdapter())
  const signal = AbortSignal.abort(new Error('cancelled before preparation'))
  const handle = registry.stream({ provider: 'test', model: 'm', messages: [], signal })
  const chunks: StreamChunk[] = []
  for await (const chunk of handle) chunks.push(chunk)
  expect(chunks).toMatchObject([{ type: 'finish', reason: { kind: 'aborted' } }])
  await expect(handle.report).resolves.toMatchObject({
    dispatchState: 'not-sent', coverage: 'not-applicable', possiblyBilledAttemptsWithoutUsage: 0,
  })
  expect(prepare).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()
})
