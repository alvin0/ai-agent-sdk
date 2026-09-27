# Deep-mode live output regression

This harness uses real Codex `gpt-6-luna` calls. One deep-mode session receives three successive requests: JSON, a number and exact text. Every response must satisfy the current format and retain an accepted self-check. The original request must remain in raw state. Request checkpoints also verify the selected model; there is no model fallback.

```sh
node --experimental-strip-types test-human/deep-mode-format/run.ts --output /tmp/new-deep-format-report
```

Use the repository's configured Codex credential store. The output directory must not exist. Results, provider usage and model-facing message traces are retained, and failures produce a nonzero exit. This is a live format/lifecycle regression, not a general guarantee of model obedience.
