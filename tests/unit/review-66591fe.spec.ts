/** Regression contracts for RR-02, RR-03 and RR-04; exercised against the SDK. */
import { describe, expect, it, vi } from 'vitest'
import { AgentTeam } from '../../packages/core/src/agent/team/team.ts'
import type { TeamSessionPort } from '../../packages/core/src/agent/team/contracts.ts'
import type { LinkedAgentResult } from '../../packages/core/src/agent/team/types.ts'
import { ModelAdapter } from '../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../packages/core/src/contract/generate-options.ts'
import type { StreamChunk } from '../../packages/core/src/stream/chunk.ts'
import type { ComposableModelProviderPlugin } from '../../packages/core/src/composition/provider/types.ts'
import { createRuntimeCompositionOwner } from '../../packages/core/src/composition/runtime/owner.ts'
import { snapshotHttpSecurityOptions } from '../../packages/mcp/src/client/http-security.ts'
import { McpClientConnection } from '../../packages/mcp/src/client/connection.ts'
import { createAbortTimeoutScope, resolveMcpReconnectOptions } from '../../packages/mcp/src/client/runtime-helpers.ts'
import { resolveRuntimeLimits } from '../../packages/core/src/agent/define/session/config.ts'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const result: LinkedAgentResult = {
  kind: 'message', succeeded: true, text: 'review completed', contextId: 'review-context',
}
function leadPort(): TeamSessionPort {
  let sequence = 0
  return {
    definition: { id: 'review-lead' }, conversationId: 'review-conversation', isRunning: false,
    inject: () => ++sequence,
    whenIdle: async () => undefined,
    runPending: async () => undefined,
  }
}
function makeTeam() {
  const team = new AgentTeam({ id: 'review-team', disposeTimeoutMs: 50, operationTimeoutMs: 1_000 })
  team.attach(leadPort(), { name: 'lead' })
  return team
}
class ReviewAdapter extends ModelAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
function provider(): ComposableModelProviderPlugin {
  return {
    kind: 'model-provider-plugin', apiVersion: 1, id: 'review-provider',
    displayName: 'Review provider', family: 'review', routes: ['review'],
    defaultModel: { provider: 'review', id: 'model' },
    setup(registrar) { registrar.registerAdapter(['review'], new ReviewAdapter()) },
  }
}

