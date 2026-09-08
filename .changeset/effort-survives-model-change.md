---
"@ai-agent-sdk/core": patch
---

Nothing in core changed here; this records a trap the sample hit, for anyone
building the same thing.

A conversation remembers a reasoning effort, and the model it runs on can change
underneath that memory. Pick `high` on a Codex route, switch the conversation to
a model with no reasoning ladder, and the next prompt fails outright with
`model "x" on route "y" does not offer reasoning effort "high"` — no answer, no
recovery, and nothing in the UI explaining why.

The SDK is right to reject it: an effort a model cannot honour is a caller
mistake, not something to silently ignore. A HOST that remembers efforts across
model changes has to re-validate the remembered value against the model actually
resolved, and clear it when the ladder does not contain it.
`ModelRegistry.resolveModelInfo` exposes the ladder for exactly that.
