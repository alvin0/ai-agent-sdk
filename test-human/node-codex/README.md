# Full Node SDK Codex-like human harness

This is the Node counterpart to `edge-chat`. It imports core plus the exact
stdio, filesystem-skill, and durable-observability capabilities and renders a
coding-agent run in the terminal. The hermetic adapter is deterministic, but
every surrounding boundary is real:

- lazy filesystem skill discovery, activation, and resource reading;
- workspace-confined list/read/write tools and shell-free `node --check`;
- a separately supervised MCP stdio server and bridged MCP tool;
- multi-step agent loop, canonical events, authoritative token usage;
- reliable JSONL runtime exporter with checksum-verified recovery checks;
- JSON-safe session snapshot and resume.

```bash
pnpm human:node-codex
pnpm human:node-codex -- --repeat 8 --parallel 4
pnpm human:node-codex -- --run-id manual-node
pnpm human:node-codex -- --dry-run
```

Each run keeps its generated workspace under
`test-human/workspaces/node-codex/<run-id>` and support-safe evidence under
`test-human/results/node-codex/<run-id>`. It does not require provider credentials
and never publishes a package. The existing live `human:agentcode` harness remains
the provider-backed interactive REPL; this harness is the reproducible explicit-capability
acceptance gate suitable for CI and runtime regression diagnosis.
