---
"@ai-agent-sdk/core": patch
---

A managed lead is woken to synthesize when a worker finishes after its turn
ended, instead of the conversation stopping on the worker's own output.

Reported from a running app: the lead delegated, finished its turn, and the
transcript ended inside a subagent panel — a worker's `send_message` and its
self-check were the last things in the conversation. The synthesis the lead
exists to write never happened.

`leadHooks` holds the lead's turn open while workers are outstanding, and that
covers the common case. It cannot cover every case: a turn that ended on its
step budget or on an error is not eligible to continue, and a worker deliberately
outlives the run that started it. The completion report was always delivered
quietly — appended to history, scheduling nothing — so when the lead had gone
idle the report landed where nothing would ever read it.

- A worker's completion report now wakes an idle lead (`wakeup` delivery) rather
  than being appended into a conversation with no turn left. While the lead is
  still inside its turn the report stays quiet, because the next model round
  rebuilds its request from history and an extra turn would be a duplicate
  answer.
- A worker the HOST spawned keeps the quiet delivery. That caller drives the
  lead itself and reads results from `workers()`; waking it would start a turn
  it never asked for.
- The turn-holding hook now counts `pending` workers, not only `running` ones.
  A worker held behind `dependsOn` has not started but will run and report, and
  counting only the running ones let a lead conclude while its whole dependency
  chain was still queued.
- A report delivered quietly while the lead was mid-turn is now followed up
  when that turn ends without reading it. Quiet delivery is a bet that the next
  model round rebuilds its request from history and picks the report up; a turn
  that ends on its step budget, or on an error, has no next round, and the
  report was left sitting in history with nothing to read it. `beforeStep`
  clears the debt because that round IS the read; still outstanding at a turn
  end that cannot continue, the lead is scheduled one more turn.
- `AgentTeam.wake(name)` schedules that turn: a wake-up with no message, for
  context the member was already given.
