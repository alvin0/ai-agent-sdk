/**
 * Internal barrel for the shared HTTP transport layer.
 *
 * Mostly internal: the session, stream and JSON pipelines are consumed from inside
 * this package. The exception is the embedding route configuration, which the
 * embedding adapters in other packages declare against, so it is re-exported from
 * the package root as well.
 *
 * @module ai-agent-sdk/providers/transport
 */

export {
  captureTransportConnection,
  type HttpTransportConnection,
} from './connection.ts'
export {
  embeddingCatalogModelInfo,
  resolvedEmbeddingCatalogModelInfo,
  type EmbeddingCatalogModel,
  type EmbeddingHttpConnection,
} from './embedding-connection.ts'
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
