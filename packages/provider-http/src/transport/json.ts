/**
 * The JSON pipeline's entry into the shared transport chain.
 *
 * Where the streaming pipeline keeps a provider attempt open for as long as a
 * consumer keeps pulling, this one has a single, bounded shape: read the whole body
 * under the configured byte and chunk bounds, parse it, hand the parsed value to
 * `decode`, close the attempt. There is no framing to track and no idle deadline to
 * enforce, because there is nothing to wait for between events.
 *
 * Three failures are stated rather than inferred, since each one has a
 * plausible-looking wrong answer:
 *
 * - A response whose media type is not JSON is refused with a code of its own
 *   ({@link HTTP_PROVIDER_ERROR_CODES.JSON_MEDIA_TYPE_INVALID}), symmetric with the
 *   SSE check. Parsing an HTML error page as if it were the provider's answer is how
 *   a proxy outage becomes a mysterious schema error further up.
 * - A body past `maxResponseBytes` is a transport failure, the same as on the SSE
 *   path, and is refused instead of truncated: half a JSON document is not data.
 * - A body that is not valid JSON is a protocol failure, never something to guess
 *   at.
 *
 * What `decode` receives is a response that already cleared every guard in
 * {@link withTransportSession} — 2xx, no redirect, attempt open, teardown owned —
 * plus a parsed body. What it owns is the schema.
 *
 * @module ai-agent-sdk/providers/transport/json
 */

import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import { HTTP_PROVIDER_ERROR_CODES } from '../common/config.ts'
import { boundedResponseBody, raceWithSignal } from './http.ts'
import {
  withTransportSession,
  type HttpTransportRequestInput,
  type HttpTransportSession,
} from './session.ts'

/** Media types this pipeline accepts back from a provider. */
export const JSON_MEDIA_TYPES = Object.freeze(['application/json'] as const)

/**
 * Send one request, read its JSON body under bound, and return `decode`'s value.
 *
 * The attempt closes as soon as the value is produced; nothing here stays open for
 * a consumer, because the whole response is already in memory by then.
 * @param input - request facts captured from one connection snapshot.
 * @param decode - turns a parsed body into the pipeline's own value.
 * @returns whatever `decode` returns.
 */
export async function transportJson<T>(
  input: HttpTransportRequestInput,
  decode: (session: HttpTransportSession, body: unknown) => T | Promise<T>,
): Promise<T> {
  const decoded: { value: T }[] = []
  // `break` closes the generator, which is what runs the shared `finally`:
  // attempt accounting, consumer teardown, response-body release.
  for await (const value of withTransportSession(input, async function* (session) {
    const body = parseJsonBody(
      await readBoundedBody(session, input.displayName),
      input.displayName,
    )
    const result = await decode(session, body)
    // A value returned from `decode` is what a successful attempt looks like.
    session.reportOutcome('success')
    yield result
  })) {
    decoded.push({ value })
    break
  }
  const first = decoded[0]
  if (first === undefined) {
    throw new ModelError(
      `${input.displayName} produced no JSON response`,
      MODEL_ERROR_CODES.MALFORMED_RESPONSE,
    )
  }
  return first.value
}

/** True when a `content-type` value names one of {@link JSON_MEDIA_TYPES}. */
export function isJsonMediaType(contentType: string | null): boolean {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType === undefined) return false
  return (JSON_MEDIA_TYPES as readonly string[]).includes(mediaType)
}

/**
 * Read the whole body as text, refusing anything past the configured bounds.
 *
 * The declared `content-length` is checked first so an oversized response is
 * refused before a single byte of it is buffered; the streaming bound still applies
 * afterwards, because the header is a claim and not a guarantee.
 * @param session - the guarded response and its resolved limits.
 * @param displayName - provider name used in every message raised here.
 * @returns the exact body text.
 */
async function readBoundedBody(
  session: HttpTransportSession,
  displayName: string,
): Promise<string> {
  const response = session.response
  if (!isJsonMediaType(response.headers.get('content-type'))) {
    throw new ModelError(
      `${displayName} response is not ${JSON_MEDIA_TYPES.join(' or ')}`,
      HTTP_PROVIDER_ERROR_CODES.JSON_MEDIA_TYPE_INVALID,
    )
  }
  if (response.body === null) {
    throw new ModelError(
      `${displayName} returned no response body`,
      MODEL_ERROR_CODES.MALFORMED_RESPONSE,
    )
  }

  const maxResponseBytes = session.limits.maxResponseBytes
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && /^\d+$/.test(declaredLength)
    && Number(declaredLength) > maxResponseBytes) {
    throw new ModelError(
      `${displayName} response exceeds the ${maxResponseBytes}-byte limit`,
      MODEL_ERROR_CODES.TRANSPORT,
    )
  }

  const reader = boundedResponseBody(
    response.body,
    maxResponseBytes,
    session.limits.maxResponseChunks,
    displayName,
    session.signal,
  ).getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (true) {
      const { done, value } = await raceWithSignal(reader.read(), session.signal)
      if (done) break
      if (value === undefined) continue
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

/** Parse a body, turning a parse failure into a protocol error rather than a guess. */
function parseJsonBody(text: string, displayName: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error: unknown) {
    throw new ModelError(
      `${displayName} response body is not valid JSON`,
      MODEL_ERROR_CODES.MALFORMED_RESPONSE,
      { cause: error },
    )
  }
}
