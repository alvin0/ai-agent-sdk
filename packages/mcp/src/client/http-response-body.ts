import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import { raceAbort } from './runtime-helpers.ts'

export function limitedResponseBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  teardownTimeoutMs: number,
  scope: { readonly signal: AbortSignal; readonly dispose: () => void },
): ReadableStream<Uint8Array> {
  const { signal, dispose } = scope
  const reader = body.getReader()
  let received = 0
  let settled = false
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const settle = (): void => {
    if (settled) return
    settled = true
    signal.removeEventListener('abort', abort)
    dispose()
  }
  const abort = (): void => {
    if (settled) return
    const reason = signal.reason ?? new Error('MCP HTTP response body was aborted')
    settle()
    controller?.error(reason)
    void waitForSettlement(reader.cancel(reason).catch(() => undefined), teardownTimeoutMs)
  }
  const source = {
    type: undefined,
    start(value: ReadableStreamDefaultController<Uint8Array>) {
      controller = value
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    },
    async pull(value: ReadableStreamDefaultController<Uint8Array>) {
      if (settled) return
      try {
        const next = await raceAbort(reader.read(), signal)
        if (next.done) { settle(); value.close(); return }
        received += next.value.byteLength
        if (received > maxBytes) {
          const error = new Error(`MCP HTTP response exceeds the ${maxBytes}-byte limit`)
          settle()
          value.error(error)
          await waitForSettlement(reader.cancel(error).catch(() => undefined), teardownTimeoutMs)
          return
        }
        value.enqueue(next.value)
      } catch (error) {
        if (settled) return
        settle()
        value.error(error)
      }
    },
    async cancel(reason: unknown) {
      settle()
      await waitForSettlement(reader.cancel(reason).catch(() => undefined), teardownTimeoutMs)
    },
  }
  return new ReadableStream<Uint8Array>(source)
}
