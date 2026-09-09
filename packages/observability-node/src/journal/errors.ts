import { NODE_OBSERVATION_ERROR_CODES, NodeObservationError } from '../common/errors.ts'

export function journalFailure(
  code: 'corrupt' | 'io',
  message: string,
  cause?: unknown,
): NodeObservationError {
  return new NodeObservationError(
    NODE_OBSERVATION_ERROR_CODES[code],
    message,
    cause === undefined ? undefined : { cause },
  )
}
