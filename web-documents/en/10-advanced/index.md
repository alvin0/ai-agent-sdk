# Advanced — Overview

Everything here is about **running this in production** rather than getting it
working. The material assumes you have read [Agents](/en/02-agents/) and
[Tools](/en/03-tools/).

| Page | Answers |
| --- | --- |
| [Error Handling](/en/10-advanced/error-handling) | The SDK-wide taxonomy, retry policy, and every code |
| [Observability](/en/10-advanced/observability) | The observation bus, usage coverage, and how to configure it |
| [Security](/en/10-advanced/security) | Credentials, endpoint policy, privacy defaults |
| [Performance](/en/10-advanced/performance) | Every bound, budget, and token-accounting decision |
| [Production Deployment](/en/10-advanced/production-deployment) | Startup, shutdown, and per-runtime checklists |
| [Troubleshooting](/en/10-advanced/troubleshooting) | Symptom → cause → fix |
| [Edge Worker](/en/10-advanced/deploy-edge-worker) · [Node CLI](/en/10-advanced/deploy-node-cli) · [Browser](/en/10-advanced/deploy-browser) | Complete working compositions |

## The four things production actually needs

**1. Read the close report.** Not as a formality — as evidence.

```ts
const report = await runtime.close()
if (report.unsettledRuns > 0) alert('something ignored cancellation')
```

**2. Read usage *coverage*, not just totals.**

```ts
response.report.coverage        // logical calls, physical attempts, missing counts
response.report.authoritative   // may this be called a total at all?
```

`reported` is a **lower-bound sum** when coverage is incomplete. Never label a
non-authoritative figure "total cost".

**3. Register an exporter that states its real durability.**

```ts
{ exporter, ownership: 'owned', requirement: 'required', boundary: 'local-durable' }
```

Memory delivery **never** claims durability. `reliable` and `audit` delivery
modes require a durable exporter package.

**4. Bound the loop for the workload, not for the demo.**

```ts
runtimeLimits: { maxTotalTokens: 250_000, maxToolDurationMs: 120_000 }
```

Defaults are safe for unattended use — 16 model steps, 64 dispatched tools, a
500,000 aggregate reported-token ceiling — but they are not tuned for your cost
model.

## What the SDK gives you, and what stays yours

This package is an **SDK, not a production control plane**.

| SDK provides | You provide |
| --- | --- |
| Bounded state, TTL, cancellation, disposal | Authentication middleware |
| Typed error taxonomy and sanitized error records | Durable stores |
| A structured observation bus with privacy defaults | Rate limiting |
| Explicit ownership and close evidence | Network and DNS enforcement |
| Policy hooks at every boundary | Secrets management |
| Runtime tiers enforced by a static gate | Deployment and telemetry backends |

Every limit in this chapter is a **deployment-neutral resource guard**. None of
them is a tenant, a billing plan, or a control-plane feature.

## Runtime tiers decide your package set

| Tier | Constraint | Packages |
| --- | --- | --- |
| **Universal** | Web Standards only | core, provider-*, protocol-*, mcp, mcp-server, observability-fetch, observability-otel |
| **Browser** | IndexedDB, page lifecycle | observability-browser |
| **Node** | Node 22.12+ built-ins | auth-node, mcp-node, mcp-node-server, skill-filesystem, observability-node, a2a |

A static gate rejects a Universal declaration that imports a Node builtin, and
rejects an Edge journey elevated by a Node capability. If your Edge bundle pulled
in `node:fs`, a Node-tier package entered the graph — see
[Troubleshooting](/en/10-advanced/troubleshooting).

## Internals live next door

Package topology, the adapter pipeline, and the design-contract gate are in
[Internals](/en/11-internals/). Read those when you are extending the SDK rather
than deploying it.
