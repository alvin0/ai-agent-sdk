import type { ResolvedOptions } from './fetch-options.ts'
import { retryableStatus, retryAfterMs, backoffMs, combinedSignal, raceAbort, cancelBody,
  boundedText, validateNoRedirectResponse, ObservationProtocolError } from './fetch-transport.ts'

interface BatchSendResult { readonly accepted: boolean; readonly retryable: boolean }
interface Batch { id: string; count: number; value: unknown }
type AttemptResult = { result: BatchSendResult } | { retryDelay: number }

async function successfulResponse(response: Response, options: ResolvedOptions, batchId: string, signal: AbortSignal)
  : Promise<BatchSendResult> {
  if (response.status === 204) {
    await cancelBody(response)
    return Object.freeze({ accepted: true, retryable: false })
  }
  const raw = await boundedText(response, options, signal)
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { parsed = undefined }
  const acceptedBatchId = typeof parsed === 'object' && parsed !== null
    ? Reflect.get(parsed, 'acceptedBatchId') : undefined
  return Object.freeze({ accepted: acceptedBatchId === batchId, retryable: false })
}

async function responseResult(response: Response, options: ResolvedOptions,
  batchId: string, control: { attempt: number; signal: AbortSignal }): Promise<AttemptResult> {
  await validateNoRedirectResponse(response, options.endpoint)
  if (response.status >= 200 && response.status < 300) {
    return { result: await successfulResponse(response, options, batchId, control.signal) }
  }
  const retryable = retryableStatus(response.status)
  const retryAfter = retryAfterMs(response.headers.get('retry-after'), options.now())
  await cancelBody(response)
  if (!retryable || control.attempt === options.maxAttempts) {
    return { result: Object.freeze({ accepted: false, retryable }) }
  }
  return { retryDelay: retryAfter ?? backoffMs(control.attempt, options) }
}

function failedAttempt(error: unknown, options: ResolvedOptions, attempt: number, signal: AbortSignal): AttemptResult {
  if (signal.aborted) throw signal.reason ?? error
  if (error instanceof ObservationProtocolError || error instanceof RangeError) {
    return { result: Object.freeze({ accepted: false, retryable: false }) }
  }
  if (attempt === options.maxAttempts) return { result: Object.freeze({ accepted: false, retryable: true }) }
  return { retryDelay: backoffMs(attempt, options) }
}

async function sendAttempt(options: ResolvedOptions, batchId: string, body: string,
  control: { attempt: number; signal: AbortSignal }): Promise<AttemptResult> {
  const request = combinedSignal(control.signal, options.requestTimeoutMs)
  // Native Window/Worker fetch must be invoked as a standalone callable.
  const dispatch = options.fetch
  try {
    const response = await raceAbort(Promise.resolve(dispatch(options.endpoint, {
      method: 'POST', headers: { ...options.headers, 'content-type': 'application/json', 'idempotency-key': batchId },
      body, redirect: 'manual', signal: request.signal,
    })), request.signal)
    return await responseResult(response, options, batchId, { attempt: control.attempt, signal: request.signal })
  } catch (error) {
    return failedAttempt(error, options, control.attempt, control.signal)
  } finally { request.clear() }
}

export async function sendBatch(options: ResolvedOptions, batch: Batch, signal: AbortSignal): Promise<BatchSendResult> {
  if (batch.count > options.maxBatchEvents) return Object.freeze({ accepted: false, retryable: false })
  const body = JSON.stringify(batch.value)
  if (new TextEncoder().encode(body).byteLength > options.maxBatchBytes) {
    return Object.freeze({ accepted: false, retryable: false })
  }
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    if (signal.aborted) throw signal.reason ?? new Error('observation export aborted')
    const outcome = await sendAttempt(options, batch.id, body, { attempt, signal })
    if ('result' in outcome) return outcome.result
    await raceAbort(Promise.resolve(options.delay(outcome.retryDelay, signal)), signal)
  }
  return Object.freeze({ accepted: false, retryable: true })
}
