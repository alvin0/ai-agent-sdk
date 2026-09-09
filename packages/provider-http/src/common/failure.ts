import {
  MODEL_ERROR_CODES,
  ModelError,
  type ModelFailure,
  type ProviderRequestId,
} from '@alvin0/ai-agent-sdk-core'
import { HTTP_FOREIGN_FAILURE_LIMITS } from './config.ts'

const ENCODER = new TextEncoder()
const INVALID_FIELD = Symbol('invalid failure field')

type EnvelopeProbe =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly failure: ModelFailure }

/** Read an own data property without invoking getters or inherited state. */
function ownDataProbe(
  source: object,
  key: PropertyKey,
): { readonly present: boolean; readonly data: boolean; readonly value?: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor === undefined) return { present: false, data: true }
    if (!('value' in descriptor)) return { present: true, data: false }
    return { present: true, data: true, value: descriptor.value }
  } catch {
    return { present: true, data: false }
  }
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && ENCODER.encode(value).byteLength <= maxBytes
}

function optionalFailureField(source: object, key: PropertyKey): unknown {
  const field = ownDataProbe(source, key)
  return field.data ? field.value : INVALID_FIELD
}

/**
 * Validate the data twin carried by a ModelError from another core copy/realm.
 * A lone outer code is deliberately insufficient: retry policy may trust a code
 * only when the bounded inner envelope exists and agrees with it.
 */
function probeFailureEnvelope(value: unknown): EnvelopeProbe {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return { kind: 'absent' }
  }

  const outerCode = ownDataProbe(value, 'code')
  const carried = ownDataProbe(value, 'failure')
  if (!outerCode.present && !carried.present) return { kind: 'absent' }
  if (!outerCode.data || !carried.data
    || !boundedString(outerCode.value, HTTP_FOREIGN_FAILURE_LIMITS.codeBytes)
    || typeof carried.value !== 'object' || carried.value === null || Array.isArray(carried.value)) {
    return { kind: 'invalid' }
  }

  const message = optionalFailureField(carried.value, 'message')
  const code = optionalFailureField(carried.value, 'code')
  const status = optionalFailureField(carried.value, 'status')
  const providerRetryAfterMs = optionalFailureField(carried.value, 'providerRetryAfterMs')
  const requestId = optionalFailureField(carried.value, 'requestId')
  if (message === INVALID_FIELD || code === INVALID_FIELD || status === INVALID_FIELD
    || providerRetryAfterMs === INVALID_FIELD || requestId === INVALID_FIELD
    || !boundedString(message, HTTP_FOREIGN_FAILURE_LIMITS.messageBytes)
    || !boundedString(code, HTTP_FOREIGN_FAILURE_LIMITS.codeBytes)
    || code !== outerCode.value
    || (status !== undefined && (!Number.isSafeInteger(status) || (status as number) < 100 || (status as number) > 599))
    || (providerRetryAfterMs !== undefined
      && (!Number.isFinite(providerRetryAfterMs) || (providerRetryAfterMs as number) <= 0))
    || (requestId !== undefined
      && !boundedString(requestId, HTTP_FOREIGN_FAILURE_LIMITS.requestIdBytes))) {
    return { kind: 'invalid' }
  }

  return {
    kind: 'valid',
    failure: Object.freeze({
      message,
      code,
      ...status === undefined ? {} : { status: status as number },
      ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: providerRetryAfterMs as number },
      ...requestId === undefined ? {} : { requestId: requestId as ProviderRequestId },
    }),
  }
}

/** Normalize a foreign provider failure without relying on package class identity. */
export function normalizeHttpBoundaryError(value: unknown, fallbackMessage: string): ModelError {
  const envelope = probeFailureEnvelope(value)
  if (envelope.kind === 'absent') {
    return new ModelError(fallbackMessage, MODEL_ERROR_CODES.TRANSPORT, { cause: value })
  }
  if (envelope.kind === 'invalid') {
    return new ModelError(
      'provider supplied an invalid failure envelope',
      MODEL_ERROR_CODES.UNKNOWN,
      { cause: value },
    )
  }
  const failure = envelope.failure
  return new ModelError(failure.message, failure.code, {
    cause: value,
    ...failure.status === undefined ? {} : { status: failure.status },
    ...failure.providerRetryAfterMs === undefined
      ? {}
      : { providerRetryAfterMs: failure.providerRetryAfterMs },
    ...failure.requestId === undefined ? {} : { requestId: failure.requestId },
  })
}
