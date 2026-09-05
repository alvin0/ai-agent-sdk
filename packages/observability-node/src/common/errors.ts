export const NODE_OBSERVATION_ERROR_CODES = Object.freeze({
  corrupt: 'OBSERVABILITY_JOURNAL_CORRUPT',
  io: 'OBSERVABILITY_JOURNAL_IO',
} as const)

export type NodeObservationErrorCode = typeof NODE_OBSERVATION_ERROR_CODES[keyof typeof NODE_OBSERVATION_ERROR_CODES]

export class NodeObservationError extends Error {
  override readonly name = 'NodeObservationError'
  readonly code: NodeObservationErrorCode

  constructor(code: NodeObservationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}
