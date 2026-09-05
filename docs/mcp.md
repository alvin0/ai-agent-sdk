# MCP client and server

MCP is an optional boundary. The provider-neutral SDK does not import MCP, and
applications install only the entries they use:

```sh
pnpm add @ai-agent-sdk/core @ai-agent-sdk/mcp
```

The HTTP package owns its exact MCP protocol dependencies. Add the separate
`@ai-agent-sdk/mcp-node` capability when using stdio or a Node HTTP framework.

## Use the SDK as an MCP client

The HTTP entry is web-standard and works in a harness, server workflow, or web
runtime:

```ts
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { connectMcpHttp } from '@ai-agent-sdk/mcp/client'

const runtime = await createAgentRuntime({ providers: [modelProvider] })
let mcp: Awaited<ReturnType<typeof connectMcpHttp>> | undefined
try {
  mcp = await connectMcpHttp({
    serverName: 'billing',
    url: 'https://tools.example.com/mcp',
    headers: { authorization: `Bearer ${token}` },
    toolFilter: { allow: ['lookup_invoice', 'refund_preview'] },
    logger: runtime.logger({ fields: { integration: 'mcp-http' } }),
  })
  const agent = runtime.agent({ model, toolSources: [mcp] })
  await agent.generate('Check invoice INV-42.')
} finally {
  try {
    await runtime.close()
  } finally {
    await mcp?.closeWithReport()
  }
}
```

Remote tools are exposed as `mcp__billing__lookup_invoice` by default. The
prefix prevents collisions when several servers publish the same raw name.
`prefixToolNames: false` is available only when the host already guarantees a
unique namespace.

The connection owns one live generation at a time. It negotiates the modern MCP
era with legacy fallback, publishes tools only after a successful handshake and
`tools/list`, listens for tool-list changes, and swaps only a fully fetched
snapshot. A failed refresh retains the last-known-good catalog. Unexpected
disconnects use bounded exponential reconnect; `close()` cancels reconnect,
quiesces pending discovery, closes the transport, and unregisters the tools.

Protocol negotiation and transport fallback are separate compatibility layers:

- `protocol: 'auto'` first probes the modern MCP handshake and falls back to the
  legacy `initialize` handshake on the same transport. Pin `'modern'` or
  `'legacy'` only when the host has a compatibility requirement.
- HTTP connections first use Streamable HTTP. If startup fails for a reason
  unrelated to authentication, authorization scope, or cancellation, the SDK
  creates a fresh protocol client and tries the deprecated SSE transport once.
- `state.protocol` exposes the negotiated `era`, exact `version`, selected
  `transport`, and whether transport `fallback` occurred. This makes a legacy
  deployment visible instead of silently hiding it from health/debug UIs.

The SSE fallback uses the primary URL by default. Configure a distinct legacy
endpoint or disable the fallback explicitly when appropriate:

```ts
const compatible = createMcpHttpClient({
  serverName: 'inventory',
  url: 'https://inventory.example.com/mcp',
  legacySse: { url: 'https://inventory.example.com/sse' },
})

const currentOnly = createMcpHttpClient({
  serverName: 'inventory',
  url: 'https://inventory.example.com/mcp',
  legacySse: false,
})
```

SSE is only a migration path for older servers. New MCP deployments should use
Streamable HTTP.

For applications that control startup themselves:

```ts
import { createMcpHttpClient } from '@ai-agent-sdk/mcp/client'

const mcp = createMcpHttpClient({
  serverName: 'optional_search',
  url: 'https://search.example.com/mcp',
  reconnect: { maxAttempts: 4 },
  onStateChange: state => updateHealthUi(state),
})

await mcp.connect() // rejects the initial failure; background reconnect follows policy
```

### OAuth 2.1 lifecycle

Pass the MCP SDK's `OAuthClientProvider` through `transport.authProvider`. When
discovery starts an interactive login, the connection enters
`oauth-authorization-required` and preserves that HTTP authorization generation:

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
  await mcp.finishOAuth(callbackParams, {
    expectedState: stateStoredByHost,
  })
}
```

`finishOAuth()` compares `state` before token exchange, passes the complete
callback query to the protocol SDK so RFC 9207 `iss` validation remains active,
does not render attacker-controlled callback error text, closes the authorization
generation, and reconnects using a fresh transport. The host owns browser/UI,
callback routing, client registration and secure credential storage; none of
those Node-specific policies are forced into the web-standard client entry.

The lifecycle distinguishes failures so an application can choose the correct
UI instead of treating every `401` as OAuth:

| State | Meaning | Host action |
| --- | --- | --- |
| `authentication-required` | No recognized credential provider was configured | Ask for credentials or configure auth |
| `authentication-failed` | A bearer/API token was supplied but rejected | Replace or refresh the token |
| `oauth-authorization-required` | OAuth needs an interactive authorization code | Complete the redirect/callback and call `finishOAuth()` |
| `scope-authorization-required` | The server returned an insufficient-scope challenge | Request consent for `authorization.requiredScope` |

With an OAuth provider, Streamable HTTP performs bounded scope step-up by
default. Set `transport.onInsufficientScope: 'throw'` when the application wants
to gate that consent flow behind its own UI; the connection then exposes
`scope-authorization-required`. Bearer-only providers cannot perform OAuth
step-up and produce that state directly.

MCP resources and prompts remain available without forcing them into the tool
abstraction:

```ts
const resources = await mcp.withClient((client, signal) =>
  client.listResources(undefined, { signal }))
