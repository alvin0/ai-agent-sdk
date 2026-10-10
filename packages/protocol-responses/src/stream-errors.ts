import { CONTEXT_WINDOW_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE } from '@alvin0/ai-agent-sdk-core'
import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import type { WireResponse } from './wire.ts'

const TERMINAL_ERROR_CODES: Readonly<Record<string, string>> = Object.freeze({
  context_length_exceeded: CONTEXT_WINDOW_EXCEEDED_CODE,
  insufficient_quota: QUOTA_EXCEEDED_CODE,
  invalid_prompt: MODEL_ERROR_CODES.INVALID_REQUEST,
  bio_policy: MODEL_ERROR_CODES.INVALID_REQUEST,
  cyber_policy: MODEL_ERROR_CODES.INVALID_REQUEST,
  misalignment_policy_violation: MODEL_ERROR_CODES.INVALID_REQUEST,
  rate_limit_exceeded: MODEL_ERROR_CODES.RATE_LIMIT,
})


export function failedError(response: WireResponse | undefined, displayName: string): ModelError {
  const error = response?.error ?? undefined
  const code = error?.code ?? error?.type
  const message = error?.message ?? `${displayName} reported a failed response${failureContext(response, code)}`
  const mapped = code === undefined ? undefined : TERMINAL_ERROR_CODES[code]
  return new ModelError(
    message,
    // An unrecognized failure defaults to SERVER, which IS in the retryable set:
    // the request produced nothing, so repeating it is safe and often works.
    mapped ?? MODEL_ERROR_CODES.SERVER,
    {},
  )
}

function failureContext(response: WireResponse | undefined, code: string | undefined): string {
  const facts = [
    code === undefined ? 'no error detail' : `code ${code}`,
    ...typeof response?.id === 'string' && /^[\w.:-]{1,128}$/.test(response.id) ? [`response ${response.id}`] : [],
    ...typeof response?.status === 'string' && /^[\w-]{1,32}$/.test(response.status)
      ? [`status ${response.status}`] : [],
  ]
  return ` (${facts.join(', ')})`
}