import { describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '../../src/core/primitives/brand.ts'
import { createApprovalBroker, fixedApprovalBroker } from '../../src/agent/tool/approval.ts'
import { defineTool, type ToolDefinition } from '../../src/agent/tool/definition.ts'
import { ToolError } from '../../src/agent/tool/errors.ts'
import type { ToolRunContext } from '../../src/agent/tool/definition.ts'
import {
  dispatchToolCall,
  type PreToolDecision,
  type ToolCallContext,
  type ToolInterceptor,
} from '../../src/agent/tool/pipeline.ts'
import { ToolRegistry } from '../../src/agent/tool/registry.ts'

const POSITION = { turn: 1, step: 1 } as const

function registryWith(...tools: readonly ToolDefinition<never>[]): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of tools) registry.register(tool)
  return registry
}

function tool(overrides: Partial<ToolDefinition<never>> = {}): ToolDefinition<never> {
  return {
    name: 't',
    description: 'A tool.',
    parameters: { type: 'object' },
    execute: () => 'ok',
    ...overrides,
  } as ToolDefinition<never>
}

async function run(
  registry: ToolRegistry,
  options: {
    toolName?: string
    rawArguments?: string
    interceptors?: readonly ToolInterceptor[]
    approvals?: Parameters<typeof dispatchToolCall>[0]['approvals']
    signal?: AbortSignal
    teardownTimeoutMs?: number
    defaultTimeoutMs?: number
  } = {},
) {
  return await dispatchToolCall({
    catalog: registry,
    call: {
      callId: ToolCallId('call_1'),
      toolName: options.toolName ?? 't',
      rawArguments: options.rawArguments ?? '{}',
    },
    position: POSITION,
    signal: options.signal ?? new AbortController().signal,
    ...options.interceptors === undefined ? {} : { interceptors: options.interceptors },
    ...options.approvals === undefined ? {} : { approvals: options.approvals },
    ...options.teardownTimeoutMs === undefined ? {} : { teardownTimeoutMs: options.teardownTimeoutMs },
    ...options.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.defaultTimeoutMs },
  })
}

describe('dispatchToolCall: failures reach the model instead of ending the turn', () => {
  it('reports an unknown tool as a result, not a throw', async () => {
    const result = await run(registryWith(tool()), { toolName: 'nope' })
    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.code).toBe('UNKNOWN_TOOL')
    // The text has to say it failed: the Responses API carries no error flag on a
    // tool output, so the model reads only this.
    expect(result.content[0]).toEqual({
      type: 'text',
      text: expect.stringMatching(/^Error: /u) as unknown as string,
    })
  })

  it('reports malformed argument JSON', async () => {
    const result = await run(registryWith(tool()), { rawArguments: '{"a": ' })
    expect(result.isError && result.error.code).toBe('MALFORMED_ARGUMENTS')
  })

  it('treats empty arguments as an empty object', async () => {
    const execute = vi.fn(() => 'ran')
    const result = await run(registryWith(tool({ execute })), { rawArguments: '   ' })
    expect(result.isError).toBe(false)
    expect(execute).toHaveBeenCalledWith({}, expect.anything())
  })

  it('reports a rejected parse as invalid arguments', async () => {
    const t = defineTool({
      name: 't',
      description: 'Validates.',
      parameters: { type: 'object' },
      parse: () => {
        throw new Error('city is required')
      },
      execute: () => 'unreachable',
    })
    const result = await run(registryWith(t as ToolDefinition<never>))
    expect(result.isError && result.error.code).toBe('INVALID_ARGUMENTS')
    expect(result.isError && result.error.message).toContain('city is required')
  })

  it('turns an ordinary throw from the body into a result', async () => {
    // The whole point: a TypeError inside a tool must not cost the user their turn.
    const result = await run(registryWith(tool({
      execute: () => {
        throw new TypeError('cannot read x of undefined')
      },
    })))
    expect(result.isError && result.error.message).toBe('cannot read x of undefined')
  })

  it('preserves the code of a respond-to-model ToolError', async () => {
    const result = await run(registryWith(tool({
      execute: () => {
        throw ToolError.respondToModel('file not found: /tmp/x', 'ENOENT')
      },
    })))
    expect(result.isError && result.error.code).toBe('ENOENT')
    expect(result.isError && result.error.message).toBe('file not found: /tmp/x')
  })

  it('lets a FATAL ToolError escape, because the model cannot recover from it', async () => {
    await expect(run(registryWith(tool({
      execute: () => {
        throw ToolError.fatal('tool registered with the wrong shape')
      },
    })))).rejects.toThrow('tool registered with the wrong shape')
  })

  it('rejects a value that is not lossless JSON', async () => {
    // A Date serializes without throwing but changes meaning, so the transcript
    // would disagree with what the tool actually returned.
    const result = await run(registryWith(tool({
      execute: () => new Date() as never,
    })))
    expect(result.isError && result.error.code).toBe('INVALID_TOOL_RESULT')
  })

  it('keeps the value when only rendering fails', async () => {
    const result = await run(registryWith(tool({
      execute: () => ({ n: 1 }),
      render: () => {
        throw new Error('formatter bug')
      },
    })))
    // The work succeeded; discarding it over a formatting bug would be the wrong trade.
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toEqual({ n: 1 })
    expect(result.meta).toEqual({ renderError: 'formatter bug' })
  })
})

