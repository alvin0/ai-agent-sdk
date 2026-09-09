# Sequential Execution

Four mechanisms enforce ordering, at four different levels. Pick the lowest one
that actually holds.

## 1. Your code awaits

The strongest ordering guarantee, because it does not depend on the model at all.

```ts
const plan = await planner.generate(objective)
const impl = await implementer.generate(plan.text)
const verdict = await reviewer.generate(impl.text)
```

Each run completes before the next begins. Independent budgets, independent
traces, independent reports.

Use this whenever the order is a **requirement**, not a preference.

## 2. Chained session turns

Within one conversation, turns are inherently sequential — a session
**prevents overlapping runs**.

```ts
const session = agent.createSession()

await session.run('Read the failing test and explain the cause.')
await session.run('Now write the fix.')       // sees the previous turn
await session.run('Now verify it passes.')
```

If you call `run()` while a turn is in flight, the session's exclusion lock
rejects it rather than interleaving two turns over one history.

```ts
session.isRunning              // check first
await session.whenIdle(signal) // or wait
```

`session.compact()` takes the **same** lock, so compaction can never rewrite
history while a turn is reading it.

## 3. Exclusive tools

Inside a single turn the model may emit several tool calls at once. Scheduling is
**fail-closed**: a call runs alone unless `isConcurrencySafe` returns exactly
`true`.

```ts
const writeFile = defineTool({
  name: 'write_file',
  description: 'Write a file in the project.',
  parameters: { /* … */ },
  parse: raw => Args.parse(raw),
  execute: async (args, ctx) => write(args, ctx.signal),
  isConcurrencySafe: () => false,   // never alongside a sibling
})
```

A throwing or absent classifier also means exclusive. The failure mode of
guessing wrong is silent data corruption, so the default protects you.

## 4. Scheduler barriers

Some generated tools are **barriers**: they preserve model order for a batch
instead of running in parallel.

Skill tools are the built-in example. `load_skill` followed by
`read_skill_resource` executes in the order the model emitted them, because a
resource read is meaningless before its skill is loaded — and because a remote
provider may not be safe for concurrent access.

You get the same effect for your own tools by returning `false` from
`isConcurrencySafe`, rather than trying to coordinate inside `execute`.

## Sequencing across a team

`followup()` starts **serialized** work on a target and waits for it.

```ts
await composed.run('lead', 'Prepare release abc123.')
await composed.team.followup('lead', 'reviewer', 'Review abc123.')
await composed.team.whenIdle('reviewer')
```

Two ordering guarantees worth relying on:

**Wake-up work waits behind an active turn.** A `followup_task` aimed at a busy
agent is queued and calls `runPending()` exactly once for the accepted context —
it does not interrupt the turn in progress.

**Remote dispatches are FIFO.** Calls to the same remote A2A target are ordered,
and one remote `contextId` is retained per `(team, sender)` so later follow-ups
resume the same conversation.

## Quiet context before a turn

To hand an agent information **without** starting a turn:

```ts
await team.sendMessage({
  from: 'lead',
  target: 'reviewer',
  message: 'The candidate commit is abc123.',
  delivery: 'quiet',
})

// Later, when you actually want work to happen:
await team.followup('lead', 'reviewer', 'Review abc123 and report back.')
```

`quiet` delivery appends attributed context to the target's history and does not
wake an idle agent. That separation is what lets you stage several inputs and
then trigger one turn that sees all of them.

Within a single session, `session.inject(text)` does the same thing.

## Making the model respect order

Ordering that depends on the model needs to be stated in three places, or it
will not hold:

```ts
const agent = runtime.agent({
  id: 'migrator',
  model,
  instructions: 'Read the file before editing it. Run tests after every edit.',
  tools: [readFile, writeFile, runTests],
})
```

| Place | What to say |
| --- | --- |
| `instructions` | The ordering rule, plainly |
| Tool `description` | "Use after `read_file`." / "Call this last." |
| `isConcurrencySafe` | `false`, so the scheduler cannot reorder it anyway |

The third one is the only guarantee. The first two are prompts.

## When order breaks

| Symptom | Cause | Fix |
| --- | --- | --- |
| Two writes raced | A write tool returned `true` from `isConcurrencySafe` | Return `false` |
| Model edited before reading | Ordering stated only in prose | Make the write tool exclusive; state it in the description |
| A follow-up interrupted a turn | Expected — it is queued, not interruptive | `await team.whenIdle(target)` |
| Overlapping `run()` rejected | The session lock did its job | Check `isRunning` or `whenIdle()` |

## Read next

- [Parallel Execution](/en/06-workflows/parallel-execution)
- [Tool Execution](/en/03-tools/tool-execution) — the dispatch pipeline in detail
