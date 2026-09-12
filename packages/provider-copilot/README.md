# @alvin0/ai-agent-sdk-provider-copilot

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node with an injected credential store).

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-copilot
```

Universal GitHub Copilot adapter: OAuth device flow, the two-tier credential
contract, Copilot token exchange, model-driven endpoint routing across
`/responses` and `/chat/completions`, catalog discovery, and a transactional
provider plugin. A `CopilotCredentialStore` must be injected; filesystem and
environment defaults belong to the Node auth package.

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { copilotPlugin, memoryCopilotCredentialStore } from '@alvin0/ai-agent-sdk-provider-copilot'

const registry = new ModelRegistry()
registry.install(copilotPlugin({ authStore: memoryCopilotCredentialStore(tokens) }))
```

Use `copilotAdapter()` for manual route registration. The store contract is
Universal; a browser, Worker, secret manager, or Node package owns persistence.

Composition: `runtime.providers`. Lifecycle:
`inert-runtime-owned-registration`; the runtime owns registration while the
injected credential store remains caller-owned.

## Client identity

Three exported constants decide which client this SDK presents itself as:

| Constant | Module | Override |
| --- | --- | --- |
| `COPILOT_OAUTH_CLIENT_ID` | `src/oauth.ts` | `clientId` option |
| `COPILOT_EDITOR_VERSION` | `src/adapter.ts` | `editorHeaders.editorVersion` |
| `COPILOT_EDITOR_PLUGIN_VERSION` | `src/adapter.ts` | `editorHeaders.editorPluginVersion` |

Their defaults make this SDK identify itself as an editor client. That is required
for the surface to answer: `copilot_internal/v2/token` only accepts a token minted
by an OAuth App on GitHub's allowlist, and the Copilot endpoints answer HTTP 400
when either editor header is missing.

They are exported and overridable rather than hidden precisely because presenting
as another client is a decision you should be able to read off the source and
change. Use your own account, and prefer a provider's official first-party surface
for production workloads.

**Two of the three default values are confirmed against a live Copilot account; one
is not.** A live run on 2026-09-10 sent both editor headers on the token exchange,
`GET /models`, a streaming `/chat/completions` call and `POST /embeddings`, and none
answered HTTP 400 — so `COPILOT_EDITOR_VERSION` and `COPILOT_EDITOR_PLUGIN_VERSION`
are confirmed as of that date. `COPILOT_OAUTH_CLIENT_ID` is still unconfirmed: that
run used an existing user token rather than the device flow, so this client id never
reached GitHub's allowlist check. The source carries a `copilot-identity` comment
naming what must be confirmed and how.

## License

MIT
