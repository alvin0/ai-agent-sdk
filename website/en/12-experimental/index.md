# Experimental

> **Nothing in the SDK carries an `@experimental` marker.** There is no
> `experimental` export, no unstable namespace, and no opt-in flag for
> pre-release behaviour. Searching the source for `@experimental`, `@alpha`, or
> `@unstable` returns nothing.
>
> What *is* provisional is listed here explicitly, with the gate each one is
> waiting on. Treat this page as the honest answer to "what might change".

## 1. `@ai-agent-sdk/a2a` is Node-elevated, pending promotion

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

## 3. Registry publication is deferred

| Property | Status |
| --- | --- |
| Version | `0.1.0` |
| npm publication | **Intentionally deferred** while scope ownership is arranged |
| Current validation | Generated tarballs, or the workspace directly |

```bash
pnpm add ./artifacts/ai-agent-sdk-core-0.1.0.tgz
```

Every `pnpm add @ai-agent-sdk/...` command in this documentation describes the
**intended** install profile for a future registry release.

`@ai-agent-sdk/testkit` is additionally **private** and is exercised through
local workspace or tarball installs; publishing is intentionally not configured
for it at all.

## 4. Spikes are evaluations, not features

`spikes/` holds deliberately non-production evaluations. They are evidence that a
seam is adequate — **not** implementations you can import.

| Spike | Question it answered |
| --- | --- |
| `chat-completions-fit.ts` | Can Chat Completions fit the existing wire-protocol seam? |
| `history-substrate.ts` | Is the history substrate adequate for long tasks? |
| `step-budget.ts` | How should step budgets behave at exhaustion? |
| `persistence-boundary.ts` | Where should the persistence boundary sit? |
| `live-agent-modes.ts`, `live-native-capabilities.ts`, `live-tool-loop-trace.ts` | Live provider behaviour checks |
| `runtime-compat/` | Worker-runtime compatibility probes |

**What to do:** read them for rationale; do not depend on them. In particular,
`chat-completions-fit.ts` is *not* a Chat Completions protocol. The shipped
[Gemini](/en/09-providers/gemini) provider instead implements Interactions.

## 5. Token estimation is a deliberate placeholder

The neutral SDK cannot bundle every provider tokenizer, so the default meter is a
**conservative deterministic estimator** over text, tool schemas, replay state,
and fixed image costs.

Estimated values are never presented as provider-reported or
billing-authoritative. Applications needing exact pricing can set an absolute
`maxInputTokens`.

> Future tokenizer backends can replace the meter **without changing history or
> session contracts**. That is the stability guarantee: the estimator may improve,
> the surfaces around it will not move.

## What is *not* provisional

Worth stating, because these are the parts people most often assume are unstable:

- The neutral message, stream, usage, and error contracts.
- `createAgentRuntime()`, `defineAgent()`, `defineTool()`, and the session API.
- Runtime tiers and the static gate that enforces them.
- The public API ledgers in `design-contracts/` — 417 frozen export occurrences,
  hash-locked. Preservation is the default; every removal needs an approved
  decision plus a consumer migration path.

## Read next

- [A2A](/en/08-a2a/) — the Node-elevation note in context
- [Connecting Servers](/en/07-mcp/connecting-servers) — transport negotiation
- [Design contracts](/en/11-internals/design-contracts) — what "frozen" means here
- [Project Information](/en/14-project/) — versioning and release status
