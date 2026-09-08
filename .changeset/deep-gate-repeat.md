---
"@ai-agent-sdk/core": patch
---

The deep-mode self-check gate stops re-asking a model that keeps giving the same
answer.

The gate re-prompts until the model submits its self-check. A model that will
not submit answers the same words every round — measured at nineteen identical
answers for one prompt in a scripted soak of the research scenario, each one a
paid model call and each one written to the transcript the user reads.

Two identical answers in a row now end the re-prompting. The run finishes with
`completed: false`, which is the truth: nothing was submitted. A model whose
answer is still changing is still asked, because that is the case the gate
exists for.
