# I5 MCP capability evidence

Status: capability ownership and lifecycle contracts implemented and verified.

## Package/runtime separation

| Package | Runtime | Public responsibility |
| --- | --- | --- |
| `@ai-agent-sdk/mcp` | Universal | remote Streamable HTTP/SSE client and versioned `ToolSource` |
| `@ai-agent-sdk/mcp-server` | Universal | inert `Request`/`Response` server definition |
| `@ai-agent-sdk/mcp-node` | Node | stdio client transport |
| `@ai-agent-sdk/mcp-node-server` | Node | stdio and `node:http` server hosting |

All four packed fixtures install their own release closure. The two Universal
packages execute without `Buffer` or `process` on standards-only Node,
Chromium, and workerd; the Node packages execute real child-process stdio
round trips.

## Client and ToolSource lifecycle

- `McpClientConnection` directly carries `kind: 'tool-source'`, `apiVersion: 1`,
  stable ID, synchronous revisioned `snapshot()`, and bounded detached tool
  definitions.
- Connection refresh swaps a validated catalog atomically and increments its
  revision. A failed refresh leaves the prior catalog intact. A refresh during a
  run appears only in the next invocation snapshot.
- Reconnect, negotiated protocol/fallback state, OAuth callback state,
  authentication/scope state, operation deadlines, catalog/result/transport
  limits, and the raw resource/prompt client remain on the dedicated MCP
  connection rather than being copied into core.
- Core treats a connected MCP source as borrowed. Construction failure and
  runtime quiescence do not close it; the caller closes it after runtime close.

## Transactional startup and close evidence

Both `connectMcpHttp()` and `connectMcpStdio()` construct, connect, and on any
startup failure run bounded `closeWithReport()` rollback before throwing
`McpConnectionError`. The error retains a support-safe primary stage/failure,
the original cause for local programmatic handling, and the independent cleanup
report. HTTP injected failure and an actual missing stdio executable are covered.

`closeWithReport()` returns one frozen, idempotent `McpCloseReport`. Successful,
rejected, caller-aborted, and deadline-exceeded cleanup are distinct; pending
operations are counted and timeout is never represented as success. The legacy
`close(): Promise<void>` delegates to that operation and remains source-compatible.

## Server ownership

`createMcpServer()` is frozen and inert and intentionally has no application
close method. Each Web request owns its protocol resources. `serveMcpStdio()` is
host-owned and exposes `close({ signal })` with a separate
`McpNodeServerCloseReport`, including deadline and unsettled-request evidence.
The packed Node fixture performs real discovery, tools/list, tools/call, process
termination, and report inspection.

## Verification

```text
@ai-agent-sdk/mcp:             23 tests passed
@ai-agent-sdk/mcp-node:         2 tests passed
@ai-agent-sdk/mcp-server:       2 tests passed
@ai-agent-sdk/mcp-node-server:  3 tests passed

pnpm exec tsc -p design-contracts/core-capability-v1/tsconfig.current-mcp-compatibility.json
passed

packed MCP runtime matrix passed
packed mcp-node Node fixture passed
packed MCP server runtime matrix passed
packed mcp-node-server Node fixture passed
```

The cross-runtime manual redirect evidence is recorded separately in
[I3-portable-no-follow.md](./I3-portable-no-follow.md).
