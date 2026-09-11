# Internals — Overview

For contributors, provider authors, and anyone debugging behaviour the
user-facing docs do not explain.

| Page | Covers |
| --- | --- |
| [Package topology](/en/11-internals/package-topology) | 23 target packages, 38 specifiers, runtime tiers, dependency rules |
| [Adapter pipeline](/en/11-internals/adapter-pipeline) | What a provider supplies and what the base class owns |

## The two structural rules

Most of the architecture follows from two rules.

**Adapters are the only layer that knows a wire format.** Everything above
speaks the neutral vocabulary in `core/`.

**`stream()` lives in the base class, not in providers.** A provider supplies
four things — `connect`, `endpointPath`, `buildBody`, `translate` — and cannot
accidentally ship its own fetch loop that forgets attribution headers,
mishandles abort, or invents error codes.

## Layering inside core

Read the folders in dependency order. It is the design, not an accident:

```text
primitives/     branded ids, deep freeze, exhaustiveness   ← no dependencies
async/          bounded-settlement primitives
observation/    correlation, usage, telemetry ports
plugin/         transactional provider extension contracts
errors/         the code-routed taxonomy and its serializable twin
message/        content blocks, immutable messages, projection
stream/         chunk protocol, assembler, SSE and idle bounds
contract/       what an adapter implements and receives
runtime/        the registry that routes calls, and retry
http/           credential and attribution concerns adapters share
```

## Runtime tiers are enforced, not documented

Every package declares `universal`, `browser`, or `node`. A static gate rejects:

- a Universal declaration that imports a Node package or builtin;
- an Edge journey elevated by a Node capability;
- undeclared or forbidden facade imports;
- drift between `tsconfig` package mappings and the topology;
- direct package selections that no longer match their documented recipe.

## The repository layout

```text
packages/core                 Universal runtime, agent, observability, contracts, registry
packages/provider-http        shared Fetch/SSE transport
packages/protocol-*           reusable wire protocols
packages/provider-*           explicit provider plugins
packages/observability-*      runtime-specific exporters and bridges
packages/auth-node, mcp-node  explicit Node elevation
docs/                         design documents and implementation evidence
test-human/                   interactive acceptance harnesses
website/                      this documentation site
```

## Where the design record lives

`docs/` holds the reasoning behind these pages: `tool-loop-design.md`,
`observability-and-usage-architecture.md`,
`core-capability-composition-design.md`, `monorepo-package-architecture.md`, and
`dependency-policy.md`.

This chapter summarizes them. When the two disagree, the source of truth is the
code plus `scripts/package-policy.mts`, which the CI graph and runtime-boundary
gates enforce on every change.
