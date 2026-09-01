/** The shared pipeline every provider adapter in this package runs through. */

export {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  HttpModelAdapter,
  redactHeaders,
  type HttpConnection,
  type ProviderCatalogModel,
  type ProviderRequest,
  type ProviderRequestLogger,
  type ProviderRequestLogRecord,
} from './http-adapter.ts'
export {
  httpErrorCode,
  parseErrorBody,
  requestIdFrom,
  retryAfterMs,
  type ParsedErrorBody,
} from './http-errors.ts'
