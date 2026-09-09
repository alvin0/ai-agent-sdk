import { describe, expect, it, vi } from 'vitest'
import { ModelError } from '@alvin0/ai-agent-sdk-core'
import { parseSse } from '@alvin0/ai-agent-sdk-provider-http'

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
  teardownTimeoutMs?: number,
) {
  const events = []
  for await (const event of parseSse(stream, onActivity, teardownTimeoutMs)) events.push(event)
  return events
}

describe('parseSse', () => {
  it('reassembles split UTF-8, CRLF framing, BOM, named events, and multiline data', async () => {
    const encoded = new TextEncoder().encode('\uFEFFevent: delta\r\ndata: xin\r\ndata: chào 👋\r\n\r\n')
    const chunks = [
      encoded.subarray(0, 7),
      encoded.subarray(7, encoded.length - 3),
      encoded.subarray(encoded.length - 3),
    ]
    await expect(collect(byteStream(chunks))).resolves.toEqual([
      { event: 'delta', data: 'xin\nchào 👋' },
    ])
  })

  it('uses WHATWG replacement semantics for malformed and split UTF-8', async () => {
    const prefix = new TextEncoder().encode('data: ')
    const suffix = new TextEncoder().encode('\n\n')
    const chunks = [
      new Uint8Array([...prefix, 0xf0, 0x9f]),
      new Uint8Array([0x41, 0x80, ...suffix]),
    ]
    await expect(collect(byteStream(chunks))).resolves.toEqual([
      { event: undefined, data: '\uFFFDA\uFFFD' },
    ])
  })

  it('accepts CR, LF, IDs, empty data and ignores retry as transport policy', async () => {
    const bytes = new TextEncoder().encode([
      'retry: 1\r',
      'id: opaque\r',
      'data:\r',
      '\r',
      'data: next\n',
      '\n',
    ].join(''))
    await expect(collect(byteStream([bytes]))).resolves.toEqual([
      { event: undefined, data: '' },
      { event: undefined, data: 'next' },
    ])
  })

  it('counts comments as activity without exposing them as protocol events', async () => {
    const activity = vi.fn()
    const bytes = new TextEncoder().encode(': keepalive\n\ndata: value\n\n')
    await expect(collect(byteStream([bytes]), activity)).resolves.toEqual([
      { event: undefined, data: 'value' },
    ])
    expect(activity).toHaveBeenCalledTimes(2)
  })

  it('does not dispatch an unterminated event tail at EOF', async () => {
    const bytes = new TextEncoder().encode('data: truncated')
    await expect(collect(byteStream([bytes]))).resolves.toEqual([])
  })

  it('rejects an event that exceeds the bounded parser buffer', async () => {
    const bytes = new TextEncoder().encode(`data: ${'x'.repeat(1_048_577)}`)
    await expect(collect(byteStream([bytes]))).rejects.toThrow(/buffer/i)
  })

  it('preserves a primary parser-path failure when body cancellation also fails', async () => {
    const bytes = new TextEncoder().encode('data: value\n\n')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes) },
      cancel() { return Promise.reject(new Error('secondary cancellation failure')) },
    })
    await expect(collect(stream, () => {
      throw new ModelError('primary parser failure', 'PRIMARY_PARSER_FAILURE')
    }, 10)).rejects.toMatchObject({ code: 'PRIMARY_PARSER_FAILURE' })
  })

  it('bounds a hanging body cancellation without replacing the primary failure', async () => {
    const bytes = new TextEncoder().encode('data: value\n\n')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes) },
      cancel() { return new Promise<void>(() => {}) },
    })
    const startedAt = Date.now()
    await expect(collect(stream, () => {
      throw new ModelError('primary parser failure', 'PRIMARY_PARSER_FAILURE')
    }, 10)).rejects.toMatchObject({ code: 'PRIMARY_PARSER_FAILURE' })
    expect(Date.now() - startedAt).toBeLessThan(250)
  })
})
