/**
 * The pipeline-independent HTTP primitives the shared chain is built from.
 *
 * Each one exists because the obvious version of it is wrong in a way that only
 * shows up under failure: a body read without a byte bound is a memory bug waiting
 * for a hostile response, a promise raced against a signal that disposes nothing
 * leaks a socket, a redirect followed once is a credential sent somewhere the
 * caller never named, and an iterator abandoned without `return()` leaves a reader
 * locked forever.
 *
 * None of it knows anything about SSE, JSON, catalogs, or model shapes — which is
 * why it sits under the transport and not beside a pipeline.
 *
 * @module ai-agent-sdk/providers/transport/http
 */

import {
  MODEL_ERROR_CODES,
  ModelError,
  waitForSettlement,
  type ModelFailure,
  type SafeErrorRecord,
} from '@alvin0/ai-agent-sdk-core'
import { HTTP_PROVIDER_ERROR_CODES } from '../common/config.ts'
import { isSensitiveHeaderName } from '../common/header-layers.ts'

/** Bound a response body by cumulative bytes and by chunk count, whichever trips first. */
export function boundedResponseBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  maxChunks: number,
  displayName: string,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let bytes = 0
  let chunks = 0
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      chunks++
      bytes += chunk.byteLength
      if (chunks > maxChunks) {
        throw new ModelError(
          `${displayName} response exceeds the ${maxChunks}-chunk limit`,
          MODEL_ERROR_CODES.TRANSPORT,
        )
      }
      if (bytes > maxBytes) {
        throw new ModelError(
          `${displayName} response exceeds the ${maxBytes}-byte limit`,
          MODEL_ERROR_CODES.TRANSPORT,
        )
      }
      controller.enqueue(chunk)
    },
  }), signal === undefined ? undefined : { signal })
}

/** Read at most `maxBytes` of text, marking the truncation in the returned string. */
export async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await raceWithSignal(reader.read(), signal)
      if (done) break
      if (value === undefined) continue
      const remaining = maxBytes - bytes
      if (remaining <= 0) {
        await waitForSettlement(reader.cancel().catch(() => undefined), 30_000)
        return `${text}\n[error body truncated at ${maxBytes} bytes]`
      }
      const kept = value.byteLength <= remaining ? value : value.subarray(0, remaining)
      bytes += kept.byteLength
      text += decoder.decode(kept, { stream: true })
      if (kept.byteLength !== value.byteLength) {
        await waitForSettlement(reader.cancel().catch(() => undefined), 30_000)
        return `${text}${decoder.decode()}\n[error body truncated at ${maxBytes} bytes]`
      }
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

/** Reject every redirect shape exposed by Web fetch without following a second hop. */
export async function rejectProviderRedirect(response: Response, requestedUrl: string): Promise<void> {
  const redirectedStatus = response.status >= 300 && response.status < 400
  const finalUrlChanged = response.url.length > 0 && response.url !== requestedUrl
  if (response.type !== 'opaqueredirect' && response.redirected !== true
    && !redirectedStatus && !finalUrlChanged) return
  if (response.body !== null) {
    await waitForSettlement(response.body.cancel().catch(() => undefined), 30_000)
  }
  throw new ModelError(
    'provider transport rejected a redirect before following it',
    HTTP_PROVIDER_ERROR_CODES.REDIRECT_REJECTED,
    response.status === 0 ? undefined : { status: response.status },
  )
}

/** Await a promise but surrender as soon as the signal aborts. */
export async function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined)
    throw signal.reason ?? new Error('operation aborted')
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('operation aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** HTTP-specific ownership cleanup; generic Promise races must not dispose values. */
export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    if (response.body === null || response.body.locked) return
    await waitForSettlement(Promise.resolve().then(() => response.body!.cancel()), 30_000)
  } catch {
    // Cleanup rejection must not replace the original transport failure.
  }
}

/** Iterate an async source under a signal, closing the iterator when it is cut short. */
export async function* withAbortSignal<T>(
  iterable: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]()
  let exhausted = false
  try {
    while (true) {
      const next = await raceWithSignal(iterator.next(), signal)
      if (next.done === true) {
        exhausted = true
        return
      }
      yield next.value
    }
  } finally {
    if (!exhausted) {
      const close = iterator.return?.bind(iterator)
      if (close !== undefined) {
        const closing = Promise.resolve().then(async () => { await close() })
        await waitForSettlement(closing, 30_000)
      }
    }
  }
}

/** Join a base URL and a path while refusing credentials, cleartext, and origin escapes. */
export function endpointUrl(baseUrl: string, path: string, allowInsecureHttp: boolean): URL {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch (error) {
    throw new ModelError(
      'provider baseUrl is not a valid absolute URL',
      MODEL_ERROR_CODES.INVALID_REQUEST,
      { cause: error },
    )
  }
  if (base.username.length > 0 || base.password.length > 0) {
    throw new ModelError('provider baseUrl must not contain credentials', MODEL_ERROR_CODES.INVALID_REQUEST)
  }
  if (base.search.length > 0 || base.hash.length > 0) {
    throw new ModelError('provider baseUrl must not contain a query or fragment', MODEL_ERROR_CODES.INVALID_REQUEST)
  }
  if (base.protocol !== 'https:' && !(allowInsecureHttp && base.protocol === 'http:')) {
    throw new ModelError(
      'provider baseUrl must use HTTPS unless allowInsecureHttp is explicitly enabled',
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  const normalizedBase = base.href.replace(/\/+$/, '')
  let endpoint: URL
  try {
    endpoint = new URL(`${normalizedBase}${path}`)
  } catch (error) {
    throw new ModelError(
      'provider endpoint path produced an invalid URL',
      MODEL_ERROR_CODES.INVALID_REQUEST,
      { cause: error },
    )
  }
  if (endpoint.origin !== base.origin) {
    throw new ModelError(
      'provider endpoint path must remain on the configured origin',
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  return endpoint
}

/** Reduce a failure to what a support report may carry: a code, a status, no prose. */
export function safeProviderFailure(failure: ModelFailure): SafeErrorRecord {
  return Object.freeze({
    type: 'ModelError',
    message: 'provider attempt failed; inspect the stable code and request ID',
    code: failure.code,
    ...(failure.status === undefined ? {} : { status: failure.status }),
  })
}

/** Replace credential-bearing header values, by provenance and by name shape. */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  sensitiveHeaderNames: readonly string[] = [],
): Record<string, string> {
  const provenance = new Set(sensitiveHeaderNames.map(name => name.toLowerCase()))
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    provenance.has(name.toLowerCase()) || isSensitiveHeaderName(name) ? '[REDACTED]' : value,
  ]))
}

/** Local correlation id for a diagnostic record, without requiring a crypto global. */
export function requestLogId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** The one shape a caller-requested cancellation takes on the way out. */
export function abortError(displayName: string, cause: unknown): ModelError {
  return new ModelError(
    `${displayName} request aborted by caller`,
    MODEL_ERROR_CODES.ABORTED,
    { cause },
  )
}
