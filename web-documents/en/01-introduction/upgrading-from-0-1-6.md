# Upgrading from 0.1.6 to 0.1.7

This guide covers **0.1.7**. Merging into `main` triggers the guarded Release
workflow to publish npm packages. Package versions remain in lockstep;
the private testkit is not published. Existing import routes and v1 session
snapshots remain supported.

## Completion and steering

Treat `response.completed` as objective completion; `response.report.status`
describes execution. Empty, whitespace-only or reasoning-only basic replies
are incomplete, even if an earlier round produced an answer. Explicit tools
that conclude a turn retain their completion semantics.

New user or delegated input invalidates an accepted deep-mode self-check and
requires a new `submit_result`. A submission must not share a model message
with another submission or substantive tools. SDK-managed coordination notices
and automatic worker reports can wake the lead without invalidating its check;
ordinary application notices do not count as pending work.

Input arriving at the final round may remain unanswered when the run cannot
continue. The runtime session now exposes the recovery methods already available
on the lower-level session:

```ts
await session.whenIdle()
if (session.hasUnansweredInput()) {
  const response = await session.runPending({ signal })
  // Inspect response.completed; no duplicate user message is added.
}
```

Use one host scheduler per conversation and bound recovery with your cancellation
and budget policy. Do not automatically resume a run the person stopped.
`inject()` checks history capacity before admitting queued input; handle admission
errors instead of recording the steer as accepted.

## Stream and reload agree

The unchanged-answer marker is reserved in every mode, including split text
blocks and text around the marker. It is removed from public answers. Remaining
answer text streams normally; a kept answer may produce no second copy of its
deltas. `assistant-replacement` carries `fromMessageId` and the replacement
`message` when an accepted check keeps or corrects a draft. Apply it to the
identified message rather than appending another answer.

Reconcile the UI with `response.text` after success, even when no answer delta
arrived. If `handle.result` rejects, including Stop, reconcile from the persisted
session transcript after cleanup. Deltas alone are provisional: `text-end.phase`
can reclassify text that preceded a tool call. Replacement events do not cover
every change in the canonical transcript.

The SDK does not rewrite conversations previously stored by 0.1.6. Strip the
reserved marker from legacy assistant text in the application's reload view.

## Stop and human input

Stopping deep or human-in-loop work records interruption and closes pending
question events. Render the dismiss/abort response so an open question dialog
can close. A person's HIL answer invalidates the old draft. Typing a steer does
not itself dismiss a pending HIL question; explicitly answer, dismiss or stop it.
