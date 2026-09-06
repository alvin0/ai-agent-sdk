# MCP Client

Four packages. Client and server are separate, and Node transports are separate
again, so a web/workflow user never inherits CLI dependencies.

| Package | Runtime | Role |
| --- | --- | --- |
| `@ai-agent-sdk/mcp` | Universal | HTTP client + `ToolSource` |
| `@ai-agent-sdk/mcp-server` | Universal | Inert `Request`/`Response` server |
| `@ai-agent-sdk/mcp-node` | Node | stdio client transport |
| `@ai-agent-sdk/mcp-node-server` | Node | stdio / `node:http` server hosting |

---

## `@ai-agent-sdk/mcp`

Runtime: **Universal**. Entrypoints: `.`, `./client`, `./server`.
Composition: `runtime-agent.toolSources`. Lifecycle: `connected-caller-owned`.

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/mcp
```

```ts
export class McpClientConnection implements ToolSource { … }
export function createMcpHttpClient(options: McpHttpClientOptions): McpClientConnection
export function connectMcpHttp(options: McpHttpClientOptions): Promise<McpClientConnection>
export { McpConnectionError }
export type { McpCloseReport }
```

### Key options

| Option | Purpose |
| --- | --- |
| `serverName` | Namespace for prefixed tool names. |
| `url` | Streamable HTTP endpoint. |
| `headers` | Static request headers. |
| `toolFilter` | `{ allow: [...] }` / `{ deny: [...] }`. |
| `prefixToolNames` | `false` only when the host guarantees a unique namespace. |
| `protocol` | `'auto'` (default) / `'modern'` / `'legacy'`. |
| `legacySse` | `{ url }` for a distinct SSE endpoint, or `false` to disable fallback. |
| `reconnect` | `{ maxAttempts }`, or `false`. |
| `transport.authProvider` | An MCP SDK `OAuthClientProvider`. |
| `transport.onInsufficientScope` | `'throw'` to gate consent behind your UI. |
| `allowedOrigins`, `requireHttps`, `allowPrivateNetwork`, `allowRedirects`, `validateEndpoint` | Endpoint policy; HTTPS/public/no-redirect defaults, with a final validator receiving the operation deadline signal. |
| `closeTimeoutMs` | Bound on transport shutdown. |
| `logger` | Pass `runtime.logger({ fields: … })`. |
| `onStateChange` | Health/debug UI hook. |

### Connection surface

`operationTimeoutMs`, `toolCallTimeoutMs`, `closeTimeoutMs`, and reconnect
`initialDelayMs` / `maxDelayMs` must be integer milliseconds from `1` through
`2147483647`. Values outside this range are rejected before timers are scheduled;
byte and count limits are validated separately.

```ts
connection.state                 // status + negotiated protocol era/version/transport/fallback
connection.connect()             // rejects the initial failure
connection.finishOAuth(params, { expectedState })
connection.withClient((client, signal) => …)   // raw resources/prompts
connection.closeWithReport()     // McpCloseReport
```

---

## `@ai-agent-sdk/mcp-server`

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, Node).
Composition: `host.mcp-server`. Lifecycle: `inert-host-mounted`.

```ts
export { createMcpServer, type McpServerDefinition, type McpWebServer }
export * from './server/advanced.ts'   // createSdkMcpServer, SdkMcpServerOptions, …
```

`createMcpServer()` returns an inert `Request`/`Response` host surface. The
application owns authentication and mounting; **each request owns its protocol
resources**, so the returned server has no fabricated application cleanup handle.

The `@ai-agent-sdk/mcp/server` route exposes `createSdkMcpHandler()` for the same
purpose from the MCP package.

---

## `@ai-agent-sdk/mcp-node`

Runtime: **Node 22.12+**. Composition: `runtime-agent.toolSources`.
Lifecycle: `connected-caller-owned`.

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/mcp @ai-agent-sdk/mcp-node
```

```ts
export interface McpStdioConnection extends McpClientConnection {}
export interface McpStdioClientOptions extends McpClientLifecycleOptions, StdioServerParameters {}

export function createMcpStdioClient(options: McpStdioClientOptions): McpStdioConnection
export function connectMcpStdio(options: McpStdioClientOptions): Promise<McpStdioConnection>
export { McpConnectionError }
export type { McpCloseReport }
```

`createMcpStdioClient()` constructs a supervised client **without spawning the
child yet**. `connectMcpStdio()` spawns, negotiates, discovers tools, and returns
a ready client — and on failure closes with a report and throws
`McpConnectionError` carrying it.

Stdio parameters come from the MCP SDK: `command`, `args`, `env`, `stderr`,
`cwd`, `maxBufferSize`.

---

## `@ai-agent-sdk/mcp-node-server`

Runtime: **Node 22.12+**. Composition: `host.mcp-server`.
Lifecycle: `host-owned` — call `handle.close({ signal })` and retain the
deadline/unsettled-request evidence.

```ts
export function serveMcpStdio(
  server: McpWebServer,
  options?: { closeTimeoutMs?: number; logger?: SdkLogger },
): McpNodeServerHandle

export function serveSdkMcpStdio(
  options: SdkMcpServerOptions,
  serveOptions?: ServeStdioOptions,
): StdioServerHandle

// node:http adaptation and DNS-rebinding protection
export {
  toNodeHandler, hostHeaderValidation,
  localhostHostValidation, localhostOriginValidation, originValidation,
}
export type { NodeMcpRequestHandler, ToNodeHandlerOptions, McpNodeServerCloseReport }

// Re-exported for convenience
export { createMcpServer, type McpServerDefinition, type McpWebServer }
```

```ts
const handle = serveMcpStdio(server, { logger })
const report = await handle.close({ signal })
```

When binding a local HTTP listener, apply `localhostHostValidation()` and
`localhostOriginValidation()` — or explicit allowlists — **before** the handler,
to protect it from DNS rebinding and unwanted browser origins.

## Read next

- [Connecting Servers](/en/07-mcp/connecting-servers) — handshake, OAuth, endpoint policy
- [Using MCP Tools](/en/07-mcp/using-mcp-tools) — naming, filtering, revisions
- [MCP Server](/en/07-mcp/mcp-server) — the publishing side
