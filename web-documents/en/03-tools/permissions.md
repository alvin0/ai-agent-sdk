# Permissions

The SDK's permission boundary is the **approval broker**. It gates a tool call
before `execute` runs, and a denial becomes a result the model can react to.

## Gating a call

```ts
import { createApprovalBroker } from '@ai-agent-sdk/core'

const approvals = createApprovalBroker()
const session = agent.createSession({ approvals })

for await (const event of session.stream('Delete the stale branches.')) {
  if (event.type === 'approval-request') {
    const decision = await confirmInGui(event.request)
    approvals.resolve(event.request.approvalRequestId, decision)
  }
}
```

`ApprovalDecision` is `'allow' | 'deny' | 'abort'`, and `resolve` answers the
SDK-issued `approvalRequestId` — never the provider call id, which a replay
could repeat.

A rejected call becomes a `ToolFailure` with `status: 'rejected'`. The model sees
the denial and can react — it does **not** silently end the turn, because
`concludesTurn` is typed `never` on failure.

## Answering outside the stream loop

When the UI that answers is not the code that consumes events:

```ts
approvals.onRequest(async request => {
  approvals.resolve(request.approvalRequestId, await confirmInGui(request))
})

const result = await session.run('Delete the stale branches.')
```

## Unattended runs

```ts
import { fixedApprovalBroker } from '@ai-agent-sdk/core'

// Tests, benchmarks, CI acceptance:
const approvals = fixedApprovalBroker('allow')
```

`fixedApprovalBroker` answers every request identically. It exists so the
approval code path is still exercised when no human is present — not as a way to
disable the boundary in production.

## Waiting is observable

`sdk.tool.call` records the approval wait and decision, and
`sdk.user.input.wait` records blocking waits with a reason and terminal status —
**never the answer text**.

That means "the run stalled for 40 seconds waiting for a human" is visible in
telemetry rather than looking like a slow model.

## What the SDK does not do

The SDK has **no permission model of its own** — no roles, scopes, ACLs, or
per-tenant policy. That is deliberate: those are product concepts, and the SDK
stays deployment-neutral.

What you get instead:

| SDK provides | You provide |
| --- | --- |
| A blocking approval boundary per tool call | Who is allowed to approve |
| Request identity and correlation | The policy that decides |
| A sanitized denial the model can read | The UI or automated rule |
| Interceptors around every dispatch | Roles, scopes, tenancy |

## Implementing policy with interceptors

Interceptors run around dispatch, so they are the natural place for
deny-by-default rules that never reach a human:

```ts
const session = agent.createSession({
  interceptors: [{
    name: 'tenant-policy',
    before: async (call, next) => {
      if (!policy.allows(currentUser, call.toolName, call.args)) {
        return { kind: 'deny', reason: `not permitted: ${call.toolName}` }
      }
      return next()
    },
  }],
})
```

A `before` phase decides **allow**, **deny**, or **ask** — `'ask'` routes the
call to the approval broker instead of answering it. A `deny` (or a throw from
`around`) becomes a `ToolFailure` the model reads. Use interceptors for
machine-decidable policy and the approval broker for decisions a person must
make.

## Narrowing what exists at all

The cheapest permission is a tool the model never sees:

```ts
// Per-request capability, not a global one.
const session = agent.createSession({
  tools: currentUser.canWrite ? [readFile, writeFile] : [readFile],
})
```

The same applies to remote catalogs and skills:

```ts
connectMcpHttp({ serverName: 'billing', url, toolFilter: { allow: ['lookup_invoice'] } })

runtime.agent({ /* … */, allowedSkillIds: ['release-review'] })
```

`allowedSkillIds` is an **authorization and routing boundary**, not an activation
list: the catalog exposes metadata only for those ids, and a session that
declares an unavailable id fails **before** its model request rather than running
with a different capability.

## Destructive tools: three rules

**Never concurrency-safe.** Return `false` from `isConcurrencySafe` for anything
that writes, deletes, or runs a command.

**Always forward `ctx.signal`.** A destructive tool that ignores cancellation
keeps mutating state after the run was aborted.

**Make the request legible.** The approval prompt shows the tool name and input;
a vague name and an opaque payload make a human approve blindly.

## Human-in-the-loop is a separate boundary

Approvals gate a **tool call**. `mode: 'deep-human-in-loop'` parks the model on a
**material decision** through a blocking `request_user_input` tool, and requires
a `userInput` broker at session creation.

See [Human Approval](/en/06-workflows/human-approval) for that flow.

## Read next

- [Human Approval](/en/06-workflows/human-approval)
- [Durable Execution](/en/03-tools/durable-execution) — journalling approvals across a restart
- [Security](/en/10-advanced/security) — credentials, endpoint policy, privacy
