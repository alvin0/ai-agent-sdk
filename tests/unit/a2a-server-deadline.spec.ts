import { afterEach, expect, it, vi } from 'vitest'
import { A2A_PROTOCOL_VERSION, Role, TaskState, type SendMessageRequest } from '@a2a-js/sdk'
import { DefaultExecutionEventBus, RequestContext, ServerCallContext } from '@a2a-js/sdk/server'
import { defineAgent, type AgentSession } from '@alvin0/ai-agent-sdk-core/agent'
import { DefinedAgentA2AExecutor } from '../../packages/a2a/src/server/executor.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const agent = defineAgent({ id: 'server-deadline', provider: 'offline', model: 'fixture', instructions: 'Reply.' })
const response = { text: 'completed', outcome: { completed: true, reason: { kind: 'completed' } } }

function requestContext(): RequestContext {
  const request: SendMessageRequest = { tenant: '', configuration: undefined, metadata: undefined,
    message: { messageId: 'message', taskId: '', contextId: 'context', role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text', value: 'work' },
        mediaType: 'text/plain', filename: '', metadata: undefined }],
      metadata: undefined, extensions: [], referenceTaskIds: [] } }
  const call = new ServerCallContext({ requestedVersion: A2A_PROTOCOL_VERSION })
  return new RequestContext(request, 'task', 'context', call)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function eventBus() {
  const bus = new DefaultExecutionEventBus()
  const states: TaskState[] = []
  bus.on('event', event => { if (event.kind === 'statusUpdate') states.push(event.data.status!.state) })
  return { bus, states }
}

it('releases the long default deadline after completed tasks and admission failures', async () => {
  vi.useFakeTimers()
  const nativeTimeout = vi.spyOn(AbortSignal, 'timeout')
  const session = { run: async () => response } as unknown as AgentSession
  for (const requireAuthenticated of [false, true]) {
    const executor = new DefinedAgentA2AExecutor({ agent, createSession: () => session, requireAuthenticated })
    const { bus, states } = eventBus()
    try {
      await executor.execute(requestContext(), bus)
      expect(states).toContain(requireAuthenticated ? TaskState.TASK_STATE_FAILED : TaskState.TASK_STATE_COMPLETED)
      expect(vi.getTimerCount()).toBe(0)
      expect(nativeTimeout).not.toHaveBeenCalled()
    } finally { await executor.dispose() }
  }
})

it('bounds session creation even when user abort listeners stop immediate propagation', async () => {
  vi.useFakeTimers()
  const creation = deferred<AgentSession>()
  const entered = deferred<void>()
  let signal: AbortSignal | undefined
  let error: unknown
  const executor = new DefinedAgentA2AExecutor({ agent, taskTimeoutMs: 10,
    createSession(_context, current) {
      signal = current
      current!.addEventListener('abort', event => event.stopImmediatePropagation())
      entered.resolve()
      return creation.promise
    }, onError(value) { error = value } })
  const { bus, states } = eventBus()
  const run = executor.execute(requestContext(), bus)
  try {
    await entered.promise
    await vi.advanceTimersByTimeAsync(10)
    expect(signal?.reason).toMatchObject({ name: 'TimeoutError' })
    expect(states).toContain(TaskState.TASK_STATE_FAILED)
    expect(error).toBe(signal?.reason)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    creation.resolve({ run: async () => response } as unknown as AgentSession)
    await run
    await executor.dispose()
  }
})

it.each(['cancel', 'dispose'] as const)('preserves %s during an uncooperative session run', async action => {
  vi.useFakeTimers()
  const work = deferred<typeof response>()
  const entered = deferred<void>()
  let signal: AbortSignal | undefined
  const session = { run(_input: unknown, options: { signal: AbortSignal }) {
    signal = options.signal
    signal.addEventListener('abort', event => event.stopImmediatePropagation())
    entered.resolve()
    return work.promise
  } } as unknown as AgentSession
  const executor = new DefinedAgentA2AExecutor({ agent, createSession: () => session, taskTimeoutMs: 100 })
  const { bus, states } = eventBus()
  let settled = false
  const run = executor.execute(requestContext(), bus).then(() => { settled = true })
  const reason = new Error('host disposed')
  let disposal: Promise<void> | undefined
  try {
    await entered.promise
    if (action === 'cancel') await executor.cancelTask('task', bus)
    else disposal = executor.dispose(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    expect(signal?.aborted).toBe(true)
    if (action === 'dispose') expect(signal?.reason).toBe(reason)
    else expect(signal?.reason.message).toBe("A2A task 'task' was canceled")
    expect(states).toContain(TaskState.TASK_STATE_CANCELED)
    expect(states).not.toContain(TaskState.TASK_STATE_FAILED)
    expect(vi.getTimerCount()).toBe(0)
    await disposal
  } finally {
    work.resolve(response)
    await run
    await executor.dispose()
  }
})
