# Design contracts

`design-contracts/core-capability-v1/` is a **design artifact, not package
implementation**. It answers one question before source migration: do the
recommended package names and public TypeScript shapes support the intended
consumer journeys, using the imports consumers would actually write?

No JavaScript is emitted. No provider, network, package installation, or runtime
fixture is executed.

## What is in there

| Kind | Files |
| --- | --- |
| Declaration stubs + consumer fixtures | `consumers/*.ts` — 25 compile journeys |
| Strict compile configs | `tsconfig.declarations-*.json`, `tsconfig.current-*.json` |
| Frozen API ledgers | `api-migration.json`, `implementation-api-I*.json`, `retained-package-api-baseline.json`, `provider-api-baseline.json` |
| Topology and manifests | `topology.json`, `manifest-blueprints.json`, `install-closures.json` |
| Migration state | `source-migration.json`, `documentation-migration.json` |
| Approved decisions | `phase0-decisions.json` |

## Run the gate

```bash
pnpm check:core-capability-contract
```

## The journeys

Consumer fixtures cover minimal Edge, extended Edge, minimal Node, Node
environment-credential convenience, and full Node harness — plus author journeys:

- a third-party **Universal provider** composed through the public core,
  transport, and protocol contracts, with no generic plugin container;
- a **core-only author** subclassing the advanced adapter contract directly for
  non-HTTP providers, including stream, model metadata, accounting, middleware,
  and cleanup;
- **two accounts of the same provider family** composed through distinct instance
  IDs and routes;
- core-only authors implementing Universal credential source/store,
  skill-provider, optimistic memory-store, observation-exporter, and live
  tool-source families.

The declarations deliberately do **not** import current `agent` or
`observability` packages, and consumer fixtures do not receive an injected
runtime factory.

## Three strict declaration configs

| Config | Scope |
| --- | --- |
| `tsconfig.declarations-node.json` | All target declarations and consumers; `skipLibCheck: false`; NodeNext resolution; explicit Node types |
| `tsconfig.declarations-web-base.json` | Ten non-Node packages except MCP client/server, plus eight author fixtures; `types: []` |
| `tsconfig.declarations-web-full.json` | All twelve Universal/Browser packages, including MCP |

All three are compile-only local checks. **None replaces packed runtime
acceptance.**

> The `web-full` config passes with no Node ambient types, shim, diagnostic
> baseline, or `skipLibCheck` waiver: the former upstream `Buffer` closure is
> isolated by SDK-owned portable declarations. Runtime code remains on MCP 2.0.0,
> while emitted SDK declarations no longer name its root-exported
> `ReadBuffer.append(chunk: Buffer)`.

## The API ledgers

**`api-migration.json`** freezes 417 current public API export occurrences and
their generated declaration hashes — 415 root exports plus the two available only
through `@ai-agent-sdk/agent/skill-validation`.

> Journey declarations are intentionally focused and **cannot authorize deletion
> of an unmentioned symbol**. Preservation is the default; every removal needs an
> approved decision plus consumer migration.

**`implementation-api-I1.json` / `-I2.json`** are phase snapshots of the emitted
declaration closure. While a phase is current, the checker compares that closure
byte-for-byte; after `currentImplementationSlice` advances, it treats the record
as historical, validates its structure and routes, then applies the exhaustive
baseline and parity checks to the current canonical declarations.

That distinction matters: it stops a historical phase snapshot from forbidding
reviewed additive declarations in a later slice.

**`retained-package-api-baseline.json`** freezes 19 public entrypoints, their
declaration hashes, and 344 export occurrences for A2A, auth, MCP, filesystem
skills, wire protocols, and observation exporters. The exact empty gap is
hash-locked so later drift cannot silently reopen parity. It separately
inventories all 53 intentionally moved export occurrences.

**`provider-api-baseline.json`** keeps its original 84-symbol inventory as
historical evidence. Current provider declarations must contain exactly that
baseline **plus** the named, reviewed additions — the checker rejects both
missing legacy symbols and undeclared additions.

## What the checker rejects

| Violation |
| --- |
| A Universal declaration importing a Node package or builtin |
| An Edge journey elevated by a Node capability |
| Undeclared or forbidden facade imports |
| Drift between `tsconfig` package mappings and the topology |
| Direct package selections that no longer match their documented recipe |
| Changed original/current declaration hashes |
| Extra declaration sidecars or stale source states |
| Copied implementations, partial roots, public-core self-imports, cycles |
| Anything beyond the exact route-complete compatibility bridge at an old owner |
| Restoration of the removed obsolete runtime-spike test |

## The public root

The public root is a **curated re-export-only facade** with exactly 264 names:
all 184 current core-root exports plus 80 reviewed everyday composition
additions.

Focused core subpaths and the public root are **views over one internal canonical
implementation owner**. They never own copied classes, interfaces, registries,
buses, or singleton state. The collision check compares the actual shared
declaration binding imported by both core entrypoints; negative tests reject
copied declarations and same-named imports from different owners.

## Phase 0 decisions

Fourteen normalized decision IDs live in `phase0-decisions.json` and are reviewed
in `docs/core-capability-phase0-approval.md`. The record is `approved` following
the owner's explicit approval and per-agent model-default amendment.

The checker rejects missing IDs, approval without owner/time attribution, target
package/specifier/root-export-count drift, diagnostics-budget drift, and
Markdown/JSON ID drift.

## What passing does and does not prove

**Proves:** compile-time composition. The recommended package names and public
shapes support the intended consumer journeys.

**Does not prove:** that future packages export these declarations, that their
packed closures obey runtime tiers, or that Edge/Node execution works. Those are
post-migration exit gates — installed-tarball compilation plus packed
Node/Chromium/Workerd tests.

Approval permits staged source migration. A passing static contract alone is
**not** runtime or release acceptance.

## Read next

- [Package topology](/en/11-internals/package-topology)
- [Testing and acceptance](/en/14-project/testing)
