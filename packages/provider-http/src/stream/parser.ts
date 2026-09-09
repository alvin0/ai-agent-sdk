import { ModelError, waitForSettlement } from '@ai-agent-sdk/core'
import { createParser } from 'eventsource-parser'
import { HTTP_PROVIDER_ERROR_CODES } from '../common/config.ts'
import type { SseEvent } from './sse.ts'
import type { SseParserLimits } from './config.ts'

/** Internal bounded parser used by the HTTP transport. */
export async function* parseSseBounded(
  stream: ReadableStream<Uint8Array>,
  onActivity: (() => void) | undefined,
  teardownTimeoutMs: number,
  limits: SseParserLimits,
): AsyncGenerator<SseEvent> {
  const pending: SseEvent[] = []
  let emitted = 0
  const parser = createParser({
    maxBufferSize: limits.maxEventChars,
    onError(error) {
      if (error.type === 'max-buffer-size-exceeded') throw limitError('character')
    },
    onEvent(event) {
      emitted++
      if (emitted > limits.maxEvents || event.data.length > limits.maxEventChars) {
        throw limitError(emitted > limits.maxEvents ? 'event-count' : 'character')
      }
      pending.push({ event: event.event, data: event.data })
    },
    onComment() { onActivity?.() },
  })

  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let drained = false
  let primaryFailure: unknown
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined && value.byteLength > 0) onActivity?.()
      if (value !== undefined) parser.feed(decoder.decode(value, { stream: true }))
      yield* drainBatch(pending)
    }
    const tail = decoder.decode()
    if (tail.length > 0) {
      parser.feed(tail)
      yield* drainBatch(pending)
    }
    drained = true
  } catch (error: unknown) {
    primaryFailure = error
    throw error
  } finally {
    if (drained) reader.releaseLock()
    else {
      let cancellationFailure: unknown
      const cancellation = reader.cancel()
        .catch((error: unknown) => { cancellationFailure = error })
      const settled = await waitForSettlement(cancellation, teardownTimeoutMs)
      // Parser/protocol failure is the support-relevant cause. A broken body
      // cancellation path must not overwrite it with secondary teardown noise.
      if (primaryFailure === undefined) {
        if (!settled) {
          throw new Error(`SSE body ignored cancellation for more than ${teardownTimeoutMs}ms`)
        }
        if (cancellationFailure !== undefined) throw cancellationFailure
      }
    }
  }
}

/** Cursor iteration avoids repeated array compaction from Array.shift(). */
function* drainBatch(pending: SseEvent[]): Generator<SseEvent> {
  for (let index = 0; index < pending.length; index++) {
    const event = pending[index]
    if (event !== undefined) yield event
  }
  pending.length = 0
}

function limitError(kind: 'event-count' | 'character'): ModelError {
  return new ModelError(
    `provider SSE event buffer ${kind} limit exceeded`,
    HTTP_PROVIDER_ERROR_CODES.SSE_LIMIT_EXCEEDED,
  )
}