describe('dispatchToolCall: interceptors', () => {
  it('reports a denial with the interceptor reason, phrased for the model', async () => {
    const deny: ToolInterceptor = {
      name: 'policy',
      before: () => Promise.resolve({ kind: 'deny', reason: 'writing outside the workspace' }),
    }
    const result = await run(registryWith(tool()), { interceptors: [deny] })
    expect(result.isError && result.error.code).toBe('TOOL_DENIED')
    expect(result.isError && result.error.message).toBe('writing outside the workspace')
  })

  it('never runs the body when denied', async () => {
    const execute = vi.fn(() => 'ran')
    const deny: ToolInterceptor = {
      name: 'policy',
      before: () => Promise.resolve({ kind: 'deny', reason: 'no' }),
    }
    await run(registryWith(tool({ execute })), { interceptors: [deny] })
    expect(execute).not.toHaveBeenCalled()
  })

  it('runs before-hooks even for a malformed call, so an audit sees the attempt', async () => {
    const before = vi.fn<
      (call: ToolCallContext, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
    >(() => Promise.resolve({ kind: 'allow' as const }))
    await run(registryWith(tool()), {
      toolName: 'ghost',
      interceptors: [{ name: 'audit', before }],
    })
    expect(before).toHaveBeenCalled()
    // `args` is undefined for a call that never parsed — interceptors must cope.
    expect(before.mock.calls[0]?.[0]).toMatchObject({ toolName: 'ghost', tool: undefined })
  })

  it('places earlier interceptors further out', async () => {
    const order: string[] = []
    const outer: ToolInterceptor = {
      name: 'outer',
      around: async (_call, next) => {
        order.push('outer-in')
        const result = await next()
        order.push('outer-out')
        return result
      },
    }
    const inner: ToolInterceptor = {
      name: 'inner',
      around: async (_call, next) => {
        order.push('inner-in')
        const result = await next()
        order.push('inner-out')
        return result
      },
    }
    await run(registryWith(tool({ execute: () => { order.push('body'); return 'ok' } })), {
      interceptors: [outer, inner],
    })
    expect(order).toEqual(['outer-in', 'inner-in', 'body', 'inner-out', 'outer-out'])
  })

  it('lets an around-interceptor observe the timeout, because timeout sits innermost', async () => {
    let seen: boolean | undefined
    const observe: ToolInterceptor = {
      name: 'metrics',
      around: async (_call, next) => {
        const result = await next()
        seen = result.isError
        return result
      },
    }
    const result = await run(registryWith(tool({
      timeoutMs: 10,
      execute: async (_args, ctx) => {
        await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve()))
        return 'late'
      },
    })), { interceptors: [observe] })
    expect(result.isError && result.error.code).toBe('TOOL_TIMEOUT')
    expect(seen).toBe(true)
  })

  it('replaces what the model reads without losing the value', async () => {
    const redact: ToolInterceptor = {
      name: 'redact',
      after: () => Promise.resolve({
        kind: 'replace',
        content: [{ type: 'text', text: '[redacted]' }],
      }),
    }
    const result = await run(registryWith(tool({ execute: () => 'secret' })), {
      interceptors: [redact],
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.content).toEqual([{ type: 'text', text: '[redacted]' }])
    expect(result.value).toBe('secret')
  })

  it('turns a blocked result into a failure carrying the feedback', async () => {
    const block: ToolInterceptor = {
      name: 'guard',
      after: () => Promise.resolve({
        kind: 'block',
        feedback: [{ type: 'text', text: 'that path is off limits' }],
      }),
    }
    const result = await run(registryWith(tool()), { interceptors: [block] })
    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toBe('that path is off limits')
    expect(result.content).toEqual([{ type: 'text', text: 'that path is off limits' }])
  })
})

