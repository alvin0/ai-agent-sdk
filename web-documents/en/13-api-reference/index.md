# API Reference — Overview

Curated reference, one page per package family. Each page lists the public
entrypoints, the exports that matter, and a usage shape.

> **Public surface rule.** The documented root plus the listed subpaths are
> public. Internal source paths are **not** compatibility contracts — deep
> imports into `dist/` or `src/` internals will break without a major version.

## Packages

| Page | Packages covered | Runtime |
| --- | --- | --- |
| [core](/en/13-api-reference/core) | `@alvin0/ai-agent-sdk-core` and its 6 subpaths | Universal |
| [Agent](/en/13-api-reference/agent) · [Tool](/en/13-api-reference/tool) · [Workflow](/en/13-api-reference/workflow) · [Memory](/en/13-api-reference/memory) · [Types](/en/13-api-reference/types) | Per-concept reference | Universal |
| [Providers](/en/09-providers/) | `provider-openai`, `provider-anthropic`, `provider-codex`, `provider-gemini`, `provider-http` | Universal |
| [Protocols](/en/09-providers/protocols) | `protocol-responses`, `protocol-anthropic-messages`, `protocol-gemini-interactions` | Universal |
| [Observability](/en/13-api-reference/observability) | `observability-fetch`, `-otel`, `-browser`, `-node` | mixed |
| [MCP](/en/07-mcp/mcp-client) | `mcp`, `mcp-server`, `mcp-node`, `mcp-node-server` | mixed |
| [A2A](/en/08-a2a/remote-agents) | `a2a` | Node |
| [auth-node](/en/09-providers/auth-node) | `auth-node` | Node |
| [skill-filesystem](/en/04-skills/loading-skills) | `skill-filesystem` | Node |
| [testkit](/en/14-project/testkit) | `testkit` (dev-only) | Universal |

## Composition slots at a glance

Every non-core package documents where it plugs in and who closes it.

| Package | Composition slot | Lifecycle |
| --- | --- | --- |
| `provider-openai` / `-anthropic` / `-codex` / `-gemini` | `runtime.providers` | `inert-runtime-owned-registration` |
| `provider-http` | `provider-author.adapter` | `inert-value` |
| `protocol-*` | `provider-author.protocol` | `inert-value` |
| `mcp`, `mcp-node` | `runtime-agent.toolSources` | `connected-caller-owned` |
| `mcp-server` | `host.mcp-server` | `inert-host-mounted` |
| `mcp-node-server` | `host.mcp-server` | `host-owned` |
| `a2a` | `runtime-team.linkAgent` | `borrowed-caller-owned` |
| `auth-node` | `provider-factory.credentials` | `borrowed-caller-owned` |
| `skill-filesystem` | `runtime-agent.skills` | `borrowed-caller-owned` |
| `observability-fetch` / `-node` / `-browser` | `runtime.observability.exporters` | `explicit-owned-or-borrowed` |
| `observability-otel` | `runtime.observability.openSpan-processors` | `borrowed-caller-owned` |

## Reading the lifecycle labels

| Label | Means |
| --- | --- |
| `inert-value` | Creating it performs no I/O and it has no close obligation. |
| `inert-runtime-owned-registration` | The runtime activates and removes the captured registration. |
| `connected-caller-owned` | You connect it and you close it — after closing the runtime. |
| `borrowed-caller-owned` | The runtime uses it but never closes it. |
| `host-owned` | You call `close()` and read the returned report. |
| `explicit-owned-or-borrowed` | Ownership is stated at registration time. |
