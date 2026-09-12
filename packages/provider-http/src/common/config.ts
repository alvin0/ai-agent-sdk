/** Runtime wire-protocol contract version supported by this package. */
export const HTTP_PROTOCOL_API_VERSION = 1 as const

/** Stable support-safe errors owned by the runtime HTTP extension path. */
export const HTTP_PROVIDER_ERROR_CODES = Object.freeze({
  PROTOCOL_API_UNSUPPORTED: 'HTTP_PROTOCOL_API_UNSUPPORTED',
  HEADER_INVALID: 'HTTP_HEADER_INVALID',
  HEADER_RESERVED: 'HTTP_HEADER_RESERVED',
  HEADER_COLLISION: 'HTTP_HEADER_COLLISION',
  WIRE_BODY_INVALID: 'HTTP_WIRE_BODY_INVALID',
  WIRE_BODY_TOO_LARGE: 'HTTP_WIRE_BODY_TOO_LARGE',
  STREAM_MEDIA_TYPE_INVALID: 'HTTP_STREAM_MEDIA_TYPE_INVALID',
  JSON_MEDIA_TYPE_INVALID: 'HTTP_JSON_MEDIA_TYPE_INVALID',
  SSE_LIMIT_EXCEEDED: 'HTTP_SSE_LIMIT_EXCEEDED',
  REDIRECT_REJECTED: 'HTTP_REDIRECT_REJECTED',
} as const)

export const HTTP_PROTOCOL_LIMITS = Object.freeze({
  idBytes: 128,
  dialectDepth: 16,
  dialectNodes: 4_096,
  dialectObjectFields: 1_024,
  dialectArrayItems: 4_096,
  dialectKeyBytes: 1_024,
  dialectBytes: 1024 * 1024,
})

/** Structural limits for detached runtime-provider configuration snapshots. */
export const HTTP_RUNTIME_OPTION_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 16_384,
  maxObjectFields: 4_096,
  maxArrayItems: 4_096,
  maxKeyBytes: 1_024,
  maxBytes: 4 * 1024 * 1024,
})

/** Bounds for a failure envelope received across a package/runtime boundary. */
export const HTTP_FOREIGN_FAILURE_LIMITS = Object.freeze({
  messageBytes: 2_048,
  codeBytes: 128,
  requestIdBytes: 1_024,
})
