# Upgrading from 0.1.6 to 0.1.7

These notes cover 0.1.7. Merging into `main` triggers guarded npm publication.
Check the installed package typings or a matching packed workspace build.

- Judge objective completion with `response.completed`, independently of execution
  status. Empty basic replies cannot complete a request using an older answer.
- `RuntimeAgentSession.hasUnansweredInput()` and `runPending(options?)` recover
  input left at a terminal boundary. Wait for idle, use one conversation scheduler,
  bound retries, and do not resume a person's Stop automatically.
- New user/delegated work invalidates deep self-checks. `submit_result` must be
  isolated from duplicate submissions and substantive sibling tools. Internal
  managed-team notices and automatic reports wake the lead without invalidating
  its check; generic app notices are not pending work.
- Handle `inject()` history-capacity rejection before acknowledging a steer.
- Apply `assistant-replacement.fromMessageId` and `.message` to replace a draft.
  Reconcile successful runs from `response.text`, including when there were no
  deltas; reconcile rejected/aborted runs from the persisted transcript after
  cleanup. Use `text-end.phase` to reclassify text preceding tools. Replacement
  events alone do not cover every transcript change.
- The reserved marker is stripped in all modes. Old stored assistant text still
  needs application-side cleanup. Stop closes pending HIL responses; a steer
  does not dismiss a waiting question by itself.

Existing import routes and v1 snapshots remain supported. See
[runtime-and-agents.md](runtime-and-agents.md) and [streaming.md](streaming.md)
for the session and event contracts.
