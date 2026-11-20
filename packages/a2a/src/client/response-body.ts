import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import type { A2AScope } from '../common/deadline.ts'

/** Transfer the request deadline to the response body until EOF, cancellation or failure. */
export function boundedA2AResponse(
  response: Response, maxBytes: number, scope: A2AScope, teardownTimeoutMs: number,
): Response {
  if (response.body === null) { scope.dispose(); return response }
  const signal = AbortSignal.any([scope.signal])
  const reader = response.body.getReader()
  let received = 0, finished = false
  let abort = (): void => undefined
  const finish = (): void => {
    if (finished) return
    finished = true
    signal.removeEventListener('abort', abort)
    scope.dispose()
    reader.releaseLock()
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        controller.error(signal.reason)
        void reader.cancel(signal.reason).catch(() => undefined)
        finish()
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    },
    async pull(controller) {
      try {
        signal.throwIfAborted()
        const next = await reader.read()
        signal.throwIfAborted()
        if (next.done) { controller.close(); finish(); return }
        received += next.value.byteLength
        if (received > maxBytes) throw new Error(`A2A HTTP response exceeds the ${maxBytes}-byte limit`)
        controller.enqueue(next.value)
      } catch (error: unknown) {
        if (finished) return
        controller.error(error)
        void reader.cancel(error).catch(() => undefined)
        finish()
      }
    },
    async cancel(reason) {
      try { await waitForSettlement(reader.cancel(reason).catch(() => undefined), teardownTimeoutMs) }
      finally { finish() }
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
