# SDK customer-journey stress harness

This hermetic harness exercises the same public APIs customers compose, without
provider credentials or network access. Every case writes `summary.json` and
`events.jsonl` under `test-human/results/sdk-stress/<run-id>/`.

```powershell
pnpm human:sdk-stress -- --profile complex --seed 20260901
pnpm human:sdk-stress -- --profile stress --repeat 2 --parallel 4 --seed 20260901
pnpm human:sdk-stress -- --profile soak --parallel 8 --seed 20260901
```

The scenarios cover randomized streaming assembly, parallel agent/tool runs,
missing usage accounting, trace closure, transactional provider plugins, retry,
observability backpressure/privacy/exporter failure, lazy filesystem skills,
symlink defense, cancellation, and concurrent MCP lifecycle/error translation.

Use `--scenario <id>` repeatedly to select cases. A failure can be reproduced by
keeping the printed case seed and base `--seed`. `--dry-run` validates selection
and still emits a plan artifact.

Profiles are intentionally nonlinear:

- `complex`: broad, fast integration pressure for every change.
- `stress`: hundreds or thousands of operations per scenario.
- `soak`: thousands of iterations and repeated lifecycle churn for release gates.

Artifacts are bounded and support-safe. Secret-shaped fields are redacted;
prompt/content fields are stored only as byte/character counts and SHA-256
digests. Exact provider wire logs remain a separate, explicit high-risk option.
