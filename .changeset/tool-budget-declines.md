---
"@ai-agent-sdk/core": minor
---

A spent tool-call budget no longer fails a tool call, and never blocks the calls
that end work.

Reported from a running app: a team lead finished its research, called
`followup_task` to hand the work over, and got back a red
`TOOL_BUDGET_EXHAUSTED`. The budget was doing its job; blocking the handover was
not. Both reference harnesses avoid this shape entirely — Codex measures a
weighted token budget and ends the TURN with `TurnAbortReason::BudgetLimited`
(`rollout_budget.rs`), never failing a call, and the DeepSeek harness has no
tool-call budget at all, only advisory reminders and a goal-level round cap that
records a blocker rather than an error. A limit should end a turn; it should
never break a call.

- **Declined, not failed.** A call the loop refuses now comes back as a
  successful result carrying the instruction, tagged
  `meta: { declined: true, reason }`, and projected as `status: 'declined'` on
  the composition event stream. A failure invites the model's usual recovery —
  retry, retry smaller — with calls that no longer exist, and it counted toward
  `maxConsecutiveToolErrors` on top of the limit that had already fired.
- **The reason is the real one.** A repeat guard, a cycle guard, a token limit,
  and a spent call budget each say so in their own words. Every one of them
  previously reported "the turn has no remaining tool-call budget", which teaches
  a repeating model to ask for fewer calls — a lesson that changes nothing.
- **`ToolDefinition.budgetExempt`.** A tool that ENDS work rather than doing it
  is never declined for a budget and spends none of it. Set on `submit_result`,
  `request_user_input`, and the four team coordination tools, so a deep run can
  always submit, a blocked run can always ask, and a lead can always delegate and
  collect. Run-level ledger limits still apply, so this cannot be used to escape
  accounting.
- **One live budget notice.** Reminders now replace each other instead of piling
  up, so the remainder the model reads is the current one. Codex keeps exactly
  one `<rollout_budget>` fragment for the same reason.
- **`TurnBounds.onExhausted: 'continue'`.** Takes the wall down: the tool-call
  budget becomes a notice, and the turn stays bounded by `maxSteps`,
  `maxTotalTokens`, and the run-level ledger. Each further budget spent injects
  one wrap-up notice, in the shape of Codex's `budget_limit` prompt — no new
  substantive work, finish, say what is unverified. Available through
  `runtimeLimits.onExhausted` for composition and defined agents. Long research
  and team leads want it; the guards that mean "this is not working" still
  decline under every setting.

`force-final-answer` remains the default, so nothing changes for a host that has
not asked for it.
