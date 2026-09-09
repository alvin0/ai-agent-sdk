# Security

## What is excluded by default

Observation defaults to `content: 'none'`. Excluded unless you explicitly enable
them:

- OAuth tokens and API keys
- Cookies
- Account details
- Headers outside a positive allowlist
- Prompt and completion content

Missing token usage stays `missing` or `partial` — never a fabricated zero.

## Content policy

```ts
observability: {
  content: 'none',              // 'none' | 'metadata'
  includeErrorStacks: false,
  redactors: [myRedactor],
}
```

`content: 'metadata'` adds structural metadata — block counts, sizes, types —
without bodies. Prompt and completion bodies require an explicitly enabled
high-risk path.

Custom `ContentRedactor` functions run inside the bus, before any exporter sees
an event.

## The exact-wire diagnostic

This is a **separate high-risk capability**, not a verbosity setting. It refuses
construction unless **both** flags are set:

```ts
import { createDailyJsonlRequestLogger } from '@ai-agent-sdk/observability-node/diagnostic'

registry.registerAdapter(['codex'], codexAdapter({
  requestLogger: createDailyJsonlRequestLogger({
    content: 'full',
    allowWireBodies: true,
  }),
}))
```

| Behaviour | Detail |
| --- | --- |
| Location | Private unique file under `.providers/<provider>/wire/` |
| Redacted | Credentials, cookies, account ids |
| **Not** redacted | Request bodies — prompts and tool results are the point |
| Git | `.providers/` is git-ignored, but still sensitive local data |

The human harness leaves this disabled unless `--logs` is passed explicitly.

For normal production diagnosis, use the structured observation bus instead.

## Credential handling

Credentials are always **injected**. Universal provider packages never read
environment variables or files.

```ts
openAiPlugin({ apiKey: () => secretStore.get('openai') })              // any runtime
openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })              // Node
codexPlugin({ authStore: mySecretManagerStore })                       // any runtime
codexNodeProviderPlugin()                                              // Node file store
```

Credential sources are **lazy**, receive the model-operation cancellation signal,
and are **borrowed** — core never closes them.

### Codex token isolation

Tokens land in `.providers/.codex/auth.json` below `process.cwd()`, **not** in
the Codex CLI's `~/.codex/auth.json`.

This isolation is deliberate. OAuth refresh tokens are single-use and rotate on
every refresh, so two programs sharing one credential file will eventually race —
the second to refresh replays a spent token and silently logs you out of your
real Codex CLI.

Writes use compare-and-swap under a cross-process writer lock, a private
same-directory temporary file, file sync, atomic rename, mode `0600`, and
directory sync. **Credential-file symlinks are rejected.**

## Endpoint policy

The SDK is deployment-policy neutral and accepts standard endpoints unless the
host opts into constraints. Choose these for your trust boundary.

**MCP HTTP client:**

```ts
createMcpHttpClient({
  url,
  allowedOrigins: ['https://tools.example.com'],
  requireHttps: true,
  allowPrivateNetwork: false,
  // response / catalog / result bounds, operation deadlines
})
```

**A2A client:**

```ts
linkA2AAgent(team, {
  baseUrl,
  requireHttps: true,
  allowPrivateNetwork: false,
  allowRedirects: false,
  allowedOrigins: ['https://security-agent.example.com'],
})
```

**HTTPS telemetry exporter:** HTTPS is required except for an explicitly enabled
localhost/loopback test endpoint. Redirects and cross-origin responses are
rejected.

## Hosting an MCP server

`createSdkMcpHandler()` accepts already-validated `authInfo` but does **not**
authenticate request headers. Verify credentials and resource access in the
hosting framework **before** calling `handler.fetch()`.

For a local Node HTTP listener, apply `localhostHostValidation()` and
`localhostOriginValidation()` — or explicit allowlists — **before** the handler,
to protect it from DNS rebinding and unwanted browser origins.

Internal errors are generic by default. Set `exposeInternalErrors: true` only for
a trusted diagnostic surface.

## Hosting an A2A server

Authentication is host policy. Set `requireAuthenticated: true` only when the
surrounding transport supplies an authenticated `User`.

`sessionOwner(context)` chooses the isolation boundary — user, device, workspace,
API client. A session is retained per `(session owner, A2A contextId)`, so a task
in one owned context never sees another owner's history.

Agent Card security schemes are passed through when configured, but are **not**
invented or enforced by this SDK.

## Support-safe errors

`SupportSafeError` is a sanitized projection for support tickets and
cross-service propagation. It carries the code and correlation identity without
credentials, endpoints, headers, or raw provider text.

## What stays with you

This package is an SDK, not a production control plane. The embedding service
remains responsible for:

- authentication middleware
- durable stores
- rate limiting
- network/DNS enforcement
- secrets management
- deployment
- observability backends

## Read next

- [Observability](/en/10-advanced/observability)
- [Permissions](/en/03-tools/permissions)
- [Dependency policy](/en/14-project/dependency-policy)
