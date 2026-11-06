# @alvin0/ai-agent-sdk-auth-node

Runtime: **Node 22.12+**.

Node-owned environment credentials and project-local Codex OAuth storage. The
package root and `/env` entrypoint are environment-only: installing either does
not require or load a model provider.

For an OpenAI agent whose key comes from the environment:

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai @alvin0/ai-agent-sdk-auth-node
```

```ts
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })],
})
```

`envCredential()` is lazy, receives the model-operation cancellation signal and
remains callable for compatibility. It is borrowed by the provider and has no
close lifecycle.

Codex support is an explicit optional closure:

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-codex @alvin0/ai-agent-sdk-auth-node
```

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { codexNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/codex'

const runtime = await createAgentRuntime({
  providers: [codexNodeProviderPlugin()],
})
```

`codexNodeProviderPlugin()` uses the revisioned `fileCodexCredentialStore()` by
default. The store is borrowed and remains caller-owned; the runtime closes the
provider registration, not the store. Codex defaults to
`.providers/.codex/auth.json` below `process.cwd()` and never uses the Codex
CLI's global credential file. Writes use compare-and-swap under a cross-process
writer lock, a private same-directory temporary file, file sync, atomic rename,
mode `0600`, and directory sync. Credential-file symlinks are rejected.

The deprecated `fileCodexAuthStore()` and `codexNodePlugin()` retain the former
`read/write` compatibility contract. New runtime composition should use the
revisioned factory above.

Run `ai-agent-sdk-codex-login` after installation to authenticate this project.
Add `--account <name>` (also on `ai-agent-sdk-copilot-login`) to sign in an extra
account, stored at `.providers/.<provider>/accounts/<name>.json`, and select it
with `codexNodeProviderPlugin({ id, account: '<name>' })` /
`copilotNodeProviderPlugin({ id, account: '<name>' })` — for example as a backup
member of core's `failoverProviderPlugin`, which moves calls to the next account
or provider when one is expired, rate-limited, out of quota or down.
By default it signs in with a device code, which the ChatGPT account must allow
(device code authorization in its security settings). `ai-agent-sdk-codex-login
--browser` signs in straight through the browser instead, as the Codex CLI does:
it listens on `http://localhost:1455/auth/callback` (loopback only), opens the
authorization page, and stores the tokens once the browser returns there with
this login's `state`. It needs a browser on the same machine (or port 1455
forwarded); on a remote shell use the device code. In code, call
`runBrowserLogin(store, { port?, timeoutMs?, signal? }, { onPrompt })` from
`@alvin0/ai-agent-sdk-auth-node/codex`; `GET /cancel` on the listener stops it,
so a newer login can take the port.

## Concurrent requests over HTTP/2

Node 26's built-in `fetch` (undici 8) negotiates HTTP/2 but serializes POST
requests on an established session, so concurrent model calls to one provider
stream one after another ([nodejs/undici#5390](https://github.com/nodejs/undici/issues/5390)).
`createNodeHttp2Fetch()` keeps HTTP/2 and multiplexes each request as its own
stream on a shared `node:http2` session.

`codexNodeProviderPlugin()` and `copilotNodeProviderPlugin()` use one shared
instance of it by default. They keep the platform `fetch` when the caller passes
`fetch` (pass `fetch: globalThis.fetch` to opt out) or when `HTTPS_PROXY`,
`HTTP_PROXY` or `ALL_PROXY` is set, because this transport does not use proxies.
They also send a request through the global `fetch` while the application has
replaced it (MSW, `vi.stubGlobal('fetch', …)`, nock, or a fetch-patching
instrumentation, whether installed before or after this package loaded) or has
installed its own global dispatcher with `setGlobalDispatcher` (a proxy, a mock,
or an `Agent` with custom `connect` options such as a CA). Instrumentation that
observes undici through `diagnostics_channel` without replacing `fetch` does not
see requests on this transport; pass `fetch: globalThis.fetch` to keep it.
Universal providers such as `openAiPlugin()` take it explicitly:

```ts
import { createNodeHttp2Fetch } from '@alvin0/ai-agent-sdk-auth-node/http2'

const fetch = createNodeHttp2Fetch()
const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY'), fetch })],
})
// On shutdown, after runtime.close():
await fetch.close()
```

A session carries up to the server's `SETTINGS_MAX_CONCURRENT_STREAMS` (capped
by `maxStreamsPerSession`, default 100) before another is opened; idle sessions
close after `idleTimeoutMs` and never keep the process alive. Responses are
decoded like `fetch` (gzip, deflate, br), aborts reset the stream, and
redirects follow Fetch rules. `http:` URLs, origins that do not negotiate h2
and connection failures go through `fallback` (default: global `fetch`, or the
one it replaced when this transport is installed as `globalThis.fetch`); an
origin that does not negotiate h2 goes straight to the fallback for
`fallbackTtlMs` (default 5 min); one whose connect failed for another reason
(DNS, refused, timed out) does so for at most 5 s. A response body that waits on
a reader that is not reading keeps its stream slot but not the process alive.
As with `fetch`, a body nobody holds any more (its `Response` and any kept
`response.body` were garbage-collected before anyone started reading it) cancels
the stream, releasing its slot, even when the server keeps the stream open; a
kept `response.body` stays readable. A body whose server sends nothing for
`bodyTimeoutMs` (default 5 min, as undici's `bodyTimeout`) while the body waits
for data fails and resets its stream; time spent waiting on a reader that is not
reading does not count. After `close()`, requests reject.

Composition: `provider-factory.credentials`. Lifecycle: `borrowed-caller-owned`;
`envCredential()` and file-backed stores are resolved lazily by the selected
provider and are never closed by core.