describe('dispatchToolCall: approval', () => {
  it('fails closed when approval is asked for but no approver exists', async () => {
    // Falling through to running the tool would be the dangerous outcome.
    const ask: ToolInterceptor = {
      name: 'policy',
      before: () => Promise.resolve({ kind: 'ask', reason: 'this deletes files' }),
    }
    const execute = vi.fn(() => 'ran')
    const result = await run(registryWith(tool({ execute })), { interceptors: [ask] })
    expect(result.isError && result.error.code).toBe('TOOL_DENIED')
    expect(execute).not.toHaveBeenCalled()
  })

  it('runs the tool when approval is granted', async () => {
    const ask: ToolInterceptor = { name: 'p', before: () => Promise.resolve({ kind: 'ask' }) }
    const result = await run(registryWith(tool({ execute: () => 'done' })), {
      interceptors: [ask],
      approvals: fixedApprovalBroker('allow'),
    })
    expect(result.isError).toBe(false)
  })

  it('reports a denial to the model but does not end the turn', async () => {
    const ask: ToolInterceptor = { name: 'p', before: () => Promise.resolve({ kind: 'ask' }) }
    const result = await run(registryWith(tool()), {
      interceptors: [ask],
      approvals: fixedApprovalBroker('deny'),
    })
    expect(result.isError && result.error.code).toBe('TOOL_DENIED')
  })

  it('ends the turn when the user aborts instead of denying', async () => {
    // Denial is an answer the model reacts to; abort means there is nothing to
    // react to, so collapsing the two would strand a cancelled run.
    const ask: ToolInterceptor = { name: 'p', before: () => Promise.resolve({ kind: 'ask' }) }
    await expect(run(registryWith(tool()), {
      interceptors: [ask],
      approvals: fixedApprovalBroker('abort'),
    })).rejects.toThrow(/withdrawn/)
  })
})

describe('createApprovalBroker', () => {
  it('can be answered synchronously from inside its own listener', async () => {
    // Proves the waiter is registered BEFORE the request is published.
    const broker = createApprovalBroker()
    broker.onRequest(request => void broker.resolve(request.callId, 'allow'))
    const decision = await broker.request({
      callId: ToolCallId('c1'),
      toolName: 't',
      args: {},
      turn: 1,
      step: 1,
    })
    expect(decision).toBe('allow')
  })

  it('exposes pending requests and resolves them by id', async () => {
    const broker = createApprovalBroker()
    const pending = broker.request({
      callId: ToolCallId('c2'),
      toolName: 'rm',
      args: { path: '/tmp' },
      turn: 1,
      step: 1,
    })
    expect(broker.pending()).toHaveLength(1)
    expect(broker.pending()[0]?.toolName).toBe('rm')
    expect(broker.resolve(ToolCallId('c2'), 'deny')).toBe(true)
    await expect(pending).resolves.toBe('deny')
    expect(broker.pending()).toHaveLength(0)
  })

  it('reports an unknown id rather than throwing', async () => {
    // Legitimately happens when the turn was already cancelled.
    expect(createApprovalBroker().resolve(ToolCallId('gone'), 'allow')).toBe(false)
  })

  it('settles on abort so a torn-down turn cannot leak a parked promise', async () => {
    const broker = createApprovalBroker()
    const controller = new AbortController()
    const pending = broker.request(
      { callId: ToolCallId('c3'), toolName: 't', args: {}, turn: 1, step: 1 },
      controller.signal,
    )
    controller.abort()
    await expect(pending).resolves.toBe('abort')
  })

  it('answers immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(createApprovalBroker().request(
      { callId: ToolCallId('c4'), toolName: 't', args: {}, turn: 1, step: 1 },
      controller.signal,
    )).resolves.toBe('abort')
  })

  it('aborts every outstanding request on teardown', async () => {
    const broker = createApprovalBroker()
    const a = broker.request({ callId: ToolCallId('a'), toolName: 't', args: {}, turn: 1, step: 1 })
    const b = broker.request({ callId: ToolCallId('b'), toolName: 't', args: {}, turn: 1, step: 1 })
    broker.abortAll()
    await expect(Promise.all([a, b])).resolves.toEqual(['abort', 'abort'])
  })

  it('survives a listener that throws', async () => {
    const broker = createApprovalBroker()
    broker.onRequest(() => {
      throw new Error('observer bug')
    })
    broker.onRequest(request => void broker.resolve(request.callId, 'allow'))
    await expect(broker.request({
      callId: ToolCallId('c5'), toolName: 't', args: {}, turn: 1, step: 1,
    })).resolves.toBe('allow')
  })
})

