import type { JsonObject } from '../../primitives/index.ts'
import type { ObservationEvent, OperationStatus } from '../../observation/index.ts'
import { boundedText, objectValue, ownData } from '../common/data.ts'
import { RUNTIME_LOG_LIMITS } from './config.ts'

const KINDS = new Set(['logical-start', 'attempt-start', 'attempt-terminal', 'logical-terminal'])
const STATUSES = new Set<OperationStatus>(['success', 'error', 'aborted', 'rejected', 'unknown'])

/** False is an ordinary log. A present integration marker is validated or rejected, never silently downgraded. */
export function validateIntegrationEvidence(fields: Readonly<JsonObject>): boolean {
  const marker = Object.getOwnPropertyDescriptor(fields, 'integrationSchemaVersion')
  if (marker === undefined) return false
  if (!('value' in marker) || marker.value !== 1) throw new TypeError('Invalid integration evidence')
  try {
    const source = objectValue(fields)
    boundedText(ownData(source, 'integrationFamily'), 64)
    boundedText(ownData(source, 'integrationOperation'), 64)
    boundedText(ownData(source, 'operationId'), RUNTIME_LOG_LIMITS.identityBytes)
    const kind = ownData(source, 'kind')
    if (!KINDS.has(kind as string)) throw new TypeError('Invalid integration evidence')
    if (kind === 'attempt-start' || kind === 'attempt-terminal') {
      boundedText(ownData(source, 'attemptId'), RUNTIME_LOG_LIMITS.identityBytes)
      const attempt = ownData(source, 'attemptNumber')
      if (!Number.isSafeInteger(attempt) || Number(attempt) < 1) throw new TypeError('Invalid integration evidence')
    }
    if (kind === 'attempt-terminal' || kind === 'logical-terminal') {
      if (!STATUSES.has(ownData(source, 'status') as OperationStatus)) throw new TypeError('Invalid integration evidence')
      const duration = ownData(source, 'durationMs')
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) throw new TypeError('Invalid integration evidence')
      const code = ownData(source, 'errorCode', false)
      if (code !== undefined) boundedText(code, RUNTIME_LOG_LIMITS.identityBytes)
    }
    return true
  } catch { throw new TypeError('Invalid integration evidence') }
}

export function eventHasIntegrationEvidence(event: ObservationEvent): boolean {
  try {
    if (event.name !== 'sdk.log') return false
    const fields = Object.getOwnPropertyDescriptor(event.data, 'fields')
    return fields !== undefined && 'value' in fields && validateIntegrationEvidence(fields.value as Readonly<JsonObject>)
  } catch { return false }
}
