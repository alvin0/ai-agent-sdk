import { describe, expect, it } from 'vitest'
import { fetchA2AEndpoint } from '../../packages/a2a/src/client/http-redirect.ts'

function queueCallerAbort(controller: AbortController): void {
  void Promise.resolve().then(() => queueMicrotask(() => controller.abort(new Error('fixture canceled'))))
}

describe('A2A canceled fetch ownership', () => {
  it.each(['http://[', 'http://private.test/'])('cancels the body for rejected redirect %s', async location => {
    let canceled = 0, fetches = 0
    const response = new Response(new ReadableStream({ cancel() { canceled++ } }), {
      status: 302, headers: { location },
    })
    await expect(fetchA2AEndpoint(async () => { fetches++; return response },
      'https://example.test/', undefined, {
        allowRedirects: true, signal: new AbortController().signal, teardownTimeoutMs: 10,
        validateEndpoint: value => {
          const url = new URL(value)
          if (url.protocol !== 'https:') throw new TypeError('fixture rejected endpoint')
          return url
        },
      })).rejects.toThrow()
    expect(fetches).toBe(1)
    expect(canceled).toBe(1)
  })

  it('checks caller cancellation before invoking fetch', async () => {
    const controller = new AbortController()
    controller.abort(new Error('fixture canceled'))
    let fetches = 0
    await expect(fetchA2AEndpoint(async () => { fetches++; return new Response('ok') },
      'https://example.test/', undefined, {
        allowRedirects: false, signal: controller.signal, teardownTimeoutMs: 10,
        validateEndpoint: value => new URL(value),
      })).rejects.toBe(controller.signal.reason)
    expect(fetches).toBe(0)
  })

  it('cancels a response body that arrives after the caller has canceled', async () => {
    let respond!: (response: Response) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const controller = new AbortController()
    const request = fetchA2AEndpoint(async () => {
      entered()
      return new Promise<Response>(resolve => { respond = resolve })
    }, 'https://example.test/', undefined, {
      allowRedirects: false, signal: controller.signal, teardownTimeoutMs: 10,
      validateEndpoint: value => new URL(value),
    })
    await started
    controller.abort(new Error('fixture canceled'))
    await expect(request).rejects.toBe(controller.signal.reason)
    let canceled = 0
    respond(new Response(new ReadableStream({ cancel() { canceled++ } })))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(canceled).toBe(1)
  })

  it('disposes queued responses according to the actual cancellation race outcome', async () => {
    let canceled = 0
    const controller = new AbortController()
    const response = new Response(new ReadableStream({ cancel() { canceled++ } }))
    const request = fetchA2AEndpoint(async () => {
      queueCallerAbort(controller)
      return response
    }, 'https://example.test/', undefined, {
      allowRedirects: false, signal: controller.signal, teardownTimeoutMs: 10,
      validateEndpoint: value => new URL(value),
    })
    const outcome = await request.then(value => ({ response: value }), error => ({ error }))
    await new Promise<void>(resolve => setImmediate(resolve))
    if ('error' in outcome) {
      expect(outcome.error).toBe(controller.signal.reason)
      expect(canceled).toBe(1)
    } else {
      expect(outcome.response).toBe(response)
      expect(canceled).toBe(0)
      await response.body?.cancel()
    }
  })
})
