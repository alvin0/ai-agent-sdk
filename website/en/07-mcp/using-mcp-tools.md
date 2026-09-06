# Using MCP Tools

## Attach the connection as a tool source

```ts
const agent = runtime.agent({
  id: 'support',
  model,
  instructions: 'Use the connected tools when needed.',
  toolSources: [mcp],       // not `tools` — a whole catalog, not one function
  tools: [localTool],       // your own host functions still work alongside
})
```

`toolSources` and `tools` are separate slots. Host tools are values you own;
a tool source is a **versioned catalog** that can change revision underneath you.

## Names are prefixed

Remote tools appear as `mcp__<serverName>__<tool>`:

```text
serverName: 'billing'  +  lookup_invoice  →  mcp__billing__lookup_invoice
```

The prefix prevents collisions when several servers publish the same raw name —
two servers both offering `search` would otherwise be indistinguishable to the
model.

```ts
prefixToolNames: false
```

Available **only** when the host already guarantees a unique namespace. If you
turn it off and two catalogs collide, you get a
`CapabilityIdentityConflict` rather than a silent shadowing.

## Filtering what the model sees

```ts
connectMcpHttp({
  serverName: 'billing',
  url,
  toolFilter: { allow: ['lookup_invoice', 'refund_preview'] },
})
```

An allowlist is the cheapest permission boundary there is: a tool the model never
sees cannot be called. Prefer it over instructing the model to avoid something.

This composes with the rest of the narrowing surface:

```ts
// Per-request capability
agent.createSession({ toolSources: currentUser.canRefund ? [mcp] : [] })
```

## Catalog snapshots are atomic

```text
tools/list succeeds → snapshot revision N published
list_changed fires  → fetch fully → publish revision N+1
fetch fails         → revision N retained (last-known-good)
```

Snapshots are **synchronous and atomic**: one revision binds both the schema and
the execution path. A catalog that changes mid-run therefore cannot make the
model call a tool whose schema it never saw.

Terminal evidence carries **source and revision only** — not the whole catalog —
so a run report stays small and still tells you exactly which revision executed.

## Inspecting connection health

```ts
mcp.state.status      // connecting | ready | authentication-required | …
mcp.state.protocol    // { era, version, transport, fallback }
```

```ts
createMcpHttpClient({
  serverName: 'billing',
  url,
  onStateChange: state => healthUi.update('billing', state),
})
```

Publish `state.protocol` in your health UI. A server that quietly fell back to
the deprecated SSE transport is something you want to know before it is removed
upstream.

## Resources and prompts

MCP resources and prompts stay available **without** being forced into the tool
abstraction. Reach them with `withClient()`:

```ts
const resources = await mcp.withClient((client, signal) =>
  client.listResources(undefined, { signal }))

const prompt = await mcp.withClient((client, signal) => client.getPrompt({
  name: 'release-check',
  arguments: { version: '1.2.0' },
}, { signal }))
```

The callback receives the live protocol client **and the connection's deadline
signal**. Forward that signal — an operation that ignores it has its client
generation removed from the live catalog, closed within `closeTimeoutMs`, and
reconnected only per policy.

The automatic bridge maps **only MCP tools** to `ToolCatalog`, because that is
the abstraction the agent tool loop consumes. Resources and prompts are yours to
place into context deliberately, for example through `session.inject()`.

## Results become structured content

An SDK tool value becomes MCP `structuredContent`; text and inline images remain
first-class result content. In the other direction, an MCP tool result arrives
through the normal `tool-result` run event:

```ts
for await (const event of agent.stream(input)) {
  if (event.type === 'tool-result' && event.name.startsWith('mcp__billing__')) {
    renderBillingResult(event.output, event.status)
  }
}
```

## Bounds that apply to remote tools

Remote tools go through the **same** pipeline as host tools, so the same bounds
apply — plus transport-level caps:

| Bound | Scope |
| --- | --- |
| `maxToolCalls` (64) | Dispatched tools per run |
| `maxToolDurationMs` | One call, end to end |
| `maxToolResultBytes` | Retained serialized result |
| Response / catalog / result caps | Raw MCP transport bytes |
| Operation deadlines | Per MCP request |

An MCP server cannot bypass your run budget by returning a huge payload — it is
bounded at the transport and again at the result.

## Multiple servers

```ts
const [billing, search] = await Promise.all([
  connectMcpHttp({ serverName: 'billing', url: billingUrl, logger }),
  connectMcpHttp({ serverName: 'search', url: searchUrl, logger }),
])

const agent = runtime.agent({ id: 'ops', model, instructions: '…', toolSources: [billing, search] })

try {
  await runtime.close()
} finally {
  await Promise.allSettled([billing.closeWithReport(), search.closeWithReport()])
}
```

Distinct `serverName` values keep the prefixed names unambiguous. Close each
connection you opened and inspect each report.

## Read next

- [Connecting Servers](/en/07-mcp/connecting-servers)
- [Tool Execution](/en/03-tools/tool-execution) — the shared dispatch pipeline
- [MCP Server](/en/07-mcp/mcp-server)
