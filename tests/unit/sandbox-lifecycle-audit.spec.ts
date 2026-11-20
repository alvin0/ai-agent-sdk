import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { openConfinedWrite } from '../../packages/sandbox-node/src/open.ts'
import { superviseConfined } from '../../packages/sandbox-node/src/supervise.ts'
import type { FsFence, PathResolver } from '@alvin0/ai-agent-sdk-sandbox'

const handles = vi.hoisted(() => ({ close: vi.fn(async () => {}) }))
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  open: vi.fn(async () => handles),
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('closes an opened descriptor when post-open path resolution fails', async () => {
  const failure = new Error('resolver I/O failed')
  const resolver = {
    realpath: vi.fn().mockResolvedValueOnce('/workspace').mockRejectedValueOnce(failure),
  } as unknown as PathResolver
  const fence = {
    assertWritable: vi.fn(async () => {}), writableRoots: ['/workspace'],
  } as unknown as FsFence
  await expect(openConfinedWrite(fence, '/workspace/notes.txt', { resolver })).rejects.toBe(failure)
  expect(handles.close).toHaveBeenCalledOnce()
})

function childFixture(exitCode: number | null = null): ChildProcess {
  return Object.assign(new EventEmitter(), { exitCode, signalCode: null, pid: 123 }) as unknown as ChildProcess
}

it('settles and releases all monitoring resources when watching is stopped', async () => {
  vi.useFakeTimers()
  const child = childFixture()
  const supervision = superviseConfined(child, { wallClockMs: 10_000 })
  expect(vi.getTimerCount()).toBe(1)
  supervision.stop()
  supervision.stop()
  await expect(supervision.done).resolves.toMatchObject({ terminated: false })
  expect(child.listenerCount('exit')).toBe(0)
  expect(child.listenerCount('close')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('settles immediately for an execution that has already exited', async () => {
  const child = childFixture(0)
  await expect(superviseConfined(child).done).resolves.toMatchObject({ terminated: false })
  expect(child.listenerCount('exit')).toBe(0)
  expect(child.listenerCount('close')).toBe(0)
})

it('settles on process close when an exit event was unavailable', async () => {
  const child = childFixture()
  const supervision = superviseConfined(child)
  child.emit('close', -1, null)
  await expect(supervision.done).resolves.toMatchObject({ terminated: false })
  expect(child.listenerCount('exit')).toBe(0)
  expect(child.listenerCount('close')).toBe(0)
})
