# Package topology

The current topology is enforced by `scripts/package-policy.mts`, package
manifests, and the graph/runtime-boundary gates on every change.

## What is enforced

`PACKAGE_RULES` in `scripts/package-policy.mts` is the normative graph. For every
package it records the runtime tier, the workspace dependencies it may have, and
the external runtime dependencies it directly owns.

The CI gates check the real manifests and the real import graph against it:

| Gate | Rejects |
| --- | --- |
| `check-package-graph` | A manifest whose dependencies differ from the recorded rule |
| `check-dependency-cruiser` | An import edge the graph does not allow |
| `check-runtime-boundaries` | A Universal package reaching a Node builtin |
| `check-agent-boundaries` | An agent-layer edge that would create a concrete team dependency |

Adding a package means adding one entry to `PACKAGE_RULES`. There is no separate
ledger to keep in sync.

## Runtime tiers and their baselines

| Tier | Host feature baseline |
| --- | --- |
| **Universal** | Web Platform: ECMAScript, Fetch-compatible types, Web Streams, `AbortController`, performance timing, Web Crypto |
| **Browser** | The Universal baseline plus IndexedDB and optional page lifecycle APIs |
| **Node** | Node 22.12 built-ins: filesystem, `process`, child processes, stdio |

Schema v5 freezes these baselines explicitly, **so a runtime label cannot pass
merely because the imports look clean**.

## The 20 target packages

| Package | Tier | Roles |
| --- | --- | --- |
| `core` | universal | core-runtime |
| `provider-http` | universal | provider-extension-kit |
| `protocol-responses` | universal | wire-protocol |
| `protocol-anthropic-messages` | universal | wire-protocol |
| `protocol-gemini-interactions` | universal | wire-protocol |
| `provider-openai` | universal | model-provider |
| `provider-anthropic` | universal | model-provider |
| `provider-codex` | universal | model-provider |
| `provider-gemini` | universal | model-provider |
| `mcp` | universal | mcp-client, tool-source |
| `mcp-server` | universal | mcp-server |
| `mcp-node` | node | mcp-client-transport |
| `mcp-node-server` | node | mcp-server-transport |
| `a2a` | node | agent-transport |
| `auth-node` | node | credential-source, credential-store |
| `skill-filesystem` | node | skill-provider |
| `observability-fetch` | universal | observation-exporter |
| `observability-otel` | universal | observation-processor |
| `observability-browser` | browser | observation-exporter |
| `observability-node` | node | observation-exporter, diagnostics |

(`testkit` is a private dev-only package outside the published target set.)

## Multi-entry packages

Five packages have more than one public entrypoint:

| Package | Entrypoints |
| --- | --- |
| `core` | `.` `./agent` `./memory` `./provider` `./skills` `./tools` `./observability` |
| `auth-node` | `.` `./env` `./codex` |
| `a2a` | `.` `./client` `./server` |
| `mcp` | `.` `./client` `./server` |
| `observability-node` | `.` `./journal` `./diagnostic` |

MCP `/server` and auth `/codex` are **optional-peer views**; identity routes are
recorded separately.

## Manifest rules

All 20 packages:

- **forbid wildcard and `require` routes**;
- include an explicit `"./package.json"` export;
- render a non-executable `aiAgentSdk` metadata object from the topology —
  `runtime`, `coreApi: 1`, and a bounded plural `roles` list.

That metadata is **documentation and release metadata only**. Runtime code never
scans it and never auto-loads a plugin from it.

Manifest policy also preserves non-TypeScript install surfaces: common packed
files, `auth-node`'s Codex-login binary and `bin` directory, root `main`/`types`
mirrors, and Node-only engine metadata.

## Dependency classification

The topology defines the exact source-manifest encoding for:

- normal dependencies;
- required core peers;
- optional workspace peers and metadata;
- external runtime dependencies;
- required and optional external API peers.

The checker rejects:

| Violation | Why it matters |
| --- | --- |
| A dependency/optional-peer overlap | Ambiguous ownership of a version. |
| An optional peer without an owning route | Nothing would ever load it. |
| Runtime elevation through an unclassified optional route | A Universal package silently becoming Node. |
| Conflicting exact external selections | Two packages pinning different versions of one dependency. |

Optional peers enter a closure **only when directly selected**.

## Install closures

`pnpm test:pack` packs every publishable package and installs the resulting
tarballs into throwaway fixtures, so a package-local runtime error or a hidden
dependency shows up as a failing install rather than at a user's first import.

## The install recipes

Eight `pnpm add` recipes are checked against exact journey package sets: five
application compositions and three third-party provider authoring paths. That
keeps support packages transitive for normal consumers while making the extension
surface directly approachable.

## Read next

- [Package map](/en/01-introduction/getting-started)
