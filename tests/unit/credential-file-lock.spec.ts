import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ open: vi.fn(), mkdir: vi.fn(), chmod: vi.fn(), lstat: vi.fn(), unlink: vi.fn(), rename: vi.fn() }))
vi.mock('node:fs/promises', () => io)
import { withCredentialFileLock } from '../../packages/auth-node/src/common/credential-file.ts'

const permissionError = () => Object.assign(new Error('delete pending or permission denied'), { code: 'EPERM' })
let close: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
  close = vi.fn().mockResolvedValue(undefined)
  io.mkdir.mockResolvedValue(undefined)
  io.open.mockResolvedValue({ close })
  io.lstat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  io.unlink.mockResolvedValue(undefined)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('credential sidecar lock contention', () => {
  it('waits for a Windows delete-pending sidecar before running the task once', async () => {
    io.open.mockRejectedValueOnce(permissionError()).mockRejectedValueOnce(permissionError())
    const task = vi.fn().mockResolvedValue('committed')
    const result = withCredentialFileLock('fixture/auth.json', undefined, task)
      .then(value => ({ value }), error => ({ error }))
    await vi.runAllTimersAsync()
    expect(await result).toEqual({ value: 'committed' })
    expect(io.open).toHaveBeenCalledTimes(3)
    expect(task).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(io.unlink).toHaveBeenCalledExactlyOnceWith('fixture/auth.json.lock')
  })

  it('surfaces persistent permission errors after a short bounded retry', async () => {
    const error = permissionError(), task = vi.fn()
    io.open.mockRejectedValue(error)
    const result = withCredentialFileLock('fixture/auth.json', undefined, task)
      .then(() => undefined, failure => failure)
    await vi.runAllTimersAsync()
    expect(await result).toBe(error)
    expect(io.open).toHaveBeenCalledTimes(4)
    expect(task).not.toHaveBeenCalled()
    expect(io.unlink).not.toHaveBeenCalled()
  })

  it('does not retry POSIX permission failures', async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }))
    const error = permissionError(), task = vi.fn()
    io.open.mockRejectedValue(error)
    await expect(withCredentialFileLock('fixture/auth.json', undefined, task)).rejects.toBe(error)
    expect(io.open).toHaveBeenCalledTimes(1)
    expect(task).not.toHaveBeenCalled()
  })

  it('still rejects symlinks before retrying a denied lock open', async () => {
    io.open.mockRejectedValueOnce(permissionError())
    io.lstat.mockResolvedValue({ isSymbolicLink: () => true })
    const task = vi.fn()
    await expect(withCredentialFileLock('fixture/auth.json', undefined, task)).rejects.toThrow(/symbolic link/)
    expect(io.open).toHaveBeenCalledTimes(1)
    expect(task).not.toHaveBeenCalled()
    expect(io.unlink).not.toHaveBeenCalled()
  })

  it('honors cancellation while waiting for a delete-pending sidecar', async () => {
    io.open.mockRejectedValueOnce(permissionError())
    const controller = new AbortController(), reason = new Error('stop waiting'), task = vi.fn()
    const result = withCredentialFileLock('fixture/auth.json', controller.signal, task)
      .then(() => undefined, failure => failure)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(reason)
    expect(await result).toBe(reason)
    expect(io.open).toHaveBeenCalledTimes(1)
    expect(task).not.toHaveBeenCalled()
  })
})
