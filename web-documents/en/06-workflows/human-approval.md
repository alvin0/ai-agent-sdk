# Human Approval

Two separate boundaries block on a human: **approvals** gate a tool call,
**user input** parks the model on a material decision.

## Approvals — gate a tool call

```ts
import { createApprovalBroker } from '@ai-agent-sdk/core'

const approvals = createApprovalBroker()
const session = agent.createSession({ approvals })

for await (const event of session.stream('Delete the stale branches.')) {
  if (event.type === 'approval-request') {
    const decision = await confirmInGui(event.request)
    approvals.resolve(event.request.requestId, decision)
  }
}
```

A rejected call becomes a `ToolFailure` with `status: 'rejected'`. The model sees
it and can react — it does not silently end the turn, because `concludesTurn` is
typed `never` on failure.

For unattended harnesses and tests, `fixedApprovalBroker(decision)` answers every
request identically.

## User input — park on a decision

`deep-human-in-loop` mode gives the model a blocking `request_user_input` tool.

```ts
import { createUserInputBroker } from '@ai-agent-sdk/core'

const userInput = createUserInputBroker()

const session = planner.createSession({ registry, userInput })
// The broker is REQUIRED for this mode; a missing one fails at session creation,
// not halfway through a run.
```

Two integration shapes are available.

**Event-driven, inside the run loop:**

```ts
for await (const event of session.stream('Plan the migration.')) {
  if (event.type === 'user-input-request') {
    const response = await askInGui(event.request)
    userInput.resolve(event.request.requestId, response)
  }
  if (event.type === 'user-input-response') {
    renderAnswer(event.requestId, event.response)
  }
}
```

**Callback, outside the run loop:**

```ts
userInput.onRequest(async request => {
  userInput.resolve(request.requestId, await askInGui(request))
})

const result = await session.run('Plan the migration.')
```

The callback form is what you want when the answering UI is not the same code
that consumes the event stream — a web request handler answering from a separate
socket, for example.

## Resuming by exact call id

Resume by the exact provider call id. Answers may select a suggested option **or**
contain free-form feedback:

```ts
if (event.type === 'user-input-request') {
  // event.request carries 2-3 suggested choices and always permits free-form text.
  const response = await askInGui(event.request)
  userInput.resolve(event.request.requestId, response)
}
```

The request shape:

```ts
interface UserInputRequest {
  requestId: string
  question: UserInputQuestion
  options?: readonly UserInputOption[]   // 2-3 suggestions
  // free-form answers are always permitted
}
```

## Web-safe by construction

Approval and user-input policy are Universal — no Node dependency, no process
globals, no `AsyncLocalStorage`. The same broker works in an Edge worker, a
browser, and a Node CLI.

Waiting is observable: `sdk.user.input.wait` records start/end with a reason and
terminal status, and **never the answer text**.

## Interactive brokers

`createApprovalBroker()` and `createUserInputBroker()` return
`InteractiveApprovalBroker` / `InteractiveUserInputBroker`. Both accept options
for queue bounds and default behaviour, and both expose `resolve(requestId, …)`
plus an `onRequest` subscription.

The fixed variants — `fixedApprovalBroker()`, `fixedUserInputBroker()` — are for
tests, benchmarks, and unattended acceptance runs where a real human is not
present but the code path must still be exercised.

## Read next

- [Permissions](/en/03-tools/permissions) — gating a single tool call
- [Conditional Execution](/en/06-workflows/conditional-execution) — machine-decided gates
- [Security](/en/10-advanced/security) — what stays host policy
