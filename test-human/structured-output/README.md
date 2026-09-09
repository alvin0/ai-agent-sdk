# Live provider structured-output acceptance

This provider-backed walkthrough shows how `outputFormat: { type:
'json_schema' }` behaves in a user-visible release-readiness review. The model
collects host-owned checks through tools, completes its process, and only then
returns a structured release decision.

```bash
pnpm human:structured-output
pnpm human:structured-output -- --scenario short
pnpm human:structured-output -- --scenario long --long-steps 10
pnpm human:structured-output -- --model gpt-5.6-sol
pnpm human:structured-output -- --provider gemini --scenario short
pnpm human:structured-output -- --provider gemini --scenario long
pnpm human:structured-output -- --verbose
pnpm human:structured-output -- --dry-run
```

The short scenario executes one sequential host-tool round. The long scenario
executes six rounds by default. Each scenario must then produce this provider
call pattern:

```text
tool-calls × N -> process stop -> JSON Schema final stop
```

The default output is a human-readable timeline: each tool request, the release
check returned by the host, the process/final boundary, and the exact JSON the
caller receives. Diagnostic invariants are shown only on failure or with
`--verbose`.

Acceptance remains fail-closed. The harness independently compares the JSON
decision and check list with host-owned process state, requires an exact `N + 2`
call pattern, requires one public tool-call and tool-result event per check, and
requires HTTP 200 for every provider attempt.

Codex uses the project-local credential store managed by
`@ai-agent-sdk/auth-node/codex`. Gemini may read `GEMINI_KEY` and `GEMINI_MODEL`
from the repository `.env` as a test-harness convenience. The Gemini provider
itself never reads environment variables and still receives the key through the
normal injected credential contract. The command writes bounded, support-safe evidence to
`test-human/results/structured-output/<run-id>/summary.json` and `events.jsonl`.
The summary includes each process's final JSON, while the event stream includes
each release check and the final-schema boundary. Credentials and raw prompts
are never copied into the artifact.
