/** Internal defaults shared by MCP client lifecycle, HTTP policy, and reconnect code. */
export const MCP_CLIENT_DEFAULTS = Object.freeze({
  toolCallTimeoutMs: 120_000,
  operationTimeoutMs: 120_000,
  closeTimeoutMs: 30_000,
  maxTools: 1_024,
  maxCatalogBytes: 4 * 1024 * 1024,
  maxToolResultBytes: 4 * 1024 * 1024,
  maxTransportBytes: 16 * 1024 * 1024,
  maxRedirectHops: 10,
})

export const MCP_RECONNECT_DEFAULTS = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

export const MCP_HTTP_REDIRECT_STATUSES: readonly number[] = Object.freeze([
  301, 302, 303, 307, 308,
])
