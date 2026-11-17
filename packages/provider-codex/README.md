# @alvin0/ai-agent-sdk-provider-codex

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node with an injected auth store).

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-codex
```

Universal Codex adapter, OAuth flows, memory/custom auth stores, and transactional provider plugin. A `CodexAuthStore` must be injected; filesystem and environment defaults belong to the Node auth package.

For normal runtime composition use a revisioned `CodexCredentialStore`, created
with `defineCredentialStore<CodexAuthFile>({ id, label, read, commit })`.
`getCodexTokens(store)` reads tokens and refreshes/commits when due;
`getCodexTokens(store, { refreshIfNeeded: false })` reads only.
`refreshCodexTokens(store)` explicitly refreshes and commits the rotated tokens.
These APIs and both logins accept database stores without filesystem access.
Device login is `runDeviceCodeLogin(store)`. Browser login (authorization code
with PKCE, no device authorization needed) is split so any runtime with a
redirect endpoint can host it: `createBrowserAuthorization({ redirectUri? })`
returns the URL to open plus its `state` and verifier (keep them server-side),
and `completeBrowserLogin(store, authorization, callbackUrl)` checks `state`,
exchanges the code and commits the tokens. The Codex OAuth client only accepts
its registered redirect, `http://localhost:1455/auth/callback`; the Node
listener for it is `runBrowserLogin` in `@alvin0/ai-agent-sdk-auth-node/codex`.
See the [working database example](../../samples/credential-database/README.md).

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { codexPlugin } from '@alvin0/ai-agent-sdk-provider-codex'

const registry = new ModelRegistry()
registry.install(codexPlugin({ authStore: mySecretManagerStore }))
```

### Remaining usage

`getCodexUsage({ authStore })` reads the account's remaining Codex usage without
spending any: the share left in each rolling plan window (five hours and one week
on current plans) and when it resets, credits, any separately metered limits, and
which models are available. It calls the same usage endpoint as the Codex CLI's
`/status`, derived from `baseUrl` by `codexUsageUrl()`, and refreshes tokens when
due. Email, user and account ids in the response are not returned.

```ts
import { getCodexUsage } from '@alvin0/ai-agent-sdk-provider-codex'

const usage = await getCodexUsage({ authStore: mySecretManagerStore })
const week = usage.rateLimit?.secondary
if (week !== undefined && week.remainingPercent < 10) {
  console.warn(`Codex: ${week.remainingPercent}% of the weekly limit left, resets ${week.resetsAt}`)
}
```

A failed usage request throws `CodexUsageError`; route on `code`:
`CODEX_USAGE_UNAUTHORIZED` (HTTP 401/403, sign in again), `CODEX_USAGE_HTTP`,
`CODEX_USAGE_TIMEOUT`, `CODEX_USAGE_NETWORK`, `CODEX_USAGE_REDIRECT`,
`CODEX_USAGE_TOO_LARGE` or `CODEX_USAGE_MALFORMED`. Missing credentials and refresh
failures keep the credential store's and `CodexRefreshError`'s own errors, and caller
cancellation rethrows the signal's reason. Every model response also carries
`x-codex-*` usage headers; `parseCodexUsageHeaders(headers)` turns a `Headers`
object or a `responseLogger` record's headers into the same `CodexUsage` shape
(primary/secondary windows, plan, credits) with `source: 'response-headers'`.
Usage is reported by the service as percentages, not tokens.

Use `codexAdapter()` for manual route registration. The store contract is
Universal; a browser, Worker, secret manager, or Node package owns persistence.
Credential and catalog observation excludes OAuth tokens, account details, store
locations, and raw authentication errors.

Composition: `runtime.providers`. Lifecycle: `inert-runtime-owned-registration`;
the runtime owns registration while the injected credential store remains
caller-owned.
