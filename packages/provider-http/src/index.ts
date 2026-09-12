/** Universal fetch/SSE provider pipeline and configurable endpoint adapter. */

export * from './base/index.ts'
export * from './base/context-policy.ts'
export * from './configurable/http-provider.ts'
export * from './configurable/runtime-provider.ts'
export type * from './configurable/runtime-types.ts'
export * from './observation/operations.ts'
export * from './protocol/protocol.ts'
export * from './stream/sse.ts'
/** Embedding route configuration; the provider embedding adapters declare against it. */
export * from './transport/embedding-connection.ts'
/**
 * The shared transport chain and the JSON pipeline.
 *
 * Exported because the embedding adapters live in the provider packages while the
 * chain they must not re-implement lives here: a second copy of the fused-signal,
 * attempt-accounting, redirect-refusing sequence is a second chance to forget one
 * of its steps. Named exports rather than a star, so the transport's own
 * `redactHeaders`/`httpErrorCode`/`DEFAULT_*` do not collide with the identical
 * names already re-exported from `./base`.
 */
export {
  captureTransportConnection,
  type HttpTransportConnection,
} from './transport/connection.ts'
export {
  isJsonMediaType,
  transportJson,
  JSON_MEDIA_TYPES,
} from './transport/json.ts'
export type {
  HttpTransportRequestInput,
  HttpTransportSession,
  PreparedWireBody,
  WireBodySource,
} from './transport/session.ts'
export {
  resolveTransportLimits,
  type ResolvedTransportLimits,
} from './transport/limits.ts'
