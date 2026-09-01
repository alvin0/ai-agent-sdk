# @ai-agent-sdk/observability-node

Runtime: **Node 22.12+**.

```sh
pnpm add @ai-agent-sdk/observability @ai-agent-sdk/observability-node
```

Node-only durable observation journal and explicit lifecycle/diagnostic helpers.
The journal root is always caller-supplied. Records use checksum-framed JSONL,
private directory/file modes, unique segments, atomic acknowledgment cursors,
bounded retention, and strict corruption recovery.

Exact provider-wire diagnostics are a separate high-risk capability and refuse
construction unless both `content: 'full'` and `allowWireBodies: true` are set.
Nothing installs process lifecycle handlers automatically.

Use `@ai-agent-sdk/observability-node/journal` when only durable journal and
lifecycle APIs are needed, or `@ai-agent-sdk/observability-node/diagnostic` for
the separately gated exact-wire capability. The root entry re-exports both.
