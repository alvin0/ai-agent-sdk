# Agent termination and usage estimation

The composition response exposes additive `completed: boolean` and
`stopReason: TurnEndReason['kind']` fields. `report.status` describes execution,
not objective completion. Budget/step exhaustion, max-tokens and unavailable
usage may resolve with execution success but `completed: false`. Basic mode
accepts a normal completion or a concluding tool; deep mode also requires an
accepted completion submission. Cancellation/errors reject the composition
result; `handle.report` retains terminal execution evidence. The low-level
session continues to expose its existing `response.outcome` contract.

Every next model call uses the same cancellation, usage-policy and known-token
admission decision. Retry and continuation hooks cannot override it. Structured
and forced finalizers may have an extra step under the existing step policy,
but no implicit extra token budget. Unknown usage stays unknown. This cannot
prevent an already-running provider request from generating beyond the cap.

For `usagePolicy.onMissing: 'estimate'`, `estimateTimeoutMs` is an independent
post-response deadline (default 30,000ms; integer 1..2,147,483,647). The estimator
receives `input.signal`. Caller cancellation, ledger closure and timeout end the
wait even if the callback never settles. Raw provider/attempt reports are stored
before estimation; invalid, failed or timed-out estimation stops admission with
`USAGE_REQUIRED`, without erasing raw counters or fabricating zero usage.
Late results/rejections are observed without publishing into sealed state.

Cancellation cannot preempt synchronous JavaScript or undo external effects of
user callbacks. Estimators must not busy-loop, and should pass the signal to any
asynchronous work they own. No accounting failure automatically retries a model.
