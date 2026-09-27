# Edge chat sample live harness

`run.ts` drives the actual sample HTTP route with a real OpenAI provider. It does not mock the SDK or judge success from the assistant's claims alone. Provider usage is billed normally.

Start the sample with a separate build directory (from `samples/edge-runtime-chat-agents/web`):

```sh
EDGE_CHAT_DIST_DIR=.next-harness-build EDGE_CHAT_MODEL=gpt-6-luna pnpm exec next dev -p 3368
```

The sample reads the repository root `.env`. No key is written to the harness artifacts. From the repository root:

```sh
node --experimental-strip-types test-human/edge-runtime-sample/run.ts \
  --base http://127.0.0.1:3368 --output /tmp/edge-sample-new-report \
  --model gpt-6-luna
```

The output directory must not exist. Results, full SSE frames and cleanup responses are retained there, including failures. All test-owned conversations are closed in `finally`; existing conversations are untouched. The harness exits nonzero when any oracle fails.

The default model is `gpt-6-luna` and there is no automatic fallback. The history case uses the same model unless `--secondary-model` is explicitly supplied; without a different secondary model it proves multi-turn history retention, not a model switch.

`--only team-auto-workers-released-between-turns` runs just that case. Wait for the server to report Ready before starting the harness.

Eight workflows cover history across model changes, actual clock and bounded HTTPS tools, provider errors and subsequent user requests, credential-scoped traces and close, fixed-team worker execution and synthesis, dynamic worker cleanup across turns with distinct exact worker and lead answers, and disconnect cancellation followed by reuse. Each noncancelled stream must contain exactly one terminal frame at its end. Successful runs must report usage. The fixed-team oracle requires a real peer message: `followup_task` starts an idle peer, while `send_message` defaults to quiet mailbox delivery.

Exact-output checks also measure model obedience. A failed model oracle remains a failed result even when the runtime terminates cleanly. The harness does not prove cold-isolate durability, hosted platform deadlines, or DNS-level egress isolation. See [the sample audit](../../docs/evaluations/sample-harness-audit-2026-09-27/findings.md) for retained evidence and unresolved cases.
