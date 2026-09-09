# @ai-agent-sdk/provider-gemini

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

```sh
pnpm add @ai-agent-sdk/core @ai-agent-sdk/provider-gemini
```

Universal Gemini provider for ai-agent-sdk. It targets only Google's Gemini
Interactions endpoint at `/v1beta/interactions` and does not use
`generateContent` or the OpenAI-compatible Chat Completions endpoint.

Credentials are always injected. This package never reads `.env`, environment
variables, or files; a Node host may opt into `envCredential()` from
`@ai-agent-sdk/auth-node`.
