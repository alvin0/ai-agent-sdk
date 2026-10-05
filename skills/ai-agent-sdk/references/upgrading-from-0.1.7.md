# Upgrading from 0.1.7 to 0.1.8

This patch fixes exact-repeat recovery and terminal embedding diagnostics in
`@alvin0/ai-agent-sdk-core`. All 26 workspace packages and root metadata move to
**0.1.8** together; the private testkit remains unpublished. Merging into `main`
triggers the guarded Release workflow. Existing imports and v1 session snapshots
remain supported. Update the SDK packages you use and refresh your lockfile.

## Exact repeated tool calls

At `repeatToolLimit`, the loop can reuse the immediately preceding successful
result from the same turn when the tool name, raw arguments and tool definition
are unchanged. The new call still gets its own history and event pair, with a
model-visible `duplicate_of` notice; result metadata carries `recovered: true`
and `duplicateOfCallId`, and its execution span carries `sdk.tool.recovered`.
The tool body is not dispatched again.

In a batch mixing an exact repeat with fresh calls, repeat admission is per call.
An eligible repeat is recovered; an ineligible repeat is declined without
reserving dispatch quota. Fresh siblings retain normal quota, authorization,
concurrency and cancellation checks. A batch with recovered repeats and actual
fresh dispatches can continue normally; recovered calls spend no tool-call quota.
A fresh call preceding the former repeat resets its streak, so that later call
executes again instead of reusing a result across intervening work.

Recovery does not cross an intervening call or failure, reuse a declined call,
or reuse a result with `additionalContext` or `concludesTurn`. Budget-exempt
tools are excluded. This is bounded repeat-guard recovery, not a general cache
or durable idempotency mechanism.

A round containing only recovered calls may take one ordinary model replan per
exact key when steps and budgets allow and `onExhausted` is not `'stop'`. A
further exact repeat exhausts the repeat guard. Mixed recovered/declined rounds,
cycle limits, missing required usage, token limits, report reserve, cancellation
and admission stops retain their existing stop behavior. Recovery never marks
objective completion by itself; inspect `response.completed` as usual.

## Embedding provider diagnostics

`EmbeddingError.failure` now exposes a validated, frozen `ModelFailure` envelope.
Terminal provider errors preserve their available `status`,
`providerRetryAfterMs` and `requestId` through the embedding retry wrapper and
`normalizeModelFailure(error)`. Missing facts stay absent. The constructor accepts
these optional facts through `EmbeddingErrorOptions`, and an existing
`EmbeddingError` keeps its identity.

Retry decisions, attempt limits, backoff, input text and vectors are unchanged.
The failure envelope adds no raw input text or raw provider response body. Use
these facts to classify authentication, rate-limit and server failures; they do
not establish provider availability, retrieval quality or faster execution.
