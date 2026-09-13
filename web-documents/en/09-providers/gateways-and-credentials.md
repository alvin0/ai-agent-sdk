# Compatible gateways and database credentials

Available in SDK **0.1.2**.

## Configure a compatible endpoint

OpenAI, Anthropic, and Gemini generation adapters/plugins accept `baseUrl`,
`models`, `fetch`, and `headers`. OpenAI and Gemini embedding adapters/plugins
also accept custom headers.

```ts
import { openAiEmbeddingPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const provider = openAiEmbeddingPlugin({
  id: 'gateway-embeddings',
  apiKey: 'gateway-key', // or a CredentialSource
  baseUrl: 'https://gateway.example/v1',
  headers: { 'x-tenant': 'tenant-a' },
  models: [{
    id: 'custom-embedding',
    compatibilityIdentity: 'gateway:custom-embedding',
  }],
})
```

Headers can also be a synchronous function: `headers: () => ({ 'x-tenant': tenantId })`.
Static records are copied at adapter construction. Resolvers run per operation;
all batches of a prepared embedding call share the captured header snapshot.
Keep each provider instance scoped to the appropriate tenant/account rather than
changing a process-global tenant variable during concurrent requests.

Names are case-insensitive. Duplicate names and ownership collisions fail rather
than overwrite. Use `apiKey` for credentials, OpenAI `organization`/`project`
for account headers, and Anthropic `version`/`beta` for protocol headers.
Transport and SDK headers such as `content-type`, `accept`, and `user-agent`
are reserved. A different authentication scheme can use a
[custom HTTP provider](/en/09-providers/custom-provider).

| Provider capability | Required wire protocol/path |
| --- | --- |
| OpenAI generation | Responses, `/responses` |
| Anthropic generation | Messages, `/v1/messages` |
| Gemini generation | Interactions, `/interactions` |
| OpenAI embeddings | `/embeddings` |
| Gemini embeddings | `models/{model}:batchEmbedContents` |

A model name alone does not establish compatibility. A gateway implementing only
Chat Completions or Gemini `generateContent` does not match those generation
plugins. Supply model capabilities in `models` when the endpoint supports them.
For trusted local HTTP endpoints, opt in with `allowInsecureHttp: true`.

## Store Codex and Copilot credentials in a database

Universal providers require injected `authStore` objects. Only Node convenience
wrappers default to files; they also accept an injected store. The types named
`CodexAuthFile` and `CopilotAuthFile` are JSON payloads, not filesystem requirements.

Create a store with `defineCredentialStore<Value>` from
`@alvin0/ai-agent-sdk-core/provider`:

| Hook | Contract |
| --- | --- |
| `read(operation)` | Return `{ value, revision }` or `undefined`. |
| `commit(input, operation)` | Atomically write `input.value` only when `input.expectedRevision` matches; return the new revision. `null` means insert only if absent. |

Scope every operation to one tenant/account and provider. Conflicts must use
`CODEX_CREDENTIAL_REVISION_CONFLICT` or `COPILOT_CREDENTIAL_REVISION_CONFLICT`.
Both device-login flows persist through these same hooks.

The repository includes a [tested SQLite store and integration example](https://github.com/alvin0/ai-agent-sdk/tree/main/samples/credential-database).
Use your own database client to implement the same contract for other databases.

## Read and refresh tokens

```ts
import { getCodexTokens, refreshCodexTokens } from '@alvin0/ai-agent-sdk-provider-codex'
import { getCopilotToken, createCopilotTokenCache } from '@alvin0/ai-agent-sdk-provider-copilot'

// codexStore and copilotStore are your injected stores.
const current = await getCodexTokens(codexStore)
const storedOnly = await getCodexTokens(codexStore, { refreshIfNeeded: false })
const refreshed = await refreshCodexTokens(codexStore)

const tokenCache = createCopilotTokenCache()
const apiToken = await getCopilotToken(copilotStore, { tokenCache })
const renewed = await getCopilotToken(copilotStore, { tokenCache, forceRefresh: true })
```

Share `tokenCache` with `copilotPlugin({ authStore: copilotStore, tokenCache })`.
Without an explicit cache, each `getCopilotToken` call exchanges anew. An injected
cache owns exchange configuration. `forceRefresh` invalidates the cached entry
but may reuse an exchange already in flight.

For database caching or a separate auth service, implement
`CopilotTokenCache.acquire(source, operation, context?)` and `invalidate()`.
`acquire` returns `{ token, expiresAtMs }`; it owns expiry checks and exchange.
`invalidate` is synchronous: mark invalid locally, then await database work during
the next `acquire`. The standalone `exchangeCopilotToken` is also public.
Cache keys must include the account and source credential revision.

Codex refresh rotates and commits its refresh token. Copilot exchanges a long-lived
GitHub token for a short-lived API token without rotating the GitHub credential.
The short-lived cache is separate from `CopilotAuthFile`.

The token helpers honor cancellation while waiting for database/cache hooks.
Cancellation stops the caller's wait; it cannot terminate arbitrary host work.
Pass and honor `operation.signal` in your database/auth clients.

Revision checks prevent lost database updates, but do not prevent two workers
from sending the same Codex refresh token to OAuth. Coordinate the entire
read/refresh/commit sequence per account, including inference-triggered refresh.
Keep token values out of logs and status responses; the host owns encryption,
database permissions, and tenant selection.
