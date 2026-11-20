import { afterEach, expect, it, vi } from 'vitest'
import { executeMcpClosePlan } from '../../packages/mcp/src/client/close.ts'

afterEach(() => { vi.useRealTimers() })

it.each([false, true])('clears the close wait deadline while cleanup continues (already aborted %s)', async already => {
  vi.useFakeTimers()
  const caller = new AbortController()
  const cleanup = vi.fn()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  if (already) caller.abort()
  const closing = executeMcpClosePlan({
    family: 'mcp-http-client', timeoutMs: 30_000, signal: caller.signal,
    tasks: [async () => { await blocked; cleanup() }],
  })
  if (!already) caller.abort()
  await expect(closing).resolves.toMatchObject({ state: 'closed', deadlineReached: false,
    unsettledOperations: 1, error: { code: 'MCP_CLOSE_ABORTED' } })
  expect(vi.getTimerCount()).toBe(0)
  expect(cleanup).not.toHaveBeenCalled()
  release()
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
  expect(vi.getTimerCount()).toBe(0)
})
