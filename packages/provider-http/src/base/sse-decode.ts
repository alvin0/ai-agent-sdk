import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'
import type { TokenUsage } from '@alvin0/ai-agent-sdk-core'
import { validateUsageCounters } from '@alvin0/ai-agent-sdk-core'
import { parseSseBounded } from '../stream/parser.ts'
import type { SseEvent } from '../stream/sse.ts'
import { createStreamIdleDeadline } from '../stream/idle-deadline.ts'
import { requireTerminalFinish } from '../stream/terminal.ts'
import type { ProviderProtocolChunk } from '../stream/types.ts'
import { HTTP_PROVIDER_ERROR_CODES } from '../common/config.ts'
import type { HttpTransportSession } from '../transport/session.ts'
import { boundedResponseBody } from './transport.ts'
import { tapSseEvents, type ProviderRequest, type ResolvedSseLimits } from './http-types.ts'

interface SseDecodeOwner {
  readonly displayName: string
  translate(events: AsyncIterable<SseEvent>, request: ProviderRequest): AsyncIterable<ProviderProtocolChunk>
  emitResponseLog(request: ProviderRequest, session: HttpTransportSession, frames: readonly SseEvent[]): Promise<void>
}

export async function* decodeProviderSse(
    session: HttpTransportSession,
    request: ProviderRequest,
    sse: ResolvedSseLimits,
    owner: SseDecodeOwner,
  ): AsyncGenerator<StreamChunk> {
  const response = session.response
  assertSseResponse(response, session, owner)
  const maxResponseBytes = session.limits.maxResponseBytes
  const idleDeadline = createStreamIdleDeadline(
    request.connection.streamIdleTimeoutMs,
    owner.displayName,
    30_000,
  )
  const rawFrames: SseEvent[] = []
  const events = tapSseEvents(parseSseBounded(boundedResponseBody(
    response.body, { maxBytes: maxResponseBytes, maxChunks: session.limits.maxResponseChunks },
    owner.displayName, session.signal,
  ), idleDeadline.activity, 30_000, {
    maxEvents: sse.maxEvents,
    maxEventChars: sse.maxEventChars,
  }), rawFrames)
  const translated = requireTerminalFinish(owner.translate(events, request), owner.displayName)
  try {
    for await (const chunk of idleDeadline.guard(translated)) {
      yield* accountSseChunk(session, chunk)
    }
  } finally {
    // Fired after the consumer has already seen everything real; a slow or
    // failing sink here can no longer delay or break the call it describes.
    void owner.emitResponseLog(request, session, rawFrames)
  }
}

function assertSseResponse(
  response: Response, session: HttpTransportSession, owner: SseDecodeOwner,
): asserts response is Response & { readonly body: ReadableStream<Uint8Array> } {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== session.accept) {
    throw new ModelError(
      `${owner.displayName} response is not text/event-stream`,
      HTTP_PROVIDER_ERROR_CODES.STREAM_MEDIA_TYPE_INVALID,
    )
  }
  if (response.body === null) {
    throw new ModelError(
      `${owner.displayName} returned no response body`,
      MODEL_ERROR_CODES.STREAM_CLOSED,
    )
  }

  const maxResponseBytes = session.limits.maxResponseBytes
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && /^\d+$/.test(declaredLength)
    && Number(declaredLength) > maxResponseBytes) {
    throw new ModelError(
      `${owner.displayName} response exceeds the ${maxResponseBytes}-byte limit`,
      MODEL_ERROR_CODES.TRANSPORT,
    )
  }
}

function* accountSseChunk(
  session: HttpTransportSession, chunk: ProviderProtocolChunk,
): Generator<StreamChunk> {
  if (chunk.type === 'usage-progress') {
    session.reportUsage(chunk.usage, false)
    const validated = validateUsageCounters(chunk.usage, true)
    if (Object.keys(validated.reported).length > 0) {
      yield { type: 'usage-progress', usage: validated.reported,
        ...(session.attemptId === undefined ? {} : { attemptId: session.attemptId }) }
    }
    return
  }
  if (chunk.type === 'usage') {
    session.reportUsage(chunk.usage)
    const validated = validateUsageCounters(chunk.usage, true)
    // Partial and malformed reports remain provider-attempt evidence but
    // never escape as the SDK's exact TokenUsage contract.
    if (!validated.complete) return
    yield { type: 'usage', usage: validated.reported as TokenUsage }
    return
  }
  if (chunk.type === 'finish') {
    const status = finishStatus(chunk.reason.kind)
    session.reportOutcome(
      status,
      chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted'
        ? chunk.reason.failure
        : undefined,
    )
  }
  yield chunk
}

function finishStatus(kind: string): 'aborted' | 'error' | 'success' {
  if (kind === 'aborted') return 'aborted'
  if (kind === 'error') return 'error'
  return 'success'
}
