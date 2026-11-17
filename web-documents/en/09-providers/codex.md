# Codex

The ChatGPT-backed Codex endpoint. Runtime: **Universal**, with an **injected**
`CodexAuthStore`; a Node package supplies the filesystem-backed one.

```bash
# Universal — you inject the store
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-codex

# Node — project-local OAuth store included
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-codex @alvin0/ai-agent-sdk-auth-node
```

`openai` and `codex` share **one** Responses implementation and differ only by a
small dialect record: base URL, auth, and which optional fields the endpoint
accepts.

## On Node — project-local login

```bash
pnpm exec ai-agent-sdk-codex-login             # sign in
pnpm exec ai-agent-sdk-codex-login --status    # local account/status details
```

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { codexNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/codex'

const runtime = await createAgentRuntime({ providers: [codexNodeProviderPlugin()] })

const agent = runtime.agent({
  id: 'coding-cli',
  instructions: 'Work in the current project.',
  model: { provider: 'codex' },     // catalog discovered from the account
})
```

`codexNodeProviderPlugin()` uses the revisioned `fileCodexCredentialStore()` by
default. The store is **borrowed and stays caller-owned** — the runtime closes
the provider registration, not the store.

### Token isolation is deliberate

Tokens land in `.providers/.codex/auth.json` below `process.cwd()`, **not** in the
Codex CLI's `~/.codex/auth.json`.

OAuth refresh tokens are **single-use and rotate on every refresh**, so two
programs sharing one credential file will eventually race — the second to refresh
replays a spent token and silently logs you out of your real Codex CLI. The
isolation prevents that.

Writes use compare-and-swap under a **cross-process writer lock**, a private
same-directory temporary file, file sync, atomic rename, mode `0600`, and
directory sync. **Credential-file symlinks are rejected.**

## Anywhere else — inject a store

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { codexPlugin } from '@alvin0/ai-agent-sdk-provider-codex'

const registry = new ModelRegistry()
registry.install(codexPlugin({ authStore: mySecretManagerStore }))
```

The `CodexAuthStore` contract is Universal — a browser, Worker, secret manager,
or Node package owns persistence. For tests and ephemeral hosts:

```ts
import { memoryCodexCredentialStore } from '@alvin0/ai-agent-sdk-provider-codex'

codexPlugin({ authStore: memoryCodexCredentialStore(tokens) })
```

## Standalone image generation (experimental)

Image generation has a separate transport from Codex Responses. The opt-in
`generateCodexNodeImage()` helper sends one request to
`<baseUrl>/images/generations`, reusing the project-local OAuth store and its
revision-safe token refresh. `account` selects the same named login as
`codexNodeProviderPlugin({ account })`; a custom `authStore` takes precedence.

```ts
import { generateCodexNodeImage } from '@alvin0/ai-agent-sdk-auth-node/codex'

// Supply an image model enabled for this connection, independently of the text model.
async function draw(prompt: string, imageModel: string) {
  const { images } = await generateCodexNodeImage({ model: imageModel, prompt })
  return images // ImageBlock[] with inline base64 and detected mediaType
}
```

To let an agent request images, explicitly register the host tool:

```ts
import { codexNodeImageTool } from '@alvin0/ai-agent-sdk-auth-node/codex'

function imageAgent(imageModel: string) {
  return runtime.agent({
    id: 'image-assistant',
    instructions: 'Use codex_generate_image when the user requests a new image.',
    model: { provider: 'codex', id: 'gpt-6-luna' },
    tools: [codexNodeImageTool({ model: imageModel })],
  })
}
```

The tool's only model-controlled argument is `prompt`. Credentials, endpoint,
image model and output settings stay in host configuration. Image blocks appear
in `tool-result` events (`event.output.content`) and tool-result history;
the final assistant message can be text only. Render or persist the image blocks
from those results. This does not enable the Responses native
`image-generation` tool or add image models to the chat catalog.

**A connected Codex account does not guarantee access to this endpoint.**
The project OAuth live check on 2026-11-17 returned HTTP 403 even with a
specialized image model. Image delivery is covered by offline transport and
agent-loop tests; successful live generation through this connection remains
unverified. This result does not establish a restriction on image generation in
the Codex app, whose runtime authorization can differ.

`CodexImageError.code` distinguishes `CODEX_IMAGE_FORBIDDEN` (403),
`CODEX_IMAGE_UNAUTHORIZED` (401), `CODEX_IMAGE_HTTP`, `CODEX_IMAGE_REDIRECT`,
`CODEX_IMAGE_TIMEOUT`, `CODEX_IMAGE_NETWORK`, `CODEX_IMAGE_TOO_LARGE` and
`CODEX_IMAGE_MALFORMED`. Missing credentials and refresh failures keep their
original errors; caller cancellation preserves its reason. There is no automatic
retry, model fallback or switch to API-key billing. The defaults are a 180-second
deadline and a 32-MiB encoded response limit; use `timeoutMs`, `maxBytes`, `quality`,
`size` and `background` to configure them. Overrides of `baseUrl` must be trusted
HTTPS endpoints because they receive the selected account's credentials.

The host tool defaults to a smaller **2,000,000-byte JSON response limit** so its
JSON value and rendered image together fit the core's 4-MiB tool-result limit.
For larger images, configure `maxBytes` together with `maxToolResultBytes` and
history entry limits, or use the standalone helper and save the image as an artifact.

Universal hosts use `generateCodexImage({ authStore, model, prompt })` or
`codexImageTool({ authStore, model })` from
`@alvin0/ai-agent-sdk-provider-codex`. The standalone route follows the
[Codex Images client](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/images.rs)
and its
[image extension backend](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/backend.rs).

## Exports

```ts
// Adapter + plugin
export {
  CODEX_BASE_URL, CODEX_CLIENT_VERSION, CODEX_ORIGINATOR,
  codexAdapter, codexPlugin,
  type CodexAdapterOptions, type CodexPluginOptions,
  type CodexProviderOptions, type CodexRevisionedAdapterOptions,
}

// Auth contracts and in-memory stores
export {
  ACCESS_TOKEN_REFRESH_WINDOW_MS, LAST_REFRESH_MAX_AGE_MS,
  isFedrampAccount, memoryCodexAuthStore, memoryCodexCredentialStore,
  readJwtClaims, requireTokens, resolveAccountId, shouldRefresh,
  type CodexAuthFile, type CodexAuthStore, type CodexCredentialStore,
  type CodexJwtClaims, type CodexTokens,
}

// OAuth device-code flow
export {
  CODEX_CLIENT_ID, CodexRefreshError, DEFAULT_CODEX_ISSUER,
  refreshCodexTokens, requestDeviceCode, runDeviceCodeLogin,
  type CodexDeviceCode, type CodexLoginProgress, type CodexLoginResult,
  type CodexOAuthOptions, type RefreshFailureKind,
}
```

`shouldRefresh()`, `ACCESS_TOKEN_REFRESH_WINDOW_MS`, and
`LAST_REFRESH_MAX_AGE_MS` are what a custom store uses to decide when to refresh
rather than guessing from expiry alone.

## The catalog comes from the account

```ts
const models = await runtime.modelCatalog('codex')
```

Codex **discovers its catalog from the endpoint**, because the available models
depend on the account's plan. That is why `model: { provider: 'codex' }` with no
`id` is meaningful here in a way it is not for a static catalog.

### Discovery under-reports document input

Discovery reports `input_modalities` as `text` and `image` only, even for models
that do accept PDF input. Because an omitted modality is read as a negative
capability claim, document input is projected to text unless you override the
entry yourself:

```ts
codexNodeAdapter({
  authStore,
  models: [{ id: 'gpt-6-luna', inputModalities: ['text', 'image', 'document'] }],
})
```

An explicit `models` entry replaces discovery for that id. See
[Document input](/en/03-tools/native-tools#document-pdf-input).

## Two things to know before using it

> **This endpoint serves the Codex CLI.** It identifies its client with an
> `originator` header, and the adapter defaults to `CODEX_ORIGINATOR` — the CLI's
> value — so requests are accepted.
>
> Use **your own account**, and prefer [`openai`](/en/09-providers/openai) for
> production.

## It is the built-in `auth: dynamic` case

Codex needs a refreshing OAuth credential, and it required **no adapter
subclass**: it is configuration on top of the Responses protocol with
`auth: { kind: 'dynamic' }`.

If your provider also refreshes credentials, you do not need a subclass either —
see [Custom Provider](/en/09-providers/custom-provider).

## Credential observation is redacted

Credential and catalog observation **excludes** OAuth tokens, account details,
store locations, and raw authentication errors. `sdk.credential.operation`
records the refresh/login **classification** and never a credential value.

`CodexRefreshError` carries a typed `RefreshFailureKind` so you can distinguish
"needs re-login" from "transient network failure" without parsing a message.

## Read next

- [auth-node](/en/09-providers/auth-node) — the credential store in detail
- [OpenAI](/en/09-providers/openai) — the same protocol, static catalog
- [Node coding agent](/en/10-advanced/deploy-node-cli) — Codex in a full CLI
