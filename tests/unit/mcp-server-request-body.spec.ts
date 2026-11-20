import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { createMcpServer } from '../../packages/mcp-server/src/preferred/server.ts'

function request(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Request {
  return new Request('https://fixture.invalid/mcp', {
    method: 'POST', body, duplex: 'half', signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  } as RequestInit)
}

describe('preferred MCP request body ownership', () => {
  it('stops at the configured small byte allowance and cancels its reader', async () => {
    let produced = 0
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced === 8) { controller.close(); return }
        produced++
        controller.enqueue(new Uint8Array(16).fill(32))
      },
      cancel,
    }, { highWaterMark: 0 })
    const input = request(body)
    const server = createMcpServer({ id: 'small-body', maxRequestBytes: 32 })
    const response = await server.handle(input)
    expect(response.status).toBe(413)
    expect(produced).toBe(3)
    expect(cancel).toHaveBeenCalledOnce()
    expect(input.body!.locked).toBe(false)
  })

  it('reconstructs a valid fragmented request at the exact byte allowance', async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    const cancel = vi.fn()
    let offset = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === payload.byteLength) { controller.close(); return }
        const next = Math.min(offset + 7, payload.byteLength)
        controller.enqueue(payload.slice(offset, next))
        offset = next
      },
      cancel,
    })
    const input = request(body)
    const server = createMcpServer({ id: 'valid-body', maxRequestBytes: payload.byteLength })
    const response = await server.handle(input)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"tools":[]')
    expect(cancel).not.toHaveBeenCalled()
    expect(input.body!.locked).toBe(false)
  })

  it.each(['request', 'invocation'])('releases ownership when %s aborts a pending read', async mode => {
    const cancel = vi.fn()
    const controller = new AbortController()
    const input = request(new ReadableStream<Uint8Array>({ cancel }),
      mode === 'request' ? controller.signal : undefined)
    const server = createMcpServer({ id: 'abort-body', maxRequestBytes: 32 })
    const pending = server.handle(input, mode === 'invocation' ? { signal: controller.signal } : undefined)
    controller.abort(new Error('fixture request stopped'))
    await expect(pending).rejects.toThrow('fixture request stopped')
    expect(cancel).toHaveBeenCalledOnce()
    expect(input.body!.locked).toBe(false)
  })

  it.each(['Uint8Array', 'Buffer', 'cross-realm'])('copies reused %s chunks alongside empty chunks', async kind => {
    const payload = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    let shared: Uint8Array = new Uint8Array(3)
    if (kind === 'Buffer') shared = Buffer.alloc(3)
    if (kind === 'cross-realm') shared = runInNewContext('new Uint8Array(3)') as Uint8Array
    let offset = 0, empty = true
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (empty) { empty = false; controller.enqueue(new Uint8Array(0)); return }
        if (offset === payload.byteLength) { controller.close(); return }
        const length = Math.min(shared.byteLength, payload.byteLength - offset)
        shared.set(payload.subarray(offset, offset + length))
        controller.enqueue(shared.subarray(0, length))
        offset += length
        empty = true
      },
    }, { highWaterMark: 0 })
    const server = createMcpServer({ id: 'copied-body', maxRequestBytes: payload.byteLength })
    const input = request(body)
    const response = await server.handle(input)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"tools":[]')
    expect(input.body!.locked).toBe(false)
  })

  it('returns the request error response for an already consumed body', async () => {
    const input = request(new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }))
    await input.text()
    const server = createMcpServer({ id: 'consumed-body', maxRequestBytes: 32 })
    expect((await server.handle(input)).status).toBe(413)
  })
})
