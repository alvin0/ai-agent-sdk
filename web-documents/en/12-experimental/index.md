# Experimental

Experimental program tools are explicit, opt-in additions in 0.1.5. Session `experimentalPrograms` grants enable child
calls; tools may declare `experimentalOutputSchema` for child-result validation.
Ordinary tools do not require either option. Other provisional areas and their
runtime boundaries are listed below.

## 1. `@alvin0/ai-agent-sdk-a2a` is Node-elevated, pending promotion

| Property | Status |
| --- | --- |
| Declared runtime tier | `node` |
| Reason | The upstream binary codec calls `Buffer.from` for raw binary `Part` serialization |
| Works today | Text, structured data, URLs, and binary values — on Node |
| Provisional part | Text paths happen to work in strict Workers |
| Gate | A committed **negative promotion gate** must pass without Node globals |

Until that gate passes, the package **must not be advertised for Edge/Worker
runtimes**, even though a text-only workload may appear to run there.

**What to do:** treat A2A as Node-only in your deployment planning. If you need
cross-service agents on Edge, put the A2A hop behind a Node service.

The `.` root plus `./client` and `./server` remain compatibility aliases over the
same implementation — that aliasing is stable, not provisional.

## 2. MCP legacy SSE transport is a migration path only

| Property | Status |
| --- | --- |
| Preferred transport | Streamable HTTP |
| Provisional | The deprecated SSE fallback, attempted **once** on non-auth startup failure |
| Visibility | `state.protocol` exposes `era`, exact `version`, `transport`, and `fallback` |

```ts
createMcpHttpClient({ serverName: 'inventory', url, legacySse: false })
```

SSE exists to reach older servers. **New MCP deployments should use Streamable
HTTP**, and the fallback is deliberately observable so a legacy deployment does
not hide in a health UI.

**What to do:** publish `state.protocol` in your health surface, and set
`legacySse: false` once every server you talk to has migrated.

## 3. Registry packages use the `@alvin0` scope

| Property | Status |
| --- | --- |
| Version | `0.1.8` |
| npm publication | Merge to `main` triggers guarded publication |
| Release path | A `main` merge triggers guarded npm publication with provenance |

```bash
pnpm add ./artifacts/alvin0-ai-agent-sdk-core-0.1.8.tgz
```

Every `pnpm add @alvin0/ai-agent-sdk-...` command in this documentation uses the
intended registry package name. Use local tarballs for pre-release validation until
the requested version is available on npm.

`@alvin0/ai-agent-sdk-testkit` is additionally **private** and is exercised through
local workspace or tarball installs; publishing is intentionally not configured
for it at all.

## 4. Token estimation is a deliberate placeholder

The neutral SDK cannot bundle every provider tokenizer, so the default meter is a
**conservative deterministic estimator** over text, tool schemas, replay state,
and fixed image costs.

Estimated values are never presented as provider-reported or
billing-authoritative. Applications needing exact pricing can set an absolute
`maxInputTokens`.

> Future tokenizer backends can replace the meter **without changing history or
> session contracts**. That is the stability guarantee: the estimator may improve,
> the surfaces around it will not move.

## 5. Program tools require application grants

Use `experimentalNestedToolPort` only inside a granted exclusive program tool.
Child calls share existing policy, approval, checkpoint, cancellation, and tool
budget boundaries. `defineActionFusion` builds a sequential tool/grant pair;
it does not provide rollback or automatic mutation replay.
See [program tools](/en/12-experimental/programmatic-tools) and
[upgrading from 0.1.4](/en/01-introduction/upgrading-from-0-1-4).

## What is *not* provisional

Worth stating, because these are the parts people most often assume are unstable:

- The neutral message, stream, usage, and error contracts.
- `createAgentRuntime()`, `defineAgent()`, `defineTool()`, and the session API.
- Runtime tiers and the static gate that enforces them.
- The package graph in `scripts/package-policy.mts`, enforced by the CI graph and
  runtime-boundary gates on every change.

## Read next

- [A2A](/en/08-a2a/) — the Node-elevation note in context
- [Connecting Servers](/en/07-mcp/connecting-servers) — transport negotiation
- [Project Information](/en/14-project/) — versioning and release status
