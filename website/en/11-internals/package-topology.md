# Package topology

The current topology is enforced by `scripts/package-policy.mts`, package
manifests, and the graph/runtime-boundary gates on every change.

## What the topology freezes

The workspace records **20 target packages and 34 public specifiers**:

- each package's runtime tier and the exact host feature baseline it assumes;
- the core-peer rule, normal workspace closure, and optional peers;
- seven exact external runtime dependency/peer declarations;
- one recommended named entrypoint, typed composition slot, audience, and
  lifecycle/ownership rule per non-core package;
- explicit conditional export maps for every package
  (`manifest-blueprints.json`);
- the resulting install closure for **25 compile journeys**
  (`install-closures.json`).

Packages not used by a current journey still receive a declaration ownership
placeholder — nothing is silently unowned.

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

`install-closures.json` freezes the workspace, required-external, and effective
runtime closure for all 25 compile journeys. It also probes **every one of the 17
retained non-core packages when selected directly beside core**, so one large
Node journey cannot mask an incorrect package-local runtime or a hidden
dependency.

## The install recipes

Eight `pnpm add` recipes are checked against exact journey package sets: five
application compositions and three third-party provider authoring paths. That
keeps support packages transitive for normal consumers while making the extension
surface directly approachable.

## Read next

- [Design contracts](/en/11-internals/design-contracts)
- [Package map](/en/01-introduction/getting-started)
