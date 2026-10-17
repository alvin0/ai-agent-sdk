/** Internal limits shared by preferred and advanced Universal MCP servers. */
export const MCP_SERVER_DEFAULTS = Object.freeze({
  maxExports: 1_024,
  maxDefinitionBytes: 4 * 1024 * 1024,
  maxInputBytes: 1024 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  // Largest delay a timer honors: no practical deadline unless the host opts in to one.
  operationTimeoutMs: 2_147_483_647,
  teardownTimeoutMs: 30_000,
  observerTimeoutMs: 5_000,
})
