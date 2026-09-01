# ai-agent-sdk

Runtime: **Mixed facade**. The root entry is Universal; optional legacy subpaths
have the runtime shown in the table below.

Compatibility facade for applications migrating to the modular packages. The root entry is Universal and contains no environment, filesystem, stdio, IndexedDB, or Node lifecycle capability. New applications should prefer the scoped packages; full Node applications can use `@ai-agent-sdk/node`.

```sh
pnpm add ai-agent-sdk
```

The root entry includes the Universal core, agent, configurable Fetch/SSE provider, and both built-in wire protocols. `apiKeyFromEnv` moved to `@ai-agent-sdk/auth-node/env`; use `envCredential` in Node or inject a credential resolver in Universal code.

Legacy subpaths remain through the 1.x compatibility line, but their leaf implementation is an optional peer and must be installed explicitly:

| Import | Runtime | Install |
|---|---|---|
| `ai-agent-sdk/anthropic` | Universal | `pnpm add ai-agent-sdk @ai-agent-sdk/provider-anthropic` |
| `ai-agent-sdk/openai` | Universal | `pnpm add ai-agent-sdk @ai-agent-sdk/provider-openai` |
| `ai-agent-sdk/codex` | Node | `pnpm add ai-agent-sdk @ai-agent-sdk/auth-node` |
| `ai-agent-sdk/a2a-client` or `/a2a-server` | Node | `pnpm add ai-agent-sdk @ai-agent-sdk/a2a` |
| `ai-agent-sdk/mcp-client` or `/mcp-server` | Universal | `pnpm add ai-agent-sdk @ai-agent-sdk/mcp` |
| `ai-agent-sdk/mcp-node` | Node | `pnpm add ai-agent-sdk @ai-agent-sdk/mcp-node` |
| `ai-agent-sdk/skill-filesystem` | Node | `pnpm add ai-agent-sdk @ai-agent-sdk/skill-filesystem` |
| `ai-agent-sdk/request-logger` | Node, high-risk opt-in | `pnpm add ai-agent-sdk @ai-agent-sdk/observability-node` |
| `ai-agent-sdk/node` | Node | `pnpm add ai-agent-sdk @ai-agent-sdk/node` |

The Anthropic and OpenAI compatibility entries now use their Universal adapters, so pass `apiKey` explicitly. No import prints a migration warning.
