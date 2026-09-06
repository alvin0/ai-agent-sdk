# Testing and acceptance

Suites are separated by **what they cost** and **what they prove**.

## Test suites

| Command | Covers |
| --- | --- |
| `pnpm test:unit` | Root unit suite. Fast, no network. |
| `pnpm test:contract` | Frozen compatibility and runtime-identity contracts. |
| `pnpm test:packages` | Every package-owned suite. |
| `pnpm test:pack` | publint, ATTW, and all tarball/runtime fixtures. |
| `pnpm test:integration` | **Live provider calls.** Needs credentials and costs tokens. |

Integration tests are a separate run because they cost tokens and are slow enough
that mixing them in would discourage running the fast suite.

## Runtime matrix

| Command | Runtime |
| --- | --- |
| `pnpm test:edge` | Packed core, provider-http, mcp, observability-otel, plus the portable no-follow check |
| `pnpm test:browser` | Packed `observability-browser` |
| `pnpm test:node` | Packed `auth-node`, `mcp-node`, `mcp-node-server`, `skill-filesystem`, `observability-node` |
| `pnpm test:recovery` | Observability recovery paths |

## Static gates

| Command | Checks |
| --- | --- |
| `pnpm lint` | Package graph, dependency-cruiser, agent boundaries, runtime boundaries |
| `pnpm check:boundary-fixtures` | Proves invalid boundaries are actually **rejected** |
| `pnpm check:supply-chain` | Lockfile integrity, exact pins, lifecycle scripts, licences, `pnpm audit --prod` |
| `pnpm check:docs` | Documentation migration ledger |
| `pnpm workspace:typecheck` | Typecheck all publishable packages in graph order |
| `pnpm workspace:build` | Build all package-owned bundles and declarations |

`check:boundary-fixtures` matters more than it looks: a gate that never fails is
indistinguishable from no gate, so the suite asserts that invalid inputs are
rejected.

## What CI runs

```text
pnpm workspace:build && pnpm workspace:typecheck && pnpm build:cli
  && pnpm lint && pnpm exec tsc --noEmit
pnpm check:boundary-fixtures
pnpm check:supply-chain
pnpm test
pnpm test:packages
pnpm test:pack
```

Node 22.18.0, pnpm 11.25.0 installed with lifecycle scripts disabled, frozen
lockfile, and official GitHub actions pinned to immutable signed release commits.

## Provider conformance

For capability authors, `@ai-agent-sdk/testkit` drives a fresh provider fixture
through marker preflight, route conflicts, rollback, streaming, usage, retries,
cancellation, catalog behaviour, bounded-stream failure, observation
privacy/correlation, cleanup-failure containment, and idempotent cleanup.

```ts
import { runProviderConformanceSuite } from '@ai-agent-sdk/testkit'

const report = await runProviderConformanceSuite(fixture)
```

It is framework-independent: Vitest, `node:test`, or your own harness can consume
the frozen report or catch `ProviderConformanceError`.

## Human acceptance

Some things cannot be proven deterministically. The repository ships interactive
harnesses for manual acceptance against a real provider:

```bash
npm run human            # menu
npm run human:basic      # basic mode
npm run human:deep       # deep mode with submit_result self-check
npm run human:hil        # deep-human-in-loop
npm run human:web        # native web search
npm run human:vision     # image input
npm run human:image-gen  # image generation
npm run human:mcp        # credential-free MCP protocol round trip
npm run human:a2a-managed
npm run human:a2a-defined
```

`npm run human:mcp` is worth calling out: it performs a real initialize,
discovery, and tool call through linked MCP transports **without provider
credentials**, printing lifecycle states, discovered names, and the structured
round-trip result.

The A2A stress harnesses build a runnable site with concurrent agents, each
receiving an exact write allowlist. Model-requested npm-shaped gates are
translated to fixed Node permission-model invocations with a minimal environment;
package scripts, network, subprocesses, and access outside the disposable
workspace are denied. Host-owned fixture/build inputs are hash-verified after the
run.

## Deterministic evidence rules

The topology freezes how evidence is produced, so a passing run means the same
thing every time:

- privacy checks use **structural absence or non-ID sentinels**, not string
  matching;
- random-ID collisions remain **recorded** even when a focused rerun diagnoses
  them;
- live provider and network evidence is **manual**, never asserted by a
  deterministic suite.

Same-source dual compiles cover core message/provider and every agent domain —
tool, skill, memory/history/compaction, accounting/trace, loop/definition, and
team/messaging — both protocol packages, all six observability capability
entrypoints, and MCP client/server route mappings. The parity ledger is zero for
core, agent, base observability, protocols, observability capabilities, and MCP.

> Name presence alone is insufficient. Dual-source fixtures and explicit
> legacy/runtime protocol splits protect compatibility-sensitive semantics.

## What passing proves

| Gate | Proves | Does not prove |
| --- | --- | --- |
| `test:unit` / `test:contract` | Deterministic logic and frozen contracts | Real provider behaviour |
| `test:pack` | Packed tarballs install and run per runtime tier | Live provider behaviour |
| `test:integration` | Live provider calls work | Nothing about other accounts or model versions |
| Human harnesses | Real end-to-end behaviour a person observed | Anything a machine can re-verify |

## Read next

- [`@ai-agent-sdk/testkit`](/en/14-project/testkit)
- [Contributing](/en/14-project/contributing)
