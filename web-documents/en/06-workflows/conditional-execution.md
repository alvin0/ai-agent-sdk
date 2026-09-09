# Conditional Execution

Four places to put a branch. The first two are guarantees; the last two are
prompts.

## 1. `beforeStep` — gate the next model step

The `TurnHooks.beforeStep` hook runs before each model step and returns a
decision. This is the SDK's actual conditional-execution primitive.

```ts
type StepDecision =
  | { kind: 'proceed'; prepend?: readonly Message[] }
  | { kind: 'reject'; reason: string }
```

```ts
const session = agent.createSession({
  hooks: {
    beforeStep: async ctx => {
      if (await budget.exhausted(ctx)) {
        return { kind: 'reject', reason: 'cost budget exhausted for this tenant' }
      }

      if (ctx.step === 1) {
        return {
          kind: 'proceed',
          prepend: [createTextMessage(`Current deploy state: ${await deployState()}`)],
        }
      }

      return { kind: 'proceed' }
    },
  },
})
```

| Return | Effect |
| --- | --- |
| `{ kind: 'proceed' }` | The step runs normally |
| `{ kind: 'proceed', prepend }` | Messages are prepended to **that one request** |
| `{ kind: 'reject', reason }` | The step does not run; the reason is recorded |

`prepend` is how you inject state that must be **fresh at this step** rather than
whatever was true when the turn started. `reject` is how you stop work on a
condition the model has no business evaluating — quota, entitlement, a
maintenance window.

Hook invocations are observed as `sdk.hook.call` with a closed hook kind and a
safe error only, and are bounded by their own time limits.

## 2. `onRequestError` — conditional recovery

```ts
hooks: {
  onRequestError: ctx => {
    if (ctx.failure.code === 'RATE_LIMIT' && ctx.step < 3) return 'retry'
    return 'fail'
  },
}
```

This decides recovery for a **model request** failure, based on the typed
`ModelFailure`. It composes with the retry decorator: `withRetry` handles
transient transport-level failures before the first chunk, and this hook handles
policy above that.

## 3. Your code branches between runs

The clearest conditional is an `if` statement.

```ts
const triage = await triager.generate(incident)
const severity = classify(triage.text)

if (severity === 'sev1') {
  await pager.generate(`Page the on-call: ${triage.text}`)
  const plan = await responder.generate(triage.text)
  return plan.text
}

const ticket = await ticketer.generate(triage.text)
return ticket.text
```

For a typed, reliable branch condition, have the agent submit a structured
result rather than parsing its prose — see
[Structured Output](/en/02-agents/structured-output).

```ts
const sink: { value?: Triage } = {}
await triager.createSession({ tools: [submitTriage(sink)] }).run(incident)

switch (sink.value?.severity) {
  case 'sev1': /* … */ break
  case 'sev2': /* … */ break
  default: throw new Error('triage did not submit a verdict')
}
```

## 4. Narrow what the model can choose

The cheapest condition removes the option entirely.

```ts
// Per-request capability
const session = agent.createSession({
  tools: currentUser.canDeploy ? [plan, deploy] : [plan],
})

// Force, allow, or forbid tool use for this agent
runtime.agent({ /* … */, toolChoice: 'auto' })

// Restrict a remote catalog
connectMcpHttp({ serverName: 'billing', url, toolFilter: { allow: ['lookup_invoice'] } })

// Restrict skills
runtime.agent({ /* … */, allowedSkillIds: ['release-review'] })
```

A tool the model never sees cannot be called at the wrong time. Prefer this over
instructing the model not to use something.

## 5. Interceptors — deny-by-default policy

```ts
const session = agent.createSession({
  interceptors: [async (call, next) => {
    if (!policy.allows(currentUser, call.name, call.input)) {
      throw new Error(`not permitted: ${call.name}`)
    }
    return next(call)
  }],
})
```

A throw becomes a `ToolFailure` the model reads and can react to. Use
interceptors for machine-decidable conditions on **individual calls**, and
`beforeStep` for conditions on **whole steps**.

## Conditions the SDK already evaluates

You do not need to build these:

| Condition | Mechanism |
| --- | --- |
| Context is about to overflow | Automatic compaction at `thresholdRatio` |
| The provider confirmed overflow | One compact-and-retry (`maxOverflowRetries`) |
| The model is repeating itself | `repeatToolWarningAt` → warn, `repeatToolLimit` → stop |
| The model is looping over a short cycle | `toolCycleWarningAt` / `toolCycleLimit` |
| Tools keep failing | `maxConsecutiveToolErrors` cutoff |
| The tool budget is nearly gone | An app-authored warning at 75% of `maxToolCalls` |
| A model/effort/native-tool selection is impossible | Rejected before provider I/O |

## Choosing where to put a condition

```text
Is it about entitlement, quota, or a maintenance window?   → beforeStep reject
Does it need state that must be fresh at this step?         → beforeStep prepend
Is it a machine rule about one specific call?               → interceptor
Is it a branch between whole runs?                          → your code + structured output
Is it "the model should not have this option"?              → narrow tools / skills / toolChoice
Does a person have to decide?                               → approval broker or deep-human-in-loop
Is it a mid-run recovery decision about a provider failure?  → onRequestError
```

## What not to rely on

Stating a condition only in `instructions` is a **prompt**, not a guarantee. It
is fine for guidance ("read before editing") and unfit for policy ("never deploy
on Friday"). Policy belongs in a hook, an interceptor, or a narrowed tool set,
where it holds regardless of what the model decides.

## Read next

- [Human Approval](/en/06-workflows/human-approval)
- [Lifecycle](/en/02-agents/lifecycle) — the full hook surface
- [Structured Output](/en/02-agents/structured-output) — typed branch conditions
