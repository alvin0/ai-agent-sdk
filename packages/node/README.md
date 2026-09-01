# @ai-agent-sdk/node

Runtime: **Node 22.12+**.

```sh
pnpm add @ai-agent-sdk/node
```

One batteries-included Node facade over the canonical ai-agent-sdk packages.
It is re-export-only: all classes and contracts retain their leaf-package
identity. Importing it intentionally elevates the application runtime to Node.

```ts
import {
  ModelRegistry,
  defineAgent,
  fileSystemSkills,
  JsonlObservationJournalExporter,
  codexNodePlugin,
} from '@ai-agent-sdk/node'
```

Secondary capability boundaries are available as `/providers`,
`/observability`, `/filesystem`, `/mcp`, `/a2a`, `/env`, and `/codex`; `/core`
and `/agent` are identity-preserving convenience subpaths. The root also exposes
MCP and A2A as `mcp` and `a2a` namespaces to avoid colliding protocol types.

The Codex Node factories default to `.providers/.codex/auth.json` below the
current project. They never read or write `~/.codex/auth.json` implicitly.
Browser IndexedDB and page-lifecycle code is intentionally absent; use
`@ai-agent-sdk/observability-browser` explicitly in browser applications.
