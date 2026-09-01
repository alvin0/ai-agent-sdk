import { describe, expect, it, vi } from 'vitest'
import { parseSse } from '@ai-agent-sdk/provider-http'

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>, onActivity?: () => void) {
  const events = []
  for await (const event of parseSse(stream, onActivity)) events.push(event)
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
})
