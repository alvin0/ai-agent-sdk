import { describe, it, expect, vi } from 'vitest'
import { createToolExecutionInterceptor, type ToolExecutionStore, type ToolOperationClaim } from '../../packages/core/src/agent/tool/execution.ts'
import { dispatchToolCall } from '../../packages/core/src/agent/tool/pipeline.ts'
import { ToolRegistry } from '../../packages/core/src/agent/tool/registry.ts'
import { defineTool } from '../../packages/core/src/agent/tool/definition.ts'
import { ToolCallId } from '../../packages/core/src/primitives/brand.ts'

function stateStore() {
  const records = new Map<string, ToolOperationClaim>()
  const store: ToolExecutionStore = {
    async claim(operation) {
      const saved = records.get(operation.operationId)
      if (saved) return saved
      records.set(operation.operationId, { status: 'unknown', operation })
      return { status: 'claimed' }
    },
    async complete(operation, result) { records.set(operation.operationId, { status: 'completed', operation, result }) },
  }
  return { records, store }
}
function setup(store: ToolExecutionStore) {
  const execute = vi.fn(() => ({ receipt: 'created' }))
  const catalog = new ToolRegistry()
  catalog.register(defineTool({ name: 'create', description: 'create record', parameters: { type: 'object' }, execute }))
  const run = (args = '{}') => dispatchToolCall({ catalog,
    call: { callId: ToolCallId('provider-reused'), toolName: 'create', rawArguments: args },
    position: { turn: 1, step: 1 }, signal: new AbortController().signal,
    interceptors: [createToolExecutionInterceptor({ store, identity: { tenant: 'authenticated' }, operationId: () => 'tenant:op-1' })],
  })
  return { execute, run }
}
describe('execution adapter recovery contract', () => {
  it('reuses a durable result after a new interceptor is created', async () => {
    const { store } = stateStore()
    const first = setup(store), resumed = setup(store)
    expect((await first.run()).isError).toBe(false)
    expect((await resumed.run()).isError).toBe(false)
    expect(first.execute).toHaveBeenCalledTimes(1)
    expect(resumed.execute).not.toHaveBeenCalled()
  })
  it('does not retry a side effect after the result commit fails', async () => {
    const { store } = stateStore()
    store.complete = async () => { throw new Error('simulated crash before durable result') }
    const first = setup(store)
    await expect(first.run()).rejects.toThrow(/simulated crash/)
    expect(first.execute).toHaveBeenCalledTimes(1)
    const resumed = setup(store)
    await expect(resumed.run()).rejects.toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN' })
    expect(resumed.execute).not.toHaveBeenCalled()
  })
  it('rejects a reused operation ID with different validated arguments', async () => {
    const { store } = stateStore(), { run, execute } = setup(store)
    await run('{"amount":1}')
    await expect(run('{"amount":2}')).rejects.toMatchObject({ code: 'OPERATION_ID_CONFLICT' })
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('one concurrent claimant executes while another must reconcile', async () => {
    const { store } = stateStore(), a = setup(store), b = setup(store)
    const outcomes = await Promise.allSettled([a.run(), b.run()])
    expect(outcomes.map(x => x.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(a.execute.mock.calls.length + b.execute.mock.calls.length).toBe(1)
  })
})

it('uses the configured remote backend with trusted identity and still applies post-policy', async () => {
  const catalog = new ToolRegistry(), local = vi.fn(() => 'should not execute')
  catalog.register(defineTool({ name: 'remote', description: 'remote operation', parameters: { type: 'object' }, execute: local }))
  const execute = vi.fn(async (request: import('../../packages/core/src/agent/tool/execution.ts').ToolExecutionRequest) => {
    expect(request.identity).toEqual({ tenant: 'host' })
    expect(request.args).toEqual({ tenant: 'model' })
    return { isError: false as const, value: 'PRIVATE/TOOL~SENTINEL%', content: [{ type: 'text' as const, text: 'PRIVATE/TOOL~SENTINEL%' }] }
  })
  const result = await dispatchToolCall({ catalog, call: { callId: ToolCallId('remote'), toolName: 'remote', rawArguments: '{"tenant":"model"}' },
    position: { turn: 1, step: 1 }, signal: new AbortController().signal,
    interceptors: [createToolExecutionInterceptor({ identity: { tenant: 'host' }, operationId: () => 'op', backend: {
      id: 'remote', capabilities: { cancellation: 'forced', filesystem: 'restricted', network: 'none', cleanup: 'guaranteed' }, execute,
    } }), { name: 'sanitize', after: async () => ({ kind: 'replace', content: [{ type: 'text', text: 'public' }] }) }],
  })
  expect(result.content).toEqual([{ type: 'text', text: 'public' }])
  expect(JSON.stringify(result)).not.toContain('PRIVATE/TOOL~SENTINEL%')
  expect(local).not.toHaveBeenCalled()
  expect(execute).toHaveBeenCalledTimes(1)
})
