import { describe, expect, it, vi } from 'vitest'
import { HttpCatalog } from '../../packages/provider-http/src/configurable/catalog.ts'
import type { ModelDiscoveryContext } from '../../packages/provider-http/src/index.ts'

function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function catalog(discoverModels: (context: ModelDiscoveryContext) => Promise<readonly { id: string }[]>) {
  return new HttpCatalog({ discoverModels } as never)
}

const op = (signal?: AbortSignal) => ({ signal, context: undefined })

describe('HttpCatalog single-flight discovery', () => {
  it('shares one discovery between concurrent cold callers', async () => {
    const pending = gate<readonly { id: string }[]>()
    const discover = vi.fn(() => pending.promise)
    const subject = catalog(discover)
    const calls = Array.from({ length: 8 }, () => subject.resolve('p', 'https://example.test', {}, op()))
    pending.resolve([{ id: 'model-a' }])
    const results = await Promise.all(calls)
    expect(discover).toHaveBeenCalledOnce()
    for (const models of results) expect(models.map(model => model.id)).toEqual(['model-a'])
    // The memoized result serves later callers without another request.
    await subject.resolve('p', 'https://example.test', {}, op())
    expect(discover).toHaveBeenCalledOnce()
  })

  it('lets a follower take over when the leader is cancelled, without recording a failure', async () => {
    const discover = vi.fn((context: ModelDiscoveryContext) => new Promise<readonly { id: string }[]>((resolve, reject) => {
      if (context.signal === undefined) { resolve([{ id: 'model-b' }]); return }
      context.signal.addEventListener('abort', () => reject(context.signal!.reason), { once: true })
    }))
    const subject = catalog(discover)
    const leader = new AbortController()
    const first = subject.resolve('p', 'https://example.test', {}, op(leader.signal))
    const second = subject.resolve('p', 'https://example.test', {}, op())
    leader.abort(new Error('caller cancelled'))
    await expect(first).rejects.toThrow('caller cancelled')
    expect((await second).map(model => model.id)).toEqual(['model-b'])
    expect(discover).toHaveBeenCalledTimes(2)
    expect(subject.failed).toBe(false)
  })

  it('rejects only the follower whose own signal aborts', async () => {
    const pending = gate<readonly { id: string }[]>()
    const subject = catalog(vi.fn(() => pending.promise))
    const leader = subject.resolve('p', 'https://example.test', {}, op())
    const controller = new AbortController()
    const follower = subject.resolve('p', 'https://example.test', {}, op(controller.signal))
    controller.abort(new Error('follower cancelled'))
    await expect(follower).rejects.toThrow('follower cancelled')
    pending.resolve([{ id: 'model-c' }])
    expect((await leader).map(model => model.id)).toEqual(['model-c'])
  })
})
