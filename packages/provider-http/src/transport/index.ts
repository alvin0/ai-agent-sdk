/**
 * Internal barrel for the shared HTTP transport layer.
 *
 * Not re-exported from the package root yet: nothing outside this package consumes
 * the transport directly. The JSON pipeline (`transportJson`) lives here and will be
 * reached through this barrel once the embedding adapters land.
 *
 * @module ai-agent-sdk/providers/transport
 */

export {
  captureTransportConnection,
  type HttpTransportConnection,
} from './connection.ts'
export {
  httpErrorCode,
  parseErrorBody,
  requestIdFrom,
  retryAfterMs,
  type ParsedErrorBody,
} from './errors.ts'
export {
  abortError,
  boundedResponseBody,
  cancelResponseBody,
  endpointUrl,
  raceWithSignal,
  readBoundedText,
  redactHeaders,
  rejectProviderRedirect,
  requestLogId,
  safeProviderFailure,
  withAbortSignal,
} from './http.ts'
export {
  DEFAULT_MAX_ERROR_BODY_BYTES,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_RESPONSE_CHUNKS,
  DEFAULT_REQUEST_LOGGER_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  positiveFinite,
  positiveInteger,
  resolveTransportLimits,
  type ResolvedTransportLimits,
} from './limits.ts'
export {
  isJsonMediaType,
  transportJson,
  JSON_MEDIA_TYPES,
} from './json.ts'
export {
  withTransportSession,
  type HttpTransportRequestInput,
  type HttpTransportSession,
  type PreparedWireBody,
  type TransportAttemptStatus,
  type WireBodySource,
  type WireRequestRecord,
} from './session.ts'
export { transportStream } from './stream.ts'
