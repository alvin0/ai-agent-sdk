/**
 * Largest delay a timer honors. Used as the default tool-call and operation deadline, which means no
 * practical deadline: the MCP SDK otherwise imposes its own 60-second request default.
 */
export const MCP_NO_DEADLINE_MS = 2_147_483_647

/** Internal defaults shared by MCP client lifecycle, HTTP policy, and reconnect code. */
export const MCP_CLIENT_DEFAULTS = Object.freeze({
  // Opt-in: a long remote tool call (or its HTTP/SSE response) is never cut by default.
  toolCallTimeoutMs: MCP_NO_DEADLINE_MS,
  operationTimeoutMs: MCP_NO_DEADLINE_MS,
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
