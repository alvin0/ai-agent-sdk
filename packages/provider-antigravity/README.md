# @alvin0/ai-agent-sdk-provider-antigravity

Runtime: **Universal**. Antigravity subscription models through injected Google
OAuth credentials. Filesystem access and interactive login belong to the optional
Node companion, `@alvin0/ai-agent-sdk-auth-node/antigravity`.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-antigravity @alvin0/ai-agent-sdk-auth-node
export AI_AGENT_SDK_ANTIGRAVITY_CLIENT_ID='your-client-id'
# Set this only when the configured OAuth client requires a secret:
export AI_AGENT_SDK_ANTIGRAVITY_CLIENT_SECRET='your-client-secret'
pnpm exec ai-agent-sdk-antigravity-login
pnpm exec ai-agent-sdk-antigravity-login --models
```

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { antigravityNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/antigravity'

const runtime = await createAgentRuntime({ providers: [antigravityNodeProviderPlugin()] })
try {
  const catalog = await runtime.modelCatalog('antigravity')
  const model = catalog.models.find(model => model.id.startsWith('gemini-'))
  if (!model) throw new Error('No Antigravity models available to this account')
  const response = await runtime.agent({
    id: 'assistant', instructions: 'Be concise.',
    model: { provider: 'antigravity', id: model.id },
  }).generate('Hello')
  console.log(response.text)
} finally { await runtime.close() }
```

Models are discovered from the signed-in account, without built-in model aliases
or fallback to another provider. Select the exact ID you need from the catalog.
`models` supplies an advisory catalog override. An exact ID absent from the
catalog still reaches the provider.

## Authentication

The CLI opens Google sign-in and listens at `http://localhost:51121/oauth-callback`.
It uses authorization-code OAuth with S256 PKCE, random state, one-use callbacks,
and a 15-minute login deadline. The PKCE verifier never appears in the URL.

No OAuth client ID or secret is bundled. The Node companion reads
`AI_AGENT_SDK_ANTIGRAVITY_CLIENT_ID` and `AI_AGENT_SDK_ANTIGRAVITY_CLIENT_SECRET`,
or accepts explicit `clientId` / `clientSecret` options (which take precedence).
Use a client provisioned for the service and the loopback callback above.
The secret is never written into the credential file. Existing credentials retain
their client ID; refresh requires the same client's external secret when applicable.
Repository developer commands load `.providers/.antigravity/client.env` if present;
that private file is ignored by Git. The distributed CLI uses process environment.

Credentials are private, atomic, revisioned files at
`.providers/.antigravity/auth.json` relative to the working directory. Add
`.providers/` to your application's `.gitignore`. Token refresh runs before expiry
and cannot overwrite a newer login. No credentials are borrowed from Google's CLI
or desktop application.

```bash
pnpm exec ai-agent-sdk-antigravity-login --status
pnpm exec ai-agent-sdk-antigravity-login --force
pnpm exec ai-agent-sdk-antigravity-login --account backup
pnpm exec ai-agent-sdk-antigravity-login --account backup --models
```

Use `antigravityNodeProviderPlugin({ account: 'backup' })` for a named account.
Override the default file with `--path FILE` or `AI_AGENT_SDK_ANTIGRAVITY_AUTH`.
For SSH, forward localhost port 51121 and use `--no-open` to open the displayed URL
on your local browser. There is no Google device-code flow on this provider.

For Workers or other hosts, inject an `AntigravityCredentialStore` into
`antigravityPlugin({ authStore })`. `memoryAntigravityCredentialStore()` is useful
for tests. `createAntigravityAuthorization()` and `completeAntigravityLogin()`
expose the host-independent OAuth steps; the host owns callback storage and routing.
Keep the authorization object, including its verifier, server-side and use each
object once. Before showing the URL, call `readAntigravityCredentialRevision(store, signal)`.
Pass that value as `expectedRevision` when completing the callback so a newer login wins.

## Protocol and limits

Generation uses the shared HTTP/SSE pipeline and the Cloud Code Assist
`streamGenerateContent` envelope. Text, signed reasoning, function calls/results,
inline base64 images and PDFs, generated image output, tool choice, and JSON Schema output are translated
to SDK contracts. Thought signatures survive tool-loop replay. Provider-native
tools and remote media URLs are rejected explicitly. Usage preserves cached input
and reasoning counters without double counting. Missing finish events fail as
truncated streams.

`baseUrl`, `userAgent`, `clientId`, `clientSecret`, HTTP limits, and an injected
`fetch` are configurable. Changing an OAuth client requires signing in again with
that client. A custom client secret must be supplied when that client requires
one. `allowInsecureHttp` is only for local fixtures.

This is an **experimental, unofficial subscription integration**, distinct from
the Gemini API-key provider and Google's managed Antigravity Agent API. Its wire
contract is based on the community
[Antigravity OAuth protocol reference](https://github.com/NoeFabris/opencode-antigravity-auth).
Google may change access, headers, quota, or account eligibility. OAuth client
configuration belongs to the host; Universal callers pass it explicitly.

Offline tests and packed-runtime fixtures do not establish live Google account
eligibility. Real Google consent and real model calls require separate validation.

## Generated images

Choose an image-generation model from the account catalog (for example,
`gemini-3.1-flash-image`). The provider requests text/image output and emits the
same `ImageBlock` contract used by Codex image-generation results. An image-only
reply is a completed answer even when `response.text` is empty.

```ts
const response = await runtime.agent({
  id: 'artist', instructions: 'Create the requested image.',
  model: { provider: 'antigravity', id: 'gemini-3.1-flash-image' },
  maxTokens: 4096,
}).generate('Draw a red circle on a white background.')

// Handles direct images (Antigravity) and native tool images (Codex).
const images = response.message?.content.flatMap(block =>
  block.type === 'image' ? [block]
    : block.type === 'native-tool-call' ? block.content.filter(item => item.type === 'image') : [],
) ?? []
for (const image of images) {
  if (image.source.kind !== 'base64') continue
  const dataUrl = `data:${image.source.mediaType};base64,${image.source.data}`
  // Use dataUrl in an image element, or decode image.source.data into a file.
}
```

Preserve `source.mediaType`: the upstream may return JPEG even when the prompt
asks for PNG. `image-delta` is available on public streaming events, and the final
image is authoritative in `response.message.content`. Signed images remain
replayable in session history. Hosts that prune images or exceed history entry
limits should save the public image bytes to their own artifact storage.

Image models use a 12 MiB SSE event default; `maxSseEventChars` still overrides
it. Contradictory catalog output limits are omitted instead of increasing the
advertised context window. Model-native tools remain separate: Antigravity image
models do not require `nativeTools: [{ name: 'image-generation', ... }]`.

Agent `providerOptions.body` extends the inner GenerateContent request. Nested
objects merge and a null value removes a field. The provider owns the outer
routing envelope and the session ID. Tool declarations use `parametersJsonSchema`
and structured output uses `responseSchema` with bounded expansion of local
`$defs` references.