const prompt = await mcp.withClient((client, signal) => client.getPrompt({
  name: 'release-check', arguments: { version: '1.2.0' },
}, { signal }))
```

Raw operations receive the connection's deadline signal. If one ignores that
signal, the timed-out client generation is removed from the live catalog, closed
within `closeTimeoutMs`, and reconnected only according to the configured policy.
HTTP clients can additionally restrict `allowedOrigins`, require HTTPS, reject
private/local endpoint literals and redirects, and cap raw transport bytes.

The automatic bridge deliberately maps only MCP tools to `ToolCatalog`, because
that is the abstraction consumed by the agent tool loop.

## Use the SDK as an MCP server

`createSdkMcpHandler()` returns a web-standard handler rather than starting a
listener. It can be mounted in a Next.js route, Worker, Deno/Bun server, or any
framework with `Request`/`Response` support:

```ts
import { createSdkMcpHandler } from '@ai-agent-sdk/mcp/server'

const mcp = createSdkMcpHandler({
  name: 'orders-api',
  version: '1.0.0',
  tools: orderTools,
})

export async function POST(request: Request): Promise<Response> {
  return mcp.fetch(request)
}
```

Exported tools run through the SDK pipeline, including argument parsing,
hard outer deadlines, bounded teardown, approval brokers, and interceptors. Tool values become MCP
`structuredContent`; text and inline images remain first-class result content.
The handler accepts already validated `authInfo`, but it does not authenticate
request headers. Verify credentials and resource access in the hosting framework
before calling `handler.fetch()`.

Server tool/agent operations, input/output payloads, concurrent calls, error
observers, and teardown all have independent limits. Internal errors are generic
by default; set `exposeInternalErrors: true` only for a trusted diagnostic surface.

An agent can also become one MCP tool:

```ts
const mcp = createSdkMcpHandler({
  name: 'support-api',
  version: '1.0.0',
  agents: [{
    name: 'run_support',
    agent: supportAgent,
    createSession: async ({ conversationId }) => {
      const snapshot = conversationId === undefined
        ? undefined
        : await sessionStore.load(conversationId)
      return snapshot === undefined
        ? supportAgent.createSession({ registry, conversationId })
        : supportAgent.resumeSession({ registry, snapshot })
    },
  }],
})
```

The server does not hide conversation state in a process-global map. The host
receives `conversationId` and decides how to create or resume a session, which
keeps web/serverless persistence and isolation policy explicit.

## Node and stdio

```ts
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { connectMcpStdio, serveSdkMcpStdio } from '@ai-agent-sdk/mcp-node'

const runtime = await createAgentRuntime({ providers: [modelProvider] })
let local: Awaited<ReturnType<typeof connectMcpStdio>> | undefined
try {
  local = await connectMcpStdio({
    serverName: 'filesystem',
    command: process.execPath,
    args: ['path/to/server.js'],
    logger: runtime.logger({ fields: { integration: 'mcp-stdio' } }),
  })
  const agent = runtime.agent({ model, toolSources: [local] })
  await agent.generate('Inspect the requested files.')
} finally {
  try {
    await runtime.close()
  } finally {
    await local?.closeWithReport()
  }
}

// In an MCP server process:
serveSdkMcpStdio({ name: 'local-tools', version: '1.0.0', tools })
```

For Express or `node:http`, convert the web handler with `toNodeHandler()`.
When binding a local HTTP listener, apply `localhostHostValidation()` and
`localhostOriginValidation()` (or explicit allowlists) before the handler to
protect it from DNS rebinding and unwanted browser origins.

## Human verification

```powershell
npm run human:mcp
```

This performs an actual initialize, discovery, and tool call through linked MCP
transports without provider credentials. It prints lifecycle states, discovered
names, and the structured round-trip result.

For an end-to-end OAuth request to GitHub's official remote MCP server, first
register `http://127.0.0.1:8765/oauth/callback` on a dedicated GitHub App or
OAuth App:

```powershell
$env:GITHUB_MCP_OAUTH_CLIENT_ID = '<client id>'
$env:GITHUB_MCP_OAUTH_CLIENT_SECRET = '<client secret>'
npm run human:mcp:github -- whoami
npm run human:mcp:github -- read --repo github/github-mcp-server --path README.md
```

GitHub Remote MCP currently has no Dynamic Client Registration, so those app
credentials cannot be inferred. PAT remains available with `--auth pat` for
headless/CI use.

The GitHub harness requests only `get_me` and `get_file_contents` in read-only
mode. Its `create-file` command requires `--confirm-write`, refuses an existing
path, omits update SHA, sends plaintext content, and reads the new file back for
verification. See `test-human/github-mcp/README.md` for the complete write
example and safety rules.
