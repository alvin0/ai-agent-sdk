---
"@ai-agent-sdk/core": patch
---

A lead waiting on its workers no longer spins.

The hook that keeps a delegating lead's turn open re-prompted the model the
instant the turn ended. With workers that take real time, that is a spin:
measured on a scripted run, a lead answered "still waiting" twelve times in half
a second and had no budget left when the results arrived. The transcript filled
with holding answers, and each one was a paid model call that learned nothing.

Both reference harnesses block instead of asking again. Codex has the parent
wait inside its `wait_agent` tool until a mailbox update arrives or a deadline
passes; the DeepSeek harness starts the next goal round only when the agent is
idle and there is something to start it for.

- The hold now waits for a worker to actually report before re-prompting,
  bounded by `ManagedAgentTeamOptions.holdWaitMs` (default 15s). The turn stays
  open and costs nothing while it waits.
- When the wait ends with every worker reported, the lead is told exactly that
  and asked for the answer, instead of being told again what is still running.
- At the deadline the lead gets its turn back and decides for itself: wait again
  with `wait_agents`, close a worker, or answer with what it has. An unbounded
  wait would hand the run's liveness to its slowest worker.
