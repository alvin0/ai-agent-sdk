# @alvin0/ai-agent-sdk-mcp-server

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

Universal MCP server hosting built only on Web Standards and the core runtime.

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-mcp-server
```

Use `createMcpServer()` for an inert `Request`/`Response` host surface. The
application owns authentication and mounting; each request owns its protocol
resources, so the returned server has no fabricated application cleanup handle.

```ts
import { createMcpServer } from '@alvin0/ai-agent-sdk-mcp-server'
```

Composition: `host.mcp-server`. Lifecycle: `inert-host-mounted`; the host owns
authentication and request mounting, while each request owns its resources.
