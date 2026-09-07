---
"@ai-agent-sdk/core": minor
---

A turn now warns repeatedly as its tool-call budget runs down, and tells a model
that ran out what to do about it.

Reported from a running app: a call came back red with "the turn has no
remaining tool-call budget", and the work stopped there. The budget itself was
working as designed — but the model had been told about it exactly once, many
calls earlier, and the failure it finally got was a statement of fact it could
not act on.

Neither reference implementation retries a budget, and neither should: the
budget is still zero on the retry. Codex keeps the model continuously aware
instead — a list of remaining-token thresholds, one reminder per threshold
crossed, re-armable (`rollout_budget.rs`) — and errors hard only at the end. The
DeepSeek harness has no tool-call budget at all. This takes Codex's shape.

- `TurnBounds.toolBudgetRemindAt` is a list of remaining-call counts at which
  the turn tells the model how much is left, defaulting to `[32, 16, 6]`
  against the default budget of 64. One reminder per threshold crossed replaces
  the single warning fired once at 25% remaining: a model warned at sixteen
  calls left and still exploring at four used to hear nothing in between.
  Several thresholds crossed in one round collapse into the lowest, so the
  number the model reads is the true one. Thresholds that do not fit the budget
  are ignored rather than rejected, so a list written for a larger budget stays
  valid; an empty list disables the reminders.
- The failure handed to a call that had no budget left now says what to do —
  do not retry, answer now from what you have, and say what is unverified —
  rather than only what happened. A model given only the fact reaches for its
  usual recovery, which is to try again with calls that no longer exist.

`onExhausted: 'force-final-answer'` remains the default, so an exhausted turn
still ends in an answer rather than an error.
