export type ToolBudgetReminderContext = {
  maxToolCalls: number; toolCalls: number; budgetReminders: number[]; budgetIsAWall: boolean
  budgetRemindersSent: number; overBudgetNoticesSent: number; appendBudgetNotice: (text: string) => void
}

export function remindToolBudget(ctx: ToolBudgetReminderContext): void {
    const remaining = Math.max(0, ctx.maxToolCalls - ctx.toolCalls)
    // One reminder per threshold crossed, not one per turn.
    //
    // This was a single boolean: the model was told once, at 25% remaining,
    // and then never again however close it came to the end. A model warned at
    // sixteen calls left and still exploring at four has been told nothing
    // since, and runs into the wall with no notice — which is what produces a
    // red "no remaining tool-call budget" where an answer should have been.
    //
    // Codex counts thresholds rather than remembering a flag
    // (`rollout_budget.rs`, `reminder_index`): every threshold now below the
    // remaining budget that has not been reported yet gets reported. Crossing
    // several at once collapses into the one that matters, the lowest.
    const crossed = ctx.budgetReminders.filter(threshold => remaining <= threshold).length
    if (crossed > ctx.budgetRemindersSent && remaining > 0) {
      ctx.budgetRemindersSent = crossed
      ctx.appendBudgetNotice(
        `Tool budget: ${remaining} of ${ctx.maxToolCalls} calls remain in this turn.`
        + ' Stop broad exploration, make the necessary edits, and reserve calls for'
        + (ctx.budgetIsAWall
          ? ' verification. When the budget runs out no further work call will run, so'
            + ' finish with what you can still verify.'
          : ' verification. Past the budget you are expected to be wrapping up, not'
            + ' opening new lines of work.'),
      )
    }
    // Past the budget with the wall down. The turn is not stopped — the model
    // keeps its tools — but it is told, once per further budget spent, that it
    // is now expected to be finishing. This is the shape of Codex's
    // `budget_limit` goal prompt: no new substantive work, wrap up, name what
    // is left.
    if (!ctx.budgetIsAWall && remaining === 0) {
      const windows = Math.floor(ctx.toolCalls / ctx.maxToolCalls)
      if (windows > ctx.overBudgetNoticesSent) {
        ctx.overBudgetNoticesSent = windows
        ctx.appendBudgetNotice(
          `Tool budget spent: ${ctx.toolCalls} calls made against a budget of ${ctx.maxToolCalls}.`
          + ' Do not start new substantive work. Finish what is in flight, verify what you'
          + ' can, and answer — stating plainly what is unverified or unfinished.',
        )
      }
    }

}
