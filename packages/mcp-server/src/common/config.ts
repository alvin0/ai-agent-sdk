/** Internal limits shared by preferred and advanced Universal MCP servers. */
export const MCP_SERVER_DEFAULTS = Object.freeze({
  maxExports: 1_024,
  maxDefinitionBytes: 4 * 1024 * 1024,
  maxInputBytes: 1024 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  operationTimeoutMs: 10 * 60_000,
  teardownTimeoutMs: 30_000,
  observerTimeoutMs: 5_000,
})
