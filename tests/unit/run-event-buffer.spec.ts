import { expect, it } from 'vitest'
import { ModelAdapter, ModelRegistry, type StreamChunk } from '../../packages/core/src/index.ts'
import { defineAgent } from '../../packages/core/src/agent-public.ts'
import { RunEventBuffer } from '../../packages/core/src/agent/accounting/event-buffer.ts'

it('counts queued events and bytes after previously buffered events have been consumed', async () => {
  const limitedEvents = new RunEventBuffer<number>(3, 100)
  for (const value of [0, 1, 2]) limitedEvents.push(value)
  expect(await limitedEvents.take()).toEqual({ done: false, value: 0 })
  limitedEvents.push(3)
  expect(() => limitedEvents.push(4)).toThrow(/resource limit/)
  limitedEvents.close()
  for (const value of [1, 2, 3]) expect(await limitedEvents.take()).toEqual({ done: false, value })
  expect(await limitedEvents.take()).toMatchObject({ done: true })

  const limitedBytes = new RunEventBuffer<string>(10, 6)
  limitedBytes.push('a')
  limitedBytes.push('b')
  expect(await limitedBytes.take()).toEqual({ done: false, value: 'a' })
  limitedBytes.push('c')
  expect(() => limitedBytes.push('d')).toThrow(/resource limit/)
  limitedBytes.stop()
  expect(await limitedBytes.take()).toMatchObject({ done: true })
})

it('preserves order while a large queue is consumed and refilled, then delivers its failure', async () => {
  const buffer = new RunEventBuffer<number>(4096)
  for (let value = 0; value < 4096; value++) buffer.push(value)
  for (let value = 0; value < 3072; value++) {
    expect(await buffer.take()).toEqual({ done: false, value })
  }
  for (let value = 4096; value < 7168; value++) buffer.push(value)
  expect(() => buffer.push(7168)).toThrow(/resource limit/)
  const failure = new Error('producer stopped')
  buffer.fail(failure)
  for (let value = 3072; value < 7168; value++) {
    expect(await buffer.take()).toEqual({ done: false, value })
  }
  await expect(buffer.take()).rejects.toBe(failure)
})

it('wakes a pending consumer when stopped and discards queued values', async () => {
  const buffer = new RunEventBuffer<number>()
  const waiting = buffer.take()
  buffer.stop()
  await expect(waiting).resolves.toMatchObject({ done: true })
  buffer.push(1)
  await expect(buffer.take()).resolves.toMatchObject({ done: true })
})

it('replays a completed session with a large streamed answer in the original order', async () => {
  class Fixture extends ModelAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (let index = 0; index < 16_000; index++) yield { type: 'text-delta', index: 0, text: 'x' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'x'.repeat(16_000) } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 16_000 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const registry = new ModelRegistry()
  registry.registerAdapter(['fixture'], new Fixture())
  const agent = defineAgent({ id: 'buffer', provider: 'fixture', model: 'fixture',
    instructions: 'Answer the request.', mode: 'basic', maxTurns: 1 })
  const handle = agent.createSession({ registry, compaction: false }).stream('Answer the request.')
  expect((await handle.result).text).toBe('x'.repeat(16_000))
  let answer = ''
  for await (const event of handle) if (event.type === 'text-delta') answer += event.text
  expect(answer).toBe('x'.repeat(16_000))
})
