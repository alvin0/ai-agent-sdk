# Baseline smoke: authentication blocked

One invocation attempted `sequential,code-change`, `single,team`, one repetition,
`codex/gpt-6-luna`, medium effort, concurrency 1. All four runs failed before dispatch:

```text
MISSING_CREDENTIAL: no Codex credentials at /Users/dinh-ai/Documents/workspace/coding/ai-agent-sdk/.temp/wt/benchmark/.providers/.codex/auth.json; run `npm run provider:codex:login-device` to sign in
```

No older model was selected and no live results were fabricated. The SDK reports
`dispatchState: not-sent`, `coverage: not-applicable`, `attemptCount: 0`: recorded zero
tokens reflect no provider dispatch, not a successful zero-cost run. Logical model-call
start counts include this failed preflight. Code-change's nonzero partial score comes
from trivial unchanged empty/zero cases; neither arm passes.

`manifest.json` identifies the actual dirty worktree snapshot and bundle/fixture/harness
hashes. Git staging was denied by the session sandbox, so this is not a committed snapshot.
Raw observation evidence is in `*.audit.json`; result JSON includes exact terminal failures
and fixture artifacts. These four failed attempts do not establish a performance baseline
or satisfy the live N>=3 merge gate. `smoke-summary.json` is a derived index of the raw results.
