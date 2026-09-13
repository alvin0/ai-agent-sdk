# Database-owned Codex and Copilot credentials

Neither Universal provider requires filesystem storage. Both accept an injected
`authStore`; only the optional Node convenience wrappers default to a file.
The `CodexAuthFile` and `CopilotAuthFile` names describe JSON payloads, not a
requirement to create files.

The accompanying [sqlite-store.ts](./sqlite-store.ts) is a working Node SQLite
store, exercised by [database tests](../../tests/unit/database-credentials.spec.ts).
It uses `node:sqlite` (Node 22.18+). PostgreSQL, MySQL, Redis, or a secrets service
can implement the same two hooks with their own client:

- `read(operation)` returns `{ value, revision }`, or `undefined`.
- `commit({ value, expectedRevision }, operation)` atomically writes only if the
  revision still matches. `expectedRevision: null` means insert only if absent.
  Return the new revision. Report conflicts with
  `CODEX_CREDENTIAL_REVISION_CONFLICT` or `COPILOT_CREDENTIAL_REVISION_CONFLICT`.

Use `defineCredentialStore<Value>()` from
`@alvin0/ai-agent-sdk-core/provider` to wrap those hooks. Each store instance
must be bound to one tenant/account and provider. The SQL example scopes every
query by tenant and provider and uses an atomic conditional UPDATE for commits.

## Configure the runtime

```ts
import { DatabaseSync } from 'node:sqlite'
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import {
  codexPlugin, getCodexTokens, refreshCodexTokens, runDeviceCodeLogin,
  type CodexAuthFile,
} from '@alvin0/ai-agent-sdk-provider-codex'
import {
  copilotPlugin, createCopilotTokenCache, getCopilotToken, runCopilotDeviceLogin,
  type CopilotAuthFile,
} from '@alvin0/ai-agent-sdk-provider-copilot'
import { sqliteCredentialStore } from './sqlite-store.ts'

const database = new DatabaseSync('credentials.sqlite')
const codexStore = sqliteCredentialStore<CodexAuthFile>(database, 'tenant-a', 'codex')
const copilotStore = sqliteCredentialStore<CopilotAuthFile>(database, 'tenant-a', 'copilot')
const tokenCache = createCopilotTokenCache()

const runtime = await createAgentRuntime({
  providers: [
    codexPlugin({ authStore: codexStore }),
    copilotPlugin({ authStore: copilotStore, tokenCache }),
  ],
})

// When the account first connects, call the appropriate login flow.
// These persist credentials through commit(), directly into your database.
// await runDeviceCodeLogin(codexStore, oauthOptions, loginProgress)
// await runCopilotDeviceLogin(copilotStore, oauthOptions, loginProgress)

// Read a usable Codex token set; refresh and commit to the DB if due.
const codexTokens = await getCodexTokens(codexStore)

// Explicit refresh, e.g. under your own account-level refresh lock.
const refreshed = await refreshCodexTokens(codexStore)

// Read the stored Codex token set without a network refresh.
const stored = await getCodexTokens(codexStore, { refreshIfNeeded: false })

// Share a cache with inference so acquisition does not exchange again.
const copilotToken = await getCopilotToken(copilotStore, { tokenCache })
const exchanged = await getCopilotToken(copilotStore, {
  tokenCache, forceRefresh: true,
})

await runtime.close()
database.close()
```

The returned objects contain secrets: consume them in the application that owns
the credentials. Do not print them or send them to a browser merely for status.
`getCodexTokens` also accepts the OAuth transport options (including `signal`
and custom `fetch`). For an unconditional refresh use `refreshCodexTokens`.

`getCopilotToken` accepts exchange options when no `tokenCache` is supplied;
in that case it creates a one-call cache and exchanges anew. When a cache is
supplied, that cache owns exchange configuration. `forceRefresh` invalidates the
current entry; it may reuse an exchange already in flight.

## Own the short-lived Copilot API token

The default Copilot cache is in memory. To keep API tokens in a database or to
delegate exchange to an auth service, implement `CopilotTokenCache` and pass the
same object to `copilotPlugin` and `getCopilotToken`:

- `acquire(source, operation, context?)` returns a `CopilotApiToken`
  (`{ token, expiresAtMs }`). Read your cache, check expiry and source revision,
  then exchange or ask your auth service when needed.
- `invalidate()` synchronously invalidates the local entry or marks it for
  invalidation; await database work inside the next `acquire()`.
- `exchangeCopilotToken(source.file.github, options)` is the public standalone
  exchange function. Persist its result yourself when implementing a DB cache.

Keep cache entries keyed by tenant/account and source credential revision.
The long-lived GitHub token does not rotate during exchange; a Copilot API-token
refresh must not replace it. An API-token cache is separate from `CopilotAuthFile`.

## Concurrent Codex refresh

Codex refresh tokens rotate. `commit` must be atomic, not a SELECT followed by an
unconditional UPDATE. The SDK handles a revision conflict by re-reading the winning
credential, but compare-and-swap alone cannot prevent two workers from sending
the same refresh token to OAuth. Applications with concurrent refreshers should
serialize the whole read/refresh/commit operation per account (including inference
refresh), through a shared auth service or an account-level lock.

The example stores JSON to show the contract. The host owns encryption at rest,
database permissions, connection lifecycle, and tenant/account selection.
