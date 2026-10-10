import { ModelError } from '@alvin0/ai-agent-sdk-core'
import { httpErrorCode, parseErrorBody, requestIdFrom, retryAfterMs } from './errors.ts'
import { readBoundedText } from './http.ts'
import type { HttpTransportRequestInput } from './session-types.ts'

export async function httpFailure(
  response: Response,
  request: { origin: string; maxBytes: number; signal: AbortSignal },
  input: HttpTransportRequestInput,
): Promise<ModelError> {
  const { origin, maxBytes, signal } = request
  let raw = ''
  try {
    raw = await readBoundedText(response, maxBytes, signal)
  } catch {
    // A truncated error body must not replace the status, which is the more
    // reliable signal anyway.
  }
  const { message, detail } = parseErrorBody(raw)
  const delay = retryAfterMs(response.headers.get('retry-after'))
  const id = requestIdFrom(response.headers)
  return new ModelError(
    message ?? `${input.displayName} error (HTTP ${response.status}) from ${origin}`,
    (input.errorCode ?? httpErrorCode)(response.status, detail),
    {
      cause: new Error(raw.length > 0 ? raw : `HTTP ${response.status}`),
      status: response.status,
      ...delay === undefined ? {} : { providerRetryAfterMs: delay },
      ...id === undefined ? {} : { requestId: id },
    },
  )
}
