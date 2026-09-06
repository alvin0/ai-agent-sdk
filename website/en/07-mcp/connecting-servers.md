# Connecting Servers

## Connect

```ts
import { connectMcpHttp } from '@ai-agent-sdk/mcp/client'

const mcp = await connectMcpHttp({
  serverName: 'billing',
  url: 'https://tools.example.com/mcp',
  headers: { authorization: `Bearer ${token}` },
  toolFilter: { allow: ['lookup_invoice', 'refund_preview'] },
  logger: runtime.logger({ fields: { integration: 'mcp-http' } }),
})
```

`connectMcpHttp()` negotiates, discovers tools, and returns a ready connection.
`createMcpHttpClient()` builds one **without** connecting, for applications that
control startup themselves:

```ts
const mcp = createMcpHttpClient({
  serverName: 'optional_search',
  url: 'https://search.example.com/mcp',
  reconnect: { maxAttempts: 4 },
  onStateChange: state => updateHealthUi(state),
})

await mcp.connect()   // rejects the initial failure; background reconnect follows policy
```

## Connection semantics

The connection owns **one live generation at a time**. It:

- negotiates the modern MCP era with legacy fallback;
- publishes tools **only** after a successful handshake **and** `tools/list`;
- listens for tool-list changes;
- swaps only a **fully fetched** snapshot;
- retains the last-known-good catalog when a refresh fails.

Unexpected disconnects use **bounded exponential reconnect**. `close()` cancels
reconnect, quiesces pending discovery, closes the transport, and unregisters the
tools.

## Negotiation and transport are separate layers

```ts
protocol: 'auto'     // default: probe modern, fall back to legacy `initialize`
protocol: 'modern'   // pin
protocol: 'legacy'   // pin
```

HTTP connections use **Streamable HTTP** first. If startup fails for a reason
unrelated to authentication, authorization scope, or cancellation, the SDK
creates a fresh protocol client and tries the deprecated **SSE** transport
**once**.

```ts
// A distinct legacy endpoint:
createMcpHttpClient({ serverName: 'inventory', url, legacySse: { url: `${base}/sse` } })

// Or refuse the fallback entirely:
createMcpHttpClient({ serverName: 'inventory', url, legacySse: false })
```

SSE is only a migration path for older servers. New MCP deployments should use
Streamable HTTP.

### Legacy deployments stay visible

```ts
mcp.state.protocol   // { era, version, transport, fallback }
```

`state.protocol` exposes the negotiated era, the **exact** version, the selected
transport, and whether transport fallback occurred. That is deliberate: a legacy
deployment should be visible in a health UI, not silently hidden.

## OAuth 2.1

Pass the MCP SDK's `OAuthClientProvider` through `transport.authProvider`.

```ts
import { UnauthorizedError } from '@modelcontextprotocol/client'

const mcp = createMcpHttpClient({
  serverName: 'github',
  url: 'https://api.githubcopilot.com/mcp/',
  reconnect: false,
  transport: { authProvider: oauthProvider },
})

try {
  await mcp.connect()
} catch (error) {
  if (!(error instanceof UnauthorizedError)) throw error
  // redirectToAuthorization() has already handed the URL to your browser/UI.
  const callbackParams = await receiveOAuthCallback()
  await mcp.finishOAuth(callbackParams, { expectedState: stateStoredByHost })
}
```

`finishOAuth()`:

- compares `state` **before** token exchange;
- passes the complete callback query to the protocol SDK so RFC 9207 `iss`
  validation stays active;
- does **not** render attacker-controlled callback error text;
- closes the authorization generation;
- reconnects on a **fresh** transport.

The host owns browser/UI, callback routing, client registration, and secure
credential storage. None of those Node-specific policies are forced into the
web-standard client entry.

### Four states, four different UIs

Treating every `401` as OAuth is the classic mistake here.

| State | Meaning | Host action |
| --- | --- | --- |
| `authentication-required` | No recognized credential provider was configured | Ask for credentials or configure auth |
| `authentication-failed` | A bearer/API token was supplied but rejected | Replace or refresh the token |
| `oauth-authorization-required` | OAuth needs an interactive authorization code | Complete the redirect, then `finishOAuth()` |
| `scope-authorization-required` | The server returned an insufficient-scope challenge | Request consent for `authorization.requiredScope` |

With an OAuth provider, Streamable HTTP performs **bounded scope step-up** by
default. Set `transport.onInsufficientScope: 'throw'` to gate that consent behind
your own UI; the connection then exposes `scope-authorization-required`.
Bearer-only providers cannot perform OAuth step-up and produce that state
directly.

## Endpoint policy is secure by default and host-refined

The client requires HTTPS, rejects private/local host literals, and rejects
redirects by default. Add a trusted origin allowlist and deployment controls for
**your** trust boundary:

```ts
createMcpHttpClient({
  serverName: 'billing',
  url,
  allowedOrigins: ['https://tools.example.com'],
  requireHttps: true,
  allowPrivateNetwork: false,
  closeTimeoutMs: 10_000,
  // plus response / catalog / result bounds and operation deadlines
})
```

HTTP clients can restrict origins, require HTTPS, reject private/local endpoint
literals and redirects, and cap raw transport bytes. For tenant-controlled URLs,
use the awaited `validateEndpoint` hook with DNS resolution and a custom fetch
that pins the validated address, or enforce equivalent outbound network policy.

## Node stdio

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/mcp @ai-agent-sdk/mcp-node
```

```ts
import { connectMcpStdio, createMcpStdioClient } from '@ai-agent-sdk/mcp-node'

const local = await connectMcpStdio({
  serverName: 'filesystem',
  command: process.execPath,
  args: ['path/to/server.js'],
  logger: runtime.logger({ fields: { integration: 'mcp-stdio' } }),
})
```

`createMcpStdioClient()` constructs a supervised client **without spawning the
child yet**. `connectMcpStdio()` spawns, negotiates, discovers, and returns a
ready client — and on failure closes with a report and throws
`McpConnectionError` carrying it.

## Deadlines and uncooperative servers

Raw operations receive the connection's deadline signal. If one **ignores** that
signal, the timed-out client generation is removed from the live catalog, closed
within `closeTimeoutMs`, and reconnected only according to the configured policy.

That containment is why one hung server cannot wedge your agent: the generation
is abandoned, not awaited forever.

## Closing

```ts
try {
  await runtime.close()
} finally {
  const report = await mcp.closeWithReport()
  if (report.unsettledRequests > 0) console.warn('MCP left work unsettled', report)
}
```

Always inspect the close report. Transport shutdown and runtime shutdown are
**independent evidence**.

## Read next

- [Using MCP Tools](/en/07-mcp/using-mcp-tools)
- [MCP Client](/en/07-mcp/mcp-client) — the full option list
- [Security](/en/10-advanced/security)
