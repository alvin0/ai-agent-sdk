---
"@ai-agent-sdk/core": minor
---

Default aggregate token limits to `maxTotalTokens: 'auto'`. Positive numeric
ceilings remain opt-in; token reminders and report reserves are inactive for
auto. Usage accounting and other resource limits retain their existing scope.

Support `maxTurns: 'auto'` for completion-driven agent execution without a fixed
model-step ceiling. Runtime session overrides and the low-level tool loop also
accept `maxSteps: 'auto'`. Numeric defaults and resource, cancellation and
completion guards remain in effect; serialized configuration preserves `'auto'`.

Add opt-in `finalReportReserveTokens` to stop tool work with token headroom for
one final report, without extending the hard token budget or overriding Stop.

Count consecutive identical calls in the repetition guard instead of accumulating
all visits across a run, allowing verification after distinct intervening work.
The separate multi-step cycle guard still detects alternating tool loops.

Explain when later tool use invalidates an accepted self-check, and bound
unverified prose-only completion retries even when each answer is worded
differently. This prevents automatic deep runs from repeatedly claiming an
obsolete submission was accepted without submitting a current result.
