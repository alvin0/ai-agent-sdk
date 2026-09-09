# Installation

## Requirements

| Target | Requirement |
| --- | --- |
| Workspace tooling | Node **22.18** or newer |
| Installed Node capability packages | Node **22.12** or newer |
| Universal packages | Any Fetch-shaped runtime: Edge/Worker, Deno, Bun, browser, Node |
| Language | TypeScript with `moduleResolution: "bundler"` or `"nodenext"` |

## Install

> **Registry status.** Publication to npm is intentionally deferred while
> ownership is being arranged. The commands below document the intended install
> profiles. Current validation installs the generated tarballs or uses the
> workspace directly. See [10. Project Information](/en/14-project/).

Choose the smallest runtime closure you need.

**Edge/Worker with a remote provider and acknowledged HTTPS telemetry**

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/provider-openai \
  @ai-agent-sdk/observability-fetch
```

**Browser harness with IndexedDB crash recovery**

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/provider-openai \
  @ai-agent-sdk/observability-browser
```

**Node coding harness — only the capabilities it uses**

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/auth-node @ai-agent-sdk/provider-codex \
  @ai-agent-sdk/mcp-node @ai-agent-sdk/observability-node \
  @ai-agent-sdk/skill-filesystem
```

All three profiles share the same Universal core and agent loop.

## Credentials

Credentials are always **injected**. Provider packages are Universal and never
read environment variables or files themselves.

**Node, from the environment:**

```ts
import { envCredential } from '@ai-agent-sdk/auth-node'

openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })
```

`envCredential()` is lazy, receives the model-operation cancellation signal, and
is borrowed by the provider — it has no close lifecycle.

**Anywhere else, from your own secret store:**

```ts
openAiPlugin({ apiKey: () => secretStore.get('openai') })
```

**Codex, project-local device-code login:**

```bash
pnpm exec ai-agent-sdk-codex-login             # sign in
pnpm exec ai-agent-sdk-codex-login --status    # local account/status details
```

Tokens land in `.providers/.codex/auth.json` (git-ignored), **not** in the Codex
CLI's `~/.codex/auth.json`. This isolation is deliberate: OAuth refresh tokens
are single-use and rotate on every refresh, so two programs sharing one
credential file will eventually race — the second to refresh replays a spent
token and silently logs you out of your real Codex CLI.

## Verify the install

```ts
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'
import { envCredential } from '@ai-agent-sdk/auth-node'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })],
})

console.log(runtime.providers())
console.log(await runtime.modelCatalog('openai'))

await runtime.close()
```

If `providers()` lists your route and `modelCatalog()` returns models, the
composition and the credential both work.

## Repository development

If you are working on the SDK itself rather than consuming it:

```bash
pnpm install --frozen-lockfile
pnpm workspace:build
pnpm build:cli
```

## Read next

- [Your first agent](/en/01-introduction/quick-start)
- [Streaming a model call](/en/02-agents/streaming)
