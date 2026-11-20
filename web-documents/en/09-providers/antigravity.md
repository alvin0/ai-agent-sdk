# Antigravity

Runtime: **Universal**, with an injected `AntigravityCredentialStore`. The optional
Node companion owns Google browser login and project-local files.

## Install and sign in

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-antigravity @alvin0/ai-agent-sdk-auth-node
export AI_AGENT_SDK_ANTIGRAVITY_CLIENT_ID='your-client-id'
# Only for clients that require a secret:
export AI_AGENT_SDK_ANTIGRAVITY_CLIENT_SECRET='your-client-secret'
pnpm exec ai-agent-sdk-antigravity-login
pnpm exec ai-agent-sdk-antigravity-login --models
```

Sign-in uses Google OAuth authorization-code flow with S256 PKCE. The CLI opens
your browser and listens on `http://localhost:51121/oauth-callback`. Credentials
are saved privately to `.providers/.antigravity/auth.json`; ignore `.providers/`
in your application's Git repository. Access tokens refresh automatically.

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { antigravityNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/antigravity'

const runtime = await createAgentRuntime({ providers: [antigravityNodeProviderPlugin()] })
try {
  const catalog = await runtime.modelCatalog('antigravity')
  const model = catalog.models.find(model => model.id.startsWith('gemini-'))
  if (!model) throw new Error('No Gemini model available to this Antigravity account')
  const response = await runtime.agent({
    id: 'assistant', instructions: 'Be concise.',
    model: { provider: 'antigravity', id: model.id },
  }).generate('Hello')
  console.log(response.text)
} finally { await runtime.close() }
```

Select the exact model you need from `--models`; account availability is dynamic.
The example selects an available Gemini model. The provider has no model default
or automatic fallback to another provider.

## Accounts and CLI

```bash
pnpm exec ai-agent-sdk-antigravity-login --status
pnpm exec ai-agent-sdk-antigravity-login --force
pnpm exec ai-agent-sdk-antigravity-login --account backup
pnpm exec ai-agent-sdk-antigravity-login --account backup --models
```

Use `antigravityNodeProviderPlugin({ account: 'backup' })` for the named account.
`--path FILE` or `AI_AGENT_SDK_ANTIGRAVITY_AUTH` overrides the default location.
Status reads local credentials without contacting Google. `--models` contacts the
account's catalog. On SSH, forward localhost port 51121 and pass `--no-open`.
This integration uses browser OAuth, rather than a device code.

## Other runtimes

Inject a revisioned store into `antigravityPlugin({ authStore })` from
`@alvin0/ai-agent-sdk-provider-antigravity`. The Universal package never reads
files or environment variables. `memoryAntigravityCredentialStore()` supports
fixtures; production persistence belongs to your host.

`createAntigravityAuthorization()` and `completeAntigravityLogin()` expose the
OAuth steps without Node APIs. Keep the authorization object server-side; it
contains the PKCE verifier and must be used once. The host owns callback handling.
Before showing the URL, read the store revision with `readAntigravityCredentialRevision(store, signal)`.
Pass it as `expectedRevision` when completing the callback. Node browser login does this automatically.

## Supported behavior

- Text, reasoning and function tool calls/results, including signed replay.
- Inline base64 images and PDFs; remote URLs and uploaded-file IDs are rejected.
- Tool choice, JSON Schema output and generation limits.
- Account model discovery, cancellation, bounded HTTP/SSE and disjoint usage counters.

Provider-native tools are currently unsupported; image models return image blocks directly. Model-specific
support for generation parameters remains subject to the upstream endpoint.

This is an **experimental, unofficial Antigravity subscription integration**.
It is separate from [Gemini API-key access](/en/09-providers/gemini) and Google's
[managed Antigravity Agent API](https://aistudio.google.com/docs/antigravity-agent).
The protocol reference is the community
[Antigravity OAuth plugin](https://github.com/NoeFabris/opencode-antigravity-auth).
Google may change access, quota, or client requirements. `baseUrl`, `userAgent`,
`clientId`, `clientSecret`, transport limits and `fetch` are configurable.

OAuth client configuration is external; the package embeds no client ID or secret.
Node reads the environment variables above, with explicit `clientId` and
`clientSecret` options taking precedence. Universal hosts pass these options
directly. Use a client provisioned for the needed service and callback URL.
Existing token files retain the client ID; refresh requires the same client's
external secret when applicable. The secret is not saved in token files.
Changing clients requires a fresh sign-in. This repository's developer commands
also load the ignored private `.providers/.antigravity/client.env` when present.

Offline fixtures verify SDK behavior; live Google consent and model generation
require separate account validation.

## Generated image results

Choose an image model such as `gemini-3.1-flash-image` from the account catalog.
It returns `type: 'image'` blocks in `response.message.content`, including when
`response.text` is empty. Public streams emit `image-delta`; session history keeps
the final images and replay signatures. The MIME type is the upstream's actual
format, so a request for PNG can still produce JPEG.

```ts
const response = await runtime.agent({
  id: 'artist', instructions: 'Create the requested image.',
  model: { provider: 'antigravity', id: 'gemini-3.1-flash-image' },
  maxTokens: 4096,
}).generate('Draw a red circle on a white background.')

const images = response.message?.content.flatMap(block =>
  block.type === 'image' ? [block]
    : block.type === 'native-tool-call' ? block.content.filter(item => item.type === 'image') : [],
) ?? []
// The same extraction handles Codex native image-generation results.
for (const image of images) {
  if (image.source.kind !== 'base64') continue
  const dataUrl = `data:${image.source.mediaType};base64,${image.source.data}`
  // Display dataUrl or persist the decoded bytes using the actual MIME type.
}
```

No Antigravity native image tool is required: select the image model. Codex uses
`nativeTools: [{ type: 'native', name: 'image-generation' }]`; availability depends
on the upstream model and account. The SDK preserves any image results returned
by that endpoint; declaring a tool does not grant upstream access.

Image models allow 12 MiB per SSE event by default, bounded below the ordinary
16 MiB history-entry limit. An explicit `maxSseEventChars` overrides this bound.
If history drops oversized image bytes, save them from the public reply/events.
