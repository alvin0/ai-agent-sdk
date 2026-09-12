# @alvin0/ai-agent-sdk-provider-gemini

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-gemini
```

Universal Gemini provider for ai-agent-sdk. It targets only Google's Gemini
Interactions endpoint at `/v1beta/interactions` and does not use
`generateContent` or the OpenAI-compatible Chat Completions endpoint.

Credentials are always injected. This package never reads `.env`, environment
variables, or files; a Node host may opt into `envCredential()` from
`@alvin0/ai-agent-sdk-auth-node`.

Unknown models now default to a conservative 200,000-token operating context.
Verified Pro model policies stay at 200,000 to avoid the higher long-context price
tier; verified Flash policies can use 1,000,000. Set `models[].contextWindow` to
override, or `defaultContextWindow` at provider level. See the
[context policy guide](../../web-documents/en/09-providers/index.md).
