# Experimental program tools

These are additions in **0.1.5**. Ordinary tools work without
them. A program is a host-defined exclusive tool that calls granted child tools
through the existing scheduler, without an intermediate model round.

## Explicit grants

Register the program and children as normal tools, then configure its session:

```ts
const session = agent.createSession({
  experimentalPrograms: [{ tool: 'lookup_pair', allow: ['lookup'], maxCalls: 2 }],
})
```

Inside the program's `execute`, obtain `experimentalNestedToolPort(ctx)` from
`@alvin0/ai-agent-sdk-core/tools`. It returns undefined when no program port is
bound. Handle that condition instead of directly invoking children to bypass
the grant. Use `port.call(name, args)` sequentially and inspect `result.ok`.
`catalog()` exposes only granted tools.

Programs cannot be concurrency-safe/budget-exempt or call other granted programs,
including themselves. `maxCalls` counts child requests even for exempt children.
Outer and non-exempt child calls spend the same root tool budget. Each child
passes through policy, approvals, checkpointing, cancellation, timeout, and
post-policy output handling. Checkpoints/interceptors receive `parentCallId`;
child calls do not enter model-visible history.

## Validate and retain child values

An optional `experimentalOutputSchema` on a child validates its finalized JSON
value when the schema is supported. Absent/unsupported schemas yield
`schema: 'unchecked'`; do not treat that as a typed contract. MCP bridge schemas
describe the returned envelope's `structuredContent`, not rendered text.

`port.call(name, args, { retain: true })` can return a handle. Capacity refusal is
reported as `retainRefused`; it does not guarantee a handle exists. `load` and
`release` use program-scoped handles within the current turn. Handles expire
when the turn ends and are not persistent output storage.

## Fuse a mutation and validation

The host supplies `applyPatch` and `runValidation` tool definitions below:

```ts
import { defineActionFusion } from '@alvin0/ai-agent-sdk-core/tools'

const fusion = defineActionFusion<{ patch: string }>({
  name: 'edit_and_validate',
  description: 'Apply a patch and run host-selected validation.',
  parameters: {
    type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'],
  },
  parse(raw) {
    if (typeof raw !== 'object' || raw === null || !('patch' in raw)
      || typeof raw.patch !== 'string') throw new TypeError('patch required')
    return { patch: raw.patch }
  },
  steps: [
    { tool: 'apply_patch', arguments: args => ({ patch: args.patch }) },
    { tool: 'run_validation', arguments: (_args, results) => ({ receipt: results[0] ?? null }),
      accept: value => typeof value === 'object' && value !== null
        && 'exitCode' in value && value.exitCode === 0 },
  ],
})
const agent = runtime.agent({
  id: 'editor', model, instructions: 'Use edit_and_validate for edits.',
  tools: [fusion.tool, applyPatch, runValidation],
})
const session = agent.createSession({ experimentalPrograms: [fusion.grant] })
```

Mappings and `accept` predicates are synchronous. The pipeline stops on a child
failure or rejected predicate. Inspect its JSON `ok`, `completedSteps`, and
`results`: successful outer execution can still report `ok: false`.
Earlier mutations remain applied when validation fails; no rollback or automatic
mutation replay is provided. A host journal/interceptor can supply durable
operation identities and decide whether recovery is safe.

See [context optimization](/en/05-memory/context-optimization),
[durable execution](/en/03-tools/durable-execution), and
[upgrading from 0.1.4](/en/01-introduction/upgrading-from-0-1-4).