describe('dispatchToolCall: timeout and cancellation', () => {
  it('fails fatally after a timed-out in-process tool ignores bounded teardown', async () => {
    const started = Date.now()
    await expect(run(registryWith(tool({
      timeoutMs: 10,
      execute: () => new Promise(() => {}),
    })), { teardownTimeoutMs: 10 })).rejects.toMatchObject({ code: 'TOOL_TEARDOWN_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('bounds an interceptor that ignores cancellation around the whole facade', async () => {
    const interceptor: ToolInterceptor = {
      name: 'stuck-policy',
      around: async () => await new Promise<never>(() => {}),
    }
    const started = Date.now()
    await expect(run(registryWith(tool()), {
      interceptors: [interceptor], defaultTimeoutMs: 10, teardownTimeoutMs: 10,
    })).rejects.toMatchObject({ code: 'TOOL_TEARDOWN_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('awaits the tool rather than abandoning it', async () => {
    // Racing and walking away would leave a tool still mutating state the loop no
    // longer tracks. So the signal is aborted and the body is given time to stop.
    let settled = false
    const result = await run(registryWith(tool({
      timeoutMs: 10,
      execute: async (_args, ctx) => {
        await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve()))
        settled = true
        return 'stopped cleanly'
      },
    })))
    expect(result.isError && result.error.code).toBe('TOOL_TIMEOUT')
    expect(settled).toBe(true)
  })

  it('does not report a timeout for a tool that finishes in time', async () => {
    const result = await run(registryWith(tool({ timeoutMs: 1_000, execute: () => 'fast' })))
    expect(result.isError).toBe(false)
  })

  it('distinguishes cancellation before dispatch from cancellation during it', async () => {
    const controller = new AbortController()
    controller.abort()
    const execute = vi.fn(() => 'ran')
    const before = await run(registryWith(tool({ execute })), { signal: controller.signal })
    expect(before.isError && before.error.code).toBe('TOOL_ABORTED_BEFORE_DISPATCH')
    expect(execute).not.toHaveBeenCalled()

    // Aborted from OUTSIDE while the body runs, which is the real scenario. Note
    // the `aborted` check before subscribing: a listener attached to an
    // already-aborted signal never fires, and a tool that forgets this hangs.
    const live = new AbortController()
    const during = await run(registryWith(tool({
      execute: async (_args, ctx) => {
        setTimeout(() => live.abort(), 0)
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve()
            return
          }
          ctx.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        throw new Error('interrupted')
      },
    })), { signal: live.signal })
    expect(during.isError && during.error.code).toBe('TOOL_ABORTED')
  })
})

describe('dispatchToolCall: side channels', () => {
  it('records concludeTurn on the result', async () => {
    const result = await run(registryWith(tool({
      execute: (_args, ctx) => {
        ctx.concludeTurn()
        return 'final'
      },
    })))
    expect(result.isError).toBe(false)
    expect(result.isError ? undefined : result.concludesTurn).toBe(true)
  })

  it('collects added context, including from a failed call', async () => {
    const ok = await run(registryWith(tool({
      execute: (_args, ctx) => {
        ctx.addContext('the file changed underneath you')
        return 'done'
      },
    })))
    expect(ok.additionalContext).toEqual([
      { type: 'text', text: 'the file changed underneath you' },
    ])

    const failed = await run(registryWith(tool({
      execute: (_args, ctx) => {
        ctx.addContext([{ type: 'text', text: 'you have now tried this three times' }])
        throw new Error('still failing')
      },
    })))
    expect(failed.isError).toBe(true)
    expect(failed.additionalContext).toHaveLength(1)
  })

  it('gives the body the call identity and position', async () => {
    const execute = vi.fn<(args: never, ctx: ToolRunContext) => string>(() => 'ok')
    await run(registryWith(tool({ execute })))
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      callId: 'call_1',
      toolName: 't',
      turn: 1,
      step: 1,
    })
  })
})
