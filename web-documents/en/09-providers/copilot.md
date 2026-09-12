# Copilot

The GitHub Copilot subscription surface. Runtime: **Universal**, with an
**injected** `CopilotCredentialStore`; a Node package supplies the
filesystem-backed one.

```bash
# Universal — you inject the store
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-copilot

# Node — project-local device-code login included
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-copilot @alvin0/ai-agent-sdk-auth-node
```

One Copilot route dispatches to **two** wire protocols — `/responses` for models
matching the responses prefixes, `/chat/completions` for the rest — behind a
single provider id.

## On Node — project-local login

```bash
pnpm exec ai-agent-sdk-copilot-login             # sign in via device flow
```

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { copilotNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/copilot'

const runtime = await createAgentRuntime({ providers: [copilotNodeProviderPlugin()] })

const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'copilot' },     // catalog discovered from the account
})
```

Credentials land in `.providers/.copilot/auth.json` below `process.cwd()`.
Override the path with `AI_AGENT_SDK_COPILOT_AUTH`. The store is **borrowed and
stays caller-owned** — the runtime closes the provider registration, not the
store.

## Anywhere else — inject a store

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { copilotPlugin, memoryCopilotCredentialStore } from '@alvin0/ai-agent-sdk-provider-copilot'

const registry = new ModelRegistry()
registry.install(copilotPlugin({ authStore: memoryCopilotCredentialStore(tokens) }))
```

The `CopilotCredentialStore` contract is Universal — a browser, Worker, secret
manager, or Node package owns persistence.

## Tradeoffs of using the Copilot subscription surface

This provider talks to the endpoints a Copilot **editor extension** talks to.
That is a different thing from a vendor API product, and the differences are
worth reading before you build on it.

**The SDK presents itself as an editor client.** Three exported constants decide
which client that is:

| Constant | Override |
| --- | --- |
| `COPILOT_OAUTH_CLIENT_ID` | `clientId` option |
| `COPILOT_EDITOR_VERSION` | `editorHeaders.editorVersion` |
| `COPILOT_EDITOR_PLUGIN_VERSION` | `editorHeaders.editorPluginVersion` |

The defaults are required for the surface to answer at all:
`copilot_internal/v2/token` only accepts a token minted by an OAuth App on
GitHub's allowlist, and the Copilot endpoints return HTTP 400 when either editor
header is missing. They are **exported and overridable named options rather than
hidden constants** precisely because presenting as another client is a decision
you should be able to read off the source and change — not one buried in a
private module.

Two of the three defaults are confirmed against a live Copilot account; a run on
2026-09-10 sent both editor headers on the token exchange, `GET /models`, and a
streaming call without an HTTP 400. `COPILOT_OAUTH_CLIENT_ID` is **unconfirmed**:
that run used an existing user token rather than the device flow, so the client id
never reached the allowlist check.

What that adds up to:

| Consideration | Reality on this surface |
| --- | --- |
| Contract | No published API contract, versioning policy, or deprecation window. Endpoint shape, model lineup, and required headers can change without notice. |
| Rate and quota | Governed by your Copilot subscription, not a metered API plan. A subscription is provisioned for interactive editing, not for sustained programmatic load. |
| Terms | Automated non-editor use may not be within your subscription's terms. That is your call to make, on your own account. |
| Auth | OAuth device flow only. A personal access token cannot mint a Copilot API token on this surface. |
| Client identity | The SDK identifies as an editor client, by necessity. |
| Tenancy | Data-residency tenants (`*.ghe.com`) are out of scope. |

> **Recommendation.** Use **your own account**, and for production workloads
> prefer a vendor's official first-party provider —
> [`openai`](/en/09-providers/openai),
> [`anthropic`](/en/09-providers/anthropic), or
> [`gemini`](/en/09-providers/gemini) — where you get a published contract, a
> deprecation policy, and a quota you can reason about. Copilot is a good fit for
> local development, personal tooling, and prototypes where an existing
> subscription is the credential you already have.

Same reasoning as the [Codex](/en/09-providers/codex) note, one step further:
Codex identifies with an `originator` header, Copilot needs an allowlisted OAuth
client id **and** two editor headers.

## Embedding

> **Not available for Copilot.** `copilotEmbeddingPlugin` and the
> `@alvin0/ai-agent-sdk-provider-copilot/embedding` entry point **do not exist**.

The embedding capability itself shipped:
[`@alvin0/ai-agent-sdk-core/embedding`](/en/09-providers/embeddings) is a core
entry point, and OpenAI and Gemini both have embedding adapters. What is missing
is a Copilot one. `provider-copilot` exports `"."` only, and Copilot's catalog
already partitions embedding models out of the generation lineup
(`CopilotEmbeddingModel`), so the catalog side is in place — but there is nothing
to register yet. Registration, and how Copilot's usage differs from the other
embedding providers, gets documented here once that lands.

## Read next

- [auth-node](/en/09-providers/auth-node) — the credential store in detail
- [Codex](/en/09-providers/codex) — the other subscription-backed surface
- [Protocols](/en/09-providers/protocols) — reusing the Chat Completions protocol elsewhere
