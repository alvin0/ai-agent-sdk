import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ModelAdapter, ModelRegistry, type StreamChunk } from '@alvin0/ai-agent-sdk-core'

function call() {
  let calls = 0
  class Fixture extends ModelAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      calls++
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const registry = new ModelRegistry()
  registry.registerAdapter(['fixture'], new Fixture())
  const handle = registry.stream({ provider: 'fixture', model: 'fixture', messages: [] })
  return { handle, iterator: handle[Symbol.asyncIterator](), calls: () => calls }
}

describe('model call lifetime', () => {
  it('releases request messages while callers keep completed handles and iterators', () => {
    const probe = new URL(
      '../fixtures/model-call-retention.mjs', import.meta.url,
    )
    // Isolate SDK references from V8's concurrent optimizing compiler in this ownership check.
    const flags = ['--jitless', '--expose-gc', fileURLToPath(probe)]
    const output = execFileSync(process.execPath, flags, {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    })
    expect(JSON.parse(output.split('\n')[0]!)).toMatchObject({ handlesAndIteratorsKept: 1000, inputsRetained: 0 })
  })

  it('settles the report without dispatch and preserves single use', async () => {
    const { handle, iterator, calls } = call()
    await expect(iterator.return!()).resolves.toMatchObject({ done: true })
    await expect(handle.report).resolves.toMatchObject({ status: 'aborted', dispatchState: 'not-sent' })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await expect(handle[Symbol.asyncIterator]().next()).rejects.toThrow('only be iterated once')
    expect(calls()).toBe(0)
  })

  it('records an early consumer throw and propagates the error', async () => {
    const { handle, iterator, calls } = call()
    const error = new Error('consumer failed')
    await expect(iterator.throw!(error)).rejects.toBe(error)
    await expect(handle.report).resolves.toMatchObject({ status: 'error', dispatchState: 'not-sent' })
    expect(calls()).toBe(0)
  })
})