describe('66591fe review: physical settlement versus public completion', () => {
  it('does not report successful cancellation while a remote send ignores abort', async () => {
    vi.useFakeTimers()
    const team = makeTeam()
    const entered = deferred<void>(), raw = deferred<LinkedAgentResult>()
    team.linkAgent({ name: 'remote', transport: {
      protocol: 'review', agentId: 'remote-id',
      send: async () => { entered.resolve(undefined); return await raw.promise },
    } })
    const sending = team.sendMessage({ from: 'lead', target: 'remote', message: 'work', delivery: 'wakeup' })
    void sending.catch(() => undefined)
    try {
      await entered.promise
      const cancellation = team.cancel('remote')
      const outcome = cancellation.then(
        () => ({ code: 'UNEXPECTED_SUCCESS' }),
        error => error as { code: string },
      )
      await vi.advanceTimersByTimeAsync(51)
      expect(await outcome).toMatchObject({ code: 'TEAM_CANCELLATION_TIMEOUT' })
    } finally {
      raw.resolve(result)
      await Promise.allSettled([raw.promise, sending])
      await team.dispose().catch(() => undefined)
      vi.useRealTimers()
    }
  })

  it('preserves remote serial ownership after the first public wait is cancelled', async () => {
    vi.useFakeTimers()
    const team = makeTeam()
    const entered = deferred<void>(), firstRaw = deferred<LinkedAgentResult>(), secondRaw = deferred<LinkedAgentResult>()
    let calls = 0
    const send = vi.fn(async () => {
      calls++
      if (calls === 1) { entered.resolve(undefined); return await firstRaw.promise }
      return await secondRaw.promise
    })
    team.linkAgent({ name: 'remote', transport: { protocol: 'review', agentId: 'remote-id', send } })
    const caller = new AbortController()
    const first = team.sendMessage({ from: 'lead', target: 'remote', message: 'first', delivery: 'wakeup', signal: caller.signal })
    void first.catch(() => undefined)
    let second: Promise<unknown> | undefined
    try {
      await entered.promise
      caller.abort(new Error('cancel first public wait'))
      await expect(first).rejects.toBeDefined()
      second = team.sendMessage({ from: 'lead', target: 'remote', message: 'second', delivery: 'wakeup' })
      void second.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(1)
      // A repair can queue the second call or reject it until ownership clears.
      // It must not dispatch another physical send while the first is unresolved.
      expect(send).toHaveBeenCalledTimes(1)
      firstRaw.resolve(result)
      await vi.advanceTimersByTimeAsync(1)
    } finally {
      firstRaw.resolve(result); secondRaw.resolve(result)
      await Promise.allSettled([first, ...second === undefined ? [] : [second]])
      await team.dispose().catch(() => undefined)
      vi.useRealTimers()
    }
  })

  it('makes an awaited public result a reusable-session boundary', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider()] })
    try {
      const session = runtime.agent({ id: 'review-agent', instructions: 'Reply', compaction: false }).createSession()
      const first = session.stream('one')
      await first.result
      expect(session.isRunning).toBe(false)
      const second = session.stream('two')
      await expect(second.result).resolves.toMatchObject({ text: 'done' })
      expect(() => session.reset()).not.toThrow()
      await expect(session.compact()).resolves.toBeNull()
    } finally { await runtime.close() }
  })

  it('rejects a timeout outside the native timer range before scheduling anything', () => {
    expect(() => snapshotHttpSecurityOptions({
      serverName: 'review', url: 'https://mcp.example.test', operationTimeoutMs: 2_147_483_648,
    })).toThrow()
  })

  it.each(['resolve', 'reject'] as const)('retains unlink and idle ownership through late transport %s', async outcome => {
    const team = makeTeam(), entered = deferred<void>(), raw = deferred<LinkedAgentResult>()
    const close = vi.fn()
    const transport = { protocol: 'test', agentId: 'remote', close,
      send: async () => { entered.resolve(); return raw.promise } }
    const unlink = team.linkAgent({ name: 'remote', transport })
    const caller = new AbortController()
    const sending = team.followup('lead', 'remote', 'first', caller.signal)
    void sending.catch(() => undefined)
    await entered.promise
    caller.abort()
    await expect(sending).rejects.toBeDefined()
    expect(() => unlink()).toThrow(/running/)
    let idle = false
    const waiting = team.whenIdle('remote').then(() => { idle = true })
    await Promise.resolve()
    expect(idle).toBe(false)
    if (outcome === 'resolve') raw.resolve(result)
    else raw.reject(new Error('late failure'))
    await waiting
    expect(() => unlink()).not.toThrow()
    expect(team.messages()).toEqual([])
    await team.dispose()
    expect(close).not.toHaveBeenCalled()
  })

  it('does not let a cancelled queued send bypass the preceding physical task', async () => {
    const team = makeTeam(), entered = deferred<void>(), raw = deferred<LinkedAgentResult>()
    let calls = 0
    team.linkAgent({ name: 'remote', transport: { protocol: 'test', agentId: 'remote', send: async () => {
      if (++calls === 1) { entered.resolve(); return raw.promise }
      return result
    } } })
    const first = team.followup('lead', 'remote', 'first')
    await entered.promise
    const caller = new AbortController()
    const second = team.followup('lead', 'remote', 'second', caller.signal)
    caller.abort()
    await expect(second).rejects.toBeDefined()
    const third = team.followup('lead', 'remote', 'third')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(1)
    raw.resolve(result)
    await Promise.all([first, third])
    expect(calls).toBe(2)
    await team.dispose()
  })

  it('keeps cancelled raw transport work in runtime quiescence reporting', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider()], closeTimeoutMs: 10 })
    const entered = deferred<void>(), raw = deferred<LinkedAgentResult>(), close = vi.fn()
    const agent = runtime.agent({ id: 'lead', instructions: 'Lead', compaction: false })
    const team = runtime.team({ id: 'raw-owned', members: [{ name: 'lead', agent }] })
    const transport = { protocol: 'test', agentId: 'remote', close,
      send: async () => { entered.resolve(); return raw.promise } }
    team.linkAgent({ name: 'remote', transport })
    const caller = new AbortController()
    const sending = team.sendMessage({ from: 'lead', target: 'remote', message: 'first', delivery: 'wakeup', signal: caller.signal })
    void sending.catch(() => undefined)
    await entered.promise
    caller.abort()
    await expect(sending).rejects.toBeDefined()
    const report = await runtime.close()
    expect(report.operations.find(row => row.kind === 'team-operation')).toMatchObject({
      activeAtClose: 1, aborted: 1, settled: 0, unsettled: 1,
    })
    expect(report.components).toContainEqual(expect.objectContaining({ id: 'raw-owned', status: 'timed-out' }))
    raw.resolve(result)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(close).not.toHaveBeenCalled()
  })

  it('keeps remote whenIdle pending for work queued after the wait began', async () => {
    const team = makeTeam(), entered = deferred<void>(), raw = deferred<LinkedAgentResult>(), later = deferred<LinkedAgentResult>()
    let calls = 0
    team.linkAgent({ name: 'remote', transport: { protocol: 'test', agentId: 'remote', send: async () => {
      if (++calls === 1) { entered.resolve(); return raw.promise }
      return later.promise
    } } })
    const first = team.followup('lead', 'remote', 'first')
    await entered.promise
    let idle = false
    const waiting = team.whenIdle('remote').then(() => { idle = true })
    const second = team.followup('lead', 'remote', 'second')
    raw.resolve(result)
    await first
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(2)
    expect(idle).toBe(false)
    later.resolve(result)
    await Promise.all([second, waiting])
    await team.dispose()
  })

  it('bounds retained raw ownership when callers repeatedly cancel sends', async () => {
    const team = new AgentTeam({ id: 'bounded-raw', maxMessages: 1 })
    team.attach(leadPort(), { name: 'lead' })
    const entered = deferred<void>(), raw = deferred<LinkedAgentResult>()
    team.linkAgent({ name: 'remote', transport: { protocol: 'test', agentId: 'remote',
      send: async () => { entered.resolve(); return raw.promise } } })
    const caller = new AbortController()
    const first = team.followup('lead', 'remote', 'first', caller.signal)
    void first.catch(() => undefined)
    await entered.promise
    caller.abort()
    await expect(first).rejects.toBeDefined()
    await expect(team.followup('lead', 'remote', 'second')).rejects.toMatchObject({ code: 'TEAM_REMOTE_PENDING_LIMIT' })
    raw.resolve(result)
    await team.whenIdle('remote')
    await team.dispose()
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 2_147_483_648])('rejects timer value %s across MCP timeout fields', value => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    try {
      for (const field of ['operationTimeoutMs', 'closeTimeoutMs', 'toolCallTimeoutMs']) {
        expect(() => new McpClientConnection({ serverName: 'review', [field]: value }, () => { throw new Error('no I/O') }))
          .toThrow(RangeError)
      }
      for (const field of ['initialDelayMs', 'maxDelayMs']) {
        expect(() => resolveMcpReconnectOptions({ [field]: value })).toThrow(RangeError)
      }
      expect(() => createAbortTimeoutScope(value, 'invalid')).toThrow(RangeError)
      expect(() => resolveRuntimeLimits({ memoryOperationTimeoutMs: value })).toThrow(RangeError)
      expect(timer).not.toHaveBeenCalled()
    } finally { timer.mockRestore() }
  })

  it('accepts the native timer upper bound without restricting unrelated byte limits', () => {
    const options = snapshotHttpSecurityOptions({ serverName: 'review', url: 'https://example.test',
      operationTimeoutMs: 2_147_483_647, closeTimeoutMs: 2_147_483_647, maxTransportBytes: Number.MAX_SAFE_INTEGER })
    expect(options.timeoutMs).toBe(2_147_483_647)
    expect(options.maxTransportBytes).toBe(Number.MAX_SAFE_INTEGER)
    const scope = createAbortTimeoutScope(2_147_483_647, 'valid')
    expect(scope.signal.aborted).toBe(false)
    scope.dispose()
  })
})
